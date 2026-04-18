"""
AI 对话服务
核心模块：实现流式对话的提示词拼接、上下文管理和 OpenAI SDK 调用。
"""
import json
from typing import AsyncGenerator

from openai import AsyncOpenAI, DefaultAsyncHttpxClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import ModelConfig, Prompt, Message, Session
from services.crypto_service import decrypt_api_key
from services.base_url_service import ensure_openai_api_base_url, should_bypass_env_proxy
from config import settings


async def get_active_model_config(db: AsyncSession, model_config_id: str | None = None) -> ModelConfig | None:
    """
    获取当前要使用的模型配置。
    如果指定了 model_config_id 则用指定的，否则取 is_active=True 的。
    """
    if model_config_id:
        stmt = select(ModelConfig).where(ModelConfig.id == model_config_id)
    else:
        stmt = select(ModelConfig).where(ModelConfig.is_active == True)
    
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def build_messages_context(
    db: AsyncSession,
    session_id: str,
    user_message: str,
    attachments: list[dict] | None = None,
) -> list[dict]:
    """
    构建完整的消息上下文，按以下顺序拼接：
    1. 全局提示词（enabled=True 的所有全局提示词拼接为一个 system message）
    2. 特定提示词（enabled=True 且关联当前 session 或无关联的 specific 类型）
    3. 历史消息上下文（从 Message 表取最近 N 条）
    4. 当前用户输入（可能包含附件内容）
    """
    messages = []
    
    # --- 第一层：全局提示词 ---
    stmt = select(Prompt).where(
        Prompt.type == "global",
        Prompt.enabled == True,
    )
    result = await db.execute(stmt)
    global_prompts = result.scalars().all()
    
    if global_prompts:
        global_text = "\n\n".join(p.text for p in global_prompts if p.text.strip())
        if global_text.strip():
            messages.append({"role": "system", "content": global_text})
    
    # --- 第二层：特定提示词（当前会话的）---
    stmt = select(Prompt).where(
        Prompt.type == "specific",
        Prompt.enabled == True,
    )
    # 特定提示词：可以关联某个 session，也可以是通用的
    result = await db.execute(stmt)
    specific_prompts = result.scalars().all()
    
    # 过滤：只取 session_id 匹配的或 session_id 为空的
    relevant_specific = [
        p for p in specific_prompts
        if p.session_id is None or p.session_id == session_id
    ]
    
    if relevant_specific:
        specific_text = "\n\n".join(p.text for p in relevant_specific if p.text.strip())
        if specific_text.strip():
            messages.append({"role": "system", "content": specific_text})
    
    # --- 第三层：历史消息 ---
    stmt = (
        select(Message)
        .where(Message.session_id == session_id)
        .order_by(Message.created_at.desc())
        .limit(settings.MAX_CONTEXT_MESSAGES)
    )
    result = await db.execute(stmt)
    history = list(reversed(result.scalars().all()))  # 按时间正序
    
    for msg in history:
        messages.append({"role": msg.role, "content": msg.content})
    
    # --- 第四层：当前用户输入 ---
    # 处理多模态附件
    if attachments:
        # 构建多模态消息内容
        content_parts = []
        
        for att in attachments:
            att_type = att.get("type") or att.get("file_type")
            if att_type == "image" and att.get("data", att.get("content")):
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": att.get("data", att.get("content"))}
                })
            elif att_type in {"file", "document"} and att.get("content"):
                # 文件内容作为文本前缀
                content_parts.append({
                    "type": "text",
                    "text": f"[附件内容 - {att.get('filename', '文件')}]:\n{att['content']}"
                })
        
        content_parts.append({"type": "text", "text": user_message})
        messages.append({"role": "user", "content": content_parts})
    else:
        messages.append({"role": "user", "content": user_message})
    
    return messages


async def stream_chat_completion(
    model_config: ModelConfig,
    messages: list[dict],
) -> AsyncGenerator[str, None]:
    """
    调用 OpenAI 兼容 API 的流式对话接口。
    使用 AsyncOpenAI SDK，支持任何 OpenAI 兼容的 API 端点。
    每次 yield 一个 JSON 字符串，格式: {"content": "增量文字", "done": false}
    """
    # 解密 API Key
    api_key = decrypt_api_key(model_config.api_key_encrypted)
    if not api_key:
        yield json.dumps({"content": "", "done": True, "error": "API Key 无效或已损坏"}, ensure_ascii=False)
        return
    
    # 统一规范化 Base URL，避免 /V1 等大小写路径被重复拼接
    base_url = ensure_openai_api_base_url(model_config.base_url)
    
    # 本地代理地址需要禁用 trust_env，避免请求误走系统代理
    bypass_env_proxy = should_bypass_env_proxy(base_url)

    # 创建异步 OpenAI 客户端
    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=60.0,
        http_client=DefaultAsyncHttpxClient(
            timeout=60.0,
            trust_env=not bypass_env_proxy,
        ),
    )
    
    full_content = ""
    
    try:
        # 发起流式请求
        stream = await client.chat.completions.create(
            model=model_config.model_id,
            messages=messages,
            stream=True,
            temperature=0.7,
            max_tokens=4096,
        )
        
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                delta = chunk.choices[0].delta.content
                full_content += delta
                yield json.dumps({"content": delta, "done": False}, ensure_ascii=False)
        
        # 流结束
        yield json.dumps({"content": "", "done": True}, ensure_ascii=False)
    
    except Exception as e:
        error_msg = str(e)
        # 分类常见错误，给用户可操作的提示
        if "401" in error_msg or "Unauthorized" in error_msg:
            error_msg = "API Key 验证失败。请检查您的 API Key 是否正确。"
        elif "429" in error_msg:
            error_msg = "请求频率过高或额度不足。请稍后重试。"
        elif "404" in error_msg or "Not Found" in error_msg:
            error_msg = f"模型 '{model_config.model_id}' 不存在或 API 路径错误。请检查模型名称和 Base URL。"
        elif "502" in error_msg or "Bad Gateway" in error_msg:
            error_msg = f"API 服务返回 502 (Bad Gateway)。请确认 Base URL ({model_config.base_url}) 对应的服务正在运行。"
        elif "503" in error_msg or "Service Unavailable" in error_msg:
            error_msg = "API 服务暂时不可用 (503)。请稍后重试。"
        elif "timeout" in error_msg.lower():
            error_msg = f"请求超时。请检查 Base URL ({model_config.base_url}) 是否可达。"
        elif "connection" in error_msg.lower() or "connect" in error_msg.lower():
            error_msg = f"无法连接到 API 服务 ({model_config.base_url})。请确认该服务正在运行且地址正确。"
        else:
            # 未知错误也附带 base_url 信息，方便排查
            error_msg = f"API 调用失败: {error_msg[:200]}"
        
        yield json.dumps({"content": "", "done": True, "error": error_msg}, ensure_ascii=False)
    
    finally:
        await client.close()
