#!/usr/bin/env node
import chalk from "chalk";
import { listModels, setActiveModel } from "../src/ollama.js";
import { runTurn, getMaxRounds, setMaxRounds } from "../src/agent.js";
import { LineReader } from "../src/input.js";
import { taskManager } from "../src/taskManager.js";
import { subagentManager } from "../src/subagentManager.js";
import { launchAgentCreator } from "../src/agentCreator.js";
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
} from "../src/theme.js";

const history = [];
let model = process.env.FIXY_MODEL || null;
const reader = new LineReader();

// Live background task event emitter (shell commands)
taskManager.on("task:done", ({ task }) => {
  const card = renderBackgroundTaskCard(task);
  process.stdout.write(`\n${card}\n`);
});

// Live background sub-agent event emitter
subagentManager.on("subagent:done", ({ task }) => {
  const card = renderSubagentTaskCard(task);
  process.stdout.write(`\n${card}\n`);
});

async function pickModel() {
  let models;
  try {
    models = await listModels();
  } catch {
    console.log(
      colors.danger(
        `\nCould not reach Ollama at ${process.env.OLLAMA_HOST || "http://127.0.0.1:11434"}.`
      )
    );
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
    const sizeMb = m.size ? ` (${(m.size / 1024 / 1024 / 1024).toFixed(1)} GB)` : "";
    console.log(`  ${colors.accent(i + 1)}.  ${colors.boldWhite(m.name)}${colors.dim(sizeMb)}`);
  });

  const answer = await reader.question(
    colors.primary.bold("\nPick a model (number or name) [default: 1]: ")
  );
  if (!answer || !answer.trim()) return models[0].name;

  const byIndex = models[parseInt(answer.trim(), 10) - 1];
  const byName = models.find((m) => m.name.toLowerCase() === answer.trim().toLowerCase());
  const chosen = byIndex?.name || byName?.name || models[0].name;
  setActiveModel(chosen);
  console.log(colors.success(`✔ Using model: ${colors.boldWhite(chosen)}`));
  return chosen;
}

function showHelp() {
  console.log("\n" + renderCommandMatrix(getMaxRounds()) + "\n");
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

// --- Live Streaming Renderer -----------------------------------------------

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

// --- Main REPL Loop --------------------------------------------------------

async function main() {
  if (!model) {
    model = await pickModel();
  }

  renderBanner({
    model,
    activeTasksCount: taskManager.runningCount() + subagentManager.runningCount(),
    agentCount: subagentManager.listAgents().length,
  });

  while (true) {
    const runningBgCmds = taskManager.runningCount();
    const runningBgSubagents = subagentManager.runningCount();
    let bgBadge = "";
    if (runningBgCmds > 0 || runningBgSubagents > 0) {
      const parts = [];
      if (runningBgCmds > 0) parts.push(`${runningBgCmds} cmd`);
      if (runningBgSubagents > 0) parts.push(`${runningBgSubagents} agent`);
      bgBadge = colors.warning(` [⚡${parts.join(", ")}]`);
    }

    const promptStr = `\n${colors.accent.bold("you")}${bgBadge}${colors.primary("› ")}`;

    const input = await reader.question(promptStr);

    if (input === undefined) break; // Ctrl+D
    if (input === null) continue; // Ctrl+C
    const trimmed = input.trim();

    if (trimmed === "/exit" || trimmed === "/quit") break;

    if (trimmed === "/help") {
      showHelp();
      continue;
    }

    if (trimmed === "/clear") {
      history.length = 0;
      console.log(colors.dim("  (Conversation history cleared)"));
      continue;
    }

    if (trimmed === "/model") {
      model = await pickModel();
      continue;
    }

    if (trimmed.startsWith("/rounds")) {
      const arg = trimmed.slice(7).trim();
      if (!arg) {
        console.log(colors.primary(`  Current max tool rounds limit: ${colors.boldWhite(getMaxRounds())}`));
      } else {
        try {
          const updated = setMaxRounds(arg);
          console.log(colors.success(`  ✔ Max tool rounds limit set to: ${colors.boldWhite(updated)}`));
        } catch (err) {
          console.log(colors.danger(`  ✖ ${err.message}`));
        }
      }
      continue;
    }

    if (trimmed === "/agents" || trimmed === "/subagents") {
      showAgentsList();
      continue;
    }

    if (trimmed === "/create-agent" || trimmed === "/agent-creator") {
      await launchAgentCreator(reader);
      continue;
    }

    if (trimmed === "/tasks" || trimmed === "/bg") {
      showTasksList();
      continue;
    }

    if (trimmed === "/subtasks" || trimmed === "/subagent-tasks") {
      showSubtasksList();
      continue;
    }

    if (trimmed.startsWith("/kill ")) {
      const targetId = trimmed.slice(6).trim();
      try {
        if (targetId.startsWith("subtask-")) {
          const msg = subagentManager.killTask(targetId);
          console.log(colors.warning(`  ${msg}`));
        } else {
          const msg = taskManager.killTask(targetId);
          console.log(colors.warning(`  ${msg}`));
        }
      } catch (err) {
        console.log(colors.danger(`  ${err.message}`));
      }
      continue;
    }

    if (trimmed.startsWith("/logs ")) {
      const targetId = trimmed.slice(6).trim();
      if (targetId.startsWith("subtask-")) {
        const { runTool } = await import("../src/tools.js");
        const logs = await runTool("manage_subagents", { action: "logs", task_id: targetId });
        console.log("\n" + renderBox(logs.split("\n"), { title: `SUBAGENT LOGS FOR ${targetId}`, borderColor: colors.secondary }) + "\n");
      } else {
        const logs = taskManager.getLogs(targetId, 40);
        console.log("\n" + renderBox(logs.split("\n"), { title: `SHELL LOGS FOR ${targetId}`, borderColor: colors.dim }) + "\n");
      }
      continue;
    }

    if (trimmed === "/diagnostics" || trimmed === "/info") {
      const { runTool } = await import("../src/tools.js");
      const diag = await runTool("system_diagnostics", {});
      console.log("\n" + renderBox(diag.split("\n"), { title: "SYSTEM DIAGNOSTICS", borderColor: colors.accent }) + "\n");
      continue;
    }

    if (!trimmed) continue;

    try {
      await runTurn({
        model,
        history,
        userMessage: trimmed,
        onToolCall,
        onToolResult,
        onThinking,
        onContent,
        onRoundStart,
      });
      console.log();
      resetStream();
    } catch (err) {
      resetStream();
      console.log(colors.danger(`\n✖ Error: ${err.message}`));
    }
  }

  reader.close();
  process.exit(0);
}

main();
