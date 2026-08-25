/**
 * Permission Gate System
 * ----------------------
 * Two execution modes:
 *   • confirm  — dangerous tools require interactive y/n approval from the
 *                user before executing ("y" once, "a" always-for-session).
 *                Sub-agents have no approval channel, so their dangerous
 *                calls are DENIED in this mode.
 *   • auto     — AUTO-DRIVE: everything runs without prompting (previous
 *                Fixy behavior).
 */

export const PERMISSION_MODES = ["confirm", "auto"];

let mode = normalizeMode(process.env.FIXY_MODE) || "auto";

function normalizeMode(m) {
  const v = String(m ?? "").trim().toLowerCase();
  if (v === "confirm" || v === "y-n") return "confirm";
  if (v === "auto" || v === "auto-drive" || v === "autodrive") return "auto";
  return null;
}

export function getMode() {
  return mode;
}

export function setMode(next) {
  const normalized = normalizeMode(next);
  if (!normalized) {
    throw new Error(`Invalid mode "${next}". Allowed: ${PERMISSION_MODES.join(", ")}`);
  }
  mode = normalized;
  return mode;
}

// --- Tool danger classification -------------------------------------------

const ALWAYS_DANGEROUS = new Set([
  "run_command",
  "write_file",
  "edit_file",
  "batch_edit",
  "web_download",
  "define_agent", // mutates the persisted agent registry
]);

const GIT_READ_ONLY = new Set(["status", "diff", "log", "blame"]);

/**
 * Decide whether a tool call can mutate the system, files, or network state.
 */
export function isDangerous(toolName, args = {}) {
  if (toolName === "git_action") {
    return !GIT_READ_ONLY.has(String(args.action ?? ""));
  }
  if (toolName === "manage_background_tasks") {
    return ["kill", "send_input"].includes(args.action);
  }
  return ALWAYS_DANGEROUS.has(toolName);
}

// --- Session allowlist ------------------------------------------------------

const sessionAllowlist = new Set();

function allowKeys(toolName, args) {
  const keys = [toolName];
  if (toolName === "run_command" && typeof args.command === "string" && args.command.trim()) {
    keys.push(`run_command:${args.command.trim()}`);
  }
  return keys;
}

export function allowForSession(toolName, args = {}) {
  for (const k of allowKeys(toolName, args)) sessionAllowlist.add(k);
}

export function clearSessionAllowlist() {
  sessionAllowlist.clear();
}

export function listSessionAllowlist() {
  return Array.from(sessionAllowlist);
}

// --- Approval channel --------------------------------------------------------

let confirmHandler = null;

/**
 * Register the interactive prompt implementation (wired up by bin/fixy.js).
 * handler({ name, args }) => Promise<"yes"|"no"|"always">
 */
export function setConfirmHandler(handler) {
  confirmHandler = handler;
}

/**
 * Central gate consulted by runTool() before every tool execution.
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
export async function requestApproval(toolName, args = {}, { interactive = false } = {}) {
  if (mode === "auto") return { allowed: true };
  if (!isDangerous(toolName, args)) return { allowed: true };

  // Session-level "always allow" shortcuts
  if (allowKeys(toolName, args).some((k) => sessionAllowlist.has(k))) {
    return { allowed: true };
  }

  // Non-interactive contexts (subagents, background tasks) cannot prompt
  if (!interactive || !confirmHandler) {
    return {
      allowed: false,
      reason:
        `confirm mode blocks "${toolName}" outside the main conversation ` +
        `(no approval channel). Switch to /mode auto to grant full autonomy.`,
    };
  }

  let answer = "no";
  try {
    answer = await confirmHandler({ name: toolName, args });
  } catch {
    answer = "no";
  }

  if (answer === "always") {
    allowForSession(toolName, args);
    return { allowed: true };
  }
  if (answer === "yes") return { allowed: true };
  return { allowed: false, reason: "denied by user" };
}
