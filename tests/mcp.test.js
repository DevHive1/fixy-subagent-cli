import test from "node:test";
import assert from "node:assert/strict";
import { MCPManager } from "../src/mcp.js";

test("MCP (Model Context Protocol) Client Engine", async (t) => {
  await t.test("MCPManager initializes cleanly with no configs", async () => {
    const manager = new MCPManager();
    const status = manager.getStatus();
    assert.ok(Array.isArray(status));
    assert.strictEqual(manager.isMCPTool("mcp__github__create_issue"), true);
    assert.strictEqual(manager.isMCPTool("read_file"), false);
  });

  await t.test("MCPManager formats tools as OpenAI function definitions", () => {
    const manager = new MCPManager();
    manager.servers.set("test_server", {
      config: { command: "node" },
      status: "connected",
      tools: [
        {
          name: "calculate_sum",
          description: "Calculate sum of numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      ],
      client: null,
    });

    const defs = manager.getToolDefinitions();
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].function.name, "mcp__test_server__calculate_sum");
    assert.strictEqual(defs[0].function.description, "[MCP Server: test_server] Calculate sum of numbers");
  });

  await t.test("MCPManager gracefully rejects unconfigured server tool execution", async () => {
    const manager = new MCPManager();
    await assert.rejects(
      async () => {
        await manager.executeTool("mcp__nonexistent__foo", {});
      },
      /not running/
    );
  });
});
