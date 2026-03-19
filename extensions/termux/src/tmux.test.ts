import { describe, it, expect, vi } from "vitest";
import { TmuxManager, validateSessionName } from "./tmux.js";
import type { TmuxRunner } from "./tmux.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub runner that returns preset strings per call. */
function stubRunner(outputs: string[]): TmuxRunner {
  let idx = 0;
  return async (_args) => {
    const out = outputs[idx] ?? "";
    idx++;
    return out;
  };
}

/** Build a runner that throws an error with the given message. */
function errorRunner(message: string): TmuxRunner {
  return async () => {
    const e = new Error(message);
    throw e;
  };
}

// ---------------------------------------------------------------------------
// validateSessionName
// ---------------------------------------------------------------------------

describe("validateSessionName", () => {
  it("accepts normal names", () => {
    expect(() => validateSessionName("my-session")).not.toThrow();
    expect(() => validateSessionName("session_1")).not.toThrow();
    expect(() => validateSessionName("abc")).not.toThrow();
  });

  it("rejects empty names", () => {
    expect(() => validateSessionName("")).toThrow("empty");
    expect(() => validateSessionName("   ")).toThrow("empty");
  });

  it("rejects names with dots", () => {
    expect(() => validateSessionName("ses.sion")).toThrow("Invalid session name");
  });

  it("rejects names with colons", () => {
    expect(() => validateSessionName("ses:sion")).toThrow("Invalid session name");
  });

  it("rejects names with dollar signs", () => {
    expect(() => validateSessionName("ses$sion")).toThrow("Invalid session name");
  });
});

// ---------------------------------------------------------------------------
// TmuxManager.listSessions
// ---------------------------------------------------------------------------

describe("TmuxManager.listSessions", () => {
  it("parses session list output", async () => {
    const mgr = new TmuxManager({
      runner: stubRunner(["main\t3\t1710000000\t1\nwork\t1\t1710000100\t0\n"]),
    });
    const sessions = await mgr.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      name: "main",
      windows: 3,
      created: 1710000000,
      attached: true,
    });
    expect(sessions[1]).toMatchObject({
      name: "work",
      windows: 1,
      attached: false,
    });
  });

  it("returns [] when no server is running", async () => {
    const mgr = new TmuxManager({
      runner: errorRunner("no server running"),
    });
    await expect(mgr.listSessions()).resolves.toEqual([]);
  });

  it("returns [] on empty output", async () => {
    const mgr = new TmuxManager({ runner: stubRunner([""]) });
    const sessions = await mgr.listSessions();
    expect(sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TmuxManager.hasSession
// ---------------------------------------------------------------------------

describe("TmuxManager.hasSession", () => {
  it("returns true when has-session succeeds", async () => {
    const mgr = new TmuxManager({ runner: stubRunner([""]) });
    await expect(mgr.hasSession("main")).resolves.toBe(true);
  });

  it("returns false when has-session throws", async () => {
    const mgr = new TmuxManager({ runner: errorRunner("can't find session") });
    await expect(mgr.hasSession("nonexistent")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TmuxManager.createSession
// ---------------------------------------------------------------------------

describe("TmuxManager.createSession", () => {
  it("calls new-session with correct args", async () => {
    const calls: string[][] = [];
    const mgr = new TmuxManager({
      runner: async (args) => {
        calls.push(args);
        return "";
      },
    });
    await mgr.createSession("mytest");
    expect(calls[0]).toContain("new-session");
    expect(calls[0]).toContain("mytest");
  });

  it("is idempotent on duplicate session error", async () => {
    const mgr = new TmuxManager({ runner: errorRunner("duplicate session: mytest") });
    await expect(mgr.createSession("mytest")).resolves.toBeUndefined();
  });

  it("rejects invalid session names", async () => {
    const mgr = new TmuxManager({ runner: stubRunner([""]) });
    await expect(mgr.createSession("bad.name")).rejects.toThrow("Invalid session name");
  });

  it("passes initialCommand when provided", async () => {
    const calls: string[][] = [];
    const mgr = new TmuxManager({
      runner: async (args) => {
        calls.push(args);
        return "";
      },
    });
    await mgr.createSession("cmd-session", "bash");
    expect(calls[0]).toContain("bash");
  });
});

// ---------------------------------------------------------------------------
// TmuxManager.killSession
// ---------------------------------------------------------------------------

describe("TmuxManager.killSession", () => {
  it("calls kill-session", async () => {
    const calls: string[][] = [];
    const mgr = new TmuxManager({
      runner: async (args) => {
        calls.push(args);
        return "";
      },
    });
    await mgr.killSession("tosslot");
    expect(calls[0]).toContain("kill-session");
    expect(calls[0]).toContain("tosslot");
  });

  it("is idempotent when session doesn't exist", async () => {
    const mgr = new TmuxManager({ runner: errorRunner("can't find session") });
    await expect(mgr.killSession("gone")).resolves.toBeUndefined();
  });

  it("is idempotent when no server", async () => {
    const mgr = new TmuxManager({ runner: errorRunner("no server running") });
    await expect(mgr.killSession("x")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TmuxManager.sendKeys
// ---------------------------------------------------------------------------

describe("TmuxManager.sendKeys", () => {
  it("sends send-keys with Enter", async () => {
    const calls: string[][] = [];
    const mgr = new TmuxManager({
      runner: async (args) => {
        calls.push(args);
        return "";
      },
    });
    await mgr.sendKeys("mysession", "ls -la");
    expect(calls[0]).toContain("send-keys");
    expect(calls[0]).toContain("ls -la");
    expect(calls[0]).toContain("Enter");
  });
});

// ---------------------------------------------------------------------------
// TmuxManager.capturePane
// ---------------------------------------------------------------------------

describe("TmuxManager.capturePane", () => {
  it("returns structured output", async () => {
    const mgr = new TmuxManager({
      runner: stubRunner(["line1\nline2\nline3\n"]),
    });
    const result = await mgr.capturePane("mysession");
    expect(result.sessionName).toBe("mysession");
    expect(result.windowIndex).toBe(0);
    expect(result.paneIndex).toBe(0);
    expect(result.lines).toContain("line1");
    expect(result.lines).toContain("line2");
  });
});

// ---------------------------------------------------------------------------
// TmuxManager.newWindow
// ---------------------------------------------------------------------------

describe("TmuxManager.newWindow", () => {
  it("returns trimmed window index", async () => {
    const mgr = new TmuxManager({ runner: stubRunner(["mysession:1\n"]) });
    const idx = await mgr.newWindow("mysession");
    expect(idx).toBe("mysession:1");
  });
});
