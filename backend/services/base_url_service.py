"""
Base URL 规范化工具。

统一处理 OpenAI 兼容接口的 Base URL，避免大小写路径或完整接口路径
导致重复拼接 `/v1`、`/chat/completions`。
"""

from urllib.parse import urlparse


def normalize_openai_base_url(base_url: str) -> str:
    """将用户输入或数据库中的 Base URL 规范化为稳定格式。"""
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return ""

    lower_base = base.lower()
    chat_suffix = "/chat/completions"
    v1_suffix = "/v1"

    if lower_base.endswith(chat_suffix):
        base = base[: -len(chat_suffix)]
        lower_base = base.lower()

    if lower_base.endswith(v1_suffix):
        base = f"{base[: -len(v1_suffix)]}/v1"

    return base.rstrip("/")


def ensure_openai_api_base_url(base_url: str) -> str:
    """确保 Base URL 可直接传给 OpenAI SDK。"""
    base = normalize_openai_base_url(base_url)
    if base and not base.lower().endswith("/v1"):
        base = f"{base}/v1"
    return base


def build_chat_completions_url(base_url: str) -> str:
    """构造稳定的 chat completions URL。"""
    base = ensure_openai_api_base_url(base_url)
    return f"{base}/chat/completions" if base else ""


def should_bypass_env_proxy(base_url: str) -> bool:
    """
    对本地回环地址禁用 httpx/OpenAI SDK 的 trust_env。

    某些 Windows 环境下，本地 `127.0.0.1` 请求在 trust_env=True 时会误走
    系统代理，导致本地 OpenAI 兼容服务返回异常 502。
    """
    parsed = urlparse((base_url or "").strip())
    hostname = (parsed.hostname or "").lower()
    return hostname in {"127.0.0.1", "localhost", "::1"}
