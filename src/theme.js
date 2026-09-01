import chalk from "chalk";

/**
 * Terminal Card Styling & Aesthetic User Interface System
 */

export const colors = {
  primary: chalk.hex("#00f0ff"), // Cyber Cyan
  secondary: chalk.hex("#a855f7"), // Cosmic Purple
  accent: chalk.hex("#38bdf8"), // Sky Blue
  success: chalk.hex("#10b981"), // Emerald Green
  warning: chalk.hex("#f59e0b"), // Amber
  danger: chalk.hex("#ef4444"), // Ruby Red
  dim: chalk.hex("#64748b"), // Slate Gray
  subtle: chalk.hex("#94a3b8"), // Light Slate
  boldWhite: chalk.bold.hex("#f8fafc"),
  highlight: chalk.hex("#e0e7ff"),
  codeBg: chalk.bgHex("#1e293b"),
  tagBg: chalk.bgHex("#0f172a"),
};

import { stripAnsi as utilStripAnsi } from "./utils.js";
export const stripAnsi = utilStripAnsi;
export const colorsFrozen = Object.freeze(colors);

/**
 * Draw a clean border box with flexible headers and footers.
 */
export function renderBox(lines, options = {}) {
  const {
    title = null,
    badge = null,
    borderColor = colors.dim,
    padding = 1,
    minWidth = 64,
  } = options;

  const rawLines = Array.isArray(lines) ? lines : lines.split("\n");

  let contentWidth = minWidth;
  for (const line of rawLines) {
    const len = stripAnsi(line).length;
    if (len > contentWidth) contentWidth = len;
  }

  const titleLen = title ? stripAnsi(title).length + 4 : 0;
  const badgeLen = badge ? stripAnsi(badge).length + 4 : 0;
  if (titleLen + badgeLen > contentWidth) {
    contentWidth = titleLen + badgeLen;
  }

  const innerWidth = contentWidth + padding * 2;
  const pad = " ".repeat(padding);

  let top = "╭─";
  if (title) {
    top += ` ${title} `;
  }
  const usedTop = (title ? stripAnsi(title).length + 4 : 2) + (badge ? stripAnsi(badge).length + 4 : 0);
  const remaining = Math.max(0, innerWidth - usedTop + 2);
  top += "─".repeat(remaining);
  if (badge) {
    top += ` ${badge} ─`;
  }
  top += "╮";

  const bottom = "╰" + "─".repeat(innerWidth + 2) + "╯";

  const formattedLines = rawLines.map((line) => {
    const len = stripAnsi(line).length;
    const rightPad = " ".repeat(Math.max(0, innerWidth - len - padding));
    return borderColor("│") + " " + pad + line + rightPad + " " + borderColor("│");
  });

  return [borderColor(top), ...formattedLines, borderColor(bottom)].join("\n");
}

/**
 * Format the main welcome banner.
 */
export function renderBanner({ model, provider = "ollama", activeTasksCount = 0, agentCount = 7 }) {
  const providerLabel = provider === "openrouter" ? colors.secondary.bold("OpenRouter") : colors.accent.bold("Ollama");
  const modelTag = model ? colors.primary.bold(model) : colors.warning("(none)");
  const bgBadge =
    activeTasksCount > 0
      ? colors.warning.bold(`⚡ ${activeTasksCount} ACTIVE BG TASKS`)
      : colors.dim("0 ACTIVE BG TASKS");
  const agentsBadge = colors.secondary.bold(`✦ ${agentCount} SUB-AGENTS`);

  const lines = [
    `  ${colors.primary.bold("◈  F I X Y")}  ${colors.dim("│")}  ${colors.highlight.bold("Engineering Subsystem v2.0")}`,
    `  ${colors.dim("Autonomous Multi-Agent Engineering & Precision Shell Engine")}`,
    ``,
    `  ${colors.dim("Provider:")} ${providerLabel}   ${colors.dim("•")}   ${colors.dim("Model:")} ${modelTag}`,
    `  ${bgBadge}   ${colors.dim("•")}   ${agentsBadge}`,
  ];

  console.log("\n" + renderBox(lines, { borderColor: colors.primary, minWidth: 70 }) + "\n");
  console.log(
    colors.dim(
      "  Type commands or instructions. Use " +
        colors.accent("/help") +
        " for command matrix, " +
        colors.accent("/provider") +
        " to switch provider, " +
        colors.accent("/create-agent") +
        " for Agent Creator.\n"
    )
  );
}

/**
 * Render a professional Tool Card with parameters and formatted results.
 */
export function renderToolCard({ name, args, result, isError = false, durationMs }) {
  const isErr = isError || String(result ?? "").startsWith("ERROR");
  const statusBadge = isErr
    ? colors.danger.bold("[✖ FAILED]")
    : colors.success.bold("[✔ SUCCESS]");
  const durationTag = durationMs ? colors.dim(` (${durationMs}ms)`) : "";

  // Categorize tool for styling border
  let borderColor = colors.dim;
  if (name.includes("agent")) borderColor = colors.secondary;
  else if (name.includes("command") || name.includes("task") || name.includes("load_tester")) borderColor = colors.warning;
  else if (name.includes("file") || name.includes("code") || name.includes("web_scaffold")) borderColor = colors.accent;
  else if (name.includes("git") || name.includes("test_runner") || name.includes("inspector")) borderColor = colors.success;
  else if (name.includes("db_") || name.includes("schema_") || name.includes("port_") || name.includes("hosting_")) borderColor = colors.primary;
  else if (name.includes("api_") || name.includes("auditor")) borderColor = colors.secondary;

  const lines = [];

  // 1. Arguments table
  if (args && typeof args === "object" && Object.keys(args).length > 0) {
    lines.push(colors.dim("Parameters:"));
    for (const [k, v] of Object.entries(args)) {
      let valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (valStr.length > 70) valStr = valStr.slice(0, 70) + "…";
      lines.push(`  ${colors.subtle(k.padEnd(14))} ${colors.dim(":")} ${colors.boldWhite(valStr)}`);
    }
    lines.push("");
  }

  // 2. Result output preview
  const resStr = String(result ?? "(no output)");
  const resultLines = resStr.split("\n");
  const maxLines = 6;
  const previewLines = resultLines.slice(0, maxLines);

  lines.push(colors.dim("Execution Result:"));
  for (const rLine of previewLines) {
    lines.push(`  ${isErr ? colors.danger(rLine) : colors.highlight(rLine)}`);
  }
  if (resultLines.length > maxLines) {
    lines.push(colors.dim(`  … (+${resultLines.length - maxLines} more lines)`));
  }

  return renderBox(lines, {
    title: colors.warning.bold(`⚙ TOOL: ${name}`) + durationTag,
    badge: statusBadge,
    borderColor: isErr ? colors.danger : borderColor,
    minWidth: 68,
  });
}

/**
 * Render a professional Sub-Agent Profile Card.
 */
export function renderSubagentProfileCard(agent) {
  const typeTag = agent.isCustom
    ? colors.secondary.bold("[CUSTOM SPECIALIST]")
    : colors.accent.bold("[CORE AGENT]");
  const count = agent.toolsCount ?? (Array.isArray(agent.allowedTools) ? agent.allowedTools.length : "all");
  const toolsTag = count === "all" ? "ALL TOOLS (Full Access)" : `${count} Tools`;
  const roundsTag = `${agent.maxRounds || 20} max rounds`;
  const modelTag = agent.model || "inherit";

  const lines = [
    `${colors.boldWhite(agent.role)}`,
    `${colors.dim("Domain:")} ${colors.subtle(agent.description)}`,
    ``,
    `${colors.dim("Permissions:")} ${colors.primary(toolsTag)}   ${colors.dim("•")}   ${colors.warning(roundsTag)}   ${colors.dim("•")}   ${colors.dim("Model:")} ${colors.accent(modelTag)}`,
  ];

  return renderBox(lines, {
    title: colors.secondary.bold(`✦ [${agent.name.toUpperCase()}]`),
    badge: typeTag,
    borderColor: agent.isCustom ? colors.secondary : colors.accent,
    minWidth: 68,
  });
}

/**
 * Render a professional Background Shell Task Card.
 */
export function renderBackgroundTaskCard(task) {
  const isRunning = task.status === "running";
  const isSuccess = task.status === "completed";
  const statusBadge = isRunning
    ? colors.warning.bold("[● RUNNING]")
    : isSuccess
    ? colors.success.bold("[● COMPLETED]")
    : colors.danger.bold(`[● ${task.status.toUpperCase()}]`);

  const lines = [
    `${colors.dim("Process PID:")} ${colors.boldWhite(String(task.pid))}    ${colors.dim("Duration:")} ${colors.accent(task.duration)}    ${colors.dim("Exit Code:")} ${task.exitCode !== null ? colors.boldWhite(String(task.exitCode)) : colors.dim("N/A")}`,
    `${colors.dim("Command:")}     ${colors.primary.bold("$ " + task.command)}`,
    `${colors.dim("Working Dir:")} ${colors.subtle(task.cwd)}`,
  ];

  if (task.logs && task.logs.length > 0) {
    lines.push("");
    lines.push(colors.dim("Recent Logs (Tail):"));
    const tail = task.logs.slice(-3);
    for (const log of tail) {
      lines.push(`  ${colors.dim(`[${log.type}]`)} ${colors.highlight(log.text.slice(0, 65))}`);
    }
  }

  return renderBox(lines, {
    title: colors.warning.bold(`⚡ [SHELL TASK: ${task.id}]`),
    badge: statusBadge,
    borderColor: isRunning ? colors.warning : isSuccess ? colors.success : colors.danger,
    minWidth: 68,
  });
}

/**
 * Render a professional Background Sub-Agent Task Card.
 */
export function renderSubagentTaskCard(task) {
  const isRunning = task.status === "running";
  const isSuccess = task.status === "completed";
  const statusBadge = isRunning
    ? colors.warning.bold("[● EXECUTING]")
    : isSuccess
    ? colors.success.bold("[● COMPLETED]")
    : colors.danger.bold(`[● ${task.status.toUpperCase()}]`);

  const bgTag = task.background ? colors.secondary("[BACKGROUND]") : colors.dim("[FOREGROUND]");

  const lines = [
    `${colors.dim("Specialist:")} ${colors.boldWhite(task.agentName)}  ${colors.highlight(`(${task.role})`)}`,
    `${colors.dim("Duration:")}   ${colors.accent(task.duration)}   ${colors.dim("•")}   ${bgTag}`,
    `${colors.dim("Task:")}       ${colors.subtle(task.taskPrompt.slice(0, 75))}${task.taskPrompt.length > 75 ? "…" : ""}`,
  ];

  if (task.output) {
    lines.push("");
    lines.push(colors.dim("Findings / Output Preview:"));
    const outLines = String(task.output).split("\n").slice(0, 4);
    for (const ol of outLines) {
      lines.push(`  ${colors.highlight(ol.slice(0, 70))}`);
    }
  }

  return renderBox(lines, {
    title: colors.secondary.bold(`✦ [SUBAGENT TASK: ${task.id}]`),
    badge: statusBadge,
    borderColor: isRunning ? colors.secondary : isSuccess ? colors.success : colors.danger,
    minWidth: 68,
  });
}

/**
 * Render the full categorized Command Matrix.
 */
export function renderCommandMatrix(currentRounds = 30) {
  const lines = [
    `${colors.primary.bold("🚀 CORE OPERATIONS")}`,
    `  ${colors.accent.bold("/help")}                     Display this command palette`,
    `  ${colors.accent.bold("/provider [name]")}          Switch provider (ollama / openrouter)`,
    `  ${colors.accent.bold("/model [name]")}             Switch or pick model`,
    `  ${colors.accent.bold("/sessions")}                 List all saved sessions`,
    `  ${colors.accent.bold("/history, /chat")}           Replay full conversation history`,
    `  ${colors.accent.bold("/mode [confirm|auto]")}      Set permission / safety mode`,
    `  ${colors.accent.bold("/rounds [n]")}               Set/view max tool rounds limit ${colors.dim(`(current: ${currentRounds})`)}`,
    `  ${colors.accent.bold("/clear")}                    Reset conversation context`,
    `  ${colors.accent.bold("/exit, /quit")}              Exit Fixy CLI`,
    ``,
    `${colors.secondary.bold("✦ MULTI-AGENT SUBSYSTEM")}`,
    `  ${colors.accent.bold("/agents, /subagents")}       Explore available specialized sub-agents`,
    `  ${colors.accent.bold("/create-agent")}             Launch interactive Agent Creator wizard`,
    `  ${colors.accent.bold("/subtasks")}                 List background sub-agent execution tasks`,
    ``,
    `${colors.warning.bold("⚡ BACKGROUND EXECUTION")}`,
    `  ${colors.accent.bold("/tasks, /bg")}               List active and completed background commands`,
    `  ${colors.accent.bold("/logs <task-id>")}           Inspect live logs for a background task`,
    `  ${colors.accent.bold("/kill <task-id>")}           Terminate a running background task or subagent`,
    ``,
    `${colors.success.bold("📊 SYSTEM & DIAGNOSTICS")}`,
    `  ${colors.accent.bold("/diagnostics, /info")}       Inspect CPU, memory, uptime, and host stats`,
  ];

  return renderBox(lines, {
    title: colors.primary.bold("◈ FIXY COMMAND MATRIX"),
    borderColor: colors.primary,
    minWidth: 70,
  });
}

/**
 * Format thinking header.
 */
export function formatThinkingStart() {
  return colors.dim.italic("\n  · 🧠 [Reasoning Engine]\n  ");
}

export function formatToolHeader(name, args) {
  let preview = "";
  try {
    const raw = typeof args === "string" ? args : JSON.stringify(args);
    preview = raw.length > 85 ? raw.slice(0, 85) + "…" : raw;
  } catch {
    preview = String(args);
  }
  return colors.warning(`  ⚙ ${name}`) + " " + colors.dim(`(${preview})`);
}

export function formatToolResult(result, isError = false) {
  const str = String(result ?? "");
  const lines = str.split("\n");
  const maxLines = 4;
  const firstLines = lines.slice(0, maxLines).join("\n    ");
  const truncatedNote =
    lines.length > maxLines
      ? colors.dim(`\n    … (+${lines.length - maxLines} more lines)`)
      : "";

  const prefix = isError ? colors.danger("  ✖ ") : colors.dim("  └ ");
  return prefix + (isError ? colors.danger(firstLines) : colors.subtle(firstLines)) + truncatedNote;
}

export function formatAgentBadge(role, name = "") {
  const tag = name ? `${role} (${name})` : role;
  return colors.secondary.bold(`✦ [${tag}]`);
}
