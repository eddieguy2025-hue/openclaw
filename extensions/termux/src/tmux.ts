/**
 * tmux session manager for the Termux / Android extension.
 *
 * Wraps the tmux CLI. All operations are async child-process calls.
 * Works inside Termux (Android) and any POSIX environment with tmux ≥2.x.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TmuxCaptureResult, TmuxSession } from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Low-level tmux runner
// ---------------------------------------------------------------------------

/** Raw wrapper around the tmux binary; injectable for testing. */
export type TmuxRunner = (args: string[]) => Promise<string>;

/** Default runner: calls the system `tmux` binary. */
export async function defaultTmuxRunner(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    env: process.env,
    maxBuffer: 4 * 1024 * 1024, // 4 MB
  });
  return stdout;
}

// ---------------------------------------------------------------------------
// TmuxManager
// ---------------------------------------------------------------------------

export type TmuxManagerOptions = {
  /** Custom runner used in tests to avoid spawning real tmux processes. */
  runner?: TmuxRunner;
  /** Socket path passed as -S to every tmux command (optional). */
  socketPath?: string;
};

/**
 * High-level tmux session manager.
 *
 * All methods throw if the underlying tmux command fails.
 */
export class TmuxManager {
  private readonly run: TmuxRunner;
  private readonly socketArgs: string[];

  constructor(options: TmuxManagerOptions = {}) {
    this.run = options.runner ?? defaultTmuxRunner;
    this.socketArgs = options.socketPath ? ["-S", options.socketPath] : [];
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  /**
   * List all tmux sessions.
   * Returns an empty array if tmux has no server running (no sessions).
   */
  async listSessions(): Promise<TmuxSession[]> {
    let raw: string;
    try {
      raw = await this.run([
        ...this.socketArgs,
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}",
      ]);
    } catch (err) {
      // tmux exits with code 1 when no server exists — treat as empty list.
      if (isNoServerError(err)) {
        return [];
      }
      throw err;
    }

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", windows = "0", created = "0", attached = "0"] = line.split("\t");
        return {
          name,
          windows: parseInt(windows, 10) || 0,
          created: parseInt(created, 10) || 0,
          attached: attached.trim() === "1",
        };
      });
  }

  /**
   * Create a new detached tmux session with the given name.
   * If a session with that name already exists, does nothing.
   */
  async createSession(name: string, initialCommand?: string): Promise<void> {
    validateSessionName(name);
    try {
      const args = [...this.socketArgs, "new-session", "-d", "-s", name];
      if (initialCommand) {
        args.push(initialCommand);
      }
      await this.run(args);
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        return; // idempotent
      }
      throw err;
    }
  }

  /** Kill a session by name. Does nothing if it does not exist. */
  async killSession(name: string): Promise<void> {
    validateSessionName(name);
    try {
      await this.run([...this.socketArgs, "kill-session", "-t", name]);
    } catch (err) {
      if (isNoSessionError(err) || isNoServerError(err)) {
        return; // idempotent
      }
      throw err;
    }
  }

  /** Return true if a session with the given name is running. */
  async hasSession(name: string): Promise<boolean> {
    validateSessionName(name);
    try {
      await this.run([...this.socketArgs, "has-session", "-t", name]);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Window / pane interaction
  // -------------------------------------------------------------------------

  /**
   * Send a shell command to a session's active window (window 0, pane 0 by default).
   * Appends a newline so the command is executed immediately.
   */
  async sendKeys(
    sessionName: string,
    command: string,
    target = `${sessionName}:0.0`,
  ): Promise<void> {
    validateSessionName(sessionName);
    await this.run([...this.socketArgs, "send-keys", "-t", target, command, "Enter"]);
  }

  /**
   * Capture the visible contents of a pane.
   * Returns structured output with one line per array entry.
   */
  async capturePane(
    sessionName: string,
    windowIndex = 0,
    paneIndex = 0,
  ): Promise<TmuxCaptureResult> {
    validateSessionName(sessionName);
    const target = `${sessionName}:${windowIndex}.${paneIndex}`;
    const raw = await this.run([...this.socketArgs, "capture-pane", "-p", "-t", target]);
    return {
      sessionName,
      windowIndex,
      paneIndex,
      lines: raw.split("\n"),
    };
  }

  /**
   * Create a new window inside a session.
   * Returns the new window index (as a string from tmux output).
   */
  async newWindow(sessionName: string, windowName?: string): Promise<string> {
    validateSessionName(sessionName);
    const args = [
      ...this.socketArgs,
      "new-window",
      "-P", // print new window index
      "-t",
      sessionName,
    ];
    if (windowName) {
      args.push("-n", windowName);
    }
    const out = await this.run(args);
    return out.trim();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate that a session name is safe for use as a tmux target. */
export function validateSessionName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error("Session name must not be empty.");
  }
  // tmux session names cannot contain dots or colons (reserved separators).
  // Dollar signs are also disallowed since they can trigger variable expansion
  // in shell contexts when session names appear in command strings.
  if (/[.:$\x00-\x1f]/.test(name)) {
    throw new Error(
      `Invalid session name "${name}": must not contain dots, colons, dollar signs, or control characters.`,
    );
  }
}

function isNoServerError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? "");
  return (
    msg.includes("no server running") ||
    msg.includes("No such file or directory") ||
    msg.includes("error connecting to")
  );
}

function isNoSessionError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? "");
  return msg.includes("can't find session") || msg.includes("session not found");
}

function isAlreadyExistsError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? "");
  return msg.includes("duplicate session");
}
