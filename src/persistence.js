import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const SESSION_DIR = path.join(os.homedir(), ".fixy", "sessions");
const LATEST = path.join(SESSION_DIR, "latest.json");

/**
 * Generates a unique, short session ID.
 */
export function generateSessionId() {
  return crypto.randomBytes(5).toString("hex"); // e.g. '28892bhhshs' (approx)
}

/**
 * Persist conversation history + scratchpad memory to disk.
 * If sessionId is provided, it saves to a specific file.
 * Always updates 'latest.json' to allow `fixy -c` to resume the most recent work.
 */
export async function saveSession({ history, memory, sessionId }) {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
    try { await fs.chmod(SESSION_DIR, 0o700); } catch {}

    const payload = JSON.stringify({ 
      sessionId,
      savedAt: new Date().toISOString(), 
      history, 
      memory 
    }, null, 2);

    // 1. Save to the specific session file
    if (sessionId) {
      const sessionPath = path.join(SESSION_DIR, `${sessionId}.json`);
      await fs.writeFile(sessionPath, payload, { encoding: "utf8", mode: 0o600 });
      try { await fs.chmod(sessionPath, 0o600); } catch {}
    }

    // 2. Always update 'latest.json' for quick resume
    await fs.writeFile(LATEST, payload, { encoding: "utf8", mode: 0o600 });
    try { await fs.chmod(LATEST, 0o600); } catch {}

    // 3. Rotate history — keep last 10 named sessions (excluding latest.json)
    try {
      const files = await fs.readdir(SESSION_DIR);
      const jsons = files
        .filter((f) => f.endsWith(".json") && f !== "latest.json")
        .sort((a, b) => {
          // This is a naive sort, but works for most cases
          return a.localeCompare(b);
        });
      if (jsons.length > 10) {
        for (const f of jsons.slice(0, jsons.length - 10)) {
          try { await fs.unlink(path.join(SESSION_DIR, f)); } catch {}
        }
      }
    } catch {}
  } catch (err) {
    console.error(`[session] save failed: ${err.message}`);
  }
}

/**
 * Load a session. 
 * If sessionId is provided, loads that specific file.
 * If sessionId is null, loads the most recent session from 'latest.json'.
 */
export async function loadSession(sessionId = null) {
  try {
    const filePath = sessionId 
      ? path.join(SESSION_DIR, `${sessionId}.json`) 
      : LATEST;
      
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.history)) return null;
    return { 
      history: data.history, 
      memory: data.memory || {}, 
      savedAt: data.savedAt, 
      sessionId: data.sessionId 
    };
  } catch {
    return null;
  }
}

export async function clearSession(sessionId = null) {
  try {
    if (sessionId) {
      await fs.unlink(path.join(SESSION_DIR, `${sessionId}.json`));
    } else {
      await fs.unlink(LATEST);
    }
  } catch {
    // nothing to clear
  }
}
