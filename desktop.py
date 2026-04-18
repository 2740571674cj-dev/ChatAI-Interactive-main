"""
ChatAI Interactive 桌面应用入口
使用 PyWebView 创建原生窗口，在后台线程中运行 FastAPI 服务。

架构：
  - 主线程: PyWebView 原生窗口（使用系统 Edge WebView2）
  - 后台守护线程: FastAPI/Uvicorn HTTP 服务
  - 启动流程: 启动后端 → 等待端口就绪 → 打开窗口
"""
import os
import sys
import time
import socket
import threading
import logging

# 确保从 backend 目录加载模块
BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend")
sys.path.insert(0, BACKEND_DIR)
os.chdir(BACKEND_DIR)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("desktop")

# 服务端口
PORT = 8000
HOST = "127.0.0.1"


def _find_free_port(start: int = 8000, end: int = 8100) -> int:
    """寻找一个可用端口，避免端口冲突"""
    for port in range(start, end):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    return start  # 回退到默认端口


def _wait_for_server(port: int, timeout: float = 15.0) -> bool:
    """阻塞等待服务端口就绪"""
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.create_connection((HOST, port), timeout=1.0):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.2)
    return False


def _run_backend(port: int):
    """在后台线程中启动 FastAPI/Uvicorn 服务"""
    import uvicorn
    from main import app

    uvicorn.run(
        app,
        host=HOST,
        port=port,
        log_level="warning",
        # 桌面模式下不需要热重载
        reload=False,
    )


def _get_frontend_path() -> str:
    """获取前端 HTML 文件的绝对路径"""
    # 打包后 (PyInstaller) 的路径
    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    
    candidates = [
        os.path.join(base, "ChatAI Interactive UI.html"),
        os.path.join(base, "frontend", "index.html"),
    ]
    
    for path in candidates:
        if os.path.exists(path):
            return path
    
    # 找不到前端文件，返回后端首页 URL
    return ""


def main():
    """桌面应用主入口"""
    import webview

    # 1. 找到可用端口
    port = _find_free_port(PORT)
    logger.info(f"📡 后端服务将使用端口: {port}")

    # 2. 在后台守护线程中启动 FastAPI
    server_thread = threading.Thread(target=_run_backend, args=(port,), daemon=True)
    server_thread.start()
    logger.info("🚀 后端服务正在启动...")

    # 3. 等待服务就绪
    if not _wait_for_server(port):
        logger.error("❌ 后端服务启动超时！")
        return

    logger.info("✅ 后端服务已就绪")

    # 4. 通过 HTTP 加载前端页面（避免 file:// 协议的 WebView2 安全限制）
    url = f"http://{HOST}:{port}/app"
    logger.info(f"🌐 加载前端: {url}")

    # 5. 创建原生窗口
    window = webview.create_window(
        title="ChatAI Interactive",
        url=url,
        width=1280,
        height=800,
        min_size=(900, 600),
        resizable=True,
        confirm_close=False,
        # 注入后端 API 地址，供前端 JS 使用
        js_api=None,
    )

    # 窗口打开后注入后端地址
    def on_loaded():
        """页面加载完成后，注入后端 API 基础地址"""
        try:
            window.evaluate_js(f"""
                window.__CHATAI_API_BASE__ = 'http://{HOST}:{port}';
                console.log('[ChatAI Desktop] API 地址已注入:', window.__CHATAI_API_BASE__);
            """)
        except Exception:
            pass

    window.events.loaded += on_loaded

    # 6. 启动 GUI 事件循环（阻塞，直到窗口关闭）
    webview.start(
        debug=not getattr(sys, "frozen", False),  # 开发模式下启用 DevTools
        # Windows 上优先使用 Edge WebView2
    )

    logger.info("👋 应用已退出")


if __name__ == "__main__":
    main()
