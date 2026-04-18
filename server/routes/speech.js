const { Router } = require('express');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const multer = require('multer');
const OpenAI = require('openai');
const { promisify } = require('util');
const { getActiveModelConfig, getOpenAiClient } = require('../services/ai');

const router = Router();
const execFileAsync = promisify(execFile);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

const TRANSCRIPTION_MODELS = [
    'gpt-4o-mini-transcribe',
    'whisper-1',
];

async function transcribeWithFallback(client, file, options = {}) {
    let lastError = null;

    for (const model of TRANSCRIPTION_MODELS) {
        try {
            const result = await client.audio.transcriptions.create({
                file,
                model,
                language: options.language || undefined,
                temperature: 0,
            });

            const text = String(result?.text || '').trim();
            if (text) {
                return { text, model };
            }
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('No transcription model is available.');
}

function normalizeWindowsSpeechCulture(language = '') {
    const normalized = String(language || '').trim().toLowerCase();
    if (!normalized) {
        return 'zh-CN';
    }

    if (normalized === 'zh' || normalized.startsWith('zh-')) {
        return 'zh-CN';
    }

    if (normalized === 'en' || normalized.startsWith('en-')) {
        return 'en-US';
    }

    return normalized;
}

async function writeTempSpeechFile(buffer, originalName = 'speech.wav') {
    const extension = path.extname(originalName) || '.wav';
    const tempPath = path.join(
        os.tmpdir(),
        `chatai-speech-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`
    );
    await fs.writeFile(tempPath, buffer);
    return tempPath;
}

function buildWindowsSpeechScript(filePath, cultureName) {
    const safePath = String(filePath || '').replace(/'/g, "''");
    const safeCulture = String(cultureName || 'zh-CN').replace(/'/g, "''");

    return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$path = '${safePath}'
$preferredCulture = '${safeCulture}'
$recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name -eq $preferredCulture } |
    Select-Object -First 1
if (-not $recognizer) {
    $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1
}
if (-not $recognizer) {
    throw 'No Windows speech recognizer is installed.'
}
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
try {
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToWaveFile($path)
    $segments = New-Object System.Collections.Generic.List[string]
    while ($true) {
        $result = $engine.Recognize()
        if ($null -eq $result) {
            break
        }
        if ($result.Text) {
            [void]$segments.Add($result.Text)
        }
    }
    @{
        text = ($segments -join ' ')
        culture = $recognizer.Culture.Name
        engine = 'windows-speech'
    } | ConvertTo-Json -Compress
}
finally {
    $engine.Dispose()
}
`.trim();
}

async function transcribeWithWindowsSpeech(filePath, language = 'zh') {
    const script = buildWindowsSpeechScript(filePath, normalizeWindowsSpeechCulture(language));
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        {
            timeout: 120000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        }
    );

    const payload = String(stdout || '').trim();
    if (!payload) {
        throw new Error('Windows speech recognizer returned an empty result.');
    }

    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch {
        throw new Error(payload);
    }

    const text = String(parsed?.text || '').trim();
    if (!text) {
        throw new Error('Windows speech recognizer did not detect clear speech.');
    }

    return {
        text,
        model: parsed?.engine || 'windows-speech',
        culture: parsed?.culture || normalizeWindowsSpeechCulture(language),
    };
}

function normalizeSpeechErrorMessage(error, localFallbackTried = false) {
    const message = [
        error?.stderr,
        error?.stdout,
        error?.message,
        error,
    ]
        .filter(Boolean)
        .map((value) => String(value))
        .join(' ')
        .trim() || 'Transcription failed.';

    if (/401|403|unauthorized|forbidden/i.test(message)) {
        return localFallbackTried
            ? 'AI transcription authorization failed, and Windows speech fallback also did not succeed. Please check the API key or try a clearer recording.'
            : 'Audio transcription authorization failed. Please check the API key.';
    }

    if (/429/.test(message)) {
        return localFallbackTried
            ? 'AI transcription is rate-limited, and Windows speech fallback also did not succeed. Please try again later.'
            : 'Audio transcription is rate-limited. Please try again later.';
    }

    if (/No Windows speech recognizer is installed|did not detect clear speech|empty result/i.test(message)) {
        return `Speech-to-text failed: ${message}`;
    }

    if (/404|not found|unsupported|unknown/i.test(message)) {
        return localFallbackTried
            ? 'The current AI service does not support audio transcription, and Windows speech fallback also did not succeed.'
            : 'The current AI service does not support audio transcription.';
    }

    return `Speech-to-text failed: ${message}`;
}

router.post('/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file?.buffer) {
        return res.status(400).json({ detail: 'Missing audio file.' });
    }

    const requestedLanguage = String(req.body?.language || '').trim() || 'zh';
    const modelConfig = getActiveModelConfig(req.body?.model_config_id || null);
    const client = modelConfig ? getOpenAiClient(modelConfig, 120000) : null;
    let lastError = null;
    let tempAudioPath = null;

    try {
        if (client) {
            const file = await OpenAI.toFile(
                req.file.buffer,
                req.file.originalname || 'speech.wav',
                { type: req.file.mimetype || 'audio/wav' }
            );

            try {
                const result = await transcribeWithFallback(client, file, {
                    language: requestedLanguage || undefined,
                });

                return res.json({
                    text: result.text,
                    model: result.model,
                    engine: 'ai',
                });
            } catch (error) {
                lastError = error;
            }
        } else {
            lastError = new Error('No active AI model is available for transcription.');
        }

        tempAudioPath = await writeTempSpeechFile(req.file.buffer, req.file.originalname || 'speech.wav');
        const localResult = await transcribeWithWindowsSpeech(tempAudioPath, requestedLanguage);
        return res.json({
            text: localResult.text,
            model: localResult.model,
            engine: 'windows',
            culture: localResult.culture,
        });
    } catch (error) {
        const normalized = normalizeSpeechErrorMessage(error, Boolean(lastError));
        res.status(502).json({ detail: normalized });
    } finally {
        if (tempAudioPath) {
            fs.unlink(tempAudioPath).catch(() => {});
        }
    }
});

module.exports = router;
