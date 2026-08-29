/**
 * gitTools.js — Fixy agent Git & GitHub helpers (ESM, zero external deps)
 * Termux-compatible: uses only node:fs, node:child_process, node:util, fetch, truncate
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { truncate } from "./utils.js";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 15000;

// ---------------------------------------------------------------------------
// Helper: safe execFile wrapper with truncation
// ---------------------------------------------------------------------------
function formatExecError(prefix, err) {
  const code = err.code ?? 1;
  const stdout = err.stdout ? String(err.stdout).slice(0, 4000) : "";
  const stderr = err.stderr ? String(err.stderr).slice(0, 4000) : String(err.message).slice(0, 4000);
  return `${prefix} [exit code ${code}]\n${stdout ? `stdout:\n${stdout}\n` : ""}${stderr ? `stderr:\n${stderr}` : ""}`.trim();
}

// ---------------------------------------------------------------------------
// 1. git_diff_analyzer
// ---------------------------------------------------------------------------
/**
 * Parse git diff and produce stats.
 * @param {object} opts
 * @param {boolean} opts.staged - if true use --cached
 * @param {string} opts.base - base ref to diff against (ignored when staged=true)
 * @param {number} opts.max_bytes - max diff bytes to process (default 50000)
 */
export async function git_diff_analyzer({ staged = false, base = "HEAD", max_bytes = 50000 } = {}) {
  try {
    const maxBytes = Math.min(Math.max(1024, Number(max_bytes) || 50000), 5 * 1024 * 1024);
    let args;
    if (staged) {
      args = ["diff", "--cached", "--no-color"];
    } else {
      // git diff <base>  -> compare base to working tree (includes staged+unstaged vs base)
      // fallback to just "git diff" if base is falsy or "HEAD" with no commits edge
      if (base && typeof base === "string" && base.trim()) {
        args = ["diff", String(base).trim(), "--no-color"];
      } else {
        args = ["diff", "--no-color"];
      }
    }

    let stdout = "";
    let stderr = "";
    try {
      const res = await execFileAsync("git", args, {
        timeout: 30000,
        maxBuffer: Math.max(maxBytes + 1024 * 10, 5 * 1024 * 1024),
      });
      stdout = res.stdout || "";
      stderr = res.stderr || "";
    } catch (err) {
      // git diff returns exit 0 even when no diff; non-zero usually means error (bad base)
      // but some git versions return 1 for no diff? Capture anyway.
      if (err.stdout !== undefined || err.stderr !== undefined) {
        stdout = err.stdout || "";
        stderr = err.stderr || "";
        // If error indicates bad revision, try fallback to plain diff without base
        if (!staged && err.stderr && /unknown revision|bad revision|not a commit/i.test(err.stderr)) {
          try {
            const fallback = await execFileAsync("git", ["diff", "--no-color"], {
              timeout: 30000,
              maxBuffer: 5 * 1024 * 1024,
            });
            stdout = fallback.stdout || "";
            stderr = `Fallback due to bad base "${base}": ${err.stderr}\n${fallback.stderr || ""}`;
          } catch (fallbackErr) {
            return truncate(`ERROR git_diff_analyzer failed: ${formatExecError("$ git " + args.join(" "), err)}`);
          }
        } else if (!stdout && err.code !== 0 && !err.stdout) {
          return truncate(`ERROR git_diff_analyzer failed: ${formatExecError("$ git " + args.join(" "), err)}`);
        }
      } else {
        return truncate(`ERROR git_diff_analyzer failed: ${err.message}`);
      }
    }

    // Apply max_bytes limit for parsing (keep first maxBytes chars)
    const limited = stdout.length > maxBytes ? stdout.slice(0, maxBytes) : stdout;
    const wasTruncated = stdout.length > maxBytes;

    // Parse stats
    const lines = limited.split("\n");
    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;
    let hunks = 0;
    const fileSet = new Set();
    const filePattern = /^diff --git a\/(.+?) b\/(.+)$/;
    const hunkPattern = /^@@\s/;

    for (const line of lines) {
      if (filePattern.test(line)) {
        filesChanged++;
        const m = line.match(filePattern);
        if (m) fileSet.add(m[2] || m[1]);
      }
      if (hunkPattern.test(line)) hunks++;
      // additions/deletions: ignore file header +++ / ---
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    const totalChanges = additions + deletions;

    // Determine risk label
    // low: small, medium: moderate, high: large or many files/hunks
    let risk = "low";
    // Heuristic thresholds
    if (filesChanged >= 10 || totalChanges >= 500 || hunks >= 30) risk = "high";
    else if (filesChanged >= 5 || totalChanges >= 100 || hunks >= 10) risk = "medium";

    // Extra heuristics for high risk
    const sensitive = /\b(auth|password|secret|token|key|security|migration|schema|lockfile|package-lock)\b/i.test(limited);
    if (sensitive && risk === "medium") risk = "high";
    if (totalChanges === 0 && filesChanged === 0) risk = "low";

    const fileList = [...fileSet].slice(0, 50);

    // Also try to get --stat for nicer summary (best effort)
    let statSummary = "";
    try {
      const statArgs = staged ? ["diff", "--cached", "--stat"] : ["diff", String(base).trim(), "--stat"];
      // fallback to plain --stat if base invalid
      const statRes = await execFileAsync("git", statArgs, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }).catch(async (e) => {
        if (!staged) return execFileAsync("git", ["diff", "--stat"], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
        throw e;
      });
      statSummary = (statRes.stdout || "").trim();
    } catch (_) {
      // ignore stat failure
    }

    const out = [];
    out.push(`=== Git Diff Analyzer ===`);
    out.push(`Mode: ${staged ? "staged (--cached)" : `diff ${base}`}${wasTruncated ? ` [truncated to ${maxBytes} bytes]` : ""}`);
    out.push(`Files changed: ${filesChanged}${fileSet.size ? ` (${fileSet.size} unique)` : ""}`);
    if (fileList.length) out.push(`File list: ${fileList.join(", ")}${fileSet.size > 50 ? ` ... +${fileSet.size - 50} more` : ""}`);
    out.push(`Additions: ${additions} | Deletions: ${deletions} | Total: ${totalChanges}`);
    out.push(`Hunks: ${hunks}`);
    out.push(`Risk: ${risk.toUpperCase()}${risk === "high" ? " ⚠️ large or sensitive change" : risk === "medium" ? " ◆ moderate review" : " ● small/safe"}`);
    if (statSummary) {
      out.push("");
      out.push("--- git diff --stat ---");
      out.push(statSummary.slice(0, 4000));
    }
    if (stderr) {
      out.push("");
      out.push(`[stderr] ${stderr.slice(0, 1000)}`);
    }
    out.push("");
    out.push("--- Diff preview (first 3000 chars) ---");
    const preview = limited.slice(0, 3000);
    out.push(preview || "(no diff — working tree clean)");
    if (wasTruncated) out.push(`\n...[diff truncated, original ${stdout.length} bytes, showing first ${maxBytes}]`);

    return truncate(out.join("\n"), MAX_OUTPUT);
  } catch (err) {
    return truncate(`ERROR git_diff_analyzer: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 2. github_api
// ---------------------------------------------------------------------------
/**
 * Minimal GitHub API wrapper using native fetch.
 * @param {object} opts
 * @param {string} opts.action - get_pr|list_issues|comment|get_repo
 * @param {string} opts.repo - "owner/repo"
 * @param {number|string} opts.number - PR/issue number (required for get_pr/comment)
 * @param {string} opts.body - comment body (for comment action)
 */
export async function github_api({ action = "get_repo", repo, number, body } = {}) {
  try {
    if (!repo || typeof repo !== "string" || !repo.includes("/")) {
      return truncate(`ERROR github_api: 'repo' is required and must be "owner/repo" format.`);
    }
    const allowed = ["get_pr", "list_issues", "comment", "get_repo"];
    if (!allowed.includes(action)) {
      return truncate(`ERROR github_api: invalid action "${action}". Allowed: ${allowed.join(", ")}`);
    }

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Fixy-Agent/2.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token.trim()}`;

    let url = "";
    let method = "GET";
    let payload = undefined;

    const base = `https://api.github.com/repos/${repo}`;

    switch (action) {
      case "get_pr":
        if (number === undefined || number === null || String(number).trim() === "") {
          return truncate(`ERROR github_api: 'number' (PR number) is required for action "get_pr".`);
        }
        url = `${base}/pulls/${encodeURIComponent(String(number).trim())}`;
        break;
      case "list_issues":
        url = `${base}/issues?state=open&per_page=30`;
        // number is ignored for list_issues, but allow optional filter?
        break;
      case "comment":
        if (number === undefined || number === null || String(number).trim() === "") {
          return truncate(`ERROR github_api: 'number' (issue/PR number) is required for action "comment".`);
        }
        if (!body || typeof body !== "string" || !body.trim()) {
          return truncate(`ERROR github_api: 'body' is required for action "comment".`);
        }
        url = `${base}/issues/${encodeURIComponent(String(number).trim())}/comments`;
        method = "POST";
        payload = JSON.stringify({ body: String(body) });
        headers["Content-Type"] = "application/json";
        break;
      case "get_repo":
        url = base;
        break;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const contentType = res.headers.get("content-type") || "";
    let rawText = "";
    try {
      rawText = await res.text();
    } catch (e) {
      return truncate(`ERROR github_api: failed to read response: ${e.message}`);
    }

    let pretty = rawText;
    // Try to pretty-print JSON if applicable
    if (contentType.includes("application/json") || rawText.trim().startsWith("{") || rawText.trim().startsWith("[")) {
      try {
        const json = JSON.parse(rawText);
        pretty = JSON.stringify(json, null, 2);
      } catch (_) {
        // keep raw
      }
    }

    // Truncate JSON preview to 3000 as spec, then overall MAX_OUTPUT
    const JSON_PREVIEW_LIMIT = 3000;
    let jsonPreview = pretty;
    if (pretty.length > JSON_PREVIEW_LIMIT) {
      jsonPreview = pretty.slice(0, JSON_PREVIEW_LIMIT) + `\n...[JSON preview truncated, ${pretty.length - JSON_PREVIEW_LIMIT} more chars]`;
    }

    const out = [];
    out.push(`=== GitHub API: ${action} ===`);
    out.push(`Repo: ${repo}${number ? ` | Number: ${number}` : ""} | Status: ${res.status} ${res.statusText}`);
    out.push(`URL: ${url} | Method: ${method}${token ? " | Auth: Bearer [present]" : " | Auth: none (set GITHUB_TOKEN for private repos/higher rate limit)"}`);
    if (!res.ok) {
      out.push(`[HTTP ERROR ${res.status}]`);
    }
    out.push("");
    out.push("--- Response Preview (truncated to 3000) ---");
    out.push(jsonPreview || "(empty response)");

    return truncate(out.join("\n"), MAX_OUTPUT);
  } catch (err) {
    return truncate(`ERROR github_api: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. patch_applier
// ---------------------------------------------------------------------------
/**
 * Apply a patch via `git apply`.
 * @param {object} opts
 * @param {string} opts.patch - unified diff patch content
 * @param {boolean} opts.dry_run - if true use --check
 * @param {number} opts.strip - -p value (default 1)
 */
export async function patch_applier({ patch, dry_run = true, strip = 1 } = {}) {
  if (!patch || typeof patch !== "string" || !patch.trim()) {
    return truncate(`ERROR patch_applier: 'patch' is required and must be a non-empty string (unified diff).`);
  }
  const stripVal = Number.isInteger(Number(strip)) ? String(Number(strip)) : "1";
  const isDry = Boolean(dry_run);

  // Generate temp file in /tmp (Termux: /data/data/com.termux/files/usr/tmp often symlinked)
  const tmpDir = os.tmpdir() || "/tmp";
  const rnd = crypto.randomBytes(4).toString("hex");
  const patchFile = path.join(tmpDir, `fixy-${Date.now()}-${rnd}.patch`);

  try {
    // Ensure tmp dir exists
    await fs.mkdir(path.dirname(patchFile), { recursive: true });
    await fs.writeFile(patchFile, String(patch), "utf8");

    const args = isDry
      ? ["apply", "--check", `-p${stripVal}`, patchFile]
      : ["apply", `-p${stripVal}`, patchFile];

    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const successMsg = isDry
        ? `✔ Patch check PASSED (dry_run=true, -p${stripVal}). Patch would apply cleanly.`
        : `✔ Patch APPLIED successfully (-p${stripVal}).`;
      const details = [`=== Patch Applier ${isDry ? "[DRY RUN]" : "[APPLIED]"} ===`, successMsg, `Patch file: ${patchFile}`, `Strip: -p${stripVal}`, `Patch size: ${String(patch).length} bytes`];
      if (stdout) details.push(`stdout:\n${stdout.slice(0, 2000)}`);
      if (stderr) details.push(`stderr:\n${stderr.slice(0, 2000)}`);
      // Clean up on success (keep file for debugging if needed? Remove unless dry_run? We'll keep dry_run file for inspection? Remove both for hygiene)
      try {
        await fs.unlink(patchFile);
      } catch (_) {}
      return truncate(details.join("\n"), MAX_OUTPUT);
    } catch (err) {
      const errMsg = formatExecError(`$ git ${args.join(" ")}`, err);
      const out = [
        `=== Patch Applier ${isDry ? "[DRY RUN CHECK FAILED]" : "[APPLY FAILED]"} ===`,
        `Patch file: ${patchFile}`,
        `Strip: -p${stripVal} | dry_run: ${isDry}`,
        `Patch size: ${String(patch).length} bytes`,
        "",
        errMsg,
        "",
        "--- Patch preview (first 3000 chars) ---",
        String(patch).slice(0, 3000),
      ];
      // Keep patch file on failure for debugging, but also note location
      return truncate(out.join("\n"), MAX_OUTPUT);
    }
  } catch (err) {
    return truncate(`ERROR patch_applier: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 4. changelog_generator
// ---------------------------------------------------------------------------
/**
 * Generate changelog from git log using conventional commits.
 * @param {object} opts
 * @param {string} opts.range - git rev range (default "HEAD~20..HEAD")
 * @param {string} opts.format - "markdown" or "json"
 */
export async function changelog_generator({ range = "HEAD~20..HEAD", format = "markdown" } = {}) {
  try {
    const fmt = String(format || "markdown").toLowerCase() === "json" ? "json" : "markdown";
    const revRange = String(range || "HEAD~20..HEAD").trim() || "HEAD~20..HEAD";

    // Use unit/record separators for robust parsing
    // Format: %h%x1f%s%x1f%an%x1f%ad%x1f%b%x1e   with --date=short
    const pretty = "%h%x1f%s%x1f%an%x1f%ad%x1f%b%x1e";
    let logOutput = "";
    try {
      const res = await execFileAsync("git", ["log", revRange, `--pretty=format:${pretty}`, "--date=short"], {
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024,
      });
      logOutput = res.stdout || "";
    } catch (err) {
      // Fallback: try without range if invalid, or HEAD only
      if (err.stderr && /unknown revision|bad revision|ambiguous argument/i.test(err.stderr)) {
        try {
          const fallback = await execFileAsync("git", ["log", `--pretty=format:${pretty}`, "--date=short", "-n", "20"], {
            timeout: 30000,
            maxBuffer: 5 * 1024 * 1024,
          });
          logOutput = fallback.stdout || "";
        } catch (fallbackErr) {
          return truncate(`ERROR changelog_generator: git log failed for range "${revRange}": ${formatExecError("git log", err)}`);
        }
      } else if (err.stdout) {
        logOutput = err.stdout || "";
      } else {
        return truncate(`ERROR changelog_generator: ${formatExecError("git log " + revRange, err)}`);
      }
    }

    if (!logOutput.trim()) {
      return truncate(`=== Changelog (${revRange}) ===\n(no commits found in range "${revRange}")`);
    }

    // Parse records
    const records = logOutput.split("\x1e").filter((r) => r.trim());
    const commits = records.map((rec) => {
      const parts = rec.split("\x1f");
      // parts: hash, subject, author, date, body
      const hash = (parts[0] || "").trim();
      const subject = (parts[1] || "").trim();
      const author = (parts[2] || "").trim();
      const date = (parts[3] || "").trim();
      const body = (parts[4] || "").trim();
      return { hash, subject, author, date, body };
    });

    // Conventional commit parsing
    const CONVENTIONAL_RE = /^(\w+)(\(.+\))?(!)?:\s*(.+)/;
    const KNOWN_TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
    const groups = {
      feat: [],
      fix: [],
      docs: [],
      style: [],
      refactor: [],
      perf: [],
      test: [],
      build: [],
      ci: [],
      chore: [],
      revert: [],
      other: [],
    };

    for (const c of commits) {
      const m = c.subject.match(CONVENTIONAL_RE);
      let type = "other";
      let scope = "";
      let breaking = false;
      let desc = c.subject;
      if (m) {
        const candidate = m[1].toLowerCase();
        type = KNOWN_TYPES.includes(candidate) ? candidate : "other";
        scope = m[2] ? m[2].slice(1, -1) : "";
        breaking = Boolean(m[3]);
        desc = m[4] || c.subject;
        // Also check body for BREAKING CHANGE
        if (!breaking && /BREAKING CHANGE:/i.test(c.body)) breaking = true;
      }
      const targetGroup = groups[type] ? type : "other";
      groups[targetGroup].push({ ...c, parsedType: type, scope, breaking, desc });
    }

    if (fmt === "json") {
      const jsonObj = {
        range: revRange,
        total: commits.length,
        groups: Object.fromEntries(
          Object.entries(groups)
            .filter(([, arr]) => arr.length > 0)
            .map(([k, arr]) => [
              k,
              arr.map((x) => ({
                hash: x.hash,
                subject: x.subject,
                desc: x.desc,
                scope: x.scope,
                author: x.author,
                date: x.date,
                breaking: x.breaking,
              })),
            ])
        ),
        commits: commits.map((c) => ({ hash: c.hash, subject: c.subject, author: c.author, date: c.date })),
      };
      const jsonStr = JSON.stringify(jsonObj, null, 2);
      return truncate(jsonStr, MAX_OUTPUT);
    }

    // Markdown
    const out = [];
    out.push(`# Changelog`);
    out.push("");
    out.push(`> Range: \`${revRange}\` | Commits: ${commits.length} | Generated: ${new Date().toISOString().slice(0, 10)}`);
    out.push("");

    const labels = {
      feat: "✨ Features",
      fix: "🐛 Fixes",
      docs: "📝 Documentation",
      style: "💄 Styles",
      refactor: "♻️ Refactors",
      perf: "⚡ Performance",
      test: "✅ Tests",
      build: "📦 Build",
      ci: "👷 CI",
      chore: "🔧 Chores",
      revert: "⏪ Reverts",
      other: "📌 Other",
    };
    const order = ["feat", "fix", "perf", "refactor", "docs", "style", "test", "build", "ci", "chore", "revert", "other"];

    let hasGrouped = false;
    for (const type of order) {
      const arr = groups[type];
      if (!arr || arr.length === 0) continue;
      hasGrouped = true;
      out.push(`## ${labels[type]} (${arr.length})`);
      out.push("");
      for (const c of arr) {
        const scopeStr = c.scope ? `**${c.scope}**: ` : "";
        const breakingStr = c.breaking ? " ⚠️ BREAKING" : "";
        out.push(`- \`${c.hash}\` ${scopeStr}${c.desc} — *${c.author}* (${c.date})${breakingStr}`);
        if (c.subject !== c.desc) {
          // show original if truncated? Already desc is clean
        }
      }
      out.push("");
    }

    if (!hasGrouped) {
      out.push("(No conventional commits grouped — showing raw log)");
      out.push("");
      for (const c of commits) {
        out.push(`- \`${c.hash}\` ${c.subject} — *${c.author}* (${c.date})`);
      }
      out.push("");
    }

    // Add raw log appendix (first few)
    out.push("---");
    out.push(`<details><summary>Raw log (${commits.length} commits)</summary>`);
    out.push("");
    for (const c of commits.slice(0, 30)) {
      out.push(`- ${c.hash} ${c.subject} ${c.author} ${c.date}`);
    }
    if (commits.length > 30) out.push(`- ... and ${commits.length - 30} more`);
    out.push("");
    out.push("</details>");

    return truncate(out.join("\n"), MAX_OUTPUT);
  } catch (err) {
    return truncate(`ERROR changelog_generator: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 5. commit_linter
// ---------------------------------------------------------------------------
/**
 * Lint commit message against conventional commits.
 * @param {object} opts
 * @param {string} opts.target - "last_commit" or "staged"
 * @param {string} opts.rules - "conventional" (only supported)
 */
export async function commit_linter({ target = "last_commit", rules = "conventional" } = {}) {
  try {
    const tgt = String(target || "last_commit").toLowerCase() === "staged" ? "staged" : "last_commit";
    const ruleSet = String(rules || "conventional").toLowerCase();

    // Conventional commits regex (allows ! for breaking, optional scope)
    // Loose but standard: type(scope)!: description
    const CONVENTIONAL_REGEX = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?(!)?:\s.+$/;
    // Alternative more strict: description should be lowercase start? Keep loose for now.
    // Provide detailed error categories.

    if (tgt === "last_commit") {
      let commitMsg = "";
      try {
        const res = await execFileAsync("git", ["log", "-1", "--pretty=%B"], {
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
        commitMsg = (res.stdout || "").trim();
      } catch (err) {
        if (err.stderr && /does not have any commits yet|unknown revision|bad revision/i.test(err.stderr)) {
          return truncate(`ERROR commit_linter: no commits yet in this repository (git log -1 failed): ${err.stderr.trim()}`);
        }
        return truncate(`ERROR commit_linter: failed to get last commit message: ${formatExecError("git log -1 --pretty=%B", err)}`);
      }

      if (!commitMsg) {
        return truncate(`=== Commit Linter [${tgt} | ${ruleSet}] ===\nResult: FAIL ✖ (empty commit message)\nMessage: "(empty)"\nRule: conventional-commits requires "type(scope): description"`);
      }

      const firstLine = commitMsg.split("\n")[0].trim();
      const pass = CONVENTIONAL_REGEX.test(firstLine);

      // Additional checks for nice feedback
      const details = [];
      details.push(`=== Commit Linter [${tgt} | ${ruleSet}] ===`);
      details.push(`Commit: ${firstLine.slice(0, 120)}${firstLine.length > 120 ? "…" : ""}`);
      details.push(`Full message preview: ${commitMsg.slice(0, 500).replace(/\n/g, " ⏎ ")}`);
      details.push(`Rule: conventional-commits ${CONVENTIONAL_REGEX}`);
      details.push(`Result: ${pass ? "PASS ✔" : "FAIL ✖"}`);
      details.push("");

      if (pass) {
        const m = firstLine.match(CONVENTIONAL_REGEX);
        details.push(`Type: ${m[1]}${m[2] ? ` Scope: ${m[2]}` : ""}${m[3] ? " Breaking: !":""}`);
        details.push(`✔ Commit message follows conventional commits.`);
      } else {
        details.push(`✖ Commit message does NOT follow conventional commits.`);
        details.push("");
        details.push(`Expected: <type>(<scope>): <description>  e.g. "feat(auth): add login"`);
        details.push(`Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert`);
        details.push(`You may append "!" for breaking changes, e.g. "feat!: drop Node 16"`);
        // Diagnose specific failure
        if (!/:/.test(firstLine)) details.push(`Diagnosis: missing ":" separator.`);
        else if (!/^\w+(\(.+\))?(!)?:\s/.test(firstLine)) details.push(`Diagnosis: type/scope format invalid.`);
        else if (/^[A-Z]/.test(firstLine.split(":")[1]?.trim() || "")) details.push(`Note: description should start lowercase (conventional style).`);
        details.push("");
        details.push(`To fix: git commit --amend -m "fix(scope): your message"`);
      }

      // Validate body BREAKING CHANGE note if present
      if (/BREAKING CHANGE:/i.test(commitMsg) && !/!/.test(firstLine) && pass) {
        details.push(`Note: body contains BREAKING CHANGE but header missing "!" — consider "type!: description"`);
      }

      return truncate(details.join("\n"), MAX_OUTPUT);
    } else {
      // staged
      let stagedStat = "";
      let stagedNumstat = "";
      let hasStaged = false;
      try {
        const statRes = await execFileAsync("git", ["diff", "--cached", "--stat"], {
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
        stagedStat = (statRes.stdout || "").trim();
        hasStaged = Boolean(stagedStat);
      } catch (err) {
        // git diff --cached --stat returns 0 even when empty; error only if not repo
        if (err.stderr) stagedStat = err.stderr.trim();
        return truncate(`ERROR commit_linter (staged): ${formatExecError("git diff --cached --stat", err)}`);
      }

      try {
        const numRes = await execFileAsync("git", ["diff", "--cached", "--numstat"], {
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
        stagedNumstat = (numRes.stdout || "").trim();
      } catch (_) {}

      const out = [];
      out.push(`=== Commit Linter [staged | ${ruleSet}] ===`);
      if (!hasStaged || !stagedStat) {
        out.push(`Result: INFO — No staged changes.`);
        out.push(`Details: git diff --cached is empty. Stage changes with "git add <files>" before linting.`);
        out.push(`Tip: run commit_linter with target="last_commit" to lint the last commit message instead.`);
        return truncate(out.join("\n"), MAX_OUTPUT);
      }

      // We have staged changes — we cannot validate commit message yet, but we can report staged stats
      // and optionally lint the last commit as reference, plus validate staged diff sanity
      out.push(`Staged changes detected:`);
      out.push(stagedStat.slice(0, 3000));
      if (stagedNumstat) {
        out.push("");
        out.push("--- --numstat ---");
        out.push(stagedNumstat.slice(0, 2000));
      }

      // Count staged files
      let stagedFiles = [];
      try {
        const nameRes = await execFileAsync("git", ["diff", "--cached", "--name-only"], {
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
        stagedFiles = (nameRes.stdout || "").trim().split("\n").filter(Boolean);
      } catch (_) {}

      out.push("");
      out.push(`Staged files: ${stagedFiles.length}${stagedFiles.length ? ` — ${stagedFiles.slice(0, 20).join(", ")}${stagedFiles.length > 20 ? ` +${stagedFiles.length - 20} more` : ""}` : ""}`);

      // Since staged has no commit message yet, we provide guidance
      // Try to get last commit message for comparison
      let lastMsg = "";
      try {
        const lastRes = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { timeout: 5000, maxBuffer: 1 * 1024 * 1024 });
        lastMsg = (lastRes.stdout || "").trim();
      } catch (_) {}

      out.push("");
      out.push(`Lint check (staged):`);
      out.push(`- Conventional commit lint requires a commit message, which is not yet created for staged changes.`);
      out.push(`- Next step: commit with conventional format, e.g. "feat: add xyz" then re-run linter with target="last_commit".`);
      if (lastMsg) {
        const passLast = CONVENTIONAL_REGEX.test(lastMsg);
        out.push(`- Last commit message: "${lastMsg.slice(0, 120)}" → ${passLast ? "PASS ✔" : "FAIL ✖ (consider fixing next commit)"}`);
      }
      out.push("");
      out.push(`Validation: staged diff exists → PREPARE PASS (ready to commit). Ensure your commit message follows "${CONVENTIONAL_REGEX}"`);
      out.push(`Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert`);

      return truncate(out.join("\n"), MAX_OUTPUT);
    }
  } catch (err) {
    return truncate(`ERROR commit_linter: ${err.message}`);
  }
}
