const { Router } = require('express');
const path = require('path');
const { dialog } = require('electron');
const { getDataDir, switchDataDir } = require('../database');
const { getDefaultDataDir, writeStorageSettings } = require('../services/storage');

const router = Router();

function buildStorageResponse(currentPath) {
    const normalizedCurrentPath = path.resolve(currentPath);
    const defaultPath = path.resolve(getDefaultDataDir());
    return {
        path: normalizedCurrentPath,
        default_path: defaultPath,
        is_default: normalizedCurrentPath === defaultPath,
    };
}

router.get('/', (req, res) => {
    res.json(buildStorageResponse(getDataDir()));
});

router.post('/select', async (req, res) => {
    try {
        const currentPath = getDataDir();
        let nextPath = req.body?.path ? path.resolve(req.body.path) : null;

        if (!nextPath) {
            const result = await dialog.showOpenDialog({
                title: '选择存储目录',
                defaultPath: currentPath,
                properties: ['openDirectory', 'createDirectory'],
            });

            if (result.canceled || !result.filePaths?.[0]) {
                return res.json({
                    cancelled: true,
                    ...buildStorageResponse(currentPath),
                });
            }

            nextPath = path.resolve(result.filePaths[0]);
        }

        if (!nextPath) {
            return res.json({
                cancelled: true,
                ...buildStorageResponse(currentPath),
            });
        }

        switchDataDir(nextPath);
        writeStorageSettings(nextPath);

        return res.json({
            cancelled: false,
            switched: true,
            migrated: true,
            ...buildStorageResponse(nextPath),
        });
    } catch (error) {
        return res.status(500).json({ detail: `切换存储目录失败：${error.message}` });
    }
});

module.exports = router;
