import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

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
 * Autonomously inspects a project directory and detects framework, runtime,
 * package manager, testing tools, styling, and database ORMs.
 */
export async function detectProjectStack(cwd = process.cwd()) {
  const stack = {
    runtime: "unknown",
    framework: "vanilla",
    language: "javascript",
    packageManager: "npm",
    database: "none",
    testing: "none",
    styling: "none",
    isFresh: true,
  };

  // 1. Check Node / JS ecosystem
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    stack.runtime = "node";
    stack.isFresh = false;

    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    // Framework detection
    if (allDeps.next) stack.framework = "nextjs";
    else if (allDeps["@remix-run/react"]) stack.framework = "remix";
    else if (allDeps.nuxt || allDeps.vue) stack.framework = "vue";
    else if (allDeps["@sveltejs/kit"] || allDeps.svelte) stack.framework = "svelte";
    else if (allDeps.react) stack.framework = "react";
    else if (allDeps.express) stack.framework = "express";
    else if (allDeps.fastify) stack.framework = "fastify";
    else if (allDeps["@nestjs/core"]) stack.framework = "nestjs";

    // Testing
    if (allDeps.vitest) stack.testing = "vitest";
    else if (allDeps.jest) stack.testing = "jest";
    else if (allDeps.playwright || allDeps["@playwright/test"]) stack.testing = "playwright";

    // Styling
    if (allDeps.tailwindcss) stack.styling = "tailwind";

    // Database / ORM
    if (allDeps["@prisma/client"] || allDeps.prisma) stack.database = "prisma";
    else if (allDeps["drizzle-orm"]) stack.database = "drizzle";
    else if (allDeps.mongoose) stack.database = "mongoose";
    else if (allDeps.pg || allDeps.mysql2 || allDeps["better-sqlite3"] || allDeps.sqlite3) stack.database = "sql";
  } catch {}

  // 2. Language check (TypeScript)
  try {
    await fs.access(path.join(cwd, "tsconfig.json"));
    stack.language = "typescript";
    stack.isFresh = false;
  } catch {}

  // 3. Package Manager check
  try {
    await fs.access(path.join(cwd, "pnpm-lock.yaml"));
    stack.packageManager = "pnpm";
  } catch {
    try {
      await fs.access(path.join(cwd, "yarn.lock"));
      stack.packageManager = "yarn";
    } catch {
      try {
        await fs.access(path.join(cwd, "bun.lockb"));
        stack.packageManager = "bun";
      } catch {}
    }
  }

  // 4. Python ecosystem
  try {
    const pyproject = await fs.readFile(path.join(cwd, "pyproject.toml"), "utf-8");
    stack.runtime = "python";
    stack.language = "python";
    stack.isFresh = false;
    if (pyproject.includes("fastapi")) stack.framework = "fastapi";
    else if (pyproject.includes("django")) stack.framework = "django";
    else if (pyproject.includes("flask")) stack.framework = "flask";
    if (pyproject.includes("pytest")) stack.testing = "pytest";
    if (pyproject.includes("sqlalchemy")) stack.database = "sqlalchemy";
  } catch {
    try {
      const reqs = await fs.readFile(path.join(cwd, "requirements.txt"), "utf-8");
      stack.runtime = "python";
      stack.language = "python";
      stack.isFresh = false;
      if (reqs.includes("fastapi")) stack.framework = "fastapi";
      else if (reqs.includes("django")) stack.framework = "django";
      else if (reqs.includes("flask")) stack.framework = "flask";
      if (reqs.includes("pytest")) stack.testing = "pytest";
    } catch {}
  }

  // 5. Rust / Go ecosystem
  try {
    await fs.access(path.join(cwd, "Cargo.toml"));
    stack.runtime = "rust";
    stack.language = "rust";
    stack.isFresh = false;
  } catch {}

  try {
    await fs.access(path.join(cwd, "go.mod"));
    stack.runtime = "go";
    stack.language = "go";
    stack.isFresh = false;
  } catch {}

  return stack;
}

/**
 * Autonomously generate a production-ready FIXY.md rule file based on detected or specified stack.
 */
export async function generateProjectRules({ format = "FIXY.md", customNotes = "" } = {}, cwd = process.cwd()) {
  const stack = await detectProjectStack(cwd);

  const lines = [
    `# Project Development Rules & Engineering Standards`,
    ``,
    `> Auto-generated by Fixy for ${stack.language.toUpperCase()} / ${stack.framework.toUpperCase()} environment.`,
    ``,
    `## 1. Stack & Runtime Environment`,
    `- **Language**: ${stack.language} (strict typing enabled)`,
    `- **Runtime / Framework**: ${stack.framework} (${stack.runtime})`,
    `- **Package Manager**: ${stack.packageManager}`,
    `- **Testing Framework**: ${stack.testing !== "none" ? stack.testing : "Vitest/Jest standard"}`,
    `- **Database / ORM**: ${stack.database !== "none" ? stack.database : "Modular data layer"}`,
    ``,
    `## 2. Core Architectural Principles`,
    `- **Single Responsibility**: Keep components, functions, and modules isolated and focused.`,
    `- **Explicit Error Handling**: Always wrap I/O, database queries, and network requests with structured try/catch or Result types.`,
    `- **Strict Typing**: Avoid \`any\` or loosely typed interfaces. Prefer explicit domain types and schemas.`,
    `- **Idempotency & Reversibility**: All migrations and database schema modifications MUST support UP and DOWN operations.`,
    ``,
    `## 3. Code Conventions & Quality Gates`,
    `- Write clean, readable code with descriptive variable and function names.`,
    `- Keep business logic out of presentation components and route handlers.`,
    `- Run tests before proposing or finalizing major refactors.`,
  ];

  if (stack.styling === "tailwind") {
    lines.push(`- **Styling**: Use utility-first Tailwind CSS with \`clsx\` or \`tailwind-merge\` for dynamic class names.`);
  }

  if (stack.framework === "nextjs") {
    lines.push(`- **Next.js App Router**: Prefer React Server Components (RSC) by default. Use \`'use client'\` only for interactive components.`);
  }

  if (customNotes) {
    lines.push(``, `## 4. Custom Project Requirements`, customNotes);
  }

  const content = lines.join("\n") + "\n";
  const targetPath = path.resolve(cwd, format);
  await fs.writeFile(targetPath, content, "utf-8");

  return {
    path: targetPath,
    filename: format,
    stack,
    content,
  };
}
