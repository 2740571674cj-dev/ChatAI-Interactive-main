"""
提示词管理路由
提供全局提示词和特定提示词的 CRUD、启用/禁用切换功能。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Prompt
from schemas import PromptCreate, PromptUpdate, PromptToggle, PromptOut

router = APIRouter(prefix="/api/prompts", tags=["提示词管理"])


@router.post("", response_model=PromptOut, status_code=201)
async def create_prompt(body: PromptCreate, db: AsyncSession = Depends(get_db)):
    """添加提示词"""
    prompt = Prompt(
        type=body.type,
        text=body.text,
        enabled=body.enabled,
        session_id=body.session_id,
    )
    db.add(prompt)
    await db.flush()
    await db.refresh(prompt)
    return prompt


@router.get("", response_model=list[PromptOut])
async def list_prompts(
    type: str | None = Query(None, pattern="^(global|specific)$", description="按类型过滤"),
    session_id: str | None = Query(None, description="按会话 ID 过滤特定提示词"),
    db: AsyncSession = Depends(get_db),
):
    """获取提示词列表，支持按类型和会话 ID 过滤"""
    stmt = select(Prompt).order_by(Prompt.created_at)
    
    if type:
        stmt = stmt.where(Prompt.type == type)
    if session_id:
        stmt = stmt.where(Prompt.session_id == session_id)
    
    result = await db.execute(stmt)
    return result.scalars().all()


@router.put("/{prompt_id}", response_model=PromptOut)
async def update_prompt(prompt_id: str, body: PromptUpdate, db: AsyncSession = Depends(get_db)):
    """更新提示词内容"""
    stmt = select(Prompt).where(Prompt.id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()
    
    if not prompt:
        raise HTTPException(status_code=404, detail="提示词不存在")
    
    prompt.text = body.text
    await db.flush()
    await db.refresh(prompt)
    return prompt


@router.patch("/{prompt_id}/toggle", response_model=PromptOut)
async def toggle_prompt(prompt_id: str, body: PromptToggle, db: AsyncSession = Depends(get_db)):
    """切换提示词启用/禁用状态"""
    stmt = select(Prompt).where(Prompt.id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()
    
    if not prompt:
        raise HTTPException(status_code=404, detail="提示词不存在")
    
    prompt.enabled = body.enabled
    await db.flush()
    await db.refresh(prompt)
    return prompt


@router.delete("/{prompt_id}", status_code=204)
async def delete_prompt(prompt_id: str, db: AsyncSession = Depends(get_db)):
    """删除提示词"""
    stmt = select(Prompt).where(Prompt.id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()
    
    if not prompt:
        raise HTTPException(status_code=404, detail="提示词不存在")
    
    await db.delete(prompt)
