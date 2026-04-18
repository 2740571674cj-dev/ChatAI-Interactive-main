"""
文件上传路由
支持图片和文档文件的上传与解析。
"""
import base64
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException

from config import settings
from schemas import UploadResponse
from services.file_service import extract_text_from_file

router = APIRouter(prefix="/api/upload", tags=["文件上传"])

# 允许的文件类型
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
DOCUMENT_EXTENSIONS = {".txt", ".md", ".py", ".js", ".ts", ".java", ".c", ".cpp", ".h",
                       ".go", ".rs", ".rb", ".php", ".html", ".css", ".json", ".xml",
                       ".yaml", ".yml", ".toml", ".ini", ".cfg", ".csv", ".log", ".sh",
                       ".bat", ".ps1", ".sql", ".r", ".swift", ".kt", ".scala", ".lua"}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20MB


@router.post("", response_model=UploadResponse)
async def upload_file(file: UploadFile = File(...)):
    """
    上传文件并解析内容。
    - 图片：转为 base64 data URL，可直接传给多模态模型
    - 文档：提取文本内容，作为对话上下文
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")
    
    ext = Path(file.filename).suffix.lower()
    content_bytes = await file.read()
    
    if len(content_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail=f"文件大小超过限制 ({MAX_FILE_SIZE // 1024 // 1024}MB)")
    
    # 判断文件类型
    if ext in IMAGE_EXTENSIONS:
        # 图片：转为 base64 data URL
        mime_type = file.content_type or "image/png"
        b64 = base64.b64encode(content_bytes).decode("utf-8")
        content = f"data:{mime_type};base64,{b64}"
        file_type = "image"
    elif ext in DOCUMENT_EXTENSIONS:
        # 文本文档：直接解码
        try:
            content = content_bytes.decode("utf-8")
        except UnicodeDecodeError:
            try:
                content = content_bytes.decode("gbk")
            except UnicodeDecodeError:
                content = content_bytes.decode("utf-8", errors="replace")
        file_type = "document"
    else:
        # 尝试使用通用文本提取
        content = extract_text_from_file(content_bytes, ext)
        file_type = "document"
    
    # 保存文件到上传目录（可选，用于后续引用）
    save_path = settings.UPLOAD_DIR / file.filename
    save_path.write_bytes(content_bytes)
    
    return UploadResponse(
        filename=file.filename,
        file_type=file_type,
        content=content,
        size_bytes=len(content_bytes),
    )
