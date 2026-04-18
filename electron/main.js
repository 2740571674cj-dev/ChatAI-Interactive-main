const { app, BrowserWindow, session } = require('electron');
const net = require('net');
const path = require('path');
const { resolveConfiguredDataDir } = require('../server/services/storage');

const DEFAULT_PORT = 8000;
let serverPort = DEFAULT_PORT;

function findFreePort(start = DEFAULT_PORT, end = 8100) {
    return new Promise((resolve) => {
        let port = start;

        function tryListen() {
            if (port > end) {
                resolve(start);
                return;
            }

            const probe = net.createServer();
            probe.once('error', () => {
                port += 1;
                tryListen();
            });
            probe.once('listening', () => {
                probe.close(() => resolve(port));
            });
            probe.listen(port, '127.0.0.1');
        }

        tryListen();
    });
}

function getFrontendDir() {
    if (app.isPackaged) {
        return path.join(app.getAppPath(), 'frontend');
    }
    return path.join(__dirname, '..', 'frontend');
}

async function startBackend() {
    process.env.CHATAI_DATA_DIR = resolveConfiguredDataDir();

    const { createApp } = require('../server/index');
    const expressApp = createApp(getFrontendDir());
    serverPort = await findFreePort(DEFAULT_PORT);

    return new Promise((resolve, reject) => {
        const server = expressApp.listen(serverPort, '127.0.0.1', () => {
            console.log(`Backend started: http://127.0.0.1:${serverPort}`);
            resolve(server);
        });
        server.on('error', reject);
    });
}

function setupMediaPermissions() {
    const ses = session.defaultSession;
    if (!ses) {
        return;
    }

    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
        if (
            (permission === 'media' || permission === 'microphone')
            && /^http:\/\/127\.0\.0\.1:\d+$/i.test(String(requestingOrigin || ''))
        ) {
            return true;
        }

        return false;
    });

    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const origin = String(details?.requestingUrl || '');
        const allow = (
            (permission === 'media' || permission === 'microphone')
            && /^http:\/\/127\.0\.0\.1:\d+/i.test(origin)
        );
        callback(allow);
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: 'ChatAI Interactive',
        backgroundColor: '#0d0d0d',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    win.webContents.setWindowOpenHandler(() => ({
        action: 'allow',
        overrideBrowserWindowOptions: {
            width: 1280,
            height: 820,
            minWidth: 900,
            minHeight: 640,
            autoHideMenuBar: true,
            backgroundColor: '#020617',
            title: 'ChatAI Interactive Preview',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        },
    }));

    const url = `http://127.0.0.1:${serverPort}/app`;
    console.log(`Loading frontend: ${url}`);
    win.loadURL(url);

    if (!app.isPackaged) {
        win.webContents.openDevTools({ mode: 'detach' });
    }

    return win;
}

app.whenReady().then(async () => {
    try {
        setupMediaPermissions();
        await startBackend();
        createWindow();
    } catch (error) {
        console.error('Failed to start application:', error);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
