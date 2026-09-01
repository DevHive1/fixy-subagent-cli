import * as ollama from "./ollama.js";
import * as openrouter from "./openrouter.js";
import {
  DEFAULT_PROVIDER,
  DEFAULT_HOST,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  getOpenRouterApiKey,
  saveConfig,
} from "./config.js";

let activeProvider = process.env.FIXY_PROVIDER || DEFAULT_PROVIDER || "ollama";

export const SUPPORTED_PROVIDERS = ["ollama", "openrouter"];

/**
 * Get the currently active LLM provider ('ollama' or 'openrouter').
 */
export function getActiveProvider() {
  return activeProvider;
}

/**
 * Set the currently active LLM provider.
 */
export async function setActiveProvider(provider) {
  const norm = String(provider).toLowerCase().trim();
  if (!SUPPORTED_PROVIDERS.includes(norm)) {
    throw new Error(`Unsupported provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`);
  }
  activeProvider = norm;
  process.env.FIXY_PROVIDER = norm;
  await saveConfig({ defaultProvider: norm });
  return activeProvider;
}

/**
 * Detect provider from model name format.
 * Models with '/' (e.g. anthropic/claude-3.5-sonnet, deepseek/deepseek-r1) are OpenRouter models.
 */
export function detectProviderForModel(modelName) {
  if (!modelName || typeof modelName !== "string") return null;
  const trimmed = modelName.trim();
  if (trimmed.includes("/")) {
    return "openrouter";
  }
  return null;
}

/**
 * Get active model for the current or specified provider.
 */
export function getActiveModel(provider = activeProvider) {
  if (provider === "openrouter") {
    return openrouter.getActiveModel();
  }
  return ollama.getActiveModel();
}

/**
 * Set active model for the current or specified provider.
 */
export function setActiveModel(name, provider = null) {
  if (!name) return;
  const targetProvider = provider || detectProviderForModel(name) || activeProvider;
  if (targetProvider === "openrouter") {
    openrouter.setActiveModel(name);
  } else {
    ollama.setActiveModel(name);
  }
}

/**
 * List models for the specified or active provider.
 */
export async function listModels(provider = activeProvider, options = {}) {
  if (provider === "openrouter") {
    return openrouter.listModels(options);
  }
  return ollama.listModels(options.host || DEFAULT_HOST);
}

/**
 * Resolve an available model name for the provider.
 */
export async function resolveAvailableModel(preferredModel, provider = null, options = {}) {
  const targetProvider = provider || (preferredModel ? detectProviderForModel(preferredModel) : null) || activeProvider;
  if (targetProvider === "openrouter") {
    return openrouter.resolveAvailableModel(preferredModel);
  }
  return ollama.resolveAvailableModel(preferredModel, options.host || DEFAULT_HOST, options.excludeModels || []);
}

/**
 * Unified non-streaming chat turn routed to active or requested provider.
 */
export async function chat({
  model,
  messages,
  tools,
  provider = null,
  host = DEFAULT_HOST,
  apiKey = getOpenRouterApiKey(),
  baseUrl = OPENROUTER_BASE_URL,
}) {
  const targetProvider = provider || (model ? detectProviderForModel(model) : null) || activeProvider;

  if (targetProvider === "openrouter") {
    return openrouter.chat({
      model,
      messages,
      tools,
      apiKey,
      baseUrl,
    });
  }

  return ollama.chat({
    model,
    messages,
    tools,
    host,
  });
}

/**
 * Unified streaming chat turn routed to active or requested provider.
 */
export async function chatStream({
  model,
  messages,
  tools,
  provider = null,
  host = DEFAULT_HOST,
  apiKey = getOpenRouterApiKey(),
  baseUrl = OPENROUTER_BASE_URL,
  onThinking,
  onContent,
  signal,
}) {
  const targetProvider = provider || (model ? detectProviderForModel(model) : null) || activeProvider;

  if (targetProvider === "openrouter") {
    return openrouter.chatStream({
      model,
      messages,
      tools,
      apiKey,
      baseUrl,
      onThinking,
      onContent,
      signal,
    });
  }

  return ollama.chatStream({
    model,
    messages,
    tools,
    host,
    onThinking,
    onContent,
    signal,
  });
}

export { ollama, openrouter };
