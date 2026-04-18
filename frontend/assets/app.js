function appAlert(message) {
    window.alert(message);
}

function escapeHtmlFragment(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncateText(text, maxChars = 280) {
    const value = String(text || '').trim();
    if (!value) {
        return '';
    }
    return value.length > maxChars ? `${value.slice(0, maxChars).trim()}...` : value;
}

function neutralizeRawHtmlOutsideCodeFences(markdown) {
    const source = String(markdown || '');
    const fencePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
    const htmlPattern = /<!--[\s\S]*?-->|<![A-Za-z][^>]*>|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*)?\/?>/g;
    let output = '';
    let cursor = 0;
    let match;

    while ((match = fencePattern.exec(source))) {
        output += source.slice(cursor, match.index).replace(htmlPattern, escapeHtmlFragment);
        output += match[0];
        cursor = match.index + match[0].length;
    }

    output += source.slice(cursor).replace(htmlPattern, escapeHtmlFragment);
    return output;
}

function renderSafeMarkdownHtml(markdown) {
    const safeSource = neutralizeRawHtmlOutsideCodeFences(markdown);
    return DOMPurify.sanitize(marked.parse(safeSource), {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
        ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'colspan', 'rowspan'],
        FORBID_ATTR: ['class', 'style', 'src', 'srcset', 'srcdoc', 'onerror', 'onload', 'onclick'],
    });
}

let webSearchEnabled = false;
const CHAT_MODE_STORAGE_KEY = 'chatai:chat-mode';
const WEB_SEARCH_STORAGE_KEY = 'chatai:web-search-enabled';
const SPEECH_MODE_STORAGE_KEY = 'chatai:speech-mode';
const SPEECH_TARGET_SAMPLE_RATE = 16000;
const CHAT_MODE_CONFIG = {
    ask: {
        badge: '问答模式',
        placeholder: '输入你的问题',
        sendTitle: '以问答模式发送',
    },
    agent: {
        badge: '代理模式',
        placeholder: '描述你要我执行的任务',
        sendTitle: '以代理模式发送',
    },
};
let currentChatMode = 'ask';
let pendingAttachments = [];
let isUploadingAttachments = false;
let speechMediaStream = null;
let speechAudioContext = null;
let speechSourceNode = null;
let speechProcessorNode = null;
let speechMonitorNode = null;
let speechPcmChunks = [];
let speechInputSampleRate = SPEECH_TARGET_SAMPLE_RATE;
let isSpeechCaptureSupported = false;
let embeddedSpeechRecognition = null;
let isEmbeddedSpeechSupported = false;
let isSpeechListening = false;
let isSpeechTranscribing = false;
let speechMode = 'backend';

function autoResizeUserInput() {
    if (!ui?.userInput) {
        return;
    }

    ui.userInput.style.height = '';
    ui.userInput.style.height = `${ui.userInput.scrollHeight}px`;
}

function normalizeChatMode(mode) {
    return String(mode || '').toLowerCase() === 'agent' ? 'agent' : 'ask';
}

function applyChatModeButtonState(button, isActive) {
    if (!button) {
        return;
    }

    button.classList.toggle('mode-pill-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
}

function renderChatMode() {
    const mode = CHAT_MODE_CONFIG[currentChatMode] || CHAT_MODE_CONFIG.ask;

    applyChatModeButtonState(ui.askModeBtn, currentChatMode === 'ask');
    applyChatModeButtonState(ui.agentModeBtn, currentChatMode === 'agent');

    if (ui.chatModeBadge) {
        ui.chatModeBadge.textContent = mode.badge;
        ui.chatModeBadge.className = currentChatMode === 'agent'
            ? 'ml-2 inline-flex items-center rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-200'
            : 'ml-2 inline-flex items-center rounded-full border border-sky-400/20 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-200';
    }

    if (ui.userInput) {
        ui.userInput.placeholder = mode.placeholder;
    }

    if (ui.sendBtn) {
        ui.sendBtn.title = mode.sendTitle;
    }

    if (typeof renderSidebarContent === 'function') {
        renderSidebarContent();
    }
}

function setChatMode(mode, { persist = true } = {}) {
    const nextMode = normalizeChatMode(mode);
    const previousMode = currentChatMode;
    currentChatMode = nextMode;

    if (persist) {
        try {
            window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, currentChatMode);
        } catch (error) {
            console.warn('Unable to persist chat mode', error);
        }
    }

    renderChatMode();

    if (previousMode !== nextMode && typeof window.handleChatModeChanged === 'function') {
        Promise.resolve(window.handleChatModeChanged(nextMode)).catch((error) => {
            console.error('Failed to switch chat mode context:', error);
        });
    }
}

function initializeChatMode() {
    let savedMode = 'ask';
    const initialMode = currentChatMode;

    try {
        savedMode = window.localStorage.getItem(CHAT_MODE_STORAGE_KEY) || 'ask';
    } catch (error) {
        console.warn('Unable to read chat mode', error);
    }

    setChatMode(savedMode, { persist: false });
    if (normalizeChatMode(savedMode) === normalizeChatMode(initialMode) && typeof window.handleChatModeChanged === 'function') {
        Promise.resolve(window.handleChatModeChanged(currentChatMode)).catch((error) => {
            console.error('Failed to initialize chat mode context:', error);
        });
    }
}

function initializeWebSearchState() {
    let savedState = false;

    try {
        savedState = window.localStorage.getItem(WEB_SEARCH_STORAGE_KEY) === 'true';
    } catch (error) {
        console.warn('Unable to read web search mode', error);
    }

    webSearchEnabled = savedState;
}

function initializeSpeechMode() {
    speechMode = 'backend';

    try {
        window.localStorage.removeItem(SPEECH_MODE_STORAGE_KEY);
    } catch (error) {
        console.warn('Unable to reset speech mode', error);
    }
}

function persistSpeechMode(nextMode) {
    speechMode = nextMode === 'embedded' ? 'embedded' : 'backend';
    try {
        window.localStorage.setItem(SPEECH_MODE_STORAGE_KEY, speechMode);
    } catch (error) {
        console.warn('Unable to persist speech mode', error);
    }
}

function toggleChatMode(mode, event) {
    if (event) {
        event.stopPropagation();
    }

    setChatMode(mode);
}

function createLocalAttachmentId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatAttachmentSize(bytes = 0) {
    const size = Number(bytes) || 0;
    if (size < 1024) {
        return `${size} B`;
    }
    if (size < 1024 * 1024) {
        return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function refreshComposerState() {
    if (!ui?.sendBtn || !ui?.userInput) {
        return;
    }

    const hasText = Boolean(ui.userInput.value.trim());
    const hasAttachments = pendingAttachments.length > 0;
    ui.sendBtn.disabled = isTyping || isUploadingAttachments || isSpeechTranscribing || (!hasText && !hasAttachments);
}

function renderSpeechRecognitionState() {
    if (!ui?.speechBtn) {
        return;
    }

    if (!isSpeechCaptureSupported && !isEmbeddedSpeechSupported) {
        ui.speechBtn.disabled = true;
        ui.speechBtn.title = '当前桌面环境不支持录音转文字';
        ui.speechBtn.className = 'p-2 rounded-full text-gray-600 transition-colors cursor-not-allowed opacity-50';
        return;
    }

    ui.speechBtn.disabled = isSpeechTranscribing;
    ui.speechBtn.title = isSpeechTranscribing
        ? '正在转写语音'
        : (isSpeechListening ? '停止录音并转文字' : '语音转文字');
    ui.speechBtn.className = isSpeechListening
        ? 'p-2 rounded-full text-red-300 bg-red-500/10 hover:bg-red-500/15 transition-colors'
        : isSpeechTranscribing
            ? 'p-2 rounded-full text-emerald-200 bg-emerald-500/10 transition-colors opacity-80'
            : 'p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/5 transition-colors';
}

function mergeSpeechText(baseText, transcript, separator = ' ') {
    const base = String(baseText || '');
    const next = String(transcript || '').trim();

    if (!base) {
        return next;
    }

    if (!next) {
        return base;
    }

    return `${base}${separator}${next}`.trim();
}

function appendSpeechTranscript(transcript = '') {
    if (!ui?.userInput) {
        return;
    }

    ui.userInput.value = mergeSpeechText(ui.userInput.value, transcript);
    autoResizeUserInput();
    refreshComposerState();
}

function cleanupSpeechStream() {
    if (speechMediaStream) {
        speechMediaStream.getTracks().forEach((track) => track.stop());
        speechMediaStream = null;
    }
}

function cleanupSpeechNodes() {
    if (speechProcessorNode) {
        speechProcessorNode.onaudioprocess = null;
        speechProcessorNode.disconnect();
        speechProcessorNode = null;
    }

    if (speechSourceNode) {
        speechSourceNode.disconnect();
        speechSourceNode = null;
    }

    if (speechMonitorNode) {
        speechMonitorNode.disconnect();
        speechMonitorNode = null;
    }

    if (speechAudioContext) {
        const currentContext = speechAudioContext;
        speechAudioContext = null;
        currentContext.close().catch(() => {});
    }
}

function resetSpeechCaptureBuffers() {
    speechPcmChunks = [];
    speechInputSampleRate = SPEECH_TARGET_SAMPLE_RATE;
}

function cleanupSpeechCapture() {
    cleanupSpeechNodes();
    cleanupSpeechStream();
}

function mergeFloat32Chunks(chunks = []) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;

    chunks.forEach((chunk) => {
        merged.set(chunk, offset);
        offset += chunk.length;
    });

    return merged;
}

function downsamplePcmBuffer(buffer, inputSampleRate, targetSampleRate) {
    if (!buffer.length || inputSampleRate <= targetSampleRate) {
        return buffer;
    }

    const ratio = inputSampleRate / targetSampleRate;
    const resultLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(resultLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < resultLength) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
        let accumulator = 0;
        let count = 0;

        for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
            accumulator += buffer[index];
            count += 1;
        }

        result[offsetResult] = count > 0 ? accumulator / count : 0;
        offsetResult += 1;
        offsetBuffer = nextOffsetBuffer;
    }

    return result;
}

function encodePcm16ToWav(float32Buffer, sampleRate) {
    const dataLength = float32Buffer.length * 2;
    const wavBuffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(wavBuffer);
    const safeSampleRate = Number(sampleRate) || SPEECH_TARGET_SAMPLE_RATE;

    function writeAscii(offset, text) {
        for (let index = 0; index < text.length; index += 1) {
            view.setUint8(offset + index, text.charCodeAt(index));
        }
    }

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, safeSampleRate, true);
    view.setUint32(28, safeSampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let index = 0; index < float32Buffer.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, float32Buffer[index]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
    }

    return new Blob([wavBuffer], { type: 'audio/wav' });
}

function buildSpeechWavBlob() {
    const merged = mergeFloat32Chunks(speechPcmChunks);
    if (!merged.length) {
        return null;
    }

    const normalized = speechInputSampleRate > SPEECH_TARGET_SAMPLE_RATE
        ? downsamplePcmBuffer(merged, speechInputSampleRate, SPEECH_TARGET_SAMPLE_RATE)
        : merged;

    return encodePcm16ToWav(normalized, SPEECH_TARGET_SAMPLE_RATE);
}

async function finalizeBackendSpeechCapture() {
    const audioBlob = buildSpeechWavBlob();
    resetSpeechCaptureBuffers();
    cleanupSpeechCapture();

    if (!audioBlob || audioBlob.size === 0) {
        renderSpeechRecognitionState();
        refreshComposerState();
        return;
    }

    isSpeechTranscribing = true;
    renderSpeechRecognitionState();
    refreshComposerState();

    try {
        const transcript = await transcribeSpeechBlob(audioBlob);
        if (transcript) {
            appendSpeechTranscript(transcript);
        } else {
            appAlert('没有识别到清晰语音，请再试一次。');
        }
    } catch (error) {
        appAlert(`语音转文字失败：${error.message}`);
    } finally {
        isSpeechTranscribing = false;
        renderSpeechRecognitionState();
        refreshComposerState();
    }
}

function stopSpeechToText() {
    if (speechMode === 'embedded' && embeddedSpeechRecognition && isSpeechListening) {
        embeddedSpeechRecognition.stop();
        return;
    }

    if (!isSpeechListening) {
        cleanupSpeechCapture();
        resetSpeechCaptureBuffers();
        renderSpeechRecognitionState();
        refreshComposerState();
        return;
    }

    isSpeechListening = false;
    renderSpeechRecognitionState();
    refreshComposerState();
    finalizeBackendSpeechCapture().catch((error) => {
        console.error('Failed to finalize speech capture', error);
        cleanupSpeechStream();
        resetSpeechCaptureBuffers();
        isSpeechTranscribing = false;
        renderSpeechRecognitionState();
        refreshComposerState();
        appAlert(`语音转文字失败：${error.message}`);
    });
}

function initializeSpeechToText() {
    initializeSpeechMode();

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    isSpeechCaptureSupported = Boolean(
        AudioContextCtor
        && navigator.mediaDevices
        && typeof navigator.mediaDevices.getUserMedia === 'function'
    );

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognitionCtor) {
        isEmbeddedSpeechSupported = true;
        embeddedSpeechRecognition = new SpeechRecognitionCtor();
        embeddedSpeechRecognition.lang = 'zh-CN';
        embeddedSpeechRecognition.continuous = true;
        embeddedSpeechRecognition.interimResults = true;
        embeddedSpeechRecognition.maxAlternatives = 1;

        let embeddedBaseText = '';
        let embeddedCommittedText = '';

        embeddedSpeechRecognition.onstart = () => {
            isSpeechListening = true;
            embeddedBaseText = String(ui?.userInput?.value || '').trim();
            embeddedCommittedText = '';
            renderSpeechRecognitionState();
            refreshComposerState();
        };

        embeddedSpeechRecognition.onresult = (event) => {
            let interimText = '';

            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const transcript = String(event.results[index]?.[0]?.transcript || '').trim();
                if (!transcript) {
                    continue;
                }

                if (event.results[index].isFinal) {
                    embeddedCommittedText = mergeSpeechText(embeddedCommittedText, transcript);
                } else {
                    interimText = mergeSpeechText(interimText, transcript);
                }
            }

            ui.userInput.value = mergeSpeechText(embeddedBaseText, mergeSpeechText(embeddedCommittedText, interimText));
            autoResizeUserInput();
            refreshComposerState();
        };

        embeddedSpeechRecognition.onerror = (event) => {
            isSpeechListening = false;
            renderSpeechRecognitionState();
            refreshComposerState();

            if (!event?.error || event.error === 'no-speech' || event.error === 'aborted') {
                return;
            }

            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                appAlert('语音转文字权限被拒绝，请允许应用访问麦克风。');
                return;
            }

            appAlert(`语音转文字失败：${event.error}`);
        };

        embeddedSpeechRecognition.onend = () => {
            isSpeechListening = false;
            ui.userInput.value = mergeSpeechText(embeddedBaseText, embeddedCommittedText);
            autoResizeUserInput();
            renderSpeechRecognitionState();
            refreshComposerState();
        };
    }

    if (speechMode === 'embedded' && !isEmbeddedSpeechSupported) {
        speechMode = 'backend';
    }

    if (speechMode === 'backend' && !isSpeechCaptureSupported && isEmbeddedSpeechSupported) {
        speechMode = 'embedded';
    }

    renderSpeechRecognitionState();
}

async function transcribeSpeechBlob(blob) {
    const formData = new FormData();
    formData.append('audio', blob, 'speech.wav');
    formData.append('language', 'zh');

    const activeModel = typeof getActiveModel === 'function' ? getActiveModel() : null;
    if (activeModel?.id) {
        formData.append('model_config_id', activeModel.id);
    }

    const response = await apiRequest('/api/speech/transcribe', {
        method: 'POST',
        body: formData,
    });
    const result = await readJsonSafe(response);
    if (!response.ok || !result) {
        throw new Error(result?.detail || `HTTP ${response.status}`);
    }

    return String(result.text || '').trim();
}

function isUnsupportedSpeechBackendError(message = '') {
    return /does not support audio transcription|not support audio transcription|当前模型服务不支持音频转写/i.test(String(message || ''));
}

function startEmbeddedSpeechToText() {
    if (!isEmbeddedSpeechSupported || !embeddedSpeechRecognition) {
        appAlert('当前环境没有可用的内置语音识别。');
        return;
    }

    try {
        embeddedSpeechRecognition.start();
    } catch (error) {
        appAlert(`无法启动内置语音识别：${error.message}`);
    }
}

function toggleSpeechToText(event) {
    if (event) {
        event.stopPropagation();
    }

    if (!isSpeechCaptureSupported && !isEmbeddedSpeechSupported) {
        appAlert('当前桌面环境不支持录音转文字。');
        return;
    }

    if (isSpeechTranscribing) {
        return;
    }

    if (isSpeechListening) {
        stopSpeechToText();
        return;
    }

    if (speechMode === 'embedded') {
        startEmbeddedSpeechToText();
        return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
    }).then(async (stream) => {
        speechMediaStream = stream;
        resetSpeechCaptureBuffers();

        speechAudioContext = new AudioContextCtor();
        speechInputSampleRate = speechAudioContext.sampleRate || SPEECH_TARGET_SAMPLE_RATE;

        if (speechAudioContext.state === 'suspended') {
            await speechAudioContext.resume();
        }

        speechSourceNode = speechAudioContext.createMediaStreamSource(stream);
        speechProcessorNode = speechAudioContext.createScriptProcessor(4096, 1, 1);
        speechMonitorNode = speechAudioContext.createGain();
        speechMonitorNode.gain.value = 0;

        speechProcessorNode.onaudioprocess = (audioEvent) => {
            if (!isSpeechListening) {
                return;
            }

            const channelData = audioEvent.inputBuffer.getChannelData(0);
            speechPcmChunks.push(new Float32Array(channelData));
        };

        speechSourceNode.connect(speechProcessorNode);
        speechProcessorNode.connect(speechMonitorNode);
        speechMonitorNode.connect(speechAudioContext.destination);

        isSpeechListening = true;
        renderSpeechRecognitionState();
        refreshComposerState();
    }).catch((error) => {
        appAlert(`无法访问麦克风：${error.message}`);
        cleanupSpeechCapture();
        resetSpeechCaptureBuffers();
        isSpeechListening = false;
        renderSpeechRecognitionState();
        refreshComposerState();
    });
}

function getPendingAttachmentsHost() {
    return document.getElementById('pending-attachments');
}

function renderPendingAttachments() {
    const host = getPendingAttachmentsHost();
    if (!host) {
        refreshComposerState();
        return;
    }

    host.replaceChildren();

    if (pendingAttachments.length === 0) {
        host.classList.add('hidden');
        refreshComposerState();
        return;
    }

    host.classList.remove('hidden');

    pendingAttachments.forEach((attachment) => {
        const item = document.createElement('div');
        item.className = attachment.file_type === 'image'
            ? 'group relative overflow-hidden rounded-2xl border border-white/10 bg-[#171717]'
            : 'group flex items-center gap-3 rounded-2xl border border-white/10 bg-[#171717] px-3 py-2 text-sm text-gray-200';

        if (attachment.file_type === 'image') {
            const image = document.createElement('img');
            image.src = attachment.content || attachment.data || '';
            image.alt = attachment.filename || 'image';
            image.className = 'h-20 w-20 object-cover';
            item.appendChild(image);

            const overlay = document.createElement('div');
            overlay.className = 'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-2 pt-5 text-xs text-white';

            const name = document.createElement('div');
            name.className = 'truncate';
            name.textContent = attachment.filename || 'image';
            overlay.appendChild(name);

            const size = document.createElement('div');
            size.className = 'mt-0.5 text-[10px] text-white/70';
            size.textContent = formatAttachmentSize(attachment.size_bytes);
            overlay.appendChild(size);

            item.appendChild(overlay);
        } else {
            const icon = document.createElement('div');
            icon.className = 'flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-gray-400';
            icon.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
            `;
            item.appendChild(icon);

            const meta = document.createElement('div');
            meta.className = 'min-w-0';

            const name = document.createElement('div');
            name.className = 'truncate font-medium text-white';
            name.textContent = attachment.filename || 'document';
            meta.appendChild(name);

            const size = document.createElement('div');
            size.className = 'mt-0.5 text-xs text-gray-500';
            size.textContent = formatAttachmentSize(attachment.size_bytes);
            meta.appendChild(size);

            item.appendChild(meta);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = attachment.file_type === 'image'
            ? 'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75'
            : 'ml-1 flex h-7 w-7 items-center justify-center rounded-full text-gray-500 transition hover:bg-white/5 hover:text-white';
        remove.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18M6 6l12 12"></path>
            </svg>
        `;
        remove.onclick = (event) => removePendingAttachment(attachment.id, event);
        item.appendChild(remove);

        host.appendChild(item);
    });

    refreshComposerState();
}

function removePendingAttachment(id, event) {
    if (event) {
        event.stopPropagation();
    }

    pendingAttachments = pendingAttachments.filter((attachment) => attachment.id !== id);
    renderPendingAttachments();
}

function clearPendingAttachments() {
    pendingAttachments = [];

    const fileInput = document.getElementById('attach-file-input');
    const imageInput = document.getElementById('attach-image-input');
    if (fileInput) {
        fileInput.value = '';
    }
    if (imageInput) {
        imageInput.value = '';
    }

    renderPendingAttachments();
}

function openDocumentPicker(event) {
    if (event) {
        event.stopPropagation();
    }

    closeAllMenus();
    document.getElementById('attach-file-input')?.click();
}

function openImagePicker(event) {
    if (event) {
        event.stopPropagation();
    }

    closeAllMenus();
    document.getElementById('attach-image-input')?.click();
}

async function uploadAttachmentFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await apiRequest('/api/upload', {
        method: 'POST',
        body: formData,
    });

    const result = await readJsonSafe(response);
    if (!response.ok || !result) {
        throw new Error(result?.detail || `HTTP ${response.status}`);
    }

    return {
        id: createLocalAttachmentId(),
        filename: result.filename || file.name,
        file_type: result.file_type || (file.type.startsWith('image/') ? 'image' : 'document'),
        content: result.content,
        data: result.content,
        size_bytes: result.size_bytes || file.size || 0,
    };
}

async function handleAttachmentInputChange(event) {
    const files = Array.from(event?.target?.files || []);
    if (event?.target) {
        event.target.value = '';
    }

    if (files.length === 0) {
        return;
    }

    isUploadingAttachments = true;
    refreshComposerState();

    try {
        for (const file of files) {
            const uploaded = await uploadAttachmentFile(file);
            pendingAttachments.push(uploaded);
        }
        renderPendingAttachments();
    } catch (error) {
        appAlert(`附件上传失败：${error.message}`);
    } finally {
        isUploadingAttachments = false;
        refreshComposerState();
    }
}

function initializeAttachmentInputs() {
    const fileInput = document.getElementById('attach-file-input');
    const imageInput = document.getElementById('attach-image-input');

    if (fileInput && !fileInput.dataset.bound) {
        fileInput.addEventListener('change', handleAttachmentInputChange);
        fileInput.dataset.bound = 'true';
    }

    if (imageInput && !imageInput.dataset.bound) {
        imageInput.addEventListener('change', handleAttachmentInputChange);
        imageInput.dataset.bound = 'true';
    }

    renderPendingAttachments();
}

function appendAttachmentsToMessageGroup(messageGroup, attachments = [], text = '') {
    if (!messageGroup || !Array.isArray(attachments) || attachments.length === 0) {
        return;
    }

    messageGroup.dataset.hasAttachments = 'true';

    const shell = messageGroup.querySelector('div.flex.flex-col.items-end.gap-1');
    const contentDiv = messageGroup.querySelector('.message-content');
    if (!shell) {
        return;
    }

    if (!text && contentDiv) {
        contentDiv.classList.add('hidden');
    }

    const wrap = document.createElement('div');
    wrap.className = 'message-attachments mb-2 flex max-w-[90%] flex-wrap justify-end gap-2';

    attachments.forEach((attachment) => {
        if (attachment.file_type === 'image') {
            const imageCard = document.createElement('div');
            imageCard.className = 'overflow-hidden rounded-2xl border border-white/10 bg-[#171717]';

            const image = document.createElement('img');
            image.src = attachment.content || attachment.data || '';
            image.alt = attachment.filename || 'image';
            image.className = 'h-24 w-24 object-cover';
            imageCard.appendChild(image);

            wrap.appendChild(imageCard);
            return;
        }

        const docCard = document.createElement('div');
        docCard.className = 'flex max-w-[260px] items-center gap-3 rounded-2xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-left text-sm text-white';
        docCard.innerHTML = `
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-gray-300">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
            </div>
            <div class="min-w-0">
                <div class="truncate font-medium">${escapeHtmlFragment(attachment.filename || 'document')}</div>
                <div class="mt-0.5 text-xs text-gray-400">${formatAttachmentSize(attachment.size_bytes)}</div>
            </div>
        `;
        wrap.appendChild(docCard);
    });

    shell.insertBefore(wrap, contentDiv || shell.firstChild);
}

function getWebSearchElements() {
    return {
        button: document.getElementById('web-search-toggle'),
        dot: document.getElementById('web-search-dot'),
        label: document.getElementById('web-search-label'),
        status: document.getElementById('web-search-status'),
    };
}

function setWebSearchStatus(message = '', tone = 'muted') {
    const { status } = getWebSearchElements();
    if (!status) {
        return;
    }

    const toneClasses = {
        muted: 'text-gray-500',
        pending: 'text-sky-300',
        success: 'text-emerald-300',
        warning: 'text-amber-300',
        error: 'text-red-300',
    };

    status.textContent = message;
    status.className = `text-xs ${toneClasses[tone] || toneClasses.muted}`;
    status.classList.toggle('hidden', !message);
}

function formatSearchSources(results = []) {
    if (!Array.isArray(results) || results.length === 0) {
        return '';
    }

    const sources = results
        .map((result) => result.source)
        .filter(Boolean)
        .filter((source, index, list) => list.indexOf(source) === index)
        .slice(0, 3);

    return sources.length > 0 ? `（${sources.join('、')}）` : '';
}

function renderWebSearchState() {
    const { button, dot, label, status } = getWebSearchElements();
    if (!button || !dot || !label) {
        return;
    }

    button.setAttribute('aria-pressed', webSearchEnabled ? 'true' : 'false');
    button.className = webSearchEnabled
        ? 'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all cursor-pointer bg-[#123b33] text-emerald-200 border border-emerald-400/30 shadow-sm'
        : 'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all cursor-pointer bg-transparent text-gray-500 hover:bg-white/5 border border-transparent';
    dot.className = `w-1.5 h-1.5 rounded-full ${webSearchEnabled ? 'bg-[#10b981]' : 'bg-gray-600'}`;
    label.textContent = webSearchEnabled ? '联网搜索已开' : '联网搜索';

    if (!webSearchEnabled && status) {
        status.textContent = '';
        status.classList.add('hidden');
    }
}

function toggleWebSearch(event) {
    if (event) {
        event.stopPropagation();
    }

    webSearchEnabled = !webSearchEnabled;
    try {
        window.localStorage.setItem(WEB_SEARCH_STORAGE_KEY, webSearchEnabled ? 'true' : 'false');
    } catch (error) {
        console.warn('Unable to persist web search mode', error);
    }
    renderWebSearchState();
    if (webSearchEnabled) {
        setWebSearchStatus('发送前会先尝试联网搜索。', 'success');
    }
}

function handleWebSearchStatus(chunk, target) {
    if (!chunk || chunk.type !== 'status') {
        return;
    }

    if (chunk.status === 'searching') {
        setWebSearchStatus(chunk.message || '正在联网搜索...', 'pending');
        renderWebSearchPanel(target, [], 'searching');
        return;
    }

    if (chunk.status === 'search_skipped') {
        setWebSearchStatus(chunk.message || '模型判断无需联网，将直接回答', 'muted');
        removeWebSearchPanel(target);
        return;
    }

    if (chunk.status === 'search_done') {
        const count = Array.isArray(chunk.results) ? chunk.results.length : 0;
        setWebSearchStatus(count > 0 ? `已找到 ${count} 条联网结果${formatSearchSources(chunk.results)}` : '联网搜索已完成。', 'success');
        renderWebSearchPanel(target, chunk.results || [], 'done');
        return;
    }

    if (chunk.status === 'search_empty') {
        setWebSearchStatus('当前搜索服务没有返回可解析结果，将直接回答。', 'warning');
        renderWebSearchPanel(target, [], 'empty');
        return;
    }

    if (chunk.status === 'search_failed') {
        setWebSearchStatus(chunk.message || '联网搜索失败，将直接回答', 'error');
        renderWebSearchPanel(target, [], 'failed');
    }
}

function removeWebSearchPanel(target) {
    const group = target?.closest('.message-group');
    const panel = group?.querySelector('.web-search-results');
    if (panel) {
        panel.remove();
    }
}

function buildWebSearchSummary(results = [], state = 'searching') {
    if (state === 'searching') {
        return '正在联网搜索';
    }

    if (state === 'failed') {
        return '搜索失败，已回退到直接回答';
    }

    if (!Array.isArray(results) || results.length === 0) {
        return '暂无可展开的搜索结果';
    }

    const sources = results
        .map((result) => result.source)
        .filter(Boolean)
        .filter((source, index, list) => list.indexOf(source) === index)
        .slice(0, 3);

    const sourceText = sources.length > 0 ? ` · ${sources.join('、')}` : '';
    return `${results.length} 条结果${sourceText}`;
}

function buildWebSearchIcon(state = 'done') {
    const colorClass = state === 'failed'
        ? 'text-amber-300'
        : state === 'searching'
            ? 'text-emerald-200'
            : 'text-emerald-300';
    const spinClass = state === 'searching' ? ' animate-spin' : '';

    return `
        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 ${colorClass}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${spinClass.trim()}">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M2 12h20"></path>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
        </span>
    `;
}

function renderWebSearchPanel(target, results = [], state = 'searching', options = {}) {
    const group = target?.closest('.message-group');
    const host = target?.parentElement;
    if (!group || !host || !target) {
        return;
    }

    let panel = group.querySelector('.web-search-results');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'web-search-results mb-3 w-full max-w-full rounded-2xl border border-emerald-400/20 bg-emerald-500/5 p-2 text-sm text-gray-300 shadow-sm';
        host.insertBefore(panel, target);
    }

    if (options.preserveExpanded !== true) {
        panel.dataset.expanded = 'false';
    }

    const expanded = panel.dataset.expanded === 'true' && state !== 'searching';
    panel.replaceChildren();

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition hover:bg-white/5';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.innerHTML = `
        ${buildWebSearchIcon(state)}
        <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium text-emerald-200">${state === 'searching' ? '联网搜索中' : '联网来源'}</div>
            <div class="truncate text-xs text-gray-400">${buildWebSearchSummary(results, state)}</div>
        </div>
        <div class="shrink-0 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6"></path>
            </svg>
        </div>
    `;
    panel.appendChild(toggle);

    const details = document.createElement('div');
    details.className = expanded ? 'mt-2' : 'mt-2 hidden';
    panel.appendChild(details);

    toggle.addEventListener('click', () => {
        const nextExpanded = panel.dataset.expanded !== 'true';
        panel.dataset.expanded = nextExpanded ? 'true' : 'false';
        renderWebSearchPanel(target, results, state, { preserveExpanded: true });
    });

    if (state === 'searching') {
        panel.dataset.expanded = 'false';
        return;
    }

    if (!Array.isArray(results) || results.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-xs text-amber-300';
        empty.textContent = state === 'failed' ? '联网搜索失败，本次将直接回答。' : '当前搜索服务没有返回可解析结果，本次将直接回答。';
        details.appendChild(empty);
        return;
    }

    const list = document.createElement('div');
    list.className = 'flex flex-col gap-2';

    results.forEach((result, index) => {
        const item = document.createElement('div');
        item.className = 'rounded-xl border border-white/10 bg-black/15 px-3 py-2';

        const title = document.createElement(result.url ? 'a' : 'div');
        title.className = `block truncate text-sm font-medium ${result.url ? 'text-sky-300 hover:underline' : 'text-emerald-200'}`;
        if (result.url) {
            title.href = result.url;
            title.target = '_blank';
            title.rel = 'noreferrer';
        }
        title.textContent = `${index + 1}. ${result.title || result.url || '搜索结果'}`;
        item.appendChild(title);

        const source = document.createElement('div');
        source.className = 'mt-0.5 truncate text-[11px] text-gray-500';
        source.textContent = result.source || result.url || '';
        item.appendChild(source);

        if (result.snippet) {
            const snippet = document.createElement('div');
            snippet.className = 'mt-1 line-clamp-2 text-xs leading-relaxed text-gray-400';
            snippet.textContent = result.snippet;
            item.appendChild(snippet);
        }

        list.appendChild(item);
    });

    panel.appendChild(list);
}

const AGENT_STAGE_META = [
    { key: 'analysis', title: '分析用户问题' },
    { key: 'prompt_refinement', title: '优化用户提示词' },
    { key: 'solution_plan', title: '制定解决方案' },
    { key: 'solution_evaluation', title: '评估解决方案' },
    { key: 'execution', title: '按方案执行' },
    { key: 'step_validation', title: '执行一步验证一步' },
    { key: 'final_validation', title: '总验证' },
    { key: 'final_report', title: '输出汇报性结论' },
];
const agentTimelineState = new Map();
let agentProjectRefreshTimer = null;

function scheduleAgentProjectRefresh() {
    if (typeof loadAgentProject !== 'function') {
        return;
    }

    if (agentProjectRefreshTimer) {
        window.clearTimeout(agentProjectRefreshTimer);
    }

    agentProjectRefreshTimer = window.setTimeout(() => {
        agentProjectRefreshTimer = null;
        Promise.resolve(loadAgentProject()).catch((error) => {
            console.error('Failed to refresh agent project tree:', error);
        });
    }, 250);
}

function toolCallMayChangeProject(toolName = '') {
    const normalized = String(toolName || '').trim();
    return [
        'project.write_file',
        'project.edit_file',
        'project.delete_path',
        'shell.run',
    ].includes(normalized);
}

function createEmptyAgentRunState(seed = {}) {
    return {
        runId: seed.run_id || seed.id || '',
        assistantMessageId: seed.assistant_message_id || '',
        status: seed.status || 'pending',
        projectDirty: false,
        changedPaths: [],
        workingDirectory: '',
        stages: AGENT_STAGE_META.map((meta, index) => ({
            key: meta.key,
            title: meta.title,
            index: index + 1,
            status: 'pending',
            summary: '',
            data: null,
            toolCalls: [],
            validations: [],
            expanded: false,
        })),
    };
}

function ensureAgentStages(state) {
    if (!state || !Array.isArray(state.stages) || state.stages.length === 0) {
        if (state) {
            state.stages = AGENT_STAGE_META.map((meta, index) => ({
                key: meta.key,
                title: meta.title,
                index: index + 1,
                status: 'pending',
                summary: '',
                data: null,
                toolCalls: [],
                validations: [],
                expanded: false,
            }));
        }
        return;
    }

    AGENT_STAGE_META.forEach((meta, index) => {
        const existing = state.stages.find((item) => item.key === meta.key);
        if (!existing) {
            state.stages.push({
                key: meta.key,
                title: meta.title,
                index: index + 1,
                status: 'pending',
                summary: '',
                data: null,
                toolCalls: [],
                validations: [],
                expanded: false,
            });
        } else {
            existing.title = existing.title || meta.title;
            existing.index = existing.index || index + 1;
            existing.toolCalls = Array.isArray(existing.toolCalls) ? existing.toolCalls : [];
            existing.validations = Array.isArray(existing.validations) ? existing.validations : [];
        }
    });

    state.stages.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
}

function getAgentRunState(target, seed = {}) {
    const key = target?.id;
    if (!key) {
        return createEmptyAgentRunState(seed);
    }

    if (!agentTimelineState.has(key)) {
        agentTimelineState.set(key, createEmptyAgentRunState(seed));
    }

    const state = agentTimelineState.get(key);
    if (seed.run_id || seed.id) {
        state.runId = seed.run_id || seed.id;
    }
    if (seed.assistant_message_id) {
        state.assistantMessageId = seed.assistant_message_id;
    }
    if (seed.status) {
        state.status = seed.status;
    }
    if (Array.isArray(seed.changed_paths)) {
        state.changedPaths = Array.from(new Set(seed.changed_paths.filter(Boolean)));
    }
    if (seed.working_directory) {
        state.workingDirectory = seed.working_directory;
    }
    ensureAgentStages(state);
    return state;
}

function collectStageChangedPaths(stage) {
    const fromTools = Array.isArray(stage?.toolCalls)
        ? stage.toolCalls.flatMap((toolCall) => {
            if (Array.isArray(toolCall?.changed_paths)) {
                return toolCall.changed_paths;
            }
            if (Array.isArray(toolCall?.output_json?.changed_paths)) {
                return toolCall.output_json.changed_paths;
            }
            return [];
        })
        : [];
    return fromTools.filter(Boolean);
}

function collectRunChangedPaths(state) {
    const direct = Array.isArray(state?.changedPaths) ? state.changedPaths : [];
    const fromStages = Array.isArray(state?.stages)
        ? state.stages.flatMap((stage) => collectStageChangedPaths(stage))
        : [];
    return Array.from(new Set([...direct, ...fromStages].filter(Boolean)));
}

function jumpToAgentProjectPath(targetPath) {
    if (!targetPath) {
        return;
    }

    if (currentChatMode !== 'agent') {
        setChatMode('agent');
    }

    if (typeof window.focusAgentProjectPath === 'function') {
        window.focusAgentProjectPath(targetPath);
    }
}

function ensureAgentTimelineShell(target, seed = {}) {
    const group = target?.closest('.message-group');
    const host = target?.parentElement;
    if (!group || !host || !target) {
        return null;
    }

    let shell = group.querySelector('.agent-run-timeline');
    if (!shell) {
        shell = document.createElement('div');
        shell.className = 'agent-run-timeline mb-3 w-full max-w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 shadow-sm';
        host.insertBefore(shell, target);
    }

    getAgentRunState(target, seed);
    return shell;
}

function agentStatusLabel(status = 'pending') {
    const normalized = String(status || 'pending').toLowerCase();
    if (normalized === 'running') {
        return '执行中';
    }
    if (normalized === 'completed') {
        return '已完成';
    }
    if (normalized === 'failed') {
        return '失败';
    }
    return '待处理';
}

function agentStatusBadgeClass(status = 'pending') {
    const normalized = String(status || 'pending').toLowerCase();
    if (normalized === 'running') {
        return 'border-sky-400/25 bg-sky-500/10 text-sky-200';
    }
    if (normalized === 'completed') {
        return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200';
    }
    if (normalized === 'failed') {
        return 'border-red-400/25 bg-red-500/10 text-red-200';
    }
    return 'border-white/10 bg-white/[0.04] text-gray-400';
}

function stageNodeClass(status = 'pending') {
    const normalized = String(status || 'pending').toLowerCase();
    if (normalized === 'running') {
        return 'border-sky-400/60 bg-sky-400/20 text-sky-200';
    }
    if (normalized === 'passed' || normalized === 'completed') {
        return 'border-emerald-400/60 bg-emerald-400/20 text-emerald-200';
    }
    if (normalized === 'failed') {
        return 'border-red-400/60 bg-red-400/20 text-red-200';
    }
    if (normalized === 'skipped') {
        return 'border-amber-400/40 bg-amber-400/10 text-amber-200';
    }
    return 'border-white/10 bg-white/[0.03] text-gray-500';
}

function normalizeStageStatus(status = 'pending') {
    const normalized = String(status || 'pending').toLowerCase();
    if (normalized === 'completed') {
        return 'passed';
    }
    return normalized;
}

function toAgentObject(value) {
    if (!value) {
        return null;
    }
    if (typeof value === 'object') {
        return value;
    }
    try {
        return JSON.parse(String(value));
    } catch {
        return null;
    }
}

function formatAgentDetailsBlock(text) {
    return `<div class="text-xs leading-6 whitespace-pre-wrap text-gray-300">${escapeHtmlFragment(truncateText(text, 1200))}</div>`;
}

function formatAgentStageData(stage) {
    const data = toAgentObject(stage?.data);
    if (!data || typeof data !== 'object') {
        return '';
    }

    if (stage.key === 'analysis') {
        return [
            data.goal ? `目标: ${data.goal}` : '',
            Array.isArray(data.success_criteria) && data.success_criteria.length ? `成功标准: ${data.success_criteria.join('；')}` : '',
            Array.isArray(data.constraints) && data.constraints.length ? `约束: ${data.constraints.join('；')}` : '',
            Array.isArray(data.risks) && data.risks.length ? `风险: ${data.risks.join('；')}` : '',
        ].filter(Boolean).join('\n');
    }

    if (stage.key === 'prompt_refinement') {
        return [
            data.refined_request ? `优化后任务: ${data.refined_request}` : '',
            Array.isArray(data.execution_brief) && data.execution_brief.length ? `执行重点: ${data.execution_brief.join('；')}` : '',
            Array.isArray(data.verification_focus) && data.verification_focus.length ? `验证重点: ${data.verification_focus.join('；')}` : '',
        ].filter(Boolean).join('\n');
    }

    if (stage.key === 'solution_plan') {
        const steps = Array.isArray(data.steps) ? data.steps : [];
        const lines = [
            data.objective ? `目标: ${data.objective}` : '',
            data.task_type ? `任务类型: ${data.task_type}` : '',
        ].filter(Boolean);
        steps.forEach((step, index) => {
            const files = Array.isArray(step.target_files) && step.target_files.length ? ` -> ${step.target_files.join(', ')}` : '';
            lines.push(`${index + 1}. ${step.title || '未命名步骤'}${files}`);
        });
        return lines.join('\n');
    }

    if (stage.key === 'solution_evaluation') {
        const metrics = data.metrics && typeof data.metrics === 'object' ? Object.entries(data.metrics) : [];
        const lines = [
            data.decision ? `结论: ${data.decision}` : '',
            Number.isFinite(Number(data.overall_score)) ? `总分: ${Number(data.overall_score)}` : '',
            Array.isArray(data.blocking_issues) && data.blocking_issues.length ? `阻断项: ${data.blocking_issues.join('；')}` : '',
        ].filter(Boolean);
        metrics.slice(0, 7).forEach(([key, metric]) => {
            if (!metric || typeof metric !== 'object') {
                return;
            }
            lines.push(`${key}: ${Number(metric.score || 0)} 分${metric.rationale ? ` - ${metric.rationale}` : ''}`);
        });
        return lines.join('\n');
    }

    if (stage.key === 'execution') {
        const steps = Array.isArray(data.steps) ? data.steps : [];
        return steps.map((step) => {
            const changed = Array.isArray(step.changed_paths) && step.changed_paths.length ? ` | 改动: ${step.changed_paths.join(', ')}` : '';
            return `${step.step_index}. ${step.title} - ${step.status}${changed}`;
        }).join('\n');
    }

    if (stage.key === 'final_validation') {
        const checks = Array.isArray(data.checks) ? data.checks : [];
        const lines = [
            data.status ? `状态: ${data.status}` : '',
            Array.isArray(data.blocking_issues) && data.blocking_issues.length ? `阻断项: ${data.blocking_issues.join('；')}` : '',
            data.summary ? `摘要: ${data.summary}` : '',
        ].filter(Boolean);
        checks.slice(0, 10).forEach((check) => {
            lines.push(`${check.name || '检查'}: ${check.status}${check.details ? ` - ${check.details}` : ''}`);
        });
        return lines.join('\n');
    }

    if (stage.key === 'final_report') {
        return data.final_validation?.summary || JSON.stringify(data, null, 2);
    }

    return JSON.stringify(data, null, 2);
}

function formatAgentToolOutput(toolCall) {
    const output = toAgentObject(toolCall?.output_json || toolCall?.output) || {};
    const lines = [
        toolCall?.working_directory ? `工作目录: ${toolCall.working_directory}` : '',
        Number.isFinite(Number(toolCall?.exit_code)) ? `退出码: ${Number(toolCall.exit_code)}` : '',
        output.path ? `目标路径: ${output.path}` : '',
        output.operation ? `操作: ${output.operation}` : '',
        typeof output.content_changed === 'boolean' ? `内容变化: ${output.content_changed ? '是' : '否'}` : '',
        Array.isArray(output.results) ? `搜索结果: ${output.results.length} 条` : '',
        output.query ? `查询: ${output.query}` : '',
        output.stdout ? `stdout: ${truncateText(output.stdout, 280)}` : '',
        output.stderr ? `stderr: ${truncateText(output.stderr, 280)}` : '',
        output.error ? `错误: ${output.error}` : '',
    ].filter(Boolean);
    return lines.join('\n') || JSON.stringify(output, null, 2);
}

function formatAgentValidationDetails(validation) {
    const details = toAgentObject(validation?.details_json || validation?.details) || {};
    const lines = [
        details.expected ? `验证目标: ${details.expected}` : '',
        details.validator ? `验证结果: ${details.validator}` : '',
        Array.isArray(details.changed_paths) && details.changed_paths.length ? `涉及文件: ${details.changed_paths.join(', ')}` : '',
        typeof details.mutated_project === 'boolean' ? `发生项目改动: ${details.mutated_project ? '是' : '否'}` : '',
        details.step_summary ? `步骤摘要: ${truncateText(details.step_summary, 360)}` : '',
        details.output_excerpt ? `输出摘录: ${truncateText(details.output_excerpt, 360)}` : '',
    ].filter(Boolean);
    return lines.join('\n') || JSON.stringify(details, null, 2);
}

function renderAgentTimeline(target) {
    const shell = ensureAgentTimelineShell(target);
    const state = getAgentRunState(target);
    if (!shell || !state) {
        return;
    }
    ensureAgentStages(state);

    shell.replaceChildren();

    const header = document.createElement('div');
    header.className = 'mb-3 flex items-center justify-between gap-3';
    header.innerHTML = `
        <div class="min-w-0">
            <div class="text-sm font-medium text-white">Agent 执行轨迹</div>
            <div class="mt-0.5 text-xs text-gray-400">${state.runId ? `Run ${escapeHtmlFragment(state.runId.slice(0, 8))}` : '等待启动'}</div>
        </div>
        <div class="shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${agentStatusBadgeClass(state.status)}">${agentStatusLabel(state.status)}</div>
    `;
    shell.appendChild(header);

    const changedPaths = collectRunChangedPaths(state);
    if (changedPaths.length > 0) {
        const changes = document.createElement('div');
        changes.className = 'mb-3 rounded-xl border border-emerald-400/15 bg-emerald-500/[0.05] px-3 py-2';

        const meta = document.createElement('div');
        meta.className = 'mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-[0.12em] text-emerald-200/80';
        meta.innerHTML = `
            <span>本次 Agent 变更文件</span>
            <span>${changedPaths.length} 项</span>
        `;
        changes.appendChild(meta);

        const list = document.createElement('div');
        list.className = 'flex flex-wrap gap-2';
        changedPaths.forEach((changedPath) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-gray-200 hover:border-emerald-300/40 hover:text-white';
            button.textContent = changedPath;
            button.addEventListener('click', () => jumpToAgentProjectPath(changedPath));
            list.appendChild(button);
        });
        changes.appendChild(list);
        shell.appendChild(changes);
    }

    const list = document.createElement('div');
    list.className = 'space-y-2';

    state.stages.forEach((stage, index) => {
        const row = document.createElement('div');
        row.className = 'rounded-xl border border-white/5 bg-black/10 px-3 py-2';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'flex w-full items-start gap-3 text-left';

        const dot = document.createElement('div');
        dot.className = `mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${stageNodeClass(stage.status)}`;
        dot.textContent = String(stage.index);
        button.appendChild(dot);

        const body = document.createElement('div');
        body.className = 'min-w-0 flex-1';
        body.innerHTML = `
            <div class="flex items-center justify-between gap-3">
                <div class="truncate text-sm font-medium text-gray-100">${escapeHtmlFragment(stage.title)}</div>
                <div class="shrink-0 text-[11px] ${stage.status === 'failed' ? 'text-red-300' : stage.status === 'running' ? 'text-sky-300' : stage.status === 'passed' ? 'text-emerald-300' : stage.status === 'skipped' ? 'text-amber-300' : 'text-gray-500'}">${escapeHtmlFragment(stage.status || 'pending')}</div>
            </div>
            <div class="mt-1 text-xs leading-relaxed text-gray-400">${escapeHtmlFragment(stage.summary || '等待执行')}</div>
        `;
        button.appendChild(body);

        const chevron = document.createElement('div');
        chevron.className = `shrink-0 pt-0.5 text-gray-500 transition-transform ${stage.expanded ? 'rotate-180' : ''}`;
        chevron.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"></path></svg>';
        button.appendChild(chevron);
        row.appendChild(button);

        const details = document.createElement('div');
        details.className = stage.expanded ? 'mt-3 space-y-3 border-t border-white/5 pt-3' : 'hidden';

        if (stage.data && Object.keys(stage.data).length > 0) {
            const dataCard = document.createElement('div');
            dataCard.className = 'rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2';
            dataCard.innerHTML = `<div class="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-500">阶段摘要</div>${formatAgentDetailsBlock(formatAgentStageData(stage))}`;
            details.appendChild(dataCard);
        }

        if (stage.toolCalls.length > 0) {
            const tools = document.createElement('div');
            tools.className = 'rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2';
            tools.innerHTML = `<div class="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-500">工具调用</div>`;
            stage.toolCalls.forEach((toolCall) => {
                const item = document.createElement('div');
                item.className = 'mb-2 last:mb-0 text-xs text-gray-300';
                item.innerHTML = `
                    <div class="font-medium text-gray-200">${escapeHtmlFragment(toolCall.tool_name || 'tool')}</div>
                    <div class="mt-1 text-gray-400 whitespace-pre-wrap leading-6">${escapeHtmlFragment(formatAgentToolOutput(toolCall))}</div>
                `;
                const changed = Array.isArray(toolCall.changed_paths)
                    ? toolCall.changed_paths
                    : (Array.isArray(toolCall.output_json?.changed_paths) ? toolCall.output_json.changed_paths : []);
                if (changed.length > 0) {
                    const files = document.createElement('div');
                    files.className = 'mt-2 flex flex-wrap gap-2';
                    changed.forEach((changedPath) => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-gray-200 hover:border-emerald-300/40 hover:text-white';
                        button.textContent = changedPath;
                        button.addEventListener('click', () => jumpToAgentProjectPath(changedPath));
                        files.appendChild(button);
                    });
                    item.appendChild(files);
                }
                tools.appendChild(item);
            });
            details.appendChild(tools);
        }

        if (stage.validations.length > 0) {
            const checks = document.createElement('div');
            checks.className = 'rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2';
            checks.innerHTML = `<div class="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-500">验证记录</div>`;
            stage.validations.forEach((validation) => {
                const item = document.createElement('div');
                item.className = 'mb-2 last:mb-0 text-xs text-gray-300';
                item.innerHTML = `
                    <div class="flex items-center justify-between gap-3">
                        <div class="font-medium text-gray-200">${escapeHtmlFragment(validation.check_name || '验证')}</div>
                        <div class="${validation.status === 'failed' ? 'text-red-300' : validation.status === 'passed' ? 'text-emerald-300' : 'text-gray-500'}">${escapeHtmlFragment(validation.status || 'pending')}</div>
                    </div>
                    <div class="mt-1 text-gray-400 whitespace-pre-wrap leading-6">${escapeHtmlFragment(formatAgentValidationDetails(validation))}</div>
                `;
                checks.appendChild(item);
            });
            details.appendChild(checks);
        }

        if (!stage.data && stage.toolCalls.length === 0 && stage.validations.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-gray-500';
            empty.textContent = '当前阶段暂无可展开的详细记录。';
            details.appendChild(empty);
        }

        row.appendChild(details);
        button.addEventListener('click', () => {
            stage.expanded = !stage.expanded;
            renderAgentTimeline(target);
        });

        if (index < state.stages.length - 1) {
            row.classList.add('relative');
        }
        list.appendChild(row);
    });

    shell.appendChild(list);
}

function upsertAgentStageState(target, chunk) {
    const state = getAgentRunState(target, chunk);
    const stage = state.stages.find((item) => item.key === chunk.stage_key);
    if (!stage) {
        return;
    }

    if (chunk.status) {
        stage.status = normalizeStageStatus(chunk.status);
    }
    if (typeof chunk.summary === 'string') {
        stage.summary = chunk.summary;
    }
    if (chunk.data && typeof chunk.data === 'object') {
        stage.data = chunk.data;
    }
    if (stage.status === 'running') {
        stage.expanded = true;
    }
}

function handleAgentStreamEvent(target, chunk) {
    if (!target || !chunk?.type || !String(chunk.type).startsWith('agent_')) {
        return false;
    }

    const state = getAgentRunState(target, chunk);
    ensureAgentTimelineShell(target, chunk);

    if (chunk.type === 'agent_run_started') {
        state.status = 'running';
        renderAgentTimeline(target);
        return true;
    }

    if (chunk.type === 'agent_stage_started' || chunk.type === 'agent_stage_updated' || chunk.type === 'agent_stage_completed') {
        upsertAgentStageState(target, chunk);
        if (chunk.type === 'agent_stage_completed' && chunk.status) {
            state.stages
                .filter((item) => item.key !== chunk.stage_key && item.status === 'running')
                .forEach((item) => { item.status = 'passed'; });
        }
        renderAgentTimeline(target);
        return true;
    }

    if (chunk.type === 'agent_tool_call_completed') {
        const stage = state.stages.find((item) => item.key === chunk.stage_key);
        if (stage) {
            stage.toolCalls.push({
                tool_name: chunk.tool_name,
                output_json: chunk.output,
                status: chunk.status,
                step_index: chunk.step_index,
                tool_call_id: chunk.tool_call_id,
                changed_paths: Array.isArray(chunk.changed_paths) ? chunk.changed_paths : [],
                mutated_project: Boolean(chunk.mutated_project),
                working_directory: chunk.working_directory || '',
            });
            stage.expanded = true;
        }
        if (Array.isArray(chunk.changed_paths) && chunk.changed_paths.length > 0) {
            state.changedPaths = Array.from(new Set([...(state.changedPaths || []), ...chunk.changed_paths]));
        }
        if (chunk.working_directory) {
            state.workingDirectory = chunk.working_directory;
        }
        if (chunk.mutated_project || toolCallMayChangeProject(chunk.tool_name)) {
            state.projectDirty = true;
            scheduleAgentProjectRefresh();
        }
        renderAgentTimeline(target);
        return true;
    }

    if (chunk.type === 'agent_validation_completed') {
        const stage = state.stages.find((item) => item.key === chunk.stage_key);
        if (stage) {
            stage.validations.push({
                check_name: chunk.check_name,
                status: chunk.status,
                details_json: chunk.details,
                validation_id: chunk.validation_id,
            });
            stage.expanded = true;
        }
        renderAgentTimeline(target);
        return true;
    }

    if (chunk.type === 'agent_run_completed' || chunk.type === 'agent_run_failed') {
        state.status = chunk.type === 'agent_run_completed' ? 'completed' : 'failed';
        if (Array.isArray(chunk.changed_paths)) {
            state.changedPaths = Array.from(new Set([...(state.changedPaths || []), ...chunk.changed_paths]));
        }
        if (chunk.working_directory) {
            state.workingDirectory = chunk.working_directory;
        }
        if (chunk.type === 'agent_run_failed') {
            const firstActiveStage = state.stages.find((item) => item.status === 'running')
                || state.stages.find((item) => item.status === 'pending');
            if (firstActiveStage) {
                firstActiveStage.status = 'failed';
                firstActiveStage.summary = chunk.summary || firstActiveStage.summary || 'Agent 在该阶段启动失败。';
                firstActiveStage.expanded = true;
            }
        }
        if (state.projectDirty) {
            scheduleAgentProjectRefresh();
        }
        renderAgentTimeline(target);
        return true;
    }

    return true;
}

function removeAgentTimeline(target) {
    const key = target?.id;
    if (key) {
        agentTimelineState.delete(key);
    }
    const group = target?.closest('.message-group');
    const shell = group?.querySelector('.agent-run-timeline');
    if (shell) {
        shell.remove();
    }
}

function hydrateAgentRunReplayByContentId(msgId, run) {
    const target = document.getElementById(msgId);
    if (!target || !run) {
        return;
    }

    const state = getAgentRunState(target, run);
    state.runId = run.id || run.run_id || state.runId;
    state.assistantMessageId = run.assistant_message_id || state.assistantMessageId;
    state.status = run.status || state.status;
    state.stages = AGENT_STAGE_META.map((meta, index) => {
        const sourceStage = Array.isArray(run.stages)
            ? run.stages.find((stage) => stage.stage_key === meta.key || stage.key === meta.key)
            : null;
        return {
            key: meta.key,
            title: meta.title,
            index: index + 1,
            status: normalizeStageStatus(sourceStage?.status || 'pending'),
            summary: sourceStage?.summary || '',
            data: sourceStage?.evaluation_json || null,
            toolCalls: Array.isArray(sourceStage?.tool_calls) ? sourceStage.tool_calls.map((toolCall) => ({
                ...toolCall,
                changed_paths: Array.isArray(toolCall?.changed_paths)
                    ? toolCall.changed_paths
                    : (Array.isArray(toolCall?.output_json?.changed_paths) ? toolCall.output_json.changed_paths : []),
            })) : [],
            validations: Array.isArray(sourceStage?.validations) ? sourceStage.validations : [],
            expanded: false,
        };
    });
    ensureAgentStages(state);

    ensureAgentTimelineShell(target, run);
    renderAgentTimeline(target);
}

window.hydrateAgentRunReplayByContentId = hydrateAgentRunReplayByContentId;

function normalizeStreamingMarkdown(content) {
    let normalized = content || '';
    const fenceCount = (normalized.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
        normalized += '\n```';
    }
    return normalized;
}

function renderAssistantContent(target, content, renderMarkdown = false, isStreaming = false) {
    if (!target) {
        return;
    }

    if (renderMarkdown && typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        try {
            const source = isStreaming ? normalizeStreamingMarkdown(content) : (content || '');
            target.innerHTML = renderSafeMarkdownHtml(source);
            if (typeof enhanceCodeBlocks === 'function') {
                enhanceCodeBlocks(target);
            }
            return;
        } catch {}
    }

    target.textContent = content || '';
}

function scheduleStreamingAssistantRender(target, content) {
    if (!target) {
        return;
    }

    target.__pendingStreamContent = content || '';
    if (target.__streamRenderFrame) {
        return;
    }

    target.__streamRenderFrame = requestAnimationFrame(() => {
        target.__streamRenderFrame = null;
        renderAssistantContent(target, target.__pendingStreamContent, true, true);
    });
}

function flushStreamingAssistantRender(target, content) {
    if (!target) {
        return;
    }

    if (target.__streamRenderFrame) {
        cancelAnimationFrame(target.__streamRenderFrame);
        target.__streamRenderFrame = null;
    }

    target.__pendingStreamContent = '';
    renderAssistantContent(target, content, true, false);
}

function setMessageRawContent(target, content) {
    if (!target) {
        return;
    }

    target.setAttribute('data-raw-content', encodeURIComponent(content || ''));
    const group = target.closest('.message-group');
    if (group) {
        group.dataset.rawContent = content || '';
    }
}

function getMessageTextFromGroup(messageGroup) {
    if (!messageGroup) {
        return '';
    }

    if (messageGroup.dataset.rawContent) {
        return messageGroup.dataset.rawContent;
    }

    const contentDiv = messageGroup.querySelector('.message-content');
    if (!contentDiv) {
        return '';
    }

    const encoded = contentDiv.getAttribute('data-raw-content');
    if (encoded && encoded !== '%') {
        try {
            return decodeURIComponent(encoded);
        } catch {}
    }

    return contentDiv.innerText || '';
}

function setComposerText(text) {
    ui.userInput.value = text || '';
    autoResizeUserInput();
    refreshComposerState();
    ui.userInput.focus();
    const length = ui.userInput.value.length;
    ui.userInput.setSelectionRange(length, length);
}

function findPreviousUserMessageGroup(messageGroup) {
    let current = messageGroup ? messageGroup.previousElementSibling : null;
    while (current) {
        if (current.classList.contains('message-group') && current.dataset.role === 'user') {
            return current;
        }
        current = current.previousElementSibling;
    }
    return null;
}

function formatStoragePath(info) {
    if (!info) {
        return '榛樿 (搴旂敤鍐呴儴鐩綍)';
    }

    return info.is_default ? `榛樿 (${info.path})` : info.path;
}

async function loadStorageSettings() {
    try {
        const response = await apiRequest('/api/storage', { method: 'GET' });
        const info = await readJsonSafe(response);
        if (!response.ok || !info) {
            throw new Error(`HTTP ${response.status}`);
        }

        const display = document.getElementById('storage-path-display');
        if (display) {
            display.textContent = formatStoragePath(info);
            display.title = info.path || '';
        }
    } catch (error) {
        console.error('Failed to load storage settings:', error);
    }
}

function updateApiFormForEdit(model) {
    const keyInput = document.getElementById('api-key');
    document.getElementById('api-model').value = model.name;
    document.getElementById('api-url').value = model.url;
    keyInput.value = '';
    keyInput.placeholder = model.keyMasked
        ? `Saved ${model.keyMasked}. Leave blank to keep it unchanged.`
        : 'sk-...';
}

function clearApiForm() {
    document.getElementById('api-model').value = '';
    document.getElementById('api-url').value = '';
    const keyInput = document.getElementById('api-key');
    keyInput.value = '';
    keyInput.placeholder = 'sk-...';
}

showApiEditView = function (id = null) {
    editingModelId = id;
    document.getElementById('api-list-view').classList.add('hidden');
    document.getElementById('api-edit-view').classList.remove('hidden');
    document.getElementById('api-edit-title').textContent = id ? 'Edit Model' : 'Add Model';

    if (id) {
        const model = apiModels.find((item) => item.id === id);
        if (model) {
            updateApiFormForEdit(model);
        }
    } else {
        clearApiForm();
    }

    document.getElementById('api-parser-container').classList.add('hidden');
    document.getElementById('parser-chevron').style.transform = 'rotate(0deg)';
    document.getElementById('api-parser-input').value = '';
};

saveApiModel = async function () {
    const name = document.getElementById('api-model').value.trim();
    const url = document.getElementById('api-url').value.trim();
    const key = document.getElementById('api-key').value.trim();

    if (!name || !url) {
        appAlert('Please enter the model name and Base URL first.');
        return;
    }

    if (!editingModelId && !key) {
        appAlert('API Key is required when adding a new model.');
        return;
    }

    const response = await apiRequest(
        editingModelId ? `/api/models/${editingModelId}` : '/api/models',
        {
            method: editingModelId ? 'PUT' : 'POST',
            body: JSON.stringify({
                name,
                base_url: url,
                api_key: key,
                model_id: name,
            }),
        }
    );

    if (!response.ok) {
        const error = await readJsonSafe(response);
        appAlert(error?.detail || 'Failed to save the model.');
        return;
    }

    editingModelId = null;
    await loadModels();
    showApiListView();
};

deleteApiModel = async function (id) {
    const response = await apiRequest(`/api/models/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
        const error = await readJsonSafe(response);
        appAlert(error?.detail || 'Failed to delete the model.');
        return;
    }

    await loadModels();
};

setActiveModel = async function (id) {
    const response = await apiRequest(`/api/models/${id}/activate`, { method: 'PATCH' });
    if (!response.ok) {
        const error = await readJsonSafe(response);
        appAlert(error?.detail || 'Failed to switch the active model.');
        return;
    }

    await loadModels();
};

parseAPICode = async function () {
    const code = document.getElementById('api-parser-input').value.trim();
    if (!code) {
        return;
    }

    const response = await apiRequest('/api/models/parse-config', {
        method: 'POST',
        body: JSON.stringify({ code }),
    });
    const result = await readJsonSafe(response);
    if (!response.ok || !result) {
        appAlert('Automatic config parsing failed.');
        return;
    }

    if (result.name) {
        document.getElementById('api-model').value = result.name;
    }
    if (result.base_url) {
        document.getElementById('api-url').value = result.base_url;
    }
    if (result.api_key) {
        document.getElementById('api-key').value = result.api_key;
    }
};

testConnection = async function () {
    const button = document.getElementById('test-btn');
    const url = document.getElementById('api-url').value.trim();
    const key = document.getElementById('api-key').value.trim();
    const model = document.getElementById('api-model').value.trim() || 'gpt-4o';

    if (!url || !key) {
        button.textContent = 'Enter URL and Key first';
        setTimeout(() => {
            button.textContent = 'Test Connection';
        }, 2000);
        return;
    }

    button.textContent = 'Testing...';
    button.disabled = true;

    try {
        const response = await apiRequest('/api/models/test', {
            method: 'POST',
            body: JSON.stringify({
                base_url: url,
                api_key: key,
                model_id: model,
            }),
        });
        const result = await readJsonSafe(response);
        button.textContent = result?.success ? 'Connected' : 'Failed';
    } catch {
        button.textContent = 'Failed';
    } finally {
        button.disabled = false;
        setTimeout(() => {
            button.textContent = 'Test Connection';
        }, 3000);
    }
};

parseGithubRepo = async function () {
    const input = document.getElementById('github-url-input').value.trim();
    if (!input) {
        return;
    }

    const button = document.getElementById('github-parse-btn');
    const originalText = button.textContent;
    button.textContent = '瑙ｆ瀽涓?..';
    button.disabled = true;

    try {
        const response = await apiRequest('/api/github/parse', {
            method: 'POST',
            body: JSON.stringify({ url: input }),
        });
        const result = await readJsonSafe(response);
        if (!response.ok || !result?.success) {
            throw new Error(result?.message || `HTTP ${response.status}`);
        }

        closeGithubModal();
        if (ui.messagesList.classList.contains('hidden')) {
            ui.welcomeView.classList.add('hidden');
            ui.messagesList.classList.remove('hidden');
        }
        addMessage('assistant', `GitHub repository parsed:\n${input}\n\n${result.message}`);
        button.textContent = 'Parsed';
    } catch (error) {
        button.textContent = 'Failed';
        if (ui.messagesList.classList.contains('hidden')) {
            ui.welcomeView.classList.add('hidden');
            ui.messagesList.classList.remove('hidden');
        }
        addMessage('assistant', `GitHub parsing failed: ${error.message}`);
    } finally {
        button.disabled = false;
        setTimeout(() => {
            button.textContent = originalText;
        }, 1500);
    }
};

async function ensureRealSession(firstMessage, attachments = []) {
    if (currentSessionId) {
        return currentSessionId;
    }

    const attachmentLabel = Array.isArray(attachments) && attachments.length > 0
        ? attachments.map((attachment) => attachment.filename).filter(Boolean).slice(0, 2).join(', ')
        : '';
    const baseTitle = String(firstMessage || '').trim() || (attachmentLabel ? `Attachments: ${attachmentLabel}` : 'New Chat');

    const response = await apiRequest('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
            title: baseTitle.length > 30 ? baseTitle.slice(0, 30) : baseTitle,
            chat_mode: currentChatMode,
        }),
    });

    const data = await readJsonSafe(response);
    if (!response.ok || !data?.id) {
        throw new Error(data?.detail || 'Failed to create the chat session.');
    }

    if (typeof setCurrentSession === 'function') {
        setCurrentSession(data.id, data.chat_mode || currentChatMode);
    } else {
        currentSessionId = data.id;
    }
    if (typeof loadPrompts === 'function') {
        await loadPrompts();
    }
    return currentSessionId;
}

async function streamRealChat(msgId, avatarId, payload) {
    const target = document.getElementById(msgId);

    if (payload?.chat_mode === 'agent') {
        setWebSearchStatus('');
        removeWebSearchPanel(target);
        removeAgentTimeline(target);
        ensureAgentTimelineShell(target, { status: 'running' });
        renderAgentTimeline(target);
    } else if (payload?.web_search) {
        setWebSearchStatus('正在判断是否需要联网搜索…', 'pending');
        renderWebSearchPanel(target, [], 'searching');
    } else {
        setWebSearchStatus('');
        removeWebSearchPanel(target);
        removeAgentTimeline(target);
    }

    const response = await apiRequest('/api/chat/stream', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const error = await readJsonSafe(response);
        throw new Error(error?.detail || `HTTP ${response.status}`);
    }

    if (!response.body) {
        throw new Error('Streaming responses are not supported in the current environment.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let doneStreaming = false;

    while (!doneStreaming) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
            const lines = event.split(/\r?\n/);
            for (const line of lines) {
                if (!line.startsWith('data:')) {
                    continue;
                }

                const raw = line.slice(5).trim();
                if (!raw) {
                    continue;
                }

                const chunk = JSON.parse(raw);
                if (chunk.type === 'status') {
                    handleWebSearchStatus(chunk, target);
                    continue;
                }
                try {
                    if (handleAgentStreamEvent(target, chunk)) {
                        continue;
                    }
                } catch (error) {
                    console.error('Agent timeline render failed:', error);
                }

                if (chunk.error) {
                    throw new Error(chunk.error);
                }

                if (chunk.content) {
                    fullText += chunk.content;
                    scheduleStreamingAssistantRender(target, fullText);
                    setMessageRawContent(target, fullText);
                    scrollToBottom();
                }

                if (chunk.done) {
                    doneStreaming = true;
                    break;
                }
            }
        }

        if (done) {
            break;
        }
    }

    if (!fullText) {
        fullText = 'The model returned no content.';
    }

    flushStreamingAssistantRender(target, fullText);
    setMessageRawContent(target, fullText);
    finishTyping(avatarId);
}

handleSend = async function () {
    const text = ui.userInput.value.trim();
    const outgoingAttachments = pendingAttachments.map((attachment) => ({ ...attachment }));
    if ((!text && outgoingAttachments.length === 0) || isTyping || isUploadingAttachments) {
        return;
    }

    if (isSpeechListening) {
        stopSpeechToText();
    }

    const activeModel = getActiveModel();
    if (!activeModel) {
        appAlert('Please configure and activate a model in Settings first.');
        return;
    }

    if (ui.messagesList.classList.contains('hidden')) {
        ui.welcomeView.classList.add('hidden');
        ui.messagesList.classList.remove('hidden');
    }

    const outgoingSummary = text || `Sent ${outgoingAttachments.length} attachment${outgoingAttachments.length > 1 ? 's' : ''}`;
    addMessage('user', outgoingSummary);
    const latestUserGroup = Array.from(ui.messagesList.querySelectorAll('.message-group[data-role="user"]')).pop();
    appendAttachmentsToMessageGroup(latestUserGroup, outgoingAttachments, text);
    ui.userInput.value = '';
    ui.userInput.style.height = 'auto';
    clearPendingAttachments();
    refreshComposerState();

    isTyping = true;
    const { msgId, avatarId } = addMessage('assistant', '', true);

    try {
        const sessionId = await ensureRealSession(text, outgoingAttachments);
        isNewSession = false;
        if (typeof loadSessionHistory === 'function') {
            await loadSessionHistory(sessionId, { openPreferred: false });
        }
        await streamRealChat(msgId, avatarId, {
            session_id: sessionId,
            message: text,
            attachments: outgoingAttachments,
            project_context: currentChatMode === 'agent' && typeof buildSelectedProjectContext === 'function'
                ? buildSelectedProjectContext()
                : null,
            model_config_id: activeModel.id,
            web_search: webSearchEnabled,
            chat_mode: currentChatMode,
        });
    } catch (error) {
        pendingAttachments = outgoingAttachments;
        renderPendingAttachments();
        const target = document.getElementById(msgId);
        const errorText = `Request failed: ${error.message}`;
        if (currentChatMode === 'agent') {
            const state = getAgentRunState(target, { status: 'failed' });
            state.status = 'failed';
            renderAgentTimeline(target);
        }
        renderAssistantContent(target, errorText, false);
        setMessageRawContent(target, errorText);
        if (webSearchEnabled) {
            setWebSearchStatus('请求失败，请检查网络或模型配置。', 'error');
            renderWebSearchPanel(target, [], 'failed');
        }
        finishTyping(avatarId);
    }
};

resetChat = function () {
    if (isSpeechListening) {
        stopSpeechToText();
    }
    ui.messagesList.innerHTML = '';
    ui.messagesList.classList.add('hidden');
    ui.welcomeView.classList.remove('hidden');
    ui.userInput.value = '';
    ui.userInput.style.height = 'auto';
    clearPendingAttachments();
    isTyping = false;
    isNewSession = true;
    if (typeof setCurrentSession === 'function') {
        setCurrentSession(null);
    } else {
        currentSessionId = null;
    }
    refreshComposerState();

    if (typeof loadPrompts === 'function') {
        loadPrompts();
    }
};

window.addEventListener('load', async () => {
    await loadModels();
    await loadStorageSettings();
    initializeWebSearchState();
    initializeAttachmentInputs();
    renderWebSearchState();
    refreshComposerState();
});

selectStorageFolder = function () {
    (async () => {
        try {
            const response = await apiRequest('/api/storage/select', {
                method: 'POST',
                body: JSON.stringify({}),
            });
            const result = await readJsonSafe(response);

            if (!response.ok || !result) {
                throw new Error(result?.detail || `HTTP ${response.status}`);
            }

            if (result.cancelled) {
                return;
            }

            await loadStorageSettings();
            resetChat();
            await loadModels();
            await loadPrompts();
            appAlert(`Storage folder switched to:\n${result.path}`);
        } catch (error) {
            appAlert(error.message || 'Failed to switch the storage folder.');
        }
    })();
};

editSingleMessage = function (button) {
    const messageGroup = button.closest('.message-group');
    const text = getMessageTextFromGroup(messageGroup);
    if (!text) {
        return;
    }

    setComposerText(text);
};

function getLatestAssistantMessageGroup() {
    const assistantGroups = Array.from(ui.messagesList.querySelectorAll('.message-group[data-role="assistant"]'));
    return assistantGroups[assistantGroups.length - 1] || null;
}

retrySingleMessage = async function (button) {
    if (isTyping) {
        return;
    }

    const assistantGroup = button.closest('.message-group');
    if (!assistantGroup || assistantGroup.dataset.role !== 'assistant') {
        return;
    }

    if (assistantGroup !== getLatestAssistantMessageGroup()) {
        appAlert('Only the latest assistant reply can be regenerated right now.');
        return;
    }

    const userGroup = findPreviousUserMessageGroup(assistantGroup);
    const text = getMessageTextFromGroup(userGroup);
    if (userGroup?.dataset?.hasAttachments === 'true') {
        appAlert('The previous message includes attachments. Please resend it so the attachments are included again.');
        return;
    }
    if (!text) {
        appAlert('No previous user message was found for retry.');
        return;
    }

    const activeModel = getActiveModel();
    if (!activeModel) {
        appAlert('Please configure and activate a model in Settings first.');
        return;
    }

    if (!currentSessionId) {
        appAlert('The current chat has not been saved yet, so it cannot be regenerated.');
        return;
    }

    const target = assistantGroup.querySelector('.message-content');
    const avatar = assistantGroup.querySelector("[id^='avatar-']");
    if (!target || !avatar) {
        return;
    }

    isTyping = true;
    refreshComposerState();
    if (typeof setAssistantLoadingState === 'function') {
        setAssistantLoadingState(avatar.id, true);
    }
    renderAssistantContent(target, '', false);
    setMessageRawContent(target, '');

    try {
        await streamRealChat(target.id, avatar.id, {
            session_id: currentSessionId,
            message: text,
            project_context: currentChatMode === 'agent' && typeof buildSelectedProjectContext === 'function'
                ? buildSelectedProjectContext()
                : null,
            model_config_id: activeModel.id,
            regenerate: true,
            web_search: webSearchEnabled,
            chat_mode: currentChatMode,
        });

        if (typeof loadSessionHistory === 'function') {
            await loadSessionHistory(currentSessionId, { openPreferred: false });
        }
    } catch (error) {
        const errorText = `Request failed: ${error.message}`;
        if (currentChatMode === 'agent') {
            const state = getAgentRunState(target, { status: 'failed' });
            state.status = 'failed';
            renderAgentTimeline(target);
        }
        renderAssistantContent(target, errorText, false);
        setMessageRawContent(target, errorText);
        if (webSearchEnabled) {
            setWebSearchStatus('请求失败，请检查网络或模型配置。', 'error');
            renderWebSearchPanel(target, [], 'failed');
        }
        finishTyping(avatar.id);
    }
};
