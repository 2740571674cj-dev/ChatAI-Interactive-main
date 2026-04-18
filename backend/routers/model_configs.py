"""
模型配置管理路由
提供模型配置的 CRUD、激活切换、curl/Python 代码解析和连接测试功能。
"""
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from database import get_db
from models import ModelConfig
from services.base_url_service import (
    normalize_openai_base_url,
    build_chat_completions_url,
    should_bypass_env_proxy,
)
from schemas import (
    ModelConfigCreate, ModelConfigUpdate, ModelConfigOut,
    ParseConfigRequest, ParseConfigResponse,
    TestConnectionRequest, TestConnectionResponse,
)
from services.crypto_service import encrypt_api_key, decrypt_api_key, mask_api_key

router = APIRouter(prefix="/api/models", tags=["模型配置"])


# ============================================================
# 辅助函数：将 ORM 对象转换为响应模型
# ============================================================
def _to_out(m: ModelConfig) -> ModelConfigOut:
    """将 ModelConfig ORM 实例转为 API 响应格式"""
    return ModelConfigOut(
        id=m.id,
        name=m.name,
        base_url=normalize_openai_base_url(m.base_url),
        api_key_masked=mask_api_key(decrypt_api_key(m.api_key_encrypted)),
        model_id=m.model_id,
        is_active=m.is_active,
        created_at=m.created_at,
    )


# ============================================================
# CRUD 端点
# ============================================================
@router.post("", response_model=ModelConfigOut, status_code=201)
async def create_model(body: ModelConfigCreate, db: AsyncSession = Depends(get_db)):
    """添加模型配置"""
    model = ModelConfig(
        name=body.name,
        base_url=normalize_openai_base_url(body.base_url),
        api_key_encrypted=encrypt_api_key(body.api_key),
        model_id=body.model_id,
    )
    
    # 如果是第一个模型，自动设为激活
    stmt = select(ModelConfig)
    result = await db.execute(stmt)
    if not result.scalars().first():
        model.is_active = True
    
    db.add(model)
    await db.flush()
    await db.refresh(model)
    return _to_out(model)


@router.get("", response_model=list[ModelConfigOut])
async def list_models(db: AsyncSession = Depends(get_db)):
    """获取所有模型配置"""
    stmt = select(ModelConfig).order_by(ModelConfig.created_at)
    result = await db.execute(stmt)
    models = result.scalars().all()
    return [_to_out(m) for m in models]


@router.put("/{model_id}", response_model=ModelConfigOut)
async def update_model(model_id: str, body: ModelConfigUpdate, db: AsyncSession = Depends(get_db)):
    """更新模型配置"""
    stmt = select(ModelConfig).where(ModelConfig.id == model_id)
    result = await db.execute(stmt)
    model = result.scalar_one_or_none()
    
    if not model:
        raise HTTPException(status_code=404, detail="模型配置不存在")
    
    model.name = body.name
    model.base_url = normalize_openai_base_url(body.base_url)
    if body.api_key:
        model.api_key_encrypted = encrypt_api_key(body.api_key)
    model.model_id = body.model_id
    await db.flush()
    await db.refresh(model)
    return _to_out(model)


@router.delete("/{model_id}", status_code=204)
async def delete_model(model_id: str, db: AsyncSession = Depends(get_db)):
    """删除模型配置"""
    stmt = select(ModelConfig).where(ModelConfig.id == model_id)
    result = await db.execute(stmt)
    model = result.scalar_one_or_none()
    
    if not model:
        raise HTTPException(status_code=404, detail="模型配置不存在")
    
    was_active = model.is_active
    await db.delete(model)
    await db.flush()
    
    # 如果删除的是当前激活模型，自动激活第一个
    if was_active:
        stmt = select(ModelConfig).order_by(ModelConfig.created_at).limit(1)
        result = await db.execute(stmt)
        first = result.scalar_one_or_none()
        if first:
            first.is_active = True


@router.patch("/{model_id}/activate", response_model=ModelConfigOut)
async def activate_model(model_id: str, db: AsyncSession = Depends(get_db)):
    """设置指定模型为激活状态（同时取消其他模型的激活）"""
    # 先取消所有激活
    stmt = select(ModelConfig).where(ModelConfig.is_active == True)
    result = await db.execute(stmt)
    for m in result.scalars().all():
        m.is_active = False
    
    # 激活目标模型
    stmt = select(ModelConfig).where(ModelConfig.id == model_id)
    result = await db.execute(stmt)
    model = result.scalar_one_or_none()
    
    if not model:
        raise HTTPException(status_code=404, detail="模型配置不存在")
    
    model.is_active = True
    await db.flush()
    await db.refresh(model)
    return _to_out(model)


# ============================================================
# 解析 curl/Python 代码
# ============================================================
@router.post("/parse-config", response_model=ParseConfigResponse)
async def parse_config(body: ParseConfigRequest):
    """
    从用户粘贴的 curl 命令或 Python 代码中自动提取 API 配置。
    支持格式：
    - curl -X POST https://api.xxx.com/v1/chat/completions -H "Authorization: Bearer sk-xxx"
    - openai.OpenAI(api_key="sk-xxx", base_url="https://api.xxx.com/v1")
    """
    code = body.code.strip()
    result = ParseConfigResponse()
    
    # --- 提取 Base URL ---
    # curl 格式: curl ... https://api.xxx.com/v1/chat/completions
    url_match = re.search(r'https?://[^\s\'"\\]+', code)
    if url_match:
        url = url_match.group(0).rstrip("/")
        # 去掉路径部分，保留 base URL
        result.base_url = normalize_openai_base_url(url)
    
    # Python 格式: base_url="https://..."
    base_url_py = re.search(r'base_url\s*=\s*["\']([^"\']+)["\']', code)
    if base_url_py:
        result.base_url = normalize_openai_base_url(base_url_py.group(1))
    
    # --- 提取 API Key ---
    # Authorization: Bearer sk-xxx
    bearer_match = re.search(r'Bearer\s+(sk-[a-zA-Z0-9_-]+)', code)
    if bearer_match:
        result.api_key = bearer_match.group(1)
    
    # api_key="sk-xxx" 或 api_key='sk-xxx'
    key_match = re.search(r'api_key\s*=\s*["\']([^"\']+)["\']', code)
    if key_match:
        result.api_key = key_match.group(1)
    
    # 直接匹配 "sk-" 开头的 Key
    if not result.api_key:
        sk_match = re.search(r'(sk-[a-zA-Z0-9_-]{20,})', code)
        if sk_match:
            result.api_key = sk_match.group(1)
    
    # --- 提取 Model ID ---
    # "model": "gpt-4o"
    model_match = re.search(r'"model"\s*:\s*"([^"]+)"', code)
    if model_match:
        result.model_id = model_match.group(1)
    
    # model="gpt-4o"
    model_py = re.search(r'model\s*=\s*["\']([^"\']+)["\']', code)
    if model_py:
        result.model_id = model_py.group(1)
    
    # --- 生成模型名 ---
    if result.model_id:
        result.name = result.model_id
    elif result.base_url:
        # 从 URL 中提取服务商名
        from urllib.parse import urlparse
        domain = urlparse(result.base_url).hostname or ""
        result.name = domain.split(".")[0].capitalize()
    
    return result


# ============================================================
# 测试连接
# ============================================================
@router.post("/test", response_model=TestConnectionResponse)
async def test_connection(body: TestConnectionRequest):
    """
    测试与 AI API 的连接可用性。
    发送一个最小化请求验证 API Key 和网络连通性。
    """
    start_time = time.time()
    
    try:
        # 构造一个简短的测试请求（避免重复拼接 /v1）
        url = build_chat_completions_url(body.base_url)
        headers = {
            "Authorization": f"Bearer {body.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": body.model_id,
            "messages": [{"role": "user", "content": "Hi"}],
            "max_tokens": 5,
            "stream": False,
        }
        
        async with httpx.AsyncClient(
            timeout=15.0,
            trust_env=not should_bypass_env_proxy(body.base_url),
        ) as client:
            response = await client.post(url, json=payload, headers=headers)
        
        latency = int((time.time() - start_time) * 1000)
        
        if response.status_code == 200:
            return TestConnectionResponse(
                success=True,
                message="连接成功！API 正常响应。",
                latency_ms=latency,
            )
        else:
            error_detail = response.text[:200]
            return TestConnectionResponse(
                success=False,
                message=f"API 返回错误 ({response.status_code}): {error_detail}",
                latency_ms=latency,
            )
    
    except httpx.TimeoutException:
        latency = int((time.time() - start_time) * 1000)
        return TestConnectionResponse(
            success=False,
            message="连接超时：无法在 15 秒内获得响应。请检查 Base URL 是否正确。",
            latency_ms=latency,
        )
    except Exception as e:
        latency = int((time.time() - start_time) * 1000)
        return TestConnectionResponse(
            success=False,
            message=f"连接失败：{str(e)}",
            latency_ms=latency,
        )
