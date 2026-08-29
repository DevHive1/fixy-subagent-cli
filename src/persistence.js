import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_DIR = path.join(os.homedir(), ".fixy", "sessions");
const LATEST = path.join(SESSION_DIR, "latest.json");

/**
 * Persist conversation history + scratchpad memory to disk.
 * Called after each completed turn so `fixy -c` can resume.
 * Rotates up to 10 historic sessions and secures perms 0o700/0o600 on Termux.
 */
export async function saveSession({ history, memory }) {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
    try { await fs.chmod(SESSION_DIR, 0o700); } catch {}
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), history, memory }, null, 2);
    await fs.writeFile(LATEST, payload, { encoding: "utf8", mode: 0o600 });
    try { await fs.chmod(LATEST, 0o600); } catch {}
    // Rotate history — keep last 10 by timestamp
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const arch = path.join(SESSION_DIR, `${ts}.json`);
    try { await fs.writeFile(arch, payload, { encoding: "utf8", mode: 0o600 }); } catch {}
    // GC old sessions beyond 10
    try {
      const files = await fs.readdir(SESSION_DIR);
      const jsons = files.filter((f) => f.endsWith(".json") && f !== "latest.json").sort();
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
 * Load the most recent session. Returns null when none exists.
 */
export async function loadSession() {
  try {
    const raw = await fs.readFile(LATEST, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.history)) return null;
    return { history: data.history, memory: data.memory || {}, savedAt: data.savedAt };
  } catch {
    return null;
  }
}

export async function clearSession() {
  try {
    await fs.unlink(LATEST);
  } catch {
    // nothing to clear
  }
}
