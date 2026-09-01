# Fixy (Edition 2.0) — Autonomous Terminal Engineering Agent

An autonomous, on-device & cloud AI engineering assistant featuring a **cyber terminal interface**, **professional visual cards**, dual **Ollama & OpenRouter LLM providers**, a specialized **Parallel Multi-Agent Subsystem** with an autonomous & interactive **Agent Creator**, a non-blocking **Background Task Engine**, configurable **Max Tool Rounds Limits**, and a comprehensive suite of **42 precision tools** and **12 specialized sub-agents**.

---

## Key Highlights

- **Dual LLM Providers (Ollama + OpenRouter)**:
  - **Ollama**: Run 100% locally and offline on your machine/Termux with your installed open-weights models (no hardcoded defaults; automatically picks from your local models).
  - **OpenRouter (100% Free Models)**: Access top cloud models with `:free` tier (`Llama 3.3 70B Instruct:free`, `DeepSeek R1:free`, `DeepSeek V3:free`, `Gemini 2.0 Flash Exp:free`, `Qwen 2.5 Coder 32B:free`, `Mistral Small 24B:free`, etc.) with zero payment required.
  - **Seamless Switching & Key Setup**: Easily switch between Ollama and OpenRouter anytime via `/provider` or `/model`, add/update your API key with `/provider key <key>` or interactive prompts, and filter exclusively for free models.
- **Cyber Terminal Aesthetic & Professional Cards**:
  - ⚙ **Tool Cards**: Boxed parameters table, execution duration timer `(14ms)`, status badges `[✔ SUCCESS]` / `[✖ FAILED]`, and formatted result previews.
  - ✦ **Sub-Agent Cards**: Visual profiles showing role domain, toolset permissions, max rounds, and model configuration.
  - ⚡ **Background Shell Task Cards**: Real-time status pills `[● RUNNING]`, PID, elapsed duration, command string, and recent log tail.
  - ✦ **Background Sub-Agent Cards**: Task specifications, duration, specialist info, and structured findings previews.
  - ◈ **Command Matrix**: Grouped command cards with clear functional sections.
- **Autonomous & Interactive Agent Creator**:
  - Fixy can **autonomously create new custom sub-agents on the fly** via `define_agent` when a task requires specialized domain expertise.
  - Users can also create and persist custom agents interactively using the `/create-agent` wizard.
- **Dynamic Rounds Limit Control**: Set and adjust max tool rounds dynamically during runtime via `/rounds <number>`, the `set_rounds_limit` tool, or per-agent `max_rounds` parameters.
- **Parallel Sub-Agent Execution**: Invoke multiple sub-agents **at the same time in parallel** (e.g. run `frontend_engineer`, `backend_engineer`, `database_architect`, `qa_engineer`, and `cloud_devops` concurrently) using `invoke_parallel_subagents`.
- **Background Sub-Agent Execution**: Dispatch sub-agents to run asynchronously in the background (`background: true`) so work continues uninterrupted.
- **Non-blocking Shell Background Tasks**: Run long-running servers, test suites, or sub-agents in the background with live completion notifications.

---

## Complete Suite of 42 Professional Tools

### 🌐 Frontend & Web Construction
1. `web_scaffold` — Scaffold full-stack web projects (`modern_html`, `react_tailwind`, `vue`, `svelte`, `nextjs`, `express_api`, `fastapi`), accessible UI components (Navbar, Modal, Hero, Form, DataTable, CardGrid), and complete pages.
2. `frontend_inspector` — Static audit for WCAG Accessibility (a11y), SEO meta tags, OpenGraph, mobile responsiveness, and asset performance.
3. `web_fetch` — HTTP client for API queries and clean web documentation retrieval.

### 🔍 Advanced Internet & Browsing (zero-dependency, Node 22 built-ins)
4. `web_search` — Multi-engine web search: DuckDuckGo HTML, Wikipedia REST, GitHub API, npm registry. No API key required.
5. `web_scrape` — CSS-selector based HTML scraping with structured JSON extraction (field→selector map) and per-attribute extraction (e.g. `href`, `src`).
6. `web_crawl` — Multi-page recursive crawler with depth limit, same-domain filter, URL include/exclude regex, and optional polite delay.
7. `web_screenshot` — Headless render descriptor: title, language, viewport, DOM tag histogram, asset inventory, and performance hints.
8. `web_extract_links` — All hyperlinks with text, `rel`, `type`, `target`, internal/external classification, and regex filtering.
9. `web_extract_metadata` — SEO meta, OpenGraph, Twitter Card, JSON-LD structured data, link relations, microdata/RDFa detection.
10. `web_download` — Stream remote files (PDF, images, archives) to disk with size limit and overwrite control.
11. `web_rss` — Parse RSS 2.0 / Atom 1.0 feeds: title, entries, links, authors, pubDate, GUID, categories, optional content.
12. `web_sitemap` — Parse XML sitemaps (urlset or sitemap index) with optional sub-sitemap enumeration.

### ⚙ Backend & API Architecture
13. `api_tester` — Send precision HTTP/REST/GraphQL requests with microsecond latency timing, Bearer/Basic auth, JSON schema validation, and status assertions.
14. `route_inspector` — Introspect backend routes (Express, Fastify, Next.js, FastAPI, Flask), middleware stacks, CORS policies, and security vulnerabilities.

### 🗄 Database & ORM Modeling
15. `db_client` — Universal DB tool: schema table inspection, SQLite query execution, SQL anti-pattern analysis, and relational schema normalization validation.
16. `schema_migrator` — Generate reversible UP/DOWN SQL migrations, TypeScript domain interfaces, Prisma models, or Drizzle schemas.

### 🧪 Automated Testing & Benchmarks
17. `test_runner` — Execute unit/integration/E2E test suites (Vitest, Jest, Pytest, Playwright, Node test runner) and extract failure assertion diffs.
18. `load_tester` — High-concurrency HTTP benchmark stress tester measuring throughput (RPS), p50/p95/p99 latency percentiles, and error rates.

### 🚀 Hosting, Cloud & DevOps
19. `hosting_deployer` — Generate hardened multi-stage Dockerfiles, `docker-compose.yml`, Nginx reverse proxy configs with SSL/HTTP2, and GitHub Actions CI/CD workflows.
20. `port_scanner` — Inspect network ports, discover active services (Node, Vite, Postgres, Redis, Mongo, FastAPI), check HTTP health, and verify SSL certificate expiration.
21. `project_auditor` — Full-stack quality and highest-standards architecture auditor producing a scored diagnostic scorecard across 6 architectural pillars.

### 📝 Precision File & Code Intelligence
22. `read_file` — Read text with optional line numbers and ranges.
23. `read_lines` — Read specific line numbers, ranges, or line selections from one or more files simultaneously.
24. `write_file` — Create or overwrite files.
25. `edit_file` — Surgical exact replacement with unique match verification.
26. `batch_edit` — Multi-file search and replace with dry-run safety.
27. `list_dir` — Directory tree inspection with recursive depth and sizes.
28. `search_code` — High-speed ripgrep/regex code search across files.
29. `find_files` — Advanced search by glob pattern, file extension, and type.
30. `code_structure` — Extract code outlines (functions, classes, exports, imports).
31. `file_info` — Detailed metadata (size, lines, permissions, SHA-256 hash).

### 🤖 Multi-Agent & Execution Engine
32. `invoke_subagent` — Delegate sub-tasks to a specialized subagent (foreground or background, with `max_rounds`).
33. `invoke_parallel_subagents` — Spawn multiple subagents simultaneously in parallel (with `max_rounds`).
34. `manage_subagents` — List, inspect status, read logs, or cancel background subagents.
35. `define_agent` — Programmatically create and register new custom agents (with `max_rounds`).
36. `set_rounds_limit` — Dynamically adjust execution budget and max rounds limit.
37. `manage_memory` — Session scratchpad store for multi-turn planning.

### ⚡ System & Environment
38. `run_command` — Execute shell commands in foreground or background.
39. `manage_background_tasks` — List, inspect logs, send stdin, or terminate background shell processes.
40. `git_action` — Git operations (`status`, `diff`, `log`, `commit`, `branch`, `stash`, `blame`).
41. `env_manager` — Safe inspection and parsing of environment variables and `.env` files.
42. `system_diagnostics` — Host CPU, memory, uptime, and OS statistics.

---

## 12 Specialized Sub-Agents

1. `frontend_engineer` — Lead Frontend & UI/UX Engineer (WCAG a11y, Tailwind, React, Vue, Svelte, Next.js).
2. `backend_engineer` — Senior Backend & API Architect (REST/GraphQL, microservices, auth, rate limiting).
3. `database_architect` — Database & Data Modeling Architect (Postgres, SQLite, MySQL, Mongo, Prisma, Drizzle, migrations).
4. `qa_engineer` — Quality Assurance & Test Automation Specialist (Vitest, Jest, Playwright, load testing).
5. `cloud_devops` — Cloud Infrastructure & Production DevOps Engineer (Docker, Nginx, CI/CD, SSL, security).
6. `researcher` — Codebase & Web Researcher.
7. `coder` — High-Precision Implementation Engineer.
8. `architect` — System & Software Architect.
9. `debugger` — Root-Cause Debugger & Error Specialist.
10. `tester` — Quality Assurance & Test Engineer.
11. `devops` — DevOps & Build Specialist.
12. `security_auditor` — Security & Vulnerability Auditor.

---

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Display the Command Matrix card |
| `/provider [name]` | Switch provider (`ollama` or `openrouter`) or configure OpenRouter API key |
| `/model [name]` | Switch or select Ollama / OpenRouter models interactively |
| `/mode [confirm\|auto]` | Set safety permission mode |
| `/rounds [n]` | View or set max tool rounds limit for the session (e.g. `/rounds 50`) |
| `/agents`, `/subagents` | List all core and custom sub-agents with formatted visual cards |
| `/create-agent` | Launch interactive Agent Creator wizard |
| `/tasks`, `/bg` | List background shell command task cards |
| `/subtasks` | List background sub-agent execution cards |
| `/logs <task-id>` | Inspect live output logs of a background task |
| `/kill <task-id>` | Terminate a running background command or subagent |
| `/diagnostics`, `/info`| View host system diagnostics and memory stats |
| `/clear` | Reset conversation history |
| `/exit`, `/quit` | Exit Fixy |

