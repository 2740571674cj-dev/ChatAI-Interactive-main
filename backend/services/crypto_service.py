"""
加密服务模块
提供 API Key 的 AES 加密/解密和掩码显示功能。
使用 Fernet 对称加密（基于 AES-128-CBC）。
"""
import base64
import hashlib

from cryptography.fernet import Fernet

from config import settings


def _get_fernet() -> Fernet:
    """从配置的密钥生成 Fernet 实例"""
    # 将任意长度密钥哈希为 32 字节，再 base64 编码为 Fernet 所需的格式
    key_bytes = hashlib.sha256(settings.ENCRYPTION_KEY.encode()).digest()
    fernet_key = base64.urlsafe_b64encode(key_bytes)
    return Fernet(fernet_key)


def encrypt_api_key(plain_key: str) -> str:
    """加密 API Key，返回 base64 编码的密文字符串"""
    if not plain_key:
        return ""
    f = _get_fernet()
    return f.encrypt(plain_key.encode()).decode()


def decrypt_api_key(encrypted_key: str) -> str:
    """解密 API Key，返回明文"""
    if not encrypted_key:
        return ""
    try:
        f = _get_fernet()
        return f.decrypt(encrypted_key.encode()).decode()
    except Exception:
        # 解密失败时返回空字符串，避免崩溃
        return ""


def mask_api_key(key: str) -> str:
    """
    将 API Key 掩码处理：显示前 3 位和后 4 位。
    例如: sk-abcdefgh12345 → sk-****2345
    """
    if not key or len(key) < 8:
        return "****"
    return f"{key[:3]}****{key[-4:]}"
