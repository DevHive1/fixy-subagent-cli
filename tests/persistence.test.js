import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  saveSession,
  loadSession,
  listSessions,
  generateSessionId,
  clearSession,
} from "../src/persistence.js";

describe("Session Persistence & History Management", () => {
  const testId = "test_sess_" + generateSessionId();

  test("saveSession saves full session metadata and loadSession retrieves it", async () => {
    const history = [
      { role: "user", content: "hello fixy" },
      { role: "assistant", content: "hello! how can I help you today?" },
    ];
    const memory = { project: "water-app" };

    await saveSession({
      history,
      memory,
      sessionId: testId,
      model: "openrouter/free",
      provider: "openrouter",
    });

    const loaded = await loadSession(testId);
    assert.ok(loaded);
    assert.equal(loaded.sessionId, testId);
    assert.equal(loaded.model, "openrouter/free");
    assert.equal(loaded.provider, "openrouter");
    assert.equal(loaded.history.length, 2);
    assert.equal(loaded.history[0].content, "hello fixy");
    assert.equal(loaded.memory.project, "water-app");
  });

  test("loadSession supports prefix and .json extension", async () => {
    const loadedExact = await loadSession(`${testId}.json`);
    assert.ok(loadedExact);
    assert.equal(loadedExact.sessionId, testId);

    const prefix = testId.slice(0, 14);
    const loadedPrefix = await loadSession(prefix);
    assert.ok(loadedPrefix);
    assert.equal(loadedPrefix.sessionId, testId);
  });

  test("listSessions lists saved sessions with preview and message count", async () => {
    const sessions = await listSessions();
    assert.ok(Array.isArray(sessions));
    const found = sessions.find((s) => s.sessionId === testId);
    assert.ok(found, `Session ${testId} should be in listSessions`);
    assert.equal(found.messageCount, 2);
    assert.equal(found.preview, "hello fixy");
    assert.equal(found.provider, "openrouter");
  });

  test("clearSession removes the specific session", async () => {
    await clearSession(testId);
    const loaded = await loadSession(testId);
    assert.equal(loaded, null);
  });
});
