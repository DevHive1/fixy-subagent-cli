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
