import path from "node:path";
import os from "node:os";

export const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
export const MAX_OUTPUT = 15000;
export const MAX_ROUNDS_DEFAULT = parseInt(process.env.FIXY_MAX_ROUNDS, 10) || 30;
export const LLM_TIMEOUT_MS = parseInt(process.env.FIXY_LLM_TIMEOUT_MS, 10) || 120000;

export const SESSION_DIR = path.join(os.homedir(), ".fixy", "sessions");
export const LATEST_SESSION = path.join(SESSION_DIR, "latest.json");
export const AGENTS_FILE = path.join(os.homedir(), ".fixy", "agents.json");
export const PLUGINS_DIR = path.join(os.homedir(), ".fixy", "plugins");
export const MCP_FILE = path.join(os.homedir(), ".fixy", "mcp.json");
export const MEMORY_DIR = path.join(os.homedir(), ".fixy", "memory");
export const BACKUP_DIR = path.join(os.homedir(), ".fixy", "backups");
export const MODELS_CACHE = path.join(os.homedir(), ".fixy", "models-cache.json");
export const ALLOWLIST_DIR = path.join(os.homedir(), ".fixy", "allowlist");

export const FIXY_SANDBOX = process.env.FIXY_SANDBOX === "1" || process.env.FIXY_SANDBOX === "true";
export const FIXY_ALLOW_OUTSIDE = process.env.FIXY_ALLOW_OUTSIDE === "1" || false;

export const DOWNLOAD_MAX_BYTES_DEFAULT = 20 * 1024 * 1024; // 20MB (down from 100MB)
export const MEMORY_MAX_ENTRIES = 5000;
