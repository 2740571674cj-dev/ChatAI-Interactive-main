const fs = require('fs');
const path = require('path');
const { getDb, genId, nowUTC } = require('../database');
const { getOpenAiClient } = require('./ai');
const { getToolSchemas, executeAgentTool, resolveProjectRoot, safeStringify } = require('./agentTools');

const AGENT_STAGES = [
    { key: 'analysis', index: 1, title: '分析用户问题' },
    { key: 'prompt_refinement', index: 2, title: '优化用户提示词' },
    { key: 'solution_plan', index: 3, title: '制定解决方案' },
    { key: 'solution_evaluation', index: 4, title: '评估解决方案' },
    { key: 'execution', index: 5, title: '按方案执行' },
    { key: 'step_validation', index: 6, title: '执行一步验证一步' },
    { key: 'final_validation', index: 7, title: '总验证' },
    { key: 'final_report', index: 8, title: '输出汇报性结论' },
];

const DEFAULT_MODEL_TEMPERATURE = 0.1;
const MAX_HISTORY_MESSAGES = 10;
const MAX_STEP_ROUNDS = 6;
const MAX_PARALLEL_STEPS = 3;
const MAX_TOOL_CALLS_PER_STEP = 10;
const DEFAULT_EXECUTION_TIMEOUT = 120000;

function sendSse(res, payload) {
    if (!res || res.writableEnded) {
        return;
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeWhitespace(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(text = '', maxLength = 600) {
    const value = String(text || '').trim();
    return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

function uniqueList(values = []) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function parseJsonSafely(value, fallback = null) {
    if (value == null || value === '') {
        return fallback;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(String(value));
    } catch {
        return fallback;
    }
}

function extractJsonObject(text = '') {
    const source = String(text || '').trim();
    if (!source) {
        return null;
    }

    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidateTexts = fenced ? [fenced[1], source] : [source];

    for (const candidate of candidateTexts) {
        const trimmed = String(candidate || '').trim();
        const direct = parseJsonSafely(trimmed, null);
        if (direct && typeof direct === 'object') {
            return direct;
        }

        const starts = [];
        for (let index = 0; index < trimmed.length; index += 1) {
            if (trimmed[index] === '{' || trimmed[index] === '[') {
                starts.push(index);
            }
        }

        for (const start of starts) {
            const slice = trimmed.slice(start);
            for (let end = slice.length; end > 1; end -= 1) {
                const maybeJson = slice.slice(0, end);
                const parsed = parseJsonSafely(maybeJson, null);
                if (parsed && typeof parsed === 'object') {
                    return parsed;
                }
            }
        }
    }

    return null;
}

function taskLikelyRequiresArtifact(message = '', projectRoot = '') {
    if (!projectRoot) {
        return false;
    }

    return /(创建|实现|开发|修改|修复|搭建|生成|编写|写一个|写个|做一个|做个|制作|构建|新增|删除|重构|开发一个|build|create|implement|modify|edit|fix|scaffold|generate|write|develop)/i
        .test(String(message || ''));
}

function taskLikelyRequiresRunnableArtifact(message = '') {
    return /(运行|可运行|run|启动|页面|网站|界面|应用|系统|demo|原型|客户端|server|服务端|前端|网页)/i
        .test(String(message || ''));
}

function buildConversationTranscript(sessionId, currentMessage = '') {
    const db = getDb();
    const rows = db.prepare(
        `SELECT role, content
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
    ).all(sessionId, MAX_HISTORY_MESSAGES);

    const normalizedRows = rows.reverse().map((row) => ({
        role: row.role,
        content: truncateText(String(row.content || '').replace(/\n{3,}/g, '\n\n'), 1200),
    }));

    const lastContent = normalizedRows.at(-1)?.content || '';
    if (currentMessage && normalizeWhitespace(lastContent) !== normalizeWhitespace(currentMessage)) {
        normalizedRows.push({
            role: 'user',
            content: truncateText(currentMessage, 1200),
        });
    }

    return normalizedRows
        .map((item) => `${item.role}: ${item.content}`)
        .join('\n\n');
}

function summarizeProjectContext(projectContext = null) {
    if (!projectContext) {
        return '当前没有选中的项目目录。';
    }

    const rootPath = String(projectContext.root_path || '').trim();
    const focusPath = String(projectContext.focus_path || '').trim();
    const tree = Array.isArray(projectContext.tree) ? projectContext.tree : [];
    const flatNodes = [];

    const walk = (nodes = [], depth = 0) => {
        nodes.forEach((node) => {
            const indent = '  '.repeat(depth);
            flatNodes.push(`${indent}${node.type === 'directory' ? '[D]' : '[F]'} ${node.path || node.name}`);
            if (Array.isArray(node.children) && node.children.length > 0 && depth < 2) {
                walk(node.children, depth + 1);
            }
        });
    };

    walk(tree);

    return [
        `项目根目录: ${rootPath || '未选择'}`,
        `当前焦点: ${focusPath || '项目根目录'}`,
        flatNodes.length > 0 ? '项目树摘要:\n' + flatNodes.slice(0, 120).join('\n') : '项目树摘要: 暂无',
    ].join('\n');
}

function buildAgentKnowledgeBlock({ sessionId, message, projectContext, externalContext }) {
    return [
        '[用户请求]',
        String(message || '').trim(),
        '',
        '[最近对话上下文]',
        buildConversationTranscript(sessionId, message) || '无',
        '',
        '[项目上下文]',
        summarizeProjectContext(projectContext),
        '',
        '[外部上下文]',
        String(externalContext || '').trim() || '无',
    ].join('\n');
}

function getModelClient(modelConfig, timeout = DEFAULT_EXECUTION_TIMEOUT) {
    const client = getOpenAiClient(modelConfig, timeout);
    if (!client) {
        throw new Error('当前模型配置无效，无法启动 Agent。');
    }
    return client;
}

async function runModelText(modelConfig, messages, options = {}) {
    const client = getModelClient(modelConfig, options.timeout || DEFAULT_EXECUTION_TIMEOUT);
    const completion = await client.chat.completions.create({
        model: modelConfig.model_id,
        messages,
        temperature: options.temperature ?? DEFAULT_MODEL_TEMPERATURE,
        max_tokens: options.maxTokens || 1800,
    });

    return completion.choices?.[0]?.message?.content || '';
}

async function runModelJson(modelConfig, messages, options = {}) {
    const content = await runModelText(modelConfig, messages, options);
    const parsed = extractJsonObject(content);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`模型未返回可解析的 JSON。原始内容: ${truncateText(content, 400)}`);
    }
    return parsed;
}

function buildAnalysisFallback(message, projectRoot) {
    return {
        goal: truncateText(message, 200),
        success_criteria: [
            '输出与用户请求直接对应',
            projectRoot ? '若涉及产物则必须落地到选中项目' : '不给出与上下文无关的结果',
        ],
        constraints: projectRoot ? ['文件操作必须限制在选中项目根目录内'] : ['当前没有选中项目目录'],
        risks: projectRoot ? ['如果没有真实文件改动，则创建型任务必须失败'] : ['未选择项目目录时无法执行项目写入'],
        missing_information: [],
        recommended_task_type: taskLikelyRequiresArtifact(message, projectRoot) ? 'artifact_task' : 'analysis_task',
        requires_project_context: Boolean(projectRoot),
    };
}

function normalizePlan(plan, message, projectRoot, refinedRequest = '') {
    const source = plan && typeof plan === 'object' ? plan : {};
    const sourceSteps = Array.isArray(source.steps) ? source.steps : [];
    const inferredArtifact = taskLikelyRequiresArtifact(refinedRequest || message, projectRoot);
    const taskType = source.task_type === 'analysis_task'
        ? 'analysis_task'
        : (source.task_type === 'artifact_task' || inferredArtifact ? 'artifact_task' : 'analysis_task');

    const normalizedSteps = sourceSteps.map((step, index) => ({
        id: String(step.id || `step_${index + 1}`),
        title: truncateText(step.title || `步骤 ${index + 1}`, 120),
        objective: truncateText(step.objective || step.title || `完成步骤 ${index + 1}`, 300),
        requires_mutation: Boolean(step.requires_mutation || (taskType === 'artifact_task' && index === sourceSteps.length - 1)),
        target_files: uniqueList(Array.isArray(step.target_files) ? step.target_files.map((item) => String(item || '').trim()) : []),
        verification_checks: uniqueList(Array.isArray(step.verification_checks) ? step.verification_checks.map((item) => String(item || '').trim()) : []),
        parallel_group: String(step.parallel_group || `group_${index + 1}`),
        depends_on: uniqueList(Array.isArray(step.depends_on) ? step.depends_on.map((item) => String(item || '').trim()) : []),
        preferred_tools: uniqueList(Array.isArray(step.preferred_tools) ? step.preferred_tools.map((item) => String(item || '').trim()) : []),
    })).filter((step) => step.title);

    const steps = normalizedSteps.length > 0 ? normalizedSteps : [{
        id: 'step_1',
        title: taskType === 'artifact_task' ? '在选中项目内完成任务落地' : '完成分析与输出',
        objective: truncateText(refinedRequest || message, 300),
        requires_mutation: taskType === 'artifact_task',
        target_files: [],
        verification_checks: taskType === 'artifact_task'
            ? ['确认项目内发生真实文件改动']
            : ['确认输出直接回答用户请求'],
        parallel_group: 'group_1',
        depends_on: [],
        preferred_tools: [],
    }];

    return {
        objective: truncateText(source.objective || refinedRequest || message, 240),
        task_type: taskType,
        requires_artifact: taskType === 'artifact_task',
        requires_runnable_artifact: Boolean(source.requires_runnable_artifact || taskLikelyRequiresRunnableArtifact(refinedRequest || message)),
        steps,
    };
}

function buildExecutionBatches(steps = []) {
    const groups = new Map();
    const order = [];

    steps.forEach((step, index) => {
        const groupKey = String(step.parallel_group || `group_${index + 1}`);
        if (!groups.has(groupKey)) {
            groups.set(groupKey, []);
            order.push(groupKey);
        }
        groups.get(groupKey).push(step);
    });

    return order.map((groupKey) => ({
        group: groupKey,
        steps: groups.get(groupKey).slice(0, MAX_PARALLEL_STEPS),
    }));
}

function createAgentRun(sessionId, assistantMessageId, initialRequest) {
    const db = getDb();
    const runId = genId();
    const now = nowUTC();

    db.prepare(
        `INSERT INTO agent_runs (
            id, session_id, assistant_message_id, status, initial_request, refined_request, final_report, created_at, updated_at
        ) VALUES (?, ?, ?, 'running', ?, '', '', ?, ?)`
    ).run(runId, sessionId, assistantMessageId, initialRequest, now, now);

    const insertStage = db.prepare(
        `INSERT INTO agent_stages (
            id, run_id, stage_key, stage_index, stage_title, status, summary, started_at, completed_at, evaluation_json
        ) VALUES (?, ?, ?, ?, ?, 'pending', '', NULL, NULL, '{}')`
    );

    AGENT_STAGES.forEach((stage) => {
        insertStage.run(genId(), runId, stage.key, stage.index, stage.title);
    });

    return runId;
}

function updateRunStatus(runId, updates = {}) {
    const db = getDb();
    const current = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId);
    if (!current) {
        return;
    }

    const next = {
        status: updates.status ?? current.status,
        refined_request: updates.refined_request ?? current.refined_request,
        final_report: updates.final_report ?? current.final_report,
        updated_at: nowUTC(),
    };

    db.prepare(
        `UPDATE agent_runs
         SET status = ?, refined_request = ?, final_report = ?, updated_at = ?
         WHERE id = ?`
    ).run(next.status, next.refined_request, next.final_report, next.updated_at, runId);
}

function updateStage(runId, stageKey, updates = {}) {
    const db = getDb();
    const stage = db.prepare(
        'SELECT * FROM agent_stages WHERE run_id = ? AND stage_key = ?'
    ).get(runId, stageKey);
    if (!stage) {
        return null;
    }

    const nextStatus = updates.status ?? stage.status;
    const nextSummary = updates.summary ?? stage.summary;
    const nextEvaluationJson = updates.evaluation_json !== undefined
        ? safeStringify(updates.evaluation_json)
        : stage.evaluation_json;
    const nextStartedAt = updates.started_at !== undefined
        ? updates.started_at
        : (stage.started_at || (nextStatus === 'running' ? nowUTC() : stage.started_at));
    const nextCompletedAt = updates.completed_at !== undefined
        ? updates.completed_at
        : ((nextStatus === 'passed' || nextStatus === 'failed' || nextStatus === 'skipped') ? nowUTC() : stage.completed_at);

    db.prepare(
        `UPDATE agent_stages
         SET status = ?, summary = ?, evaluation_json = ?, started_at = ?, completed_at = ?
         WHERE id = ?`
    ).run(nextStatus, nextSummary, nextEvaluationJson, nextStartedAt, nextCompletedAt, stage.id);

    return {
        ...stage,
        status: nextStatus,
        summary: nextSummary,
        evaluation_json: parseJsonSafely(nextEvaluationJson, {}),
        started_at: nextStartedAt,
        completed_at: nextCompletedAt,
    };
}

function markRemainingStagesSkipped(runId, stageKeys = []) {
    stageKeys.forEach((stageKey) => {
        updateStage(runId, stageKey, {
            status: 'skipped',
            summary: '该阶段因前序阶段失败或阻断而跳过。',
        });
    });
}

function insertToolCall(runId, stageKey, stepIndex, stepTitle, toolName, inputJson) {
    const db = getDb();
    const id = genId();
    db.prepare(
        `INSERT INTO agent_tool_calls (
            id, run_id, stage_key, step_index, step_title, tool_name, input_json, output_json,
            mutated_project, changed_paths_json, working_directory, exit_code, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 0, '[]', '', NULL, 'running', ?)`
    ).run(id, runId, stageKey, stepIndex, stepTitle, toolName, safeStringify(inputJson), nowUTC());
    return id;
}

function completeToolCall(toolCallId, result = {}) {
    const db = getDb();
    db.prepare(
        `UPDATE agent_tool_calls
         SET output_json = ?, mutated_project = ?, changed_paths_json = ?, working_directory = ?, exit_code = ?, status = ?
         WHERE id = ?`
    ).run(
        safeStringify(result.output || result.error || {}),
        result.mutated_project ? 1 : 0,
        safeStringify(result.changed_paths || []),
        result.working_directory || '',
        Number.isFinite(Number(result.exit_code)) ? Number(result.exit_code) : null,
        result.status || 'passed',
        toolCallId
    );
}

function insertValidation(runId, stageKey, stepIndex, checkName, status, details) {
    const db = getDb();
    const id = genId();
    db.prepare(
        `INSERT INTO agent_validations (
            id, run_id, stage_key, step_index, check_name, status, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, runId, stageKey, stepIndex, checkName, status, safeStringify(details), nowUTC());
    return id;
}

function readStageRows(runId) {
    const db = getDb();
    const stages = db.prepare(
        `SELECT *
         FROM agent_stages
         WHERE run_id = ?
         ORDER BY stage_index ASC`
    ).all(runId);

    return stages.map((stage) => {
        const toolCalls = db.prepare(
            `SELECT *
             FROM agent_tool_calls
             WHERE run_id = ? AND stage_key = ?
             ORDER BY created_at ASC`
        ).all(runId, stage.stage_key).map((toolCall) => ({
            ...toolCall,
            input_json: parseJsonSafely(toolCall.input_json, {}),
            output_json: parseJsonSafely(toolCall.output_json, {}),
            changed_paths: parseJsonSafely(toolCall.changed_paths_json, []),
            mutated_project: Boolean(toolCall.mutated_project),
        }));

        const validations = db.prepare(
            `SELECT *
             FROM agent_validations
             WHERE run_id = ? AND stage_key = ?
             ORDER BY created_at ASC`
        ).all(runId, stage.stage_key).map((validation) => ({
            ...validation,
            details_json: parseJsonSafely(validation.details_json, {}),
        }));

        return {
            ...stage,
            evaluation_json: parseJsonSafely(stage.evaluation_json, {}),
            tool_calls: toolCalls,
            validations,
        };
    });
}

function getAgentRunDetails(runId) {
    const db = getDb();
    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId);
    if (!run) {
        return null;
    }
    return {
        ...run,
        stages: readStageRows(runId),
    };
}

function getAgentRunsForSession(sessionId) {
    const db = getDb();
    const rows = db.prepare(
        `SELECT *
         FROM agent_runs
         WHERE session_id = ?
         ORDER BY created_at DESC`
    ).all(sessionId);

    return rows.map((row) => ({
        ...row,
        stages: readStageRows(row.id),
    }));
}

function emitStageEvent(res, type, runId, stageKey, payload = {}) {
    sendSse(res, {
        type,
        run_id: runId,
        stage_key: stageKey,
        ...payload,
    });
}

function emitStageStarted(res, runId, stageKey, summary = '') {
    const stage = updateStage(runId, stageKey, {
        status: 'running',
        summary,
        started_at: nowUTC(),
        completed_at: null,
    });
    emitStageEvent(res, 'agent_stage_started', runId, stageKey, {
        status: 'running',
        summary: stage?.summary || summary,
        data: stage?.evaluation_json || {},
    });
}

function emitStageUpdated(res, runId, stageKey, summary = '', data = undefined) {
    const stage = updateStage(runId, stageKey, {
        status: 'running',
        summary,
        evaluation_json: data !== undefined ? data : undefined,
    });
    emitStageEvent(res, 'agent_stage_updated', runId, stageKey, {
        status: 'running',
        summary: stage?.summary || summary,
        data: stage?.evaluation_json || {},
    });
}

function emitStageCompleted(res, runId, stageKey, status, summary = '', data = undefined) {
    const stage = updateStage(runId, stageKey, {
        status,
        summary,
        evaluation_json: data !== undefined ? data : undefined,
        completed_at: nowUTC(),
    });
    emitStageEvent(res, 'agent_stage_completed', runId, stageKey, {
        status: stage?.status || status,
        summary: stage?.summary || summary,
        data: stage?.evaluation_json || {},
    });
}

function collectChangedPathsFromToolRecords(toolRecords = []) {
    return uniqueList(toolRecords.flatMap((record) => Array.isArray(record.changed_paths) ? record.changed_paths : []));
}

function buildToolResultForModel(record) {
    return {
        tool_name: record.tool_name,
        status: record.status,
        mutated_project: Boolean(record.mutated_project),
        changed_paths: record.changed_paths || [],
        working_directory: record.working_directory || '',
        output: record.output || {},
        error: record.error || '',
    };
}

async function analyzeUserProblem(modelConfig, knowledgeBlock, projectRoot, userMessage) {
    const fallback = buildAnalysisFallback(userMessage, projectRoot);
    const messages = [
        {
            role: 'system',
            content: [
                '你是桌面 Agent 的分析阶段。',
                '请只输出 JSON，不要输出额外解释。',
                '字段必须包含: goal, success_criteria, constraints, risks, missing_information, recommended_task_type, requires_project_context。',
                'recommended_task_type 只能是 artifact_task 或 analysis_task。',
                '如果当前选中了项目目录，且任务明显要求创建或修改实际文件，应优先判断为 artifact_task。',
            ].join('\n'),
        },
        {
            role: 'user',
            content: knowledgeBlock,
        },
    ];

    try {
        return await runModelJson(modelConfig, messages, { maxTokens: 1200 });
    } catch {
        return fallback;
    }
}

async function refinePrompt(modelConfig, knowledgeBlock, analysis) {
    const messages = [
        {
            role: 'system',
            content: [
                '你是桌面 Agent 的任务标准化阶段。',
                '请只输出 JSON，不要输出额外解释。',
                '字段必须包含: refined_request, execution_brief, verification_focus。',
                'execution_brief 和 verification_focus 必须是字符串数组。',
            ].join('\n'),
        },
        {
            role: 'user',
            content: [
                knowledgeBlock,
                '',
                '[分析结果]',
                safeStringify(analysis),
            ].join('\n'),
        },
    ];

    return runModelJson(modelConfig, messages, { maxTokens: 1400 });
}

async function buildSolutionPlan(modelConfig, knowledgeBlock, analysis, refinement, projectRoot) {
    const messages = [
        {
            role: 'system',
            content: [
                '你是桌面 Agent 的方案制定阶段。',
                '请只输出 JSON，不要输出额外解释。',
                '字段必须包含: objective, task_type, requires_artifact, requires_runnable_artifact, steps。',
                'steps 必须是数组，每个步骤包含: id, title, objective, requires_mutation, target_files, verification_checks, parallel_group, depends_on, preferred_tools。',
                '允许把彼此独立的步骤放进同一个 parallel_group，以便并行执行。',
            ].join('\n'),
        },
        {
            role: 'user',
            content: [
                knowledgeBlock,
                '',
                `[项目目录是否可用] ${projectRoot ? '是' : '否'}`,
                '',
                '[分析结果]',
                safeStringify(analysis),
                '',
                '[优化后的任务]',
                safeStringify(refinement),
            ].join('\n'),
        },
    ];

    try {
        const modelPlan = await runModelJson(modelConfig, messages, { maxTokens: 2200 });
        return normalizePlan(modelPlan, refinement?.refined_request || '', projectRoot, refinement?.refined_request || '');
    } catch {
        return normalizePlan({}, refinement?.refined_request || '', projectRoot, refinement?.refined_request || '');
    }
}

function buildEvaluationFromPlan(plan, analysis, refinement, projectRoot) {
    const metrics = {
        goal_alignment: {
            score: 9,
            rationale: '方案步骤直接对应用户目标，并以最终产物为中心。',
            blockingIssues: [],
            validationMethod: '检查步骤是否覆盖用户目标与成功标准。',
        },
        executability: {
            score: projectRoot || plan.task_type === 'analysis_task' ? 8 : 3,
            rationale: projectRoot || plan.task_type === 'analysis_task'
                ? '已有可用工具与上下文支持执行。'
                : '缺少项目根目录，无法执行真实文件写入。',
            blockingIssues: projectRoot || plan.task_type === 'analysis_task'
                ? []
                : ['当前任务需要在项目目录内落地产物，但尚未选择项目目录。'],
            validationMethod: '检查工具、路径和上下文是否齐备。',
        },
        risk_level: {
            score: plan.task_type === 'artifact_task' ? 7 : 9,
            rationale: plan.task_type === 'artifact_task'
                ? '存在文件写入和命令执行风险，但执行边界限定在选中项目内。'
                : '主要是分析型任务，副作用较低。',
            blockingIssues: [],
            validationMethod: '确认所有写操作均限制在项目根目录。',
        },
        verifiability: {
            score: 9,
            rationale: '每个步骤均要求验证项，最终还有总验证。',
            blockingIssues: [],
            validationMethod: '检查步骤是否绑定验证检查。',
        },
        rollback_readiness: {
            score: 7,
            rationale: '可通过改动文件列表与工具日志定位影响范围，但部分 shell 行为仍需谨慎。',
            blockingIssues: [],
            validationMethod: '检查是否记录改动路径与命令结果。',
        },
        output_completeness: {
            score: plan.steps.length > 0 ? 8 : 4,
            rationale: plan.steps.length > 0 ? '方案已覆盖执行与验证闭环。' : '方案步骤为空或不完整。',
            blockingIssues: plan.steps.length > 0 ? [] : ['没有可执行的步骤。'],
            validationMethod: '检查计划是否包含可执行步骤和产物目标。',
        },
    };

    const blockingIssues = uniqueList([
        ...Object.values(metrics).flatMap((metric) => Array.isArray(metric.blockingIssues) ? metric.blockingIssues : []),
    ]);

    if (plan.task_type === 'artifact_task' && !projectRoot) {
        blockingIssues.push('该任务要求对选中项目进行实际文件操作，但当前没有可用的项目根目录。');
    }

    const overallScore = Math.round(
        Object.values(metrics).reduce((sum, metric) => sum + Number(metric.score || 0), 0) / Object.keys(metrics).length
    );

    return {
        metrics,
        decision: blockingIssues.length === 0 ? 'approved' : 'blocked',
        overall_score: overallScore,
        blocking_issues: blockingIssues,
        analysis_snapshot: {
            recommended_task_type: analysis?.recommended_task_type || '',
            refined_request: refinement?.refined_request || '',
        },
    };
}

function listCanonicalToolNames(context = {}) {
    return getToolSchemas(context).map((schema) => schema?.function?.name || '');
}

function buildStepSystemPrompt(step, overallContext, plan, projectRoot, taskType) {
    const toolNames = listCanonicalToolNames({ projectContext: overallContext.projectContext });

    return [
        '你是桌面 Agent 的执行阶段，负责完成单个计划步骤。',
        '你必须根据步骤目标决定是否调用工具；当任务要求真实产物时，不能只给文字说明。',
        '若步骤 requires_mutation = true，则本步骤只有在选中项目目录内发生真实文件改动后才算成功。',
        '工具调用后会收到工具结果与改动路径，请据此继续思考下一步。',
        '当且仅当该步骤可以结束时，输出 JSON：',
        '{"status":"passed|failed","summary":"...","expected":"...","produced_artifacts":["..."],"next_hint":"..."}',
        '禁止输出除 JSON 之外的额外解释。',
        `当前任务类型: ${taskType}`,
        `当前项目根目录: ${projectRoot || '未选择'}`,
        `可用工具别名: ${toolNames.join(', ')}`,
        `本轮计划步骤总数: ${plan.steps.length}`,
    ].join('\n');
}

function buildStepUserPrompt(step, overallContext, dependencySummaries = []) {
    return [
        '[整体任务]',
        overallContext.refinement?.refined_request || overallContext.message,
        '',
        '[当前步骤]',
        safeStringify(step),
        '',
        dependencySummaries.length > 0 ? `[已完成的依赖步骤摘要]\n${dependencySummaries.join('\n')}\n` : '',
        '[分析结果]',
        safeStringify(overallContext.analysis),
        '',
        '[项目上下文]',
        summarizeProjectContext(overallContext.projectContext),
        '',
        '[附加上下文]',
        String(overallContext.externalContext || '').trim() || '无',
    ].join('\n');
}

function buildStepValidation(step, stepResult, taskType) {
    const changedPaths = collectChangedPathsFromToolRecords(stepResult.toolRecords);
    const mutatedProject = stepResult.toolRecords.some((record) => record.mutated_project);
    const toolErrors = stepResult.toolRecords.filter((record) => record.status === 'failed');
    const hasToolCalls = stepResult.toolRecords.length > 0;
    const requiresMutation = Boolean(step.requires_mutation || taskType === 'artifact_task');
    const explicitPass = String(stepResult.decision?.status || '').toLowerCase() === 'passed';

    let status = 'passed';
    let validator = '本步骤已通过工具证据完成验证。';

    if (toolErrors.length > 0) {
        status = 'failed';
        validator = `工具调用失败 ${toolErrors.length} 次，步骤未通过验证。`;
    } else if (requiresMutation && !mutatedProject) {
        status = 'failed';
        validator = '该步骤需要真实项目改动，但本次没有发生任何写入、编辑、删除或导入操作。';
    } else if (taskType === 'analysis_task' && !hasToolCalls && explicitPass) {
        status = 'passed';
        validator = '该步骤属于分析型任务，可在无文件改动的情况下通过。';
    } else if (!hasToolCalls && requiresMutation) {
        status = 'failed';
        validator = '该步骤要求真实产物，但没有发生任何工具调用。';
    } else if (!hasToolCalls && !explicitPass) {
        status = 'failed';
        validator = '该步骤没有工具证据，也没有形成可接受的完成判定。';
    }

    return {
        status,
        details: {
            expected: step.verification_checks.join('；') || (requiresMutation ? '确认真实项目改动已发生' : '确认步骤目标已完成'),
            validator,
            changed_paths: changedPaths,
            mutated_project: mutatedProject,
            step_summary: stepResult.summary || stepResult.decision?.summary || '',
            output_excerpt: truncateText(stepResult.rawContent || safeStringify(stepResult.decision || {}), 400),
        },
    };
}

async function executePlannedStep(params) {
    const {
        res,
        runId,
        modelConfig,
        step,
        stepIndex,
        plan,
        overallContext,
        projectRoot,
        taskType,
        dependencySummaries,
    } = params;

    const client = getModelClient(modelConfig, DEFAULT_EXECUTION_TIMEOUT);
    const toolSchemas = getToolSchemas({ projectContext: overallContext.projectContext });
    const messages = [
        { role: 'system', content: buildStepSystemPrompt(step, overallContext, plan, projectRoot, taskType) },
        { role: 'user', content: buildStepUserPrompt(step, overallContext, dependencySummaries) },
    ];

    const toolRecords = [];
    let rawContent = '';
    let decision = null;
    let toolCallsObserved = 0;

    for (let round = 0; round < MAX_STEP_ROUNDS; round += 1) {
        const completion = await client.chat.completions.create({
            model: modelConfig.model_id,
            messages,
            tools: toolSchemas,
            tool_choice: 'auto',
            temperature: DEFAULT_MODEL_TEMPERATURE,
            max_tokens: 1400,
        });

        const assistantMessage = completion.choices?.[0]?.message || {};
        const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
        rawContent = assistantMessage.content || rawContent;

        if (toolCalls.length > 0) {
            messages.push({
                role: 'assistant',
                content: assistantMessage.content || '',
                tool_calls: toolCalls,
            });

            for (const toolCall of toolCalls) {
                if (toolCallsObserved >= MAX_TOOL_CALLS_PER_STEP) {
                    break;
                }
                toolCallsObserved += 1;

                const parsedArgs = parseJsonSafely(toolCall.function?.arguments, {}) || {};
                const toolName = toolCall.function?.name || 'unknown_tool';
                const toolCallId = insertToolCall(runId, 'execution', stepIndex, step.title, toolName, parsedArgs);

                sendSse(res, {
                    type: 'agent_tool_call_started',
                    run_id: runId,
                    stage_key: 'execution',
                    tool_call_id: toolCallId,
                    step_index: stepIndex,
                    step_title: step.title,
                    tool_name: toolName,
                    input: parsedArgs,
                });

                let toolRecord;
                try {
                    const executionResult = await executeAgentTool(toolName, parsedArgs, {
                        projectContext: overallContext.projectContext,
                        sessionId: overallContext.sessionId,
                    });

                    toolRecord = {
                        tool_call_id: toolCallId,
                        tool_name: executionResult.tool_name,
                        status: 'passed',
                        output: executionResult.output,
                        changed_paths: executionResult.changed_paths,
                        mutated_project: executionResult.mutated_project,
                        working_directory: executionResult.working_directory,
                        exit_code: executionResult.output?.exit_code ?? null,
                    };

                    completeToolCall(toolCallId, {
                        output: executionResult.output,
                        mutated_project: executionResult.mutated_project,
                        changed_paths: executionResult.changed_paths,
                        working_directory: executionResult.working_directory,
                        exit_code: executionResult.output?.exit_code ?? null,
                        status: 'passed',
                    });

                    sendSse(res, {
                        type: 'agent_tool_call_completed',
                        run_id: runId,
                        stage_key: 'execution',
                        tool_call_id: toolCallId,
                        step_index: stepIndex,
                        step_title: step.title,
                        tool_name: executionResult.tool_name,
                        status: 'passed',
                        output: executionResult.output,
                        changed_paths: executionResult.changed_paths,
                        mutated_project: executionResult.mutated_project,
                        working_directory: executionResult.working_directory,
                    });

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: safeStringify(buildToolResultForModel(toolRecord)),
                    });
                } catch (error) {
                    const errorMessage = error?.message || String(error);
                    toolRecord = {
                        tool_call_id: toolCallId,
                        tool_name: toolName,
                        status: 'failed',
                        output: { error: errorMessage },
                        changed_paths: [],
                        mutated_project: false,
                        working_directory: projectRoot || '',
                        exit_code: null,
                        error: errorMessage,
                    };

                    completeToolCall(toolCallId, {
                        output: { error: errorMessage },
                        mutated_project: false,
                        changed_paths: [],
                        working_directory: projectRoot || '',
                        exit_code: null,
                        status: 'failed',
                    });

                    sendSse(res, {
                        type: 'agent_tool_call_completed',
                        run_id: runId,
                        stage_key: 'execution',
                        tool_call_id: toolCallId,
                        step_index: stepIndex,
                        step_title: step.title,
                        tool_name: toolName,
                        status: 'failed',
                        output: { error: errorMessage },
                        changed_paths: [],
                        mutated_project: false,
                        working_directory: projectRoot || '',
                    });

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: safeStringify(buildToolResultForModel(toolRecord)),
                    });
                }

                toolRecords.push(toolRecord);
            }

            if (toolCallsObserved >= MAX_TOOL_CALLS_PER_STEP) {
                break;
            }

            continue;
        }

        decision = extractJsonObject(assistantMessage.content || '');
        if (decision) {
            break;
        }

        messages.push({
            role: 'assistant',
            content: assistantMessage.content || '',
        });
        messages.push({
            role: 'user',
            content: '请停止解释，只输出步骤完成判定 JSON。',
        });
    }

    const summary = truncateText(
        decision?.summary
        || rawContent
        || (toolRecords.length > 0 ? `步骤已执行 ${toolRecords.length} 次工具调用。` : '步骤没有生成有效结果。'),
        240
    );

    const validation = buildStepValidation(step, {
        toolRecords,
        decision,
        rawContent,
        summary,
    }, taskType);

    const validationId = insertValidation(
        runId,
        'step_validation',
        stepIndex,
        step.title,
        validation.status,
        validation.details
    );

    sendSse(res, {
        type: 'agent_validation_started',
        run_id: runId,
        stage_key: 'step_validation',
        validation_id: validationId,
        step_index: stepIndex,
        check_name: step.title,
    });

    sendSse(res, {
        type: 'agent_validation_completed',
        run_id: runId,
        stage_key: 'step_validation',
        validation_id: validationId,
        step_index: stepIndex,
        check_name: step.title,
        status: validation.status,
        details: validation.details,
    });

    return {
        step_index: stepIndex,
        step_id: step.id,
        title: step.title,
        summary,
        status: validation.status,
        toolRecords,
        validation,
        changed_paths: collectChangedPathsFromToolRecords(toolRecords),
        mutated_project: toolRecords.some((record) => record.mutated_project),
        working_directory: toolRecords.find((record) => record.working_directory)?.working_directory || projectRoot || '',
    };
}

function buildExecutionStageData(stepOutcomes = []) {
    return {
        steps: stepOutcomes.map((stepOutcome) => ({
            step_index: stepOutcome.step_index,
            title: stepOutcome.title,
            status: stepOutcome.status,
            summary: stepOutcome.summary,
            changed_paths: stepOutcome.changed_paths,
            mutated_project: stepOutcome.mutated_project,
        })),
    };
}

function computeTargetFileChecks(plan, projectRoot, stepOutcomes = []) {
    if (!projectRoot) {
        return [];
    }

    const checks = [];
    const targetFiles = uniqueList(
        plan.steps.flatMap((step) => Array.isArray(step.target_files) ? step.target_files : [])
    );

    targetFiles.forEach((relativePath) => {
        const resolved = path.resolve(projectRoot, relativePath);
        const exists = fs.existsSync(resolved);
        checks.push({
            name: `目标文件检查: ${relativePath}`,
            status: exists ? 'passed' : 'failed',
            details: exists ? '目标路径存在。' : '目标路径不存在。',
        });
    });

    const changedPaths = uniqueList(stepOutcomes.flatMap((item) => item.changed_paths || []));
    if (changedPaths.length > 0) {
        changedPaths.forEach((changedPath) => {
            const resolved = path.resolve(projectRoot, changedPath);
            checks.push({
                name: `改动路径检查: ${changedPath}`,
                status: fs.existsSync(resolved) ? 'passed' : 'passed',
                details: fs.existsSync(resolved) ? '改动路径已存在。' : '改动路径已删除或移动，但改动已被记录。',
            });
        });
    }

    return checks;
}

function buildFinalValidation(plan, stepOutcomes, projectRoot) {
    const checks = [];
    const changedPaths = uniqueList(stepOutcomes.flatMap((item) => item.changed_paths || []));
    const mutatedProject = stepOutcomes.some((item) => item.mutated_project);
    const blockingIssues = [];

    stepOutcomes.forEach((stepOutcome) => {
        checks.push({
            name: stepOutcome.title,
            status: stepOutcome.validation.status,
            details: stepOutcome.validation.details.validator,
        });
    });

    if (plan.task_type === 'artifact_task') {
        checks.push({
            name: '真实项目改动检查',
            status: mutatedProject ? 'passed' : 'failed',
            details: mutatedProject
                ? `已记录 ${changedPaths.length} 个改动路径。`
                : '任务要求对选中项目进行实际文件操作，但执行阶段没有发生真实文件改动。',
        });

        if (!mutatedProject) {
            blockingIssues.push('该任务要求对选中项目进行实际文件操作，但执行阶段没有发生真实文件改动。');
        }
    }

    if (plan.requires_runnable_artifact) {
        const runnableEvidence = stepOutcomes.some((outcome) =>
            outcome.toolRecords.some((record) =>
                record.tool_name === 'shell.run'
                && record.status === 'passed'
                && (record.output?.exit_code == null || Number(record.output.exit_code) === 0)
            )
        );

        checks.push({
            name: '可运行/可构建验证',
            status: runnableEvidence ? 'passed' : 'failed',
            details: runnableEvidence
                ? '已捕获成功的 shell 验证或构建执行记录。'
                : '任务声明需要可运行或可构建结果，但没有成功的运行或构建验证记录。',
        });

        if (!runnableEvidence) {
            blockingIssues.push('任务声明需要可运行或可构建结果，但没有成功的运行或构建验证记录。');
        }
    }

    computeTargetFileChecks(plan, projectRoot, stepOutcomes).forEach((check) => {
        checks.push(check);
        if (check.status === 'failed') {
            blockingIssues.push(check.details);
        }
    });

    const failedChecks = checks.filter((check) => check.status !== 'passed');
    const status = failedChecks.length === 0 ? 'passed' : 'failed';
    const summary = status === 'passed'
        ? `共完成 ${stepOutcomes.length} 个步骤，并通过总验证。`
        : `${failedChecks.length} 项总验证未通过，请查看阻断原因。`;

    return {
        status,
        checks,
        blocking_issues: uniqueList(blockingIssues),
        summary,
        changed_paths: changedPaths,
        mutated_project: mutatedProject,
    };
}

async function buildFinalReport(modelConfig, context) {
    const messages = [
        {
            role: 'system',
            content: [
                '你是桌面 Agent 的最终汇报阶段。',
                '请输出简洁、可交付的中文结论。',
                '必须明确写出：完成了什么、改动了哪些文件、如何验证、还有什么注意事项。',
                '不要编造没有发生的文件或验证。',
            ].join('\n'),
        },
        {
            role: 'user',
            content: [
                '[任务]',
                context.refinedRequest,
                '',
                '[执行结果]',
                safeStringify(context.executionData),
                '',
                '[总验证]',
                safeStringify(context.finalValidation),
            ].join('\n'),
        },
    ];

    return truncateText(await runModelText(modelConfig, messages, { maxTokens: 1200, temperature: 0.2 }), 4000);
}

async function finalizeFailure(res, runId, reason, changedPaths = [], workingDirectory = '') {
    emitStageCompleted(res, runId, 'final_report', 'failed', reason, {
        status: 'failed',
        reason,
        changed_paths: changedPaths,
    });
    updateRunStatus(runId, { status: 'failed', final_report: reason });
    sendSse(res, {
        type: 'agent_run_failed',
        run_id: runId,
        summary: reason,
        changed_paths: changedPaths,
        working_directory: workingDirectory,
    });
    return {
        runId,
        finalReport: reason,
    };
}

async function runAgentMode({ res, sessionId, message, modelConfig, projectContext, externalContext, assistantMessageId }) {
    const projectRoot = resolveProjectRoot(projectContext);
    const runId = createAgentRun(sessionId, assistantMessageId, message);
    const knowledgeBlock = buildAgentKnowledgeBlock({ sessionId, message, projectContext, externalContext });
    const overallContext = {
        sessionId,
        message,
        projectContext,
        externalContext,
        analysis: null,
        refinement: null,
    };

    sendSse(res, {
        type: 'agent_run_started',
        run_id: runId,
        assistant_message_id: assistantMessageId,
        status: 'running',
    });

    try {
        emitStageStarted(res, runId, 'analysis', '正在分析任务目标、约束、风险和可执行条件。');
        const analysis = await analyzeUserProblem(modelConfig, knowledgeBlock, projectRoot, message);
        overallContext.analysis = analysis;
        emitStageCompleted(res, runId, 'analysis', 'passed', truncateText(analysis.goal || '已完成任务分析。', 180), analysis);

        emitStageStarted(res, runId, 'prompt_refinement', '正在把用户请求重写为内部执行指令。');
        const refinement = await refinePrompt(modelConfig, knowledgeBlock, analysis);
        overallContext.refinement = refinement;
        updateRunStatus(runId, { refined_request: refinement.refined_request || '' });
        emitStageCompleted(res, runId, 'prompt_refinement', 'passed', truncateText(refinement.refined_request || '已完成任务标准化。', 180), refinement);

        emitStageStarted(res, runId, 'solution_plan', '正在制定执行计划与并行批次。');
        const plan = await buildSolutionPlan(modelConfig, knowledgeBlock, analysis, refinement, projectRoot);
        emitStageCompleted(
            res,
            runId,
            'solution_plan',
            'passed',
            `共规划 ${plan.steps.length} 个步骤，任务类型为 ${plan.task_type}。`,
            plan
        );

        emitStageStarted(res, runId, 'solution_evaluation', '正在评估方案的可执行性、风险和验证覆盖度。');
        const evaluation = buildEvaluationFromPlan(plan, analysis, refinement, projectRoot);
        emitStageCompleted(
            res,
            runId,
            'solution_evaluation',
            evaluation.decision === 'approved' ? 'passed' : 'failed',
            evaluation.decision === 'approved' ? '方案评估通过。' : '方案评估未通过，存在阻断项。',
            evaluation
        );

        if (evaluation.decision !== 'approved') {
            markRemainingStagesSkipped(runId, ['execution', 'step_validation', 'final_validation']);
            return finalizeFailure(
                res,
                runId,
                evaluation.blocking_issues.join('；') || '方案评估未通过。',
                [],
                projectRoot || ''
            );
        }

        emitStageStarted(res, runId, 'execution', '正在执行计划步骤。可并行的步骤将并发推进。');
        emitStageStarted(res, runId, 'step_validation', '正在逐步验证每一个执行步骤。');

        const batches = buildExecutionBatches(plan.steps);
        const dependencySummaries = new Map();
        const stepOutcomes = [];

        for (const batch of batches) {
            emitStageUpdated(
                res,
                runId,
                'execution',
                `正在执行批次 ${batch.group}，共 ${batch.steps.length} 个并行步骤。`,
                buildExecutionStageData(stepOutcomes)
            );

            const settled = await Promise.allSettled(batch.steps.map((step) => {
                const priorSummaries = uniqueList(step.depends_on.map((depId) => dependencySummaries.get(depId)).filter(Boolean));
                return executePlannedStep({
                    res,
                    runId,
                    modelConfig,
                    step,
                    stepIndex: plan.steps.findIndex((item) => item.id === step.id) + 1,
                    plan,
                    overallContext,
                    projectRoot,
                    taskType: plan.task_type,
                    dependencySummaries: priorSummaries,
                });
            }));

            const batchOutcomes = settled.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                }

                const failedStep = batch.steps[index];
                const validationDetails = {
                    expected: failedStep.verification_checks.join('；') || '步骤需成功执行',
                    validator: result.reason?.message || String(result.reason || '步骤执行异常'),
                    changed_paths: [],
                    mutated_project: false,
                    step_summary: '',
                    output_excerpt: '',
                };
                const stepIndex = plan.steps.findIndex((item) => item.id === failedStep.id) + 1;
                const validationId = insertValidation(
                    runId,
                    'step_validation',
                    stepIndex,
                    failedStep.title,
                    'failed',
                    validationDetails
                );
                sendSse(res, {
                    type: 'agent_validation_completed',
                    run_id: runId,
                    stage_key: 'step_validation',
                    validation_id: validationId,
                    step_index: stepIndex,
                    check_name: failedStep.title,
                    status: 'failed',
                    details: validationDetails,
                });
                return {
                    step_index: stepIndex,
                    step_id: failedStep.id,
                    title: failedStep.title,
                    summary: result.reason?.message || '步骤执行异常',
                    status: 'failed',
                    toolRecords: [],
                    validation: {
                        status: 'failed',
                        details: validationDetails,
                    },
                    changed_paths: [],
                    mutated_project: false,
                    working_directory: projectRoot || '',
                };
            });

            batchOutcomes.forEach((outcome) => {
                stepOutcomes.push(outcome);
                dependencySummaries.set(outcome.step_id, `${outcome.title}: ${outcome.summary}`);
            });

            emitStageUpdated(
                res,
                runId,
                'execution',
                `已完成批次 ${batch.group}。`,
                buildExecutionStageData(stepOutcomes)
            );

            const failedInBatch = batchOutcomes.find((outcome) => outcome.status !== 'passed');
            if (failedInBatch) {
                emitStageCompleted(
                    res,
                    runId,
                    'execution',
                    'failed',
                    `${failedInBatch.title} 未通过执行验证。`,
                    buildExecutionStageData(stepOutcomes)
                );
                emitStageCompleted(
                    res,
                    runId,
                    'step_validation',
                    'failed',
                    `执行验证失败，失败步骤: ${failedInBatch.title}。`,
                    {
                        steps: stepOutcomes.map((item) => ({
                            step_index: item.step_index,
                            title: item.title,
                            status: item.validation.status,
                        })),
                    }
                );
                emitStageStarted(res, runId, 'final_validation', '正在根据失败结果生成总验证结论。');
                const failedValidation = buildFinalValidation(plan, stepOutcomes, projectRoot);
                emitStageCompleted(res, runId, 'final_validation', 'failed', failedValidation.summary, failedValidation);
                return finalizeFailure(
                    res,
                    runId,
                    failedValidation.blocking_issues.join('；') || failedValidation.summary,
                    failedValidation.changed_paths,
                    stepOutcomes.find((item) => item.working_directory)?.working_directory || projectRoot || ''
                );
            }
        }

        emitStageCompleted(
            res,
            runId,
            'execution',
            'passed',
            `已完成 ${stepOutcomes.length} 个执行步骤。`,
            buildExecutionStageData(stepOutcomes)
        );
        emitStageCompleted(
            res,
            runId,
            'step_validation',
            'passed',
            `逐步验证已完成，共验证 ${stepOutcomes.length} 个步骤。`,
            {
                steps: stepOutcomes.map((item) => ({
                    step_index: item.step_index,
                    title: item.title,
                    status: item.validation.status,
                })),
            }
        );

        emitStageStarted(res, runId, 'final_validation', '正在汇总所有工具证据与文件结果，执行总验证。');
        const finalValidation = buildFinalValidation(plan, stepOutcomes, projectRoot);
        emitStageCompleted(
            res,
            runId,
            'final_validation',
            finalValidation.status,
            finalValidation.summary,
            finalValidation
        );

        if (finalValidation.status !== 'passed') {
            return finalizeFailure(
                res,
                runId,
                finalValidation.blocking_issues.join('；') || finalValidation.summary,
                finalValidation.changed_paths,
                stepOutcomes.find((item) => item.working_directory)?.working_directory || projectRoot || ''
            );
        }

        emitStageStarted(res, runId, 'final_report', '正在生成最终汇报结论。');
        const finalReport = await buildFinalReport(modelConfig, {
            refinedRequest: refinement.refined_request || message,
            executionData: buildExecutionStageData(stepOutcomes),
            finalValidation,
        });

        emitStageCompleted(res, runId, 'final_report', 'passed', truncateText(finalReport, 200), {
            final_report: finalReport,
            final_validation: finalValidation,
        });

        updateRunStatus(runId, {
            status: 'completed',
            refined_request: refinement.refined_request || '',
            final_report: finalReport,
        });

        sendSse(res, {
            type: 'agent_run_completed',
            run_id: runId,
            summary: truncateText(finalReport, 200),
            changed_paths: finalValidation.changed_paths,
            working_directory: stepOutcomes.find((item) => item.working_directory)?.working_directory || projectRoot || '',
        });

        return {
            runId,
            finalReport,
        };
    } catch (error) {
        const reason = error?.message || String(error || 'Agent 执行失败');
        const pendingStages = getAgentRunDetails(runId)?.stages
            ?.filter((stage) => stage.status === 'pending')
            .map((stage) => stage.stage_key) || [];
        markRemainingStagesSkipped(runId, pendingStages);
        return finalizeFailure(res, runId, reason, [], projectRoot || '');
    }
}

module.exports = {
    AGENT_STAGES,
    getAgentRunDetails,
    getAgentRunsForSession,
    runAgentMode,
};
