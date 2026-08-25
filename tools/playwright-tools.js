/**
 * Playwright Wrapper Tools
 * ========================
 * Provides real headless-browser capabilities for Fixy:
 *   1. playwright_screenshot  — true PNG screenshot of a rendered page
 *   2. playwright_render      — render a page and extract structured data
 *   3. playwright_evaluate    — run arbitrary JS in a real browser context
 *   4. playwright_links       — follow all in-page links and capture their state
 *
 * Notes:
 *   - Uses playwright-core (no bundled browsers). Requires an installed Chromium,
 *     Chrome, Edge, or a system `executablePath` to be configured via env var
 *     PW_BROWSER_PATH, or the user can install browsers with:
 *         npx playwright install chromium
 *   - All tools gracefully fall back to a "browser unavailable" message when
 *     no browser binary can be located.
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const PW_BROWSER_PATH = process.env.PW_BROWSER_PATH || null;
const PW_TIMEOUT = parseInt(process.env.PW_TIMEOUT_MS || '30000', 10);
const VIEWPORT = { width: 1280, height: 800 };

/* ------------------------------------------------------------------ */
/*  Internal: locate a usable browser binary                           */
/* ------------------------------------------------------------------ */

async function resolveBrowser() {
  // 1. Explicit env var wins
  if (PW_BROWSER_PATH && fs.existsSync(PW_BROWSER_PATH)) {
    return { executablePath: PW_BROWSER_PATH, source: 'env:PW_BROWSER_PATH' };
  }

  // 2. Common system paths (Termux / Linux / macOS / Windows)
  const candidates = [
    // Termux / Linux
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { executablePath: p, source: p };
    } catch (_) {}
  }

  // 3. Last resort: playwright-core's auto-resolve (may fail if no browser)
  return { executablePath: undefined, source: 'auto' };
}

/* ------------------------------------------------------------------ */
/*  Internal: shared launch helper                                    */
/* ------------------------------------------------------------------ */

async function withPage(url, fn, { waitUntil = 'domcontentloaded', timeoutMs } = {}) {
  const browserInfo = await resolveBrowser();
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (browserInfo.executablePath) launchOpts.executablePath = browserInfo.executablePath;

  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (err) {
    return {
      ok: false,
      browser_source: browserInfo.source,
      error: `Failed to launch Chromium: ${err.message}`,
      hint:
        'Install browsers with `npx playwright install chromium` OR set PW_BROWSER_PATH ' +
        'to an existing Chrome/Edge/Chromium binary.',
    };
  }

  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil, timeout: timeoutMs || PW_TIMEOUT });
    const result = await fn(page);
    await ctx.close();
    return { ok: true, browser_source: browserInfo.source, ...result };
  } catch (err) {
    return { ok: false, browser_source: browserInfo.source, error: err.message };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

/* ------------------------------------------------------------------ */
/*  Tool 1: playwright_screenshot                                    */
/* ------------------------------------------------------------------ */

async function playwright_screenshot({ url, output_path, full_page = true, selector = null }) {
  if (!url) return { ok: false, error: 'url is required' };

  const outPath =
    output_path ||
    path.join(process.cwd(), `screenshot-${Date.now()}.png`);

  const result = await withPage(
    url,
    async (page) => {
      if (selector) {
        const el = await page.$(selector);
        if (!el) return { error: `Selector not found: ${selector}`, path: outPath };
        await el.screenshot({ path: outPath });
      } else {
        await page.screenshot({ path: outPath, fullPage: full_page });
      }
      const stat = fs.statSync(outPath);
      return { path: outPath, bytes: stat.size };
    }
  );

  return result;
}

/* ------------------------------------------------------------------ */
/*  Tool 2: playwright_render                                         */
/* ------------------------------------------------------------------ */

async function playwright_render({ url, selector, timeout_ms }) {
  if (!url) return { ok: false, error: 'url is required' };

  return withPage(
    url,
    async (page) => {
      const title = await page.title();
      const text = await page.evaluate(() => document.body.innerText.slice(0, 8000));
      const html = await page.content();
      const data = {
        title,
        text_length: text.length,
        text_preview: text.slice(0, 1200),
        html_size_bytes: html.length,
      };
      if (selector) {
        const el = await page.$(selector);
        data.selector_found = !!el;
        if (el) {
          data.selector_text = (await el.innerText()).slice(0, 2000);
          data.selector_html_size = (await el.innerHTML()).length;
        }
      }
      return data;
    },
    { timeoutMs: timeout_ms }
  );
}

/* ------------------------------------------------------------------ */
/*  Tool 3: playwright_evaluate                                       */
/* ------------------------------------------------------------------ */

async function playwright_evaluate({ url, expression, timeout_ms }) {
  if (!url) return { ok: false, error: 'url is required' };
  if (!expression) return { ok: false, error: 'expression is required' };

  return withPage(
    url,
    async (page) => {
      const value = await page.evaluate((expr) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function('return (' + expr + ');');
        return fn();
      }, expression);
      return { value, expression };
    },
    { timeoutMs: timeout_ms }
  );
}

/* ------------------------------------------------------------------ */
/*  Tool 4: playwright_links                                          */
/* ------------------------------------------------------------------ */

async function playwright_links({ url, filter_pattern = '', max_links = 50 }) {
  if (!url) return { ok: false, error: 'url is required' };

  return withPage(
    url,
    async (page) => {
      const origin = new URL(url).origin;
      const links = await page.$$eval('a[href]', (anchors) =>
        anchors.map((a) => ({
          href: a.href,
          text: (a.innerText || '').trim().slice(0, 120),
        }))
      );

      const rx = filter_pattern ? new RegExp(filter_pattern) : null;
      const filtered = links
        .filter((l) => l.href && (!rx || rx.test(l.href) || rx.test(l.text)))
        .slice(0, max_links);

      return {
        total_anchors: links.length,
        returned: filtered.length,
        links: filtered,
        origin,
      };
    }
  );
}

/* ------------------------------------------------------------------ */
/*  Export                                                            */
/* ------------------------------------------------------------------ */

module.exports = {
  playwright_screenshot,
  playwright_render,
  playwright_evaluate,
  playwright_links,
};
