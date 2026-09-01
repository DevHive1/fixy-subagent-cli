import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getActiveProvider,
  setActiveProvider,
  SUPPORTED_PROVIDERS,
  detectProviderForModel,
  resolveAvailableModel,
  getActiveModel,
  setActiveModel,
} from "../src/llm.js";

describe("Unified LLM Layer", () => {
  test("SUPPORTED_PROVIDERS includes ollama and openrouter", () => {
    assert.deepEqual(SUPPORTED_PROVIDERS, ["ollama", "openrouter"]);
  });

  test("setActiveProvider switches provider and validates input", async () => {
    await setActiveProvider("openrouter");
    assert.equal(getActiveProvider(), "openrouter");

    await setActiveProvider("ollama");
    assert.equal(getActiveProvider(), "ollama");

    await assert.rejects(async () => {
      await setActiveProvider("invalid_provider");
    }, /Unsupported provider/);
  });

  test("detectProviderForModel auto-detects OpenRouter model format", () => {
    assert.equal(detectProviderForModel("meta-llama/llama-3.3-70b-instruct:free"), "openrouter");
    assert.equal(detectProviderForModel("deepseek/deepseek-r1:free"), "openrouter");
    assert.equal(detectProviderForModel("qwen2.5-coder:7b"), null);
    assert.equal(detectProviderForModel("llama3"), null);
  });

  test("setActiveModel and getActiveModel manage models per provider", async () => {
    setActiveModel("meta-llama/llama-3.3-70b-instruct:free", "openrouter");
    assert.equal(getActiveModel("openrouter"), "meta-llama/llama-3.3-70b-instruct:free");

    setActiveModel("qwen2.5-coder:1.5b", "ollama");
    assert.equal(getActiveModel("ollama"), "qwen2.5-coder:1.5b");
  });

  test("resolveAvailableModel routes appropriately to free models", async () => {
    // Mock fetch so openrouter.listModels returns controlled data
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openrouter/free", name: "Free Models Router", pricing: { prompt: "0", completion: "0" } },
            { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B", pricing: { prompt: "0", completion: "0" } },
            { id: "deepseek/deepseek-chat:free", name: "DeepSeek V3", pricing: { prompt: "0", completion: "0" } },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    };

    try {
      const openrouterModel = await resolveAvailableModel("llama-3.3-70b", "openrouter");
      assert.equal(openrouterModel, "meta-llama/llama-3.3-70b-instruct:free");

      // Auto-detects openrouter from '/' in name
      const autoModel = await resolveAvailableModel("deepseek/deepseek-chat:free");
      assert.equal(autoModel, "deepseek/deepseek-chat:free");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
