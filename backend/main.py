"""
ChatAI Interactive 后端服务入口
FastAPI 应用初始化、CORS 配置和路由注册。
"""
import logging
from pathlib import Path
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse

from config import settings
from database import init_db

# 前端文件根目录（backend 的上级目录）
FRONTEND_DIR = Path(__file__).resolve().parent.parent

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ============================================================
# 应用生命周期管理
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动时初始化数据库，关闭时清理资源"""
    logger.info("🚀 正在初始化数据库...")
    await init_db()
    logger.info("✅ 数据库初始化完成")
    logger.info(f"📂 上传目录: {settings.UPLOAD_DIR}")
    logger.info(f"📂 向量库目录: {settings.CHROMA_PERSIST_DIR}")
    yield
    logger.info("👋 服务已关闭")


# ============================================================
# 创建 FastAPI 应用
# ============================================================
app = FastAPI(
    title="ChatAI Interactive API",
    description="ChatAI Interactive 前端的后端服务，提供流式对话、模型管理、提示词系统等完整功能。",
    version="1.0.0",
    lifespan=lifespan,
)

# ============================================================
# CORS 中间件 - 允许前端跨域访问
# ============================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ============================================================
# 注册路由
# ============================================================
from routers import sessions, messages, chat, model_configs, prompts, upload, github

app.include_router(sessions.router)
app.include_router(messages.router)
app.include_router(chat.router)
app.include_router(model_configs.router)
app.include_router(prompts.router)
app.include_router(upload.router)
app.include_router(github.router)

# ============================================================
# 静态文件服务（上传文件目录）
# ============================================================
app.mount("/uploads", StaticFiles(directory=str(settings.UPLOAD_DIR)), name="uploads")

# 前端静态资源目录（CSS/JS 等）
_frontend_assets = FRONTEND_DIR / "ChatAI Interactive UI_files"
if _frontend_assets.exists():
    app.mount("/static", StaticFiles(directory=str(_frontend_assets)), name="frontend_static")


# ============================================================
# 前端页面服务 - 通过 HTTP 提供 HTML，避免 file:// 协议限制
# ============================================================
@app.get("/app", response_class=HTMLResponse, tags=["前端"])
async def serve_frontend():
    """返回前端 HTML 页面"""
    html_file = FRONTEND_DIR / "ChatAI Interactive UI.html"
    if html_file.exists():
        content = html_file.read_text(encoding="utf-8")
        # 修正资源引用路径：将相对路径 ./ChatAI Interactive UI_files/ 改为 /static/
        content = content.replace(
            './ChatAI Interactive UI_files/',
            '/static/'
        )
        return HTMLResponse(content=content)
    return HTMLResponse(content="<h1>前端文件未找到</h1>", status_code=404)


# ============================================================
# 健康检查
# ============================================================
@app.get("/", tags=["系统"])
async def root():
    """API 健康检查"""
    return {
        "service": "ChatAI Interactive API",
        "version": "1.0.0",
        "status": "running",
        "docs": "/docs",
    }


@app.get("/health", tags=["系统"])
async def health_check():
    """健康检查端点"""
    return {"status": "ok"}


# ============================================================
# 启动入口
# ============================================================
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.PORT,
        reload=True,  # 开发模式：代码修改后自动重载
        log_level="info",
    )
