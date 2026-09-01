import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

export const FIXY_DIR = path.join(os.homedir(), ".fixy");
export const CONFIG_FILE = path.join(FIXY_DIR, "config.json");

export const DEFAULT_PROVIDER = process.env.FIXY_PROVIDER || "ollama";
export const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

export const MAX_OUTPUT = 15000;
export const MAX_ROUNDS_DEFAULT = parseInt(process.env.FIXY_MAX_ROUNDS, 10) || 30;
export const LLM_TIMEOUT_MS = parseInt(process.env.FIXY_LLM_TIMEOUT_MS, 10) || 120000;

export const SESSION_DIR = path.join(FIXY_DIR, "sessions");
export const LATEST_SESSION = path.join(SESSION_DIR, "latest.json");
export const AGENTS_FILE = path.join(FIXY_DIR, "agents.json");
export const PLUGINS_DIR = path.join(FIXY_DIR, "plugins");
export const MCP_FILE = path.join(FIXY_DIR, "mcp.json");
export const MEMORY_DIR = path.join(FIXY_DIR, "memory");
export const BACKUP_DIR = path.join(FIXY_DIR, "backups");
export const MODELS_CACHE = path.join(FIXY_DIR, "models-cache.json");
export const ALLOWLIST_DIR = path.join(FIXY_DIR, "allowlist");

export const FIXY_SANDBOX = process.env.FIXY_SANDBOX === "1" || process.env.FIXY_SANDBOX === "true";
export const FIXY_ALLOW_OUTSIDE = process.env.FIXY_ALLOW_OUTSIDE === "1" || false;

export const DOWNLOAD_MAX_BYTES_DEFAULT = 20 * 1024 * 1024; // 20MB (down from 100MB)
export const MEMORY_MAX_ENTRIES = 5000;

let cachedConfig = null;

/**
 * Load global user config from ~/.fixy/config.json
 */
export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    cachedConfig = JSON.parse(raw);
    return { ...cachedConfig };
  } catch {
    cachedConfig = {};
    return {};
  }
}

/**
 * Synchronous get of cached config (or empty object if not loaded yet)
 */
export function getConfigSync() {
  return cachedConfig ? { ...cachedConfig } : {};
}

/**
 * Save patch to ~/.fixy/config.json with 0o600 permissions
 */
export async function saveConfig(patch = {}) {
  try {
    await fs.mkdir(FIXY_DIR, { recursive: true, mode: 0o700 });
    const current = await loadConfig();
    const updated = { ...current, ...patch };
    cachedConfig = updated;
    await fs.writeFile(CONFIG_FILE, JSON.stringify(updated, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    return updated;
  } catch (err) {
    console.error("Warning: Failed to save config:", err.message);
    return null;
  }
}

/**
 * Resolve OpenRouter API Key from env, cached config, or null
 */
export function getOpenRouterApiKey() {
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY.trim();
  }
  const config = getConfigSync();
  return config.openrouterApiKey ? String(config.openrouterApiKey).trim() : null;
}

/**
 * Set and persist OpenRouter API Key
 */
export async function setOpenRouterApiKey(key) {
  if (key) {
    process.env.OPENROUTER_API_KEY = key.trim();
    await saveConfig({ openrouterApiKey: key.trim() });
  }
}
