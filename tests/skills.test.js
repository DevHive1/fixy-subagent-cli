import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseSkillMarkdown, parseSkillContent, saveSkill, findRelevantSkills, formatSkillsForPrompt, loadAllSkills } from "../src/skills.js";

test("Skills Customization System", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixy-skills-test-"));

  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await t.test("parseSkillMarkdown parses YAML frontmatter and body", () => {
    const raw = `---
name: nextjs-expert
description: Next.js App Router best practices
triggers:
  - nextjs
  - app router
tools:
  - web_scaffold
  - test_runner
---
# Next.js Guidelines
Always use Server Components by default.
`;
    const parsed = parseSkillMarkdown(raw);
    assert.strictEqual(parsed.name, "nextjs-expert");
    assert.strictEqual(parsed.description, "Next.js App Router best practices");
    assert.deepStrictEqual(parsed.triggers, ["nextjs", "app router"]);
    assert.deepStrictEqual(parsed.tools, ["web_scaffold", "test_runner"]);
    assert.ok(parsed.body.includes("Always use Server Components"));
  });

  await t.test("saveSkill creates SKILL.md file and directory", async () => {
    const saved = await saveSkill(
      {
        name: "docker-master",
        description: "Docker multi-stage and compose patterns",
        triggers: ["docker", "container", "compose"],
        content: "# Docker Rules\nUse alpine or distroless base images.",
        scope: "project",
      },
      tmpDir
    );

    assert.ok(saved.path.includes("docker-master"));
    const content = await fs.readFile(saved.path, "utf8");
    assert.ok(content.includes("name: docker-master"));
    assert.ok(content.includes("distroless base images"));
  });

  await t.test("findRelevantSkills matches triggers in user prompt", async () => {
    const matched = await findRelevantSkills("Please build a docker container for me", tmpDir);
    assert.ok(matched.some((s) => s.name === "docker-master"));
  });

  await t.test("formatSkillsForPrompt formats instructions into system prompt injection", () => {
    const mockSkills = [
      {
        name: "tailwind-wizard",
        description: "Tailwind CSS styling guide",
        body: "Use clsx and tailwind-merge for dynamic classes.",
      },
    ];
    const formatted = formatSkillsForPrompt(mockSkills);
    assert.ok(formatted.includes("ACTIVE SPECIALIZED SKILLS"));
    assert.ok(formatted.includes("tailwind-wizard"));
    assert.ok(formatted.includes("tailwind-merge"));
  });
});
