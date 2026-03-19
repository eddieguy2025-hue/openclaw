/**
 * Mobile-friendly HTTP + SSE server for the Termux / Android extension.
 *
 * Serves a single-page chat UI optimised for small screens (dark theme,
 * large tap targets, responsive layout).  Replies stream via SSE so the
 * user sees tokens as they arrive.
 *
 * No framework dependencies — only Node built-ins + the local MobileAgent.
 */

import http from "node:http";
import { URL } from "node:url";
import { MobileAgent, type MobileAgentConfig } from "./agent.js";
import type { WebUiConfig, SseEvent } from "./types.js";

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

const HTML_TEMPLATE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#1a1a2e">
<title>__TITLE__</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #1a1a2e; --surface: #16213e; --accent: #0f3460;
    --text: #e2e2e2; --muted: #8899aa; --user-bg: #0f3460;
    --bot-bg: #1e2a3a; --radius: 12px; --gap: 12px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); }
  body { display: flex; flex-direction: column; height: 100dvh; }
  header {
    background: var(--accent); padding: 14px 16px;
    font-size: 1.1rem; font-weight: 600; letter-spacing: 0.02em;
    display: flex; align-items: center; gap: 10px;
  }
  header span.dot { width: 10px; height: 10px; border-radius: 50%; background: #4ecca3; flex-shrink: 0; }
  #chat {
    flex: 1; overflow-y: auto; padding: var(--gap);
    display: flex; flex-direction: column; gap: var(--gap);
    scroll-behavior: smooth;
  }
  .bubble {
    max-width: 88%; padding: 10px 14px; border-radius: var(--radius);
    line-height: 1.5; font-size: 0.95rem; white-space: pre-wrap; word-break: break-word;
  }
  .bubble.user { background: var(--user-bg); align-self: flex-end; border-bottom-right-radius: 4px; }
  .bubble.bot  { background: var(--bot-bg);  align-self: flex-start; border-bottom-left-radius: 4px; }
  .bubble.bot.streaming { opacity: 0.85; }
  .bubble.error { background: #3a1a1a; color: #ff8888; }
  .meta { font-size: 0.72rem; color: var(--muted); margin-top: 4px; }
  footer {
    background: var(--surface); padding: 10px 12px;
    border-top: 1px solid var(--accent); display: flex; gap: 8px; align-items: flex-end;
  }
  textarea {
    flex: 1; resize: none; background: var(--accent); color: var(--text);
    border: none; border-radius: var(--radius); padding: 10px 12px;
    font-family: var(--font); font-size: 1rem; line-height: 1.4;
    max-height: 120px; outline: none;
  }
  button#send {
    background: #4ecca3; color: #111; border: none;
    border-radius: var(--radius); padding: 10px 18px; font-size: 1rem;
    font-weight: 700; cursor: pointer; white-space: nowrap;
    touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  }
  button#send:disabled { opacity: 0.4; }
  button#reset {
    background: none; color: var(--muted); border: none;
    font-size: 0.8rem; cursor: pointer; padding: 4px 8px;
    touch-action: manipulation;
  }
  .tool-info { font-size: 0.78rem; color: #7bb8d4; margin-top: 4px; font-style: italic; }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f0f4f8; --surface: #ffffff; --accent: #2d6a9f;
      --text: #1a1a2e; --muted: #6677aa; --user-bg: #2d6a9f;
      --bot-bg: #e8eef4; --font: inherit;
    }
    button#send { background: #2d6a9f; color: #fff; }
    textarea { background: #dce8f4; color: #1a1a2e; }
  }
</style>
</head>
<body>
<header><span class="dot"></span>__TITLE__</header>
<div id="chat"></div>
<footer>
  <div style="display:flex;flex-direction:column;flex:1;gap:4px">
    <textarea id="input" rows="2" placeholder="Type a message…" autofocus></textarea>
    <div style="display:flex;justify-content:flex-end"><button id="reset">Clear chat</button></div>
  </div>
  <button id="send">Send</button>
</footer>
<script>
(function () {
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const resetBtn = document.getElementById('reset');
  let streaming = false;

  function scrollBottom() { chat.scrollTop = chat.scrollHeight; }

  function addBubble(role, text, extra) {
    const div = document.createElement('div');
    div.className = 'bubble ' + role + (extra?.streaming ? ' streaming' : '');
    div.textContent = text;
    if (extra?.id) div.id = extra.id;
    chat.appendChild(div);
    scrollBottom();
    return div;
  }

  function setDisabled(v) {
    input.disabled = v;
    sendBtn.disabled = v;
    streaming = v;
  }

  async function send() {
    const msg = input.value.trim();
    if (!msg || streaming) return;
    input.value = '';
    addBubble('user', msg);
    setDisabled(true);

    const botId = 'bot-' + Date.now();
    const botDiv = addBubble('bot', '…', { id: botId, streaming: true });

    try {
      const keyParam = __API_KEY__ ? '?key=' + encodeURIComponent(__API_KEY__) : '';
      const sep = keyParam ? '&' : '?';
      const es = new EventSource('/chat' + keyParam + sep + 'msg=' + encodeURIComponent(msg));
      let reply = '';

      es.addEventListener('token', (e) => {
        reply += e.data;
        botDiv.textContent = reply;
        botDiv.classList.add('streaming');
        scrollBottom();
      });

      es.addEventListener('tool', (e) => {
        const info = document.createElement('div');
        info.className = 'tool-info';
        info.textContent = '⚙ ' + e.data;
        botDiv.appendChild(info);
        scrollBottom();
      });

      es.addEventListener('done', () => {
        botDiv.classList.remove('streaming');
        if (!reply) botDiv.textContent = '(no reply)';
        es.close();
        setDisabled(false);
        input.focus();
      });

      es.addEventListener('error', (e) => {
        botDiv.classList.add('error');
        botDiv.textContent = 'Connection error';
        es.close();
        setDisabled(false);
      });

    } catch (err) {
      botDiv.classList.add('error');
      botDiv.textContent = String(err);
      setDisabled(false);
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  resetBtn.addEventListener('click', async () => {
    await fetch('/reset', { method: 'POST' });
    chat.innerHTML = '';
  });
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// WebUiServer
// ---------------------------------------------------------------------------

export class WebUiServer {
  private readonly config: Required<WebUiConfig>;
  private readonly agent: MobileAgent;
  private server: http.Server | null = null;

  constructor(uiConfig: WebUiConfig, agentConfig: MobileAgentConfig = {}) {
    this.config = {
      host: "0.0.0.0",
      title: "OpenClaw Mobile",
      apiKey: "",
      ...uiConfig,
    };
    this.agent = new MobileAgent(agentConfig);
  }

  /** Start listening. Resolves when the server is bound. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", reject);
      this.server.listen(this.config.port, this.config.host, () => resolve());
    });
  }

  /** Stop the server gracefully. */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        this.server = null;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /** The port the server is listening on (after start()). */
  get port(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.config.port;
  }

  // -------------------------------------------------------------------------
  // Request handler
  // -------------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const raw = req.url ?? "/";
    const parsed = new URL(raw, `http://${req.headers.host ?? "localhost"}`);

    // Authenticate when an API key is configured.
    if (this.config.apiKey) {
      const key =
        parsed.searchParams.get("key") ??
        (req.headers.authorization?.startsWith("Bearer ")
          ? req.headers.authorization.slice(7)
          : null);
      if (key !== this.config.apiKey) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }
    }

    const pathname = parsed.pathname;

    if (pathname === "/" && req.method === "GET") {
      this.serveHtml(res);
    } else if (pathname === "/chat" && req.method === "GET") {
      const msg = parsed.searchParams.get("msg") ?? "";
      this.handleChatSse(msg, res);
    } else if (pathname === "/reset" && req.method === "POST") {
      this.agent.reset();
      res.writeHead(204);
      res.end();
    } else if (pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private serveHtml(res: http.ServerResponse): void {
    // Embed the API key reference (empty string when not configured) into the HTML.
    const safeKey = JSON.stringify(this.config.apiKey);
    const safeTitle = escapeHtml(this.config.title);
    const html = HTML_TEMPLATE.replace(/__TITLE__/g, safeTitle).replace("__API_KEY__", safeKey);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  }

  private handleChatSse(msg: string, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const send = (event: SseEvent) => {
      res.write(`event: ${event.type}\ndata: ${event.data}\n\n`);
    };

    const trimmed = msg.trim();
    if (!trimmed) {
      send({ type: "error", data: "Empty message" });
      send({ type: "done", data: "" });
      res.end();
      return;
    }

    this.agent
      .turn(trimmed)
      .then((result) => {
        // Emit tool calls so the client can surface them.
        for (const tc of result.toolCalls) {
          send({ type: "tool", data: `${tc.name}: ${tc.output.slice(0, 120)}` });
        }
        // Emit the reply as a single token for simplicity
        // (full streaming would require an SSE-capable backend).
        if (result.reply) {
          send({ type: "token", data: result.reply });
        }
        send({ type: "done", data: "" });
        res.end();
      })
      .catch((err: unknown) => {
        send({ type: "error", data: String(err) });
        send({ type: "done", data: "" });
        res.end();
      });
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
