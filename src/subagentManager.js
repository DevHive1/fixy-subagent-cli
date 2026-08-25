import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import EventEmitter from "node:events";
import { chatStream, resolveAvailableModel, getActiveModel } from "./ollama.js";
import { TOOL_DEFS, runTool } from "./tools.js";
import { colors, formatAgentBadge } from "./theme.js";

const DEFAULT_AGENTS = {
  researcher: {
    name: "researcher",
    role: "Codebase & Web Researcher",
    description: "Specialized in exploring large codebases, inspecting files, finding patterns, searching documentation, and synthesizing facts.",
    systemPrompt: `You are an expert Codebase Researcher sub-agent.
Your goal is to inspect codebases, read documentation, search symbols, analyze file dependencies, and return thorough, structured reports.
Guidelines:
- Always use read_file, search_code, find_files, list_dir, file_info, and code_structure to verify code rather than guessing.
- Provide clear file links and line numbers when referencing findings.
- Return structured summaries with bullet points, root cause explanations, and exact locations.`,
    allowedTools: [
      "read_file",
      "read_lines",
      "list_dir",
      "search_code",
      "find_files",
      "file_info",
      "code_structure",
      "web_fetch",
      "git_action",
    ],
  },
  coder: {
    name: "coder",
    role: "High-Precision Implementation Engineer",
    description: "Specialized in writing clean, minimal, maintainable code, making atomic edits, and refactoring with surgical precision.",
    systemPrompt: `You are a High-Precision Implementation Engineer sub-agent.
Your goal is to implement features, perform refactorings, fix bugs, and create clean code files.
Guidelines:
- Prefer edit_file for targeted modifications over rewriting entire files.
- Ensure strict adherence to existing syntax styles, naming conventions, and project architecture.
- Verify imports, exports, and syntax correctness.`,
    allowedTools: [
      "read_file",
      "read_lines",
      "write_file",
      "edit_file",
      "batch_edit",
      "list_dir",
      "search_code",
      "find_files",
      "code_structure",
      "run_command",
    ],
  },
  architect: {
    name: "architect",
    role: "System & Software Architect",
    description: "Specialized in high-level architecture design, component decomposition, API contracts, design patterns, and tech stack evaluation.",
    systemPrompt: `You are a Principal Software Architect sub-agent.
Your goal is to plan large refactors, design modular architectures, assess scalability and maintainability, and produce step-by-step implementation blueprints.
Guidelines:
- Map out clear component interactions and data flows.
- Identify edge cases, failure modes, and migration plans.
- Provide actionable phase-by-phase implementation plans.`,
    allowedTools: [
      "read_file",
      "read_lines",
      "list_dir",
      "search_code",
      "find_files",
      "code_structure",
      "web_fetch",
      "git_action",
      "manage_memory",
    ],
  },
  debugger: {
    name: "debugger",
    role: "Root-Cause Debugger & Error Specialist",
    description: "Specialized in analyzing stack traces, reproducing bugs, isolating regression points, and verifying fixes.",
    systemPrompt: `You are an elite Root-Cause Debugger sub-agent.
Your goal is to diagnose errors, trace stack traces to the exact failing line, identify root causes, and verify resolution.
Guidelines:
- Read error logs and stack traces carefully.
- Inspect the offending code and check surrounding context.
- Form clear hypotheses, test with run_command or code inspection, and verify fixes.`,
    allowedTools: [
      "read_file",
      "read_lines",
      "edit_file",
      "search_code",
      "run_command",
      "git_action",
      "code_structure",
      "manage_background_tasks",
      "file_info",
    ],
  },
  tester: {
    name: "tester",
    role: "Quality Assurance & Test Engineer",
    description: "Specialized in designing unit/integration tests, edge-case coverage, fuzzing, and running test suites.",
    systemPrompt: `You are a Senior QA & Test Engineer sub-agent.
Your goal is to construct robust test suites, identify edge-cases, execute test commands, and verify zero regressions.
Guidelines:
- Write clean test cases covering edge cases, null checks, and error boundaries.
- Run tests via run_command and analyze test reports.`,
    allowedTools: [
      "read_file",
      "read_lines",
      "write_file",
      "edit_file",
      "run_command",
      "search_code",
      "find_files",
    ],
  },
  devops: {
    name: "devops",
    role: "DevOps & Build Specialist",
    description: "Specialized in package management, build scripts, environment variables, dependencies, and shell automation.",
    systemPrompt: `You are a DevOps & Infrastructure Engineer sub-agent.
Your goal is to configure build tools, troubleshoot dependencies, optimize package scripts, manage environment configurations, and run system tasks.
Guidelines:
- Safely check environment variables and system specs.
- Diagnose dependency conflicts and build failures.`,
    allowedTools: [
      "run_command",
      "manage_background_tasks",
      "env_manager",
      "system_diagnostics",
      "read_file",
      "read_lines",
      "write_file",
      "edit_file",
      "git_action",
    ],
  },
  security_auditor: {
    name: "security_auditor",
    role: "Security & Vulnerability Auditor",
    description: "Specialized in auditing source code for security vulnerabilities, secret leakage, injection attacks, and insecure configurations.",
    systemPrompt: `You are a Senior Cybersecurity Auditor sub-agent.
Your goal is to review code for vulnerabilities (OWASP Top 10, command injections, path traversals, secret leakage) and recommend remediation.
Guidelines:
- Examine input sanitization, file permissions, authentication, and external dependencies.
- Highlight risk severity (Critical, High, Medium, Low) and provide secure alternatives.`,
    allowedTools: [
      "read_file",
      "read_lines",
      "search_code",
      "find_files",
      "env_manager",
      "code_structure",
      "file_info",
      "git_action",
      "route_inspector",
      "frontend_inspector",
      "project_auditor",
      "port_scanner",
    ],
  },
  frontend_engineer: {
    name: "frontend_engineer",
    role: "Lead Frontend & UI/UX Engineer",
    description: "Specialized in crafting accessible (WCAG), responsive, high-performance web UIs (HTML5, Tailwind, React, Vue, Svelte, Next.js).",
    systemPrompt: `You are a Lead Frontend & UI/UX Engineer sub-agent.
Your goal is to build, inspect, and optimize frontend interfaces to the highest engineering standards.
Guidelines:
- Ensure WCAG AAA/AA accessibility (a11y), semantic HTML tags, keyboard navigation, and ARIA labels.
- Audit frontend files with frontend_inspector for SEO, meta tags, and responsive design.
- Scaffold components and layouts with web_scaffold.`,
    allowedTools: [
      "web_scaffold",
      "frontend_inspector",
      "read_file",
      "read_lines",
      "write_file",
      "edit_file",
      "batch_edit",
      "search_code",
      "find_files",
      "run_command",
      "web_fetch",
      "project_auditor",
    ],
  },
  backend_engineer: {
    name: "backend_engineer",
    role: "Senior Backend & API Architect",
    description: "Specialized in architecting REST/GraphQL APIs, microservices, security middleware, auth (JWT/OAuth), and rate limiting.",
    systemPrompt: `You are a Senior Backend & API Architect sub-agent.
Your goal is to construct robust, high-throughput backend services and APIs adhering to production standards.
Guidelines:
- Inspect endpoints and security middleware with route_inspector.
- Validate API contracts and status assertions with api_tester.
- Ensure proper error middleware, CORS policies, rate limiting, and input validation.`,
    allowedTools: [
      "api_tester",
      "route_inspector",
      "db_client",
      "schema_migrator",
      "load_tester",
      "read_file",
      "read_lines",
      "write_file",
      "edit_file",
      "run_command",
      "env_manager",
      "port_scanner",
      "project_auditor",
    ],
  },
  database_architect: {
    name: "database_architect",
    role: "Database & Data Modeling Architect",
    description: "Specialized in relational schema design, SQL optimization, migrations, indexing, and ORMs (Prisma, Drizzle, SQLAlchemy).",
    systemPrompt: `You are a Principal Database Architect sub-agent.
Your goal is to design normalized schemas, write reversible migrations, optimize SQL queries, and ensure data integrity.
Guidelines:
- Validate schema constraints and table relationships with db_client (validate_schema).
- Analyze query efficiency and detect index suppression with db_client (analyze_query).
- Generate UP/DOWN migrations and ORM schemas with schema_migrator.`,
    allowedTools: [
      "db_client",
      "schema_migrator",
      "read_file",
      "read_lines",
      "write_file",
      "edit_file",
      "run_command",
      "search_code",
      "find_files",
      "project_auditor",
    ],
  },
  qa_engineer: {
    name: "qa_engineer",
    role: "Quality Assurance & Test Automation Specialist",
    description: "Specialized in designing unit/integration/E2E test suites (Vitest, Jest, Playwright), API assertions, and concurrency load tests.",
    systemPrompt: `You are a QA & Test Automation Specialist sub-agent.
Your goal is to design comprehensive test suites, verify edge-case coverage, execute test runners, and benchmark system throughput.
Guidelines:
- Run test suites with test_runner and parse failure assertion diffs.
- Execute HTTP concurrency stress tests with load_tester.
- Verify API contract responses with api_tester.`,
    allowedTools: [
      "test_runner",
      "api_tester",
      "load_tester",
      "frontend_inspector",
      "read_file",
      "read_lines",
      "write_file",
      "edit_file",
      "run_command",
      "search_code",
      "find_files",
      "project_auditor",
    ],
  },
  cloud_devops: {
    name: "cloud_devops",
    role: "Cloud Infrastructure & Production DevOps Engineer",
    description: "Specialized in multi-stage Docker builds, container orchestration, Nginx reverse proxies, SSL/TLS certificates, and CI/CD pipelines.",
    systemPrompt: `You are a Cloud Infrastructure & Production DevOps Engineer sub-agent.
Your goal is to generate, audit, and deploy production-grade infrastructure adhering to 12-Factor App methodology.
Guidelines:
- Generate multi-stage Dockerfiles and docker-compose configurations with hosting_deployer.
- Set up hardened Nginx reverse proxy configs with SSL, HTTP/2, and security headers.
- Inspect open network ports and check SSL expiration with port_scanner.`,
    allowedTools: [
      "hosting_deployer",
      "port_scanner",
      "load_tester",
      "env_manager",
      "system_diagnostics",
      "run_command",
      "manage_background_tasks",
      "read_file",
      "read_lines",
      "write_file",
      "edit_file",
      "git_action",
      "project_auditor",
    ],
  },
};

const AGENTS_FILE = path.join(os.homedir(), ".fixy", "agents.json");

class SubagentManager extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();
    this.tasks = new Map(); // id -> SubagentTask
    this.nextTaskId = 1;
    this.notificationQueue = [];
    this.initDefaults();
    // Awaited before any save to avoid overwriting agents.json mid-load
    this.ready = this.loadCustomAgents();
  }

  initDefaults() {
    for (const [key, def] of Object.entries(DEFAULT_AGENTS)) {
      this.agents.set(key.toLowerCase(), { ...def });
    }
  }

  async loadCustomAgents() {
    try {
      const data = await fs.readFile(AGENTS_FILE, "utf8");
      const list = JSON.parse(data);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item.name) {
            this.agents.set(item.name.toLowerCase(), item);
          }
        }
      }
    } catch {
      // no custom agents yet
    }
  }

  async saveCustomAgents() {
    try {
      await this.ready; // never persist before custom agents are loaded
      const customList = Array.from(this.agents.values()).filter(
        (a) => !DEFAULT_AGENTS[a.name.toLowerCase()]
      );
      await fs.mkdir(path.dirname(AGENTS_FILE), { recursive: true });
      await fs.writeFile(AGENTS_FILE, JSON.stringify(customList, null, 2), "utf8");
    } catch (err) {
      console.error(colors.danger(`Failed to persist custom agents: ${err.message}`));
    }
  }

  registerAgent(agentDef) {
    if (!agentDef.name) throw new Error("Agent definition must have a 'name'.");
    const key = agentDef.name.toLowerCase();
    if (DEFAULT_AGENTS[key]) {
      throw new Error(`"${agentDef.name}" is a reserved core agent name. Choose a different name (e.g. "${key}_custom").`);
    }
    this.agents.set(key, {
      name: agentDef.name,
      role: agentDef.role || agentDef.name,
      description: agentDef.description || "Custom agent",
      systemPrompt: agentDef.systemPrompt || `You are ${agentDef.role || agentDef.name}, a specialized assistant.`,
      allowedTools: Array.isArray(agentDef.allowedTools) ? agentDef.allowedTools : "all",
      model: agentDef.model || null,
      maxRounds: agentDef.maxRounds || agentDef.max_rounds || 20,
      temperature: agentDef.temperature || undefined,
    });
    this.saveCustomAgents();
    return this.agents.get(key);
  }

  getAgent(name) {
    return this.agents.get(name.toLowerCase()) || null;
  }

  listAgents() {
    return Array.from(this.agents.values()).map((a) => ({
      name: a.name,
      role: a.role,
      description: a.description,
      isCustom: !DEFAULT_AGENTS[a.name.toLowerCase()],
      toolsCount: a.allowedTools === "all" ? "all" : (a.allowedTools || []).length,
      model: a.model || "(inherit)",
      maxRounds: a.maxRounds || 20,
    }));
  }

  /**
   * Run a sub-agent task. Can run synchronously or in the background.
   */
  async runSubagent({
    agentName,
    taskPrompt,
    parentModel,
    background = false,
    onStep,
    maxRounds,
  }) {
    const agent = this.getAgent(agentName);
    if (!agent) {
      throw new Error(
        `Sub-agent "${agentName}" not found. Available: ${Array.from(this.agents.keys()).join(", ")}`
      );
    }

    const effectiveLimit = maxRounds || agent.maxRounds || 20;
    const taskId = `subtask-${this.nextTaskId++}`;
    const startTime = new Date();

    const taskObj = {
      id: taskId,
      agentName: agent.name,
      role: agent.role,
      taskPrompt,
      status: "running", // 'running' | 'completed' | 'failed' | 'killed'
      startTime,
      endTime: null,
      output: null,
      error: null,
      logs: [],
      background,
      cancelled: false,
      abortController: new AbortController(),
    };

    this.tasks.set(taskId, taskObj);

    const executeLogic = async () => {
      let modelToUse = agent.model || parentModel || getActiveModel();
      if (!modelToUse) {
        modelToUse = await resolveAvailableModel(null);
      }

      const history = [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: taskPrompt },
      ];

      // Filter tools according to agent permissions
      const allowedSet = Array.isArray(agent.allowedTools)
        ? new Set(agent.allowedTools)
        : null; // null => full access
      let availableTools = TOOL_DEFS;
      if (allowedSet) {
        availableTools = TOOL_DEFS.filter((t) => allowedSet.has(t.function.name));
      }

      const appendTaskLog = (entry) => {
        taskObj.logs.push({ ...entry, timestamp: new Date() });
        onStep?.(entry);
      };

      appendTaskLog({
        type: "agent_start",
        agent: agent.name,
        role: agent.role,
        model: modelToUse,
        taskId,
      });

      try {
        for (let round = 0; round < effectiveLimit; round++) {
          if (taskObj.cancelled) {
            taskObj.status = "killed";
            taskObj.output = "(Sub-agent task cancelled by user/parent)";
            break;
          }

          let subThinking = "";
          let subContent = "";

          const response = await chatStream({
            model: modelToUse,
            messages: history,
            tools: availableTools,
            signal: taskObj.abortController.signal,
            onThinking: (t) => {
              subThinking += t;
              appendTaskLog({ type: "thinking", text: t, agent: agent.name, taskId });
            },
            onContent: (t) => {
              subContent += t;
              appendTaskLog({ type: "content", text: t, agent: agent.name, taskId });
            },
          });

          history.push(response);

          const toolCalls = response.tool_calls;
          if (!toolCalls || toolCalls.length === 0) {
            taskObj.status = "completed";
            taskObj.output = response.content;
            appendTaskLog({ type: "agent_done", agent: agent.name, result: response.content, taskId });
            break;
          }

          for (const call of toolCalls) {
            if (taskObj.cancelled) break;
            const name = call.function?.name;
            let args = call.function?.arguments;
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                args = {};
              }
            }

            // Enforce tool permissions at execution time (defense against
            // models emitting tools outside their allowlist, e.g. via
            // prompt injection from fetched web content).
            if (allowedSet && !allowedSet.has(name)) {
              const deniedMsg = `ERROR: tool "${name}" is not permitted for agent "${agent.name}". Allowed tools: ${agent.allowedTools.join(", ")}`;
              appendTaskLog({ type: "tool_denied", name, agent: agent.name, taskId });
              history.push({ role: "tool", content: deniedMsg, tool_name: name });
              continue;
            }

            appendTaskLog({ type: "tool_call", name, args, agent: agent.name, taskId });
            const result = await runTool(name, args);
            appendTaskLog({ type: "tool_result", name, result, agent: agent.name, taskId });
            history.push({ role: "tool", content: result, tool_name: name });
          }
        }

        if (taskObj.status === "running") {
          taskObj.status = "completed";
          taskObj.output = taskObj.output || "(Sub-agent completed without final text)";
        }
      } catch (err) {
        if (taskObj.cancelled || err.name === "AbortError") {
          taskObj.status = "killed";
          taskObj.output = "(Sub-agent task cancelled by user/parent)";
        } else {
          taskObj.status = "failed";
          taskObj.error = err.message;
          taskObj.output = `ERROR in sub-agent "${agent.name}": ${err.message}`;
        }
      } finally {
        taskObj.endTime = new Date();
        const durationSec = Math.round((taskObj.endTime - taskObj.startTime) / 1000);

        if (background) {
          const summary = `[Background Sub-Agent ${taskId} (${agent.name} - ${agent.role})] finished with status '${taskObj.status}' in ${durationSec}s.\nResult: ${String(taskObj.output).slice(0, 300)}${String(taskObj.output).length > 300 ? "…" : ""}`;
          this.notificationQueue.push(summary);
          this.emit("subagent:done", { task: taskObj, summary });
        }
      }

      return {
        taskId,
        agent: agent.name,
        role: agent.role,
        status: taskObj.status,
        output: taskObj.output,
        historyCount: history.length,
      };
    };

    if (background) {
      // Execute asynchronously in background
      executeLogic();
      return {
        taskId,
        agent: agent.name,
        role: agent.role,
        status: "running",
        background: true,
        message: `Sub-agent ${agent.name} (${agent.role}) dispatched to background as [${taskId}].`,
      };
    }

    // Synchronous execution
    return await executeLogic();
  }

  /**
   * Run multiple subagents in parallel concurrently.
   * @param {Object} opts
   * @param {Array<{ agent_name: string, task_prompt: string }>} opts.agents
   * @param {string} [opts.parentModel]
   * @param {boolean} [opts.background=false]
   */
  async runParallelSubagents({ agents, parentModel, background = false, maxRounds }) {
    if (!Array.isArray(agents) || agents.length === 0) {
      throw new Error("'agents' array must contain at least one agent task specification.");
    }

    if (background) {
      const dispatched = [];
      for (const item of agents) {
        const res = await this.runSubagent({
          agentName: item.agent_name || item.name,
          taskPrompt: item.task_prompt || item.prompt,
          parentModel,
          background: true,
          maxRounds: item.max_rounds || item.maxRounds || maxRounds,
        });
        dispatched.push(res);
      }
      return {
        parallel: true,
        background: true,
        count: dispatched.length,
        tasks: dispatched,
      };
    }

    // Execute in parallel concurrently via Promise.all
    const promises = agents.map((item) =>
      this.runSubagent({
        agentName: item.agent_name || item.name,
        taskPrompt: item.task_prompt || item.prompt,
        parentModel,
        background: false,
        maxRounds: item.max_rounds || item.maxRounds || maxRounds,
      })
    );

    const results = await Promise.all(promises);
    return {
      parallel: true,
      background: false,
      count: results.length,
      results,
    };
  }

  listTasks() {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      agentName: t.agentName,
      role: t.role,
      status: t.status,
      background: t.background,
      startTime: t.startTime.toISOString(),
      duration: t.endTime
        ? `${Math.round((t.endTime - t.startTime) / 1000)}s`
        : `${Math.round((Date.now() - t.startTime.getTime()) / 1000)}s (running)`,
      outputPreview: t.output ? t.output.slice(0, 80) : null,
    }));
  }

  getTask(id) {
    return this.tasks.get(id) || null;
  }

  killTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Sub-agent task "${id}" not found.`);
    if (task.status !== "running") return `Sub-agent task ${id} is already ${task.status}.`;
    task.cancelled = true;
    task.status = "killed";
    try { task.abortController?.abort(); } catch (_) { /* ignore */ }
    return `Cancelled sub-agent task ${id}.`;
  }

  drainNotifications() {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }

  runningCount() {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === "running") count++;
    }
    return count;
  }
}

export const subagentManager = new SubagentManager();
subagentManager.loadCustomAgents();
