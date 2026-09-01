import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadRules, formatRulesForPrompt, getRulesSummary, detectProjectStack, generateProjectRules } from "../src/rules.js";

test("Project Rules Engine", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixy-rules-test-"));

  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await t.test("loadRules returns empty array when no rule files exist", async () => {
    const rules = await loadRules(tmpDir);
    const projectRules = rules.filter((r) => r.source.startsWith("project"));
    assert.strictEqual(projectRules.length, 0);
  });

  await t.test("loadRules discovers FIXY.md and .cursorrules", async () => {
    await fs.writeFile(path.join(tmpDir, "FIXY.md"), "# Project Instructions\nAlways use TypeScript.");
    await fs.writeFile(path.join(tmpDir, ".cursorrules"), "Never use any.");

    const rules = await loadRules(tmpDir);
    assert.ok(rules.some((r) => r.name === "FIXY.md" && r.content.includes("TypeScript")));
    assert.ok(rules.some((r) => r.name === ".cursorrules" && r.content.includes("Never use any")));
  });

  await t.test("loadRules discovers .fixy/rules/*.md directory rules", async () => {
    const rulesDir = path.join(tmpDir, ".fixy", "rules");
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, "backend.md"), "Use Express async handlers.");

    const rules = await loadRules(tmpDir);
    assert.ok(rules.some((r) => r.name.includes("backend.md") && r.content.includes("Express async handlers")));
  });

  await t.test("formatRulesForPrompt formats cleanly for system prompt", () => {
    const mockRules = [
      { name: "FIXY.md", source: "project", content: "Use strict mode." },
    ];
    const formatted = formatRulesForPrompt(mockRules);
    assert.ok(formatted.includes("PROJECT CONVENTIONS & RULES"));
    assert.ok(formatted.includes("[Rule Source: FIXY.md]"));
    assert.ok(formatted.includes("Use strict mode."));
  });

  await t.test("getRulesSummary produces concise summary", () => {
    const mockRules = [
      { name: "FIXY.md", source: "project", content: "Short rule." },
    ];
    const summary = getRulesSummary(mockRules);
    assert.ok(summary.includes("FIXY.md"));
  });

  await t.test("detectProjectStack detects Node, TypeScript, Next.js, Tailwind", async () => {
    const appDir = path.join(tmpDir, "sample-app");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify({
        dependencies: { next: "15.0.0", react: "19.0.0", tailwindcss: "4.0.0" },
        devDependencies: { vitest: "2.0.0" },
      })
    );
    await fs.writeFile(path.join(appDir, "tsconfig.json"), "{}");

    const stack = await detectProjectStack(appDir);
    assert.strictEqual(stack.runtime, "node");
    assert.strictEqual(stack.framework, "nextjs");
    assert.strictEqual(stack.language, "typescript");
    assert.strictEqual(stack.styling, "tailwind");
    assert.strictEqual(stack.testing, "vitest");
  });

  await t.test("generateProjectRules generates hardened FIXY.md file", async () => {
    const appDir = path.join(tmpDir, "sample-app");
    const generated = await generateProjectRules({ format: "FIXY.md" }, appDir);
    assert.strictEqual(generated.filename, "FIXY.md");
    assert.ok(generated.content.includes("NEXTJS"));
    assert.ok(generated.content.includes("React Server Components"));
    const fileOnDisk = await fs.readFile(generated.path, "utf8");
    assert.strictEqual(fileOnDisk, generated.content);
  });
});
