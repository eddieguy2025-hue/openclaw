/**
 * OpenClaw Termux/Android extension entry point.
 *
 * Registers a tool that starts a mobile web UI server and exposes tmux
 * session management from within an agent conversation.
 */

import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { TmuxManager } from "./src/tmux.js";
import { WebUiServer } from "./src/web-ui.js";

export default function register(api: OpenClawPluginApi) {
  const tmux = new TmuxManager();

  // -------------------------------------------------------------------------
  // Tool: start_mobile_ui
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "start_mobile_ui",
      label: "Start Mobile Web UI",
      description:
        "Start a mobile-friendly web UI server on the specified port. " +
        "Accessible from any browser on the same network — ideal for Termux.",
      parameters: {
        type: "object",
        properties: {
          port: {
            type: "number",
            description: "TCP port to listen on (default: 8899).",
          },
          title: {
            type: "string",
            description: "Page title shown in the browser (default: 'OpenClaw Mobile').",
          },
          api_key: {
            type: "string",
            description: "Optional API key to protect the UI.",
          },
        },
        required: [],
      },
      async run(input) {
        const port = typeof input["port"] === "number" ? input["port"] : 8899;
        const title = typeof input["title"] === "string" ? input["title"] : "OpenClaw Mobile";
        const apiKey = typeof input["api_key"] === "string" ? input["api_key"] : "";
        const server = new WebUiServer({ port, title, apiKey });
        await server.start();
        return JSON.stringify({
          ok: true,
          url: `http://localhost:${server.port}/`,
          port: server.port,
        });
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // -------------------------------------------------------------------------
  // Tool: tmux_list_sessions
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "tmux_list_sessions",
      label: "List tmux Sessions",
      description: "List all running tmux sessions. Returns JSON array.",
      parameters: { type: "object", properties: {}, required: [] },
      async run() {
        const sessions = await tmux.listSessions();
        return JSON.stringify(sessions);
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // -------------------------------------------------------------------------
  // Tool: tmux_create_session
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "tmux_create_session",
      label: "Create tmux Session",
      description: "Create a new detached tmux session.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Session name." },
          command: { type: "string", description: "Optional initial command to run." },
        },
        required: ["name"],
      },
      async run(input) {
        const name = String(input["name"] ?? "");
        const command = typeof input["command"] === "string" ? input["command"] : undefined;
        await tmux.createSession(name, command);
        return JSON.stringify({ ok: true, session: name });
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // -------------------------------------------------------------------------
  // Tool: tmux_send_keys
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "tmux_send_keys",
      label: "Send Keys to tmux Pane",
      description: "Send a command string to a tmux session pane.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Target session name." },
          command: { type: "string", description: "Command to send." },
        },
        required: ["session", "command"],
      },
      async run(input) {
        const session = String(input["session"] ?? "");
        const command = String(input["command"] ?? "");
        await tmux.sendKeys(session, command);
        return JSON.stringify({ ok: true });
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );

  // -------------------------------------------------------------------------
  // Tool: tmux_capture
  // -------------------------------------------------------------------------
  api.registerTool(
    {
      name: "tmux_capture",
      label: "Capture tmux Pane Output",
      description: "Capture the visible text from a tmux pane.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Target session name." },
          window: { type: "number", description: "Window index (default: 0)." },
          pane: { type: "number", description: "Pane index (default: 0)." },
        },
        required: ["session"],
      },
      async run(input) {
        const session = String(input["session"] ?? "");
        const window = typeof input["window"] === "number" ? input["window"] : 0;
        const pane = typeof input["pane"] === "number" ? input["pane"] : 0;
        const result = await tmux.capturePane(session, window, pane);
        return JSON.stringify(result);
      },
    } as unknown as AnyAgentTool,
    { optional: true },
  );
}
