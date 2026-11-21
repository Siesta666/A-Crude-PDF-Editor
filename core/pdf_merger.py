import os
import io
import base64
from PIL import Image
import pypdf
import pypdfium2 as pdfium

PAPER_SIZES_MM = {
    "A4": (210, 297),
    "A4_landscape": (297, 210),
    "A3": (297, 420),
    "Letter": (215.9, 279.4),
}

def get_pdf_metadata(pdf_path: str) -> dict:
    """获取单个 PDF 文件的基本元数据及第 1 页预览缩略图"""
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"文件不存在: {pdf_path}")

    reader = pypdf.PdfReader(pdf_path)
    page_count = len(reader.pages)
    size_kb = round(os.path.getsize(pdf_path) / 1024, 1)

    thumb_data = ""
    try:
        doc = pdfium.PdfDocument(pdf_path)
        if len(doc) > 0:
            page = doc[0]
            bitmap = page.render(scale=1.0)
            pil_img = bitmap.to_pil()
            pil_img.thumbnail((320, 420))
            if pil_img.mode != "RGB":
                pil_img = pil_img.convert("RGB")
            buf = io.BytesIO()
            pil_img.save(buf, format="JPEG", quality=80)
            b64_thumb = base64.b64encode(buf.getvalue()).decode("ascii")
            thumb_data = f"data:image/jpeg;base64,{b64_thumb}"
        doc.close()
    except Exception as e:
        print(f"生成 PDF 预览图失败: {e}")

    return {
        "type": "pdf",
        "path": pdf_path,
        "name": os.path.basename(pdf_path),
        "page_count": page_count,
        "size_kb": size_kb,
        "thumb_data": thumb_data
    }

def get_image_metadata(image_path: str) -> dict:
    """获取单个图片文件的基本元数据及缩略图"""
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"文件不存在: {image_path}")

    size_kb = round(os.path.getsize(image_path) / 1024, 1)
    thumb_data = ""
    width, height = 0, 0

    try:
        with Image.open(image_path) as img:
            width, height = img.size
            thumb = img.copy()
            thumb.thumbnail((320, 420))
            if thumb.mode != "RGB":
                thumb = thumb.convert("RGB")
            buf = io.BytesIO()
            thumb.save(buf, format="JPEG", quality=80)
            b64_thumb = base64.b64encode(buf.getvalue()).decode("ascii")
            thumb_data = f"data:image/jpeg;base64,{b64_thumb}"
    except Exception as e:
        print(f"读取图片元数据失败: {e}")

    return {
        "type": "image",
        "path": image_path,
        "name": os.path.basename(image_path),
        "page_count": 1,
        "size_kb": size_kb,
        "width": width,
        "height": height,
        "thumb_data": thumb_data
    }

def get_file_preview(file_path: str, max_dim: int = 1600) -> dict:
    """获取文件的高清晰度大图预览数据，供右下角预览弹窗使用"""
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"文件不存在: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()
    name = os.path.basename(file_path)
    size_kb = round(os.path.getsize(file_path) / 1024, 1)

    if ext == ".pdf":
        doc = pdfium.PdfDocument(file_path)
        page_count = len(doc)
        if page_count == 0:
            doc.close()
            raise ValueError("PDF 页面为空")
        page = doc[0]
        orig_w, orig_h = page.get_size()
        scale = min(max_dim / max(orig_w, orig_h), 2.5)
        bitmap = page.render(scale=scale)
        pil_img = bitmap.to_pil()
        doc.close()
        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=90)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {
            "type": "pdf",
            "name": name,
            "path": file_path,
            "size_kb": size_kb,
            "page_count": page_count,
            "render_width": pil_img.width,
            "render_height": pil_img.height,
            "image_data": f"data:image/jpeg;base64,{b64}"
        }
    else:
        with Image.open(file_path) as img:
            orig_w, orig_h = img.size
            preview_img = img.copy()
            if max(orig_w, orig_h) > max_dim:
                preview_img.thumbnail((max_dim, max_dim))
            if preview_img.mode != "RGB":
                preview_img = preview_img.convert("RGB")
            buf = io.BytesIO()
            preview_img.save(buf, format="JPEG", quality=90)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            return {
                "type": "image",
                "name": name,
                "path": file_path,
                "size_kb": size_kb,
                "orig_width": orig_w,
                "orig_height": orig_h,
                "render_width": preview_img.width,
                "render_height": preview_img.height,
                "image_data": f"data:image/jpeg;base64,{b64}"
            }

def convert_single_image_to_pdf_bytes(img_path: str, page_size: str = "A4", margin_mm: float = 0.0, dpi: int = 150) -> bytes:
    """将单张图片按设置转换为 PDF 字节流"""
    mm_to_px = lambda mm: int(mm * dpi / 25.4)
    margin_px = mm_to_px(margin_mm)

    with Image.open(img_path) as img:
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode != "RGBA":
                img = img.convert("RGBA")
            bg.paste(img, mask=img.split()[3])
            img_rgb = bg
        else:
            img_rgb = img.convert("RGB")

        if page_size == "original":
            target_img = img_rgb
        else:
            target_mm = PAPER_SIZES_MM.get(page_size, PAPER_SIZES_MM["A4"])
            target_w_px = mm_to_px(target_mm[0])
            target_h_px = mm_to_px(target_mm[1])
            canvas = Image.new("RGB", (target_w_px, target_h_px), (255, 255, 255))
            avail_w = max(10, target_w_px - 2 * margin_px)
            avail_h = max(10, target_h_px - 2 * margin_px)
            img_w, img_h = img_rgb.size
            scale = min(avail_w / img_w, avail_h / img_h)
            new_w = max(1, int(img_w * scale))
            new_h = max(1, int(img_h * scale))
            resized = img_rgb.resize((new_w, new_h), Image.Resampling.LANCZOS)
            pos_x = margin_px + (avail_w - new_w) // 2
            pos_y = margin_px + (avail_h - new_h) // 2
            canvas.paste(resized, (pos_x, pos_y))
            target_img = canvas

        buf = io.BytesIO()
        target_img.save(buf, format="PDF", resolution=float(dpi))
        return buf.getvalue()

def merge_mixed_items(
    items: list[dict],
    output_path: str,
    page_size: str = "A4",
    margin_mm: float = 0.0,
    dpi: int = 150
) -> dict:
    """
    按指定顺序合并任意 PDF 文件和图片文件至同一个 PDF 中
    :param items: [{'path': str, 'type': 'pdf'|'image'}]
    :param output_path: 输出 PDF 目标路径
    """
    if not items:
        raise ValueError("请至少添加一个文件！")

    writer = pypdf.PdfWriter()
    total_pages = 0
    pdf_count = 0
    img_count = 0

    for item in items:
        path = item.get("path")
        item_type = item.get("type", "pdf")
        if not path or not os.path.exists(path):
            continue

        if item_type == "pdf":
            reader = pypdf.PdfReader(path)
            for page in reader.pages:
                writer.add_page(page)
                total_pages += 1
            pdf_count += 1
        else:
            pdf_bytes = convert_single_image_to_pdf_bytes(path, page_size, margin_mm, dpi)
            img_reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
            for page in img_reader.pages:
                writer.add_page(page)
                total_pages += 1
            img_count += 1

    if total_pages == 0:
        raise ValueError("未能处理任何有效页面！")

    with open(output_path, "wb") as f:
        writer.write(f)

    file_size_kb = round(os.path.getsize(output_path) / 1024, 2)
    return {
        "success": True,
        "total_items": len(items),
        "pdf_count": pdf_count,
        "img_count": img_count,
        "total_pages": total_pages,
        "output_path": output_path,
        "file_size_kb": file_size_kb
    }

def merge_pdf_files(pdf_paths: list[str], output_path: str) -> dict:
    """兼容旧接口"""
    items = [{"type": "pdf", "path": p} for p in pdf_paths]
    return merge_mixed_items(items, output_path)
