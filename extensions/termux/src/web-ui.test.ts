import http from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { WebUiServer } from "./web-ui.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
    };
    http
      .get(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] ?? ""),
          });
        });
      })
      .on("error", reject);
  });
}

async function post(url: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
      },
      (res) => {
        res.resume(); // drain
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// WebUiServer tests
// ---------------------------------------------------------------------------

describe("WebUiServer", () => {
  const servers: WebUiServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.stop().catch(() => {
        /* ignore */
      });
    }
    servers.length = 0;
  });

  async function startServer(
    overrides: Partial<ConstructorParameters<typeof WebUiServer>[0]> = {},
    agentConfig: ConstructorParameters<typeof WebUiServer>[1] = {},
  ) {
    // Use port 0 so the OS assigns a free port (avoids EADDRINUSE on CI).
    const server = new WebUiServer({ port: 0, ...overrides }, agentConfig);
    await server.start();
    servers.push(server);
    return { server, base: `http://127.0.0.1:${server.port}` };
  }

  // -------------------------------------------------------------------------
  it("GET / returns HTML with correct content-type", async () => {
    const { base } = await startServer();
    const res = await get(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("viewport");
  });

  it("HTML embeds the title", async () => {
    const { base } = await startServer({ title: "My Mobile Bot" });
    const res = await get(`${base}/`);
    expect(res.body).toContain("My Mobile Bot");
  });

  it("HTML escapes special chars in title", async () => {
    const { base } = await startServer({ title: "<script>alert(1)</script>" });
    const res = await get(`${base}/`);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;");
  });

  it("GET /health returns JSON ok", async () => {
    const { base } = await startServer();
    const res = await get(`${base}/health`);
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
  });

  it("GET /unknown returns 404", async () => {
    const { base } = await startServer();
    const res = await get(`${base}/no-such-path`);
    expect(res.status).toBe(404);
  });

  it("POST /reset returns 204", async () => {
    const { base } = await startServer();
    const res = await post(`${base}/reset`);
    expect(res.status).toBe(204);
  });

  it("port getter reflects bound port", async () => {
    const { server } = await startServer();
    // server.port is assigned by the OS (port 0 binding).
    expect(server.port).toBeGreaterThan(0);
  });

  it("returns 401 for protected server without key", async () => {
    const { base } = await startServer({ apiKey: "secret" });
    const res = await get(`${base}/`);
    expect(res.status).toBe(401);
  });

  it("returns 200 when correct key is provided as query param", async () => {
    const { base } = await startServer({ apiKey: "secret" });
    const res = await get(`${base}/?key=secret`);
    expect(res.status).toBe(200);
  });

  it("returns 200 when correct key is provided as Bearer header", async () => {
    const { base } = await startServer({ apiKey: "secret" });
    const res = await get(`${base}/`, { Authorization: "Bearer secret" });
    expect(res.status).toBe(200);
  });

  it("GET /chat with empty msg returns SSE error event", async () => {
    const { base } = await startServer();
    const res = await get(`${base}/chat?msg=`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/event-stream");
    expect(res.body).toContain("event: error");
    expect(res.body).toContain("event: done");
  });

  it("stop() closes the server cleanly", async () => {
    // Bind with port 0, capture the assigned port, stop, then rebind same port.
    const server = new WebUiServer({ port: 0 });
    await server.start();
    const assignedPort = server.port;
    await server.stop();
    // After stop, a new server can bind the same port.
    const server2 = new WebUiServer({ port: assignedPort });
    servers.push(server2);
    await expect(server2.start()).resolves.toBeUndefined();
  });
});
