import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import EventEmitter from "node:events";

const GLOBAL_MCP_FILE = path.join(os.homedir(), ".fixy", "mcp.json");

/**
 * Manages Model Context Protocol (MCP) servers and dynamic tool dispatch.
 */
class MCPManager extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map(); // name -> { process, config, status, tools: [] }
    this.pendingRequests = new Map(); // `${serverName}:${id}` -> { resolve, reject, timeout }
    this.nextRequestId = 1;
  }

  /**
   * Load MCP configuration from ~/.fixy/mcp.json and .fixy/mcp.json.
   */
  async loadConfig(cwd = process.cwd()) {
    const configs = { mcpServers: {} };

    // 1. Global config
    try {
      const raw = await fs.readFile(GLOBAL_MCP_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.mcpServers) {
        Object.assign(configs.mcpServers, parsed.mcpServers);
      }
    } catch {}

    // 2. Project config
    const projectMcp = path.resolve(cwd, ".fixy", "mcp.json");
    try {
      const raw = await fs.readFile(projectMcp, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.mcpServers) {
        Object.assign(configs.mcpServers, parsed.mcpServers);
      }
    } catch {}

    return configs;
  }

  /**
   * Initialize and connect to all enabled MCP servers.
   */
  async initialize(cwd = process.cwd()) {
    const config = await this.loadConfig(cwd);
    const serverEntries = Object.entries(config.mcpServers || {});

    for (const [name, serverConfig] of serverEntries) {
      if (serverConfig && !serverConfig.disabled) {
        await this.connectServer(name, serverConfig, cwd).catch((err) => {
          // Keep resilience if one MCP server fails to launch
          console.error(`[mcp] Warning: Failed to connect to server "${name}": ${err.message}`);
        });
      }
    }
  }

  /**
   * Connect to a single MCP server over stdio JSON-RPC.
   */
  async connectServer(name, config, cwd = process.cwd()) {
    if (this.servers.has(name)) {
      this.disconnectServer(name);
    }

    if (!config.command) {
      throw new Error(`MCP server "${name}" is missing a "command" property.`);
    }

    const env = { ...process.env, ...(config.env || {}) };
    const child = spawn(config.command, config.args || [], {
      cwd: config.cwd ? path.resolve(cwd, config.cwd) : cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const serverEntry = {
      name,
      config,
      process: child,
      status: "connecting",
      tools: [],
      buffer: "",
    };
    this.servers.set(name, serverEntry);

    child.stdout.on("data", (chunk) => {
      this.handleServerData(serverEntry, chunk);
    });

    child.stderr.on("data", (chunk) => {
      const errText = chunk.toString().trim();
      if (errText) {
        this.emit("server:log", { name, type: "stderr", text: errText });
      }
    });

    child.on("error", (err) => {
      serverEntry.status = "error";
      serverEntry.error = err.message;
      this.emit("server:error", { name, error: err });
    });

    child.on("exit", (code) => {
      serverEntry.status = "stopped";
      this.emit("server:exit", { name, code });
    });

    // 1. Send initialize request
    const initRes = await this.sendRequest(name, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "fixy-agent",
        version: "2.0.0",
      },
    });

    // 2. Send initialized notification
    this.sendNotification(name, "notifications/initialized", {});

    // 3. Query available tools
    serverEntry.status = "connected";
    const toolsRes = await this.sendRequest(name, "tools/list", {}).catch(() => ({ tools: [] }));
    if (Array.isArray(toolsRes?.tools)) {
      serverEntry.tools = toolsRes.tools;
    }

    return serverEntry;
  }

  /**
   * Process incoming stdio JSON-RPC lines.
   */
  handleServerData(serverEntry, chunk) {
    serverEntry.buffer += chunk.toString("utf-8");
    let newlineIdx;

    while ((newlineIdx = serverEntry.buffer.indexOf("\n")) >= 0) {
      const line = serverEntry.buffer.slice(0, newlineIdx).trim();
      serverEntry.buffer = serverEntry.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Line might be part of header or partial JSON
        continue;
      }

      if (msg.id !== undefined) {
        const key = `${serverEntry.name}:${msg.id}`;
        const pending = this.pendingRequests.get(key);
        if (pending) {
          this.pendingRequests.delete(key);
          clearTimeout(pending.timeout);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || `MCP Error ${msg.error.code}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    }
  }

  /**
   * Send a JSON-RPC request to a specific server.
   */
  sendRequest(serverName, method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const server = this.servers.get(serverName);
      if (!server || server.status === "stopped") {
        return reject(new Error(`MCP server "${serverName}" is not running.`));
      }

      const id = this.nextRequestId++;
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }) + "\n";

      const timer = setTimeout(() => {
        const key = `${serverName}:${id}`;
        this.pendingRequests.delete(key);
        reject(new Error(`MCP request "${method}" to server "${serverName}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingRequests.set(`${serverName}:${id}`, { resolve, reject, timeout: timer });
      server.process.stdin.write(payload);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  sendNotification(serverName, method, params = {}) {
    const server = this.servers.get(serverName);
    if (!server || server.status === "stopped") return;

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }) + "\n";

    server.process.stdin.write(payload);
  }

  /**
   * Disconnect a specific MCP server.
   */
  disconnectServer(name) {
    const server = this.servers.get(name);
    if (server) {
      try {
        server.process.kill("SIGTERM");
      } catch {}
      this.servers.delete(name);
    }
  }

  /**
   * Disconnect and clean up all running MCP servers.
   */
  stopAll() {
    for (const [name, server] of this.servers.entries()) {
      try {
        server.process.kill("SIGTERM");
      } catch {}
    }
    this.servers.clear();
  }

  /**
   * Export discovered MCP tools formatted into standard Fixy TOOL_DEFS format.
   */
  getToolDefinitions() {
    const toolDefs = [];

    for (const [serverName, server] of this.servers.entries()) {
      if (server.status !== "connected") continue;

      for (const t of server.tools) {
        const qualifiedName = `mcp__${serverName}__${t.name}`;
        toolDefs.push({
          type: "function",
          function: {
            name: qualifiedName,
            description: `[MCP Server: ${serverName}] ${t.description || t.name}`,
            parameters: t.inputSchema || {
              type: "object",
              properties: {},
            },
          },
          mcp: {
            serverName,
            originalName: t.name,
          },
        });
      }
    }

    return toolDefs;
  }

  /**
   * Execute an MCP tool by qualified name (mcp__server__toolName).
   */
  async executeTool(qualifiedName, args) {
    const match = qualifiedName.match(/^mcp__([a-zA-Z0-9_-]+)__(.+)$/);
    if (!match) {
      throw new Error(`Invalid MCP tool format: "${qualifiedName}"`);
    }

    const [, serverName, originalName] = match;
    const res = await this.sendRequest(serverName, "tools/call", {
      name: originalName,
      arguments: args || {},
    });

    if (Array.isArray(res?.content)) {
      const textParts = res.content
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      if (textParts.length > 0) return textParts.join("\n");
      return JSON.stringify(res.content, null, 2);
    }

    return typeof res === "string" ? res : JSON.stringify(res, null, 2);
  }

  /**
   * Check if a tool name belongs to MCP.
   */
  isMCPTool(name) {
    return typeof name === "string" && name.startsWith("mcp__");
  }

  /**
   * Get formatted status of all MCP servers for UI / command matrix.
   */
  getStatus() {
    const list = [];
    for (const [name, server] of this.servers.entries()) {
      list.push({
        name,
        status: server.status,
        command: `${server.config.command} ${(server.config.args || []).join(" ")}`,
        toolsCount: server.tools.length,
        tools: server.tools.map((t) => t.name),
      });
    }
    return list;
  }
}

export { MCPManager };
export const mcpManager = new MCPManager();
