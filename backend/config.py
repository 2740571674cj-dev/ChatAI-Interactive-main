"""
应用配置模块
通过环境变量或 .env 文件加载配置，提供统一的配置访问接口。
"""
import os
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """应用全局配置"""
    
    # 项目根目录
    BASE_DIR: Path = Path(__file__).resolve().parent
    
    # 数据库配置 - 默认使用 SQLite，生产环境可切换为 PostgreSQL
    DATABASE_URL: str = f"sqlite+aiosqlite:///{Path(__file__).resolve().parent / 'chatai.db'}"
    
    # CORS 配置 - 允许前端跨域访问
    CORS_ORIGINS: list[str] = ["*"]
    
    # 上传文件目录
    UPLOAD_DIR: Path = Path(__file__).resolve().parent / "uploads"
    
    # GitHub 仓库克隆临时目录
    GITHUB_CLONE_DIR: Path = Path(__file__).resolve().parent / "github_repos"
    
    # ChromaDB 向量数据库持久化目录
    CHROMA_PERSIST_DIR: Path = Path(__file__).resolve().parent / "chroma_db"
    
    # AES 加密密钥（用于加密存储 API Key） 生产环境务必修改
    ENCRYPTION_KEY: str = "chatai-default-encryption-key-32b"
    
    # 对话上下文最大消息数
    MAX_CONTEXT_MESSAGES: int = 20
    
    # 服务端口
    PORT: int = 8000

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


# 全局单例
settings = Settings()

# 确保必要目录存在
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
os.makedirs(settings.GITHUB_CLONE_DIR, exist_ok=True)
os.makedirs(settings.CHROMA_PERSIST_DIR, exist_ok=True)
