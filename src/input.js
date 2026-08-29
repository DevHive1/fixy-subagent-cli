const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Raw-mode LineReader with bracketed paste mode and history navigation (Up/Down arrow keys).
 */
export class LineReader {
  constructor() {
    this.stdin = process.stdin;
    this.stdout = process.stdout;
    this._resolve = null;
    this._buffer = "";
    this._incoming = "";
    this._pasting = false;
    this._active = false;
    this.history = [];
    this.historyIndex = -1;
    this.savedBuffer = "";

    this.stdin.setEncoding("utf8");
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this._onDataHandler = (chunk) => this._onData(chunk);
    this.stdin.on("data", this._onDataHandler);
  }

  _onData(chunk) {
    if (!this._active) return;
    this._incoming += chunk;
    this._process();
  }

  _process() {
    while (this._incoming.length) {
      if (this._pasting) {
        const endIdx = this._incoming.indexOf(PASTE_END);
        if (endIdx === -1) {
          this._buffer += this._incoming;
          this.stdout.write(this._incoming);
          this._incoming = "";
          return;
        }
        const content = this._incoming.slice(0, endIdx);
        this._buffer += content;
        this.stdout.write(content);
        this._incoming = this._incoming.slice(endIdx + PASTE_END.length);
        this._pasting = false;
        continue;
      }

      const startIdx = this._incoming.indexOf(PASTE_START);
      if (startIdx !== -1) {
        const before = this._incoming.slice(0, startIdx);
        for (const ch of before) this._handleChar(ch);
        this._incoming = this._incoming.slice(startIdx + PASTE_START.length);
        this._pasting = true;
        continue;
      }

      // Check for arrow keys (ANSI escape sequences)
      if (this._incoming.startsWith("\x1b[A")) {
        // UP arrow
        this._incoming = this._incoming.slice(3);
        this._navigateHistory(-1);
        continue;
      }
      if (this._incoming.startsWith("\x1b[B")) {
        // DOWN arrow
        this._incoming = this._incoming.slice(3);
        this._navigateHistory(1);
        continue;
      }
      if (this._incoming.startsWith("\x1b[C") || this._incoming.startsWith("\x1b[D")) {
        // Left/Right arrow
        this._incoming = this._incoming.slice(3);
        continue;
      }

      const ch = this._incoming[0];
      this._incoming = this._incoming.slice(1);
      this._handleChar(ch);
      if (!this._active) return;
    }
  }

  _navigateHistory(direction) {
    if (this.history.length === 0) return;

    if (this.historyIndex === -1) {
      this.savedBuffer = this._buffer;
    }

    let nextIndex = this.historyIndex + (direction === -1 ? 1 : -1);
    // Clamp
    if (nextIndex < -1) nextIndex = -1;
    if (nextIndex >= this.history.length) nextIndex = this.history.length - 1;
    if (nextIndex === this.historyIndex) return;

    this.historyIndex = nextIndex;
    const targetText = this.historyIndex === -1 ? this.savedBuffer : this.history[this.history.length - 1 - this.historyIndex];

    // Clear current line buffer in terminal
    while (this._buffer.length > 0) {
      this.stdout.write("\b \b");
      this._buffer = this._buffer.slice(0, -1);
    }

    this._buffer = targetText;
    this.stdout.write(this._buffer);
  }

  _finish(value) {
    if (value && value.trim()) {
      this.history.push(value.trim());
      if (this.history.length > 200) this.history.shift();
    }
    this.historyIndex = -1;
    this.savedBuffer = "";
    this._buffer = "";
    this._active = false;
    this.stdout.write(`${ESC}[?2004l`);
    const r = this._resolve;
    this._resolve = null;
    r?.(value);
  }

  _handleChar(ch) {
    if (ch === "\r" || ch === "\n") {
      this.stdout.write("\n");
      const line = this._buffer;
      this._finish(line);
      return;
    }
    if (ch === "\x7f" || ch === "\b") {
      if (this._buffer.length) {
        const last = this._buffer[this._buffer.length - 1];
        this._buffer = this._buffer.slice(0, -1);
        this.stdout.write(last === "\n" ? "\n" : "\b \b");
      }
      return;
    }
    if (ch === "\x03") {
      this.stdout.write("^C\n");
      this._finish(null);
      return;
    }
    if (ch === "\x04") {
      if (!this._buffer) {
        this.stdout.write("\n");
        this._finish(undefined);
        return;
      }
      return;
    }
    this._buffer += ch;
    this.stdout.write(ch);
  }

  question(promptText) {
    return new Promise((resolve) => {
      this.stdout.write(promptText);
      this.stdout.write(`${ESC}[?2004h`);
      this._buffer = "";
      this._active = true;
      this._resolve = (v) => {
        try { this.stdout.write(`${ESC}[?2004l`); } catch {}
        resolve(v);
      };
    });
  }

  close() {
    try { this.stdout.write(`${ESC}[?2004l`); } catch {}
    try { this.stdin.off("data", this._onDataHandler); } catch {}
    try { if (this.stdin.isTTY) this.stdin.setRawMode(false); } catch {}
    try { this.stdin.pause(); } catch {}
  }
}
