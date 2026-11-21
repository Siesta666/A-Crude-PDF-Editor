import os
import sys
import io
import base64
import tkinter as tk
from tkinter import filedialog
from PIL import Image
import webview

# 引入核心业务模块
from core.pdf_cropper import PDFCropper
from core.image_merger import merge_images_to_pdf
from core.pdf_merger import (
    merge_pdf_files,
    get_pdf_metadata,
    get_image_metadata,
    get_file_preview,
    merge_mixed_items
)

class StudioAPI:
    def __init__(self):
        self._window = None
        self.cropper = None

    def set_window(self, window):
        self._window = window

    # ------------------ 文件对话框辅助 ------------------
    def _open_file(self, file_types, multiple=False):
        """选择文件，优先使用 pywebview 原生窗口对话框，兜底使用 tkinter"""
        try:
            if self._window:
                res = self._window.create_file_dialog(
                    webview.OPEN_DIALOG,
                    allow_multiple=multiple,
                    file_types=file_types
                )
                if res:
                    return list(res) if multiple else res[0]
                return [] if multiple else None
        except Exception as e:
            print(f"Webview dialog fallback to tkinter: {e}")

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        if multiple:
            res = filedialog.askopenfilenames(filetypes=[("PDF Files", "*.pdf")] if "PDF" in str(file_types) else [("Files", "*.*")])
            root.destroy()
            return list(res) if res else []
        else:
            res = filedialog.askopenfilename()
            root.destroy()
            return res if res else None

    def _save_file(self, file_types, default_name="export.pdf"):
        """保存文件对话框"""
        try:
            if self._window:
                res = self._window.create_file_dialog(
                    webview.SAVE_DIALOG,
                    save_filename=default_name,
                    file_types=file_types
                )
                if res:
                    return res if isinstance(res, str) else res[0]
                return None
        except Exception as e:
            print(f"Webview save dialog fallback to tkinter: {e}")

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        res = filedialog.asksaveasfilename(
            initialfile=default_name,
            defaultextension=".pdf",
            filetypes=[("PDF Files", "*.pdf")]
        )
        root.destroy()
        return res if res else None

    # ------------------ 1. PDF 页面裁剪 API ------------------
    def select_pdf(self):
        """打开单个 PDF 文件用于裁剪"""
        path = self._open_file(
            file_types=("PDF Files (*.pdf)", "All files (*.*)"),
            multiple=False
        )
        return path

    def get_pdf_info(self, path):
        """加载 PDF 基本元数据"""
        if not path or not os.path.exists(path):
            raise FileNotFoundError("文件不存在")
        self.cropper = PDFCropper(path)
        return self.cropper.get_info()

    def render_pdf_page(self, page_idx):
        """渲染 PDF 页面为前端可显示的图片"""
        if not self.cropper:
            raise RuntimeError("请先打开 PDF 文件")
        return self.cropper.render_page_base64(int(page_idx))

    def export_cropped_pdf(self, params):
        """执行页面裁剪并保存"""
        if not self.cropper:
            raise RuntimeError("未加载 PDF 文件")

        orig_name = os.path.splitext(os.path.basename(self.cropper.pdf_path))[0]
        save_path = self._save_file(
            file_types=("PDF Files (*.pdf)",),
            default_name=f"{orig_name}_cropped.pdf"
        )
        if not save_path:
            return {"success": False, "canceled": True}

        result = self.cropper.crop_and_export(
            output_path=save_path,
            norm_crop=params["norm_crop"],
            target_mode=params.get("target_mode", "current"),
            current_page_idx=params.get("current_page_idx", 0),
            page_range_str=params.get("page_range_str", "")
        )
        return result

    # ------------------ 2. PDF & 图片 统一合并板块 API ------------------
    def select_multiple_pdfs(self):
        """多选 PDF 文件并获取每个文件的元数据与封面预览"""
        paths = self._open_file(
            file_types=("PDF Files (*.pdf)", "All files (*.*)"),
            multiple=True
        )
        if not paths:
            return []

        results = []
        for p in paths:
            try:
                meta = get_pdf_metadata(p)
                results.append(meta)
            except Exception as e:
                print(f"读取 PDF 失败 {p}: {e}")
        return results

    def select_images(self):
        """多选图片并生成缩略图与尺寸信息"""
        paths = self._open_file(
            file_types=(
                "Image Files (*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.tiff)",
                "All files (*.*)"
            ),
            multiple=True
        )
        if not paths:
            return []

        images_data = []
        for p in paths:
            try:
                meta = get_image_metadata(p)
                images_data.append(meta)
            except Exception as e:
                print(f"加载图片失败 {p}: {e}")

        return images_data

    def get_file_preview(self, path):
        """获取大图高清预览 (图片原图/高清晰度，PDF第1页高画质)"""
        return get_file_preview(path)

    def export_mixed_merged(self, params):
        """按指定顺序合并任意 PDF 与图片文件"""
        items = params.get("items", [])
        if not items:
            raise ValueError("至少需要选择一个文件进行合并！")

        save_path = self._save_file(
            file_types=("PDF Files (*.pdf)",),
            default_name="merged_output.pdf"
        )
        if not save_path:
            return {"success": False, "canceled": True}

        result = merge_mixed_items(
            items=items,
            output_path=save_path,
            page_size=params.get("page_size", "A4"),
            margin_mm=float(params.get("margin_mm", 0.0)),
            dpi=int(params.get("dpi", 150))
        )
        return result

    # 兼容历史调用接口
    def export_merged_pdfs(self, params):
        pdf_paths = params.get("pdf_paths", [])
        items = [{"type": "pdf", "path": p} for p in pdf_paths]
        return self.export_mixed_merged({"items": items})

    def export_merged_pdf(self, params):
        image_paths = params.get("image_paths", [])
        items = [{"type": "image", "path": p} for p in image_paths]
        return self.export_mixed_merged({
            "items": items,
            "page_size": params.get("page_size", "A4"),
            "margin_mm": params.get("margin_mm", 0.0),
            "dpi": params.get("dpi", 150)
        })

    # ------------------ 3. 桌面文件拖放处理 API ------------------
    def handle_dropped_files(self, files_info):
        """处理从桌面或文件夹直接拖拽进入窗口的文件列表"""
        import tempfile

        pdf_list = []
        image_list = []

        temp_drop_dir = os.path.join(tempfile.gettempdir(), "pdf_studio_dropped")
        os.makedirs(temp_drop_dir, exist_ok=True)

        for item in files_info:
            file_path = item.get("path")
            file_name = item.get("name") or (os.path.basename(file_path) if file_path else "unknown")

            # 若未直接获取到本地路径，则将拖拽传递的 Base64 写入临时文件
            if (not file_path or not os.path.exists(file_path)) and item.get("base64_data"):
                raw_b64 = item["base64_data"]
                if "," in raw_b64:
                    raw_b64 = raw_b64.split(",", 1)[1]
                file_path = os.path.join(temp_drop_dir, file_name)
                try:
                    with open(file_path, "wb") as f:
                        f.write(base64.b64decode(raw_b64))
                except Exception as e:
                    print(f"写入临时拖拽文件失败 {file_name}: {e}")
                    continue

            if not file_path or not os.path.exists(file_path):
                continue

            ext = os.path.splitext(file_path)[1].lower()

            if ext == ".pdf":
                try:
                    meta = get_pdf_metadata(file_path)
                    pdf_list.append(meta)
                except Exception as e:
                    print(f"处理拖入 PDF 失败 {file_path}: {e}")
            elif ext in (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"):
                try:
                    meta = get_image_metadata(file_path)
                    image_list.append(meta)
                except Exception as e:
                    print(f"处理拖入图片失败 {file_path}: {e}")

        return {
            "pdfs": pdf_list,
            "images": image_list
        }


def get_resource_path(relative_path):
    """获取资源文件绝对路径，支持开发模式与 PyInstaller 打包后的临时解压目录"""
    base_path = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_path, relative_path)

def main():
    api = StudioAPI()
    index_path = get_resource_path(os.path.join("gui", "index.html"))

    window = webview.create_window(
        title="PDF Studio - PDF & 图片合并 / 页面可视化裁剪",
        url=f"file:///{os.path.abspath(index_path)}",
        js_api=api,
        width=1220,
        height=820,
        min_size=(980, 660)
    )
    api.set_window(window)

    # 启动桌面窗口
    webview.start(debug=False)

if __name__ == "__main__":
    main()
