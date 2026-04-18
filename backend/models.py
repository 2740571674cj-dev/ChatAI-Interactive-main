"""
ORM 模型定义
包含 User, Session, Message, ModelConfig, Prompt 五张核心表。
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Text, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def _uuid() -> str:
    """生成 UUID 字符串作为主键"""
    return str(uuid.uuid4())


def _now() -> datetime:
    """返回当前 UTC 时间"""
    return datetime.now(timezone.utc)


# ============================================================
# 用户表 - 预留扩展，当前单用户模式可不使用
# ============================================================
class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    username: Mapped[str] = mapped_column(String(100), nullable=False, default="default")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    # 关联
    sessions: Mapped[list["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")


# ============================================================
# 会话表
# ============================================================
class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="新对话")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    # 关联
    user: Mapped["User | None"] = relationship(back_populates="sessions")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="Message.created_at"
    )

    # 索引：按更新时间倒序排列（最近对话列表）
    __table_args__ = (
        Index("ix_sessions_updated_at", "updated_at"),
    )


# ============================================================
# 消息表
# ============================================================
class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(String(36), ForeignKey("sessions.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)  # "user" / "assistant" / "system"
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)  # 生成时使用的模型名
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    # 关联
    session: Mapped["Session"] = relationship(back_populates="messages")

    __table_args__ = (
        Index("ix_messages_session_id", "session_id"),
    )


# ============================================================
# 模型配置表
# ============================================================
class ModelConfig(Base):
    __tablename__ = "model_configs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(100), nullable=False)          # 显示名: "ChatGPT 4o"
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)      # API 域名
    api_key_encrypted: Mapped[str] = mapped_column(Text, nullable=False)    # AES 加密后的 API Key
    model_id: Mapped[str] = mapped_column(String(100), nullable=False, default="gpt-4o")  # 实际模型 ID
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


# ============================================================
# 提示词表
# ============================================================
class Prompt(Base):
    __tablename__ = "prompts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(String(20), nullable=False)  # "global" / "specific"
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    session_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sessions.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    __table_args__ = (
        Index("ix_prompts_type", "type"),
    )
