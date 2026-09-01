#!/usr/bin/env node
import chalk from "chalk";
import {
  listModels,
  setActiveModel,
  resolveAvailableModel,
  getActiveModel,
  getActiveProvider,
  setActiveProvider,
  SUPPORTED_PROVIDERS,
  detectProviderForModel,
} from "../src/llm.js";
import {
  getOpenRouterApiKey,
  setOpenRouterApiKey,
  loadConfig,
  saveConfig,
} from "../src/config.js";
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
import { saveSession, loadSession, clearSession, generateSessionId } from "../src/persistence.js";
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
    model: process.env.FIXY_MODEL || process.env.OPENROUTER_MODEL || null,
    provider: process.env.FIXY_PROVIDER || null,
    openrouterKey: null,
    mode: null,
    rounds: null,
    help: false,
    sessionId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
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
        case "-P":
        case "--provider": {
          const val = argv[++i];
          if (!val || !SUPPORTED_PROVIDERS.includes(val.toLowerCase())) {
            console.error(`error: --provider requires one of: ${SUPPORTED_PROVIDERS.join(", ")}`);
            process.exit(2);
          }
          opts.provider = val.toLowerCase();
          break;
        }
        case "--openrouter-key":
          opts.openrouterKey = argv[++i];
          if (!opts.openrouterKey) {
            console.error("error: --openrouter-key requires an API key string");
            process.exit(2);
          }
          break;
        case "--mode":
          opts.mode = argv[++i];
          break;
        case "--rounds": {
          const raw = argv[++i];
          const parsed = parseInt(raw, 10);
          if (isNaN(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
            console.error(`error: --rounds requires a positive integer, got "${raw}"`);
            process.exit(2);
          }
          opts.rounds = parsed;
          break;
        }
        case "-h":
        case "--help":
          opts.help = true;
          break;
        default:
          console.error(`error: unknown argument "${a}"`);
          process.exit(2);
        }
    } else {
      if (!opts.sessionId) {
        opts.sessionId = a;
      } else {
        console.error(`error: unexpected positional argument "${a}"`);
        process.exit(2);
      }
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
${colors.primary.bold("fixy")} — autonomous CLI coding agent (Ollama & OpenRouter)

Usage:
  fixy                              Start interactive REPL
  fixy -p "<prompt>"                One-shot headless run
  fixy -p "<prompt>" --json         Machine-readable JSON output
  fixy -c                           Resume last saved session (interactive)

Options:
  -p, --print <prompt>              Run a single prompt non-interactively
      --json                        Emit JSON { model, output, toolCalls }
  -c, --continue                    Restore previous conversation + memory
  -m, --model <name>                Model override (e.g. "anthropic/claude-3.5-sonnet" or "qwen2.5-coder:7b")
  -P, --provider <name>             LLM provider: "ollama" or "openrouter"
      --openrouter-key <key>        Set OpenRouter API Key
      --mode <confirm|auto>         Permission mode (default: confirm interactive / auto headless)
      --rounds <n>                  Max tool rounds (default 30)
  -h, --help                        Show this help

Providers:
  ollama       Local models via Ollama (default host: http://127.0.0.1:11434)
  openrouter   Cloud models (Claude 3.7/3.5, GPT-4o, DeepSeek R1/V3, Gemini 2.0, Llama 3.3)

Permission modes:
  confirm   Dangerous tools ask y/n before running ("a" = always this session).
            Sub-agents cannot perform write/exec actions in this mode.
  auto      AUTO-DRIVE: all tools run without prompting.

Interactive commands: /help /provider /model /mode /rounds /agents /create-agent /tasks /subtasks /logs /kill /diagnostics /clear /exit
`);
}

const cli = parseCliArgs(process.argv.slice(2));
const HEADLESS = typeof cli.prompt === "string";

const history = [];
let currentSessionId = null;
let model = cli.model || null;
const reader = HEADLESS ? null : new LineReader();

// Graceful shutdown — never orphan running background processes
function shutdown() {
  try {
    if (currentSessionId) {
      console.log(`\n${colors.dim(`Session saved. ID: ${colors.boldWhite(currentSessionId)} (use 'fixy ${currentSessionId}' to return)`)}`);
    }
  } catch {}
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

// --- Model & Provider picker --------------------------------------------------

async function ensureOpenRouterKey() {
  const currentKey = getOpenRouterApiKey();
  if (currentKey) return currentKey;

  console.log(colors.warning("\n✦ OpenRouter requires an API Key (get one from https://openrouter.ai/keys)"));
  const inputKey = await reader.question(colors.accent.bold("Enter OpenRouter API Key (sk-or-v1-...): "));
  if (inputKey && inputKey.trim()) {
    const trimmedKey = inputKey.trim();
    await setOpenRouterApiKey(trimmedKey);
    console.log(colors.success("✔ OpenRouter API Key saved to ~/.fixy/config.json"));
    return trimmedKey;
  }
  console.log(colors.danger("No API Key provided. Returning to Ollama provider."));
  await setActiveProvider("ollama");
  return null;
}

async function pickProviderMenu() {
  const curProv = getActiveProvider();
  console.log(colors.primary.bold("\n✦ LLM Provider Switcher:"));
  console.log(`  ${colors.accent("1")}. ${colors.boldWhite("Ollama")} ${colors.dim("(Local open models on your machine)")} ${curProv === "ollama" ? colors.success("✔ Active") : ""}`);
  console.log(`  ${colors.accent("2")}. ${colors.boldWhite("OpenRouter")} ${colors.success("[100% FREE Models]")} ${colors.dim("(Llama 3.3 70B, DeepSeek R1/V3, Gemini Flash, Qwen Coder)")} ${curProv === "openrouter" ? colors.success("✔ Active") : ""}`);
  console.log(`  ${colors.accent("3")}. ${colors.boldWhite("Set OpenRouter API Key")} ${getOpenRouterApiKey() ? colors.dim("(Configured)") : colors.warning("(Not set)")}`);

  const ans = await reader.question(colors.primary.bold("\nChoose provider [1-3, default: 2]: "));
  const choice = (ans || "").trim();
  if (choice === "1") {
    await setActiveProvider("ollama");
    console.log(colors.success("✔ Switched provider to Ollama"));
    return pickModel("ollama");
  } else if (choice === "3") {
    const key = await reader.question(colors.accent.bold("Enter OpenRouter API Key (sk-or-v1-...): "));
    if (key && key.trim()) {
      await setOpenRouterApiKey(key.trim());
      console.log(colors.success("✔ OpenRouter API Key saved!"));
    }
    return getActiveModel();
  } else {
    await setActiveProvider("openrouter");
    const key = await ensureOpenRouterKey();
    if (key) {
      console.log(colors.success("✔ Switched provider to OpenRouter (Free Models)"));
      return pickModel("openrouter");
    }
    return getActiveModel();
  }
}

async function pickModel(provider = getActiveProvider()) {
  if (provider === "openrouter") {
    await ensureOpenRouterKey();
    console.log(colors.dim("\n  Fetching live free models from OpenRouter..."));
    let models = [];
    try {
      models = await listModels("openrouter");
    } catch (e) {
      models = [];
    }

    console.log(colors.secondary.bold(`\n✦ Live OpenRouter Free Models (${models.length} available):`));
    models.forEach((m, i) => {
      const desc = m.description ? ` ${colors.dim(`— ${m.description.replace(/\[FREE\]/g, "").trim()}`)}` : "";
      console.log(`  ${colors.accent(i + 1)}.  ${colors.boldWhite(m.id)} ${colors.success("[FREE]")}${desc}`);
    });
    console.log(`  ${colors.accent("c")}.  ${colors.boldWhite("Custom model")} ${colors.dim("(Type any OpenRouter model ID)")}`);
    console.log(`  ${colors.accent("k")}.  ${colors.boldWhite("Set / Update OpenRouter API Key")}`);
    console.log(`  ${colors.accent("s")}.  ${colors.boldWhite("Switch provider")} ${colors.dim("→ Ollama (Local)")}`);

    const answer = await reader.question(colors.primary.bold(`\nPick model (1-${models.length}, 'c' custom, 's' switch) [default: 1]: `));
    const trimmed = (answer || "").trim();

    if (!trimmed) {
      const chosen = models[0]?.id || "openrouter/free";
      setActiveModel(chosen, "openrouter");
      console.log(colors.success(`✔ Using model: ${colors.boldWhite(chosen)}`));
      return chosen;
    }

    if (trimmed.toLowerCase() === "s") {
      await setActiveProvider("ollama");
      console.log(colors.success("✔ Switched provider to Ollama"));
      return pickModel("ollama");
    }

    if (trimmed.toLowerCase() === "k") {
      const key = await reader.question(colors.accent.bold("Enter OpenRouter API Key (sk-or-v1-...): "));
      if (key && key.trim()) {
        await setOpenRouterApiKey(key.trim());
        console.log(colors.success("✔ OpenRouter API Key saved!"));
      }
      return pickModel("openrouter");
    }

    if (trimmed.toLowerCase() === "c") {
      const customName = await reader.question(colors.accent.bold("Enter model ID (e.g. 'openrouter/free'): "));
      if (customName && customName.trim()) {
        const chosen = customName.trim();
        setActiveModel(chosen, "openrouter");
        console.log(colors.success(`✔ Using model: ${colors.boldWhite(chosen)}`));
        return chosen;
      }
      return getActiveModel("openrouter");
    }

    const idx = parseInt(trimmed, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < models.length) {
      const chosen = models[idx].id;
      setActiveModel(chosen, "openrouter");
      console.log(colors.success(`✔ Using model: ${colors.boldWhite(chosen)}`));
      return chosen;
    }

    const match = models.find((m) => m.id.toLowerCase() === trimmed.toLowerCase() || m.id.toLowerCase().includes(trimmed.toLowerCase()));
    const chosen = match ? match.id : (trimmed.includes("/") ? (trimmed.includes(":free") ? trimmed : `${trimmed}:free`) : trimmed);
    setActiveModel(chosen, "openrouter");
    console.log(colors.success(`✔ Using model: ${colors.boldWhite(chosen)}`));
    return chosen;
  }

  // Ollama provider
  let models = [];
  try {
    models = await listModels("ollama");
  } catch {
    console.log(colors.danger(`\nCould not reach Ollama at ${process.env.OLLAMA_HOST || "http://127.0.0.1:11434"}.`));
    console.log(colors.dim(`Make sure it is running: ${chalk.white("ollama serve")}`));
    console.log(colors.subtle(`Tip: You can use OpenRouter free models without local Ollama!\n`));
    const switchAns = await reader.question(colors.accent.bold("Switch to OpenRouter provider now? [Y/n]: "));
    if (!switchAns || switchAns.trim().toLowerCase().startsWith("y")) {
      await setActiveProvider("openrouter");
      return pickModel("openrouter");
    }
    process.exit(1);
  }

  if (!models.length) {
    console.log(colors.danger("\nNo local Ollama models found installed."));
    console.log(colors.subtle("Tip: You can switch to OpenRouter 100% free cloud models!\n"));
    const switchAns = await reader.question(colors.accent.bold("Switch to OpenRouter provider now? [Y/n]: "));
    if (!switchAns || switchAns.trim().toLowerCase().startsWith("y")) {
      await setActiveProvider("openrouter");
      return pickModel("openrouter");
    }
    process.exit(1);
  }

  console.log(colors.primary.bold("\nAvailable Ollama Models (Local):"));
  models.forEach((m, i) => {
    const sizeGb = m.size ? ` (${(m.size / 1024 / 1024 / 1024).toFixed(1)} GB)` : "";
    console.log(`  ${colors.accent(i + 1)}.  ${colors.boldWhite(m.name)}${colors.dim(sizeGb)}`);
  });
  console.log(`  ${colors.accent("s")}.  ${colors.boldWhite("Switch provider")} ${colors.dim("→ OpenRouter (Free)")}`);

  const answer = await reader.question(colors.primary.bold("\nPick a model (number or name, 's' switch) [default: 1]: "));
  const trimmed = answer?.trim();
  if (!trimmed) {
    setActiveModel(models[0].name, "ollama");
    return models[0].name;
  }

  if (trimmed.toLowerCase() === "s") {
    await setActiveProvider("openrouter");
    console.log(colors.success("✔ Switched provider to OpenRouter"));
    return pickModel("openrouter");
  }

  const byIndex = models[parseInt(trimmed, 10) - 1];
  const byName = models.find((m) => m.name.toLowerCase() === trimmed.toLowerCase());
  const chosen = byIndex?.name || byName?.name || models[0].name;
  setActiveModel(chosen, "ollama");
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
  if (!cli.sessionId && !cli.cont) return;

  const targetId = cli.sessionId || null;
  const session = await loadSession(targetId);
  
  if (!session) {
    if (!HEADLESS || !cli.json) {
      console.log(colors.warning(`No saved session found${targetId ? ` for ID ${colors.boldWhite(targetId)}` : ""}.`));
    }
    return;
  }

  history.splice(0, history.length, ...session.history);
  importSessionMemory(session.memory || {});
  currentSessionId = session.sessionId || generateSessionId();
  
  if (!HEADLESS || !cli.json) {
    console.log(colors.success(`✔ Restored session ${colors.boldWhite(currentSessionId)}`));
    console.log(colors.dim(`  Saved at: ${session.savedAt || "unknown time"}`));
    console.log(colors.dim(`  Messages: ${session.history.length}`));
  }
}

async function resolveStartupModel() {
  if (cli.provider) {
    await setActiveProvider(cli.provider);
  }
  if (cli.openrouterKey) {
    await setOpenRouterApiKey(cli.openrouterKey);
  }

  if (model) {
    const inferred = detectProviderForModel(model);
    if (inferred) {
      await setActiveProvider(inferred);
    }
    const resolved = await resolveAvailableModel(model);
    setActiveModel(resolved);
    if (getActiveProvider() === "openrouter" && !getOpenRouterApiKey() && !HEADLESS) {
      await ensureOpenRouterKey();
    }
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
    sessionId: currentSessionId,
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
      console.log(JSON.stringify({ provider: getActiveProvider(), model, output: serializeForJson(output), toolCalls: capturedToolCalls }, null, 2));
    } else {
      if (!contentOpen && output) process.stdout.write(String(output));
      process.stdout.write("\n");
    }
  } catch (err) {
    if (cli.json) {
      console.log(JSON.stringify({ provider: getActiveProvider(), model, error: serializeForJson(err.message), toolCalls: capturedToolCalls }, null, 2));
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

  if (trimmed === "/provider" || trimmed.startsWith("/provider ")) {
    const arg = trimmed.slice(9).trim();
    if (!arg) {
      model = await pickProviderMenu();
      return true;
    }
    if (arg.toLowerCase() === "ollama") {
      await setActiveProvider("ollama");
      console.log(colors.success(`  ✔ Active provider set to: ${colors.boldWhite("Ollama")}`));
      model = await resolveAvailableModel(null, "ollama");
      setActiveModel(model, "ollama");
      console.log(colors.dim(`  Using model: ${model}`));
      return true;
    }
    if (arg.toLowerCase() === "openrouter") {
      await setActiveProvider("openrouter");
      console.log(colors.success(`  ✔ Active provider set to: ${colors.boldWhite("OpenRouter")}`));
      if (!getOpenRouterApiKey() && reader) {
        await ensureOpenRouterKey();
      }
      model = await resolveAvailableModel(null, "openrouter");
      setActiveModel(model, "openrouter");
      console.log(colors.dim(`  Using model: ${model}`));
      return true;
    }
    if (arg.startsWith("key ") || arg.startsWith("set-key ")) {
      const keyVal = arg.split(/\s+/)[1];
      if (keyVal) {
        await setOpenRouterApiKey(keyVal);
        console.log(colors.success(`  ✔ OpenRouter API Key saved.`));
      } else {
        console.log(colors.danger(`  Usage: /provider key <sk-or-v1-...>`));
      }
      return true;
    }
    console.log(colors.warning(`  Unknown provider "${arg}". Supported: ollama, openrouter`));
    return true;
  }

  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    const arg = trimmed.slice(6).trim();
    if (!arg) {
      model = await pickModel();
      return true;
    }
    const inferred = detectProviderForModel(arg);
    if (inferred) {
      await setActiveProvider(inferred);
    }
    const resolved = await resolveAvailableModel(arg);
    setActiveModel(resolved);
    model = resolved;
    console.log(colors.success(`  ✔ Using model: ${colors.boldWhite(resolved)} (Provider: ${getActiveProvider()})`));
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
    provider: getActiveProvider(),
    activeTasksCount: taskManager.runningCount() + subagentManager.runningCount(),
    agentCount: subagentManager.listAgents().length,
  });
  console.log(colors.dim(`  Session ID: ${colors.boldWhite(currentSessionId)} (use 'fixy ${currentSessionId}' to return)`));

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

  await saveCurrentSession();
  shutdown();
}

async function main() {
  if (cli.help) {
    printHelp();
    return;
  }

  if (cli.mode) setMode(cli.mode);
  else if (!HEADLESS) setMode(process.env.FIXY_MODE || "confirm");

  if (cli.rounds !== null) {
    try { setMaxRounds(cli.rounds); } catch (e) { console.error(colors.danger(e.message)); process.exit(2); }
  }
  // Ensure subagent custom agents loaded before any use
  try { await subagentManager.ready; } catch {}
  await restoreSessionIfRequested();
  if (!currentSessionId) {
    currentSessionId = generateSessionId();
  }

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
