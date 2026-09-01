import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatMessagesForOpenRouter,
  resolveAvailableModel,
  listModels,
  chatStream,
  chat,
} from "../src/openrouter.js";

describe("OpenRouter Provider (Live Free Models Only)", () => {
  test("listModels dynamically fetches and filters only free models from OpenRouter API", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", pricing: { prompt: "0.000003", completion: "0.000015" } },
            { id: "openai/gpt-4o", name: "GPT-4o", pricing: { prompt: "0.000005", completion: "0.000015" } },
            { id: "openrouter/free", name: "Free Models Router", pricing: { prompt: "0", completion: "0" } },
            { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", pricing: { prompt: "0", completion: "0" } },
            { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5", pricing: { prompt: "0", completion: "0" } },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    };

    try {
      const models = await listModels({ forceRefresh: true });
      assert.equal(models.length, 3);
      assert.ok(models.some((m) => m.id === "openrouter/free"));
      assert.ok(models.some((m) => m.id === "google/gemma-4-31b-it:free"));
      assert.ok(models.some((m) => m.id === "nvidia/nemotron-3.5-lightning:free"));
      // Ensure paid models are never included
      assert.ok(!models.some((m) => m.id.includes("claude")));
      assert.ok(!models.some((m) => m.id.includes("gpt-4o")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolveAvailableModel dynamically matches live free models", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openrouter/free", name: "Free Models Router" },
            { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    };

    try {
      const gemma = await resolveAvailableModel("gemma-4-31b-it");
      assert.equal(gemma, "google/gemma-4-31b-it:free");

      const defaultFree = await resolveAvailableModel();
      assert.ok(defaultFree === "openrouter/free" || defaultFree.includes(":free"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("formatMessagesForOpenRouter formats messages correctly", () => {
    const raw = [
      { role: "system", content: "You are Fixy" },
      { role: "user", content: "read file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: { path: "package.json" },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_name: "read_file",
        content: '{"name": "fixy-agent"}',
      },
    ];

    const formatted = formatMessagesForOpenRouter(raw);
    assert.equal(formatted.length, 4);
    assert.equal(formatted[0].role, "system");
    assert.equal(formatted[1].role, "user");
    assert.equal(formatted[2].role, "assistant");
    assert.equal(formatted[2].tool_calls[0].id, "call_1");
    assert.equal(typeof formatted[2].tool_calls[0].function.arguments, "string");
    assert.equal(formatted[3].role, "tool");
    assert.equal(formatted[3].tool_call_id, "call_1");
  });

  test("chatStream accumulates SSE stream chunks, reasoning and tool calls", async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"reasoning":"Analyzing request..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Let me check"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"read_file","arguments":"{\\"path\\": "}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.js\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const mockBody = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(mockBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    try {
      let thinkingTokens = "";
      let contentTokens = "";

      const res = await chatStream({
        model: "openrouter/free",
        messages: [{ role: "user", content: "read test.js" }],
        apiKey: "sk-or-test-key",
        onThinking: (t) => { thinkingTokens += t; },
        onContent: (t) => { contentTokens += t; },
      });

      assert.equal(thinkingTokens, "Analyzing request...");
      assert.equal(contentTokens, "Let me check");
      assert.ok(res.tool_calls);
      assert.equal(res.tool_calls.length, 1);
      assert.equal(res.tool_calls[0].function.name, "read_file");
      assert.deepEqual(res.tool_calls[0].function.arguments, { path: "test.js" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("chat handles error response with clear message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Invalid API key provided" } }), {
        status: 401,
      });
    };

    try {
      await assert.rejects(
        async () => {
          await chat({
            model: "openrouter/free",
            messages: [{ role: "user", content: "hi" }],
            apiKey: "bad-key",
          });
        },
        /OpenRouter authentication failed \(401\)/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
