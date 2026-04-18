const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const simpleGit = require('simple-git');
const { dialog } = require('electron');
const { getDataDir, switchDataDir } = require('../database');
const { readStorageSettings, writeStorageSettings, updateStorageSettings } = require('./storage');
const { webSearch } = require('./webSearch');

const execFileAsync = promisify(execFile);

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

const CODE_EXTENSIONS = new Set([
    '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp',
    '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.lua', '.r',
    '.sh', '.bash', '.zsh', '.ps1', '.bat',
    '.html', '.css', '.scss', '.less', '.vue', '.svelte',
    '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.xml',
    '.sql', '.graphql', '.proto',
    '.md', '.txt', '.rst',
]);

const MAX_TREE_DEPTH = 4;
const MAX_TREE_CHILDREN = 40;
const MAX_SEARCH_RESULTS = 40;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PROJECT_SNAPSHOT_ENTRIES = 8000;
const TOOL_NAME_ALIASES = {
    project_read_tree: 'project.read_tree',
    project_read_file: 'project.read_file',
    project_search_text: 'project.search_text',
    project_write_file: 'project.write_file',
    project_edit_file: 'project.edit_file',
    project_delete_path: 'project.delete_path',
    shell_run: 'shell.run',
    web_search: 'web.search',
    web_fetch_page: 'web.fetch_page',
    github_import_repo: 'github.import_repo',
    storage_select_folder: 'storage.select_folder',
};

function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({ detail: String(value) });
    }
}

function toToolAlias(toolName = '') {
    return String(toolName || '').replace(/\./g, '_');
}

function fromToolAlias(toolName = '') {
    const value = String(toolName || '').trim();
    return TOOL_NAME_ALIASES[value] || value;
}

function normalizePathValue(value = '') {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function isWithinRoot(rootDir, targetPath) {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveProjectRoot(projectContext = null) {
    const rootPath = String(projectContext?.root_path || '').trim()
        || String(readStorageSettings().projectDir || '').trim();
    if (!rootPath) {
        return null;
    }

    const resolved = path.resolve(rootPath);
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

function resolvePathWithinProject(projectRoot, relativePath = '') {
    if (!projectRoot) {
        throw new Error('No project folder is currently selected.');
    }

    const normalizedRelativePath = normalizePathValue(relativePath);
    const resolved = normalizedRelativePath
        ? path.resolve(projectRoot, normalizedRelativePath)
        : path.resolve(projectRoot);

    if (!isWithinRoot(projectRoot, resolved)) {
        throw new Error('The requested path is outside the selected project root.');
    }

    return resolved;
}

function buildProjectTree(rootDir, currentDir = rootDir, depth = 0) {
    if (depth > MAX_TREE_DEPTH) {
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

            if (entry.isDirectory() && depth < MAX_TREE_DEPTH) {
                node.children = buildProjectTree(rootDir, absolutePath, depth + 1);
            }

            return node;
        })
        .sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'directory' ? -1 : 1;
            }
            return a.name.localeCompare(b.name, 'zh-CN');
        })
        .slice(0, MAX_TREE_CHILDREN);
}

function flattenTreeSummary(nodes = [], depth = 0, lines = []) {
    nodes.forEach((node) => {
        const indent = '  '.repeat(depth);
        lines.push(`${indent}${node.type === 'directory' ? '[D]' : '[F]'} ${node.path || node.name}`);
        if (Array.isArray(node.children) && node.children.length > 0) {
            flattenTreeSummary(node.children, depth + 1, lines);
        }
    });
    return lines;
}

function readUtf8File(filePath) {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
        throw new Error('The file is too large to read in Agent mode.');
    }
    return fs.readFileSync(filePath, 'utf8');
}

function collectSearchMatches(rootDir, query, currentDir = rootDir, results = []) {
    if (results.length >= MAX_SEARCH_RESULTS) {
        return results;
    }

    let entries = [];
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (results.length >= MAX_SEARCH_RESULTS) {
            break;
        }

        if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name.toLowerCase())) {
            continue;
        }

        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            collectSearchMatches(rootDir, query, entryPath, results);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext) && entry.name.toLowerCase() !== 'readme') {
            continue;
        }

        try {
            const content = readUtf8File(entryPath);
            const lines = content.split(/\r?\n/);
            lines.forEach((line, index) => {
                if (results.length >= MAX_SEARCH_RESULTS) {
                    return;
                }
                if (line.toLowerCase().includes(String(query || '').toLowerCase())) {
                    results.push({
                        path: path.relative(rootDir, entryPath).replace(/\\/g, '/'),
                        line: index + 1,
                        excerpt: line.trim().slice(0, 240),
                    });
                }
            });
        } catch {
            continue;
        }
    }

    return results;
}

function sanitizeRepoName(name) {
    const normalized = String(name || 'repo')
        .replace(/\.git$/i, '')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^\.+/, '')
        .replace(/^-+/, '')
        .slice(0, 120);
    return normalized || 'repo';
}

function parseRepoUrl(url) {
    let cleaned = String(url || '').trim().replace(/\/+$/, '');
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

function collectRepoFiles(dir, baseDir, files = []) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return files;
    }

    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            const lowerName = entry.name.toLowerCase();
            if (IGNORE_DIRS.has(lowerName) || entry.name.startsWith('.')) {
                continue;
            }
            collectRepoFiles(entryPath, baseDir, files);
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
            if (stat.size > 500 * 1024) {
                continue;
            }
            files.push(path.relative(baseDir, entryPath).replace(/\\/g, '/'));
        } catch {
            continue;
        }
    }

    return files;
}

function shouldSkipSnapshotDirectory(entryName = '') {
    const lowerName = String(entryName || '').toLowerCase();
    return IGNORE_DIRS.has(lowerName) || lowerName === '.git';
}

function collectProjectSnapshot(rootDir, currentDir = rootDir, entries = new Map()) {
    if (!rootDir || !fs.existsSync(rootDir) || entries.size >= MAX_PROJECT_SNAPSHOT_ENTRIES) {
        return entries;
    }

    let dirEntries = [];
    try {
        dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
        return entries;
    }

    for (const entry of dirEntries) {
        if (entries.size >= MAX_PROJECT_SNAPSHOT_ENTRIES) {
            break;
        }

        const absolutePath = path.join(currentDir, entry.name);
        const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
            if (shouldSkipSnapshotDirectory(entry.name)) {
                continue;
            }
            entries.set(relativePath, 'dir');
            collectProjectSnapshot(rootDir, absolutePath, entries);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        try {
            const stat = fs.statSync(absolutePath);
            entries.set(relativePath, `file:${stat.size}:${Math.floor(stat.mtimeMs)}`);
        } catch {
            continue;
        }
    }

    return entries;
}

function diffProjectSnapshots(before = new Map(), after = new Map()) {
    const added = [];
    const modified = [];
    const deleted = [];

    before.forEach((value, key) => {
        if (!after.has(key)) {
            deleted.push(key);
            return;
        }
        if (after.get(key) !== value) {
            modified.push(key);
        }
    });

    after.forEach((value, key) => {
        if (!before.has(key)) {
            added.push(key);
        }
    });

    const changedPaths = Array.from(new Set([...added, ...modified, ...deleted]));
    return {
        added,
        modified,
        deleted,
        changed_paths: changedPaths,
        mutated_project: changedPaths.length > 0,
        summary: {
            added_count: added.length,
            modified_count: modified.length,
            deleted_count: deleted.length,
        },
    };
}

function buildProjectMutationMeta(toolName, output, projectRoot, beforeSnapshot, afterSnapshot) {
    const diff = diffProjectSnapshots(beforeSnapshot, afterSnapshot);
    return {
        mutated_project: diff.mutated_project,
        changed_paths: diff.changed_paths,
        working_directory: output?.cwd || projectRoot || '',
        change_summary: {
            ...diff.summary,
            added: diff.added,
            modified: diff.modified,
            deleted: diff.deleted,
        },
    };
}

function toolCanMutateSelectedProject(toolName = '') {
    return [
        'project.write_file',
        'project.edit_file',
        'project.delete_path',
        'shell.run',
    ].includes(String(toolName || '').trim());
}

async function runPowerShellCommand(command, options = {}) {
    const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
    const timeout = Math.max(Number(options.timeout_ms) || 30000, 1000);
    const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', String(command || '')],
        {
            cwd,
            timeout,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
        }
    );

    return {
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exit_code: 0,
        cwd,
    };
}

async function runPowerShellCommandSafe(command, options = {}) {
    try {
        return await runPowerShellCommand(command, options);
    } catch (error) {
        return {
            stdout: String(error.stdout || ''),
            stderr: String(error.stderr || error.message || ''),
            exit_code: Number.isInteger(error.code) ? error.code : 1,
            cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
        };
    }
}

async function fetchPageContent(url) {
    const response = await fetch(String(url || ''), {
        headers: {
            'User-Agent': 'ChatAI-Interactive-Agent/1.0',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const raw = await response.text();
    const content = String(raw || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return {
        url: response.url || url,
        title: raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '',
        content: content.slice(0, 6000),
        status: response.status,
    };
}

function createToolDefinitions(context = {}) {
    const projectRoot = resolveProjectRoot(context.projectContext);

    return [
        {
            name: 'project.read_tree',
            description: 'Read the selected project tree and return a compact summary.',
            riskLevel: 'low',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
            validator: (output) => ({
                status: output?.selected ? 'passed' : 'failed',
                details: output?.selected ? 'Project tree loaded.' : 'No project folder is selected.',
            }),
            execute: async () => {
                if (!projectRoot) {
                    return {
                        selected: false,
                        project_root: '',
                        summary: '',
                        tree: [],
                    };
                }

                const tree = buildProjectTree(projectRoot);
                return {
                    selected: true,
                    project_root: projectRoot,
                    summary: flattenTreeSummary(tree).slice(0, 200).join('\n'),
                    tree,
                };
            },
        },
        {
            name: 'project.read_file',
            description: 'Read a UTF-8 text file from the selected project.',
            riskLevel: 'low',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path inside the selected project.' },
                },
                required: ['path'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: output?.content ? 'passed' : 'failed',
                details: output?.content ? 'File content loaded.' : 'File content is empty.',
            }),
            execute: async (args) => {
                const absolutePath = resolvePathWithinProject(projectRoot, args.path);
                if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
                    throw new Error('The requested file does not exist.');
                }
                return {
                    path: normalizePathValue(args.path),
                    absolute_path: absolutePath,
                    content: readUtf8File(absolutePath),
                };
            },
        },
        {
            name: 'project.search_text',
            description: 'Search for text inside the selected project files.',
            riskLevel: 'low',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for.' },
                },
                required: ['query'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: Array.isArray(output?.matches) && output.matches.length > 0 ? 'passed' : 'failed',
                details: Array.isArray(output?.matches) && output.matches.length > 0 ? `Found ${output.matches.length} matches.` : 'No matches found.',
            }),
            execute: async (args) => ({
                project_root: projectRoot || '',
                query: String(args.query || ''),
                matches: projectRoot ? collectSearchMatches(projectRoot, String(args.query || '')) : [],
            }),
        },
        {
            name: 'project.write_file',
            description: 'Write or create a UTF-8 text file inside the selected project.',
            riskLevel: 'high',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path inside the selected project.' },
                    content: { type: 'string', description: 'UTF-8 text content to write.' },
                },
                required: ['path', 'content'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: output?.written ? 'passed' : 'failed',
                details: output?.written ? 'File written successfully.' : 'File write failed.',
            }),
            execute: async (args) => {
                const absolutePath = resolvePathWithinProject(projectRoot, args.path);
                const hadExistingFile = fs.existsSync(absolutePath);
                const previousContent = hadExistingFile && fs.statSync(absolutePath).isFile()
                    ? fs.readFileSync(absolutePath, 'utf8')
                    : null;
                const nextContent = String(args.content || '');
                fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
                fs.writeFileSync(absolutePath, nextContent, 'utf8');
                return {
                    written: true,
                    path: normalizePathValue(args.path),
                    absolute_path: absolutePath,
                    bytes: Buffer.byteLength(nextContent, 'utf8'),
                    operation: hadExistingFile ? 'updated' : 'created',
                    content_changed: previousContent !== nextContent,
                };
            },
        },
        {
            name: 'project.edit_file',
            description: 'Edit an existing file by replacing a text fragment.',
            riskLevel: 'high',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path inside the selected project.' },
                    search: { type: 'string', description: 'The text to search for.' },
                    replace: { type: 'string', description: 'Replacement text.' },
                    replace_all: { type: 'boolean', description: 'Replace every match when true.' },
                },
                required: ['path', 'search', 'replace'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: output?.updated ? 'passed' : 'failed',
                details: output?.updated ? `Replaced ${output.replacements} match(es).` : 'No file edit was applied.',
            }),
            execute: async (args) => {
                const absolutePath = resolvePathWithinProject(projectRoot, args.path);
                if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
                    throw new Error('The requested file does not exist.');
                }

                const original = readUtf8File(absolutePath);
                const searchValue = String(args.search || '');
                if (!searchValue) {
                    throw new Error('The search text cannot be empty.');
                }

                const matches = original.split(searchValue).length - 1;
                if (matches <= 0) {
                    throw new Error('The target text was not found in the file.');
                }

                const nextContent = args.replace_all
                    ? original.split(searchValue).join(String(args.replace || ''))
                    : original.replace(searchValue, String(args.replace || ''));
                fs.writeFileSync(absolutePath, nextContent, 'utf8');

                return {
                    updated: true,
                    path: normalizePathValue(args.path),
                    absolute_path: absolutePath,
                    replacements: args.replace_all ? matches : 1,
                    content_changed: original !== nextContent,
                };
            },
        },
        {
            name: 'project.delete_path',
            description: 'Delete a file or directory inside the selected project.',
            riskLevel: 'high',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path inside the selected project.' },
                },
                required: ['path'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: output?.deleted ? 'passed' : 'failed',
                details: output?.deleted ? 'Path deleted successfully.' : 'Delete failed.',
            }),
            execute: async (args) => {
                const absolutePath = resolvePathWithinProject(projectRoot, args.path);
                if (!fs.existsSync(absolutePath)) {
                    throw new Error('The requested path does not exist.');
                }
                const existingStat = fs.statSync(absolutePath);
                fs.rmSync(absolutePath, { recursive: true, force: true });
                return {
                    deleted: true,
                    path: normalizePathValue(args.path),
                    absolute_path: absolutePath,
                    deleted_type: existingStat.isDirectory() ? 'directory' : 'file',
                };
            },
        },
        {
            name: 'shell.run',
            description: 'Run a PowerShell command locally and return stdout, stderr, and exit code.',
            riskLevel: 'high',
            inputSchema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The PowerShell command to run.' },
                    cwd: { type: 'string', description: 'Optional working directory relative to the selected project root.' },
                    timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
                },
                required: ['command'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: Number(output?.exit_code) === 0 ? 'passed' : 'failed',
                details: Number(output?.exit_code) === 0 ? 'Command completed successfully.' : `Command failed with exit code ${output?.exit_code}.`,
            }),
            execute: async (args) => {
                let cwd = projectRoot || process.cwd();
                if (args.cwd) {
                    cwd = projectRoot
                        ? resolvePathWithinProject(projectRoot, args.cwd)
                        : path.resolve(String(args.cwd || ''));
                }
                return runPowerShellCommandSafe(String(args.command || ''), {
                    cwd,
                    timeout_ms: args.timeout_ms,
                });
            },
        },
        {
            name: 'web.search',
            description: 'Search the web for current information.',
            riskLevel: 'medium',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query.' },
                    max_results: { type: 'number', description: 'Maximum result count.' },
                },
                required: ['query'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: Array.isArray(output?.results) && output.results.length > 0 ? 'passed' : 'failed',
                details: Array.isArray(output?.results) && output.results.length > 0 ? `Found ${output.results.length} web results.` : 'Web search returned no results.',
            }),
            execute: async (args) => ({
                query: String(args.query || ''),
                results: await webSearch(String(args.query || ''), {
                    maxResults: Math.min(Math.max(Number(args.max_results) || 8, 1), 24),
                }),
            }),
        },
        {
            name: 'web.fetch_page',
            description: 'Fetch and extract the main text content of a web page.',
            riskLevel: 'medium',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'HTTP or HTTPS URL.' },
                },
                required: ['url'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: output?.content ? 'passed' : 'failed',
                details: output?.content ? 'Fetched page content successfully.' : 'Fetched page content is empty.',
            }),
            execute: async (args) => fetchPageContent(args.url),
        },
        {
            name: 'github.import_repo',
            description: 'Clone a public GitHub repository into the app workspace and scan its files.',
            riskLevel: 'medium',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Public GitHub repository URL.' },
                },
                required: ['url'],
                additionalProperties: false,
            },
            validator: (output) => ({
                status: output?.success ? 'passed' : 'failed',
                details: output?.success ? `Imported ${output.repo_name}.` : 'GitHub import failed.',
            }),
            execute: async (args) => {
                const { cloneUrl, repoName } = parseRepoUrl(args.url);
                const reposDir = path.join(getDataDir(), 'github_repos');
                fs.mkdirSync(reposDir, { recursive: true });
                const targetDir = path.join(reposDir, repoName);

                if (!isWithinRoot(reposDir, targetDir)) {
                    throw new Error('The target repository directory is invalid.');
                }

                if (fs.existsSync(targetDir)) {
                    fs.rmSync(targetDir, { recursive: true, force: true });
                }

                await simpleGit().clone(cloneUrl, targetDir, ['--depth', '1', '--single-branch']);
                const files = collectRepoFiles(targetDir, targetDir);

                return {
                    success: true,
                    repo_name: repoName,
                    path: targetDir,
                    files_parsed: files.length,
                    files: files.slice(0, 80),
                };
            },
        },
        {
            name: 'storage.select_folder',
            description: 'Select a new app storage folder and migrate data to it.',
            riskLevel: 'high',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Optional target folder. If omitted, open a folder picker.' },
                },
                additionalProperties: false,
            },
            validator: (output) => ({
                status: output?.cancelled ? 'skipped' : output?.switched ? 'passed' : 'failed',
                details: output?.cancelled ? 'Storage folder selection was cancelled.' : output?.switched ? 'Storage folder switched successfully.' : 'Storage folder switch failed.',
            }),
            execute: async (args) => {
                const currentPath = getDataDir();
                let nextPath = args.path ? path.resolve(String(args.path || '')) : null;

                if (!nextPath) {
                    const result = await dialog.showOpenDialog({
                        title: 'Select Storage Folder',
                        defaultPath: currentPath,
                        properties: ['openDirectory', 'createDirectory'],
                    });

                    if (result.canceled || !result.filePaths?.[0]) {
                        return {
                            cancelled: true,
                            path: currentPath,
                        };
                    }

                    nextPath = path.resolve(result.filePaths[0]);
                }

                switchDataDir(nextPath);
                writeStorageSettings(nextPath);

                return {
                    cancelled: false,
                    switched: true,
                    migrated: true,
                    path: nextPath,
                };
            },
        },
    ];
}

function getToolSchemas(context = {}) {
    return createToolDefinitions(context).map((tool) => ({
        type: 'function',
        function: {
            name: toToolAlias(tool.name),
            description: `${tool.description} Canonical tool id: ${tool.name}.`,
            parameters: tool.inputSchema,
        },
    }));
}

async function executeAgentTool(toolName, args = {}, context = {}) {
    const definitions = createToolDefinitions(context);
    const canonicalName = fromToolAlias(toolName);
    const tool = definitions.find((item) => item.name === canonicalName);
    if (!tool) {
        throw new Error(`Unknown Agent tool: ${toolName}`);
    }

    const projectRoot = resolveProjectRoot(context.projectContext);
    const shouldTrackMutation = Boolean(projectRoot) && toolCanMutateSelectedProject(canonicalName);
    const beforeSnapshot = shouldTrackMutation ? collectProjectSnapshot(projectRoot) : null;
    const output = await tool.execute(args);
    const afterSnapshot = shouldTrackMutation ? collectProjectSnapshot(projectRoot) : null;
    const validation = typeof tool.validator === 'function'
        ? tool.validator(output, args, context)
        : null;
    const mutationMeta = shouldTrackMutation
        ? buildProjectMutationMeta(canonicalName, output, projectRoot, beforeSnapshot, afterSnapshot)
        : {
            mutated_project: false,
            changed_paths: [],
            working_directory: output?.cwd || projectRoot || '',
            change_summary: {
                added_count: 0,
                modified_count: 0,
                deleted_count: 0,
                added: [],
                modified: [],
                deleted: [],
            },
        };
    const enrichedOutput = {
        ...(output || {}),
        mutated_project: mutationMeta.mutated_project,
        changed_paths: mutationMeta.changed_paths,
        working_directory: mutationMeta.working_directory,
        change_summary: mutationMeta.change_summary,
    };

    return {
        tool_name: tool.name,
        risk_level: tool.riskLevel,
        output: enrichedOutput,
        output_json: safeStringify(enrichedOutput),
        validation,
        mutated_project: mutationMeta.mutated_project,
        changed_paths: mutationMeta.changed_paths,
        working_directory: mutationMeta.working_directory,
        change_summary: mutationMeta.change_summary,
    };
}

module.exports = {
    getToolSchemas,
    executeAgentTool,
    resolveProjectRoot,
    safeStringify,
};
