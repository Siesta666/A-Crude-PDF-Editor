// ==========================================
// PDF Studio - 前端主交互逻辑
// ==========================================

const state = {
    currentTab: 'merge-tab',
    
    // 1. PDF & 图片 统一合并板块状态 (每个 item: { id, type, path, name, page_count, size_kb, width, height, thumb_data })
    mergeItems: [],

    // 2. PDF 可视化裁剪状态
    pdfPath: null,
    pdfInfo: null,
    currentPageIdx: 0,
    currentPageData: null,
    pageImage: null,
    crop: { x: 50, y: 50, w: 300, h: 400 },
    aspectRatio: null,
    isDrawing: false,
    isDragging: false,
    isResizing: false,
    activeHandle: null,
    dragStart: { x: 0, y: 0 },
    initialCrop: { x: 0, y: 0, w: 0, h: 0 },
    zoom: 1.0
};

// 辅助生成唯一 ID，确保删除与拖拽 100% 精准
function generateId() {
    return 'item_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 7);
}

// 工具函数：Toast 提示
function showToast(msg, duration = 3000) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.classList.add('hidden');
    }, duration);
}

// 检查并调用 Python 后端 API
async function callPy(method, ...args) {
    if (window.pywebview && window.pywebview.api && window.pywebview.api[method]) {
        try {
            return await window.pywebview.api[method](...args);
        } catch (err) {
            console.error(`API [${method}] 错误:`, err);
            showToast('操作发生错误: ' + (err.message || err));
            throw err;
        }
    } else {
        console.warn(`pywebview.api.${method} 未就绪 (可能处于开发调试环境)`);
        return null;
    }
}

// ==========================================
// Tab 切换
// ==========================================
function switchTab(targetTab) {
    if (typeof dragSort !== 'undefined' && (dragSort.active || dragSort.ghostEl)) {
        finalizeDragImmediately();
    }
    document.querySelectorAll('.tab-btn').forEach(b => {
        if (b.getAttribute('data-tab') === targetTab) b.classList.add('active');
        else b.classList.remove('active');
    });
    document.querySelectorAll('.tab-content').forEach(c => {
        if (c.id === targetTab) c.classList.add('active');
        else c.classList.remove('active');
    });
    state.currentTab = targetTab;
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-tab'));
    });
});


// ==========================================
// 1. PDF & 图片 统一合并板块 (方块网格 + 右下角预览 + 可靠删除)
// ==========================================
const mergeGridContainer = document.getElementById('merge-grid-list');
const emptyMergeHint = document.getElementById('empty-merge-hint');

// 高性能 Pointer Events + FLIP 拖拽排序状态
const dragSort = {
    pending: false,
    active: false,
    pointerId: null,
    itemId: null,
    startX: 0,
    startY: 0,
    lastClientX: 0,
    lastClientY: 0,
    offsetX: 0,
    offsetY: 0,
    cardWidth: 0,
    cardHeight: 0,
    sourceCard: null,
    ghostEl: null,
    startIndex: -1,
    autoScrollRaf: null,
    justDragged: false
};

// 添加 PDF 文件
document.getElementById('btn-add-pdfs').addEventListener('click', async () => {
    const pdfs = await callPy('select_multiple_pdfs');
    if (!pdfs || pdfs.length === 0) return;

    const existingPaths = new Set(state.mergeItems.map(item => item.path));
    const newItems = pdfs
        .filter(item => !existingPaths.has(item.path))
        .map(item => ({
            id: generateId(),
            type: 'pdf',
            path: item.path,
            name: item.name,
            page_count: item.page_count || 1,
            size_kb: item.size_kb || 0,
            thumb_data: item.thumb_data || ''
        }));

    if (newItems.length < pdfs.length) {
        showToast('已自动跳过已存在的相同文件');
    }

    state.mergeItems.push(...newItems);
    renderMergeGrid();
});

// 添加图片文件
document.getElementById('btn-add-images').addEventListener('click', async () => {
    const images = await callPy('select_images');
    if (!images || images.length === 0) return;

    const existingPaths = new Set(state.mergeItems.map(item => item.path));
    const newItems = images
        .filter(item => !existingPaths.has(item.path))
        .map(item => ({
            id: generateId(),
            type: 'image',
            path: item.path,
            name: item.name,
            page_count: 1,
            size_kb: item.size_kb || item.sizeKb || 0,
            width: item.width || 0,
            height: item.height || 0,
            thumb_data: item.thumb_data || item.thumbData || ''
        }));

    if (newItems.length < images.length) {
        showToast('已自动跳过已存在的相同图片');
    }

    state.mergeItems.push(...newItems);
    renderMergeGrid();
});

// 清空列表
document.getElementById('btn-clear-all').addEventListener('click', () => {
    state.mergeItems = [];
    renderMergeGrid();
    showToast('已清空全部待合并文件');
});

// 按文件名升序排序（带 FLIP 滑动洗牌动画）
document.getElementById('btn-sort-name').addEventListener('click', () => {
    if (state.mergeItems.length <= 1) return;
    reorderGridWithFLIP(() => {
        state.mergeItems.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
        const cardById = new Map();
        mergeGridContainer.querySelectorAll('.merge-grid-card').forEach(c => {
            cardById.set(c.dataset.id, c);
        });
        state.mergeItems.forEach(item => {
            const cardEl = cardById.get(item.id);
            if (cardEl) mergeGridContainer.appendChild(cardEl);
        });
    });
    showToast('已按文件名升序排列');
});

// 辅助函数：只更新所有卡片左上角的“第 N 项”序号角标（无需重建 DOM）
function updateMergeOrderBadges() {
    const cards = mergeGridContainer.querySelectorAll('.merge-grid-card');
    cards.forEach((card, idx) => {
        const badge = card.querySelector('.merge-order-badge');
        if (badge) badge.textContent = `第 ${idx + 1} 项`;
    });
}

// 通用 FLIP 动画 DOM 重排函数（用于实时拖拽换位、前移/后移按钮、一键排序）
function reorderGridWithFLIP(mutateOrderFn, excludeEl = null) {
    const cards = Array.from(mergeGridContainer.querySelectorAll('.merge-grid-card'));
    const firstRects = new Map();
    cards.forEach(c => {
        if (c !== excludeEl) {
            firstRects.set(c, c.getBoundingClientRect());
        }
    });

    // 执行数据与 DOM 节点调序
    mutateOrderFn();
    updateMergeOrderBadges();

    // Last & Invert
    const movedCards = [];
    firstRects.forEach((firstRect, el) => {
        el.style.transition = 'none';
        el.style.transform = '';
        const lastRect = el.getBoundingClientRect();
        const dx = firstRect.left - lastRect.left;
        const dy = firstRect.top - lastRect.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
            movedCards.push(el);
        }
    });

    if (movedCards.length === 0) return;

    // 强制触发 reflow 固化起始位移帧
    void mergeGridContainer.offsetWidth;

    // Play: 丝滑物理曲线归位
    movedCards.forEach(el => {
        el.style.transition = 'transform 200ms cubic-bezier(0.2, 0, 0, 1)';
        el.style.transform = 'translate3d(0, 0, 0)';
    });
}

// 卡片动画结束后自动清理内联 transform，避免干扰后续样式
mergeGridContainer.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'transform' && e.target.classList.contains('merge-grid-card')) {
        e.target.style.transition = '';
        e.target.style.transform = '';
    }
});

// 渲染方块网格
function renderMergeGrid() {
    // 若存在未结束的拖拽先立即收尾
    if (dragSort.active || dragSort.ghostEl) {
        finalizeDragImmediately();
    }

    const items = state.mergeItems;

    // 更新统计栏
    const totalCountEl = document.getElementById('merge-total-count');
    const pdfCountEl = document.getElementById('merge-pdf-count');
    const imgCountEl = document.getElementById('merge-img-count');
    const totalPagesEl = document.getElementById('merge-total-pages');

    const pdfCount = items.filter(it => it.type === 'pdf').length;
    const imgCount = items.filter(it => it.type === 'image').length;
    const totalPages = items.reduce((sum, it) => sum + (it.page_count || 1), 0);

    totalCountEl.textContent = items.length;
    pdfCountEl.textContent = pdfCount;
    imgCountEl.textContent = imgCount;
    totalPagesEl.textContent = totalPages;

    if (items.length === 0) {
        mergeGridContainer.innerHTML = '';
        mergeGridContainer.appendChild(emptyMergeHint);
        emptyMergeHint.classList.remove('hidden');
        return;
    }

    emptyMergeHint.classList.add('hidden');
    mergeGridContainer.innerHTML = '';

    items.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = 'merge-grid-card';
        card.dataset.id = item.id;

        // 缩略图 HTML（禁止原生 img 拖拽以免劫持手势）
        const thumbHtml = item.thumb_data
            ? `<img src="${item.thumb_data}" alt="${item.name}" draggable="false">`
            : `<div class="pdf-thumb-fallback">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                        <text x="7" y="17" font-size="6" font-weight="bold" fill="currentColor">${item.type === 'pdf' ? 'PDF' : 'IMG'}</text>
                    </svg>
                    <span>无缩略图</span>
               </div>`;

        // 角标文案
        const typeBadgeText = item.type === 'pdf' ? `📄 PDF (${item.page_count}页)` : '🖼️ 图片';
        const typeBadgeClass = item.type === 'pdf' ? 'badge-pdf' : 'badge-img';

        // 规格说明
        const specMeta = item.type === 'pdf' 
            ? `共 ${item.page_count} 页`
            : (item.width && item.height ? `${item.width}×${item.height} px` : '图片文件');

        card.innerHTML = `
            <div class="merge-card-thumb" title="按住直接拖动即可实时调整合并次序">
                <span class="merge-order-badge">第 ${idx + 1} 项</span>
                <span class="merge-type-badge ${typeBadgeClass}">${typeBadgeText}</span>
                ${thumbHtml}
                <!-- 重点要求：右下角预览按钮 -->
                <button class="card-preview-btn" data-id="${item.id}" title="点击在全屏弹窗中查看高清晰度大图预览">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        <line x1="11" y1="8" x2="11" y2="14"></line>
                        <line x1="8" y1="11" x2="14" y2="11"></line>
                    </svg>
                    <span>预览</span>
                </button>
            </div>
            <div class="merge-card-body">
                <div class="merge-card-title" title="${item.path}">${item.name}</div>
                <div class="merge-card-meta">
                    <span>💾 ${item.size_kb} KB</span>
                    <span>${specMeta}</span>
                </div>
            </div>
            <div class="merge-card-actions">
                <div>
                    <button class="pdf-card-action-btn btn-move-up" data-id="${item.id}" title="前移一位">← 前移</button>
                    <button class="pdf-card-action-btn btn-move-down" data-id="${item.id}" title="后移一位">后移 →</button>
                </div>
                <!-- 可靠删除按钮 -->
                <button class="pdf-card-action-btn delete btn-remove" data-id="${item.id}" title="从合并列表中删除">✕ 移除</button>
            </div>
        `;

        mergeGridContainer.appendChild(card);
    });
}

// ==========================================
// 高性能 Pointer Events + FLIP 实时拖拽排序引擎
// (彻底取代迟钝的 HTML5 原生 DnD：零闪烁、缝隙无死区、实时让位、边缘自动滚动)
// ==========================================
function stopAutoScrollLoop() {
    if (dragSort.autoScrollRaf !== null) {
        cancelAnimationFrame(dragSort.autoScrollRaf);
        dragSort.autoScrollRaf = null;
    }
}

function releaseDragCapture() {
    if (dragSort.pointerId !== null) {
        try {
            if (mergeGridContainer.hasPointerCapture(dragSort.pointerId)) {
                mergeGridContainer.releasePointerCapture(dragSort.pointerId);
            }
        } catch (_) {}
    }
}

function finalizeDragImmediately() {
    stopAutoScrollLoop();
    releaseDragCapture();
    dragSort.pending = false;
    dragSort.active = false;
    document.body.classList.remove('is-sorting-cards');
    if (dragSort.ghostEl && dragSort.ghostEl.parentNode) {
        dragSort.ghostEl.parentNode.removeChild(dragSort.ghostEl);
    }
    if (dragSort.sourceCard) {
        dragSort.sourceCard.classList.remove('is-placeholder');
    }
    dragSort.ghostEl = null;
    dragSort.sourceCard = null;
    dragSort.itemId = null;
    dragSort.pointerId = null;
    mergeGridContainer.querySelectorAll('.merge-grid-card').forEach(c => {
        c.style.transition = '';
        c.style.transform = '';
    });
}

function startPointerDrag(e) {
    dragSort.pending = false;
    dragSort.active = true;

    try {
        mergeGridContainer.setPointerCapture(dragSort.pointerId);
    } catch (_) {}

    const card = dragSort.sourceCard;
    const ghost = card.cloneNode(true);
    ghost.classList.remove('is-placeholder');
    ghost.classList.add('merge-drag-ghost');
    ghost.style.width = `${dragSort.cardWidth}px`;
    ghost.style.height = `${dragSort.cardHeight}px`;

    const gx = e.clientX - dragSort.offsetX;
    const gy = e.clientY - dragSort.offsetY;
    ghost.style.transform = `translate3d(${gx}px, ${gy}px, 0) scale(1.03)`;
    document.body.appendChild(ghost);

    dragSort.ghostEl = ghost;
    card.classList.add('is-placeholder');
    document.body.classList.add('is-sorting-cards');

    startAutoScrollLoop();
}

function evaluatePointerSwap(clientX, clientY) {
    if (!dragSort.active || !dragSort.sourceCard) return;

    const cards = Array.from(mergeGridContainer.querySelectorAll('.merge-grid-card'));
    if (cards.length <= 1) return;

    const placeholderIdx = cards.indexOf(dragSort.sourceCard);
    if (placeholderIdx === -1) return;

    // 基于容器静态坐标系 + offsetLeft/offsetTop 精确判定槽位（不受正在进行的 FLIP transform 干扰）
    const containerRect = mergeGridContainer.getBoundingClientRect();
    const baseLeft = containerRect.left + mergeGridContainer.clientLeft - mergeGridContainer.scrollLeft;
    const baseTop = containerRect.top + mergeGridContainer.clientTop - mergeGridContainer.scrollTop;

    const style = window.getComputedStyle(mergeGridContainer);
    const padX = (parseFloat(style.columnGap) || 16) / 2 + 1;
    const padY = (parseFloat(style.rowGap) || 16) / 2 + 1;

    let targetIdx = -1;

    // 1. 优先命中任意卡片的扩展槽位（无缝覆盖网格缝隙）
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        const left = baseLeft + c.offsetLeft - padX;
        const right = baseLeft + c.offsetLeft + c.offsetWidth + padX;
        const top = baseTop + c.offsetTop - padY;
        const bottom = baseTop + c.offsetTop + c.offsetHeight + padY;

        if (clientX >= left && clientX <= right && clientY >= top && clientY <= bottom) {
            targetIdx = i;
            break;
        }
    }

    // 2. 兜底处理拖至容器末尾空白处或最前面空白处
    if (
        targetIdx === -1 &&
        clientX >= containerRect.left && clientX <= containerRect.right &&
        clientY >= containerRect.top && clientY <= containerRect.bottom
    ) {
        const lastCard = cards[cards.length - 1];
        const lastTop = baseTop + lastCard.offsetTop - padY;
        const lastRight = baseLeft + lastCard.offsetLeft + lastCard.offsetWidth + padX;
        const lastBottom = baseTop + lastCard.offsetTop + lastCard.offsetHeight + padY;

        if (clientY > lastBottom || (clientY >= lastTop && clientX > lastRight)) {
            targetIdx = cards.length - 1;
        } else {
            const firstCard = cards[0];
            const firstTop = baseTop + firstCard.offsetTop - padY;
            const firstLeft = baseLeft + firstCard.offsetLeft - padX;
            const firstBottom = baseTop + firstCard.offsetTop + firstCard.offsetHeight + padY;
            if (clientY < firstTop || (clientY <= firstBottom && clientX < firstLeft)) {
                targetIdx = 0;
            }
        }
    }

    if (targetIdx === -1 || targetIdx === placeholderIdx) return;

    // 立即同步调换数组和 DOM，并让其余卡片以 FLIP 动画丝滑补位
    reorderGridWithFLIP(() => {
        const [movedItem] = state.mergeItems.splice(placeholderIdx, 1);
        state.mergeItems.splice(targetIdx, 0, movedItem);

        const sourceEl = dragSort.sourceCard;
        const targetEl = cards[targetIdx];
        if (placeholderIdx < targetIdx) {
            mergeGridContainer.insertBefore(sourceEl, targetEl.nextSibling);
        } else {
            mergeGridContainer.insertBefore(sourceEl, targetEl);
        }
    }, dragSort.sourceCard);

    // 同步刷新浮层左上角序号
    if (dragSort.ghostEl) {
        const ghostBadge = dragSort.ghostEl.querySelector('.merge-order-badge');
        if (ghostBadge) ghostBadge.textContent = `第 ${targetIdx + 1} 项`;
    }
}

function startAutoScrollLoop() {
    stopAutoScrollLoop();
    const EDGE_ZONE = 64;
    const MAX_SPEED = 14;

    function tick() {
        if (!dragSort.active) return;

        const rect = mergeGridContainer.getBoundingClientRect();
        const y = dragSort.lastClientY;
        let delta = 0;

        if (y < rect.top + EDGE_ZONE && mergeGridContainer.scrollTop > 0) {
            const ratio = Math.min(1, (rect.top + EDGE_ZONE - y) / EDGE_ZONE);
            delta = -Math.ceil(ratio * MAX_SPEED);
        } else if (
            y > rect.bottom - EDGE_ZONE &&
            mergeGridContainer.scrollTop + mergeGridContainer.clientHeight < mergeGridContainer.scrollHeight
        ) {
            const ratio = Math.min(1, (y - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE);
            delta = Math.ceil(ratio * MAX_SPEED);
        }

        if (delta !== 0) {
            mergeGridContainer.scrollTop += delta;
            evaluatePointerSwap(dragSort.lastClientX, dragSort.lastClientY);
        }

        dragSort.autoScrollRaf = requestAnimationFrame(tick);
    }

    dragSort.autoScrollRaf = requestAnimationFrame(tick);
}

function finishPointerDrag(revertToStart = false) {
    stopAutoScrollLoop();
    releaseDragCapture();
    dragSort.pending = false;

    if (!dragSort.active) {
        dragSort.sourceCard = null;
        dragSort.itemId = null;
        dragSort.pointerId = null;
        return;
    }

    // 若按 ESC 撤销，将卡片还原回拖拽前的原始位置
    if (revertToStart && dragSort.startIndex !== -1) {
        const cards = Array.from(mergeGridContainer.querySelectorAll('.merge-grid-card'));
        const currIdx = cards.indexOf(dragSort.sourceCard);
        if (currIdx !== -1 && currIdx !== dragSort.startIndex) {
            reorderGridWithFLIP(() => {
                const [movedItem] = state.mergeItems.splice(currIdx, 1);
                state.mergeItems.splice(dragSort.startIndex, 0, movedItem);
                const targetEl = cards[dragSort.startIndex];
                if (currIdx < dragSort.startIndex) {
                    mergeGridContainer.insertBefore(dragSort.sourceCard, targetEl.nextSibling);
                } else {
                    mergeGridContainer.insertBefore(dragSort.sourceCard, targetEl);
                }
            }, dragSort.sourceCard);
        }
    }

    dragSort.active = false;
    dragSort.justDragged = true;
    setTimeout(() => { dragSort.justDragged = false; }, 120);

    document.body.classList.remove('is-sorting-cards');

    const sourceCard = dragSort.sourceCard;
    const ghost = dragSort.ghostEl;
    const finalIdx = state.mergeItems.findIndex(it => it.id === dragSort.itemId);
    const moved = !revertToStart && finalIdx !== -1 && finalIdx !== dragSort.startIndex;

    if (ghost && sourceCard) {
        const targetRect = sourceCard.getBoundingClientRect();
        ghost.classList.add('is-dropping');
        ghost.style.transform = `translate3d(${targetRect.left}px, ${targetRect.top}px, 0) scale(1)`;

        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
            sourceCard.classList.remove('is-placeholder');
            if (dragSort.ghostEl === ghost) {
                dragSort.ghostEl = null;
                dragSort.sourceCard = null;
                dragSort.itemId = null;
                dragSort.pointerId = null;
            }
            mergeGridContainer.querySelectorAll('.merge-grid-card').forEach(c => {
                c.style.transition = '';
                c.style.transform = '';
            });
        };

        ghost.addEventListener('transitionend', cleanup, { once: true });
        setTimeout(cleanup, 210);
    } else {
        finalizeDragImmediately();
    }

    if (revertToStart) {
        showToast('已取消拖拽，恢复原顺序', 1500);
    } else if (moved) {
        showToast(`已移动到第 ${finalIdx + 1} 位`, 1800);
    }
}

mergeGridContainer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;

    const card = e.target.closest('.merge-grid-card');
    if (!card || state.mergeItems.length <= 1) return;

    if (dragSort.active || dragSort.ghostEl) {
        finalizeDragImmediately();
    }

    const rect = card.getBoundingClientRect();
    dragSort.pending = true;
    dragSort.active = false;
    dragSort.pointerId = e.pointerId;
    dragSort.itemId = card.dataset.id;
    dragSort.sourceCard = card;
    dragSort.startX = e.clientX;
    dragSort.startY = e.clientY;
    dragSort.lastClientX = e.clientX;
    dragSort.lastClientY = e.clientY;
    dragSort.offsetX = e.clientX - rect.left;
    dragSort.offsetY = e.clientY - rect.top;
    dragSort.cardWidth = rect.width;
    dragSort.cardHeight = rect.height;
    dragSort.startIndex = state.mergeItems.findIndex(it => it.id === dragSort.itemId);
});

window.addEventListener('pointermove', (e) => {
    if (!dragSort.pending && !dragSort.active) return;
    if (dragSort.pointerId !== null && e.pointerId !== dragSort.pointerId) return;

    dragSort.lastClientX = e.clientX;
    dragSort.lastClientY = e.clientY;

    if (dragSort.pending) {
        const dist = Math.hypot(e.clientX - dragSort.startX, e.clientY - dragSort.startY);
        if (dist < 4) return;
        startPointerDrag(e);
    }

    if (dragSort.active && dragSort.ghostEl) {
        const gx = e.clientX - dragSort.offsetX;
        const gy = e.clientY - dragSort.offsetY;
        dragSort.ghostEl.style.transform = `translate3d(${gx}px, ${gy}px, 0) scale(1.03)`;
        evaluatePointerSwap(e.clientX, e.clientY);
    }
});

window.addEventListener('pointerup', (e) => {
    if (!dragSort.pending && !dragSort.active) return;
    if (dragSort.pointerId !== null && e.pointerId !== dragSort.pointerId) return;
    finishPointerDrag(false);
});

window.addEventListener('pointercancel', () => {
    if (dragSort.pending || dragSort.active) {
        finishPointerDrag(false);
    }
});

window.addEventListener('blur', () => {
    if (dragSort.pending || dragSort.active) {
        finishPointerDrag(false);
    }
});

// 统一事件委托处理删除、预览与换位（彻底杜绝索引漂移与子节点点击失效的问题）
mergeGridContainer.addEventListener('click', (e) => {
    if (dragSort.justDragged) return;

    // 1. 删除按钮响应 (重点检查与彻底修复)
    const removeBtn = e.target.closest('.btn-remove');
    if (removeBtn) {
        e.stopPropagation();
        const id = removeBtn.dataset.id;
        const idx = state.mergeItems.findIndex(it => it.id === id);
        if (idx !== -1) {
            const removed = state.mergeItems.splice(idx, 1)[0];
            renderMergeGrid();
            showToast(`已移除: ${removed.name}`);
        }
        return;
    }

    // 2. 右下角“预览”按钮响应 (全屏大图模态框)
    const previewBtn = e.target.closest('.card-preview-btn');
    if (previewBtn) {
        e.stopPropagation();
        const id = previewBtn.dataset.id;
        const item = state.mergeItems.find(it => it.id === id);
        if (item) {
            openPreviewModal(item);
        }
        return;
    }

    // 3. 前移按钮响应（带 FLIP 滑动动画）
    const moveUpBtn = e.target.closest('.btn-move-up');
    if (moveUpBtn) {
        e.stopPropagation();
        const id = moveUpBtn.dataset.id;
        const idx = state.mergeItems.findIndex(it => it.id === id);
        if (idx > 0) {
            const cards = Array.from(mergeGridContainer.querySelectorAll('.merge-grid-card'));
            reorderGridWithFLIP(() => {
                const temp = state.mergeItems[idx];
                state.mergeItems[idx] = state.mergeItems[idx - 1];
                state.mergeItems[idx - 1] = temp;
                mergeGridContainer.insertBefore(cards[idx], cards[idx - 1]);
            });
        }
        return;
    }

    // 4. 后移按钮响应（带 FLIP 滑动动画）
    const moveDownBtn = e.target.closest('.btn-move-down');
    if (moveDownBtn) {
        e.stopPropagation();
        const id = moveDownBtn.dataset.id;
        const idx = state.mergeItems.findIndex(it => it.id === id);
        if (idx !== -1 && idx < state.mergeItems.length - 1) {
            const cards = Array.from(mergeGridContainer.querySelectorAll('.merge-grid-card'));
            reorderGridWithFLIP(() => {
                const temp = state.mergeItems[idx];
                state.mergeItems[idx] = state.mergeItems[idx + 1];
                state.mergeItems[idx + 1] = temp;
                mergeGridContainer.insertBefore(cards[idx + 1], cards[idx]);
            });
        }
        return;
    }
});

// ==========================================
// 大图高清晰度预览模态框逻辑
// ==========================================
const previewModal = document.getElementById('preview-modal');
const previewImg = document.getElementById('preview-img');
const previewFileName = document.getElementById('preview-file-name');
const previewFileType = document.getElementById('preview-file-type');
const previewMetaInfo = document.getElementById('preview-meta-info');
const btnClosePreview = document.getElementById('btn-close-preview');

async function openPreviewModal(item) {
    if (!item) return;

    previewFileName.textContent = item.name;
    previewFileName.title = item.path;
    previewFileType.textContent = item.type === 'pdf' ? 'PDF 封面' : '图片';
    previewMetaInfo.textContent = '正在加载高清预览...';
    
    // 先用现有缩略图快速占位，避免白屏
    if (item.thumb_data) {
        previewImg.src = item.thumb_data;
    } else {
        previewImg.src = '';
    }

    previewModal.classList.remove('hidden');

    try {
        const previewData = await callPy('get_file_preview', item.path);
        if (previewData && previewData.image_data) {
            previewImg.src = previewData.image_data;
            if (previewData.type === 'pdf') {
                previewMetaInfo.textContent = `共 ${previewData.page_count} 页 · ${previewData.size_kb} KB`;
            } else {
                const w = previewData.orig_width || previewData.render_width;
                const h = previewData.orig_height || previewData.render_height;
                previewMetaInfo.textContent = `${w} × ${h} px · ${previewData.size_kb} KB`;
            }
        }
    } catch (err) {
        console.error('加载大图预览失败:', err);
        previewMetaInfo.textContent = `缩略图预览 · ${item.size_kb} KB`;
    }
}

function closePreviewModal() {
    previewModal.classList.add('hidden');
    previewImg.src = '';
}

btnClosePreview.addEventListener('click', closePreviewModal);

// 点击弹窗背景半透明区域关闭
previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) {
        closePreviewModal();
    }
});

// 监听 ESC 键：若正在拖拽则撤销复原，若打开了预览则关闭预览
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (dragSort.active || dragSort.pending) {
            finishPointerDrag(true);
            return;
        }
        if (!previewModal.classList.contains('hidden')) {
            closePreviewModal();
        }
    }
});


// 执行一体化合并导出
document.getElementById('btn-export-mixed-merged').addEventListener('click', async () => {
    if (state.mergeItems.length === 0) {
        showToast('请先添加至少一个 PDF 文件或图片！');
        return;
    }

    const pageSize = document.getElementById('select-page-size').value;
    const marginMm = parseFloat(document.getElementById('select-margin').value);
    const dpi = parseInt(document.getElementById('select-dpi').value);

    showToast('正在导出合并 PDF，请选择保存位置...');
    const result = await callPy('export_mixed_merged', {
        items: state.mergeItems.map(it => ({ type: it.type, path: it.path })),
        page_size: pageSize,
        margin_mm: marginMm,
        dpi: dpi
    });

    if (result && result.success) {
        showToast(`合并成功！共合并 ${result.total_items} 个文件 (${result.pdf_count} 个 PDF, ${result.img_count} 张图片)，总计 ${result.total_pages} 页 (${result.file_size_kb} KB)`);
    }
});


// ==========================================
// 2. PDF 可视化裁剪模块
// ==========================================
const canvas = document.getElementById('crop-canvas');
const ctx = canvas.getContext('2d');
const HANDLE_SIZE = 9;

document.getElementById('btn-open-pdf').addEventListener('click', openPdfDialog);
document.getElementById('btn-reopen-pdf').addEventListener('click', openPdfDialog);

async function openPdfDialog() {
    const path = await callPy('select_pdf');
    if (!path) return;
    loadPdf(path);
}

async function loadPdf(path) {
    showToast('正在解析 PDF 文件...');
    const info = await callPy('get_pdf_info', path);
    if (!info) return;

    state.pdfPath = path;
    state.pdfInfo = info;
    state.currentPageIdx = 0;

    document.getElementById('pdf-doc-name').textContent = info.filename;
    document.getElementById('pdf-doc-pages').textContent = `共 ${info.page_count} 页`;
    document.getElementById('span-total-pages').textContent = info.page_count;
    document.getElementById('input-page-num').max = info.page_count;
    document.getElementById('input-page-num').value = 1;

    document.getElementById('crop-empty-state').classList.add('hidden');
    document.getElementById('crop-workspace').classList.remove('hidden');

    await loadPage(0);
}

async function loadPage(pageIdx) {
    showToast(`正在渲染第 ${pageIdx + 1} 页...`, 1000);
    const pageData = await callPy('render_pdf_page', pageIdx);
    if (!pageData) return;

    state.currentPageIdx = pageIdx;
    state.currentPageData = pageData;
    document.getElementById('input-page-num').value = pageIdx + 1;

    const img = new Image();
    img.onload = () => {
        state.pageImage = img;
        canvas.width = img.width;
        canvas.height = img.height;
        
        state.crop = {
            x: Math.round(img.width * 0.05),
            y: Math.round(img.height * 0.05),
            w: Math.round(img.width * 0.90),
            h: Math.round(img.height * 0.90)
        };
        applyZoom();
        drawCanvas();
        updateHud();
    };
    img.src = pageData.image_data;
}

document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (state.currentPageIdx > 0) loadPage(state.currentPageIdx - 1);
});
document.getElementById('btn-next-page').addEventListener('click', () => {
    if (state.currentPageIdx < state.pdfInfo.page_count - 1) loadPage(state.currentPageIdx + 1);
});
document.getElementById('input-page-num').addEventListener('change', (e) => {
    let p = parseInt(e.target.value) - 1;
    if (isNaN(p) || p < 0) p = 0;
    if (p >= state.pdfInfo.page_count) p = state.pdfInfo.page_count - 1;
    loadPage(p);
});

function applyZoom() {
    canvas.style.transform = `scale(${state.zoom})`;
    canvas.style.transformOrigin = 'center center';
    document.getElementById('zoom-level-text').textContent = `${Math.round(state.zoom * 100)}%`;
}
document.getElementById('btn-zoom-in').addEventListener('click', () => {
    state.zoom = Math.min(2.5, state.zoom + 0.15);
    applyZoom();
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
    state.zoom = Math.max(0.3, state.zoom - 0.15);
    applyZoom();
});
document.getElementById('btn-zoom-100').addEventListener('click', () => {
    state.zoom = 1.0;
    applyZoom();
});
document.getElementById('btn-zoom-fit').addEventListener('click', () => {
    const viewport = document.getElementById('canvas-viewport');
    if (!state.pageImage) return;
    const padding = 60;
    const scaleX = (viewport.clientWidth - padding) / state.pageImage.width;
    const scaleY = (viewport.clientHeight - padding) / state.pageImage.height;
    state.zoom = Math.max(0.2, Math.min(1.0, Math.min(scaleX, scaleY)));
    applyZoom();
});

document.querySelectorAll('.ratio-presets .chip').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.ratio-presets .chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        
        const ratioType = btn.getAttribute('data-ratio');
        switch (ratioType) {
            case '1:1': state.aspectRatio = 1.0; break;
            case '4:3': state.aspectRatio = 4 / 3; break;
            case '16:9': state.aspectRatio = 16 / 9; break;
            case 'a4-v': state.aspectRatio = 210 / 297; break;
            case 'a4-h': state.aspectRatio = 297 / 210; break;
            default: state.aspectRatio = null; break;
        }

        if (state.aspectRatio) {
            let newH = Math.round(state.crop.w / state.aspectRatio);
            if (state.crop.y + newH > canvas.height) {
                newH = canvas.height - state.crop.y;
                state.crop.w = Math.round(newH * state.aspectRatio);
            }
            state.crop.h = newH;
            drawCanvas();
            updateHud();
        }
    });
});

document.getElementById('btn-trim-full').addEventListener('click', () => {
    if (!state.pageImage) return;
    state.crop = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    drawCanvas();
    updateHud();
});
document.getElementById('btn-trim-5').addEventListener('click', () => {
    if (!state.pageImage) return;
    state.crop = {
        x: Math.round(canvas.width * 0.05),
        y: Math.round(canvas.height * 0.05),
        w: Math.round(canvas.width * 0.90),
        h: Math.round(canvas.height * 0.90)
    };
    drawCanvas();
    updateHud();
});
document.getElementById('btn-trim-10').addEventListener('click', () => {
    if (!state.pageImage) return;
    state.crop = {
        x: Math.round(canvas.width * 0.10),
        y: Math.round(canvas.height * 0.10),
        w: Math.round(canvas.width * 0.80),
        h: Math.round(canvas.height * 0.80)
    };
    drawCanvas();
    updateHud();
});

document.querySelectorAll('input[name="crop-range"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        const rangeInput = document.getElementById('input-range-str');
        if (e.target.value === 'range') {
            rangeInput.classList.remove('hidden');
        } else {
            rangeInput.classList.add('hidden');
        }
    });
});

function updateHud() {
    if (!state.currentPageData) return;
    const { orig_width, orig_height, render_width, render_height } = state.currentPageData;

    const scaleX = orig_width / render_width;
    const scaleY = orig_height / render_height;

    const ptW = Math.round(state.crop.w * scaleX);
    const ptH = Math.round(state.crop.h * scaleY);
    const ptX = Math.round(state.crop.x * scaleX);
    const ptY = Math.round(state.crop.y * scaleY);

    const mmW = Math.round(ptW * 25.4 / 72);
    const mmH = Math.round(ptH * 25.4 / 72);

    document.getElementById('hud-width').textContent = `${ptW} pt`;
    document.getElementById('hud-width-mm').textContent = `(${mmW} mm)`;
    document.getElementById('hud-height').textContent = `${ptH} pt`;
    document.getElementById('hud-height-mm').textContent = `(${mmH} mm)`;
    document.getElementById('hud-origin').textContent = `(${ptX}, ${ptY})`;
}

function getHandles(crop) {
    const { x, y, w, h } = crop;
    const half = HANDLE_SIZE / 2;
    return {
        'nw': { x: x - half, y: y - half },
        'n':  { x: x + w / 2 - half, y: y - half },
        'ne': { x: x + w - half, y: y - half },
        'e':  { x: x + w - half, y: y + h / 2 - half },
        'se': { x: x + w - half, y: y + h - half },
        's':  { x: x + w / 2 - half, y: y + h - half },
        'sw': { x: x - half, y: y + h - half },
        'w':  { x: x - half, y: y + h / 2 - half }
    };
}

function drawCanvas() {
    if (!state.pageImage) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.pageImage, 0, 0);

    // 纯黑暗化遮罩 (纯色)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, canvas.width, state.crop.y);
    ctx.fillRect(0, state.crop.y + state.crop.h, canvas.width, canvas.height - (state.crop.y + state.crop.h));
    ctx.fillRect(0, state.crop.y, state.crop.x, state.crop.h);
    ctx.fillRect(state.crop.x + state.crop.w, state.crop.y, canvas.width - (state.crop.x + state.crop.w), state.crop.h);

    // 纯白清晰边框 (纯色)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(state.crop.x, state.crop.y, state.crop.w, state.crop.h);

    // 辅助参考线 (纯白低不透明度)
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(state.crop.x + state.crop.w / 3, state.crop.y);
    ctx.lineTo(state.crop.x + state.crop.w / 3, state.crop.y + state.crop.h);
    ctx.moveTo(state.crop.x + (state.crop.w * 2) / 3, state.crop.y);
    ctx.lineTo(state.crop.x + (state.crop.w * 2) / 3, state.crop.y + state.crop.h);
    ctx.moveTo(state.crop.x, state.crop.y + state.crop.h / 3);
    ctx.lineTo(state.crop.x + state.crop.w, state.crop.y + state.crop.h / 3);
    ctx.moveTo(state.crop.x, state.crop.y + (state.crop.h * 2) / 3);
    ctx.lineTo(state.crop.x + state.crop.w, state.crop.y + (state.crop.h * 2) / 3);
    ctx.stroke();
    ctx.restore();

    // 8 个控制手柄：纯白填充 + 纯黑描边 (纯色对比)
    const handles = getHandles(state.crop);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;

    for (const key in handles) {
        const h = handles[key];
        ctx.fillRect(h.x, h.y, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(h.x, h.y, HANDLE_SIZE, HANDLE_SIZE);
    }
}

function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY)
    };
}

function hitTest(pos) {
    const handles = getHandles(state.crop);
    const hitTolerance = 8;

    for (const key in handles) {
        const h = handles[key];
        if (
            pos.x >= h.x - hitTolerance &&
            pos.x <= h.x + HANDLE_SIZE + hitTolerance &&
            pos.y >= h.y - hitTolerance &&
            pos.y <= h.y + HANDLE_SIZE + hitTolerance
        ) {
            return { type: 'handle', handle: key };
        }
    }

    if (
        pos.x > state.crop.x &&
        pos.x < state.crop.x + state.crop.w &&
        pos.y > state.crop.y &&
        pos.y < state.crop.y + state.crop.h
    ) {
        return { type: 'inside' };
    }

    return { type: 'outside' };
}

const cursorMap = {
    'nw': 'nwse-resize', 'se': 'nwse-resize',
    'ne': 'nesw-resize', 'sw': 'nesw-resize',
    'n': 'ns-resize',    's': 'ns-resize',
    'e': 'ew-resize',    'w': 'ew-resize'
};

canvas.addEventListener('mousedown', (e) => {
    if (!state.pageImage) return;
    const pos = getCanvasPos(e);
    const hit = hitTest(pos);

    state.dragStart = pos;
    state.initialCrop = { ...state.crop };

    if (hit.type === 'handle') {
        state.isResizing = true;
        state.activeHandle = hit.handle;
    } else if (hit.type === 'inside') {
        state.isDragging = true;
    } else {
        state.isDrawing = true;
        state.crop = { x: pos.x, y: pos.y, w: 2, h: 2 };
        drawCanvas();
    }
});

window.addEventListener('mousemove', (e) => {
    if (!state.pageImage) return;
    const pos = getCanvasPos(e);

    if (!state.isDrawing && !state.isDragging && !state.isResizing) {
        const hit = hitTest(pos);
        if (hit.type === 'handle') {
            canvas.style.cursor = cursorMap[hit.handle];
        } else if (hit.type === 'inside') {
            canvas.style.cursor = 'move';
        } else {
            canvas.style.cursor = 'crosshair';
        }
        return;
    }

    const dx = pos.x - state.dragStart.x;
    const dy = pos.y - state.dragStart.y;

    if (state.isDragging) {
        let newX = state.initialCrop.x + dx;
        let newY = state.initialCrop.y + dy;
        newX = Math.max(0, Math.min(canvas.width - state.crop.w, newX));
        newY = Math.max(0, Math.min(canvas.height - state.crop.h, newY));

        state.crop.x = newX;
        state.crop.y = newY;
    } else if (state.isDrawing) {
        let x = Math.min(pos.x, state.dragStart.x);
        let y = Math.min(pos.y, state.dragStart.y);
        let w = Math.abs(pos.x - state.dragStart.x);
        let h = Math.abs(pos.y - state.dragStart.y);

        if (state.aspectRatio) {
            h = Math.round(w / state.aspectRatio);
        }

        w = Math.max(10, Math.min(canvas.width - x, w));
        h = Math.max(10, Math.min(canvas.height - y, h));

        state.crop = { x, y, w, h };
    } else if (state.isResizing) {
        const ic = state.initialCrop;
        let { x, y, w, h } = ic;

        if (state.activeHandle.includes('e')) w = Math.max(20, ic.w + dx);
        if (state.activeHandle.includes('s')) h = Math.max(20, ic.h + dy);
        if (state.activeHandle.includes('w')) {
            const newW = Math.max(20, ic.w - dx);
            x = ic.x + (ic.w - newW);
            w = newW;
        }
        if (state.activeHandle.includes('n')) {
            const newH = Math.max(20, ic.h - dy);
            y = ic.y + (ic.h - newH);
            h = newH;
        }

        x = Math.max(0, x);
        y = Math.max(0, y);
        if (x + w > canvas.width) w = canvas.width - x;
        if (y + h > canvas.height) h = canvas.height - y;

        state.crop = { x, y, w, h };
    }

    drawCanvas();
    updateHud();
});

window.addEventListener('mouseup', () => {
    state.isDrawing = false;
    state.isDragging = false;
    state.isResizing = false;
    state.activeHandle = null;
});

document.getElementById('btn-export-cropped').addEventListener('click', async () => {
    if (!state.pdfPath || !state.currentPageData) return;

    const targetMode = document.querySelector('input[name="crop-range"]:checked').value;
    const pageRangeStr = document.getElementById('input-range-str').value.trim();

    const normCrop = {
        x: state.crop.x / canvas.width,
        y: state.crop.y / canvas.height,
        w: state.crop.w / canvas.width,
        h: state.crop.h / canvas.height
    };

    showToast('正在导出裁剪后的 PDF...');
    const result = await callPy('export_cropped_pdf', {
        input_path: state.pdfPath,
        norm_crop: normCrop,
        target_mode: targetMode,
        current_page_idx: state.currentPageIdx,
        page_range_str: pageRangeStr
    });

    if (result && result.success) {
        showToast(`导出成功！已处理 ${result.cropped_pages_count} 个页面 (${result.file_size_kb} KB)`);
    }
});


// ==========================================
// 3. 桌面文件直接拖拽导入支持 (Desktop Drag & Drop)
// ==========================================
const globalDropOverlay = document.getElementById('global-drop-overlay');
let dragEnterCounter = 0;

function isExternalFileDrag(e) {
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    for (let i = 0; i < e.dataTransfer.types.length; i++) {
        if (e.dataTransfer.types[i] === 'Files') return true;
    }
    return false;
}

function showGlobalDrop(show) {
    if (!globalDropOverlay) return;
    if (show) globalDropOverlay.classList.remove('hidden');
    else globalDropOverlay.classList.add('hidden');
}

function readFileAsBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

window.addEventListener('dragenter', (e) => {
    if (!isExternalFileDrag(e)) return;
    dragEnterCounter++;
    showGlobalDrop(true);
});

window.addEventListener('dragleave', (e) => {
    if (!isExternalFileDrag(e)) return;
    dragEnterCounter--;
    if (dragEnterCounter <= 0) {
        dragEnterCounter = 0;
        showGlobalDrop(false);
    }
});

window.addEventListener('dragover', (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', async (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    dragEnterCounter = 0;
    showGlobalDrop(false);

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    showToast(`正在解析拖入的 ${files.length} 个文件...`);

    const filePayload = [];
    for (const file of files) {
        if (file.path) {
            filePayload.push({
                path: file.path,
                name: file.name
            });
        } else {
            const b64 = await readFileAsBase64(file);
            if (b64) {
                filePayload.push({
                    name: file.name,
                    base64_data: b64
                });
            }
        }
    }

    if (filePayload.length === 0) {
        showToast('未能读取到有效文件');
        return;
    }

    const result = await callPy('handle_dropped_files', filePayload);
    if (!result) return;

    const { pdfs, images } = result;
    const hasPdfs = pdfs && pdfs.length > 0;
    const hasImages = images && images.length > 0;

    if (!hasPdfs && !hasImages) {
        showToast('未能识别有效格式，支持 PDF 与常见图片格式 (JPG/PNG/WEBP/BMP)');
        return;
    }

    // 1. 如果在裁剪页面
    if (state.currentTab === 'crop-tab') {
        if (hasPdfs) {
            const firstPdf = pdfs[0];
            await loadPdf(firstPdf.path);
            showToast(`已加载拖入的 PDF 文件: ${firstPdf.name}`);
        } else if (hasImages) {
            switchTab('merge-tab');
            const newImages = images.map(img => ({
                id: generateId(),
                type: 'image',
                path: img.path,
                name: img.name,
                page_count: 1,
                size_kb: img.size_kb || 0,
                width: img.width || 0,
                height: img.height || 0,
                thumb_data: img.thumb_data || ''
            }));
            state.mergeItems.push(...newImages);
            renderMergeGrid();
            showToast(`已切换至合并板块，并添加 ${newImages.length} 张图片`);
        }
    }
    // 2. 如果在合并板块 (支持 PDF 和 图片直接追加到网格)
    else {
        const existing = new Set(state.mergeItems.map(item => item.path));
        const toAdd = [];

        if (hasPdfs) {
            pdfs.filter(p => !existing.has(p.path)).forEach(p => {
                toAdd.push({
                    id: generateId(),
                    type: 'pdf',
                    path: p.path,
                    name: p.name,
                    page_count: p.page_count || 1,
                    size_kb: p.size_kb || 0,
                    thumb_data: p.thumb_data || ''
                });
            });
        }

        if (hasImages) {
            images.filter(img => !existing.has(img.path)).forEach(img => {
                toAdd.push({
                    id: generateId(),
                    type: 'image',
                    path: img.path,
                    name: img.name,
                    page_count: 1,
                    size_kb: img.size_kb || 0,
                    width: img.width || 0,
                    height: img.height || 0,
                    thumb_data: img.thumb_data || ''
                });
            });
        }

        if (toAdd.length > 0) {
            state.mergeItems.push(...toAdd);
            renderMergeGrid();
            showToast(`成功添加 ${toAdd.length} 个拖入的文件`);
        } else {
            showToast('拖入的文件已存在于合并列表中');
        }
    }
});
