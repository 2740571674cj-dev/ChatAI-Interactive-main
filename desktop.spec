# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置文件
将 ChatAI Interactive 打包为单个 Windows 可执行文件。

使用方法:
  pip install pyinstaller
  pyinstaller desktop.spec
"""
import os
import sys
import importlib.util

# ============================================================
# 路径配置
# ============================================================
ROOT_DIR = os.path.dirname(os.path.abspath(SPEC))
BACKEND_DIR = os.path.join(ROOT_DIR, 'backend')

# ============================================================
# 自动定位 webview 包路径（运行时需要其静态资源）
# ============================================================
webview_datas = []
spec = importlib.util.find_spec('webview')
if spec and spec.submodule_search_locations:
    webview_path = spec.submodule_search_locations[0]
    webview_datas.append((webview_path, 'webview'))

# ============================================================
# 打包分析
# ============================================================
a = Analysis(
    ['desktop.py'],
    pathex=[ROOT_DIR, BACKEND_DIR],
    binaries=[],
    datas=[
        # 前端 HTML 文件
        (os.path.join(ROOT_DIR, 'ChatAI Interactive UI.html'), '.'),
        # 前端静态资源目录
        (os.path.join(ROOT_DIR, 'ChatAI Interactive UI_files'), 'ChatAI Interactive UI_files'),
        # 后端代码（作为数据打入）
        (BACKEND_DIR, 'backend'),
    ] + webview_datas,
    hiddenimports=[
        # FastAPI 及其依赖
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'fastapi',
        'starlette',
        'pydantic',
        'sqlalchemy',
        'sqlalchemy.ext.asyncio',
        'aiosqlite',
        # OpenAI
        'openai',
        'httpx',
        'httpx._transports',
        # WebView
        'webview',
        'webview.platforms.edgechromium',
        # Crypto
        'cryptography',
        'cryptography.fernet',
        # 其他
        'multipart',
        'python_multipart',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'numpy',
        'pandas',
        'scipy',
        'PIL',
    ],
    noarchive=False,
)

# ============================================================
# 打包设置
# ============================================================
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ChatAI Interactive',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # 无控制台窗口
    icon=None,      # 可替换为 .ico 图标文件路径
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ChatAI Interactive',
)
