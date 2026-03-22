/** Shared types for the Termux mobile agent extension. */

/** A single message in an agent conversation. */
export type AgentMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** Result returned by the agent after a turn. */
export type AgentTurnResult = {
  reply: string;
  toolCalls: ToolCallRecord[];
  tokensUsed?: number;
};

/** A recorded tool invocation. */
export type ToolCallRecord = {
  name: string;
  input: Record<string, unknown>;
  output: string;
  error?: string;
};

/** A tool the agent can invoke. */
export type AgentTool = {
  name: string;
  description: string;
  /** Synchronous or async handler. */
  run: (input: Record<string, unknown>) => string | Promise<string>;
};

/** Tmux session descriptor. */
export type TmuxSession = {
  name: string;
  windows: number;
  created: number; // unix epoch seconds
  attached: boolean;
};

/** Result of capturing output from a tmux pane. */
export type TmuxCaptureResult = {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  lines: string[];
};

/** Configuration for the mobile web UI server. */
export type WebUiConfig = {
  port: number;
  host?: string;
  title?: string;
  /** Optional API key that clients must include as ?key=... or Bearer token. */
  apiKey?: string;
};

/** A streaming SSE event sent to mobile clients. */
export type SseEvent = {
  type: "token" | "done" | "error" | "tool";
  data: string;
};
