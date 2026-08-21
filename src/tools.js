import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { taskManager } from "./taskManager.js";
import { subagentManager } from "./subagentManager.js";
import { getActiveModel, resolveAvailableModel } from "./ollama.js";
import { setMaxRounds, getMaxRounds } from "./agent.js";
import {
  webScaffold,
  frontendInspector,
  apiTester,
  routeInspector,
  dbClient,
  schemaMigrator,
  testRunner,
  loadTester,
  hostingDeployer,
  portScanner,
  projectAuditor,
} from "./webTools.js";

const execAsync = promisify(exec);
const MAX_OUTPUT = 15000;

function truncate(str) {
  if (typeof str !== "string") str = String(str ?? "");
  if (str.length <= MAX_OUTPUT) return str;
  return str.slice(0, MAX_OUTPUT) + `\n...[truncated, ${str.length - MAX_OUTPUT} more chars]`;
}

// In-memory persistent scratchpad for the session
const sessionMemory = new Map();

/**
 * Tool Schema Definitions for Ollama function calling
 */
export const TOOL_DEFS = [
  // 1. read_file
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file's contents with optional 1-indexed line numbers and range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative or absolute." },
          start_line: { type: "integer", description: "1-indexed start line (optional)." },
          end_line: { type: "integer", description: "1-indexed end line, inclusive (optional)." },
          show_line_numbers: { type: "boolean", description: "Include line number prefixes (default true)." },
        },
        required: ["path"],
      },
    },
  },
  // 2. write_file
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or overwrite an existing file with full content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  // 3. edit_file
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact unique text match inside a file with surgical precision.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit." },
          old_str: { type: "string", description: "Exact text to find (must be unique in file)." },
          new_str: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  // 4. list_dir
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories with type, size, and recursive depth option.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path. Defaults to current directory." },
          max_depth: { type: "integer", description: "Max recursive depth (default 1)." },
        },
      },
    },
  },
  // 5. search_code
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search for a regex or text pattern across files under a directory (using ripgrep or fallback).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search regex or string." },
          path: { type: "string", description: "Directory to search. Defaults to current directory." },
          case_sensitive: { type: "boolean", description: "Whether search is case-sensitive (default false)." },
        },
        required: ["pattern"],
      },
    },
  },
  // 6. run_command
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command. Can be executed synchronously or dispatched to the background.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string to execute." },
          cwd: { type: "string", description: "Working directory (optional)." },
          background: { type: "boolean", description: "If true, runs command asynchronously in the background." },
          timeout_ms: { type: "integer", description: "Max execution timeout in ms (default 60000)." },
        },
        required: ["command"],
      },
    },
  },
  // 7. find_files (NEW)
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find files and directories by extension, name pattern (glob/regex), and type filter.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Base directory to search. Defaults to current directory." },
          name_pattern: { type: "string", description: "Pattern to match filename (e.g. '*.js', 'test')." },
          extension: { type: "string", description: "File extension filter without dot (e.g. 'json', 'ts')." },
          type: { type: "string", enum: ["file", "dir", "any"], description: "Type of entries to match." },
          max_results: { type: "integer", description: "Max results to return (default 50)." },
        },
      },
    },
  },
  // 8. batch_edit (NEW)
  {
    type: "function",
    function: {
      name: "batch_edit",
      description: "Perform search and replace across multiple files matching a pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern or exact string." },
          replacement: { type: "string", description: "Replacement text." },
          files: { type: "array", items: { type: "string" }, description: "List of file paths to edit." },
          dry_run: { type: "boolean", description: "If true, only previews changes without writing (default false)." },
        },
        required: ["pattern", "replacement", "files"],
      },
    },
  },
  // 9. git_action (NEW)
  {
    type: "function",
    function: {
      name: "git_action",
      description: "Execute Git version control operations (status, diff, log, commit, add, branch, stash, blame).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "diff", "log", "add", "commit", "branch", "checkout", "stash", "blame"],
            description: "Git action to perform.",
          },
          args: { type: "string", description: "Additional arguments (e.g. commit message, branch name, file path)." },
        },
        required: ["action"],
      },
    },
  },
  // 10. web_fetch (NEW)
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch web content, documentation, or API endpoints via HTTP/HTTPS.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch." },
          method: { type: "string", enum: ["GET", "POST", "HEAD"], description: "HTTP method (default GET)." },
          headers: { type: "object", description: "Optional HTTP headers." },
          body: { type: "string", description: "Optional request body." },
          max_length: { type: "integer", description: "Max response characters to return (default 8000)." },
        },
        required: ["url"],
      },
    },
  },
  // 11. manage_background_tasks (NEW)
  {
    type: "function",
    function: {
      name: "manage_background_tasks",
      description: "Inspect, list, monitor logs, send stdin input, or terminate running background commands.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "status", "logs", "kill", "send_input"],
            description: "Action to perform on background tasks.",
          },
          task_id: { type: "string", description: "Task ID (required for status, logs, kill, send_input)." },
          input: { type: "string", description: "Input text when action is 'send_input'." },
          lines: { type: "integer", description: "Number of log lines to retrieve (default 30)." },
        },
        required: ["action"],
      },
    },
  },
  // 12. invoke_subagent
  {
    type: "function",
    function: {
      name: "invoke_subagent",
      description: "Invoke a specialized sub-agent (e.g. 'researcher', 'coder', 'architect', 'debugger', 'tester', 'devops', 'security_auditor', or custom) with a dedicated sub-task prompt. Can run synchronously or in the background.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Name of the sub-agent profile to invoke." },
          task_prompt: { type: "string", description: "Precise instructions and task description for the subagent." },
          background: { type: "boolean", description: "If true, runs subagent asynchronously in the background so you can continue other work." },
          max_rounds: { type: "integer", description: "Maximum tool call rounds limit for this subagent execution (default 20)." },
        },
        required: ["agent_name", "task_prompt"],
      },
    },
  },
  // 12b. invoke_parallel_subagents (NEW)
  {
    type: "function",
    function: {
      name: "invoke_parallel_subagents",
      description: "Invoke MULTIPLE specialized sub-agents AT THE SAME TIME in parallel (concurrently). Each agent executes its designated sub-task concurrently.",
      parameters: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                agent_name: { type: "string", description: "Name of subagent (e.g. 'researcher', 'coder', 'tester')." },
                task_prompt: { type: "string", description: "Specific prompt/instructions for this agent." },
                max_rounds: { type: "integer", description: "Optional max rounds limit for this agent." },
              },
              required: ["agent_name", "task_prompt"],
            },
            description: "List of subagents and their respective tasks to run in parallel.",
          },
          background: { type: "boolean", description: "If true, dispatches all subagents to background concurrently." },
          max_rounds: { type: "integer", description: "Default max rounds limit for all agents in this parallel batch." },
        },
        required: ["agents"],
      },
    },
  },
  // 12c. manage_subagents (NEW)
  {
    type: "function",
    function: {
      name: "manage_subagents",
      description: "List, inspect status, read logs, or cancel running background sub-agents.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "status", "logs", "kill"],
            description: "Action to perform on sub-agent tasks.",
          },
          task_id: { type: "string", description: "Sub-agent Task ID (e.g. 'subtask-1')." },
          lines: { type: "integer", description: "Number of log lines to inspect." },
        },
        required: ["action"],
      },
    },
  },
  // 13. define_agent (NEW)
  {
    type: "function",
    function: {
      name: "define_agent",
      description: "Programmatically create and register a new customized sub-agent profile with specific role, instructions, and tools.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique identifier for the agent (e.g. 'perf_tester')." },
          role: { type: "string", description: "Human-readable role title (e.g. 'Performance Benchmark Specialist')." },
          description: { type: "string", description: "Summary of agent's domain." },
          system_prompt: { type: "string", description: "Detailed system instructions for the agent." },
          allowed_tools: { type: "array", items: { type: "string" }, description: "List of allowed tool names, or omit for all." },
          model_override: { type: "string", description: "Optional specific model name." },
          max_rounds: { type: "integer", description: "Default maximum tool call rounds limit for this agent (default 20)." },
        },
        required: ["name", "role", "system_prompt"],
      },
    },
  },
  // 14. code_structure (NEW)
  {
    type: "function",
    function: {
      name: "code_structure",
      description: "Extract code outline (functions, classes, methods, imports, exports) from a source file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Source code file path." },
        },
        required: ["path"],
      },
    },
  },
  // 15. file_info (NEW)
  {
    type: "function",
    function: {
      name: "file_info",
      description: "Inspect file/directory metadata: size, line count, permissions, timestamps, and SHA-256 hash.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to inspect." },
        },
        required: ["path"],
      },
    },
  },
  // 16. env_manager (NEW)
  {
    type: "function",
    function: {
      name: "env_manager",
      description: "Inspect, list, parse .env files, or check active environment variables safely.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "read_dotenv"], description: "Action to perform." },
          variable_name: { type: "string", description: "Variable name when action is 'get'." },
          dotenv_path: { type: "string", description: "Path to .env file when action is 'read_dotenv'." },
        },
        required: ["action"],
      },
    },
  },
  // 17. system_diagnostics (NEW)
  {
    type: "function",
    function: {
      name: "system_diagnostics",
      description: "Retrieve comprehensive host system statistics (OS, CPU, memory, uptime, Node version, working directory).",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  // 18. manage_memory
  {
    type: "function",
    function: {
      name: "manage_memory",
      description: "Store, retrieve, list, or clear key-value scratchpad notes across multi-turn sessions.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set", "list", "delete", "clear"], description: "Memory action." },
          key: { type: "string", description: "Memory key identifier." },
          value: { type: "string", description: "Value to store when action is 'set'." },
        },
        required: ["action"],
      },
    },
  },
  // 19. read_lines
  {
    type: "function",
    function: {
      name: "read_lines",
      description: "Read specific line numbers, ranges, or line selections from one or more files with formatted line numbers, optional context, and file headers.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "List of file paths to read from (e.g. ['src/agent.js', 'src/tools.js']). Can also be a single file path string in 'files' or 'path'.",
          },
          path: {
            type: "string",
            description: "Single file path (alternative or supplement to 'files').",
          },
          lines: {
            type: "string",
            description: "Specific lines or ranges to extract (e.g. '10, 15, 20-30', '1-50', or '5').",
          },
          start_line: {
            type: "integer",
            description: "1-indexed start line (optional).",
          },
          end_line: {
            type: "integer",
            description: "1-indexed end line (optional).",
          },
          context_lines: {
            type: "integer",
            description: "Number of context lines to include before and after each matched line (default 0).",
          },
          show_line_numbers: {
            type: "boolean",
            description: "Whether to prefix output with line numbers (default true).",
          },
        },
      },
    },
  },
  // 20. set_rounds_limit
  {
    type: "function",
    function: {
      name: "set_rounds_limit",
      description: "Set the agent's maximum tool-calling rounds limit dynamically for the session to allocate more or less budget for complex multi-step tasks.",
      parameters: {
        type: "object",
        properties: {
          max_rounds: { type: "integer", description: "New maximum rounds limit (e.g. 40, 60, 100)." },
        },
        required: ["max_rounds"],
      },
    },
  },
  // 21. web_scaffold (NEW)
  {
    type: "function",
    function: {
      name: "web_scaffold",
      description: "Scaffold full-stack web projects, accessible UI components, and modern landing pages adhering to highest engineering standards (HTML5, Tailwind, React, Vue, Svelte, Express, FastAPI).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["scaffold_project", "scaffold_component", "scaffold_page", "list_templates"],
            description: "Scaffolding action to perform.",
          },
          target_dir: { type: "string", description: "Target directory path (default '.')." },
          template: {
            type: "string",
            enum: ["modern_html", "react_tailwind", "vue", "svelte", "nextjs", "express_api", "fastapi"],
            description: "Project template to use for scaffold_project.",
          },
          component_type: {
            type: "string",
            enum: ["navbar", "hero", "modal", "auth_form", "data_table", "card_grid", "footer", "stats_grid"],
            description: "Component type for scaffold_component.",
          },
          framework: {
            type: "string",
            enum: ["react", "vue", "svelte", "html"],
            description: "Framework for component generation (default 'react').",
          },
          name: { type: "string", description: "Name of the component or project." },
          options: { type: "object", description: "Additional options (typescript, tailwind, darkMode)." },
        },
        required: ["action"],
      },
    },
  },
  // 22. frontend_inspector (NEW)
  {
    type: "function",
    function: {
      name: "frontend_inspector",
      description: "Perform static analysis on frontend files (HTML, JSX, Vue, Svelte) to audit WCAG Accessibility (a11y), SEO meta tags, mobile responsiveness, and asset performance.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path to inspect." },
          checks: {
            type: "string",
            enum: ["all", "a11y", "seo", "responsive", "performance"],
            description: "Scope of frontend checks (default 'all').",
          },
        },
      },
    },
  },
  // 23. api_tester (NEW)
  {
    type: "function",
    function: {
      name: "api_tester",
      description: "Send precision HTTP requests to REST or GraphQL endpoints with microsecond timing, authentication headers, JSON payload validations, and status assertions.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "API endpoint URL to test." },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            description: "HTTP method (default 'GET').",
          },
          headers: { type: "object", description: "HTTP request headers." },
          body: { type: "string", description: "Request payload (JSON string or raw text)." },
          auth: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["bearer", "basic", "api_key"] },
              token: { type: "string" },
              username: { type: "string" },
              password: { type: "string" },
              header_name: { type: "string" },
            },
            description: "Authentication credentials.",
          },
          expected_status: { type: "integer", description: "Expected HTTP response status (e.g. 200, 201)." },
          json_assertions: { type: "object", description: "Key-value assertions on response JSON fields." },
          timeout_ms: { type: "integer", description: "Request timeout in ms (default 10000)." },
        },
        required: ["url"],
      },
    },
  },
  // 24. route_inspector (NEW)
  {
    type: "function",
    function: {
      name: "route_inspector",
      description: "Inspect backend server files (Express, Fastify, Next.js, FastAPI, Flask) to extract all route endpoints, middleware stacks, CORS policies, and security vulnerabilities.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Backend source file or directory path." },
          framework: {
            type: "string",
            enum: ["auto", "express", "fastify", "nextjs", "fastapi", "flask"],
            description: "Backend framework (default 'auto').",
          },
          check_security: { type: "boolean", description: "Whether to audit security middleware (default true)." },
        },
      },
    },
  },
  // 25. db_client (NEW)
  {
    type: "function",
    function: {
      name: "db_client",
      description: "Universal Database tool: inspect schema tables, execute SQLite queries, validate schema normalization, and analyze SQL queries for index efficiency and injection risks.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["inspect_schema", "execute_query", "analyze_query", "validate_schema", "list_tables"],
            description: "Database action to execute.",
          },
          db_type: {
            type: "string",
            enum: ["sqlite", "postgres", "mysql", "mongodb"],
            description: "Database engine (default 'sqlite').",
          },
          connection_or_file: { type: "string", description: "SQLite file path or schema file path." },
          query: { type: "string", description: "SQL query string for execute_query or analyze_query." },
          schema_content: { type: "string", description: "Raw DDL schema text for validate_schema." },
        },
        required: ["action"],
      },
    },
  },
  // 26. schema_migrator (NEW)
  {
    type: "function",
    function: {
      name: "schema_migrator",
      description: "Generate reversible database migrations (UP/DOWN SQL), TypeScript domain interfaces, or Prisma/Drizzle ORM model schemas.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["generate_migration", "diff_schema", "generate_models", "generate_seed"],
            description: "Migration action.",
          },
          orm: {
            type: "string",
            enum: ["sql", "prisma", "drizzle", "typeorm", "sqlalchemy"],
            description: "Target ORM / format (default 'sql').",
          },
          tables_spec: { type: "string", description: "Table specifications or DDL description." },
          migration_name: { type: "string", description: "Name for the migration (e.g. 'add_user_roles')." },
          output_file: { type: "string", description: "Optional output file path to write to." },
        },
        required: ["action"],
      },
    },
  },
  // 27. test_runner (NEW)
  {
    type: "function",
    function: {
      name: "test_runner",
      description: "Execute test suites (Vitest, Jest, Pytest, Playwright, Node test runner) and parse test counts, execution time, and failure assertion diffs.",
      parameters: {
        type: "object",
        properties: {
          framework: {
            type: "string",
            enum: ["auto", "vitest", "jest", "pytest", "playwright", "node"],
            description: "Testing framework (default 'auto').",
          },
          test_path: { type: "string", description: "Specific test file or directory path." },
          filter_pattern: { type: "string", description: "Filter regex or test name pattern." },
          coverage: { type: "boolean", description: "Whether to collect code coverage (default false)." },
          cwd: { type: "string", description: "Working directory." },
        },
      },
    },
  },
  // 28. load_tester (NEW)
  {
    type: "function",
    function: {
      name: "load_tester",
      description: "Run high-concurrency HTTP benchmark load tests against a target URL to measure throughput (RPS), p50/p95/p99 latency percentiles, and error rates.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target endpoint URL to stress test." },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method (default 'GET')." },
          requests: { type: "integer", description: "Total number of requests (default 50, max 2000)." },
          concurrency: { type: "integer", description: "Concurrent virtual clients (default 5, max 50)." },
          headers: { type: "object", description: "Optional HTTP headers." },
          body: { type: "string", description: "Optional request body." },
          timeout_ms: { type: "integer", description: "Per-request timeout in ms (default 5000)." },
        },
        required: ["url"],
      },
    },
  },
  // 29. hosting_deployer (NEW)
  {
    type: "function",
    function: {
      name: "hosting_deployer",
      description: "Generate hardened, production-ready cloud deployment configurations: multi-stage Dockerfile, docker-compose.yml, Nginx reverse proxy with SSL/HTTP2, and GitHub Actions CI/CD workflows.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["generate", "audit"], description: "Action to perform (default 'generate')." },
          target: {
            type: "string",
            enum: ["docker", "docker_compose", "nginx", "cicd"],
            description: "Deployment target architecture.",
          },
          project_type: {
            type: "string",
            enum: ["node", "nextjs", "react", "python", "fastapi", "go", "static"],
            description: "Project runtime type (default 'node').",
          },
          options: { type: "object", description: "Configuration parameters (ports, domains, ssl)." },
          output_file: { type: "string", description: "Optional file path to write generated config." },
        },
        required: ["target"],
      },
    },
  },
  // 30. port_scanner (NEW)
  {
    type: "function",
    function: {
      name: "port_scanner",
      description: "Inspect network ports, discover active services (Node, Vite, Postgres, Redis, Mongo, FastAPI), check HTTP health, and verify SSL certificate expiration.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["scan_ports", "check_health", "check_ssl"],
            description: "Network action to perform (default 'scan_ports').",
          },
          host: { type: "string", description: "Target host (default '127.0.0.1')." },
          ports: { type: "array", items: { type: "integer" }, description: "List of port numbers to scan." },
          url: { type: "string", description: "URL for check_health or check_ssl." },
          timeout_ms: { type: "integer", description: "Socket connection timeout in ms (default 2000)." },
        },
      },
    },
  },
  // 31. project_auditor (NEW)
  {
    type: "function",
    function: {
      name: "project_auditor",
      description: "Perform an end-to-end audit of the full-stack project against industry highest standards (A11y, API security, DB modeling, test setup, Docker hosting, CI/CD) with a scored report.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Root project directory to audit (default '.')." },
          scope: {
            type: "string",
            enum: ["all", "frontend", "backend", "database", "testing", "hosting", "security"],
            description: "Audit scope (default 'all').",
          },
          fix_suggestions: { type: "boolean", description: "Include actionable fix suggestions (default true)." },
        },
      },
    },
  },
];

// --- Tool Implementations --------------------------------------------------

async function readFile({ path: p, start_line, end_line, show_line_numbers = true }) {
  const content = await fs.readFile(p, "utf8");
  const lines = content.split("\n");
  const start = Math.max(1, start_line || 1);
  const end = end_line ? Math.min(lines.length, end_line) : lines.length;

  const sliced = lines.slice(start - 1, end);
  if (!show_line_numbers) {
    return truncate(sliced.join("\n"));
  }

  const padWidth = String(end).length;
  const numbered = sliced.map((line, idx) => {
    const lineNum = String(start + idx).padStart(padWidth, " ");
    return `${lineNum} | ${line}`;
  });

  return truncate(`[File: ${p} (lines ${start}-${end} of ${lines.length})]\n` + numbered.join("\n"));
}

async function writeFile({ path: p, content }) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
  return `Successfully wrote ${content.length} characters to ${p}`;
}

async function editFile({ path: p, old_str, new_str }) {
  const content = await fs.readFile(p, "utf8");
  const occurrences = content.split(old_str).length - 1;
  if (occurrences === 0) {
    return `ERROR: old_str not found in ${p}. No changes made. Make sure whitespace and indentation match exactly.`;
  }
  if (occurrences > 1) {
    return `ERROR: old_str matches ${occurrences} places in ${p} — must be unique. Provide more surrounding context lines.`;
  }
  const updated = content.replace(old_str, new_str);
  await fs.writeFile(p, updated, "utf8");
  return `Successfully edited ${p} (1 unique occurrence replaced).`;
}

async function listDir({ path: p = ".", max_depth = 1 }) {
  const results = [];

  async function scan(dir, currentDepth) {
    if (currentDepth > max_depth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      results.push(`[error reading ${dir}: ${err.message}]`);
      return;
    }

    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(p, full) || e.name;
      if (e.isDirectory()) {
        results.push(`[DIR]  ${rel}/`);
        await scan(full, currentDepth + 1);
      } else {
        try {
          const stat = await fs.stat(full);
          const sizeKb = (stat.size / 1024).toFixed(1);
          results.push(`[FILE] ${rel} (${sizeKb} KB)`);
        } catch {
          results.push(`[FILE] ${rel}`);
        }
      }
    }
  }

  await scan(p, 1);
  return truncate(results.length ? results.join("\n") : "(empty directory)");
}

async function searchCode({ pattern, path: dir = ".", case_sensitive = false }) {
  try {
    const flags = case_sensitive ? "-n --max-count 10" : "-n -i --max-count 10";
    const { stdout } = await execAsync(
      `rg ${flags} -- ${JSON.stringify(pattern)} ${JSON.stringify(dir)}`,
      { maxBuffer: 5 * 1024 * 1024 }
    );
    return truncate(stdout || "(no matches found)");
  } catch (err) {
    if (err.stdout !== undefined && err.code === 1) return "(no matches found)";
  }

  // Fallback scanner
  const results = [];
  const flags = case_sensitive ? "" : "i";
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (results.length < 150) {
        try {
          const content = await fs.readFile(full, "utf8");
          const lines = content.split("\n");
          lines.forEach((line, idx) => {
            if (regex.test(line)) {
              results.push(`${full}:${idx + 1}: ${line.trim()}`);
            }
          });
        } catch {
          // ignore binary files
        }
      }
    }
  }

  await walk(dir);
  return truncate(results.length ? results.join("\n") : "(no matches found)");
}

async function runCommand({ command, cwd, background = false, timeout_ms = 60000 }) {
  if (background) {
    const task = taskManager.startTask({
      command,
      cwd: cwd || process.cwd(),
      background: true,
      timeoutMs: timeout_ms,
    });
    return `[Background Task Dispatched]\nTask ID: ${task.id}\nPID: ${task.pid}\nCommand: ${command}\nUse 'manage_background_tasks' with task_id="${task.id}" to check logs or send input.`;
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || process.cwd(),
      timeout: timeout_ms,
      maxBuffer: 5 * 1024 * 1024,
    });
    return truncate(`$ ${command}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`);
  } catch (err) {
    return truncate(
      `$ ${command}\n[exit code ${err.code ?? 1}]\n${err.stdout || ""}\n[stderr]\n${err.stderr || err.message}`
    );
  }
}

async function findFiles({ path: dir = ".", name_pattern, extension, type = "any", max_results = 50 }) {
  const matches = [];

  let nameRegex = null;
  if (name_pattern) {
    const globPattern = name_pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
    nameRegex = new RegExp(`^${globPattern}$`, "i");
  }

  async function walk(current) {
    if (matches.length >= max_results) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(current, e.name);
      const isDir = e.isDirectory();
      const isFile = e.isFile();

      let typeMatches = true;
      if (type === "file" && !isFile) typeMatches = false;
      if (type === "dir" && !isDir) typeMatches = false;

      let nameMatches = true;
      if (nameRegex && !nameRegex.test(e.name)) nameMatches = false;

      let extMatches = true;
      if (extension && isFile) {
        const fileExt = path.extname(e.name).replace(/^\./, "");
        if (fileExt.toLowerCase() !== extension.toLowerCase().replace(/^\./, "")) {
          extMatches = false;
        }
      }

      if (typeMatches && nameMatches && extMatches) {
        matches.push(full);
      }

      if (isDir) {
        await walk(full);
      }
    }
  }

  await walk(dir);
  return matches.length ? matches.join("\n") : "(no files found matching criteria)";
}

async function batchEdit({ pattern, replacement, files, dry_run = false }) {
  if (!Array.isArray(files) || files.length === 0) {
    return "ERROR: 'files' array must not be empty.";
  }

  const reports = [];
  let totalReplacements = 0;

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      const count = content.split(pattern).length - 1;
      if (count > 0) {
        totalReplacements += count;
        if (!dry_run) {
          const updated = content.replaceAll(pattern, replacement);
          await fs.writeFile(file, updated, "utf8");
          reports.push(`✓ ${file}: replaced ${count} occurrences`);
        } else {
          reports.push(`[DRY-RUN] ${file}: ${count} occurrences would be replaced`);
        }
      } else {
        reports.push(`- ${file}: pattern not found`);
      }
    } catch (err) {
      reports.push(`✖ ${file}: error (${err.message})`);
    }
  }

  return `Batch edit complete. Total occurrences: ${totalReplacements}\n` + reports.join("\n");
}

async function gitAction({ action, args = "" }) {
  const allowed = ["status", "diff", "log", "add", "commit", "branch", "checkout", "stash", "blame"];
  if (!allowed.includes(action)) {
    return `ERROR: Invalid git action "${action}". Allowed: ${allowed.join(", ")}`;
  }

  let cmd = `git ${action}`;
  if (action === "log" && !args) {
    cmd = `git log -n 10 --oneline --graph --decorate`;
  } else if (action === "status" && !args) {
    cmd = `git status -s`;
  } else if (args) {
    cmd = `git ${action} ${args}`;
  }

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
    return truncate(`$ ${cmd}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`);
  } catch (err) {
    return truncate(`$ ${cmd}\n[exit code ${err.code ?? 1}]\n${err.stdout || ""}\n[stderr]\n${err.stderr || err.message}`);
  }
}

async function webFetch({ url, method = "GET", headers = {}, body, max_length = 8000 }) {
  try {
    const reqOpts = {
      method,
      headers: {
        "User-Agent": "Fixy-Agent/2.0",
        ...headers,
      },
    };
    if (body && (method === "POST" || method === "PUT")) {
      reqOpts.body = body;
    }

    const res = await fetch(url, reqOpts);
    const contentType = res.headers.get("content-type") || "";
    let dataText = "";

    if (contentType.includes("application/json")) {
      const json = await res.json();
      dataText = JSON.stringify(json, null, 2);
    } else {
      dataText = await res.text();
      // Strip script/style tags if HTML
      if (contentType.includes("text/html")) {
        dataText = dataText
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
      }
    }

    const preview = dataText.slice(0, max_length);
    const truncNote = dataText.length > max_length ? `\n...[truncated, ${dataText.length - max_length} more chars]` : "";
    return `[HTTP ${res.status} ${res.statusText}]\n${preview}${truncNote}`;
  } catch (err) {
    return `ERROR web_fetch failed: ${err.message}`;
  }
}

async function manageBackgroundTasks({ action, task_id, input, lines = 30 }) {
  if (action === "list") {
    const list = taskManager.listTasks();
    if (!list.length) return "No active or past background tasks.";
    return JSON.stringify(list, null, 2);
  }

  if (!task_id) return "ERROR: 'task_id' is required for action " + action;

  if (action === "status") {
    const task = taskManager.getTask(task_id);
    if (!task) return `Task "${task_id}" not found.`;
    return JSON.stringify({
      id: task.id,
      command: task.command,
      pid: task.pid,
      status: task.status,
      startTime: task.startTime,
      endTime: task.endTime,
      exitCode: task.exitCode,
      logLines: task.logs.length,
    }, null, 2);
  }

  if (action === "logs") {
    return taskManager.getLogs(task_id, lines);
  }

  if (action === "kill") {
    return taskManager.killTask(task_id);
  }

  if (action === "send_input") {
    if (input === undefined) return "ERROR: 'input' string is required for send_input.";
    return taskManager.sendInput(task_id, input);
  }

  return `Unknown action "${action}"`;
}

async function invokeSubagent({ agent_name, task_prompt, background = false, max_rounds }) {
  try {
    const parentModel = getActiveModel() || (await resolveAvailableModel(null));
    const res = await subagentManager.runSubagent({
      agentName: agent_name,
      taskPrompt: task_prompt,
      parentModel,
      background,
      maxRounds: max_rounds,
    });
    if (background) {
      return `[Sub-Agent Dispatched to Background]\nTask ID: ${res.taskId}\nAgent: ${res.agent} (${res.role})\nStatus: ${res.status}\nMessage: ${res.message}\nUse 'manage_subagents' with task_id="${res.taskId}" to check logs.`;
    }
    return `[Sub-Agent ${res.agent} (${res.role}) Completed Task (ID: ${res.taskId})]\n${res.output}`;
  } catch (err) {
    return `ERROR invoking sub-agent: ${err.message}`;
  }
}

async function invokeParallelSubagents({ agents, background = false, max_rounds }) {
  try {
    if (!Array.isArray(agents) || agents.length === 0) {
      return "ERROR: 'agents' array must contain at least one subagent specification.";
    }
    const parentModel = getActiveModel() || (await resolveAvailableModel(null));
    const res = await subagentManager.runParallelSubagents({
      agents,
      parentModel,
      background,
      maxRounds: max_rounds,
    });

    if (background) {
      const summary = res.tasks
        .map((t) => `• [${t.taskId}] ${t.agent} (${t.role}): ${t.status}`)
        .join("\n");
      return `[Parallel Sub-Agents (${res.count}) Dispatched to Background]\n${summary}\nAll agents are now working concurrently in the background. You will receive notifications upon completion.`;
    }

    const report = res.results
      .map((r, i) => `=== [Agent ${i + 1}/${res.count}: ${r.agent} (${r.role})] ===\n${r.output}`)
      .join("\n\n");
    return `[Parallel Execution Complete: ${res.count} Sub-Agents Finished Concurrently]\n\n${report}`;
  } catch (err) {
    return `ERROR executing parallel sub-agents: ${err.message}`;
  }
}

async function manageSubagents({ action, task_id, lines = 30 }) {
  if (action === "list") {
    const list = subagentManager.listTasks();
    if (!list.length) return "No active or past sub-agent tasks.";
    return JSON.stringify(list, null, 2);
  }

  if (!task_id) return "ERROR: 'task_id' is required for action " + action;

  if (action === "status") {
    const task = subagentManager.getTask(task_id);
    if (!task) return `Sub-agent task "${task_id}" not found.`;
    return JSON.stringify({
      id: task.id,
      agentName: task.agentName,
      role: task.role,
      status: task.status,
      background: task.background,
      startTime: task.startTime,
      endTime: task.endTime,
      duration: task.endTime ? `${Math.round((task.endTime - task.startTime) / 1000)}s` : "running",
      outputPreview: task.output ? task.output.slice(0, 150) + "…" : null,
      error: task.error,
    }, null, 2);
  }

  if (action === "logs") {
    const task = subagentManager.getTask(task_id);
    if (!task) return `Sub-agent task "${task_id}" not found.`;
    const slice = task.logs.slice(-lines);
    return slice.map((l) => `[${l.type}] ${l.text || (l.name ? `${l.name}(${JSON.stringify(l.args)})` : l.result || "")}`).join("\n") || "(no logs yet)";
  }

  if (action === "kill") {
    return subagentManager.killTask(task_id);
  }

  return `Unknown subagent action "${action}"`;
}

async function defineAgent({ name, role, description, system_prompt, allowed_tools, model_override, max_rounds }) {
  try {
    const def = subagentManager.registerAgent({
      name,
      role,
      description,
      systemPrompt: system_prompt,
      allowedTools: allowed_tools || "all",
      model: model_override || null,
      maxRounds: max_rounds,
    });
    return `Successfully defined and registered custom agent "${def.name}" (${def.role}).`;
  } catch (err) {
    return `ERROR defining agent: ${err.message}`;
  }
}

async function codeStructure({ path: p }) {
  try {
    const content = await fs.readFile(p, "utf8");
    const lines = content.split("\n");
    const symbols = [];

    const functionRegex = /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/;
    const classRegex = /^\s*(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/;
    const constFuncRegex = /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/;
    const importRegex = /^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/;
    const pythonDefRegex = /^\s*def\s+([a-zA-Z0-9_]+)\s*\(/;
    const pythonClassRegex = /^\s*class\s+([a-zA-Z0-9_]+)/;

    lines.forEach((line, i) => {
      let match;
      if ((match = line.match(functionRegex))) {
        symbols.push(`Line ${i + 1}: function ${match[1]}()`);
      } else if ((match = line.match(classRegex))) {
        symbols.push(`Line ${i + 1}: class ${match[1]}`);
      } else if ((match = line.match(constFuncRegex))) {
        symbols.push(`Line ${i + 1}: arrow function ${match[1]}()`);
      } else if ((match = line.match(importRegex))) {
        symbols.push(`Line ${i + 1}: import from "${match[2]}"`);
      } else if ((match = line.match(pythonDefRegex))) {
        symbols.push(`Line ${i + 1}: def ${match[1]}()`);
      } else if ((match = line.match(pythonClassRegex))) {
        symbols.push(`Line ${i + 1}: class ${match[1]}`);
      }
    });

    return symbols.length
      ? `[Code Outline for ${p}]\n` + symbols.join("\n")
      : `[Code Outline for ${p}]\n(No top-level functions or classes detected)`;
  } catch (err) {
    return `ERROR reading structure: ${err.message}`;
  }
}

async function fileInfo({ path: p }) {
  try {
    const stat = await fs.stat(p);
    let hash = "N/A (directory)";
    let lineCount = "N/A (directory)";

    if (stat.isFile()) {
      const buffer = await fs.readFile(p);
      hash = crypto.createHash("sha256").update(buffer).digest("hex");
      try {
        const text = buffer.toString("utf8");
        lineCount = String(text.split("\n").length);
      } catch {
        lineCount = "(binary)";
      }
    }

    const info = {
      path: path.resolve(p),
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      sizeBytes: stat.size,
      sizeFormatted: stat.size > 1024 * 1024
        ? `${(stat.size / (1024 * 1024)).toFixed(2)} MB`
        : `${(stat.size / 1024).toFixed(2)} KB`,
      lineCount,
      sha256: hash,
      created: stat.birthtime,
      modified: stat.mtime,
      permissions: "0" + (stat.mode & parseInt("777", 8)).toString(8),
    };

    return JSON.stringify(info, null, 2);
  } catch (err) {
    return `ERROR inspecting path: ${err.message}`;
  }
}

async function envManager({ action, variable_name, dotenv_path = ".env" }) {
  if (action === "list") {
    const safeKeys = Object.keys(process.env).filter(
      (k) => !k.includes("KEY") && !k.includes("SECRET") && !k.includes("TOKEN") && !k.includes("PASS")
    );
    return `Available Safe Environment Variables:\n` + safeKeys.slice(0, 40).join("\n");
  }

  if (action === "get") {
    if (!variable_name) return "ERROR: 'variable_name' required.";
    const val = process.env[variable_name];
    if (val === undefined) return `Environment variable "${variable_name}" is NOT set.`;
    return `${variable_name}=${val}`;
  }

  if (action === "read_dotenv") {
    try {
      const content = await fs.readFile(dotenv_path, "utf8");
      const lines = content.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      const masked = lines.map((line) => {
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) return line;
        const key = line.slice(0, eqIdx);
        const val = line.slice(eqIdx + 1);
        if (key.match(/KEY|SECRET|PASS|TOKEN|AUTH/i)) {
          return `${key}=******** (masked)`;
        }
        return `${key}=${val}`;
      });
      return `[.env file contents: ${dotenv_path}]\n` + masked.join("\n");
    } catch (err) {
      return `ERROR reading ${dotenv_path}: ${err.message}`;
    }
  }

  return `Unknown env action "${action}"`;
}

async function systemDiagnostics() {
  const freeMem = (os.freemem() / 1024 / 1024).toFixed(1);
  const totalMem = (os.totalmem() / 1024 / 1024).toFixed(1);
  const cpus = os.cpus();

  const data = {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    platform: os.platform(),
    hostname: os.hostname(),
    uptimeHours: (os.uptime() / 3600).toFixed(1),
    memory: `${freeMem} MB free / ${totalMem} MB total`,
    cpuModel: cpus[0]?.model || "Unknown",
    cpuCores: cpus.length,
    nodeVersion: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    runningBackgroundTasks: taskManager.runningCount(),
  };

  return JSON.stringify(data, null, 2);
}

async function manageMemory({ action, key, value }) {
  if (action === "set") {
    if (!key) return "ERROR: 'key' is required to set memory.";
    sessionMemory.set(key, value);
    return `Saved memory key "${key}".`;
  }
  if (action === "get") {
    if (!key) return "ERROR: 'key' is required to get memory.";
    if (!sessionMemory.has(key)) return `Memory key "${key}" not found.`;
    return sessionMemory.get(key);
  }
  if (action === "list") {
    if (sessionMemory.size === 0) return "(Session memory scratchpad is empty)";
    const entries = [];
    for (const [k, v] of sessionMemory.entries()) {
      entries.push(`${k}: ${String(v).slice(0, 80)}${String(v).length > 80 ? "…" : ""}`);
    }
    return entries.join("\n");
  }
  if (action === "delete") {
    if (!key) return "ERROR: 'key' is required to delete memory.";
    const deleted = sessionMemory.delete(key);
    return deleted ? `Deleted memory key "${key}".` : `Key "${key}" did not exist.`;
  }
  if (action === "clear") {
    sessionMemory.clear();
    return "Session memory scratchpad cleared.";
  }
  return `Unknown action "${action}"`;
}

function parseLineRanges(linesSpec, startLine, endLine, maxLineCount) {
  const selectedLines = new Set();

  if (startLine || endLine) {
    const s = Math.max(1, startLine || 1);
    const e = endLine ? Math.min(maxLineCount, endLine) : maxLineCount;
    for (let i = s; i <= e; i++) {
      selectedLines.add(i);
    }
  }

  if (linesSpec !== undefined && linesSpec !== null) {
    let tokens = [];
    if (Array.isArray(linesSpec)) {
      tokens = linesSpec;
    } else if (typeof linesSpec === "number") {
      tokens = [linesSpec];
    } else if (typeof linesSpec === "string") {
      tokens = linesSpec.split(/[,\s]+/).filter(Boolean);
    }

    for (const token of tokens) {
      const strToken = String(token).trim();
      if (!strToken) continue;
      if (strToken.includes("-")) {
        const [startStr, endStr] = strToken.split("-");
        const s = parseInt(startStr, 10);
        const e = parseInt(endStr, 10);
        if (!isNaN(s) && !isNaN(e)) {
          const from = Math.max(1, Math.min(s, e));
          const to = Math.min(maxLineCount, Math.max(s, e));
          for (let i = from; i <= to; i++) {
            selectedLines.add(i);
          }
        }
      } else {
        const num = parseInt(strToken, 10);
        if (!isNaN(num) && num >= 1 && num <= maxLineCount) {
          selectedLines.add(num);
        }
      }
    }
  }

  return Array.from(selectedLines).sort((a, b) => a - b);
}

async function readLines({
  files,
  path: singlePath,
  lines,
  start_line,
  end_line,
  context_lines = 0,
  show_line_numbers = true,
}) {
  const targetFiles = [];
  if (Array.isArray(files)) {
    targetFiles.push(...files.filter((f) => typeof f === "string" && f.trim()));
  } else if (typeof files === "string" && files.trim()) {
    targetFiles.push(files.trim());
  }
  if (singlePath && typeof singlePath === "string" && !targetFiles.includes(singlePath.trim())) {
    targetFiles.push(singlePath.trim());
  }

  if (targetFiles.length === 0) {
    return "ERROR: At least one file path must be provided in 'files' or 'path'.";
  }

  const results = [];

  for (const filePath of targetFiles) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const allLines = content.split("\n");
      const totalCount = allLines.length;

      let lineNumbers = parseLineRanges(lines, start_line, end_line, totalCount);

      // If no specific lines or range was specified, default to first 100 lines
      if (lineNumbers.length === 0) {
        const defaultEnd = Math.min(totalCount, 100);
        for (let i = 1; i <= defaultEnd; i++) {
          lineNumbers.push(i);
        }
      }

      // Add context lines if requested
      if (context_lines && context_lines > 0) {
        const withContext = new Set();
        for (const num of lineNumbers) {
          const from = Math.max(1, num - context_lines);
          const to = Math.min(totalCount, num + context_lines);
          for (let c = from; c <= to; c++) {
            withContext.add(c);
          }
        }
        lineNumbers = Array.from(withContext).sort((a, b) => a - b);
      }

      if (lineNumbers.length === 0) {
        results.push(`[File: ${filePath} (0 matched lines of ${totalCount} total)]\n(No matching line numbers within range 1-${totalCount})`);
        continue;
      }

      const padWidth = String(totalCount).length;
      const formattedChunks = [];
      let prevLineNum = null;

      for (const lineNum of lineNumbers) {
        if (prevLineNum !== null && lineNum > prevLineNum + 1) {
          formattedChunks.push("  ...");
        }
        prevLineNum = lineNum;

        const lineText = allLines[lineNum - 1] ?? "";
        if (show_line_numbers) {
          const padded = String(lineNum).padStart(padWidth, " ");
          formattedChunks.push(`${padded} | ${lineText}`);
        } else {
          formattedChunks.push(lineText);
        }
      }

      const header = `[File: ${filePath} (${lineNumbers.length} lines shown / ${totalCount} total lines)]`;
      results.push(`${header}\n` + formattedChunks.join("\n"));
    } catch (err) {
      results.push(`[File: ${filePath} - ERROR: ${err.message}]`);
    }
  }

  return truncate(results.join("\n\n" + "-".repeat(50) + "\n\n"));
}

async function setRoundsLimit({ max_rounds }) {
  if (!max_rounds || typeof max_rounds !== "number") {
    return "ERROR: 'max_rounds' must be a valid positive integer.";
  }
  const updated = setMaxRounds(max_rounds);
  return `Successfully updated session maximum tool rounds limit to: ${updated}`;
}

const HANDLERS = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  list_dir: listDir,
  search_code: searchCode,
  run_command: runCommand,
  find_files: findFiles,
  batch_edit: batchEdit,
  git_action: gitAction,
  web_fetch: webFetch,
  manage_background_tasks: manageBackgroundTasks,
  invoke_subagent: invokeSubagent,
  invoke_parallel_subagents: invokeParallelSubagents,
  manage_subagents: manageSubagents,
  define_agent: defineAgent,
  code_structure: codeStructure,
  file_info: fileInfo,
  env_manager: envManager,
  system_diagnostics: systemDiagnostics,
  manage_memory: manageMemory,
  read_lines: readLines,
  set_rounds_limit: setRoundsLimit,
  web_scaffold: webScaffold,
  frontend_inspector: frontendInspector,
  api_tester: apiTester,
  route_inspector: routeInspector,
  db_client: dbClient,
  schema_migrator: schemaMigrator,
  test_runner: testRunner,
  load_tester: loadTester,
  hosting_deployer: hostingDeployer,
  port_scanner: portScanner,
  project_auditor: projectAuditor,
};

/**
 * Execute a tool call by name with the given arguments.
 */
export async function runTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return `ERROR: unknown tool "${name}"`;
  try {
    return await handler(args || {});
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}
