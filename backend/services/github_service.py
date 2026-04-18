"""
GitHub 仓库解析服务
核心流程：Git 浅克隆 → 代码文件遍历 → 文本分块 → Embedding 向量化 → ChromaDB 存储
提供基于向量检索的 RAG（检索增强生成）上下文注入能力。
"""
import os
import shutil
import logging
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

# 支持解析的代码文件扩展名
CODE_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".c", ".cpp", ".h", ".hpp",
    ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".scala", ".lua", ".r",
    ".sh", ".bash", ".zsh", ".ps1", ".bat",
    ".html", ".css", ".scss", ".less", ".vue", ".svelte",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".xml",
    ".sql", ".graphql", ".proto",
    ".md", ".txt", ".rst",
    ".dockerfile", ".makefile", ".cmake",
}

# 忽略的目录
IGNORE_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
    "dist", "build", ".next", ".nuxt", "target", "bin", "obj",
    ".idea", ".vscode", ".vs", "vendor", "packages",
}

# 单文件最大字节数（超过则跳过）
MAX_FILE_SIZE = 500 * 1024  # 500KB

# 文本分块大小（字符数）
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200


def _parse_repo_url(url: str) -> tuple[str, str]:
    """
    从 GitHub URL 中提取仓库 clone 地址和仓库名。
    支持格式：
    - https://github.com/user/repo
    - https://github.com/user/repo.git
    - github.com/user/repo
    """
    url = url.strip().rstrip("/")
    
    # 补充协议头
    if not url.startswith("http"):
        url = "https://" + url
    
    # 确保 .git 后缀
    if not url.endswith(".git"):
        clone_url = url + ".git"
    else:
        clone_url = url
    
    # 提取仓库名
    parts = url.rstrip(".git").split("/")
    repo_name = parts[-1] if parts else "unknown"
    
    return clone_url, repo_name


def _clone_repo(clone_url: str, repo_name: str) -> Path:
    """
    使用 git 浅克隆仓库到临时目录。
    使用 --depth 1 只获取最新提交，节省带宽和空间。
    """
    import git
    
    target_dir = settings.GITHUB_CLONE_DIR / repo_name
    
    # 如果已存在，先删除
    if target_dir.exists():
        shutil.rmtree(target_dir, ignore_errors=True)
    
    logger.info(f"正在克隆仓库: {clone_url} → {target_dir}")
    
    git.Repo.clone_from(
        clone_url,
        str(target_dir),
        depth=1,
        single_branch=True,
    )
    
    return target_dir


def _collect_files(repo_dir: Path) -> list[dict]:
    """
    遍历仓库目录，收集所有可解析的代码文件。
    返回 [{"path": "相对路径", "content": "文件内容"}, ...]
    """
    files = []
    
    for root, dirs, filenames in os.walk(repo_dir):
        # 过滤忽略目录
        dirs[:] = [d for d in dirs if d.lower() not in IGNORE_DIRS and not d.startswith(".")]
        
        for filename in filenames:
            filepath = Path(root) / filename
            ext = filepath.suffix.lower()
            
            # 无扩展名的特殊文件（Dockerfile, Makefile 等）
            basename_lower = filename.lower()
            is_special = basename_lower in {"dockerfile", "makefile", "cmakelists.txt", "readme", "license"}
            
            if ext not in CODE_EXTENSIONS and not is_special:
                continue
            
            # 检查文件大小
            try:
                if filepath.stat().st_size > MAX_FILE_SIZE:
                    continue
            except OSError:
                continue
            
            # 读取文件内容
            try:
                content = filepath.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            
            rel_path = str(filepath.relative_to(repo_dir))
            files.append({"path": rel_path, "content": content})
    
    return files


def _split_into_chunks(files: list[dict]) -> list[dict]:
    """
    将文件内容分割为固定大小的文本块，便于向量化。
    每个块包含文件路径信息作为元数据。
    """
    chunks = []
    
    for file_info in files:
        content = file_info["content"]
        path = file_info["path"]
        
        # 添加文件路径作为上下文前缀
        prefix = f"# File: {path}\n\n"
        
        if len(content) <= CHUNK_SIZE:
            chunks.append({
                "text": prefix + content,
                "metadata": {"file_path": path, "chunk_index": 0}
            })
        else:
            # 滑动窗口分块
            start = 0
            chunk_idx = 0
            while start < len(content):
                end = start + CHUNK_SIZE
                chunk_text = content[start:end]
                chunks.append({
                    "text": prefix + chunk_text,
                    "metadata": {"file_path": path, "chunk_index": chunk_idx}
                })
                start += CHUNK_SIZE - CHUNK_OVERLAP
                chunk_idx += 1
    
    return chunks


async def store_chunks_to_vector_db(chunks: list[dict], collection_name: str) -> int:
    """
    将文本块存入 ChromaDB 向量数据库。
    使用 ChromaDB 内置的 embedding 函数（默认 sentence-transformers）。
    
    Returns:
        成功存储的 chunk 数量
    """
    try:
        import chromadb
        
        client = chromadb.PersistentClient(path=str(settings.CHROMA_PERSIST_DIR))
        
        # 删除同名旧集合（重新导入时覆盖）
        try:
            client.delete_collection(collection_name)
        except Exception:
            pass
        
        collection = client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"}
        )
        
        # 批量添加
        batch_size = 100
        total_stored = 0
        
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            
            collection.add(
                ids=[f"{collection_name}-{i + j}" for j, _ in enumerate(batch)],
                documents=[c["text"] for c in batch],
                metadatas=[c["metadata"] for c in batch],
            )
            total_stored += len(batch)
        
        logger.info(f"已将 {total_stored} 个文本块存入向量数据库集合 '{collection_name}'")
        return total_stored
    
    except ImportError:
        logger.warning("ChromaDB 未安装，跳过向量存储。仍可使用基础解析功能。")
        return 0
    except Exception as e:
        logger.error(f"向量存储失败: {e}")
        return 0


async def search_relevant_context(collection_name: str, query: str, top_k: int = 5) -> list[str]:
    """
    从向量数据库中检索与查询最相关的代码片段。
    用于 RAG 上下文注入。
    
    Args:
        collection_name: 仓库对应的集合名
        query: 用户查询文本
        top_k: 返回的最相关片段数
    
    Returns:
        相关代码片段列表
    """
    try:
        import chromadb
        
        client = chromadb.PersistentClient(path=str(settings.CHROMA_PERSIST_DIR))
        
        try:
            collection = client.get_collection(collection_name)
        except Exception:
            return []
        
        results = collection.query(
            query_texts=[query],
            n_results=top_k,
        )
        
        if results and results.get("documents"):
            return results["documents"][0]  # 返回第一个查询的结果文档列表
        
        return []
    
    except Exception as e:
        logger.error(f"向量检索失败: {e}")
        return []


async def parse_github_repo(url: str) -> dict:
    """
    完整的 GitHub 仓库解析流程。
    
    Returns:
        {"success": bool, "message": str, "repo_name": str, "files_parsed": int, "chunks_stored": int}
    """
    try:
        # 1. 解析 URL
        clone_url, repo_name = _parse_repo_url(url)
        
        # 2. 克隆仓库
        try:
            repo_dir = _clone_repo(clone_url, repo_name)
        except Exception as e:
            return {
                "success": False,
                "message": f"仓库克隆失败：{str(e)}。请检查 URL 是否正确，以及仓库是否为公开仓库。",
                "repo_name": repo_name,
                "files_parsed": 0,
                "chunks_stored": 0,
            }
        
        # 3. 收集代码文件
        files = _collect_files(repo_dir)
        if not files:
            return {
                "success": False,
                "message": "未在仓库中找到可解析的代码文件。",
                "repo_name": repo_name,
                "files_parsed": 0,
                "chunks_stored": 0,
            }
        
        # 4. 文本分块
        chunks = _split_into_chunks(files)
        
        # 5. 向量化存储
        collection_name = f"github-{repo_name}"
        chunks_stored = await store_chunks_to_vector_db(chunks, collection_name)
        
        # 6. 清理克隆目录（可选保留）
        # shutil.rmtree(repo_dir, ignore_errors=True)
        
        return {
            "success": True,
            "message": f"成功解析仓库 '{repo_name}'：共 {len(files)} 个文件，{chunks_stored} 个文本块已索引。",
            "repo_name": repo_name,
            "files_parsed": len(files),
            "chunks_stored": chunks_stored,
        }
    
    except Exception as e:
        logger.error(f"GitHub 仓库解析失败: {e}", exc_info=True)
        return {
            "success": False,
            "message": f"解析过程中发生错误：{str(e)}",
            "repo_name": "",
            "files_parsed": 0,
            "chunks_stored": 0,
        }
