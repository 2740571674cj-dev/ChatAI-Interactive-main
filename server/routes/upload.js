/**
 * 文件上传路由
 * 支持图片和文档文件的上传与解析。
 * 
 * 替代 Python 版 routers/upload.py
 */
const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDataDir } = require('../database');

const router = Router();

function buildStoredFilename(originalname = 'file') {
    const ext = path.extname(originalname);
    const base = path.basename(originalname, ext).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') || 'file';
    return `${Date.now()}-${base}${ext}`;
}

// multer 临时存储配置
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// 允许的文件类型
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);
const DOCUMENT_EXTENSIONS = new Set([
    '.txt', '.md', '.py', '.js', '.ts', '.java', '.c', '.cpp', '.h',
    '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.xml',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.csv', '.log', '.sh',
    '.bat', '.ps1', '.sql', '.r', '.swift', '.kt', '.scala', '.lua',
]);
const BINARY_EXTENSIONS = new Set([
    '.pdf', '.docx', '.xlsx', '.pptx', '.zip', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
]);

/**
 * POST /api/upload - 上传文件
 */
router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ detail: '未收到文件' });
    }

    const { originalname, buffer, mimetype } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let content = '';
    let fileType = 'document';

    if (IMAGE_EXTENSIONS.has(ext)) {
        // 图片：转为 base64 data URL
        const b64 = buffer.toString('base64');
        content = `data:${mimetype || 'image/png'};base64,${b64}`;
        fileType = 'image';
    } else if (DOCUMENT_EXTENSIONS.has(ext)) {
        // 文本文档：直接解码
        content = buffer.toString('utf8');
        fileType = 'document';
    } else if (BINARY_EXTENSIONS.has(ext)) {
        content = `[此文件为二进制格式 (${ext})，暂不支持直接解析。请转为文本格式后上传。]`;
        fileType = 'document';
    } else {
        // 尝试文本解码
        content = buffer.toString('utf8');
        fileType = 'document';
    }

    // 保存到上传目录
    const uploadsDir = path.join(getDataDir(), 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const storedName = buildStoredFilename(originalname);
    fs.writeFileSync(path.join(uploadsDir, storedName), buffer);

    res.json({
        filename: originalname,
        stored_name: storedName,
        file_type: fileType,
        content,
        size_bytes: buffer.length,
    });
});

module.exports = router;
