const fs = require('fs');
const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

let db = null;
let currentDbPath = null;

function hasColumn(database, tableName, columnName) {
    const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
    return columns.some((column) => column.name === columnName);
}

function ensureColumn(database, tableName, columnName, definitionSql) {
    if (!hasColumn(database, tableName, columnName)) {
        database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
    }
}

function getDataDir() {
    if (process.env.CHATAI_DATA_DIR) {
        return process.env.CHATAI_DATA_DIR;
    }

    return path.join(__dirname, '..', 'data');
}

function initDatabase() {
    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

    const dbPath = path.join(dataDir, 'chatai.db');
    if (db && currentDbPath === dbPath) {
        return db;
    }

    if (db) {
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
        } catch {}
        db = null;
        currentDbPath = null;
    }

    db = new Database(dbPath);
    currentDbPath = dbPath;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL DEFAULT 'default',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            title TEXT NOT NULL DEFAULT 'New Chat',
            chat_mode TEXT NOT NULL DEFAULT 'ask',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS ix_sessions_updated_at ON sessions(updated_at);

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            model_name TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_messages_session_id ON messages(session_id);

        CREATE TABLE IF NOT EXISTS model_configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key_encrypted TEXT NOT NULL,
            model_id TEXT NOT NULL DEFAULT 'gpt-4o',
            is_active INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS prompts (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            enabled INTEGER DEFAULT 1,
            session_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        CREATE INDEX IF NOT EXISTS ix_prompts_type ON prompts(type);

        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            assistant_message_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            initial_request TEXT NOT NULL DEFAULT '',
            refined_request TEXT NOT NULL DEFAULT '',
            final_report TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_agent_runs_session_id ON agent_runs(session_id);
        CREATE INDEX IF NOT EXISTS ix_agent_runs_message_id ON agent_runs(assistant_message_id);

        CREATE TABLE IF NOT EXISTS agent_stages (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            stage_key TEXT NOT NULL,
            stage_index INTEGER NOT NULL,
            stage_title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            summary TEXT NOT NULL DEFAULT '',
            started_at TEXT,
            completed_at TEXT,
            evaluation_json TEXT NOT NULL DEFAULT '{}',
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_agent_stages_run_id ON agent_stages(run_id, stage_index);

        CREATE TABLE IF NOT EXISTS agent_tool_calls (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            stage_key TEXT NOT NULL,
            step_index INTEGER NOT NULL DEFAULT 0,
            step_title TEXT NOT NULL DEFAULT '',
            tool_name TEXT NOT NULL,
            input_json TEXT NOT NULL DEFAULT '{}',
            output_json TEXT NOT NULL DEFAULT '{}',
            mutated_project INTEGER NOT NULL DEFAULT 0,
            changed_paths_json TEXT NOT NULL DEFAULT '[]',
            working_directory TEXT NOT NULL DEFAULT '',
            exit_code INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_agent_tool_calls_run_id ON agent_tool_calls(run_id, created_at);

        CREATE TABLE IF NOT EXISTS agent_validations (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            stage_key TEXT NOT NULL,
            step_index INTEGER NOT NULL DEFAULT 0,
            check_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            details_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ix_agent_validations_run_id ON agent_validations(run_id, created_at);
    `);

    ensureColumn(db, 'sessions', 'chat_mode', "TEXT NOT NULL DEFAULT 'ask'");
    ensureColumn(db, 'agent_tool_calls', 'mutated_project', "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, 'agent_tool_calls', 'changed_paths_json', "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, 'agent_tool_calls', 'working_directory', "TEXT NOT NULL DEFAULT ''");

    db.exec(`
        CREATE INDEX IF NOT EXISTS ix_sessions_chat_mode_updated_at ON sessions(chat_mode, updated_at);
    `);

    return db;
}

function copyDirIfMissing(sourceDir, targetDir) {
    if (!fs.existsSync(sourceDir) || fs.existsSync(targetDir)) {
        return;
    }

    fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function switchDataDir(nextDataDir) {
    const normalizedNextDir = path.resolve(nextDataDir);
    const currentDataDir = path.resolve(getDataDir());
    if (normalizedNextDir === currentDataDir) {
        return initDatabase();
    }

    const currentPath = currentDbPath || path.join(currentDataDir, 'chatai.db');
    const nextDbPath = path.join(normalizedNextDir, 'chatai.db');

    if (db) {
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
        } catch {}
        db = null;
        currentDbPath = null;
    }

    fs.mkdirSync(normalizedNextDir, { recursive: true });
    fs.mkdirSync(path.join(normalizedNextDir, 'uploads'), { recursive: true });

    if (fs.existsSync(currentPath) && !fs.existsSync(nextDbPath)) {
        fs.copyFileSync(currentPath, nextDbPath);
    }

    copyDirIfMissing(path.join(currentDataDir, 'uploads'), path.join(normalizedNextDir, 'uploads'));
    copyDirIfMissing(path.join(currentDataDir, 'github_repos'), path.join(normalizedNextDir, 'github_repos'));

    process.env.CHATAI_DATA_DIR = normalizedNextDir;
    return initDatabase();
}

function getDb() {
    if (!db) {
        throw new Error('Database has not been initialized. Call initDatabase() first.');
    }

    return db;
}

function genId() {
    return uuidv4();
}

function nowUTC() {
    return new Date().toISOString();
}

module.exports = { initDatabase, getDb, genId, nowUTC, getDataDir, switchDataDir };
