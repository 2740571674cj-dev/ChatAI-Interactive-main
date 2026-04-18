"""
文件解析服务
提供通用文件内容的文本提取功能。
"""


def extract_text_from_file(content_bytes: bytes, extension: str) -> str:
    """
    尝试从文件字节内容中提取可读文本。
    对于未知格式，尝试 UTF-8 和 GBK 解码。
    
    Args:
        content_bytes: 文件的原始字节内容
        extension: 文件扩展名（如 ".pdf", ".docx"）
    
    Returns:
        提取的文本内容，提取失败则返回提示信息
    """
    # 对于常见的二进制格式，返回提示信息
    binary_extensions = {".pdf", ".docx", ".xlsx", ".pptx", ".zip", ".rar", ".7z",
                         ".exe", ".dll", ".so", ".dylib", ".bin", ".dat"}
    
    if extension.lower() in binary_extensions:
        return f"[此文件为二进制格式 ({extension})，暂不支持直接解析。请转为文本格式后上传。]"
    
    # 尝试文本解码
    for encoding in ["utf-8", "gbk", "latin-1"]:
        try:
            return content_bytes.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    
    return "[无法解析此文件的文本内容]"
