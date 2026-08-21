import { spawn } from "node:child_process";
import EventEmitter from "node:events";

/**
 * Background Task Manager
 * Allows running multiple persistent or long-running commands in the background,
 * inspecting logs, sending stdin, and notifying the agent/user when commands finish.
 */
class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.nextId = 1;
    this.notificationQueue = [];
  }

  /**
   * Start a new task in the background or foreground.
   * @param {Object} opts
   * @param {string} opts.command
   * @param {string} [opts.cwd]
   * @param {boolean} [opts.background=true]
   * @param {number} [opts.timeoutMs=0]
   * @returns {Object} task object
   */
  startTask({ command, cwd = process.cwd(), background = true, timeoutMs = 0 }) {
    const id = `task-${this.nextId++}`;
    const startTime = new Date();

    const proc = spawn(command, {
      shell: true,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PAGER: "cat" },
    });

    const task = {
      id,
      command,
      cwd,
      pid: proc.pid,
      startTime,
      endTime: null,
      status: "running", // 'running' | 'completed' | 'failed' | 'killed' | 'timed_out'
      exitCode: null,
      signal: null,
      logs: [],
      maxLogs: 500,
      background,
      proc,
    };

    const appendLog = (type, data) => {
      const text = data.toString();
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.length === 0) continue;
        task.logs.push({
          type,
          text: line,
          timestamp: new Date(),
        });
        if (task.logs.length > task.maxLogs) {
          task.logs.shift();
        }
      }
      this.emit("task:output", { taskId: id, type, text });
    };

    proc.stdout.on("data", (data) => appendLog("stdout", data));
    proc.stderr.on("data", (data) => appendLog("stderr", data));

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (task.status === "running") {
          task.status = "timed_out";
          proc.kill("SIGTERM");
        }
      }, timeoutMs);
    }

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      task.status = "failed";
      task.endTime = new Date();
      task.error = err.message;
      const notif = `[Background Task ${id}] Failed to start: ${err.message}`;
      this.notificationQueue.push(notif);
      this.emit("task:done", { task, error: err });
    });

    proc.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      task.endTime = new Date();
      task.exitCode = code;
      task.signal = signal;
      if (task.status === "running") {
        task.status = code === 0 ? "completed" : "failed";
      }

      const durationSec = Math.round((task.endTime - task.startTime) / 1000);
      const summary = `[Background Task ${id} (${command.slice(0, 30)}${command.length > 30 ? "…" : ""})] finished with status '${task.status}' (code ${code}) in ${durationSec}s.`;
      this.notificationQueue.push(summary);
      this.emit("task:done", { task, code, signal });
    });

    this.tasks.set(id, task);
    return task;
  }

  /**
   * Get all tasks summary
   */
  listTasks() {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      command: t.command,
      pid: t.pid,
      status: t.status,
      startTime: t.startTime.toISOString(),
      duration: t.endTime
        ? `${Math.round((t.endTime - t.startTime) / 1000)}s`
        : `${Math.round((Date.now() - t.startTime.getTime()) / 1000)}s (running)`,
      exitCode: t.exitCode,
      logCount: t.logs.length,
    }));
  }

  /**
   * Get specific task details and logs
   */
  getTask(id) {
    return this.tasks.get(id) || null;
  }

  /**
   * Get log snippet
   */
  getLogs(id, tailCount = 50) {
    const task = this.tasks.get(id);
    if (!task) return `Task "${id}" not found.`;
    const slice = task.logs.slice(-tailCount);
    return slice
      .map((l) => `[${l.type}] ${l.text}`)
      .join("\n") || "(no logs yet)";
  }

  /**
   * Send input to task stdin
   */
  sendInput(id, input) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found.`);
    if (task.status !== "running") throw new Error(`Task "${id}" is not running (status: ${task.status}).`);
    task.proc.stdin.write(input.endsWith("\n") ? input : input + "\n");
    return `Sent input to task ${id}`;
  }

  /**
   * Kill running task
   */
  killTask(id, signal = "SIGTERM") {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found.`);
    if (task.status !== "running") return `Task ${id} is already ${task.status}.`;
    task.status = "killed";
    task.proc.kill(signal);
    return `Sent ${signal} to task ${id}`;
  }

  /**
   * Drain pending completion notifications
   */
  drainNotifications() {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }

  /**
   * Count running background tasks
   */
  runningCount() {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === "running") count++;
    }
    return count;
  }
}

export const taskManager = new TaskManager();
