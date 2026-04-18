const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const { getDataDir } = require('../database');

const router = Router();

const CODE_EXTENSIONS = new Set([
    '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp',
    '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.lua', '.r',
    '.sh', '.bash', '.zsh', '.ps1', '.bat',
    '.html', '.css', '.scss', '.less', '.vue', '.svelte',
    '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.xml',
    '.sql', '.graphql', '.proto',
    '.md', '.txt', '.rst',
]);

const IGNORE_DIRS = new Set([
    'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
    'dist', 'build', '.next', '.nuxt', 'target', 'bin', 'obj',
    '.idea', '.vscode', '.vs', 'vendor', 'packages',
]);

const MAX_FILE_SIZE = 500 * 1024;

function sanitizeRepoName(name) {
    const normalized = (name || 'repo')
        .replace(/\.git$/i, '')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^\.+/, '')
        .replace(/^-+/, '')
        .slice(0, 120);
    return normalized || 'repo';
}

function parseRepoUrl(url) {
    let cleaned = (url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cleaned)) {
        cleaned = `https://${cleaned}`;
    }

    const cloneUrl = cleaned.endsWith('.git') ? cleaned : `${cleaned}.git`;
    const parts = cleaned.replace(/\.git$/i, '').split('/');
    const rawRepoName = parts[parts.length - 1] || 'repo';

    return {
        cloneUrl,
        repoName: sanitizeRepoName(rawRepoName),
    };
}

function collectFiles(dir, baseDir) {
    const files = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            const lowerName = entry.name.toLowerCase();
            if (IGNORE_DIRS.has(lowerName) || entry.name.startsWith('.')) {
                continue;
            }
            files.push(...collectFiles(entryPath, baseDir));
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        const baseName = entry.name.toLowerCase();
        const isSpecial = ['dockerfile', 'makefile', 'cmakelists.txt', 'readme', 'license'].includes(baseName);
        if (!CODE_EXTENSIONS.has(ext) && !isSpecial) {
            continue;
        }

        try {
            const stat = fs.statSync(entryPath);
            if (stat.size > MAX_FILE_SIZE) {
                continue;
            }

            const content = fs.readFileSync(entryPath, 'utf8');
            files.push({
                path: path.relative(baseDir, entryPath).replace(/\\/g, '/'),
                content,
            });
        } catch {
            continue;
        }
    }

    return files;
}

function ensureWithin(parentDir, targetDir) {
    const parent = path.resolve(parentDir);
    const target = path.resolve(targetDir);
    return target === parent || target.startsWith(`${parent}${path.sep}`);
}

router.post('/parse', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.json({
            success: false,
            message: 'URL 不能为空',
            repo_name: '',
            files_parsed: 0,
            chunks_stored: 0,
        });
    }

    try {
        const { cloneUrl, repoName } = parseRepoUrl(url);
        const reposDir = path.join(getDataDir(), 'github_repos');
        fs.mkdirSync(reposDir, { recursive: true });

        const targetDir = path.join(reposDir, repoName);
        if (!ensureWithin(reposDir, targetDir)) {
            throw new Error('目标仓库目录不合法');
        }

        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }

        await simpleGit().clone(cloneUrl, targetDir, ['--depth', '1', '--single-branch']);

        const files = collectFiles(targetDir, targetDir);
        if (files.length === 0) {
            return res.json({
                success: false,
                message: '仓库里没有找到可解析的代码文件。',
                repo_name: repoName,
                files_parsed: 0,
                chunks_stored: 0,
            });
        }

        return res.json({
            success: true,
            message: `已解析仓库 ${repoName}，共找到 ${files.length} 个文件。当前版本仅保留克隆与文件扫描，暂不包含向量检索。`,
            repo_name: repoName,
            files_parsed: files.length,
            chunks_stored: 0,
        });
    } catch (error) {
        return res.json({
            success: false,
            message: `仓库解析失败：${error.message}。请确认 URL 正确且仓库可公开访问。`,
            repo_name: '',
            files_parsed: 0,
            chunks_stored: 0,
        });
    }
});

module.exports = router;
