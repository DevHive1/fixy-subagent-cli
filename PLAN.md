# Fixy-Agent Master Plan — v0.1.0 → v0.2.0

> Generated 2026-08-29 — Autonomous Terminal Engineering Agent
> Base: 42 tools, 12 sub-agents, 7894 LOC — Target: 72 tools, 12+ sub-agents, 4 new major features
> Scope: **All improvements + 30 new tools + 4 new features** — Plan only, no code yet.

---

## 0. Executive Summary

| Track | Goal | Count |
|-------|------|-------|
| **A. Improvements** | Fix 10 bugs + harden security/reliability/performance/docs | 21 items (P0/P1/P2) |
| **B. New Tools** | 30 new precision tools (72 total) — 6 categories ×5 | 30 |
| **C. New Features** | 4 architectural features (Memory Graph, Plugin/MCP Hub, TUI Dashboard, Self-Healing Loop) | 4 |

**Principles:** Keep Termux-native, zero paid deps, ESM, single `chalk` philosophy where possible, `MAX_OUTPUT` & `requestApproval()` invariant, Ollama-only.

**Implementation order:** A(P0) → A(P1) → B(phase 1) → C1 → B(phase 2) → C2 → C3 → C4 → A(P2) polish. Estimated 8 phases.

---

## PART A — All Improvements (21 items)

### A1. P0 Bug Fixes — Must fix before any expansion

| ID | File:Line | Issue | Fix Plan |
|----|-----------|-------|----------|
| **A1-1** | `src/subagentManager.js:301,661` | Double `loadCustomAgents()` — constructor `this.ready=load()` + top-level `loadCustomAgents()` un-awaited races `saveCustomAgents()` | Remove line 661. Make `SubagentManager` export singleton lazy: `export const subagentManager = new SubagentManager(); await subagentManager.ready` in `bin/fixy.js:main()` before any command. Add test `subagent-persistence-race.test.js`. |
| **A1-2** | `bin/fixy.js:70` + `src/agent.js:21` | `setMaxRounds(NaN)` crashes if `--rounds foo` (parseInt → NaN → `throw Invalid`). `main()` no try/catch | In `bin/fixy.js:parseCliArgs` validate: if `isNaN(opts.rounds) || opts.rounds<=0` → `console.error` + `process.exit(2)`. Same for `agentCreator.js:64`. Add input guard `Number.isInteger`. |
| **A1-3** | `src/ollama.js:22-35` | `mergeToolCalls` JSON-stringify dedup loses incremental streaming chunks; partial JSON may drop calls | Replace with index-based merge: if `call.index != null` use it; else buffer string `arguments` per `index` until valid JSON. Add unit test streaming 3-chunk tool call. |
| **A1-4** | `src/taskManager.js:killTask` | Sets `status="killed"` before `proc.kill()` — masks true exitCode if already exited | Set `killedRequested=true`, let `close` handler decide: if killedRequested → status killed else completed/failed. Persist original exitCode. |
| **A1-5** | `src/tools.js:1107-1145` `findFiles` | `name_pattern` glob→regex `replace('.', '\\.').replace('*','.*')` wrong order for `**` / `?` | Extract to `src/utils.js:globToRegex()`: handle `**/`, `*`, `?`, `.{ext,ext}` via `minimatch` or custom. Add tests `*.js`, `*.{ts,tsx}`, `**/*.test.js`. |
| **A1-6** | `src/tools.js:1498` `envManager` | Naïve `indexOf('=')` ignores `export FOO=bar`, quoted `=` , comments | Port dotenv parse: strip `export ` prefix, handle `#` comments outside quotes, split on first `=` outside quotes. Add test vector. |
| **A1-7** | `src/taskManager.js:startTask` | `spawn(shell:true)` raw `command` string — auto-mode prompt injection via `web_fetch` → `run_command` `; rm` | In `auto` mode still gate `isDangerous` + new `FIXY_SANDBOX=cwd` path check. Log warning banner if auto + dangerous. Document as known risk in README. |
| **A1-8** | `src/webTools.js:loadTester` | `completed++` race across workers overshoots `totalReqs` | Use `queue` array + `queue.shift()` or `Atomics` ; each worker `while(true){ const i=nextIdx++; if(i>=total) break; }`. Deduplicate. |
| **A1-9** | `src/ollama.js:chatStream` | Assumes `res.body.getReader()` exists — null throws | Guard: if `!res.body?.getReader` → fallback to `res.text()` + parse lines. Same as `internetTools.js:safeFetch`. |
| **A1-10** | `src/input.js` | History navigation leaks `savedBuffer`, no cursor LR, Ctrl-D leaves rawMode dirty | Clamp history idx `0..history.length`, save/restore `savedBuffer` on first nav. Keep rawMode teardown in `finally` of `question()`. |

### A2. P1 Code Quality & Maintainability (do before adding 30 tools)

| ID | Task | Files | Plan |
|----|------|-------|------|
| **A2-1** | Extract shared utils | `src/utils.js` new | Move `MAX_OUTPUT=15000`, `truncate()`, `stripAnsi()`, `colors`, `tokenizeArgs()`, `parseLineRanges()`, `globToRegex()`, `safeFetch()` into one module. Update imports in `tools.js`, `webTools.js`, `internetTools.js`. DRY - 3 copies → 1. |
| **A2-2** | Align Node engine | `package.json:17` + `README` | Change `engines: ">=22"` (code uses `fetch` stream `getReader`, `node:22` comment). Or keep `>=18` + add `fetch` polyfill fallback. Decision: set `>=20` minimum, `22` recommended in README. |
| **A2-3** | DRY theme | `src/theme.js` | `stripAnsi` defined twice; `colors` freeze `Object.freeze`. Export single `stripAnsi`. |
| **A2-4** | Add `src/config.js` | new | Centralize `DEFAULT_HOST`, `MAX_ROUNDS`, `MAX_OUTPUT`, `SESSION_DIR`, `AGENTS_FILE`, `PLUGINS_DIR`. Env overrides `FIXY_*` only here. |
| **A2-5** | Scaffolding gaps | `src/webTools.js:webScaffold` | Implement missing templates `vue`, `svelte`, `nextjs`, `fastapi` currently return `ERROR: Unsupported` — or remove from `list_templates` catalog. Choose: implement minimal `scaffold_project` for each (reuse `modern_html` + framework stub). Add `scaffold_component` 6 types (auth_form, data_table, card_grid, footer, stats_grid, hero). |

### A3. P1 Testing & CI (blocks contributors)

| ID | Task | Plan |
|----|------|------|
| **A3-1** | Test harness | `npm i -D vitest@^1` (keep 0-dep prod), add `scripts: { test:"vitest run", lint:"... " }`. Config `vitest.config.js` ESM.  |
| **A3-2** | Unit coverage P0 | Tests in `tests/`: `utils.test.js` (tokenizeArgs 10 cases), `mergeToolCalls.test.js`, `globToRegex.test.js`, `isDangerous.test.js`, `parseLineRanges.test.js`, `frontendInspector.test.js` mock HTML. Target 80% for `src/utils.js`, `src/permissions.js`, `src/ollama.js`. |
| **A3-3** | Integration | `tools-runner.test.js` spawns local `http.createServer` for `api_tester`, `webFetch`, `loadTester` without network. |
| **A3-4** | ESLint + Prettier | `eslint@9` flat config + `prettier` — run `npx eslint .` in pre-commit hook via `husky` or `simple-git-hooks`. Add `.editorconfig`. |
| **A3-5** | CI | Add `.github/workflows/ci.yml`: `node 20 & 22`, `npm test`, `npm run lint`, `node bin/fixy.js --help`. Badge in README. |

### A4. P1 Security Hardening

| ID | Task | Fix |
|----|------|-----|
| **A4-1** | Path traversal | `write_file`/`read_file`/`edit_file`: `path.resolve(cwd, p)` must satisfy `startsWith(resolve(projectRoot))` if `FIXY_SANDBOX=1`. Add option `FIXY_ALLOW_OUTSIDE`. |
| **A4-2** | `web_download` quota | Lower default `max_bytes 100MB → 20MB`, add disk-space pre-check `fs.statfs` if available, refuse if `< max_bytes*2` free. |
| **A4-3** | Allowlist persistence | `sessionAllowlist` currently mem-only; add per-project `~/.fixy/allowlist/<hash(cwd)>.json` + `allowForSession` clears on `mode` switch. |
| **A4-4** | Secret exposure | `system_diagnostics` filters but `env_manager reveal:true` leaks;Gate `reveal` behind `isDangerous` confirm even in auto. Log audit line on reveal. |
| **A4-5** | `git_action` injection | Already uses `execFile + tokenizeArgs` ✅ — add deny list for `git --upload-pack` risky args. |

### A5. P1 Reliability

| ID | Task | Plan |
|----|------|------|
| **A5-1** | Session rotation | `persistence.js:saveSession` rotate `latest.json` → `~/.fixy/sessions/{iso}.json` keep last 10, GC. Add `fixy -c --list` to pick session. |
| **A5-2** | LLM timeout | `chatStream` add `AbortController` per turn: `timeout = FIXY_LLM_TIMEOUT_MS || 120000` → abort fetch, return guidance to retry. Wire to `bin/fixy.js:onRoundStart` cancel prev. |
| **A5-3** | Model fuzzy fix | `resolveAvailableModel` change `startsWith` → exact → semver → prefix fallback order. Avoid `qwen2.5-coder:7b-text` mismatch. |
| **A5-4** | Graceful offline | If `/api/tags` fetch throws, `listModels()` already returns preferred verbatim ✅ — also cache last model list to `~/.fixy/models-cache.json` (TTL 1h). |
| **A5-5** | `~/.fixy` perms | `fs.mkdir 0o700`, `writeFile 0o600` for `agents.json`, `sessions/*` — Termux shared storage safety. |

### A6. P2 Performance

| ID | Task | Plan |
|----|------|------|
| **A6-1** | Crawl queue `shift()` O(n) → deque | Use index pointer `let head=0; queue[head++]` or `Denque` for 200-page crawl. |
| **A6-2** | `search_code` fallback throttling | JS walker: skip `*.min.js`, binary check `content.includes('\0')`, batch `Promise.all` with concurrency limit 20 (p-limit). |
| **A6-3** | Truncate tail | Keep head+tail: `str.slice(0, MAX_OUTPUT*0.8)+"\n...middle truncated...\n"+str.slice(-MAX_OUTPUT*0.2)` for logs. |

### A7. P2 Docs & UX

| ID | Task | Plan |
|----|------|------|
| **A7-1** | Unified `/help` | `renderCommandMatrix` must include `/mode`, `/rounds`, `--json` docs (currently README only). |
| **A7-2** | README engine fix | Align `README Key Highlights` mention of Node 22 vs `engines`. |
| **A7-3** | `tools/README` | Document `tools/` isolated CommonJS sister, `npx playwright install chromium` hint, env `PW_BROWSER_PATH`. |
| **A7-4** | `--verbose` flag | Add `parseCliArgs --verbose` to show session restore, model resolve, notif injection in headless. |

---

## PART B — 30 New Tools (42 → 72)

> Each tool spec: `name` — one-line description — key params — handler module — permission tier.

**Tier:** `R` read-only (no confirm), `W` write (confirm), `X` exec (always dangerous).

### Category B1 — File & Code Intelligence+ (5) → `src/tools.js`

| # | Tool | Description | Params | Tier |
|---|------|-------------|--------|------|
| 43 | `diff_viewer` | Unified diff between two files/strings or file vs git HEAD with line stats | `path_a, path_b?, content_b?, context_lines=3, ignore_ws` | R |
| 44 | `ast_analyzer` | Lightweight AST symbol extractor (functions, classes, jsx, imports) using regex+acorn fallback | `path, language?=auto, include_imports?` | R |
| 45 | `dependency_graph` | Import/require graph from entry file (BFS crawl, cycle detection) | `entry_path, max_depth=5, exclude="node_modules"` | R |
| 46 | `code_formatter` | Format code via prettier-like naive rules or `npx prettier --check` if installed | `path, language?=auto, dry_run=true, config?` | W |
| 47 | `todo_scanner` | Scan for TODO/FIXME/HACK/NOTE with priority + file:line table | `path=".", tags=["TODO","FIXME"], max_results=100` | R |

### Category B2 — Git & Collaboration+ (5) → `src/gitTools.js` NEW

| # | Tool | Description | Params | Tier |
|---|------|-------------|--------|------|
| 48 | `git_diff_analyzer` | Parsed `git diff` → file+hunk stats, line change summary, risk label | `staged?=false, base?="HEAD", max_bytes` | R |
| 49 | `github_api` | GitHub REST: get PR/issue, list issues, create comment (token via `GITHUB_TOKEN`) | `action="get_pr\|list_issues\|comment", repo, number, body?` | R/W |
| 50 | `patch_applier` | Apply unified diff patch string to workspace with dry-run & 3-way reject handling | `patch, dry_run?=true, strip?=1` | W |
| 51 | `changelog_generator` | Generate `CHANGELOG.md` slice from `git log` conventional-commits | `range="HEAD~20..HEAD", format="markdown\|json"` | R |
| 52 | `commit_linter` | Validate last commit / staged diff vs conventional-commits rules | `target="last_commit\|staged", rules?` | R |

### Category B3 — Termux / System Native (5) → `src/termuxTools.js` NEW

| # | Tool | Description | Params | Tier |
|---|------|-------------|--------|------|
| 53 | `termux_api` | Bridge to `termux-*` CLIs: battery, clipboard, location, sms, notification-list, vibrate (if installed) | `action="battery_status\|clipboard_get\|clipboard_set\|vibrate\|...", args?` | X |
| 54 | `process_manager` | List/kill/priority of OS processes (`ps`, `kill`) beyond background tasks | `action="list\|kill\|renice", pid?, signal?="SIGTERM", filter?` | X |
| 55 | `cron_scheduler` | Manage `crontab -l/e` or Termux:Boot `~/.termux/boot/` jobs for fixy | `action="list\|add\|remove", schedule, command, id?` | W |
| 56 | `clipboard_manager` | Cross-platform clipboard read/write fallback (termux-clipboard, `xclip`, `pbcopy`) | `action="get\|set", content?, raw?=false` | R/W |
| 57 | `notification_sender` | Send desktop/Termux notification + optional TTS | `title, message, channel?="fixy", priority?="default", tts?=false` | R |

### Category B4 — Web & API Advanced (5) → `src/webTools.js` + `src/internetTools.js`

| # | Tool | Description | Params | Tier |
|---|------|-------------|--------|------|
| 58 | `openapi_generator` | Generate OpenAPI 3.0 spec from `route_inspector` output or existing route file | `path, framework="auto", output_file?, title?` | R |
| 59 | `graphql_tester` | GraphQL precise query runner with variable validation & fragment timing | `url, query, variables?, headers?, expected_errors?` | R |
| 60 | `webhook_inspector` | Spin ephemeral local http listener (`/tmp/fixy-webhook-*.json`) to capture webhook callbacks | `action="start\|logs\|stop", port?=8765, timeout_ms?=30000` | X |
| 61 | `html_to_markdown` | Convert HTML file/url to Markdown (handles headings, code, tables) | `source="path\|url", selector?="main", max_length?` | R |
| 62 | `lighthouse_auditor` | Extended `frontend_inspector`: CLS/LCP heuristic + bundle size + image weight (no Chromium needed) | `path, checks="all\|perf\|a11y"` | R |

### Category B5 — Data & AI / LLM Ops (5) → `src/aiTools.js` NEW

| # | Tool | Description | Params | Tier |
|---|------|-------------|--------|------|
| 63 | `ollama_manager` | Manage local Ollama: `list\|pull\|show\|delete\|ps` models | `action, model?, host?` | X |
| 64 | `token_counter` | Estimate tokens/chars for a file or prompt (tiktoken heuristic + char/4) | `path?, text?, model?="qwen2.5-coder"` | R |
| 65 | `prompt_optimizer` | Compress prompt via remove-comments, dedup imports, truncate tail — reports token saving | `path, strategy="safe\|aggressive", max_tokens?` | R |
| 66 | `vector_memory_search` | Semantic search over long-term memory (see Feature C1) via Ollama `/api/embeddings` | `query, top_k=5, collection="default"` | R |
| 67 | `embedding_generator` | Generate embeddings for file/text and store to memory collection | `path?, text?, collection="default", overwrite?=false` | W |

### Category B6 — Security & DevOps Hardening (5) → `src/securityTools.js` NEW

| # | Tool | Description | Params | Tier |
|---|------|-------------|--------|------|
| 68 | `secret_scanner` | Scan files for secrets (keys, tokens, private keys) via entropy + regex (like gitleaks) | `path=".", patterns?="all", entropy_threshold?=4.5` | R |
| 69 | `license_auditor` | Audit `package.json` deps licenses (MIT/Apache/GPL) via `npm ls --json` + SPDX check | `path=".", allowlist?=["MIT","Apache-2.0"]` | R |
| 70 | `docker_auditor` | Lint Dockerfile/docker-compose for best-practice (no-root, pinned versions, .dockerignore) | `path=".", fix?=false` | R |
| 71 | `env_validator` | Validate `.env` vs `.env.example` required keys, types, missing/extra | `env_path=".env", example=".env.example", strict?=false` | R |
| 72 | `backup_manager` | Create/restore/list timestamped project snapshots to `~/.fixy/backups/<project>/` | `action="create\|restore\|list", target_path?, backup_id?` | W |

**Implementation details for all 30:**

* Schema: each added to `TOOL_DEFS` in `src/tools.js` (or imported defs from new modules) — keep total in `src/tools.js` re-export for `agent.js` simplicity.
* Handler: lightweight functions in new modules (`gitTools.js`, `termuxTools.js`, `aiTools.js`, `securityTools.js`) + expanded `webTools.js`. Each obeys `MAX_OUTPUT` + `truncate`.
* Approval: B1 R, B2/B3 W/X gated by `isDangerous` + `permissions.js` (`ALWAYS_DANGEROUS` extended with `patch_applier`, `cron_scheduler`, `ollama_manager pull/delete`, `process_manager kill`).
* Tests: each tool gets a `tools-*.test.js` with mocked fs/fetch, as with `A3-2`.
* Playwright optional: `lighthouse_auditor` fully static (no browser) to keep zero-PW dep; if `PW_BROWSER_PATH` present, enrich with real timing from `playwright_evaluate`.
* Termux graceful: `termux_api`, `clipboard_manager` detect binary with `execFile('which', ['termux-battery-status'])` and return friendly hint if missing.

---

## PART C — 4 New Major Features

### FEATURE C1 — Persistent Vector Memory & Knowledge Graph

**Why:** Current `sessionMemory` (`Map`) is ephemeral per-run + `persistence.js` only saves last turn. Long tasks lose context across restarts.

**Spec:**

* `~/.fixy/memory/<projectHash>/memory.jsonl` — each entry: `{id, key, value, embedding[384], createdAt, tags[], sourceFile?}`
* `~/.fixy/memory/<projectHash>/index.json` — metadata (model used for embeddings, dims).
* Embeddings: `POST /api/embeddings {model, prompt}` (Ollama `nomic-embed-text:latest` preferred, fallback `mxbai-embed-large`, else char/4 heuristic if offline).
* Tools: `embedding_generator`, `vector_memory_search` (above), plus extended `manage_memory` actions `search`, `forget`, `export`.
* Sub-agent integration: each sub-agent can `manage_memory set` with `tags: [agentName, taskId]`; main agent `drainNotifications` injects top-k search summary for user query automatically (no extra round).
* Slash: `/memory [search|list|clear] <query>` renders `renderBox` memory cards.
* Privacy: filenames `memory.jsonl` 0o600; `vector_memory_search` never sends memory content to remote hosts.

**Files to create/modify:**

* `src/vectorStore.js` NEW — `embed(text, model)`, `store(key,value)`, `search(query, topK)` with cosine similarity brute force ( <5k entries fine; later add HNSW).
* `src/tools.js` — extend `manage_memory` handler to delegate to `vectorStore`.
* `src/persistence.js` — add `loadProjectMemory()` on startup, `saveProjectMemory()` after each turn alongside `saveSession`.
* `src/agent.js:SYSTEM_PROMPT` — add “Use `vector_memory_search` to recall prior decisions before assuming.”

**Acceptance:** `tests/vectorStore.test.js` proves cosine rank, `npm test` offline falls back to char heuristic, `fixy -c` restores vector entries.

---

### FEATURE C2 — Plugin & MCP Hub (Model Context Protocol)

**Why:** Need extensibility without core edits; aligns with OpenCode/MCP ecosystem.

**Spec (two layers):**

* **Level 1 — Local JS Plugins:** `~/.fixy/plugins/<name>/index.js` ESM exports `TOOL_DEFS[]` + `handlers{}`. On startup `src/pluginManager.js` scans `PLUGINS_DIR`, `import()` each plugin, merges into `TOOL_DEFS` (capped at 100 total), validates handler signature.
* **Level 2 — MCP Client:** `mcp_manager` tool + `src/mcpClient.js` — speaks MCP over stdio/SSE to external servers (list from `~/.fixy/mcp.json`). Tool calls translate: `mcp_call {server, tool, args}`. Matches spec `github.com/modelcontextprotocol`.
* On Termux, include example plugin `fixy-termux-plugin` (battery, sms) as reference.

**New tool:**

* `73` `mcp_manager` — `{action:"list_servers"|"list_tools"|"call", server?, tool?, args?}` — W/R tier.

**Files:**

* `src/pluginManager.js` NEW — `loadPlugins()`, `getPluginDefs()`, `runPluginTool(name,args)`.
* `src/mcpClient.js` NEW — `connect(serverConfig)`, `listTools()`, `callTool()`.
* `bin/fixy.js` — after `pickModel()`, `await pluginManager.loadPlugins()`; slash `/plugins` renders plugin cards via `theme.js:renderBox`.
* Config `~/.fixy/mcp.json` example `[{ "name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/"] }]`.

**Acceptance:** Drop-in plugin with 1 tool appears in `/agents` card count, `mcp_manager call` round-trips to mock MCP server in test.

---

### FEATURE C3 — Interactive TUI Live Dashboard

**Why:** `renderBox`/`renderToolCard` is scroll-based. For long runs users lose overview of bg tasks + sub-agents. Goal: full-screen dashboard without new deps (`chalk` only) using raw ANSI + `readline`.

**Spec:**

* Slash `/dashboard` or `fixy --dashboard` enters full-screen: 4 panes:
  1. Header: model, mode, rounds, cwd, Ollama status green/red.
  2. Left: Background Tasks (`taskManager.listTasks()` live 1s poll).
  3. Right: Sub-Agent Tasks (`subagentManager.listTasks()`).
  4. Bottom: Streaming log (last `renderToolCard` preview, 6 lines).
* Input: `q` quit to normal REPL, `k <id>` kill, `l <id>` expand logs in modal, `tab` cycle panes.
* Impl: `src/tui.js` NEW — no `blessed` dep (bundle size); use `process.stdout.write('\x1b[2J\x1b[H')`, `ansi box` helpers from `theme.js`. Reads `stdin` raw mode via `LineReader`.
* Degrades gracefully if `process.stdout.columns < 80` → fallback to scroll mode warning.

**Files:**

* `src/tui.js` NEW — `launchDashboard({taskManager, subagentManager})`.
* `src/theme.js` — export `renderDashboardFrame()` helpers.
* `bin/fixy.js` — `handleSlashCommand('/dashboard')` + `cli.dashboard` flag.

**Acceptance:** Manual Termux test `fixy --dashboard` shows 4 panes, `run_command sleep 5 --background` appears instantly, kill works, exit restores REPL.

---

### FEATURE C4 — Autonomous Self-Healing Loop (`--auto-fix`)

**Why:** Core tagline “iterates until bug is fixed” needs a formal loop, not just prompting. Turn conventional workflow into guarded agent loop.

**Spec:**

* New CLI: `fixy --auto-fix "<goal>" [--max-iterations 5] [--verify "npm test"]`
* Also triggerable via tool `repair_controller`.
* Loop in `src/repairLoop.js` NEW:

```
for iter in 1..maxIterations:
  1. runTurn(goal)               // fix attempt
  2. gate = exec verifyCommand   // e.g. `npm test` or `npm run lint`
  3. if gate passes → `project_auditor scope=all` → threshold score >= 85 → stop SUCCESS
  4. else feed gate output back as `[VERIFY FAILED] ...` + `git diff` summary → next iteration
  5. if iterations exhausted → create backup via backup_manager before revert prompt
```

* Safety: auto-creates backup before iteration 1 (`backup_manager create`); enforces `FIXY_ALLOW_OUTSIDE=false`; permission mode forced `auto` but write-approval logged to `~/.fixy/repair.log`.
* Sub-agents: loop can dispatch `debugger` + `tester` in parallel to diagnose failures (`invoke_parallel_subagents`).
* Slash: `/autofix <goal>` inside REPL.
* Tool: `repair_controller` — `{action:"start"|"status"|"stop", goal?, verify?, max_iterations?}`.

**Files:**

* `src/repairLoop.js` NEW — `runRepairLoop({goal, verify, maxIterations, model})`.
* `src/tools.js` — add `repair_controller` def + handler forwarding to `repairLoop`.
* `bin/fixy.js` — flag `--auto-fix` + history handler.
* `src/taskManager.js` — emit iteration summary cards.

**Acceptance:** Repo with 1 failing vitest — `fixy --auto-fix "make tests pass" --verify "npm test"` fixes file, tests green in ≤3 iters, leaves `~/.fixy/backups/` entry + `repair.log`.

---

## D. Implementation Roadmap — 8 Phases

| Phase | Duration* | Covers | Deliverable |
|-------|-----------|--------|-------------|
| **0** | 0.5d | Setup: `src/utils.js`, `src/config.js`, Node `>=20`, `vitest`+`eslint` harness | `npm test` passes skeleton |
| **1** | 1d | P0 Bugs A1-1..A1-10 | All P0 tests green |
| **2** | 1d | P1 Quality A2 + Security A4 | `npm run lint` clean, sandbox gated |
| **3** | 2d | B1+B5+B6 (15 tools): file-intel, AIops, security | Tools 43-47, 63-72 shipped |
| **4** | 2d | **C1 Vector Memory** + B2 remainder (github_api etc.) | Memory `search` proves recall across restart |
| **5** | 2d | B2+B3 (Git+Termux 10 tools) + **C2 Plugin/MCP** | `~/.fixy/plugins` + mock MCP round-trip |
| **6** | 2d | B4 (Web 5) + **C3 TUI** | `/dashboard` live |
| **7** | 2d | **C4 Self-Healing Loop** + Reliability A5 | `fixy --auto-fix` e2e |
| **8** | 1d | P2 A6-A7 polish + docs + CI + version → `0.2.0` bump | Release tag |

*Duration assuming single dev + Ollama local; adjust for Termux.

**Dependency graph:** A1 block all; `utils.js` block B; C1 block `vector_memory_search` (B5); C2 block optional; C3 needs TaskManagers stable (A1-4); C4 needs B2 backup + project_auditor.

---

## E. File Plan (New vs Modify)

**New files (14):**

```
src/utils.js
src/config.js
src/vectorStore.js         // C1
src/pluginManager.js       // C2
src/mcpClient.js           // C2
src/tui.js                 // C3
src/repairLoop.js          // C4
src/gitTools.js            // B2
src/termuxTools.js         // B3
src/aiTools.js             // B5
src/securityTools.js       // B6
vitest.config.js
tests/*.test.js (8+)
.github/workflows/ci.yml
```

**Modified (8):**

```
package.json              // engines, scripts, devDeps
bin/fixy.js               // dashboard flag, auto-fix, plugin load, model cache, verbose
src/tools.js              // +30 defs, imports new modules, delegates to vectorStore/plugin
src/subagentManager.js:661 // remove double load, A1-1
src/agent.js              // SYSTEM_PROMPT + LLM timeout
src/taskManager.js        // killedRequested + stopAll
src/persistence.js        // rotation, perms 0o600
src/theme.js              // dashboard helpers, stripAnsi dedup
README.md                 // 72 tools table, features, engine, tools/README link
```

---

## F. Verification Checklist (before merge)

* [ ] `npm test` — all unit + integration green (incl. offline embedding fallback)
* [ ] `npm run lint` — 0 errors
* [ ] Manual: `fixy -p "list files" --json` returns toolCalls
* [ ] Manual Termux: `termux_api action=battery_status` hint if no bin
* [ ] Manual: `fixy -c` restores vector memory across restart
* [ ] Manual: drop plugin `~/.fixy/plugins/hello/index.js` appears in `/agents`
* [ ] Manual: `fixy --dashboard` + background `sleep 3` → pane update → `k` → killed
* [ ] Manual: `fixy --auto-fix "fix typo in README" --verify "npm test"` → backup + audit pass

---

## G. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Ollama `/api/embeddings` model missing → C1 fails | Auto-detect & `ollama pull nomic-embed-text` hint + char/4 fallback so search still lexical |
| MCP servers may be heavy on Termux | Keep MCP optional, lazy-connect only on `mcp_manager call` |
| TUI raw mode breaks LineReader history | Share `LineReader` instance, save/restore `isRaw` on dashboard exit |
| 30 tools blow `TOOL_DEFS` context window | Group defs, truncate description to 120 chars; sub-agents only get filtered `allowedTools` already |
| Sandbox path check breaks legitimate `/data/data/com.termux/...` absolute usage | Allow `FIXY_ALLOW_OUTSIDE=1` env escape hatch documented |

---

## H. Immediate Next Actions (when user says “build”)

1. `git checkout -b feat/v0.2-master-plan`
2. Implement Phase 0-1 (P0 bugs) + push for review — smallest safe PR.
3. Add `vitest` + first 3 tests, wire CI — proves harness.
4. Iterate B categories in parallel sub-agents (assign `coder` ×3 for B1/B5/B6).
5. After each phase `npm test && node bin/fixy.js -p "smoke test" --json --mode auto` in Termux.

---

*End of Plan — 72 tools, 4 features, 21 improvements. Awaiting `build` approval to start Phase 0.*
