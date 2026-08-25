import chalk from "chalk";
import { chatStream } from "./ollama.js";
import { TOOL_DEFS, runTool } from "./tools.js";
import { taskManager } from "./taskManager.js";
import { subagentManager } from "./subagentManager.js";
import { colors } from "./theme.js";
import { getMode } from "./permissions.js";

let globalMaxRounds = parseInt(process.env.FIXY_MAX_ROUNDS, 10) || 30;

/**
 * Get current global max tool rounds limit.
 */
export function getMaxRounds() {
  return globalMaxRounds;
}

/**
 * Set current global max tool rounds limit.
 */
export function setMaxRounds(n) {
  const parsed = parseInt(n, 10);
  if (!isNaN(parsed) && parsed > 0) {
    globalMaxRounds = parsed;
    process.env.FIXY_MAX_ROUNDS = String(parsed);
    return globalMaxRounds;
  }
  throw new Error(`Invalid max rounds number: "${n}"`);
}

const SYSTEM_PROMPT = `You are Fixy (Edition 2.0), an advanced autonomous multi-agent engineering system running directly in the user's terminal.
You have access to an extensive suite of 42 precision tools, 12 specialized sub-agents, a background process engine, an autonomous Agent Creator, dynamic rounds limit controls, and highest-standards construction capabilities.

Core Capabilities:
1. Full-Stack Web, Frontend & Backend Engineering:
   - Frontend Scaffolding & Standards: Use web_scaffold to scaffold modern web projects (HTML5, React+Tailwind, Vue, Svelte, Next.js, Express, FastAPI) and accessible UI components (Navbar, Modal, Hero, Form, DataTable, CardGrid).
   - Frontend & A11y Inspection: Use frontend_inspector to audit WCAG accessibility (a11y), SEO meta tags, OpenGraph, responsive layout, and performance.
   - Backend APIs & Routing: Use route_inspector to introspect backend route endpoints, CORS policies, security middleware, and input validation schemas.
   - API Contract Testing: Use api_tester to send precision HTTP requests, verify status codes, assert JSON response structures, and validate Bearer/Basic auth.

2. Database Architecture & Migrations:
   - Database Operations: Use db_client to inspect schema tables, execute SQLite queries, analyze SQL queries for performance and injection vulnerabilities, and validate normalization.
   - Reversible Migrations & ORMs: Use schema_migrator to generate UP/DOWN SQL migrations, TypeScript domain models, Prisma schemas, or Drizzle definitions.

3. Testing, Performance & Benchmarks:
   - Test Suite Automation: Use test_runner to execute Vitest, Jest, Pytest, Playwright, or Node test runners and extract failure assertion diffs.
   - Concurrency Load Testing: Use load_tester to stress-test HTTP endpoints with concurrent workers, measuring throughput (RPS) and p50/p95/p99 latency percentiles.

4. Hosting, Cloud Deployment & Security:
   - Hardened Cloud Configs: Use hosting_deployer to generate multi-stage Dockerfiles, docker-compose.yml, Nginx reverse proxies with SSL/HTTP2, and GitHub Actions CI/CD workflows.
   - Network & SSL Diagnostics: Use port_scanner to scan open ports, discover running services (Node, Vite, Postgres, Redis, Mongo), check health pings, and inspect SSL certificate expiration.
   - Highest-Standards Quality Audit: Use project_auditor to audit full-stack applications across 6 architectural pillars with a scored diagnostic scorecard.

5. Autonomous Sub-Agent Creation & Parallel Delegation:
   - Autonomous Agent Creator: Create custom sub-agents via define_agent for any specialized domain.
   - Parallel Execution: Invoke multiple sub-agents AT THE SAME TIME via invoke_parallel_subagents.
   - Background Delegation: Dispatch sub-agents asynchronously with background=true and manage them via manage_subagents.
   - Built-in Specialists: researcher, coder, architect, debugger, tester, devops, security_auditor, frontend_engineer, backend_engineer, database_architect, qa_engineer, cloud_devops.

6. Precision Shell & File Intelligence:
   - Multi-line & Multi-file: Use read_lines to read targeted slices across multiple files simultaneously.
   - Precision Edits: Use edit_file for surgical unique replacements and batch_edit for multi-file refactoring.
   - Background Shell Tasks: Use run_command with background=true and manage_background_tasks.

Rules:
- Never guess file contents or command outputs. Always verify with tools.
- Reply in the same language the user speaks (Arabic or English).
- Be concise, direct, and provide concrete summaries with code locations.`;

/**
 * Run one full agent turn with background notification draining, tool-calling loop,
 * and streaming output.
 */
export async function runTurn({
  model,
  history,
  userMessage,
  maxRounds = globalMaxRounds,
  onToolCall,
  onToolResult,
  onThinking,
  onContent,
  onRoundStart,
  onSubagentEvent,
}) {
  // Inject any background task or sub-agent notifications that occurred
  const pendingTaskNotifs = taskManager.drainNotifications();
  const pendingSubagentNotifs = subagentManager.drainNotifications();
  const allNotifs = [...pendingTaskNotifs, ...pendingSubagentNotifs];

  let enrichedMessage = userMessage;
  if (allNotifs.length > 0) {
    const notifBlock = allNotifs.map((n) => `[SYSTEM NOTICE] ${n}`).join("\n");
    enrichedMessage = `${notifBlock}\n\n${userMessage}`;
  }

  const modeLine =
    getMode() === "auto"
      ? "[MODE: AUTO-DRIVE — tools execute without user approval]"
      : "[MODE: CONFIRM — dangerous tool calls require user y/n approval; sub-agents cannot perform write/exec actions in this mode]";
  enrichedMessage = `${modeLine}\n\n${enrichedMessage}`;

  if (history.length === 0) {
    history.push({ role: "system", content: SYSTEM_PROMPT });
  }

  history.push({ role: "user", content: enrichedMessage });

  const limit = maxRounds || globalMaxRounds;

  for (let round = 0; round < limit; round++) {
    onRoundStart?.();
    const message = await chatStream({
      model,
      messages: history,
      tools: TOOL_DEFS,
      onThinking,
      onContent,
    });

    history.push(message);

    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return message.content;
    }

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = call.function?.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }

      onToolCall?.(name, args);
      const result = await runTool(name, args, { interactive: true });
      onToolResult?.(name, result);
      history.push({ role: "tool", content: result, tool_name: name });
    }
  }

  return chalk.yellow(
    `\n⚠ (Turn reached maximum tool rounds limit of ${limit}. You can increase this with /rounds <n> or break your request into smaller steps.)`
  );
}
