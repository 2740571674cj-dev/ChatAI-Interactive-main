"""
Pydantic Schema 定义
用于 API 的请求/响应数据验证与序列化。
"""
from datetime import datetime
from pydantic import BaseModel, Field


# ============================================================
# 会话 (Session)
# ============================================================
class SessionCreate(BaseModel):
    """创建会话请求"""
    title: str = Field(default="新对话", max_length=200)


class SessionUpdate(BaseModel):
    """更新会话标题"""
    title: str = Field(max_length=200)


class SessionOut(BaseModel):
    """会话响应"""
    id: str
    title: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SessionDetail(SessionOut):
    """会话详情（含消息列表）"""
    messages: list["MessageOut"] = []


# ============================================================
# 消息 (Message)
# ============================================================
class MessageOut(BaseModel):
    """消息响应"""
    id: str
    session_id: str
    role: str
    content: str
    model_name: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True, "protected_namespaces": ()}


# ============================================================
# 流式对话 (Chat)
# ============================================================
class ChatRequest(BaseModel):
    """流式对话请求"""
    session_id: str
    message: str
    model_config_id: str | None = None  # 不传则用当前激活模型
    attachments: list[dict] | None = None  # [{"type": "image", "data": "base64..."}, ...]

    model_config = {"protected_namespaces": ()}


class ChatChunk(BaseModel):
    """SSE 流式输出的每个 chunk"""
    content: str = ""
    done: bool = False
    error: str | None = None


# ============================================================
# 模型配置 (ModelConfig)
# ============================================================
class ModelConfigCreate(BaseModel):
    """创建/更新模型配置"""
    name: str = Field(max_length=100)
    base_url: str = Field(max_length=500)
    api_key: str  # 明文传入，服务端加密存储
    model_id: str = Field(default="gpt-4o", max_length=100)

    model_config = {"protected_namespaces": ()}


class ModelConfigUpdate(ModelConfigCreate):
    """更新模型配置（同创建）"""
    pass


class ModelConfigOut(BaseModel):
    """模型配置响应（不返回明文 Key）"""
    id: str
    name: str
    base_url: str
    api_key_masked: str = ""  # 掩码后的 Key: "sk-****xxxx"
    model_id: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True, "protected_namespaces": ()}


class ParseConfigRequest(BaseModel):
    """解析 curl/Python 代码请求"""
    code: str


class ParseConfigResponse(BaseModel):
    """解析结果"""
    name: str = ""
    base_url: str = ""
    api_key: str = ""
    model_id: str = ""

    model_config = {"protected_namespaces": ()}


class TestConnectionRequest(BaseModel):
    """测试连接请求"""
    base_url: str
    api_key: str
    model_id: str = "gpt-4o"

    model_config = {"protected_namespaces": ()}


class TestConnectionResponse(BaseModel):
    """测试连接结果"""
    success: bool
    message: str
    latency_ms: int = 0


# ============================================================
# 提示词 (Prompt)
# ============================================================
class PromptCreate(BaseModel):
    """创建提示词"""
    type: str = Field(pattern="^(global|specific)$")
    text: str = ""
    enabled: bool = True
    session_id: str | None = None


class PromptUpdate(BaseModel):
    """更新提示词内容"""
    text: str


class PromptToggle(BaseModel):
    """切换提示词启用状态"""
    enabled: bool


class PromptOut(BaseModel):
    """提示词响应"""
    id: str
    type: str
    text: str
    enabled: bool
    session_id: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ============================================================
# 文件上传 (Upload)
# ============================================================
class UploadResponse(BaseModel):
    """上传文件响应"""
    filename: str
    file_type: str  # "image" / "document"
    content: str  # 图片为 base64 data URL，文档为提取的文本
    size_bytes: int


# ============================================================
# GitHub 解析 (GitHub)
# ============================================================
class GitHubParseRequest(BaseModel):
    """GitHub 仓库解析请求"""
    url: str


class GitHubParseResponse(BaseModel):
    """GitHub 仓库解析响应"""
    success: bool
    message: str
    repo_name: str = ""
    files_parsed: int = 0
    chunks_stored: int = 0
