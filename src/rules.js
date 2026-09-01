import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { chat, getActiveModel } from "./llm.js";

const GLOBAL_RULES_FILE = path.join(os.homedir(), ".fixy", "rules.md");

const RULE_CANDIDATE_FILES = [
  "FIXY.md",
  "fixy.md",
  ".fixyrules",
  path.join(".fixy", "rules.md"),
  ".cursorrules",
  "CLAUDE.md",
  "claude.md",
];

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "dist",
  "build",
  "target",
  "vendor",
  ".cache",
  "coverage",
  ".turbo",
  ".vercel",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
]);

const KEY_CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
  ".env.example",
  "Makefile",
  "biome.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "prisma/schema.prisma",
  "drizzle.config.ts",
];

/**
 * Discovers and loads all applicable global and project rules.
 */
export async function loadRules(cwd = process.cwd()) {
  const loadedRules = [];

  // 1. Global User Rules (~/.fixy/rules.md)
  try {
    const globalContent = await fs.readFile(GLOBAL_RULES_FILE, "utf-8");
    if (globalContent && globalContent.trim()) {
      loadedRules.push({
        name: "Global User Rules",
        source: "global",
        path: GLOBAL_RULES_FILE,
        content: globalContent.trim(),
      });
    }
  } catch {}

  // 2. Project-level standard rule files
  for (const relPath of RULE_CANDIDATE_FILES) {
    const fullPath = path.resolve(cwd, relPath);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      if (content && content.trim()) {
        // Prevent duplicate loads if both FIXY.md and fixy.md match same file on case-insensitive filesystems
        const alreadyLoaded = loadedRules.some((r) => r.path.toLowerCase() === fullPath.toLowerCase());
        if (!alreadyLoaded) {
          loadedRules.push({
            name: relPath,
            source: "project",
            path: fullPath,
            content: content.trim(),
          });
        }
      }
    } catch {}
  }

  // 3. Project-level folder rules (.fixy/rules/*.md)
  const rulesDir = path.resolve(cwd, ".fixy", "rules");
  try {
    const dirEntries = await fs.readdir(rulesDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const fullPath = path.join(rulesDir, entry.name);
        const content = await fs.readFile(fullPath, "utf-8");
        if (content && content.trim()) {
          const alreadyLoaded = loadedRules.some((r) => r.path.toLowerCase() === fullPath.toLowerCase());
          if (!alreadyLoaded) {
            loadedRules.push({
              name: `.fixy/rules/${entry.name}`,
              source: "project",
              path: fullPath,
              content: content.trim(),
            });
          }
        }
      }
    }
  } catch {}

  return loadedRules;
}

/**
 * Format loaded rules for injection into the Agent system prompt.
 */
export function formatRulesForPrompt(rules) {
  if (!rules || rules.length === 0) return "";

  const sections = [];
  sections.push("\n## PROJECT CONVENTIONS & RULES");
  sections.push("You MUST strictly adhere to the following project guidelines and instructions:\n");

  for (const rule of rules) {
    sections.push(`### [Rule Source: ${rule.name}]`);
    sections.push(rule.content);
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Brief one-line summary of active rules for UI cards and banners.
 */
export function getRulesSummary(rules) {
  if (!rules || rules.length === 0) return "none";
  const names = rules.map((r) => r.name);
  return `${rules.length} active (${names.join(", ")})`;
}

/**
 * Deeply scans the project workspace to collect factual context without hardcoded assumptions.
 */
export async function collectCodebaseContext(cwd = process.cwd(), maxDepth = 2) {
  const tree = [];
  const configs = {};

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const relPath = path.relative(cwd, path.join(dir, entry.name));
        if (entry.isDirectory()) {
          tree.push(`[DIR]  ${relPath}/`);
          await walk(path.join(dir, entry.name), depth + 1);
        } else {
          tree.push(`[FILE] ${relPath}`);
        }
      }
    } catch {}
  }

  await walk(cwd, 0);

  // Read key configuration files
  for (const relConfig of KEY_CONFIG_FILES) {
    const fullConfig = path.resolve(cwd, relConfig);
    try {
      const stat = await fs.stat(fullConfig);
      if (stat.isFile() && stat.size < 30000) {
        const text = await fs.readFile(fullConfig, "utf-8");
        configs[relConfig] = text.trim();
      }
    } catch {}
  }

  return {
    tree: tree.slice(0, 80),
    configs,
    totalFilesDiscovered: tree.length,
  };
}

/**
 * Dynamically authors a bespoke, highly accurate FIXY.md rule file using the LLM agent,
 * inspecting actual directory layout, package manifests, scripts, and configs.
 */
export async function generateProjectRules(
  { model, format = "FIXY.md", customNotes = "", onStatus } = {},
  cwd = process.cwd()
) {
  onStatus?.("Inspecting workspace file structure and configuration manifests...");
  const context = await collectCodebaseContext(cwd);

  const activeModel = model || getActiveModel();
  let generatedContent = "";
  let isLLMGenerated = false;

  if (activeModel) {
    onStatus?.(`Synthesizing tailored project rules with model ${activeModel}...`);
    try {
      const configDumps = Object.entries(context.configs)
        .map(([filename, content]) => `--- Config File: ${filename} ---\n${content}`)
        .join("\n\n");

      const prompt = `You are a Principal Software Architect. Your job is to inspect this real codebase and author an authoritative, highly professional, concrete project development rules document (FIXY.md).

Real Project File Layout:
${context.tree.join("\n")}

Discovered Configuration Manifests:
${configDumps || "(No standard configuration manifests found in root)"}

${customNotes ? `User Custom Instructions / Preferences:\n${customNotes}\n` : ""}

Instructions:
1. Ground every rule strictly in what is ACTUALLY present in this repository.
2. If package.json or config files are present, extract the EXACT scripts (e.g. dev, build, test, lint), package manager, and dependencies.
3. Define concrete architectural conventions, directory responsibilities, typing guidelines, error handling policies, and state/data management standards.
4. If testing tools exist (Vitest, Jest, Pytest, Playwright), document how to run and write tests.
5. If Docker or CI/CD files exist, document container and deployment policies.
6. Do NOT include generic fluff or placeholder text. Keep it concise, actionable, and authoritative.
7. Return ONLY the markdown document contents starting with a top-level # title.`;

      const response = await chat({
        model: activeModel,
        messages: [
          { role: "system", content: "You are an expert AI software architect who writes precise, realistic, project-specific engineering rules." },
          { role: "user", content: prompt },
        ],
      });

      const raw = response?.content || "";
      generatedContent = raw.replace(/^```(?:markdown)?\r?\n([\s\S]*?)\r?\n```$/i, "$1").trim();
      if (generatedContent.length > 50) {
        isLLMGenerated = true;
      }
    } catch (err) {
      // Fallback if LLM unavailable
    }
  }

  // Fallback factual builder (no assumptions, purely reporting verified configs)
  if (!generatedContent) {
    const lines = [
      `# Project Development Rules & Engineering Standards`,
      ``,
      `> Workspace initialized on ${new Date().toISOString().split("T")[0]}.`,
      ``,
      `## 1. Discovered Project Files & Structure`,
    ];

    if (context.configs["package.json"]) {
      try {
        const pkg = JSON.parse(context.configs["package.json"]);
        lines.push(`- **Project Name**: \`${pkg.name || "workspace"}\` (v${pkg.version || "1.0.0"})`);
        if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
          lines.push(`- **Available Scripts**:`);
          for (const [k, v] of Object.entries(pkg.scripts)) {
            lines.push(`  - \`${k}\`: \`${v}\``);
          }
        }
      } catch {}
    }

    lines.push(
      ``,
      `## 2. Core Architectural Principles`,
      `- **Type Safety & Strict Validation**: Validate all runtime inputs and adhere strictly to language types.`,
      `- **Explicit Error Handling**: Always handle errors explicitly in asynchronous I/O and network operations.`,
      `- **Idempotency & Reversibility**: All migrations and schema modifications MUST support UP and DOWN operations.`,
      `- **Atomic & Verified Changes**: Verify changes with tests or diagnostics before concluding tasks.`
    );

    if (customNotes) {
      lines.push(``, `## 3. Custom Project Requirements`, customNotes);
    }

    generatedContent = lines.join("\n") + "\n";
  }

  const targetPath = path.resolve(cwd, format);
  await fs.writeFile(targetPath, generatedContent, "utf-8");

  return {
    filename: format,
    path: targetPath,
    content: generatedContent,
    isLLMGenerated,
    configsCount: Object.keys(context.configs).length,
    filesCount: context.totalFilesDiscovered,
  };
}
