import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".fixy", "skills");

/**
 * Parses frontmatter and body from a SKILL.md file.
 */
export function parseSkillMarkdown(rawContent, defaultName = "custom-skill") {
  const trimmed = (rawContent || "").trim();
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = trimmed.match(frontmatterRegex);


  if (!match) {
    return {
      name: defaultName,
      description: trimmed.slice(0, 100).replace(/\n/g, " "),
      triggers: [],
      tools: [],
      body: trimmed,
    };
  }

  const yamlBlock = match[1];
  const body = match[2].trim();
  const meta = { name: defaultName, description: "", triggers: [], tools: [] };

  let currentListKey = null;

  for (const rawLine of yamlBlock.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Check if item in active list (e.g., "  - trigger_item")
    if (currentListKey && line.startsWith("- ")) {
      const item = line.slice(2).trim().replace(/^['"]|['"]$/g, "");
      if (item) meta[currentListKey].push(item);
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      currentListKey = null;
      continue;
    }

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    let val = line.slice(colonIdx + 1).trim();

    if (key === "triggers" || key === "tools") {
      meta[key] = [];
      if (!val) {
        currentListKey = key;
      } else if (val.startsWith("[") && val.endsWith("]")) {
        try {
          meta[key] = JSON.parse(val);
        } catch {
          meta[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        }
        currentListKey = null;
      } else {
        meta[key] = val.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        currentListKey = null;
      }
    } else {
      currentListKey = null;
      meta[key] = val.replace(/^['"]|['"]$/g, "");
    }
  }

  return {
    name: meta.name || defaultName,
    description: meta.description || "",
    triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
    tools: Array.isArray(meta.tools) ? meta.tools : [],
    model: meta.model || undefined,
    body,
  };
}

/**
 * Scan a directory for skills.
 */
async function scanSkillsDir(dirPath, scope = "global") {
  const skills = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(dirPath, entry.name, "SKILL.md");
        const altSkillFile = path.join(dirPath, entry.name, "skill.md");
        let content = null;
        let finalPath = skillFile;
        try {
          content = await fs.readFile(skillFile, "utf-8");
        } catch {
          try {
            content = await fs.readFile(altSkillFile, "utf-8");
            finalPath = altSkillFile;
          } catch {}
        }
        if (content) {
          const parsed = parseSkillMarkdown(content, entry.name);
          skills.push({ ...parsed, path: finalPath, scope, dir: path.join(dirPath, entry.name) });
        }
      } else if (entry.isFile() && (entry.name.endsWith(".skill.md") || entry.name.endsWith(".md"))) {
        const baseName = entry.name.replace(/(\.skill)?\.md$/i, "");
        const fullPath = path.join(dirPath, entry.name);
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          if (content) {
            const parsed = parseSkillMarkdown(content, baseName);
            skills.push({ ...parsed, path: fullPath, scope, dir: dirPath });
          }
        } catch {}
      }
    }
  } catch {}
  return skills;
}

/**
 * Discover all installed skills across global and project directories.
 */
export async function loadAllSkills(cwd = process.cwd()) {
  const projectSkillsDir = path.resolve(cwd, ".fixy", "skills");
  const [globalSkills, projectSkills] = await Promise.all([
    scanSkillsDir(GLOBAL_SKILLS_DIR, "global"),
    scanSkillsDir(projectSkillsDir, "project"),
  ]);

  // Project skills override global skills with the same name
  const map = new Map();
  for (const s of globalSkills) map.set(s.name.toLowerCase(), s);
  for (const s of projectSkills) map.set(s.name.toLowerCase(), s);

  return Array.from(map.values());
}

/**
 * Find relevant skills matching a user prompt or keyword.
 */
export async function findRelevantSkills(prompt = "", cwd = process.cwd()) {
  if (!prompt || typeof prompt !== "string") return [];
  const lower = prompt.toLowerCase();
  const allSkills = await loadAllSkills(cwd);

  return allSkills.filter((s) => {
    if (lower.includes(s.name.toLowerCase())) return true;
    if (s.triggers && s.triggers.some((t) => lower.includes(t.toLowerCase()))) return true;
    return false;
  });
}

/**
 * Format activated skills for system prompt injection.
 */
export function formatSkillsForPrompt(skills) {
  if (!skills || skills.length === 0) return "";

  const sections = [];
  sections.push("\n## ACTIVE SPECIALIZED SKILLS");
  sections.push("You have activated the following specialized playbooks for this task:\n");

  for (const skill of skills) {
    sections.push(`### [Skill: ${skill.name}] — ${skill.description}`);
    sections.push(skill.body);
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Create or update a skill.
 */
export async function saveSkill({ name, description, triggers = [], tools = [], content, scope = "global" }, cwd = process.cwd()) {
  const targetDir = scope === "project" ? path.resolve(cwd, ".fixy", "skills", name) : path.join(GLOBAL_SKILLS_DIR, name);
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });

  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description || ""}`,
    `triggers: ${JSON.stringify(triggers)}`,
    `tools: ${JSON.stringify(tools)}`,
    "---",
    "",
    content || `# ${name}\nSpecialized instructions for ${name}.`,
  ].join("\n");

  const filePath = path.join(targetDir, "SKILL.md");
  await fs.writeFile(filePath, frontmatter, { encoding: "utf-8", mode: 0o600 });
  return { name, path: filePath, scope };
}

export { parseSkillMarkdown as parseSkillContent };

