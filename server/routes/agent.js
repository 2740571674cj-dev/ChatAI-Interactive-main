const { Router } = require('express');
const { getAgentRunDetails, getAgentRunsForSession } = require('../services/agentRunner');

const router = Router();

router.get('/runs/:runId', (req, res) => {
    const run = getAgentRunDetails(req.params.runId);
    if (!run) {
        return res.status(404).json({ detail: 'Agent run not found.' });
    }
    return res.json(run);
});

router.get('/runs/:runId/stages', (req, res) => {
    const run = getAgentRunDetails(req.params.runId);
    if (!run) {
        return res.status(404).json({ detail: 'Agent run not found.' });
    }
    return res.json(run.stages || []);
});

router.get('/runs/:runId/tool-calls', (req, res) => {
    const run = getAgentRunDetails(req.params.runId);
    if (!run) {
        return res.status(404).json({ detail: 'Agent run not found.' });
    }
    return res.json(
        (run.stages || []).flatMap((stage) => stage.tool_calls || [])
    );
});

router.get('/sessions/:sessionId', (req, res) => {
    return res.json(getAgentRunsForSession(req.params.sessionId));
});

module.exports = router;
