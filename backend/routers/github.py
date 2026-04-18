"""
GitHub 仓库解析路由
提供 GitHub 仓库的克隆、代码解析和向量化存储接口。
"""
from fastapi import APIRouter

from schemas import GitHubParseRequest, GitHubParseResponse
from services.github_service import parse_github_repo

router = APIRouter(prefix="/api/github", tags=["GitHub 解析"])


@router.post("/parse", response_model=GitHubParseResponse)
async def parse_repo(body: GitHubParseRequest):
    """
    解析 GitHub 仓库。
    
    流程：
    1. 浅克隆仓库 (git clone --depth 1)
    2. 遍历代码文件，过滤二进制和超大文件
    3. 将代码内容分块（滑动窗口，1500字符/块）
    4. 存入 ChromaDB 向量数据库
    5. 返回解析统计信息
    
    后续对话中可通过 RAG 检索相关代码片段注入上下文。
    """
    result = await parse_github_repo(body.url)
    return GitHubParseResponse(**result)
