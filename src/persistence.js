import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_DIR = path.join(os.homedir(), ".fixy", "sessions");
const LATEST = path.join(SESSION_DIR, "latest.json");

/**
 * Persist conversation history + scratchpad memory to disk.
 * Called after each completed turn so `fixy -c` can resume.
 */
export async function saveSession({ history, memory }) {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.writeFile(
      LATEST,
      JSON.stringify({ savedAt: new Date().toISOString(), history, memory }, null, 2),
      "utf8"
    );
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
