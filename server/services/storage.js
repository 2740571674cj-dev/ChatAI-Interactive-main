const fs = require('fs');
const path = require('path');

function getElectronApp() {
    try {
        const electron = require('electron');
        return electron.app || electron.remote?.app || null;
    } catch {
        return null;
    }
}

function getSettingsDir() {
    const electronApp = getElectronApp();
    if (electronApp) {
        return electronApp.getPath('userData');
    }

    return path.join(__dirname, '..', '..', 'data');
}

function getSettingsPath() {
    return path.join(getSettingsDir(), 'storage-settings.json');
}

function getDefaultDataDir() {
    const electronApp = getElectronApp();
    if (electronApp) {
        return path.join(electronApp.getPath('userData'), 'data');
    }

    return path.join(__dirname, '..', '..', 'data');
}

function readStorageSettings() {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) {
        return {};
    }

    try {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
        return {};
    }
}

function updateStorageSettings(patch = {}) {
    const settingsDir = getSettingsDir();
    const currentSettings = readStorageSettings();
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
        getSettingsPath(),
        JSON.stringify({ ...currentSettings, ...patch }, null, 2),
        'utf8'
    );
}

function writeStorageSettings(dataDir) {
    updateStorageSettings({ dataDir: path.resolve(dataDir) });
}

function resolveConfiguredDataDir() {
    const configuredPath = readStorageSettings().dataDir;
    return configuredPath ? path.resolve(configuredPath) : getDefaultDataDir();
}

module.exports = {
    getDefaultDataDir,
    readStorageSettings,
    resolveConfiguredDataDir,
    updateStorageSettings,
    writeStorageSettings,
};
