const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

let activeModel = process.env.FIXY_MODEL || null;

/**
 * Get the currently active model name.
 */
export function getActiveModel() {
  return activeModel;
}

/**
 * Set the currently active model name.
 */
export function setActiveModel(name) {
  if (name) {
    activeModel = name;
    process.env.FIXY_MODEL = name;
  }
}

/**
 * List locally installed Ollama models.
 * @returns {Promise<Array<{name: string, size: number}>>}
 */
export async function listModels(host = DEFAULT_HOST) {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags failed: ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => ({ name: m.name, size: m.size }));
}

/**
 * Resolve a valid installed model. If the requested model is not found or not provided,
 * automatically fall back to the active model or the first available installed model.
 */
export async function resolveAvailableModel(preferredModel, host = DEFAULT_HOST, excludeModels = []) {
  try {
    const installed = await listModels(host);
    if (!installed.length) {
      throw new Error("No Ollama models found locally. Run `ollama pull qwen2.5-coder:1.5b` or `ollama pull qwen2.5-coder:7b`.");
    }
    const excludeSet = new Set(excludeModels.map((m) => m.toLowerCase()));
    const validModels = installed.filter((m) => !excludeSet.has(m.name.toLowerCase()));
    const pool = validModels.length > 0 ? validModels : installed;
    const names = pool.map((m) => m.name);

    if (preferredModel && !excludeSet.has(preferredModel.toLowerCase())) {
      const match = names.find(
        (n) => n.toLowerCase() === preferredModel.toLowerCase() || n.startsWith(preferredModel)
      );
      if (match) return match;
    }

    if (activeModel && !excludeSet.has(activeModel.toLowerCase())) {
      const activeMatch = names.find(
        (n) => n.toLowerCase() === activeModel.toLowerCase() || n.startsWith(activeModel)
      );
      if (activeMatch) return activeMatch;
    }

    const fallback = names[0];
    setActiveModel(fallback);
    return fallback;
  } catch (err) {
    if (preferredModel) return preferredModel;
    if (activeModel) return activeModel;
    throw err;
  }
}

/**
 * Send a chat turn to Ollama, with optional tool definitions.
 */
export async function chat({ model, messages, tools, host = DEFAULT_HOST }) {
  const failedModels = [];
  let targetModel = model || (await resolveAvailableModel(model, host));

  while (targetModel) {
    try {
      const body = { model: targetModel, messages, stream: false };
      if (tools && tools.length) body.tools = tools;

      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let cleanMsg = text;
        try {
          const json = JSON.parse(text);
          if (json.error) cleanMsg = json.error;
        } catch {
          // use raw text
        }
        const err = new Error(`Ollama /api/chat failed (${res.status}): ${cleanMsg}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      setActiveModel(targetModel);
      return data.message;
    } catch (err) {
      failedModels.push(targetModel);
      if (err.status === 404 || err.status === 429) {
        const nextFallback = await resolveAvailableModel(null, host, failedModels);
        if (nextFallback && !failedModels.includes(nextFallback)) {
          targetModel = nextFallback;
          continue;
        }
      }
      throw err;
    }
  }
}

/**
 * Streaming variant of chat(). Emits thinking/content tokens live via callbacks
 * as they arrive, and resolves with the fully assembled assistant message once
 * the stream ends. Self-heals if a model is missing or hits quota.
 */
export async function chatStream({
  model,
  messages,
  tools,
  host = DEFAULT_HOST,
  onThinking,
  onContent,
}) {
  const failedModels = [];
  let targetModel = model || (await resolveAvailableModel(null, host));

  while (targetModel) {
    try {
      const body = { model: targetModel, messages, stream: true, think: true };
      if (tools && tools.length) body.tools = tools;

      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let cleanMsg = text;
        try {
          const json = JSON.parse(text);
          if (json.error) cleanMsg = json.error;
        } catch {
          // use raw text
        }
        const err = new Error(`Ollama /api/chat failed (${res.status}): ${cleanMsg}`);
        err.status = res.status;
        throw err;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let thinking = "";
      let toolCalls = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          let chunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }

          const msg = chunk.message;
          if (msg?.thinking) {
            thinking += msg.thinking;
            onThinking?.(msg.thinking);
          }
          if (msg?.content) {
            content += msg.content;
            onContent?.(msg.content);
          }
          if (msg?.tool_calls?.length) {
            toolCalls = msg.tool_calls;
          }
        }
      }

      setActiveModel(targetModel);
      return {
        role: "assistant",
        content,
        thinking: thinking || undefined,
        tool_calls: toolCalls || undefined,
      };
    } catch (err) {
      failedModels.push(targetModel);
      if (err.status === 404 || err.status === 429) {
        const nextFallback = await resolveAvailableModel(null, host, failedModels);
        if (nextFallback && !failedModels.includes(nextFallback)) {
          targetModel = nextFallback;
          continue;
        }
      }
      throw err;
    }
  }
}
