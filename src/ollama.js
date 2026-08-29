const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

let activeModel = process.env.FIXY_MODEL || null;

/**
 * Resolve whether the "thinking" feature should be requested.
 * Env override: FIXY_THINK=1/true/on forces on, 0/false/off forces off.
 * Default: enabled, but chatStream() auto-retries without it when a model
 * does not support thinking (Ollama returns HTTP 400 mentioning "think").
 */
function resolveThinkFlag(explicit) {
  if (typeof explicit === "boolean") return explicit;
  const env = String(process.env.FIXY_THINK ?? "").trim().toLowerCase();
  if (env) return env === "1" || env === "true" || env === "on";
  return true;
}

/**
 * Merge streamed tool_call chunks: Ollama may split tool calls across
 * multiple NDJSON messages; index-based merge with incremental JSON buffering.
 */
function mergeToolCalls(prev, next) {
  const out = Array.isArray(prev) ? [...prev] : [];
  const argBuffer = new Map(); // index -> accumulated argument string
  for (const tc of next) {
    const idx = typeof tc?.index === "number" ? tc.index : -1;
    if (idx >= 0) {
      if (idx < out.length) {
        const existing = out[idx];
        // Merge incremental function.arguments if string-chunked
        if (typeof tc.function?.arguments === "string" && typeof existing.function?.arguments === "string") {
          const cur = argBuffer.get(idx) ?? existing.function.arguments;
          const add = tc.function.arguments;
          const merged = cur + add;
          argBuffer.set(idx, merged);
          existing.function.arguments = merged;
          try { existing.function.arguments = JSON.parse(merged); } catch { /* keep as string until complete */ }
        } else if (tc.function) {
          // Shallow merge other fields
          out[idx] = { ...existing, ...tc, function: { ...existing.function, ...tc.function } };
        }
      } else {
        // Fill gaps if needed
        while (out.length < idx) out.push({ function: { name: "_gap" } });
        out.push(tc);
        if (typeof tc.function?.arguments === "string") argBuffer.set(idx, tc.function.arguments);
      }
    } else {
      // No index: dedup by JSON signature but also handle incremental same-name calls
      const sig = JSON.stringify(tc.function ?? tc);
      const existingIdx = out.findIndex((o) => JSON.stringify(o.function ?? o) === sig);
      if (existingIdx === -1) {
        // Check if same tool name exists and arguments are incremental
        const name = tc.function?.name;
        const sameNameIdx = name ? out.findIndex((o) => o.function?.name === name) : -1;
        if (sameNameIdx !== -1 && typeof tc.function?.arguments === "string" && typeof out[sameNameIdx].function?.arguments === "string") {
          const cur = out[sameNameIdx].function.arguments;
          out[sameNameIdx].function.arguments = cur + tc.function.arguments;
          try { out[sameNameIdx].function.arguments = JSON.parse(out[sameNameIdx].function.arguments); } catch {}
        } else {
          out.push(tc);
        }
      }
    }
  }
  return out;
}

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
      // exact → case-insensitive exact → prefix fallback
      let match = names.find((n) => n === preferredModel);
      if (!match) match = names.find((n) => n.toLowerCase() === preferredModel.toLowerCase());
      if (!match) match = names.find((n) => n.toLowerCase().startsWith(preferredModel.toLowerCase()));
      if (match) return match;
    }

    if (activeModel && !excludeSet.has(activeModel.toLowerCase())) {
      let activeMatch = names.find((n) => n === activeModel);
      if (!activeMatch) activeMatch = names.find((n) => n.toLowerCase() === activeModel.toLowerCase());
      if (!activeMatch) activeMatch = names.find((n) => n.toLowerCase().startsWith(activeModel.toLowerCase()));
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
  signal,
}) {
  const failedModels = [];
  let targetModel = model || (await resolveAvailableModel(null, host));
  let attemptThink = resolveThinkFlag();

  while (targetModel) {
    try {
      const body = { model: targetModel, messages, stream: true };
      if (tools && tools.length) body.tools = tools;
      if (attemptThink) body.think = true;

      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
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
        // Model does not support thinking → retry same model without it
        if (attemptThink && res.status === 400 && /think/i.test(cleanMsg)) {
          attemptThink = false;
          continue;
        }
        const err = new Error(`Ollama /api/chat failed (${res.status}): ${cleanMsg}`);
        err.status = res.status;
        throw err;
      }

      if (signal?.aborted) {
        const abortErr = new Error("Request aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }

      if (!res.body) {
        const text = await res.text().catch(() => "");
        const msg = `Ollama empty response body (status ${res.status}) : ${text.slice(0,500)}`;
        throw new Error(msg);
      }
      // Support both WHATWG ReadableStream and Node 18+ fetch (which may not have getReader)
      let reader;
      try {
        reader = res.body.getReader ? res.body.getReader() : null;
      } catch { reader = null; }
      if (!reader) {
        // Fallback: read as text and parse NDJSON lines in bulk
        const raw = await res.text();
        const lines = raw.split("\n").filter(Boolean);
        let content = "";
        let thinking = "";
        let toolCalls = null;
        for (const line of lines) {
          let chunk;
          try { chunk = JSON.parse(line); } catch { continue; }
          const msg = chunk.message;
          if (msg?.thinking) { thinking += msg.thinking; onThinking?.(msg.thinking); }
          if (msg?.content) { content += msg.content; onContent?.(msg.content); }
          if (msg?.tool_calls?.length) toolCalls = mergeToolCalls(toolCalls, msg.tool_calls);
        }
        setActiveModel(targetModel);
        return { role: "assistant", content, thinking: thinking || undefined, tool_calls: toolCalls || undefined };
      }
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
            toolCalls = mergeToolCalls(toolCalls, msg.tool_calls);
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
