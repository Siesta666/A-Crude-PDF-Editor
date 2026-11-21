import os
import io
import base64
import pypdf
import pypdfium2 as pdfium

class PDFCropper:
    def __init__(self, pdf_path: str):
        if not os.path.exists(pdf_path):
            raise FileNotFoundError(f"PDF 文件不存在: {pdf_path}")
        self.pdf_path = pdf_path
        self._doc = pdfium.PdfDocument(pdf_path)
        self.page_count = len(self._doc)

    def get_info(self) -> dict:
        """获取 PDF 基本信息"""
        pages_info = []
        for i in range(self.page_count):
            page = self._doc[i]
            # pypdfium2 默认返回 points (72 pt = 1 英寸)
            w, h = page.get_size()
            pages_info.append({"page_index": i, "width": round(w, 2), "height": round(h, 2)})
        
        return {
            "page_count": self.page_count,
            "filename": os.path.basename(self.pdf_path),
            "file_size_kb": round(os.path.getsize(self.pdf_path) / 1024, 2),
            "pages": pages_info
        }

    def render_page_base64(self, page_index: int, max_dim: int = 1400) -> dict:
        """
        渲染指定页面为 Base64 JPEG 图片，供前端交互画布绘制
        :param page_index: 0-indexed 页码
        :param max_dim: 渲染图像的最大边长 (px)
        """
        if page_index < 0 or page_index >= self.page_count:
            raise IndexError("页码超出范围")

        page = self._doc[page_index]
        orig_w, orig_h = page.get_size()

        # 计算自适应 scale，使得绘制既清晰又加载飞快
        scale = min(max_dim / max(orig_w, orig_h), 2.5)
        bitmap = page.render(scale=scale)
        pil_image = bitmap.to_pil()

        img_w, img_h = pil_image.size
        buf = io.BytesIO()
        pil_image.save(buf, format="JPEG", quality=90)
        b64_str = base64.b64encode(buf.getvalue()).decode("ascii")

        return {
            "page_index": page_index,
            "orig_width": orig_w,
            "orig_height": orig_h,
            "render_width": img_w,
            "render_height": img_h,
            "image_data": f"data:image/jpeg;base64,{b64_str}"
        }

    @staticmethod
    def parse_page_range(range_str: str, max_pages: int) -> set[int]:
        """解析诸如 '1, 3-5, 8' 格式的页码输入，返回 0-indexed 页码集合"""
        pages = set()
        parts = [p.strip() for p in range_str.split(",") if p.strip()]
        for part in parts:
            if "-" in part:
                sub_parts = part.split("-")
                if len(sub_parts) == 2 and sub_parts[0].isdigit() and sub_parts[1].isdigit():
                    start, end = int(sub_parts[0]), int(sub_parts[1])
                    for p in range(start, end + 1):
                        idx = p - 1
                        if 0 <= idx < max_pages:
                            pages.add(idx)
            elif part.isdigit():
                idx = int(part) - 1
                if 0 <= idx < max_pages:
                    pages.add(idx)
        return pages

    def crop_and_export(
        self,
        output_path: str,
        norm_crop: dict,
        target_mode: str = "current",
        current_page_idx: int = 0,
        page_range_str: str = ""
    ) -> dict:
        """
        无损裁剪 PDF 页面
        :param output_path: 输出文件路径
        :param norm_crop: 归一化裁剪坐标 {'x': 0~1, 'y': 0~1 (从顶部起), 'w': 0~1, 'h': 0~1}
        :param target_mode: 'current' (仅当前页), 'all' (全部页), 'range' (指定范围)
        :param current_page_idx: 当前页码
        :param page_range_str: 页码范围字符串
        """
        norm_x = max(0.0, min(1.0, float(norm_crop.get("x", 0.0))))
        norm_y = max(0.0, min(1.0, float(norm_crop.get("y", 0.0))))
        norm_w = max(0.01, min(1.0 - norm_x, float(norm_crop.get("w", 1.0))))
        norm_h = max(0.01, min(1.0 - norm_y, float(norm_crop.get("h", 1.0))))

        reader = pypdf.PdfReader(self.pdf_path)
        writer = pypdf.PdfWriter()

        total = len(reader.pages)
        if target_mode == "current":
            target_indices = {current_page_idx}
        elif target_mode == "all":
            target_indices = set(range(total))
        elif target_mode == "range":
            target_indices = self.parse_page_range(page_range_str, total)
        else:
            target_indices = {current_page_idx}

        for i, page in enumerate(reader.pages):
            if i in target_indices:
                mb = page.mediabox
                mb_x0 = float(mb.lower_left[0])
                mb_y0 = float(mb.lower_left[1])
                w_pt = float(mb.width)
                h_pt = float(mb.height)

                # 将前端顶部原点 (0,0) 的归一化坐标转换为 PDF 左下角原点的点坐标
                crop_x0 = mb_x0 + norm_x * w_pt
                crop_x1 = mb_x0 + (norm_x + norm_w) * w_pt
                crop_y0 = mb_y0 + (1.0 - (norm_y + norm_h)) * h_pt
                crop_y1 = mb_y0 + (1.0 - norm_y) * h_pt

                page.cropbox.lower_left = (crop_x0, crop_y0)
                page.cropbox.upper_right = (crop_x1, crop_y1)

            writer.add_page(page)

        with open(output_path, "wb") as f:
            writer.write(f)

        file_size_kb = os.path.getsize(output_path) / 1024
        return {
            "success": True,
            "cropped_pages_count": len(target_indices),
            "output_path": output_path,
            "file_size_kb": round(file_size_kb, 2)
        }
