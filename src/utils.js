/**
 * Shared utilities — single source for truncate, tokenize, glob, stripAnsi, etc.
 * Extracted for DRY (previously duplicated in 3 files)
 */

export const MAX_OUTPUT = 15000;

/**
 * Truncate string to MAX_OUTPUT with note
 */
export function truncate(str, max = MAX_OUTPUT) {
  if (typeof str !== "string") str = String(str ?? "");
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[truncated, ${str.length - max} more chars]`;
}

/**
 * Head+Tail truncate for logs — keeps beginning + end
 */
export function truncateMiddle(str, max = MAX_OUTPUT) {
  if (typeof str !== "string") str = String(str ?? "");
  if (str.length <= max) return str;
  const head = Math.floor(max * 0.8);
  const tail = max - head;
  return str.slice(0, head) + `\n...[middle truncated ${str.length - max} chars]...\n` + str.slice(-tail);
}

export const stripAnsi = (str) =>
  String(str ?? "").replace(/\x1B\[\d+m/g, "").replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

/**
 * Split shell-like argument string into safe argv array (honors single/double quotes)
 */
export function tokenizeArgs(str) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str ?? "")) ) !== null) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\(["\\])/g, "$1"));
    else if (m[2] !== undefined) tokens.push(m[2]);
    else tokens.push(m[3]);
  }
  return tokens;
}

/**
 * Parse line ranges like "10, 15, 20-30, 5" → Set of line numbers + grouped ranges
 */
export function parseLineRanges(spec, maxLines = Infinity) {
  if (!spec) return null;
  const nums = new Set();
  const parts = String(spec).split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (p.includes("-")) {
      const [a, b] = p.split("-").map((n) => parseInt(n.trim(), 10));
      if (isNaN(a) || isNaN(b)) continue;
      const s = Math.max(1, Math.min(a, b));
      const e = Math.min(maxLines, Math.max(a, b));
      for (let i = s; i <= e; i++) nums.add(i);
    } else {
      const n = parseInt(p, 10);
      if (!isNaN(n) && n >= 1 && n <= maxLines) nums.add(n);
    }
  }
  return Array.from(nums).sort((a, b) => a - b);
}

/**
 * Convert glob pattern to RegExp — supports *, **, ?, {a,b}, [abc]
 * Handles: "*.js" -> regex dot-star js, "star-star slash star.test.js", "src/**"
 */
export function globToRegex(pattern, flags = "i") {
  let p = String(pattern ?? "");
  // Escape then restore glob tokens
  // Use placeholder for **
  p = p.replace(/\*\*/g, "__GLOBSTAR__");
  p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  p = p.replace(/__GLOBSTAR__/g, ".*");
  p = p.replace(/\*/g, ".*");
  p = p.replace(/\?/g, ".");
  // Optional: handle {a,b} naive → (a|b)
  p = p.replace(/\\\{/g, "{").replace(/\\\}/g, "}").replace(/\{/g, "(").replace(/\}/g, ")").replace(/,/g, "|");
  return new RegExp(`^${p}$`, flags);
}

/**
 * Naive env line parser — handles `export FOO=bar`, quoted values, # comments
 */
export function parseDotenvLine(line) {
  let s = String(line ?? "").trim();
  if (!s || s.startsWith("#")) return null;
  if (s.startsWith("export ")) s = s.slice(7).trim();
  const eqIdx = s.indexOf("=");
  if (eqIdx === -1) return null;
  const key = s.slice(0, eqIdx).trim();
  let val = s.slice(eqIdx + 1).trim();
  // Remove inline comment not inside quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    // keep inside
    val = val.slice(1, -1);
  } else {
    // strip comment after #
    const hash = val.indexOf("#");
    if (hash !== -1) {
      // check if inside quotes — naive: if no quotes before hash, strip
      const before = val.slice(0, hash);
      if (!before.includes('"') && !before.includes("'")) val = before.trim();
    }
    // Unquote if remaining
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
  }
  return { key, value: val };
}

/**
 * Check if value looks like secret based on key name
 */
export function isSecretKey(key) {
  return /KEY|SECRET|TOKEN|PASS|CRED|AUTH/i.test(String(key ?? ""));
}

/**
 * Resolve project hash for per-project storage
 */
export function projectHash(cwd = process.cwd()) {
  // lightweight hash without crypto import overhead elsewhere
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
