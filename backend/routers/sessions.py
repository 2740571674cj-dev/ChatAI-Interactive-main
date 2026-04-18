"""
会话管理路由
提供会话的创建、列表查询、搜索、更新标题和删除功能。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import get_db
from models import Session, Message
from schemas import SessionCreate, SessionUpdate, SessionOut, SessionDetail, MessageOut

router = APIRouter(prefix="/api/sessions", tags=["会话管理"])


@router.post("", response_model=SessionOut, status_code=201)
async def create_session(body: SessionCreate, db: AsyncSession = Depends(get_db)):
    """创建新会话"""
    session = Session(title=body.title)
    db.add(session)
    await db.flush()
    await db.refresh(session)
    return session


@router.get("", response_model=list[SessionOut])
async def list_sessions(
    q: str | None = Query(None, description="搜索关键词"),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """获取会话列表，支持关键词搜索，按更新时间倒序"""
    stmt = select(Session).order_by(Session.updated_at.desc()).limit(limit)
    
    if q:
        # 模糊搜索标题
        stmt = stmt.where(Session.title.ilike(f"%{q}%"))
    
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/{session_id}", response_model=SessionDetail)
async def get_session(session_id: str, db: AsyncSession = Depends(get_db)):
    """获取会话详情，包含所有消息"""
    stmt = (
        select(Session)
        .options(selectinload(Session.messages))
        .where(Session.id == session_id)
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    
    return session


@router.patch("/{session_id}", response_model=SessionOut)
async def update_session(session_id: str, body: SessionUpdate, db: AsyncSession = Depends(get_db)):
    """更新会话标题"""
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    
    session.title = body.title
    await db.flush()
    await db.refresh(session)
    return session


@router.delete("/{session_id}", status_code=204)
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)):
    """删除整个会话（级联删除所有消息）"""
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    
    await db.delete(session)
