"""
Streaming chat routes.
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Message, Session
from schemas import ChatRequest
from services.ai_service import (
    build_messages_context,
    get_active_model_config,
    stream_chat_completion,
)

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.post("/stream")
async def chat_stream(body: ChatRequest, db: AsyncSession = Depends(get_db)):
    """Stream a model response and persist both sides of the conversation."""
    result = await db.execute(select(Session).where(Session.id == body.session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    model_config = await get_active_model_config(db, body.model_config_id)
    if not model_config:
        raise HTTPException(status_code=400, detail="No active model configured")

    # Build the prompt context before inserting the latest user message so it
    # only appears once in the model input.
    messages_context = await build_messages_context(
        db=db,
        session_id=body.session_id,
        user_message=body.message,
        attachments=body.attachments,
    )

    user_msg = Message(
        session_id=body.session_id,
        role="user",
        content=body.message,
    )
    db.add(user_msg)
    await db.flush()
    session.updated_at = user_msg.created_at
    await db.commit()

    async def sse_generator():
        full_response = ""

        async for chunk_json in stream_chat_completion(model_config, messages_context):
            chunk_data = json.loads(chunk_json)
            if chunk_data.get("content"):
                full_response += chunk_data["content"]

            yield f"data: {chunk_json}\n\n"

            if chunk_data.get("done") and full_response.strip():
                from database import AsyncSessionLocal

                async with AsyncSessionLocal() as save_db:
                    ai_msg = Message(
                        session_id=body.session_id,
                        role="assistant",
                        content=full_response,
                        model_name=model_config.name,
                    )
                    save_db.add(ai_msg)
                    await save_db.commit()

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
