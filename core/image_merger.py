import os
from PIL import Image

# 标准纸张尺寸定义 (单位: 毫米 mm)
PAPER_SIZES_MM = {
    "A4": (210, 297),
    "A4_landscape": (297, 210),
    "A3": (297, 420),
    "Letter": (215.9, 279.4),
}

def merge_images_to_pdf(
    image_paths: list[str],
    output_pdf_path: str,
    page_size: str = "original",
    margin_mm: float = 0.0,
    dpi: int = 150
) -> dict:
    """
    将图片列表合并为一个 PDF 文件
    
    :param image_paths: 图片文件路径列表
    :param output_pdf_path: 输出 PDF 路径
    :param page_size: 'original' 保持原图尺寸，或 'A4', 'A4_landscape', 'Letter'
    :param margin_mm: 页面边距 (毫米)
    :param dpi: 重建页面时的分辨率 (默认 150 DPI)
    :return: 结果统计字典
    """
    if not image_paths:
        raise ValueError("请至少选择一张图片！")

    processed_images = []

    # mm 转 像素 (在指定 dpi 下)
    mm_to_px = lambda mm: int(mm * dpi / 25.4)
    margin_px = mm_to_px(margin_mm)

    for path in image_paths:
        if not os.path.exists(path):
            continue
        
        with Image.open(path) as img:
            # 统一转为 RGB 格式 (处理 PNG 透明通道或 RGBA，避免保存为 PDF 时报错)
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                bg = Image.new("RGB", img.size, (255, 255, 255))
                if img.mode != "RGBA":
                    img = img.convert("RGBA")
                bg.paste(img, mask=img.split()[3])
                img_rgb = bg
            else:
                img_rgb = img.convert("RGB")

            if page_size == "original":
                # 保持原图尺寸
                processed_images.append(img_rgb)
            else:
                # 缩放并居中放置在指定纸张尺寸的白色画布上
                target_mm = PAPER_SIZES_MM.get(page_size, PAPER_SIZES_MM["A4"])
                target_w_px = mm_to_px(target_mm[0])
                target_h_px = mm_to_px(target_mm[1])

                canvas = Image.new("RGB", (target_w_px, target_h_px), (255, 255, 255))
                
                # 计算可用区域 (扣除边距)
                avail_w = max(10, target_w_px - 2 * margin_px)
                avail_h = max(10, target_h_px - 2 * margin_px)

                # 等比缩放
                img_w, img_h = img_rgb.size
                scale = min(avail_w / img_w, avail_h / img_h)
                new_w = max(1, int(img_w * scale))
                new_h = max(1, int(img_h * scale))

                resized = img_rgb.resize((new_w, new_h), Image.Resampling.LANCZOS)

                # 居中粘贴
                pos_x = margin_px + (avail_w - new_w) // 2
                pos_y = margin_px + (avail_h - new_h) // 2
                canvas.paste(resized, (pos_x, pos_y))
                processed_images.append(canvas)

    if not processed_images:
        raise ValueError("未能成功处理任何有效图片！")

    first_image = processed_images[0]
    rest_images = processed_images[1:]

    # 保存为 PDF
    first_image.save(
        output_pdf_path,
        "PDF",
        resolution=float(dpi),
        save_all=True,
        append_images=rest_images
    )

    file_size_kb = os.path.getsize(output_pdf_path) / 1024
    return {
        "success": True,
        "page_count": len(processed_images),
        "output_path": output_pdf_path,
        "file_size_kb": round(file_size_kb, 2)
    }
