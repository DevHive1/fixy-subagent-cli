import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const SESSION_DIR = path.join(os.homedir(), ".fixy", "sessions");
const LATEST = path.join(SESSION_DIR, "latest.json");
const MAX_SAVED_SESSIONS = 30;

/**
 * Generates a unique, short session ID.
 */
export function generateSessionId() {
  return crypto.randomBytes(5).toString("hex"); // e.g. '4ec49f1eaa'
}

/**
 * Persist conversation history + scratchpad memory + model/provider to disk.
 * If sessionId is provided, it saves to ~/.fixy/sessions/<sessionId>.json.
 * Always updates 'latest.json' for quick resume with `fixy -c`.
 */
export async function saveSession({ history, memory, sessionId, model, provider }) {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
    try { await fs.chmod(SESSION_DIR, 0o700); } catch {}

    const payload = JSON.stringify({ 
      sessionId,
      model: model || null,
      provider: provider || null,
      savedAt: new Date().toISOString(), 
      history: history || [], 
      memory: memory || {},
    }, null, 2);

    // 1. Save to the specific session file
    if (sessionId) {
      const cleanId = sessionId.replace(/\.json$/i, "");
      const sessionPath = path.join(SESSION_DIR, `${cleanId}.json`);
      await fs.writeFile(sessionPath, payload, { encoding: "utf8", mode: 0o600 });
      try { await fs.chmod(sessionPath, 0o600); } catch {}
    }

    // 2. Always update 'latest.json' for quick resume
    await fs.writeFile(LATEST, payload, { encoding: "utf8", mode: 0o600 });
    try { await fs.chmod(LATEST, 0o600); } catch {}

    // 3. Rotate history — keep most recent sessions sorted by file modification time (mtime)
    try {
      const files = await fs.readdir(SESSION_DIR);
      const sessionFiles = [];
      for (const f of files) {
        if (f.endsWith(".json") && f !== "latest.json") {
          const fullPath = path.join(SESSION_DIR, f);
          const stat = await fs.stat(fullPath).catch(() => null);
          if (stat) {
            sessionFiles.push({ file: f, path: fullPath, mtimeMs: stat.mtimeMs });
          }
        }
      }

      // Sort oldest first
      sessionFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

      if (sessionFiles.length > MAX_SAVED_SESSIONS) {
        const toDelete = sessionFiles.slice(0, sessionFiles.length - MAX_SAVED_SESSIONS);
        for (const item of toDelete) {
          try { await fs.unlink(item.path); } catch {}
        }
      }
    } catch {}
  } catch (err) {
    console.error(`[session] save failed: ${err.message}`);
  }
}

/**
 * Load a session by ID, prefix, or latest.
 */
export async function loadSession(sessionId = null) {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });

    if (!sessionId) {
      const raw = await fs.readFile(LATEST, "utf8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data.history)) return null;
      return data;
    }

    const cleanId = sessionId.trim().replace(/\.json$/i, "");

    // 1. Check exact match
    const exactPath = path.join(SESSION_DIR, `${cleanId}.json`);
    const exactExists = await fs.stat(exactPath).then(() => true).catch(() => false);
    if (exactExists) {
      const raw = await fs.readFile(exactPath, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.history)) return data;
    }

    // 2. Check prefix or partial match among session files
    const files = await fs.readdir(SESSION_DIR);
    const matchFile = files.find((f) => 
      f.endsWith(".json") && 
      f !== "latest.json" && 
      (f.startsWith(cleanId) || f.replace(/\.json$/i, "").startsWith(cleanId))
    );

    if (matchFile) {
      const raw = await fs.readFile(path.join(SESSION_DIR, matchFile), "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.history)) return data;
    }

    // 3. Scan files for matching sessionId field (excluding latest.json)
    for (const f of files) {
      if (f.endsWith(".json") && f !== "latest.json") {
        try {
          const raw = await fs.readFile(path.join(SESSION_DIR, f), "utf8");
          const data = JSON.parse(raw);
          if (data.sessionId === cleanId && Array.isArray(data.history)) {
            return data;
          }
        } catch {}
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * List all saved sessions metadata.
 */
export async function listSessions() {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
    const files = await fs.readdir(SESSION_DIR);
    const results = [];

    for (const f of files) {
      if (f.endsWith(".json") && f !== "latest.json") {
        try {
          const fullPath = path.join(SESSION_DIR, f);
          const raw = await fs.readFile(fullPath, "utf8");
          const data = JSON.parse(raw);
          const stat = await fs.stat(fullPath);
          
          let preview = "";
          if (Array.isArray(data.history)) {
            const lastUserMsg = [...data.history].reverse().find((m) => m.role === "user");
            if (lastUserMsg?.content) {
              preview = String(lastUserMsg.content).replace(/\n/g, " ").slice(0, 60);
            }
          }

          results.push({
            sessionId: data.sessionId || f.replace(/\.json$/i, ""),
            file: f,
            savedAt: data.savedAt || stat.mtime.toISOString(),
            mtimeMs: stat.mtimeMs,
            messageCount: Array.isArray(data.history) ? data.history.length : 0,
            model: data.model || "default",
            provider: data.provider || "ollama",
            preview,
          });
        } catch {}
      }
    }

    // Sort newest first
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return results;
  } catch {
    return [];
  }
}

export async function clearSession(sessionId = null) {
  try {
    if (sessionId) {
      const cleanId = sessionId.replace(/\.json$/i, "");
      await fs.unlink(path.join(SESSION_DIR, `${cleanId}.json`)).catch(() => {});
    } else {
      await fs.unlink(LATEST).catch(() => {});
    }
  } catch {
    // nothing to clear
  }
}
