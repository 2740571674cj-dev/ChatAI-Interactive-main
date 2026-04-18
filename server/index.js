/**
 * ChatAI Interactive - Express 后端服务入口
 * 
 * 替代 Python 版 backend/main.py
 * 初始化数据库、注册路由、提供前端静态文件服务。
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase } = require('./database');

/**
 * 创建并配置 Express 应用
 * @param {string} frontendDir - 前端文件根目录
 * @returns {express.Application}
 */
function createApp(frontendDir) {
    // 初始化数据库
    initDatabase();

    const app = express();

    // 中间件
    app.use(cors({
        origin: '*',
        credentials: true,
        exposedHeaders: ['*'],
    }));
    app.use(express.json({ limit: '50mb' }));

    // ============================================================
    // 注册 API 路由
    // ============================================================
    app.use('/api/sessions', require('./routes/sessions'));
    app.use('/api/messages', require('./routes/messages'));
    app.use('/api/chat', require('./routes/chat'));
    app.use('/api/models', require('./routes/models'));
    app.use('/api/prompts', require('./routes/prompts'));
    app.use('/api/storage', require('./routes/storage'));
    app.use('/api/projects', require('./routes/projects'));
    app.use('/api/upload', require('./routes/upload'));
    app.use('/api/speech', require('./routes/speech'));
    app.use('/api/github', require('./routes/github'));
    app.use('/api/agent', require('./routes/agent'));

    // ============================================================
    // 前端静态文件服务
    // ============================================================
    const assetsDir = path.join(frontendDir, 'assets');
    if (fs.existsSync(assetsDir)) {
        app.use('/static', express.static(assetsDir));
    }

    // 前端入口页面
    app.get('/app', (req, res) => {
        const htmlFile = path.join(frontendDir, 'index.html');
        if (fs.existsSync(htmlFile)) {
            let content = fs.readFileSync(htmlFile, 'utf8');
            // 修正资源引用路径（和 Python 版同样的逻辑）
            content = content.replace(
                /\.\/ChatAI Interactive UI_files\//g,
                '/static/'
            );
            res.type('html').send(content);
        } else {
            res.status(404).send('<h1>前端文件未找到</h1>');
        }
    });

    // ============================================================
    // 健康检查
    // ============================================================
    app.get('/', (req, res) => {
        res.json({
            service: 'ChatAI Interactive API',
            version: '1.0.0',
            status: 'running',
            docs: '/docs (仅 FastAPI 版可用)',
        });
    });

    app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    return app;
}

module.exports = { createApp };
