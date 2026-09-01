import { OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL, getOpenRouterApiKey } from "./config.js";

let activeModel = process.env.OPENROUTER_MODEL || null;
let cachedFreeModels = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const POPULAR_OPENROUTER_MODELS = [];
export const FREE_OPENROUTER_MODELS = [];

/**
 * Check if an OpenRouter model object is 100% free.
 */
function isModelFree(m) {
  if (!m || !m.id) return false;
  if (m.id === "openrouter/free" || m.id.endsWith(":free")) return true;
  if (m.pricing) {
    const p = parseFloat(m.pricing.prompt ?? 0);
    const c = parseFloat(m.pricing.completion ?? 0);
    const r = parseFloat(m.pricing.request ?? 0);
    const i = parseFloat(m.pricing.image ?? 0);
    if (p === 0 && c === 0 && r === 0 && i === 0) return true;
  }
  return false;
}

export function getActiveModel() {
  return activeModel || OPENROUTER_DEFAULT_MODEL || "openrouter/free";
}

export function setActiveModel(name) {
  if (name) {
    activeModel = name;
    process.env.OPENROUTER_MODEL = name;
  }
}

/**
 * Fetch and list live free models directly from OpenRouter API.
 * Never hardcodes models; displays the real-time free models directly from OpenRouter.
 */
export async function listModels({ apiKey = getOpenRouterApiKey(), baseUrl = OPENROUTER_BASE_URL, forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedFreeModels && (now - lastFetchTime) < CACHE_TTL_MS) {
    return cachedFreeModels;
  }

  try {
    const headers = {
      "HTTP-Referer": "https://github.com/DevHive1/fixy-subagent-cli",
      "X-Title": "fixy-agent",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${baseUrl}/models`, { headers });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.data)) {
        const freeModels = data.data
          .filter(isModelFree)
          .map((m) => ({
            name: m.name || m.id,
            id: m.id,
            description: `${m.name || m.id} [FREE]`,
            context_length: m.context_length,
            pricing: m.pricing,
          }));

        // Sort openrouter/free first, then alphabetical
        freeModels.sort((a, b) => {
          if (a.id === "openrouter/free") return -1;
          if (b.id === "openrouter/free") return 1;
          return a.id.localeCompare(b.id);
        });

        if (freeModels.length > 0) {
          cachedFreeModels = freeModels;
          lastFetchTime = now;
          return freeModels;
        }
      }
    }
  } catch (err) {
    if (cachedFreeModels) return cachedFreeModels;
  }

  // Fallback if network is unreachable
  return cachedFreeModels || [
    { id: "openrouter/free", name: "Free Models Router", description: "Automatic Free Models Router [FREE]" }
  ];
}

/**
 * Resolve an OpenRouter model name dynamically against live free models.
 */
export async function resolveAvailableModel(preferredModel) {
  if (preferredModel && preferredModel.trim()) {
    const trimmed = preferredModel.trim();
    const liveModels = await listModels();

    // 1. Exact match in live free models
    const exact = liveModels.find((m) => m.id.toLowerCase() === trimmed.toLowerCase());
    if (exact) return exact.id;

    // 2. Suffix match without :free
    const suffix = liveModels.find(
      (m) => m.id.replace(/:free$/i, "").toLowerCase() === trimmed.toLowerCase() ||
             m.id.toLowerCase().includes(trimmed.toLowerCase())
    );
    if (suffix) return suffix.id;

    // 3. If model contains '/' and doesn't end with :free, check if :free variant exists
    if (trimmed.includes("/") && !trimmed.endsWith(":free")) {
      const withFree = `${trimmed}:free`;
      const matchFree = liveModels.find((m) => m.id.toLowerCase() === withFree.toLowerCase());
      if (matchFree) return matchFree.id;
      return withFree;
    }
    return trimmed;
  }

  if (activeModel) return activeModel;
  const live = await listModels();
  return live[0]?.id || "openrouter/free";
}

/**
 * Format conversation history into clean OpenAI / OpenRouter message objects.
 */
export function formatMessagesForOpenRouter(messages) {
  const formatted = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "system") {
      formatted.push({ role: "system", content: String(msg.content ?? "") });
    } else if (msg.role === "user") {
      formatted.push({ role: "user", content: String(msg.content ?? "") });
    } else if (msg.role === "assistant") {
      const assistantMsg = {
        role: "assistant",
        content: msg.content !== undefined && msg.content !== null ? String(msg.content) : null,
      };
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        assistantMsg.tool_calls = msg.tool_calls.map((tc, idx) => {
          let argsStr = "{}";
          if (tc.function?.arguments !== undefined) {
            argsStr = typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          }
          return {
            id: tc.id || `call_${idx}_${Date.now()}`,
            type: "function",
            function: {
              name: tc.function?.name || "unknown",
              arguments: argsStr,
            },
          };
        });
      }
      formatted.push(assistantMsg);
    } else if (msg.role === "tool") {
      // Find matching tool call id from preceding assistant message if missing
      let callId = msg.tool_call_id;
      if (!callId) {
        for (let j = formatted.length - 1; j >= 0; j--) {
          if (formatted[j].role === "assistant" && formatted[j].tool_calls?.length) {
            const match = formatted[j].tool_calls.find((tc) => tc.function.name === (msg.name || msg.tool_name));
            if (match) {
              callId = match.id;
              break;
            }
          }
        }
      }
      formatted.push({
        role: "tool",
        tool_call_id: callId || `call_${i}_${Date.now()}`,
        name: msg.name || msg.tool_name || undefined,
        content: String(msg.content ?? ""),
      });
    }
  }

  return formatted;
}

/**
 * Handle HTTP error responses from OpenRouter with actionable hints.
 */
async function handleHttpError(res) {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const json = JSON.parse(text);
    if (json?.error?.message) message = json.error.message;
    else if (json?.message) message = json.message;
  } catch {}

  if (res.status === 401) {
    throw new Error(`OpenRouter authentication failed (401): Invalid API Key. Set OPENROUTER_API_KEY or run /provider to configure. Details: ${message}`);
  }
  if (res.status === 402) {
    throw new Error(`OpenRouter credits depleted (402): Insufficient balance to complete request. Details: ${message}`);
  }
  if (res.status === 429) {
    throw new Error(`OpenRouter rate limit exceeded (429): ${message}`);
  }
  throw new Error(`OpenRouter API error (${res.status}): ${message}`);
}

/**
 * Send a non-streaming chat turn to OpenRouter.
 */
export async function chat({
  model,
  messages,
  tools,
  apiKey = getOpenRouterApiKey(),
  baseUrl = OPENROUTER_BASE_URL,
}) {
  if (!apiKey) {
    throw new Error("OpenRouter API Key not configured. Please export OPENROUTER_API_KEY or configure via /provider.");
  }

  const targetModel = model || (await resolveAvailableModel());
  const formattedMessages = formatMessagesForOpenRouter(messages);

  const body = {
    model: targetModel,
    messages: formattedMessages,
    stream: false,
  };
  if (tools && tools.length) {
    body.tools = tools;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/DevHive1/fixy-subagent-cli",
      "X-Title": "fixy-agent",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    await handleHttpError(res);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new Error("OpenRouter returned an empty choices response.");
  }

  setActiveModel(targetModel);
  const msg = choice.message;
  return {
    role: "assistant",
    content: msg.content || "",
    thinking: msg.reasoning || msg.reasoning_content || msg.thought || undefined,
    tool_calls: msg.tool_calls || undefined,
  };
}

/**
 * Send a streaming chat turn to OpenRouter (SSE).
 */
export async function chatStream({
  model,
  messages,
  tools,
  apiKey = getOpenRouterApiKey(),
  baseUrl = OPENROUTER_BASE_URL,
  onThinking,
  onContent,
  signal,
}) {
  if (!apiKey) {
    throw new Error("OpenRouter API Key not configured. Please export OPENROUTER_API_KEY or configure via /provider.");
  }

  const targetModel = model || (await resolveAvailableModel());
  const formattedMessages = formatMessagesForOpenRouter(messages);

  const body = {
    model: targetModel,
    messages: formattedMessages,
    stream: true,
  };
  if (tools && tools.length) {
    body.tools = tools;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/DevHive1/fixy-subagent-cli",
      "X-Title": "fixy-agent",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    await handleHttpError(res);
  }

  if (signal?.aborted) {
    const abortErr = new Error("Request aborted");
    abortErr.name = "AbortError";
    throw abortErr;
  }

  if (!res.body) {
    throw new Error(`OpenRouter empty response body (status ${res.status})`);
  }

  let content = "";
  let thinking = "";
  const toolCallsMap = new Map(); // index -> { id, name, args }

  function processDataLine(line) {
    if (!line.startsWith("data:")) return;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === "[DONE]") return;

    let chunk;
    try {
      chunk = JSON.parse(jsonStr);
    } catch {
      return;
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    // Stream reasoning/thinking if present
    const thoughtToken = delta.reasoning || delta.reasoning_content || delta.thought;
    if (thoughtToken) {
      thinking += thoughtToken;
      onThinking?.(thoughtToken);
    }

    // Stream content
    if (delta.content) {
      content += delta.content;
      onContent?.(delta.content);
    }

    // Stream tool calls
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let entry = toolCallsMap.get(idx);
        if (!entry) {
          entry = {
            id: tc.id || `call_${idx}_${Math.random().toString(36).slice(2, 10)}`,
            name: tc.function?.name || "",
            args: "",
          };
          toolCallsMap.set(idx, entry);
        } else {
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
        }
        if (tc.function?.arguments) {
          entry.args += tc.function.arguments;
        }
      }
    }
  }

  let reader;
  try {
    reader = res.body.getReader ? res.body.getReader() : null;
  } catch {
    reader = null;
  }

  if (!reader) {
    const raw = await res.text();
    const lines = raw.split("\n");
    for (const line of lines) {
      processDataLine(line.trim());
    }
  } else {
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) processDataLine(line);
      }
    }

    if (buffer.trim()) {
      processDataLine(buffer.trim());
    }
  }

  setActiveModel(targetModel);

  const assembledToolCalls = Array.from(toolCallsMap.values())
    .filter((e) => e.name)
    .map((e) => {
      let parsedArgs = e.args;
      try {
        parsedArgs = JSON.parse(e.args);
      } catch {
        // keep string if not parseable
      }
      return {
        id: e.id,
        type: "function",
        function: {
          name: e.name,
          arguments: parsedArgs,
        },
      };
    });

  return {
    role: "assistant",
    content: content || "",
    thinking: thinking || undefined,
    tool_calls: assembledToolCalls.length > 0 ? assembledToolCalls : undefined,
  };
}
