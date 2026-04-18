function appAlert(message) {
    window.alert(message);
}

function updateApiFormForEdit(model) {
    const keyInput = document.getElementById("api-key");
    document.getElementById("api-model").value = model.name;
    document.getElementById("api-url").value = model.url;
    keyInput.value = "";
    keyInput.placeholder = model.keyMasked
        ? `已保存 ${model.keyMasked}，留空则不修改`
        : "sk-...";
}

function clearApiForm() {
    document.getElementById("api-model").value = "";
    document.getElementById("api-url").value = "";
    const keyInput = document.getElementById("api-key");
    keyInput.value = "";
    keyInput.placeholder = "sk-...";
}

showApiEditView = function (id = null) {
    editingModelId = id;
    document.getElementById("api-list-view").classList.add("hidden");
    document.getElementById("api-edit-view").classList.remove("hidden");
    document.getElementById("api-edit-title").textContent = id ? "编辑模型" : "添加新模型";

    if (id) {
        const model = apiModels.find(x => x.id === id);
        if (model) {
            updateApiFormForEdit(model);
        }
    } else {
        clearApiForm();
    }

    document.getElementById("api-parser-container").classList.add("hidden");
    document.getElementById("parser-chevron").style.transform = "rotate(0deg)";
    document.getElementById("api-parser-input").value = "";
};

saveApiModel = async function () {
    const name = document.getElementById("api-model").value.trim();
    const url = document.getElementById("api-url").value.trim();
    const key = document.getElementById("api-key").value.trim();

    if (!name || !url) {
        appAlert("请先填写模型名称和 Base URL。");
        return;
    }

    if (!editingModelId && !key) {
        appAlert("新增模型时必须填写 API Key。");
        return;
    }

    const response = await apiRequest(editingModelId ? `/api/models/${editingModelId}` : "/api/models", {
        method: editingModelId ? "PUT" : "POST",
        body: JSON.stringify({
            name,
            base_url: url,
            api_key: key,
            model_id: name,
        }),
    });

    if (!response.ok) {
        const error = await readJsonSafe(response);
        appAlert(error?.detail || "保存模型失败。");
        return;
    }

    editingModelId = null;
    await loadModels();
    showApiListView();
};

deleteApiModel = async function (id) {
    const response = await apiRequest(`/api/models/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) {
        const error = await readJsonSafe(response);
        appAlert(error?.detail || "删除模型失败。");
        return;
    }
    await loadModels();
};

setActiveModel = async function (id) {
    const response = await apiRequest(`/api/models/${id}/activate`, { method: "PATCH" });
    if (!response.ok) {
        const error = await readJsonSafe(response);
        appAlert(error?.detail || "切换模型失败。");
        return;
    }
    await loadModels();
};

parseAPICode = async function () {
    const code = document.getElementById("api-parser-input").value.trim();
    if (!code) return;

    const response = await apiRequest("/api/models/parse-config", {
        method: "POST",
        body: JSON.stringify({ code }),
    });
    const result = await readJsonSafe(response);
    if (!response.ok || !result) {
        appAlert("自动解析失败。");
        return;
    }

    if (result.name) document.getElementById("api-model").value = result.name;
    if (result.base_url) document.getElementById("api-url").value = result.base_url;
    if (result.api_key) document.getElementById("api-key").value = result.api_key;
};

testConnection = async function () {
    const btn = document.getElementById("test-btn");
    const url = document.getElementById("api-url").value.trim();
    const key = document.getElementById("api-key").value.trim();
    const model = document.getElementById("api-model").value.trim() || "gpt-4o";

    if (!url || !key) {
        btn.textContent = "请先填写 URL 和 Key";
        setTimeout(() => {
            btn.textContent = "测试连接";
        }, 2000);
        return;
    }

    btn.textContent = "测试中...";
    btn.disabled = true;

    try {
        const response = await apiRequest("/api/models/test", {
            method: "POST",
            body: JSON.stringify({
                base_url: url,
                api_key: key,
                model_id: model,
            }),
        });
        const result = await readJsonSafe(response);
        btn.textContent = result?.success ? "连接成功" : "连接失败";
    } catch {
        btn.textContent = "连接失败";
    } finally {
        btn.disabled = false;
        setTimeout(() => {
            btn.textContent = "测试连接";
        }, 3000);
    }
};

parseGithubRepo = async function () {
    const input = document.getElementById("github-url-input").value.trim();
    if (!input) return;

    const btn = document.getElementById("github-parse-btn");
    const originalText = btn.textContent;
    btn.textContent = "解析中...";
    btn.disabled = true;

    try {
        const response = await apiRequest("/api/github/parse", {
            method: "POST",
            body: JSON.stringify({ url: input }),
        });
        const result = await readJsonSafe(response);
        if (!response.ok || !result?.success) {
            throw new Error(result?.message || `HTTP ${response.status}`);
        }

        closeGithubModal();
        if (ui.messagesList.classList.contains("hidden")) {
            ui.welcomeView.classList.add("hidden");
            ui.messagesList.classList.remove("hidden");
        }
        addMessage("assistant", `已完成 GitHub 仓库解析：\n${input}\n\n${result.message}`);
        btn.textContent = "解析成功";
    } catch (error) {
        btn.textContent = "解析失败";
        if (ui.messagesList.classList.contains("hidden")) {
            ui.welcomeView.classList.add("hidden");
            ui.messagesList.classList.remove("hidden");
        }
        addMessage("assistant", `GitHub 解析失败：${error.message}`);
    } finally {
        btn.disabled = false;
        setTimeout(() => {
            btn.textContent = originalText;
        }, 1500);
    }
};

async function ensureRealSession(firstMessage) {
    if (currentSessionId) {
        return currentSessionId;
    }

    const response = await apiRequest("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
            title: firstMessage.length > 30 ? firstMessage.slice(0, 30) : firstMessage,
        }),
    });

    const data = await readJsonSafe(response);
    if (!response.ok || !data?.id) {
        throw new Error(data?.detail || "创建会话失败");
    }

    if (typeof setCurrentSession === "function") {
        setCurrentSession(data.id);
    } else {
        currentSessionId = data.id;
    }
    if (typeof loadPrompts === "function") {
        await loadPrompts();
    }
    return currentSessionId;
}

async function streamRealChat(msgId, avatarId, payload) {
    const response = await apiRequest("/api/chat/stream", {
        method: "POST",
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const error = await readJsonSafe(response);
        throw new Error(error?.detail || `HTTP ${response.status}`);
    }

    if (!response.body) {
        throw new Error("当前环境不支持流式响应");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const target = document.getElementById(msgId);
    let buffer = "";
    let fullText = "";
    let doneStreaming = false;

    while (!doneStreaming) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
            const lines = event.split(/\r?\n/);
            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const raw = line.slice(5).trim();
                if (!raw) continue;

                const chunk = JSON.parse(raw);
                if (chunk.error) {
                    throw new Error(chunk.error);
                }
                if (chunk.content) {
                    fullText += chunk.content;
                    if (typeof renderAssistantMarkdown === "function") {
                        renderAssistantMarkdown(target, fullText);
                    } else {
                        target.textContent = fullText;
                    }
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
        target.textContent = "模型没有返回内容。";
    }

    if (typeof renderAssistantMarkdown === "function") {
        renderAssistantMarkdown(target, fullText || "模型没有返回内容。");
    }

    if (!fullText && typeof renderAssistantMarkdown === "function") {
        renderAssistantMarkdown(target, "No content was returned by the model.");
    }

    finishTyping(avatarId);
}

function getMessageTextFromGroup(messageGroup) {
    if (!messageGroup) {
        return "";
    }

    const contentEl = messageGroup.querySelector(".message-content");
    if (!contentEl) {
        return "";
    }

    const encodedRaw = contentEl.getAttribute("data-raw-content");
    if (encodedRaw) {
        try {
            return decodeURIComponent(encodedRaw);
        } catch {}
    }

    return contentEl.innerText || "";
}

function getPreviousUserMessageText(messageGroup) {
    let cursor = messageGroup?.previousElementSibling || null;
    while (cursor) {
        if (cursor.dataset?.role === "user") {
            return getMessageTextFromGroup(cursor).trim();
        }
        cursor = cursor.previousElementSibling;
    }
    return "";
}

function getLatestAssistantMessageGroup() {
    const assistantGroups = Array.from(ui.messagesList.querySelectorAll('.message-group[data-role="assistant"]'));
    return assistantGroups[assistantGroups.length - 1] || null;
}

retrySingleMessage = async function (btn) {
    if (isTyping) return;

    const assistantGroup = btn.closest('.message-group');
    if (!assistantGroup || assistantGroup.dataset.role !== "assistant") {
        return;
    }

    if (assistantGroup !== getLatestAssistantMessageGroup()) {
        appAlert("目前只支持重新生成最新一条回答，避免改乱中间历史。");
        return;
    }

    const originalQuestion = getPreviousUserMessageText(assistantGroup);
    if (!originalQuestion) {
        appAlert("没有找到上一条用户问题，无法重新生成。");
        return;
    }

    const activeModel = getActiveModel();
    if (!activeModel) {
        appAlert("请先在设置中配置并激活一个模型。");
        return;
    }

    if (!currentSessionId) {
        appAlert("当前会话尚未保存，无法重新生成。");
        return;
    }

    const target = assistantGroup.querySelector(".message-content");
    const avatar = assistantGroup.querySelector("[id^='avatar-']");
    if (!target || !avatar) {
        return;
    }

    isTyping = true;
    ui.sendBtn.disabled = true;
    setAssistantLoadingState(avatar.id, true);
    renderAssistantMarkdown(target, "");

    try {
        await streamRealChat(target.id, avatar.id, {
            session_id: currentSessionId,
            message: originalQuestion,
            model_config_id: activeModel.id,
            regenerate: true,
        });

        if (typeof loadSessionHistory === "function") {
            await loadSessionHistory(currentSessionId, { openPreferred: false });
        }
    } catch (error) {
        renderAssistantMarkdown(target, `Request failed: ${error.message}`);
        finishTyping(avatar.id);
    }
};

handleSend = async function () {
    const text = ui.userInput.value.trim();
    if (!text || isTyping) return;

    const activeModel = getActiveModel();
    if (!activeModel) {
        appAlert("请先在设置中配置并激活模型。");
        return;
    }

    if (ui.messagesList.classList.contains("hidden")) {
        ui.welcomeView.classList.add("hidden");
        ui.messagesList.classList.remove("hidden");
    }

    addMessage("user", text);
    ui.userInput.value = "";
    ui.userInput.style.height = "auto";
    ui.sendBtn.disabled = true;

    isTyping = true;
    const { msgId, avatarId } = addMessage("assistant", "", true);

    try {
        const sessionId = await ensureRealSession(text);
        isNewSession = false;
        if (typeof loadSessionHistory === "function") {
            await loadSessionHistory(sessionId, { openPreferred: false });
        }
        await streamRealChat(msgId, avatarId, {
            session_id: sessionId,
            message: text,
            model_config_id: activeModel.id,
        });
    } catch (error) {
        const target = document.getElementById(msgId);
        if (target) {
            target.textContent = `请求失败：${error.message}`;
        }
        if (target && typeof renderAssistantMarkdown === "function") {
            renderAssistantMarkdown(target, `请求失败：${error.message}`);
        }
        if (target && typeof renderAssistantMarkdown === "function") {
            renderAssistantMarkdown(target, `Request failed: ${error.message}`);
        }
        finishTyping(avatarId);
    }
};

resetChat = function () {
    ui.messagesList.innerHTML = "";
    ui.messagesList.classList.add("hidden");
    ui.welcomeView.classList.remove("hidden");
    ui.userInput.value = "";
    ui.userInput.style.height = "auto";
    isTyping = false;
    isNewSession = true;
    if (typeof setCurrentSession === "function") {
        setCurrentSession(null);
    } else {
        currentSessionId = null;
    }
    ui.sendBtn.disabled = true;
    if (typeof loadPrompts === "function") {
        loadPrompts();
    }
};

window.addEventListener("load", async () => {
    await loadModels();
    ui.sendBtn.disabled = !ui.userInput.value.trim();
});

/**
 * 存储文件夹选择占位函数
 * 仅用于 UI 演示，实际存储逻辑由后端处理
 */
selectStorageFolder = function() {
    // 此处仅为 UI 交互演示，后续由后端接管具体逻辑
    console.log("[Storage Design] 用户点击了更改存储目录按钮");
    appAlert("存储文件夹选择功能已准备就绪。请在系统对话框中选择目标文件夹（此处为 UI 演示）。");
};
