"""
消息管理路由
提供单条消息的删除功能。
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Message

router = APIRouter(prefix="/api/messages", tags=["消息管理"])


@router.delete("/{message_id}", status_code=204)
async def delete_message(message_id: str, db: AsyncSession = Depends(get_db)):
    """删除单条消息"""
    stmt = select(Message).where(Message.id == message_id)
    result = await db.execute(stmt)
    message = result.scalar_one_or_none()
    
    if not message:
        raise HTTPException(status_code=404, detail="消息不存在")
    
    await db.delete(message)
