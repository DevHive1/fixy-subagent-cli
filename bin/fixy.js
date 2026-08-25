#!/usr/bin/env node
import chalk from "chalk";
import { listModels, setActiveModel, resolveAvailableModel } from "../src/ollama.js";
import { runTurn, getMaxRounds, setMaxRounds } from "../src/agent.js";
import { LineReader } from "../src/input.js";
import { taskManager } from "../src/taskManager.js";
import { subagentManager } from "../src/subagentManager.js";
import { launchAgentCreator } from "../src/agentCreator.js";
import {
  getMode,
  setMode,
  PERMISSION_MODES,
  setConfirmHandler,
  isDangerous,
} from "../src/permissions.js";
import { saveSession, loadSession, clearSession } from "../src/persistence.js";
import { clearSessionMemory, exportSessionMemory, importSessionMemory, runTool } from "../src/tools.js";
import {
  colors,
  renderBox,
  renderBanner,
  renderToolCard,
  renderSubagentProfileCard,
  renderBackgroundTaskCard,
  renderSubagentTaskCard,
  renderCommandMatrix,
  formatThinkingStart,
  stripAnsi,
} from "../src/theme.js";

// --- CLI arguments -----------------------------------------------------------

function parseCliArgs(argv) {
  const opts = {
    prompt: null,
    json: false,
    cont: false,
    model: process.env.FIXY_MODEL || null,
    mode: null,
    rounds: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-p":
      case "--print":
        opts.prompt = argv[++i];
        if (opts.prompt === undefined) {
          console.error("error: -p/--print requires a prompt string");
          process.exit(2);
        }
        break;
      case "--json":
        opts.json = true;
        break;
      case "-c":
      case "--continue":
        opts.cont = true;
        break;
      case "-m":
      case "--model":
        opts.model = argv[++i];
        break;
      case "--mode":
        opts.mode = argv[++i];
        break;
      case "--rounds":
        opts.rounds = parseInt(argv[++i], 10);
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        console.error(`error: unknown argument "${a}"`);
        process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
${colors.primary.bold("fixy")} — local Ollama-powered coding agent

Usage:
  fixy                              Start interactive REPL
  fixy -p "<prompt>"                One-shot headless run
  fixy -p "<prompt>" --json         Machine-readable JSON output
  fixy -c                           Resume last saved session (interactive)

Options:
  -p, --print <prompt>              Run a single prompt non-interactively
      --json                        Emit JSON { model, output, toolCalls }
  -c, --continue                    Restore previous conversation + memory
  -m, --model <name>                Model override (default $FIXY_MODEL)
      --mode <confirm|auto>         Permission mode (default: confirm interactive / auto headless)
      --rounds <n>                  Max tool rounds (default 30)
  -h, --help                        Show this help

Permission modes:
  confirm   Dangerous tools ask y/n before running ("a" = always this session).
            Sub-agents cannot perform write/exec actions in this mode.
  auto      AUTO-DRIVE: all tools run without prompting.

Interactive commands: /help /model /mode /rounds /agents /create-agent /tasks /subtasks /logs /kill /diagnostics /clear /exit
`);
}

const cli = parseCliArgs(process.argv.slice(2));
const HEADLESS = typeof cli.prompt === "string";

const history = [];
let model = cli.model || null;
const reader = HEADLESS ? null : new LineReader();

// Graceful shutdown — never orphan running background processes
function shutdown() {
  try { taskManager.stopAll(); } catch { /* best effort */ }
  try { reader?.close(); } catch { /* best effort */ }
  process.exit(0);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("exit", () => {
  try { taskManager.stopAll(); } catch { /* best effort */ }
});

// Live event cards (suppressed in headless JSON mode to keep stdout clean)
taskManager.on("task:done", ({ task }) => {
  if (HEADLESS && cli.json) return;
  process.stdout.write(`\n${renderBackgroundTaskCard(task)}\n`);
});
subagentManager.on("subagent:done", ({ task }) => {
  if (HEADLESS && cli.json) return;
  process.stdout.write(`\n${renderSubagentTaskCard(task)}\n`);
});

// Interactive permission gate wiring -----------------------------------------
if (!HEADLESS) {
  setConfirmHandler(async ({ name, args }) => {
    let preview = "";
    try {
      preview = JSON.stringify(args);
    } catch {
      preview = String(args);
    }
    if (preview.length > 160) preview = preview.slice(0, 160) + "…";
    const tag = isDangerous(name, args) ? colors.warning.bold("⚠") : "";
    const answer = await reader.question(
      `\n${tag} ${colors.warning.bold(`PERMIT ${name}?`)} ${colors.dim(preview)}\n` +
      `${colors.accent.bold("[y]es")} / ${colors.danger.bold("[n]o")} / ${colors.success.bold("[a]lways this session")}: `
    );
    const v = String(answer ?? "").trim().toLowerCase();
    if (v === "a" || v === "always") return "always";
    if (v === "y" || v === "yes" || v === "1") return "yes";
    return "no";
  });
}

// --- Model picker ------------------------------------------------------------

async function pickModel() {
  let models;
  try {
    models = await listModels();
  } catch {
    console.log(colors.danger(`\nCould not reach Ollama at ${process.env.OLLAMA_HOST || "http://127.0.0.1:11434"}.`));
    console.log(colors.dim(`Make sure it is running: ${chalk.white("ollama serve")}\n`));
    process.exit(1);
  }
  if (!models.length) {
    console.log(colors.danger("\nNo local Ollama models found. Pull one first, e.g.:"));
    console.log(chalk.white("  ollama pull qwen2.5-coder:1.5b\n"));
    process.exit(1);
  }

  console.log(colors.primary.bold("\nAvailable Ollama Models:"));
  models.forEach((m, i) => {
    const sizeGb = m.size ? ` (${(m.size / 1024 / 1024 / 1024).toFixed(1)} GB)` : "";
    console.log(`  ${colors.accent(i + 1)}.  ${colors.boldWhite(m.name)}${colors.dim(sizeGb)}`);
  });

  const answer = await reader.question(colors.primary.bold("\nPick a model (number or name) [default: 1]: "));
  if (!answer || !answer.trim()) return models[0].name;

  const byIndex = models[parseInt(answer.trim(), 10) - 1];
  const byName = models.find((m) => m.name.toLowerCase() === answer.trim().toLowerCase());
  const chosen = byIndex?.name || byName?.name || models[0].name;
  setActiveModel(chosen);
  console.log(colors.success(`✔ Using model: ${colors.boldWhite(chosen)}`));
  return chosen;
}

// --- Info views ---------------------------------------------------------------

function showHelp() {
  console.log("\n" + renderCommandMatrix(getMaxRounds(), getMode()) + "\n");
}

function showAgentsList() {
  const agents = subagentManager.listAgents();
  console.log("\n" + colors.secondary.bold(`✦ SUB-AGENTS REGISTRY (${agents.length} SPECIALISTS AVAILABLE)\n`));
  for (const agent of agents) {
    console.log(renderSubagentProfileCard(agent) + "\n");
  }
}

function showTasksList() {
  const tasks = taskManager.listTasks();
  if (tasks.length === 0) {
    console.log(colors.dim("\n  (No background shell tasks recorded in this session)\n"));
    return;
  }
  console.log("\n" + colors.warning.bold(`⚡ BACKGROUND SHELL TASKS (${tasks.length})\n`));
  for (const t of tasks) {
    const fullTask = taskManager.getTask(t.id) || t;
    console.log(renderBackgroundTaskCard({ ...fullTask, duration: t.duration }) + "\n");
  }
}

function showSubtasksList() {
  const tasks = subagentManager.listTasks();
  if (tasks.length === 0) {
    console.log(colors.dim("\n  (No sub-agent tasks recorded in this session)\n"));
    return;
  }
  console.log("\n" + colors.secondary.bold(`✦ SUB-AGENT EXECUTION TASKS (${tasks.length})\n`));
  for (const t of tasks) {
    const fullTask = subagentManager.getTask(t.id) || t;
    console.log(renderSubagentTaskCard({ ...fullTask, duration: t.duration }) + "\n");
  }
}

// --- Live Streaming Renderer ---------------------------------------------------

let thinkingOpen = false;
let contentOpen = false;
let currentToolArgs = null;
let currentToolStartTime = null;

function ensureLineBreakBeforeThinking() {
  if (!thinkingOpen) {
    process.stdout.write(formatThinkingStart());
    thinkingOpen = true;
  }
}

function ensureLineBreakBeforeContent() {
  if (thinkingOpen && !contentOpen) {
    process.stdout.write("\n");
  }
  if (!contentOpen) {
    process.stdout.write("\n" + colors.primary.bold("✦ fixy› "));
    contentOpen = true;
  }
}

function resetStream() {
  thinkingOpen = false;
  contentOpen = false;
}

function onThinking(token) {
  ensureLineBreakBeforeThinking();
  process.stdout.write(colors.dim.italic(token.replace(/\n/g, "\n  ")));
}

function onContent(token) {
  ensureLineBreakBeforeContent();
  process.stdout.write(token);
}

function onToolCall(name, args) {
  if (thinkingOpen || contentOpen) process.stdout.write("\n");
  resetStream();
  currentToolArgs = args;
  currentToolStartTime = Date.now();
}

function onToolResult(name, result) {
  const durationMs = currentToolStartTime ? Date.now() - currentToolStartTime : null;
  const isErr = String(result).startsWith("ERROR");
  console.log("\n" + renderToolCard({
    name,
    args: currentToolArgs,
    result,
    isError: isErr,
    durationMs,
  }));
  currentToolArgs = null;
  currentToolStartTime = null;
}

function onRoundStart() {
  resetStream();
}

function serializeForJson(text) {
  return stripAnsi(String(text ?? ""));
}

async function restoreSessionIfRequested() {
  if (!cli.cont) return;

  const session = await loadSession();
  if (!session) {
    if (!HEADLESS || !cli.json) {
      console.log(colors.warning("No saved session found."));
    }
    return;
  }

  history.splice(0, history.length, ...session.history);
  importSessionMemory(session.memory || {});
  if (!HEADLESS || !cli.json) {
    console.log(colors.dim(`Restored session saved at ${session.savedAt || "unknown time"}.`));
  }
}

async function resolveStartupModel() {
  if (model) {
    const resolved = await resolveAvailableModel(model);
    setActiveModel(resolved);
    return resolved;
  }

  if (HEADLESS) {
    const resolved = await resolveAvailableModel(null);
    setActiveModel(resolved);
    return resolved;
  }

  return pickModel();
}

async function runAgentTurn(userMessage) {
  return runTurn({
    model,
    history,
    userMessage,
    maxRounds: getMaxRounds(),
    onToolCall: cli.json ? undefined : onToolCall,
    onToolResult: cli.json ? undefined : onToolResult,
    onThinking: cli.json ? undefined : onThinking,
    onContent: cli.json ? undefined : onContent,
    onRoundStart,
  });
}

async function saveCurrentSession() {
  await saveSession({
    history,
    memory: exportSessionMemory(),
  });
}

async function runHeadless() {
  const capturedToolCalls = [];

  try {
    model = await resolveStartupModel();
    const output = await runTurn({
      model,
      history,
      userMessage: cli.prompt,
      maxRounds: getMaxRounds(),
      onToolCall: cli.json
        ? (name, args) => capturedToolCalls.push({ name, args })
        : onToolCall,
      onToolResult: cli.json
        ? (name, result) => {
            const last = capturedToolCalls[capturedToolCalls.length - 1];
            if (last) last.result = serializeForJson(result);
          }
        : onToolResult,
      onThinking: cli.json ? undefined : onThinking,
      onContent: cli.json ? undefined : onContent,
      onRoundStart,
    });

    await saveCurrentSession();

    if (cli.json) {
      console.log(JSON.stringify({ model, output: serializeForJson(output), toolCalls: capturedToolCalls }, null, 2));
    } else {
      if (!contentOpen && output) process.stdout.write(String(output));
      process.stdout.write("\n");
    }
  } catch (err) {
    if (cli.json) {
      console.log(JSON.stringify({ model, error: serializeForJson(err.message), toolCalls: capturedToolCalls }, null, 2));
    } else {
      console.error(colors.danger(`\nError: ${err.message}`));
    }
    process.exitCode = 1;
  } finally {
    taskManager.stopAll();
  }
}

async function handleSlashCommand(trimmed) {
  if (trimmed === "/help") {
    showHelp();
    return true;
  }

  if (trimmed === "/clear") {
    history.length = 0;
    clearSessionMemory();
    await clearSession();
    console.log(colors.dim("  (Conversation history and saved session cleared)"));
    return true;
  }

  if (trimmed === "/model") {
    model = await pickModel();
    return true;
  }

  if (trimmed.startsWith("/mode")) {
    const arg = trimmed.slice(5).trim();
    if (!arg) {
      console.log(colors.primary(`  Current permission mode: ${colors.boldWhite(getMode())}`));
      return true;
    }
    try {
      const updated = setMode(arg);
      console.log(colors.success(`  Permission mode set to: ${colors.boldWhite(updated)}`));
    } catch (err) {
      console.log(colors.danger(`  ${err.message}`));
    }
    return true;
  }

  if (trimmed.startsWith("/rounds")) {
    const arg = trimmed.slice(7).trim();
    if (!arg) {
      console.log(colors.primary(`  Current max tool rounds limit: ${colors.boldWhite(getMaxRounds())}`));
    } else {
      try {
        const updated = setMaxRounds(arg);
        console.log(colors.success(`  Max tool rounds limit set to: ${colors.boldWhite(updated)}`));
      } catch (err) {
        console.log(colors.danger(`  ${err.message}`));
      }
    }
    return true;
  }

  if (trimmed === "/agents" || trimmed === "/subagents") {
    showAgentsList();
    return true;
  }

  if (trimmed === "/create-agent" || trimmed === "/agent-creator") {
    await launchAgentCreator(reader);
    return true;
  }

  if (trimmed === "/tasks" || trimmed === "/bg") {
    showTasksList();
    return true;
  }

  if (trimmed === "/subtasks" || trimmed === "/subagent-tasks") {
    showSubtasksList();
    return true;
  }

  if (trimmed.startsWith("/kill ")) {
    const targetId = trimmed.slice(6).trim();
    try {
      const msg = targetId.startsWith("subtask-")
        ? subagentManager.killTask(targetId)
        : taskManager.killTask(targetId);
      console.log(colors.warning(`  ${msg}`));
    } catch (err) {
      console.log(colors.danger(`  ${err.message}`));
    }
    return true;
  }

  if (trimmed.startsWith("/logs ")) {
    const targetId = trimmed.slice(6).trim();
    if (targetId.startsWith("subtask-")) {
      const logs = await runTool("manage_subagents", { action: "logs", task_id: targetId });
      console.log("\n" + renderBox(logs.split("\n"), { title: `SUBAGENT LOGS FOR ${targetId}`, borderColor: colors.secondary }) + "\n");
    } else {
      const logs = taskManager.getLogs(targetId, 40);
      console.log("\n" + renderBox(logs.split("\n"), { title: `SHELL LOGS FOR ${targetId}`, borderColor: colors.dim }) + "\n");
    }
    return true;
  }

  if (trimmed === "/diagnostics" || trimmed === "/info") {
    const diag = await runTool("system_diagnostics", {});
    console.log("\n" + renderBox(diag.split("\n"), { title: "SYSTEM DIAGNOSTICS", borderColor: colors.accent }) + "\n");
    return true;
  }

  return false;
}

async function runInteractive() {
  model = await resolveStartupModel();

  renderBanner({
    model,
    activeTasksCount: taskManager.runningCount() + subagentManager.runningCount(),
    agentCount: subagentManager.listAgents().length,
  });

  while (true) {
    const runningBgCmds = taskManager.runningCount();
    const runningBgSubagents = subagentManager.runningCount();
    const parts = [];
    if (runningBgCmds > 0) parts.push(`${runningBgCmds} cmd`);
    if (runningBgSubagents > 0) parts.push(`${runningBgSubagents} agent`);
    const bgBadge = parts.length ? colors.warning(` [${parts.join(", ")}]`) : "";

    const input = await reader.question(`\n${colors.accent.bold("you")}${bgBadge}${colors.primary("› ")}`);
    if (input === undefined) break;
    if (input === null) continue;

    const trimmed = input.trim();
    if (trimmed === "/exit" || trimmed === "/quit") break;
    if (!trimmed) continue;
    if (await handleSlashCommand(trimmed)) continue;

    try {
      await runAgentTurn(trimmed);
      console.log();
      resetStream();
      await saveCurrentSession();
    } catch (err) {
      resetStream();
      console.log(colors.danger(`\nError: ${err.message}`));
    }
  }

  shutdown();
}

async function main() {
  if (cli.help) {
    printHelp();
    return;
  }

  if (cli.mode) setMode(cli.mode);
  else if (!HEADLESS) setMode(process.env.FIXY_MODE || "confirm");

  if (cli.rounds !== null) setMaxRounds(cli.rounds);
  await restoreSessionIfRequested();

  if (HEADLESS) {
    await runHeadless();
    return;
  }

  await runInteractive();
}

main().catch((err) => {
  if (cli.json) {
    console.log(JSON.stringify({ model, error: serializeForJson(err.message), toolCalls: [] }, null, 2));
  } else {
    console.error(colors.danger(`\nFatal: ${err.message}`));
  }
  try { reader?.close(); } catch { /* best effort */ }
  taskManager.stopAll();
  process.exit(1);
});
