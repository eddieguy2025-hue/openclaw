/**
 * Scratch-built mobile agent for Termux / Android environments.
 *
 * Designed to run with minimal dependencies — no bundler needed.
 * Uses an OpenAI-compatible chat completion API (local Ollama, OpenAI, etc.)
 * and exposes a clean conversation + tool-call loop.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { AgentMessage, AgentTool, AgentTurnResult, ToolCallRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Post JSON to a URL and resolve with the parsed response body. */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const options = {
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(new Error(`Failed to parse response: ${String(err)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export type MobileAgentConfig = {
  /** OpenAI-compatible base URL. Default: http://localhost:11434/v1 (Ollama). */
  baseUrl?: string;
  /** Model identifier passed to the API. Default: "llama3". */
  model?: string;
  /** API key (omit for local/Ollama). */
  apiKey?: string;
  /** System prompt injected at the start of every conversation. */
  systemPrompt?: string;
  /** Maximum context window turns to keep (oldest are pruned). */
  maxTurns?: number;
  /** Tools available to the agent. */
  tools?: AgentTool[];
};

const DEFAULTS = {
  baseUrl: "http://localhost:11434/v1",
  model: "llama3",
  maxTurns: 20,
} as const;

// ---------------------------------------------------------------------------
// MobileAgent class
// ---------------------------------------------------------------------------

/**
 * A lightweight, scratch-built conversational agent.
 *
 * Works on Termux, pydroid3 Python bridges, and anywhere Node ≥18 runs.
 * Uses only Node built-ins for HTTP — zero extra npm deps required.
 */
export class MobileAgent {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly systemPrompt: string;
  private readonly maxTurns: number;
  private readonly tools: Map<string, AgentTool>;
  private history: AgentMessage[];

  constructor(config: MobileAgentConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");
    this.model = config.model ?? DEFAULTS.model;
    this.apiKey = config.apiKey ?? "";
    this.systemPrompt =
      config.systemPrompt ??
      [
        "You are a helpful mobile assistant running inside Termux on Android.",
        "You can run shell commands, manage tmux sessions, and assist with development tasks.",
        "Keep responses concise — the user is on a small screen.",
      ].join(" ");
    this.maxTurns = config.maxTurns ?? DEFAULTS.maxTurns;
    this.tools = new Map((config.tools ?? []).map((t) => [t.name, t]));
    this.history = [];
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Send a user message and receive the assistant's reply after tool calls. */
  async turn(userMessage: string): Promise<AgentTurnResult> {
    this.history.push({ role: "user", content: userMessage });
    this.pruneHistory();

    const toolCalls: ToolCallRecord[] = [];
    let finalReply = "";

    // Agentic loop: up to 8 tool-call iterations then break.
    for (let iteration = 0; iteration < 8; iteration++) {
      const messages = this.buildMessages();
      const response = await this.callApi(messages);
      const choice = this.extractChoice(response);

      // No tool use — we have the final answer.
      if (!choice.toolCalls || choice.toolCalls.length === 0) {
        finalReply = choice.content ?? "";
        this.history.push({ role: "assistant", content: finalReply });
        this.pruneHistory();
        break;
      }

      // Execute each tool call, record results.
      const toolResults: string[] = [];
      for (const tc of choice.toolCalls) {
        const tool = this.tools.get(tc.name);
        let output: string;
        let error: string | undefined;

        if (!tool) {
          error = `Tool "${tc.name}" not found.`;
          output = error;
        } else {
          try {
            output = await tool.run(tc.input);
          } catch (err) {
            error = String(err);
            output = `Error: ${error}`;
          }
        }

        const record: ToolCallRecord = { name: tc.name, input: tc.input, output };
        if (error) {
          record.error = error;
        }
        toolCalls.push(record);
        toolResults.push(`[${tc.name}] ${output}`);
      }

      // Feed tool results back into history as assistant + user turn.
      const toolSummary = toolResults.join("\n");
      this.history.push({ role: "assistant", content: choice.content ?? "" });
      this.history.push({
        role: "user",
        content: `Tool results:\n${toolSummary}\n\nPlease continue based on the above.`,
      });
    }

    return { reply: finalReply, toolCalls };
  }

  /** Clear conversation history (start fresh). */
  reset(): void {
    this.history = [];
  }

  /** Read-only snapshot of current history (excluding system message). */
  getHistory(): ReadonlyArray<AgentMessage> {
    return [...this.history];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildMessages(): Array<{ role: string; content: string }> {
    return [
      { role: "system", content: this.systemPrompt },
      ...this.history.map((m) => ({ role: m.role, content: m.content })),
    ];
  }

  private pruneHistory(): void {
    // Keep at most maxTurns user+assistant pairs.
    const maxMessages = this.maxTurns * 2;
    if (this.history.length > maxMessages) {
      this.history = this.history.slice(this.history.length - maxMessages);
    }
  }

  protected async callApi(messages: Array<{ role: string; content: string }>): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const body = {
      model: this.model,
      messages,
      // Request tool_calls only when tools are registered.
      ...(this.tools.size > 0
        ? {
            tools: this.buildToolSchemas(),
            tool_choice: "auto",
          }
        : {}),
    };

    return postJson(`${this.baseUrl}/chat/completions`, body, headers);
  }

  private buildToolSchemas(): Array<Record<string, unknown>> {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      },
    }));
  }

  private extractChoice(response: unknown): {
    content: string;
    toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  } {
    const r = response as Record<string, unknown>;
    const choices = r["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      return { content: "" };
    }
    const msg = choices[0]?.["message"] as Record<string, unknown> | undefined;
    if (!msg) {
      return { content: "" };
    }

    const content = (msg["content"] as string | null) ?? "";
    const rawToolCalls = msg["tool_calls"] as Array<Record<string, unknown>> | undefined;

    if (!rawToolCalls || rawToolCalls.length === 0) {
      return { content };
    }

    const toolCalls = rawToolCalls.map((tc) => {
      const fn = tc["function"] as Record<string, unknown> | undefined;
      const name = (fn?.["name"] as string | undefined) ?? "";
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse((fn?.["arguments"] as string | undefined) ?? "{}") as Record<
          string,
          unknown
        >;
      } catch {
        // Ignore malformed arguments JSON — the tool will receive an empty
        // input object and can surface the problem in its own error handling.
      }
      return { name, input };
    });

    return { content, toolCalls };
  }
}

// ---------------------------------------------------------------------------
// Built-in tools (opt-in — callers assemble the tools list)
// ---------------------------------------------------------------------------

/**
 * Returns a set of commonly useful tools for Termux environments.
 * Import and pass to `MobileAgentConfig.tools` as needed.
 */
export function createDefaultTermuxTools(): AgentTool[] {
  return [echoTool, dateTool];
}

/** A simple echo tool useful for testing. */
export const echoTool: AgentTool = {
  name: "echo",
  description: "Echo back a message. Useful for testing.",
  run: (input) => {
    const msg = String(input["message"] ?? "");
    return msg;
  },
};

/** Returns the current date/time as a string. */
export const dateTool: AgentTool = {
  name: "current_time",
  description: "Return the current date and time.",
  run: () => new Date().toISOString(),
};
