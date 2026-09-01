import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  saveConfig,
  getOpenRouterApiKey,
  setOpenRouterApiKey,
  DEFAULT_PROVIDER,
  OPENROUTER_DEFAULT_MODEL,
} from "../src/config.js";

describe("Configuration & Secrets Persistence", () => {
  test("DEFAULT_PROVIDER and OPENROUTER_DEFAULT_MODEL defaults", () => {
    assert.ok(DEFAULT_PROVIDER === "ollama" || DEFAULT_PROVIDER === "openrouter");
    assert.ok(OPENROUTER_DEFAULT_MODEL === "openrouter/free" || OPENROUTER_DEFAULT_MODEL.endsWith(":free"));
  });

  test("saveConfig and loadConfig persist patches safely", async () => {
    await saveConfig({ testKey: "testValue123" });
    const config = await loadConfig();
    assert.equal(config.testKey, "testValue123");
  });

  test("setOpenRouterApiKey and getOpenRouterApiKey store and retrieve key", async () => {
    await setOpenRouterApiKey("sk-or-v1-my-secret-test-key");
    const key = getOpenRouterApiKey();
    assert.equal(key, "sk-or-v1-my-secret-test-key");
  });
});
