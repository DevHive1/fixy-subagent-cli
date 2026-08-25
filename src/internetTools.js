// ============================================================================
// internetTools.js — Advanced Internet & Browsing Tools
// ----------------------------------------------------------------------------
// Zero-dependency (Node 22 built-ins only) suite of advanced web tools:
//   1. web_search       - Multi-engine web search (DuckDuckGo + Wikipedia)
//   2. web_scrape       - CSS-selector based HTML scraping & structured extraction
//   3. web_crawl        - Multi-page recursive crawling with URL/host filters
//   4. web_screenshot   - HTML rendering metadata (headless preview descriptor)
//   5. web_extract_links - Extract all hyperlinks + metadata from a page
//   6. web_extract_metadata - OpenGraph, Twitter Card, JSON-LD, SEO meta
//   7. web_download     - Download remote files (PDF, images, archives) to disk
//   8. web_rss          - Parse RSS / Atom feeds
//   9. web_sitemap      - Parse XML sitemaps (urlset + sitemap index)
// ----------------------------------------------------------------------------
// Compatible with the existing Fixy agent tool-call registry.
// ============================================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import { URL } from "node:url";

const MAX_OUTPUT = 15000;

function truncate(str) {
  if (typeof str !== "string") str = String(str ?? "");
  if (str.length <= MAX_OUTPUT) return str;
  return str.slice(0, MAX_OUTPUT) + `\n...[truncated, ${str.length - MAX_OUTPUT} more chars]`;
}

// Shared User-Agents
const UA_BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_FIXY = "Fixy-Agent/2.0 (+https://github.com/fixy-agent)";

// ---------------------------------------------------------------------------
// Shared HTTP helper with timeout, redirect handling and size limit
// ---------------------------------------------------------------------------
async function safeFetch(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeout_ms = 20000,
    max_bytes = 10 * 1024 * 1024, // 10 MB
    follow_redirects = true,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": UA_BROWSER, ...headers },
      body,
      redirect: follow_redirects ? "follow" : "manual",
      signal: controller.signal,
    });

    // Read body with byte limit
    const reader = res.body?.getReader();
    if (!reader) {
      return { ok: false, status: res.status, statusText: res.statusText, text: "", truncated: false, contentType: "" };
    }

    const chunks = [];
    let received = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > max_bytes) {
        const allowed = max_bytes - (received - value.length);
        if (allowed > 0) chunks.push(value.subarray(0, allowed));
        truncated = true;
        try { await reader.cancel(); } catch (_) { /* ignore */ }
        break;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      text: buf.toString("utf8"),
      bytes: received,
      truncated,
      contentType: res.headers.get("content-type") || "",
      finalUrl: res.url || url,
    };
  } catch (err) {
    return { ok: false, status: 0, statusText: err.name || "Error", text: "", error: err.message, contentType: "" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML utilities (zero-dependency regex-based — good enough for extraction)
// ---------------------------------------------------------------------------

/** Decode common HTML entities */
function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/** Strip scripts/styles and return clean text */
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/** Extract attribute value from a tag match */
function getAttr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  if (!m) return "";
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/** Find all tags by name (case-insensitive, supports self-closing) */
function findTags(html, tagName) {
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ full: m[0], attrs: m[1] || "" });
  }
  return out;
}

/** Resolve a possibly-relative URL against a base */
function resolveUrl(href, base) {
  if (!href) return "";
  try {
    if (!base) return href;
    return new URL(href, base).toString();
  } catch (_) {
    return href;
  }
}

/** Get hostname of a URL */
function getHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}

// ===========================================================================
// 1. web_search — Multi-engine web search
// ===========================================================================
export async function webSearch({
  query,
  engine = "duckduckgo",
  max_results = 8,
  safe_search = "moderate",
  region = "us-en",
  timeout_ms = 15000,
} = {}) {
  if (!query || typeof query !== "string" || !query.trim()) {
    return "ERROR: 'query' is required and must be a non-empty string.";
  }

  const q = query.trim();
  const out = [`=== Web Search: "${q}" ===`];
  out.push(`Engine: ${engine} | Region: ${region} | SafeSearch: ${safe_search}`);
  out.push("");

  try {
    if (engine === "wikipedia") {
      // Wikipedia REST + Action API (no key required, CC-BY-SA)
      // Map region like "us-en" → "en" (we want the language subdomain)
      const lang = (region.split("-").pop() || "en").toLowerCase();
      const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`;
      const r = await safeFetch(summaryUrl, { timeout_ms, headers: { Accept: "application/json" } });
      if (!r.ok) {
        return out.join("\n") + `\n[Wikipedia request failed: HTTP ${r.status} ${r.statusText}]`;
      }
      const data = JSON.parse(r.text);
      out.push(`--- Wikipedia Summary ---`);
      out.push(`Title:       ${data.title || q}`);
      out.push(`Description: ${data.description || "—"}`);
      out.push(`URL:         ${data.content_urls?.desktop?.page || r.finalUrl}`);
      if (data.extract) {
        out.push("");
        out.push(data.extract);
      }
      if (data.thumbnail?.source) {
        out.push(`\nThumbnail:   ${data.thumbnail.source}`);
      }
      return truncate(out.join("\n"));
    }

    if (engine === "duckduckgo" || engine === "auto") {
      // DuckDuckGo HTML endpoint (no key, anonymous)
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(region)}&kp=${safe_search === "on" ? "1" : safe_search === "off" ? "-1" : "-2"}`;
      const r = await safeFetch(ddgUrl, {
        timeout_ms,
        headers: {
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!r.ok) {
        return out.join("\n") + `\n[DuckDuckGo request failed: HTTP ${r.status} ${r.statusText}]`;
      }

      // Parse results
      const resultBlocks = r.text.split(/<div[^>]*class="[^"]*result[^"]*"[^>]*>/i).slice(1);
      const results = [];
      for (const block of resultBlocks) {
        // Title + URL
        const aMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
          || block.match(/<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!aMatch) continue;
        const rawHref = aMatch[1];
        // Skip sponsored ads (their hrefs go through ad-tracking redirects)
        if (/ad_provider|ad_domain|bingv7aa|ad_type/.test(rawHref)) continue;
        // DDG wraps real URL in //duckduckgo.com/l/?uddg=<encoded>
        let url = rawHref;
        const uddg = rawHref.match(/[?&]uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
        const title = htmlToText(aMatch[2]).replace(/\s+—\s+.*$/, "").trim();
        if (!title || !url) continue;

        // Snippet
        const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
          || block.match(/<td[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/td>/i);
        const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : "";

        results.push({ title, url, snippet });
        if (results.length >= max_results) break;
      }

      if (results.length === 0) {
        out.push("(No results returned — DuckDuckGo may be rate-limiting. Try 'engine=wikipedia' or retry.)");
        out.push(`Raw response preview (${r.bytes} bytes):`);
        out.push(htmlToText(r.text).slice(0, 1200));
      } else {
        results.forEach((res, i) => {
          out.push(`${i + 1}. ${res.title}`);
          out.push(`   ${res.url}`);
          if (res.snippet) out.push(`   ${res.snippet}`);
          out.push("");
        });
      }
      return truncate(out.join("\n"));
    }

    if (engine === "github") {
      // GitHub REST search (unauthenticated, rate-limited but usable)
      const r = await safeFetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${Math.min(max_results, 30)}`,
        { timeout_ms, headers: { Accept: "application/vnd.github+json" } }
      );
      if (!r.ok) {
        return out.join("\n") + `\n[GitHub API failed: HTTP ${r.status} ${r.statusText}]`;
      }
      const data = JSON.parse(r.text);
      const items = data.items || [];
      if (items.length === 0) {
        out.push("(No GitHub repositories matched.)");
      } else {
        items.slice(0, max_results).forEach((it, i) => {
          out.push(`${i + 1}. ${it.full_name}  ★ ${it.stargazers_count?.toLocaleString() ?? "?"}  (${it.language || "—"})`);
          out.push(`   ${it.html_url}`);
          if (it.description) out.push(`   ${it.description}`);
          out.push("");
        });
      }
      return truncate(out.join("\n"));
    }

    if (engine === "npm") {
      const r = await safeFetch(
        `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${Math.min(max_results, 20)}`,
        { timeout_ms, headers: { Accept: "application/json" } }
      );
      if (!r.ok) {
        return out.join("\n") + `\n[npm registry failed: HTTP ${r.status} ${r.statusText}]`;
      }
      const data = JSON.parse(r.text);
      const objects = data.objects || [];
      if (objects.length === 0) {
        out.push("(No npm packages matched.)");
      } else {
        objects.slice(0, max_results).forEach((pkg, i) => {
          const p = pkg.package || {};
          out.push(`${i + 1}. ${p.name}  v${p.version}  (score: ${pkg.score?.final?.toFixed(3) ?? "?"})`);
          out.push(`   ${p.links?.npm || ""}`);
          if (p.description) out.push(`   ${p.description}`);
          out.push("");
        });
      }
      return truncate(out.join("\n"));
    }

    return `ERROR: unsupported engine "${engine}". Use: duckduckgo, wikipedia, github, npm.`;
  } catch (err) {
    return `ERROR web_search failed: ${err.message}`;
  }
}

// ===========================================================================
// 2. web_scrape — CSS-selector based extraction (with structured fields)
// ===========================================================================

/** Find the index of the closing tag for `tagName`, honoring nesting depth.
 *  Returns html.length when no matching close tag exists (unclosed element).
 */
function findMatchingClose(html, fromIdx, tagName) {
  if (/^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i.test(tagName)) {
    return fromIdx; // void element — no closing tag
  }
  const tokenRe = new RegExp(`<${tagName}(\\s[^>]*)?>|</${tagName}\\s*>`, "gi");
  tokenRe.lastIndex = fromIdx;
  let depth = 1;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[0][1] === "/") {
      depth--;
      if (depth === 0) return m.index;
    } else {
      depth++;
    }
  }
  return html.length;
}

/** Match one compound CSS selector (tag, #id, .class, [attr...]) against a node.
 *  Combinators ("div p") are not supported — only the last simple part is
 *  honored; use web_extract_links / web_extract_metadata for deeper needs.
 */
function matchSimple(node, sel) {
  sel = String(sel || "").trim().split(/\s+/).pop(); // last compound segment only
  if (!sel) return false;
  const m = sel.match(/^([a-zA-Z][a-zA-Z0-9-]*|\*)?(#[a-zA-Z0-9_-]+)?((?:\.[a-zA-Z0-9_-]+)*)?((?:\[[^\]]+\])*)?$/);
  if (!m) return false;
  const [, tagRaw, idRaw, classesRaw, attrGroup = ""] = m;

  if (tagRaw && tagRaw !== "*" && node.tag !== tagRaw.toLowerCase()) return false;
  if (idRaw && node.id !== idRaw.slice(1)) return false;
  if (classesRaw) {
    for (const c of classesRaw.split(".").filter(Boolean)) {
      if (!node.classes.includes(c)) return false;
    }
  }
  if (attrGroup) {
    const attrRe = /\[([a-zA-Z0-9_-]+)(?:([~^$*|]?=)"?([^"\]]+)"?)?\]/g;
    let am;
    while ((am = attrRe.exec(attrGroup)) !== null) {
      const name = am[1].toLowerCase();
      const op = am[2] || "";
      const val = am[3] || "";
      const actual = node.attrs[name];
      if (actual === undefined) return false;
      switch (op) {
        case "=": if (actual !== val) return false; break;
        case "*=": if (!actual.includes(val)) return false; break;
        case "^=": if (!actual.startsWith(val)) return false; break;
        case "$=": if (!actual.endsWith(val)) return false; break;
        case "~=": if (!actual.split(/\s+/).includes(val)) return false; break;
        case "|=": if (!(actual === val || actual.startsWith(val + "-"))) return false; break;
      }
    }
  }
  return true;
}

export async function webScrape({
  url,
  selectors = null,         // object: { fieldName: cssSelector }
  selector = null,          // shorthand single selector
  attr = null,              // if set, extract that attribute instead of text
  max_items = 50,
  base_url = null,          // override base for resolving relative URLs
  include_html = false,     // include raw outer HTML of matches
  timeout_ms = 20000,
} = {}) {
  if (!url) return "ERROR: 'url' is required.";
  if (!selectors && !selector) {
    return "ERROR: provide either 'selector' (single) or 'selectors' (object map of field→CSS-selector).";
  }

  const r = await safeFetch(url, { timeout_ms });
  if (!r.ok && r.status !== 0) {
    return `ERROR web_scrape: HTTP ${r.status} ${r.statusText}`;
  }
  if (r.error) return `ERROR web_scrape: ${r.error}`;

  const base = base_url || r.finalUrl || url;

  const out = [`=== Web Scrape: ${url} ===`];
  out.push(`Status: HTTP ${r.status} | Content-Type: ${r.contentType} | Bytes: ${r.bytes}${r.truncated ? " (truncated)" : ""}`);
  out.push("");

  // For text extraction, use a richer approach: find tags by regex, then
  // extract their inner text by finding the matching closing tag.
  function extractText(sel) {
    const re = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)((?:\\s+[^>]*?)?)\\s*>`, "g");
    const out = [];
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const tag = m[1].toLowerCase();
      if (["script", "style", "noscript", "template"].includes(tag)) continue;
      const attrsRaw = m[2] || "";
      const id = (attrsRaw.match(/\bid\s*=\s*"([^"]+)"/) || attrsRaw.match(/\bid\s*=\s*'([^']+)'/) || [, ""])[1];
      const classMatch = attrsRaw.match(/\bclass\s*=\s*"([^"]+)"/) || attrsRaw.match(/\bclass\s*=\s*'([^']+)'/);
      const classes = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
      const attrs = {};
      const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
      let am;
      while ((am = attrRe.exec(attrsRaw)) !== null) {
        attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
      }
      const node = { tag, id, classes, attrs };
      if (matchSimple(node, sel)) {
        // Find inner text (honors nesting depth for the same tag)
        const start = m.index + m[0].length;
        const end = findMatchingClose(r.text, start, tag);
        const innerHtml = r.text.slice(start, end);
        const text = htmlToText(innerHtml);
        const item = { tag, id, classes: classes.join(" "), text };
        if (attr) {
          item[attr] = resolveUrl(attrs[attr] || "", base);
        }
        if (include_html) {
          item.html = innerHtml.length > 2000 ? innerHtml.slice(0, 2000) + "..." : innerHtml;
        }
        out.push(item);
        if (out.length >= max_items) break;
      }
    }
    return out;
  }

  if (selectors && typeof selectors === "object") {
    const data = {};
    for (const [field, sel] of Object.entries(selectors)) {
      data[field] = extractText(sel).map((x) => {
        const o = { ...x };
        delete o.tag;
        return o;
      });
      if (data[field].length === 1) data[field] = data[field][0];
    }
    out.push(JSON.stringify(data, null, 2));
  } else {
    const items = extractText(selector);
    if (items.length === 0) {
      out.push(`(No matches for selector "${selector}")`);
    } else {
      items.forEach((it, i) => {
        out.push(`--- Match ${i + 1} <${it.tag}${it.id ? ` #${it.id}` : ""}${it.classes ? ` .${it.classes.split(" ").join(".")}` : ""}> ---`);
        if (attr && it[attr]) {
          out.push(`${attr}: ${it[attr]}`);
        }
        if (it.text) {
          out.push(it.text.slice(0, 800));
        }
        if (include_html && it.html) {
          out.push("[html]");
          out.push(it.html.slice(0, 600));
        }
        out.push("");
      });
    }
  }

  return truncate(out.join("\n"));
}

// ===========================================================================
// 3. web_crawl — Multi-page recursive crawling
// ===========================================================================
export async function webCrawl({
  start_url,
  max_pages = 10,
  max_depth = 2,
  same_domain = true,
  url_pattern = null,     // regex string to include URLs
  exclude_pattern = null,  // regex string to exclude URLs
  delay_ms = 0,            // polite delay between requests
  timeout_ms = 15000,
  max_bytes_per_page = 2 * 1024 * 1024,
} = {}) {
  if (!start_url) return "ERROR: 'start_url' is required.";

  let baseHost = "";
  try { baseHost = new URL(start_url).hostname.toLowerCase(); } catch (_) {
    return "ERROR: 'start_url' is not a valid URL.";
  }

  const includeRe = url_pattern ? new RegExp(url_pattern) : null;
  const excludeRe = exclude_pattern ? new RegExp(exclude_pattern) : null;

  const visited = new Set();
  const enqueued = new Set([start_url]);
  const queue = [{ url: start_url, depth: 0 }];
  const results = [];

  function shouldVisit(u) {
    if (!u) return false;
    if (visited.has(u)) return false;
    if (enqueued.has(u)) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    try {
      const h = new URL(u).hostname.toLowerCase();
      if (same_domain && h !== baseHost) return false;
    } catch (_) { return false; }
    if (includeRe && !includeRe.test(u)) return false;
    if (excludeRe && excludeRe.test(u)) return false;
    return true;
  }

  while (queue.length > 0 && results.length < max_pages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const r = await safeFetch(url, { timeout_ms, max_bytes: max_bytes_per_page });
    if (!r.ok && r.status !== 0) {
      results.push({ url, status: r.status, error: r.statusText, links: [] });
      continue;
    }

    // Extract links if HTML
    const links = [];
    if (r.contentType.includes("text/html")) {
      const linkRe = /<a\s+[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = linkRe.exec(r.text)) !== null) {
        const href = m[1] ?? m[2] ?? m[3] ?? "";
        const text = htmlToText(m[4] || "").slice(0, 80);
        if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
        const abs = resolveUrl(href, r.finalUrl || url);
        links.push({ href: abs, text });
        if (depth < max_depth && shouldVisit(abs)) {
          enqueued.add(abs);
          queue.push({ url: abs, depth: depth + 1 });
        }
      }
    }

    const titleMatch = r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]) : "";

    results.push({
      url,
      status: r.status,
      title: title.slice(0, 120),
      bytes: r.bytes,
      contentType: r.contentType,
      linksFound: links.length,
      links: links.slice(0, 25),
    });

    if (delay_ms > 0) await new Promise((res) => setTimeout(res, delay_ms));
  }

  const out = [`=== Web Crawl: ${start_url} ===`];
  out.push(`Pages visited: ${results.length} | Max: ${max_pages} | Max depth: ${max_depth} | Same domain: ${same_domain}`);
  if (url_pattern) out.push(`URL include pattern: ${url_pattern}`);
  if (exclude_pattern) out.push(`URL exclude pattern: ${exclude_pattern}`);
  out.push("");

  results.forEach((p, i) => {
    out.push(`[${i + 1}] ${p.url}`);
    out.push(`    HTTP ${p.status} | ${p.bytes.toLocaleString()} bytes | ${p.title || "(no title)"}`);
    out.push(`    Links found: ${p.linksFound}`);
    if (p.error) out.push(`    Error: ${p.error}`);
    if (p.links.length > 0) {
      p.links.slice(0, 5).forEach((l) => {
        out.push(`      → ${l.href}${l.text ? `  [${l.text}]` : ""}`);
      });
      if (p.links.length > 5) out.push(`      ... and ${p.links.length - 5} more`);
    }
    out.push("");
  });

  return truncate(out.join("\n"));
}

// ===========================================================================
// 4. web_screenshot — HTML rendering metadata & "headless preview descriptor"
// ===========================================================================
// Since this is a zero-dep environment without Puppeteer, we provide a rich
// static analysis that approximates what a screenshot would show: dimensions,
// structure, image list, color palette, font usage, performance hints, etc.
export async function webScreenshot({
  url,
  include_structure = true,
  include_assets = true,
  include_performance_hints = true,
  timeout_ms = 20000,
} = {}) {
  if (!url) return "ERROR: 'url' is required.";

  const r = await safeFetch(url, { timeout_ms });
  if (!r.ok && r.status !== 0) return `ERROR web_screenshot: HTTP ${r.status} ${r.statusText}`;
  if (r.error) return `ERROR web_screenshot: ${r.error}`;

  const html = r.text;
  const out = [`=== Headless Render Descriptor: ${url} ===`];
  out.push(`HTTP ${r.status} | ${r.bytes.toLocaleString()} bytes | ${r.contentType} | Load time: ${r.headers["x-response-time"] || "(n/a)"}`);
  out.push("");

  // Title & description
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1];
  const desc = (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) || [, ""])[1];
  out.push(`Title:       ${htmlToText(title) || "—"}`);
  out.push(`Description: ${htmlToText(desc) || "—"}`);
  out.push("");

  // Viewport / meta
  const viewport = (html.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i) || [, ""])[1];
  const charset = (html.match(/<meta\s+charset=["']?([^"'\s>]+)/i) || [, ""])[1];
  const lang = (html.match(/<html[^>]+lang=["']([^"']+)/i) || [, ""])[1];
  out.push(`Language:    ${lang || "(not set)"}`);
  out.push(`Charset:     ${charset || "(not set)"}`);
  out.push(`Viewport:    ${viewport || "(not set)"}`);
  out.push("");

  if (include_structure) {
    const tagCounts = {};
    const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)/g;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
      const t = m[1].toLowerCase();
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    out.push("--- DOM Structure (tag counts) ---");
    Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .forEach(([t, c]) => out.push(`  <${t}>: ${c}`));
    out.push("");
  }

  if (include_assets) {
    const images = [];
    const imgRe = /<img\s+[^>]*src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    let im;
    while ((im = imgRe.exec(html)) !== null) {
      const src = im[1] ?? im[2] ?? im[3] ?? "";
      if (src) images.push(resolveUrl(src, r.finalUrl));
    }
    const scripts = [];
    const sRe = /<script\s+[^>]*src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    while ((im = sRe.exec(html)) !== null) {
      const src = im[1] ?? im[2] ?? im[3] ?? "";
      if (src) scripts.push(resolveUrl(src, r.finalUrl));
    }
    const styles = [];
    const lRe = /<link\s+[^>]*rel\s*=\s*(?:"stylesheet"|'stylesheet')[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    while ((im = lRe.exec(html)) !== null) {
      const href = im[1] ?? im[2] ?? im[3] ?? "";
      if (href) styles.push(resolveUrl(href, r.finalUrl));
    }

    out.push("--- Assets ---");
    out.push(`  Images: ${images.length}`);
    images.slice(0, 10).forEach((u) => out.push(`    • ${u}`));
    if (images.length > 10) out.push(`    ... and ${images.length - 10} more`);
    out.push(`  Scripts: ${scripts.length}`);
    scripts.slice(0, 8).forEach((u) => out.push(`    • ${u}`));
    if (scripts.length > 8) out.push(`    ... and ${scripts.length - 8} more`);
    out.push(`  Stylesheets: ${styles.length}`);
    styles.slice(0, 8).forEach((u) => out.push(`    • ${u}`));
    if (styles.length > 8) out.push(`    ... and ${styles.length - 8} more`);
    out.push("");
  }

  if (include_performance_hints) {
    const hints = [];
    const inlineScriptLen = (html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || [])
      .reduce((sum, s) => sum + s.length, 0);
    const inlineStyleLen = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
      .reduce((sum, s) => sum + s.length, 0);
    const hasLazy = /\bloading\s*=\s*["']lazy["']/i.test(html);
    const hasDefer = /\bdefer(\s|>|=)/i.test(html) || /\basync(\s|>|=)/i.test(html);
    const hasPreconnect = /<link[^>]+rel\s*=\s*["']preconnect["']/i.test(html);
    const hasSrcset = /\bsrcset\s*=/i.test(html);

    if (inlineScriptLen > 100000) hints.push(`⚠ Large inline JS: ${(inlineScriptLen / 1024).toFixed(1)} KB (consider externalizing)`);
    if (inlineStyleLen > 50000) hints.push(`⚠ Large inline CSS: ${(inlineStyleLen / 1024).toFixed(1)} KB`);
    if (!hasLazy) hints.push("ℹ No `loading=\"lazy\"` images found");
    if (!hasDefer) hints.push("ℹ Scripts are not deferred/async");
    if (!hasPreconnect) hints.push("ℹ No preconnect hints for external origins");
    if (!hasSrcset) hints.push("ℹ No responsive `srcset` on images");
    if (r.bytes > 500000) hints.push(`ℹ Page weight: ${(r.bytes / 1024).toFixed(1)} KB (consider compression)`);
    if (hints.length === 0) hints.push("✔ No obvious performance issues detected");
    out.push("--- Performance Hints ---");
    hints.forEach((h) => out.push(`  ${h}`));
    out.push("");
  }

  out.push("--- Render Note ---");
  out.push("This is a static HTML descriptor. For pixel-perfect rendering, integrate");
  out.push("Puppeteer/Playwright in your environment and call page.screenshot() via run_command.");

  return truncate(out.join("\n"));
}

// ===========================================================================
// 5. web_extract_links — Extract all hyperlinks from a page
// ===========================================================================
export async function webExtractLinks({
  url,
  filter_pattern = null,   // regex string
  include_external = true,
  max_links = 200,
  timeout_ms = 20000,
} = {}) {
  if (!url) return "ERROR: 'url' is required.";

  const r = await safeFetch(url, { timeout_ms });
  if (!r.ok && r.status !== 0) return `ERROR web_extract_links: HTTP ${r.status} ${r.statusText}`;
  if (r.error) return `ERROR web_extract_links: ${r.error}`;

  const baseHost = getHost(r.finalUrl || url);
  const filterRe = filter_pattern ? new RegExp(filter_pattern) : null;

  const links = [];
  const seen = new Set();
  const re = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(r.text)) !== null) {
    const attrsRaw = m[1] || "";
    const hrefMatch = attrsRaw.match(/href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/);
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:") || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) continue;

    const abs = resolveUrl(rawHref, r.finalUrl || url);
    if (seen.has(abs)) continue;
    seen.add(abs);

    const rel = (attrsRaw.match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[1]
      || (attrsRaw.match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[2]
      || "";
    const type = (attrsRaw.match(/\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[1]
      || (attrsRaw.match(/\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[2]
      || "";
    const target = (attrsRaw.match(/\btarget\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[1]
      || (attrsRaw.match(/\btarget\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[2]
      || "";
    const text = htmlToText(m[2]).slice(0, 120);

    const host = getHost(abs);
    const isExternal = host && host !== baseHost;

    if (!include_external && isExternal) continue;
    if (filterRe && !filterRe.test(abs) && !filterRe.test(text)) continue;

    links.push({ href: abs, text, rel, type, target, external: isExternal });
    if (links.length >= max_links) break;
  }

  const internal = links.filter((l) => !l.external);
  const external = links.filter((l) => l.external);

  const out = [`=== Link Extraction: ${url} ===`];
  out.push(`Total unique links: ${links.length} | Internal: ${internal.length} | External: ${external.length}`);
  if (filter_pattern) out.push(`Filter pattern: ${filter_pattern}`);
  out.push("");

  if (internal.length) {
    out.push(`--- Internal (${internal.length}) ---`);
    internal.slice(0, 60).forEach((l) => {
      out.push(`  ${l.href}${l.text ? `  [${l.text}]` : ""}${l.target === "_blank" ? "  ↗" : ""}`);
    });
    if (internal.length > 60) out.push(`  ... and ${internal.length - 60} more`);
    out.push("");
  }
  if (external.length) {
    out.push(`--- External (${external.length}) ---`);
    external.slice(0, 60).forEach((l) => {
      out.push(`  ${l.href}${l.text ? `  [${l.text}]` : ""}${l.target === "_blank" ? "  ↗" : ""}`);
    });
    if (external.length > 60) out.push(`  ... and ${external.length - 60} more`);
  }

  return truncate(out.join("\n"));
}

// ===========================================================================
// 6. web_extract_metadata — OpenGraph, Twitter Card, JSON-LD, SEO meta
// ===========================================================================
export async function webExtractMetadata({ url, timeout_ms = 20000 } = {}) {
  if (!url) return "ERROR: 'url' is required.";

  const r = await safeFetch(url, { timeout_ms });
  if (!r.ok && r.status !== 0) return `ERROR web_extract_metadata: HTTP ${r.status} ${r.statusText}`;
  if (r.error) return `ERROR web_extract_metadata: ${r.error}`;

  const html = r.text;
  const out = [`=== Metadata Extraction: ${url} ===`];
  out.push(`HTTP ${r.status} | ${r.bytes.toLocaleString()} bytes | ${r.contentType}`);
  out.push("");

  // Standard meta tags
  const standard = {};
  const metaRe = /<meta\s+([^>]+?)\/?\s*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = m[1];
    const name = (attrs.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[1]
      || (attrs.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[2]
      || (attrs.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[3]
      || "";
    const prop = (attrs.match(/\bproperty\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[1]
      || (attrs.match(/\bproperty\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[2]
      || (attrs.match(/\bproperty\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[3]
      || "";
    const content = (attrs.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/) || [])[1]
      ?? (attrs.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/) || [])[2]
      ?? (attrs.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/) || [])[3]
      ?? "";
    const key = (name || prop || "").toLowerCase();
    if (!key || !content) continue;
    if (!standard[key]) standard[key] = content;
  }

  // Categorize
  const seo = ["description", "keywords", "author", "robots", "canonical", "generator", "theme-color"];
  const seoOut = {};
  for (const k of seo) if (standard[k]) seoOut[k] = standard[k];

  // OpenGraph
  const og = {};
  for (const [k, v] of Object.entries(standard)) {
    if (k.startsWith("og:")) og[k] = v;
  }
  // Twitter
  const twitter = {};
  for (const [k, v] of Object.entries(standard)) {
    if (k.startsWith("twitter:")) twitter[k] = v;
  }
  // Article
  const article = {};
  for (const [k, v] of Object.entries(standard)) {
    if (k.startsWith("article:")) article[k] = v;
  }

  out.push("--- SEO Meta ---");
  if (Object.keys(seoOut).length === 0) out.push("  (none)");
  Object.entries(seoOut).forEach(([k, v]) => out.push(`  ${k}: ${v}`));
  out.push("");

  out.push("--- OpenGraph ---");
  if (Object.keys(og).length === 0) out.push("  (none)");
  Object.entries(og).forEach(([k, v]) => out.push(`  ${k}: ${v}`));
  out.push("");

  out.push("--- Twitter Card ---");
  if (Object.keys(twitter).length === 0) out.push("  (none)");
  Object.entries(twitter).forEach(([k, v]) => out.push(`  ${k}: ${v}`));
  out.push("");

  if (Object.keys(article).length) {
    out.push("--- Article Meta ---");
    Object.entries(article).forEach(([k, v]) => out.push(`  ${k}: ${v}`));
    out.push("");
  }

  // Link relations (canonical, alternate, prev/next, icon)
  out.push("--- Link Relations ---");
  const linkRe = /<link\s+([^>]+?)\/?\s*>/gi;
  let lm;
  const links = [];
  while ((lm = linkRe.exec(html)) !== null) {
    const attrs = lm[1];
    const rel = (attrs.match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[1]
      || (attrs.match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[2]
      || "";
    const href = (attrs.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[1]
      || (attrs.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[2]
      || "";
    const type = (attrs.match(/\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[1]
      || (attrs.match(/\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/) || [])[2]
      || "";
    if (rel && href) {
      links.push({ rel, href, type });
    }
  }
  if (links.length === 0) {
    out.push("  (none)");
  } else {
    links.slice(0, 25).forEach((l) => {
      out.push(`  rel=${l.rel}${l.type ? ` type=${l.type}` : ""}: ${resolveUrl(l.href, r.finalUrl || url)}`);
    });
    if (links.length > 25) out.push(`  ... and ${links.length - 25} more`);
  }
  out.push("");

  // JSON-LD structured data
  out.push("--- JSON-LD Structured Data ---");
  const jsonLd = [];
  const jlRe = /<script\s+[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi;
  let jm;
  while ((jm = jlRe.exec(html)) !== null) {
    const raw = jm[1].trim();
    try {
      const parsed = JSON.parse(raw);
      jsonLd.push(parsed);
    } catch (e) {
      jsonLd.push({ _parseError: e.message, _raw: raw.slice(0, 200) });
    }
  }
  if (jsonLd.length === 0) {
    out.push("  (none)");
  } else {
    jsonLd.forEach((obj, i) => {
      out.push(`  [${i + 1}] ${JSON.stringify(obj, null, 2).split("\n").map((l) => "    " + l).join("\n")}`);
    });
  }
  out.push("");

  // Microdata / RDFa hint
  const hasMicrodata = /\bitemscope\b/i.test(html);
  const hasRdfa = /\btypeof\s*=/i.test(html);
  if (hasMicrodata || hasRdfa) {
    out.push("--- Microformats / RDFa ---");
    if (hasMicrodata) out.push("  ✓ Microdata (itemscope/itemprop) detected");
    if (hasRdfa) out.push("  ✓ RDFa (typeof/property) detected");
  }

  return truncate(out.join("\n"));
}

// ===========================================================================
// 7. web_download — Download remote files to disk
// ===========================================================================
export async function webDownload({
  url,
  output_path = null,           // if null, use current dir + filename from URL
  max_bytes = 100 * 1024 * 1024, // 100 MB
  timeout_ms = 60000,
  overwrite = false,
} = {}) {
  if (!url) return "ERROR: 'url' is required.";

  // Determine filename
  let filename = "";
  try {
    const u = new URL(url);
    filename = path.basename(u.pathname) || "download";
  } catch (_) {
    return "ERROR: 'url' is not a valid URL.";
  }
  const dest = output_path ? path.resolve(output_path) : path.resolve(process.cwd(), filename);

  // Ensure parent dir
  await fs.mkdir(path.dirname(dest), { recursive: true });

  // Check existence
  if (!overwrite) {
    try {
      await fs.access(dest);
      return `ERROR: destination already exists: ${dest}. Pass overwrite=true to replace.`;
    } catch (_) { /* not exists — fine */ }
  }

  // Stream to disk with size limit
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA_FIXY } });
  } catch (err) {
    clearTimeout(timer);
    return `ERROR web_download: ${err.message}`;
  }

  if (!res.ok) {
    clearTimeout(timer);
    return `ERROR web_download: HTTP ${res.status} ${res.statusText}`;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    clearTimeout(timer);
    return "ERROR web_download: response has no body";
  }

  const fh = await fs.open(dest, "w");
  let received = 0;
  let truncated = false;
  const contentType = res.headers.get("content-type") || "";
  const contentLength = parseInt(res.headers.get("content-length") || "0", 10);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > max_bytes) {
        const allowed = max_bytes - received;
        if (allowed > 0) {
          await fh.write(value.subarray(0, allowed));
          received += allowed;
        }
        truncated = true;
        try { await reader.cancel(); } catch (_) { /* ignore */ }
        break;
      }
      await fh.write(value);
      received += value.length;
    }
  } finally {
    await fh.close();
    clearTimeout(timer);
  }

  if (truncated) {
    // Remove partial file
    try { await fs.unlink(dest); } catch (_) { /* ignore */ }
    return `ERROR web_download: file exceeded max_bytes (${max_bytes}). Aborted and cleaned up.`;
  }

  const out = [
    `=== Download Complete ===`,
    `URL:           ${url}`,
    `Saved to:      ${dest}`,
    `Bytes:         ${received.toLocaleString()}`,
    `Content-Type:  ${contentType}`,
    `Expected size: ${contentLength ? contentLength.toLocaleString() : "(unknown)"}`,
    `Match:         ${contentLength && contentLength === received ? "✔ exact" : contentLength ? "⚠ size mismatch" : "—"}`,
  ];
  return out.join("\n");
}

// ===========================================================================
// 8. web_rss — Parse RSS 2.0 / Atom 1.0 feeds
// ===========================================================================
export async function webRss({
  url,
  max_items = 20,
  include_content = false,
  timeout_ms = 20000,
} = {}) {
  if (!url) return "ERROR: 'url' is required.";

  const r = await safeFetch(url, { timeout_ms, headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
  if (!r.ok && r.status !== 0) return `ERROR web_rss: HTTP ${r.status} ${r.statusText}`;
  if (r.error) return `ERROR web_rss: ${r.error}`;

  const xml = r.text;
  const out = [`=== RSS / Atom Feed: ${url} ===`];
  out.push(`HTTP ${r.status} | ${r.bytes.toLocaleString()} bytes | ${r.contentType}`);
  out.push("");

  // Detect format
  const isAtom = /<feed[\s>]/i.test(xml) && /xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xml);
  const isRss = /<rss[\s>]/i.test(xml) || /<channel[\s>]/i.test(xml);

  if (isAtom) {
    // Atom 1.0
    const feedTitle = (xml.match(/<feed[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1];
    const feedSubtitle = (xml.match(/<feed[^>]*>[\s\S]*?<subtitle[^>]*>([\s\S]*?)<\/subtitle>/i) || [, ""])[1];
    const feedLink = (xml.match(/<feed[^>]*>[\s\S]*?<link[^>]*href\s*=\s*"([^"]+)"[^>]*\/?>/i) || [, ""])[1];
    const updated = (xml.match(/<feed[^>]*>[\s\S]*?<updated[^>]*>([\s\S]*?)<\/updated>/i) || [, ""])[1];

    out.push(`Format:    Atom 1.0`);
    out.push(`Title:     ${decodeEntities(feedTitle)}`);
    out.push(`Subtitle:  ${decodeEntities(feedSubtitle) || "—"}`);
    out.push(`Home:      ${feedLink}`);
    out.push(`Updated:   ${updated}`);
    out.push("");

    const itemRe = /<entry\b([\s\S]*?)<\/entry>/gi;
    let m;
    let count = 0;
    while ((m = itemRe.exec(xml)) !== null) {
      if (count >= max_items) break;
      const body = m[1];
      const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1];
      const linkMatch = body.match(/<link[^>]*href\s*=\s*"([^"]+)"[^>]*\/?>/i);
      const link = linkMatch ? linkMatch[1] : "";
      const updated = (body.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [, ""])[1];
      const published = (body.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [, ""])[1];
      const author = (body.match(/<author[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i) || [, ""])[1];
      const id = (body.match(/<id[^>]*>([\s\S]*?)<\/id>/i) || [, ""])[1];
      const summary = (body.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [, ""])[1];
      const content = (body.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [, ""])[1];

      out.push(`--- Entry ${++count} ---`);
      out.push(`Title:     ${decodeEntities(title)}`);
      out.push(`Link:      ${link}`);
      out.push(`Published: ${published || "—"}`);
      out.push(`Updated:   ${updated || "—"}`);
      if (author) out.push(`Author:    ${decodeEntities(author)}`);
      if (id) out.push(`ID:        ${id}`);
      if (include_content) {
        const txt = summary || content;
        if (txt) out.push(`Content:   ${htmlToText(txt).slice(0, 1000)}`);
      }
      out.push("");
    }
    if (count === 0) out.push("(No entries found)");
  } else if (isRss) {
    // RSS 2.0
    const channelTitle = (xml.match(/<channel[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1];
    const channelDesc = (xml.match(/<channel[\s\S]*?<description[^>]*>([\s\S]*?)<\/description>/i) || [, ""])[1];
    const channelLink = (xml.match(/<channel[\s\S]*?<link[^>]*>([\s\S]*?)<\/link>/i) || [, ""])[1];

    out.push(`Format:    RSS`);
    out.push(`Title:     ${decodeEntities(channelTitle)}`);
    out.push(`Link:      ${decodeEntities(channelLink)}`);
    out.push(`Subtitle:  ${decodeEntities(channelDesc) || "—"}`);
    out.push("");

    const itemRe = /<item\b([\s\S]*?)<\/item>/gi;
    let m;
    let count = 0;
    while ((m = itemRe.exec(xml)) !== null) {
      if (count >= max_items) break;
      const body = m[1];
      const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1];
      const link = (body.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [, ""])[1];
      const pubDate = (body.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [, ""])[1];
      const author = (body.match(/<author[^>]*>([\s\S]*?)<\/author>/i) || [, ""])[1]
        || (body.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [, ""])[1];
      const guid = (body.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || [, ""])[1];
      const category = (body.match(/<category[^>]*>([\s\S]*?)<\/category>/i) || [, ""])[1];
      const desc = (body.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [, ""])[1];
      const content = (body.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) || [, ""])[1];

      out.push(`--- Item ${++count} ---`);
      out.push(`Title:     ${decodeEntities(title)}`);
      out.push(`Link:      ${decodeEntities(link)}`);
      out.push(`PubDate:   ${pubDate || "—"}`);
      if (author) out.push(`Author:    ${decodeEntities(author)}`);
      if (category) out.push(`Category:  ${decodeEntities(category)}`);
      if (guid) out.push(`GUID:      ${guid}`);
      if (include_content) {
        const txt = content || desc;
        if (txt) out.push(`Content:   ${htmlToText(txt).slice(0, 1000)}`);
      }
      out.push("");
    }
    if (count === 0) out.push("(No items found)");
  } else {
    out.push("ERROR: Not a recognized RSS/Atom feed (no <rss>, <channel>, or <feed> root element).");
  }

  return truncate(out.join("\n"));
}

// ===========================================================================
// 9. web_sitemap — Parse XML sitemaps (urlset + sitemap index)
// ===========================================================================
export async function webSitemap({
  url,
  max_urls = 100,
  follow_sitemap_index = true,
  max_submaps = 5,
  timeout_ms = 20000,
} = {}) {
  if (!url) return "ERROR: 'url' is required.";

  const r = await safeFetch(url, { timeout_ms, headers: { Accept: "application/xml, text/xml" } });
  if (!r.ok && r.status !== 0) return `ERROR web_sitemap: HTTP ${r.status} ${r.statusText}`;
  if (r.error) return `ERROR web_sitemap: ${r.error}`;

  const xml = r.text;
  const out = [`=== Sitemap: ${url} ===`];
  out.push(`HTTP ${r.status} | ${r.bytes.toLocaleString()} bytes | ${r.contentType}`);
  out.push("");

  const isIndex = /<sitemapindex\b/i.test(xml);
  const isUrlset = /<urlset\b/i.test(xml);

  if (!isIndex && !isUrlset) {
    return out.join("\n") + "\nERROR: Not a valid sitemap (no <sitemapindex> or <urlset> root).";
  }

  if (isIndex) {
    // Sitemap index
    out.push(`Format: Sitemap Index`);
    out.push("");
    const subRe = /<sitemap\b([\s\S]*?)<\/sitemap>/gi;
    let m;
    const subs = [];
    while ((m = subRe.exec(xml)) !== null) {
      const body = m[1];
      const loc = (body.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i) || [, ""])[1];
      const lastmod = (body.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i) || [, ""])[1];
      if (loc) subs.push({ loc: decodeEntities(loc).trim(), lastmod });
    }
    out.push(`Sub-sitemaps found: ${subs.length}`);
    subs.slice(0, max_submaps).forEach((s, i) => {
      out.push(`  ${i + 1}. ${s.loc}${s.lastmod ? `  (lastmod: ${s.lastmod})` : ""}`);
    });
    if (subs.length > max_submaps) out.push(`  ... and ${subs.length - max_submaps} more`);
    out.push("");

    if (follow_sitemap_index) {
      out.push("--- Fetched sub-sitemap contents ---");
      let totalUrls = 0;
      for (const sub of subs.slice(0, max_submaps)) {
        const subRes = await safeFetch(sub.loc, { timeout_ms, headers: { Accept: "application/xml, text/xml" } });
        if (!subRes.ok) {
          out.push(`  [skip] ${sub.loc} — HTTP ${subRes.status}`);
          continue;
        }
        const subUrls = parseUrlset(subRes.text);
        out.push(`\n  ▼ ${sub.loc} (${subUrls.length} URLs)`);
        subUrls.slice(0, Math.max(0, max_urls - totalUrls)).forEach((u) => {
          out.push(`    ${u.loc}${u.lastmod ? `  [${u.lastmod}]` : ""}`);
        });
        totalUrls += subUrls.length;
        if (totalUrls >= max_urls) break;
      }
      out.push(`\nTotal URLs enumerated: ${totalUrls}${totalUrls >= max_urls ? " (capped)" : ""}`);
    }
  } else {
    // urlset
    const urls = parseUrlset(xml);
    out.push(`Format: URL Set`);
    out.push(`URLs found: ${urls.length}`);
    out.push("");
    urls.slice(0, max_urls).forEach((u) => {
      out.push(`  ${u.loc}${u.lastmod ? `  [${u.lastmod}]` : ""}${u.changefreq ? `  cf=${u.changefreq}` : ""}${u.priority ? `  p=${u.priority}` : ""}`);
    });
    if (urls.length > max_urls) out.push(`\n  ... and ${urls.length - max_urls} more`);
  }

  return truncate(out.join("\n"));
}

function parseUrlset(xml) {
  const urls = [];
  const re = /<url\b([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const loc = (body.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i) || [, ""])[1];
    const lastmod = (body.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i) || [, ""])[1];
    const changefreq = (body.match(/<changefreq[^>]*>([\s\S]*?)<\/changefreq>/i) || [, ""])[1];
    const priority = (body.match(/<priority[^>]*>([\s\S]*?)<\/priority>/i) || [, ""])[1];
    if (loc) urls.push({
      loc: decodeEntities(loc).trim(),
      lastmod: lastmod.trim() || null,
      changefreq: changefreq.trim() || null,
      priority: priority.trim() || null,
    });
  }
  return urls;
}
