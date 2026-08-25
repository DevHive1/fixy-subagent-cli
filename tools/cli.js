#!/usr/bin/env node
/**
 * CLI shim: invoke any playwright tool from the shell.
 *
 * Usage:
 *   node cli.js screenshot <url> [output.png]
 *   node cli.js render <url> [selector]
 *   node cli.js evaluate <url> <js-expression>
 *   node cli.js links <url> [regex-filter]
 *
 * Example:
 *   node cli.js screenshot https://example.com
 *   node cli.js render https://example.com h1
 *   node cli.js evaluate https://example.com "document.title"
 *   node cli.js links https://example.com '^https://'
 */

const tools = require('./playwright-tools');

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) {
    console.error('Usage: node cli.js <screenshot|render|evaluate|links> ...args');
    process.exit(2);
  }

  switch (cmd) {
    case 'screenshot': {
      const [url, output] = rest;
      const r = await tools.playwright_screenshot({ url, output_path: output });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'render': {
      const [url, selector] = rest;
      const r = await tools.playwright_render({ url, selector });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'evaluate': {
      const [url, expression] = rest;
      const r = await tools.playwright_evaluate({ url, expression });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'links': {
      const [url, filter_pattern] = rest;
      const r = await tools.playwright_links({ url, filter_pattern });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    default:
      console.error('Unknown command:', cmd);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
