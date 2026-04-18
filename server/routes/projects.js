const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const { readStorageSettings, updateStorageSettings } = require('../services/storage');

const router = Router();

const IGNORE_DIRS = new Set([
    '.git',
    'node_modules',
    '.next',
    '.nuxt',
    'dist',
    'build',
    'coverage',
    '.idea',
    '.vscode',
    '__pycache__',
    '.venv',
    'venv',
    'env',
    'target',
    'bin',
    'obj',
]);

const MAX_DEPTH = 4;
const MAX_CHILDREN = 40;

function resolveConfiguredProjectDir() {
    const configuredPath = readStorageSettings().projectDir;
    if (!configuredPath) {
        return null;
    }

    const resolved = path.resolve(configuredPath);
    if (!fs.existsSync(resolved)) {
        return null;
    }

    try {
        if (!fs.statSync(resolved).isDirectory()) {
            return null;
        }
    } catch {
        return null;
    }

    return resolved;
}

function compareEntries(a, b) {
    if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'zh-CN');
}

function buildProjectTree(rootDir, currentDir = rootDir, depth = 0) {
    if (depth > MAX_DEPTH) {
        return [];
    }

    let entries = [];
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter((entry) => !entry.name.startsWith('.') && !IGNORE_DIRS.has(entry.name.toLowerCase()))
        .map((entry) => {
            const absolutePath = path.join(currentDir, entry.name);
            const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');
            const node = {
                name: entry.name,
                path: relativePath,
                type: entry.isDirectory() ? 'directory' : 'file',
            };

            if (entry.isDirectory() && depth < MAX_DEPTH) {
                node.children = buildProjectTree(rootDir, absolutePath, depth + 1);
            }

            return node;
        })
        .sort(compareEntries)
        .slice(0, MAX_CHILDREN);
}

function buildProjectResponse(projectDir) {
    const resolvedDir = projectDir ? path.resolve(projectDir) : null;
    if (!resolvedDir || !fs.existsSync(resolvedDir)) {
        return {
            selected: false,
            path: '',
            name: '',
            tree: [],
        };
    }

    return {
        selected: true,
        path: resolvedDir,
        name: path.basename(resolvedDir),
        tree: buildProjectTree(resolvedDir),
    };
}

router.get('/', (req, res) => {
    res.json(buildProjectResponse(resolveConfiguredProjectDir()));
});

router.post('/select', async (req, res) => {
    try {
        let nextPath = req.body?.path ? path.resolve(req.body.path) : null;

        if (!nextPath) {
            const result = await dialog.showOpenDialog({
                title: '选择项目文件夹',
                defaultPath: resolveConfiguredProjectDir() || process.cwd(),
                properties: ['openDirectory', 'createDirectory'],
            });

            if (result.canceled || !result.filePaths?.[0]) {
                return res.json({
                    cancelled: true,
                    ...buildProjectResponse(resolveConfiguredProjectDir()),
                });
            }

            nextPath = path.resolve(result.filePaths[0]);
        }

        if (!fs.existsSync(nextPath) || !fs.statSync(nextPath).isDirectory()) {
            return res.status(400).json({ detail: 'Selected path is not a valid directory.' });
        }

        updateStorageSettings({ projectDir: nextPath });

        return res.json({
            cancelled: false,
            ...buildProjectResponse(nextPath),
        });
    } catch (error) {
        return res.status(500).json({ detail: `Failed to select the project folder: ${error.message}` });
    }
});

router.post('/clear', (req, res) => {
    updateStorageSettings({ projectDir: null });
    res.json({
        cleared: true,
        ...buildProjectResponse(null),
    });
});

module.exports = router;
