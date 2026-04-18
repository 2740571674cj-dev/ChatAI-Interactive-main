"""
数据库连接与会话管理模块
使用 SQLAlchemy 2.0 异步引擎，支持 SQLite 和 PostgreSQL。
"""
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from config import settings


# 创建异步引擎
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,  # 调试时可设为 True 以打印 SQL
    future=True,
)

# 异步会话工厂
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


# ORM 基类
class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    """FastAPI 依赖注入：获取数据库会话"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db():
    """初始化数据库：创建所有表"""
    async with engine.begin() as conn:
        from models import Base  # noqa: F811 - 确保模型已注册
        await conn.run_sync(Base.metadata.create_all)
