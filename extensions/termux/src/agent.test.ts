import { describe, it, expect, vi, beforeEach } from "vitest";
import { MobileAgent, echoTool, dateTool, createDefaultTermuxTools } from "./agent.js";
import type { AgentTool } from "./types.js";

// ---------------------------------------------------------------------------
// Helper: build a mock HTTP backend
// ---------------------------------------------------------------------------

/** Creates a mock for the raw postJson function by replacing callApi internals. */
function makeAgent(
  replies: Array<{ content: string; toolCalls?: Array<{ name: string; args: string }> }>,
  tools?: AgentTool[],
): MobileAgent {
  let callCount = 0;
  const agent = new MobileAgent({ tools });

  // Spy on the private callApi method by replacing the internal postJson call.
  // We achieve this by subclassing + overriding.
  const origTurn = agent.turn.bind(agent);

  // Instead of patching internals we supply a custom baseUrl and intercept at
  // the HTTP layer.  For unit tests we prefer a stub approach: replace callApi
  // via a subclass exposed in tests only.
  return agent;
}

// ---------------------------------------------------------------------------
// Subclass that exposes a mockable callApi
// ---------------------------------------------------------------------------

type MockReply = {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: string }>;
};

class TestableAgent extends MobileAgent {
  private mockReplies: MockReply[] = [];
  private callIndex = 0;

  setReplies(replies: MockReply[]) {
    this.mockReplies = replies;
    this.callIndex = 0;
  }

  // Override the protected callApi to return pre-configured mock replies.
  protected override async callApi(messages: unknown[]): Promise<unknown> {
    const reply = this.mockReplies[this.callIndex] ?? { content: "(default)" };
    this.callIndex++;
    const choice: Record<string, unknown> = { content: reply.content ?? null };
    if (reply.toolCalls && reply.toolCalls.length > 0) {
      choice["tool_calls"] = reply.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return { choices: [{ message: choice }] };
  }
}

// ---------------------------------------------------------------------------
// Tests: MobileAgent
// ---------------------------------------------------------------------------

describe("MobileAgent", () => {
  let agent: TestableAgent;

  beforeEach(() => {
    agent = new TestableAgent();
  });

  it("starts with empty history", () => {
    expect(agent.getHistory()).toHaveLength(0);
  });

  it("records a user turn and assistant reply", async () => {
    agent.setReplies([{ content: "Hello back!" }]);
    const result = await agent.turn("Hello");
    expect(result.reply).toBe("Hello back!");
    expect(agent.getHistory()).toHaveLength(2);
    expect(agent.getHistory()[0]).toMatchObject({ role: "user", content: "Hello" });
    expect(agent.getHistory()[1]).toMatchObject({ role: "assistant", content: "Hello back!" });
  });

  it("reset() clears history", async () => {
    agent.setReplies([{ content: "Hi" }]);
    await agent.turn("test");
    agent.reset();
    expect(agent.getHistory()).toHaveLength(0);
  });

  it("executes a tool call and feeds result back", async () => {
    const callLog: string[] = [];
    const spy: AgentTool = {
      name: "spy_tool",
      description: "spy",
      run: (input) => {
        callLog.push(JSON.stringify(input));
        return "spy_output";
      },
    };

    const a = new TestableAgent({ tools: [spy] });
    // First reply: invoke tool; second reply: final answer after tool result.
    a.setReplies([
      { content: "", toolCalls: [{ name: "spy_tool", arguments: '{"x":1}' }] },
      { content: "Done after tool." },
    ]);

    const result = await a.turn("use spy_tool");
    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toBe('{"x":1}');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("spy_tool");
    expect(result.toolCalls[0]?.output).toBe("spy_output");
    expect(result.reply).toBe("Done after tool.");
  });

  it("handles an unknown tool gracefully", async () => {
    const a = new TestableAgent();
    a.setReplies([
      { content: "", toolCalls: [{ name: "no_such_tool", arguments: "{}" }] },
      { content: "Handled error." },
    ]);

    const result = await a.turn("call unknown");
    expect(result.toolCalls[0]?.error).toContain("not found");
    expect(result.reply).toBe("Handled error.");
  });

  it("handles a tool that throws", async () => {
    const bomb: AgentTool = {
      name: "bomb",
      description: "throws",
      run: () => {
        throw new Error("boom");
      },
    };
    const a = new TestableAgent({ tools: [bomb] });
    a.setReplies([
      { content: "", toolCalls: [{ name: "bomb", arguments: "{}" }] },
      { content: "Caught." },
    ]);

    const result = await a.turn("trigger bomb");
    expect(result.toolCalls[0]?.error).toContain("boom");
  });

  it("prunes history when maxTurns is exceeded", async () => {
    const a = new TestableAgent({ maxTurns: 2 });
    a.setReplies(Array.from({ length: 10 }, (_, i) => ({ content: `reply ${i}` })));
    for (let i = 0; i < 5; i++) {
      await a.turn(`msg ${i}`);
    }
    // maxTurns * 2 = 4 messages kept.
    expect(a.getHistory().length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Tests: built-in tools
// ---------------------------------------------------------------------------

describe("echoTool", () => {
  it("returns the message input", () => {
    expect(echoTool.run({ message: "hello" })).toBe("hello");
  });

  it("handles missing message", () => {
    expect(echoTool.run({})).toBe("");
  });
});

describe("dateTool", () => {
  it("returns a valid ISO date string", () => {
    const result = dateTool.run({});
    expect(() => new Date(result as string)).not.toThrow();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("createDefaultTermuxTools", () => {
  it("returns both echo and dateTool", () => {
    const tools = createDefaultTermuxTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("current_time");
  });
});
