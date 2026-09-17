/**
 * Sending requests through the pipeline — boots the real unified proxy
 * (startProxyServer) on an ephemeral high port and exercises both routes that
 * loop a request back through it:
 *
 *  • POST /__admin/replay — re-send something a device already did
 *  • POST /__admin/send   — one composed from scratch in the dashboard
 *
 * They live in one file because they are one code path (`sendViaProxy` in
 * admin-router.js) reached two ways, and the guarantees worth testing — the
 * host can't be redirected, the origin flag can't be forged, a body goes out
 * with Content-Length — belong to that shared path, not to either route.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const request = require("supertest");

const { startProxyServer } = require("../proxy-server");
const requestLog = require("../utils/request-log");
const loadMocks = require("../utils/mock-loader");
const { basePort } = require("./helpers/ports");

const INSTANCE_ID = "rep";
const PREFERRED_PORT = basePort();

let MOCKS_DIR;
let REQUESTS_DIR;
let store;
let proxy; // { server, port }

// Send a proxy-style (absolute-form) request through the unified proxy, the
// same shape a device configured with an HTTP proxy would send.
function throughProxy(proxyPort, targetHost, targetPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: `http://${targetHost}${targetPath}`,
        method: "GET",
        headers,
        agent: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-rep-"));
  // Saved requests are read through this env var at call time, so setting it
  // here keeps the suite off the real `requests/` directory.
  REQUESTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-rep-saved-"));
  process.env.IR_PROXY_REQUESTS_DIR = REQUESTS_DIR;
  fs.writeFileSync(
    path.join(MOCKS_DIR, "thing.mock.js"),
    `module.exports = {
       name: "Thing",
       match: (req) => req.path === "/api/thing",
       respond: (req, res) => res.status(200).json({ thing: true }),
     };`
  );
  // Echoes back what it actually received, so an override test can assert the
  // edited values arrived rather than just that the call returned 200.
  fs.writeFileSync(
    path.join(MOCKS_DIR, "echo.mock.js"),
    `module.exports = {
       name: "Echo",
       match: (req) => req.path.startsWith("/api/echo"),
       respond: (req, res) =>
         res.status(200).json({
           method: req.method,
           url: req.originalUrl,
           token: req.headers["x-token"] || null,
           replayed: req.headers["x-ir-proxy-replayed"] || null,
           composed: req.headers["x-ir-proxy-composed"] || null,
           contentType: req.headers["content-type"] || null,
           host: req.headers.host,
           body: req.body ?? null,
         }),
     };`
  );

  // Not-JSON and no-body-at-all, the two ways a schema check can fail before
  // it ever reaches the schema.
  fs.writeFileSync(
    path.join(MOCKS_DIR, "shapes.mock.js"),
    `module.exports = {
       name: "Shapes",
       match: (req) => req.path === "/api/html" || req.path === "/api/empty",
       respond: (req, res) =>
         req.path === "/api/empty"
           ? res.status(204).end()
           : res.status(200).type("html").send("<h1>nope</h1>"),
     };`
  );

  store = {
    instanceStatus: { [INSTANCE_ID]: { Thing: true, Echo: true, Shapes: true } },
    instanceSettings: {
      // targetUrl is never contacted: the mock answers before the proxy hop.
      [INSTANCE_ID]: { isActive: true, targetUrl: "http://127.0.0.1:1", latency: 0 },
    },
    profiles: {},
    // The proxy only decrypts hosts with SSL proxying switched on, so the test
    // has to opt its target in exactly like a user would from the dashboard.
    hostSettings: {
      "127.0.0.1": { ssl: true, focus: "none", instanceId: INSTANCE_ID },
    },
    proxyPort: null,
  };

  loadMocks.invalidate();
  requestLog.clearLog();

  proxy = await startProxyServer({
    serverConfigs: [
      { id: INSTANCE_ID, port: 3996, target: "http://127.0.0.1:9", name: "Replay" },
      // Configured but never opted into SSL proxying (hostSettings above only
      // covers 127.0.0.1), which is what makes it the fixture for the refusal.
      { id: "nossl", port: 3997, target: "http://127.0.0.2:9", name: "Not decrypted" },
    ],
    store,
    MOCKS_DIR,
    STATE_FILE: null,
    saveState: () => {},
    preferredPort: PREFERRED_PORT,
  });

  // store.proxyPort is published in the listen callback — wait for it.
  if (!proxy.server.listening) {
    await new Promise((resolve) => proxy.server.once("listening", resolve));
  }
});

afterAll(async () => {
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
  fs.rmSync(REQUESTS_DIR, { recursive: true, force: true });
  delete process.env.IR_PROXY_REQUESTS_DIR;
  if (proxy?.server) await new Promise((resolve) => proxy.server.close(resolve));
});

describe("POST /__admin/replay", () => {
  test("replays a captured request through the full pipeline", async () => {
    // 1. Generate the original entry through the proxy (intercepted host).
    const first = await throughProxy(proxy.port, "127.0.0.1", "/api/thing");
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ thing: true });

    const history = await request(proxy.server).get("/__admin/log-history");
    const original = history.body.find((e) => e.path === "/api/thing");
    expect(original).toBeDefined();
    expect(original.replayed).toBeUndefined();
    expect(store.proxyPort).toBe(proxy.port);

    // 2. Replay it.
    const replay = await request(proxy.server)
      .post("/__admin/replay")
      .send({ id: original.id });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ok: true, status: 200 });

    // 3. A second, flagged entry exists for the same path (newest first).
    const after = await request(proxy.server).get("/__admin/log-history");
    const entries = after.body.filter((e) => e.path === "/api/thing");
    expect(entries).toHaveLength(2);
    expect(entries[0].replayed).toBe(true);
    expect(entries[0].source).toBe("mock");
    expect(entries[1].id).toBe(original.id);
  });

  test("404 for an unknown log id", async () => {
    const res = await request(proxy.server).post("/__admin/replay").send({ id: "nope" });
    expect(res.status).toBe(404);
  });

  test("400 when id is missing", async () => {
    const res = await request(proxy.server).post("/__admin/replay").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /__admin/replay with overrides", () => {
  /** Capture a fresh echo entry to replay, and return its id. */
  const seed = async (path = "/api/echo") => {
    await throughProxy(proxy.port, "127.0.0.1", path);
    const history = await request(proxy.server).get("/__admin/log-history");
    return history.body.find((e) => e.path === path && !e.replayed).id;
  };

  /** The echo mock's response for the newest replayed entry. */
  const lastReplayBody = async () => {
    const after = await request(proxy.server).get("/__admin/log-history");
    return after.body.find((e) => e.replayed && e.path.startsWith("/api/echo"))
      ?.responseBody;
  };

  test("applies method, path, headers and body", async () => {
    const id = await seed();

    const res = await request(proxy.server)
      .post("/__admin/replay")
      .send({
        id,
        overrides: {
          method: "POST",
          path: "/api/echo?edited=1",
          headers: { "x-token": "abc123", "content-type": "application/json" },
          body: { hello: "world" },
        },
      });
    expect(res.status).toBe(200);

    const echoed = await lastReplayBody();
    expect(echoed).toMatchObject({
      method: "POST",
      url: "/api/echo?edited=1",
      token: "abc123",
      body: { hello: "world" },
    });
  });

  test("a lowercase method is accepted and normalised", async () => {
    const id = await seed();
    const res = await request(proxy.server)
      .post("/__admin/replay")
      .send({ id, overrides: { method: "delete" } });
    expect(res.status).toBe(200);
    expect((await lastReplayBody()).method).toBe("DELETE");
  });

  test("host and the replay flag cannot be overridden", async () => {
    // Otherwise an override could redirect the request elsewhere, or hide that
    // the entry is a replay.
    const id = await seed();
    const res = await request(proxy.server)
      .post("/__admin/replay")
      .send({
        id,
        overrides: {
          headers: { host: "evil.example.com", "x-ir-proxy-replayed": "0" },
        },
      });
    expect(res.status).toBe(200);

    const echoed = await lastReplayBody();
    expect(echoed.host).toBe("127.0.0.1");
    expect(echoed.replayed).toBe("1");
  });

  test("a request with a body replays with Content-Length, not chunked", async () => {
    // Regression: the replay used to omit Content-Length, so Node sent
    // `Transfer-Encoding: chunked`. That header reached the instance app and
    // http-proxy-middleware then added its own Content-Length when forwarding,
    // producing a malformed request the upstream answered with 400. Replaying
    // anything with a body was broken, overrides or not.
    const id = await seed();

    const res = await request(proxy.server)
      .post("/__admin/replay")
      .send({
        id,
        overrides: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: { any: "body" },
        },
      });
    expect(res.status).toBe(200);

    const after = await request(proxy.server).get("/__admin/log-history");
    const replayed = after.body.find((e) => e.replayed && e.path.startsWith("/api/echo"));
    expect(replayed.requestHeaders["transfer-encoding"]).toBeUndefined();
    expect(replayed.requestHeaders["content-length"]).toBeDefined();
  });

  test("no overrides still behaves exactly as before", async () => {
    const id = await seed();
    const res = await request(proxy.server).post("/__admin/replay").send({ id });
    expect(res.status).toBe(200);
    expect((await lastReplayBody()).method).toBe("GET");
  });

  describe("validation", () => {
    const reject = async (overrides) => {
      const id = await seed();
      return request(proxy.server).post("/__admin/replay").send({ id, overrides });
    };

    test("rejects an unknown method", async () => {
      const res = await reject({ method: "TRACEROUTE" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/method/);
    });

    test("rejects a path that isn't absolute", async () => {
      expect((await reject({ path: "api/echo" })).status).toBe(400);
    });

    test("rejects a path containing a line break", async () => {
      // A newline would let a caller inject extra request lines.
      expect((await reject({ path: "/api/echo\r\nX-Evil: 1" })).status).toBe(400);
    });

    test("rejects non-object headers and non-string values", async () => {
      expect((await reject({ headers: "x-token: abc" })).status).toBe(400);
      expect((await reject({ headers: { "x-token": { a: 1 } } })).status).toBe(400);
    });

    test("rejects a header value containing a line break", async () => {
      expect((await reject({ headers: { "x-token": "a\r\nX-Evil: 1" } })).status).toBe(
        400
      );
    });

    test("rejects a non-object overrides", async () => {
      expect((await reject("nope")).status).toBe(400);
      expect((await reject([1, 2])).status).toBe(400);
    });
  });

  test("a supplied body lifts the truncated-body refusal", async () => {
    // Editing is the documented way out of a request that was stored cut.
    const id = await seed();
    const entry = requestLog.getEntry(id);
    entry.requestTruncated = true;

    const blocked = await request(proxy.server).post("/__admin/replay").send({ id });
    expect(blocked.status).toBe(409);

    const allowed = await request(proxy.server)
      .post("/__admin/replay")
      .send({ id, overrides: { body: { rebuilt: true } } });
    expect(allowed.status).toBe(200);
  });

  test("still refuses when SSL proxying is off for the host", async () => {
    const id = await seed();
    store.hostSettings["127.0.0.1"].ssl = false;
    try {
      const res = await request(proxy.server)
        .post("/__admin/replay")
        .send({ id, overrides: { method: "POST" } });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/SSL proxying is off/);
    } finally {
      store.hostSettings["127.0.0.1"].ssl = true;
    }
  });
});

describe("POST /__admin/send (composed from scratch)", () => {
  // A path of its own, so nothing here is mistaken for a seed by the replay
  // suites above (their helpers key off `/api/echo` exactly).
  const PATH = "/api/echo/new";

  const compose = (payload) => request(proxy.server).post("/__admin/send").send(payload);

  /** The echo mock's response for the newest composed entry. */
  const lastComposedBody = async () => {
    const after = await request(proxy.server).get("/__admin/log-history");
    return after.body.find((e) => e.composed)?.responseBody;
  };

  test("sends a request nothing was captured for", async () => {
    const before = await request(proxy.server).get("/__admin/log-history");
    expect(before.body.some((e) => e.path.startsWith(PATH))).toBe(false);

    const res = await compose({
      instanceId: INSTANCE_ID,
      method: "POST",
      path: `${PATH}?from=scratch`,
      headers: { "x-token": "typed-by-hand" },
      body: { hello: "world" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 200 });

    // It went through the real pipeline: the mock answered it.
    const echoed = await lastComposedBody();
    expect(echoed).toMatchObject({
      method: "POST",
      url: `${PATH}?from=scratch`,
      token: "typed-by-hand",
      composed: "1",
      body: { hello: "world" },
    });
  });

  test("is flagged composed, not replayed", async () => {
    // The two flags answer different questions while reading the log, so a
    // composed request must not masquerade as a replay of something real.
    await compose({ instanceId: INSTANCE_ID, path: PATH });
    const after = await request(proxy.server).get("/__admin/log-history");
    const entry = after.body.find((e) => e.path === PATH);
    expect(entry.composed).toBe(true);
    expect(entry.replayed).toBeUndefined();
    expect(entry.source).toBe("mock");
  });

  test("defaults the method to GET", async () => {
    await compose({ instanceId: INSTANCE_ID, path: PATH });
    expect((await lastComposedBody()).method).toBe("GET");
  });

  test("defaults content-type to JSON for an object body", async () => {
    // Typing a JSON body and forgetting the header is the easy mistake here,
    // and it fails confusingly upstream rather than in the editor.
    await compose({
      instanceId: INSTANCE_ID,
      method: "POST",
      path: PATH,
      body: { a: 1 },
    });
    expect((await lastComposedBody()).contentType).toBe("application/json");
  });

  test("does not override a content-type that was given", async () => {
    await compose({
      instanceId: INSTANCE_ID,
      method: "POST",
      path: PATH,
      headers: { "Content-Type": "application/vnd.custom+json" },
      body: { a: 1 },
    });
    expect((await lastComposedBody()).contentType).toBe("application/vnd.custom+json");
  });

  test("a body goes out with Content-Length, not chunked", async () => {
    await compose({
      instanceId: INSTANCE_ID,
      method: "POST",
      path: PATH,
      body: { a: 1 },
    });
    const after = await request(proxy.server).get("/__admin/log-history");
    const entry = after.body.find((e) => e.composed && e.method === "POST");
    expect(entry.requestHeaders["transfer-encoding"]).toBeUndefined();
    expect(entry.requestHeaders["content-length"]).toBeDefined();
  });

  test("host and the composed flag cannot be forged", async () => {
    const res = await compose({
      instanceId: INSTANCE_ID,
      path: PATH,
      headers: { host: "evil.example.com", "x-ir-proxy-composed": "0" },
    });
    expect(res.status).toBe(200);

    const echoed = await lastComposedBody();
    expect(echoed.host).toBe("127.0.0.1");
    expect(echoed.composed).toBe("1");
  });

  describe("validation", () => {
    test("400 when instanceId is missing", async () => {
      const res = await compose({ path: PATH });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/instanceId/);
    });

    test("400 when path is missing", async () => {
      // Unlike a replay, there is no captured request to fall back on.
      const res = await compose({ instanceId: INSTANCE_ID });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/path/);
    });

    test("400 for a path that isn't absolute", async () => {
      expect((await compose({ instanceId: INSTANCE_ID, path: "api/x" })).status).toBe(
        400
      );
    });

    test("400 for a path or header carrying a line break", async () => {
      expect(
        (await compose({ instanceId: INSTANCE_ID, path: "/x\r\nX-Evil: 1" })).status
      ).toBe(400);
      expect(
        (
          await compose({
            instanceId: INSTANCE_ID,
            path: PATH,
            headers: { "x-token": "a\r\nX-Evil: 1" },
          })
        ).status
      ).toBe(400);
    });

    test("400 for an unknown method", async () => {
      const res = await compose({
        instanceId: INSTANCE_ID,
        method: "TRACEROUTE",
        path: PATH,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/method/);
    });

    test("404 for an instance that isn't configured", async () => {
      const res = await compose({ instanceId: "ghost", path: PATH });
      expect(res.status).toBe(404);
    });

    test("409 for an instance whose host has SSL proxying off", async () => {
      // It would tunnel straight upstream — no mocks, nothing logged — which is
      // not what "send this through the proxy" means.
      const res = await compose({ instanceId: "nossl", path: PATH });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/SSL proxying is off/);
    });
  });
});

describe("/__admin/saved-requests", () => {
  const save = (payload) =>
    request(proxy.server).post("/__admin/saved-requests").send(payload);

  const listSaved = async () =>
    (await request(proxy.server).get("/__admin/saved-requests")).body.requests;

  const valid = {
    name: "Login as QA",
    instanceId: INSTANCE_ID,
    method: "POST",
    path: "/api/echo/saved",
    headers: { "x-token": "keep-me" },
    body: { user: "qa" },
  };

  test("saves and lists a request", async () => {
    const res = await save(valid);
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      id: "login-as-qa",
      name: "Login as QA",
      instanceId: INSTANCE_ID,
      method: "POST",
      path: "/api/echo/saved",
    });

    const all = await listSaved();
    expect(all.map((r) => r.id)).toContain("login-as-qa");
  });

  test("a saved request can be sent, unchanged, and reaches the mock", async () => {
    // The payoff: what comes back out of the store is a valid /send payload.
    await save(valid);
    const saved = (await listSaved()).find((r) => r.id === "login-as-qa");

    const sent = await request(proxy.server).post("/__admin/send").send({
      instanceId: saved.instanceId,
      method: saved.method,
      path: saved.path,
      headers: saved.headers,
      body: saved.body,
    });
    expect(sent.status).toBe(200);

    const after = await request(proxy.server).get("/__admin/log-history");
    const entry = after.body.find((e) => e.path === "/api/echo/saved");
    expect(entry.composed).toBe(true);
    expect(entry.responseBody).toMatchObject({
      method: "POST",
      token: "keep-me",
      body: { user: "qa" },
    });
  });

  test("deletes one, then reports it gone", async () => {
    await save({ ...valid, name: "Throwaway" });
    const del = await request(proxy.server).delete("/__admin/saved-requests/throwaway");
    expect(del.status).toBe(200);

    expect((await listSaved()).map((r) => r.id)).not.toContain("throwaway");
    const again = await request(proxy.server).delete("/__admin/saved-requests/throwaway");
    expect(again.status).toBe(404);
  });

  describe("validation", () => {
    test("400 for a missing or unsafe name", async () => {
      expect((await save({ ...valid, name: undefined })).status).toBe(400);
      expect((await save({ ...valid, name: "   " })).status).toBe(400);
      // Rendered in the dashboard, so it is held to the same standard as an
      // instance or profile label.
      expect(
        (await save({ ...valid, name: "<img src=x onerror=alert(1)>" })).status
      ).toBe(400);
      expect((await save({ ...valid, name: "x".repeat(65) })).status).toBe(400);
    });

    test("404 for an instance that isn't configured", async () => {
      expect((await save({ ...valid, instanceId: "ghost" })).status).toBe(404);
    });

    test("400 for fields a send would refuse too", async () => {
      expect((await save({ ...valid, path: "api/echo" })).status).toBe(400);
      expect((await save({ ...valid, path: undefined })).status).toBe(400);
      expect((await save({ ...valid, method: "TRACEROUTE" })).status).toBe(400);
      expect(
        (await save({ ...valid, headers: { "x-token": "a\r\nX-Evil: 1" } })).status
      ).toBe(400);
    });

    test("404, and no unlink, for a traversing id", async () => {
      const res = await request(proxy.server).delete(
        "/__admin/saved-requests/..%2f..%2fetc%2fpasswd"
      );
      expect(res.status).toBe(404);
    });
  });
});

// ── Response expectations ────────────────────────────────────────────────────
// The one thing `/send` could not previously tell you: not "did it go out" but
// "was the answer the right shape". Exercised against the real proxy, because
// the whole reason this check lives on the server is that the server is the
// only place the **untruncated** response body ever exists — the activity log
// has already cut it to IR_PROXY_BODY_CHARS by the time anyone could read it there.

describe("expectations on the response", () => {
  const send = (payload) => request(proxy.server).post("/__admin/send").send(payload);

  const thing = { instanceId: INSTANCE_ID, method: "GET", path: "/api/thing" };

  test("no expectation means the response is shaped exactly as it was", async () => {
    const res = await send(thing);
    expect(res.status).toBe(200);
    // Not `toMatchObject`: the absence of the key is the assertion. Nothing
    // that does not ask for a check should start paying for one.
    expect(res.body).toEqual({ ok: true, status: 200 });
  });

  test("an empty expectation is the same as none", async () => {
    const res = await send({ ...thing, expect: {} });
    expect(res.body).toEqual({ ok: true, status: 200 });
  });

  test("a matching schema passes", async () => {
    const res = await send({
      ...thing,
      expect: {
        status: 200,
        schema: {
          type: "object",
          required: ["thing"],
          properties: { thing: { type: "boolean" } },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: 200,
      expect: { passed: true, errors: [] },
    });
  });

  test("a failing schema is a successful send with a failed expectation", async () => {
    const res = await send({
      ...thing,
      expect: {
        schema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer" } },
        },
      },
    });
    // The distinction the collections row depends on: HTTP 200, `ok: true`,
    // `status: 200` — the request went out and came back fine. What was wrong
    // was the answer, and that is a different fact.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe(200);
    expect(res.body.expect.passed).toBe(false);
    expect(res.body.expect.errors).toEqual(["/id: required property is missing"]);
  });

  test("a wrong status fails on its own, without a schema", async () => {
    const res = await send({ ...thing, expect: { status: 404 } });
    expect(res.body.expect).toEqual({
      passed: false,
      errors: ["expected status 404, got 200"],
    });
  });

  test("status and schema both report, in one round trip", async () => {
    const res = await send({
      ...thing,
      expect: { status: 201, schema: { type: "object", required: ["id"] } },
    });
    expect(res.body.expect.errors).toEqual([
      "expected status 201, got 200",
      "/id: required property is missing",
    ]);
  });

  test("a non-JSON body says so, and says what it was", async () => {
    const res = await send({
      instanceId: INSTANCE_ID,
      path: "/api/html",
      expect: { schema: { type: "object" } },
    });
    expect(res.body.expect.passed).toBe(false);
    expect(res.body.expect.errors[0]).toMatch(/not JSON/);
    expect(res.body.expect.errors[0]).toMatch(/text\/html/);
  });

  test("an empty body is named as empty rather than as bad JSON", async () => {
    const res = await send({
      instanceId: INSTANCE_ID,
      path: "/api/empty",
      expect: { schema: { type: "object" } },
    });
    expect(res.body.status).toBe(204);
    expect(res.body.expect.errors).toEqual([
      "expected a JSON body, got an empty response",
    ]);
  });

  test("a schema it cannot honour is a 400 before anything is sent", async () => {
    const res = await send({
      ...thing,
      expect: { schema: { $ref: "#/definitions/Thing" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"$ref"');
  });

  test("a malformed expectation is a 400", async () => {
    expect((await send({ ...thing, expect: "200" })).status).toBe(400);
    expect((await send({ ...thing, expect: { status: 99 } })).status).toBe(400);
    expect((await send({ ...thing, expect: { status: "ok" } })).status).toBe(400);
    expect((await send({ ...thing, expect: { schema: { type: "int" } } })).status).toBe(
      400
    );
  });

  test("a replay can carry one too", async () => {
    await throughProxy(proxy.port, "127.0.0.1", "/api/thing");
    const history = await request(proxy.server).get("/__admin/log-history");
    const original = history.body.find((e) => e.path === "/api/thing");

    const res = await request(proxy.server)
      .post("/__admin/replay")
      .send({
        id: original.id,
        expect: { schema: { type: "object", required: ["thing"] } },
      });
    expect(res.body.expect).toEqual({ passed: true, errors: [] });
  });

  test("an expectation is saved, and refused on the same terms a send refuses it", async () => {
    const expectation = {
      status: 200,
      schema: { type: "object", properties: { thing: { type: "boolean" } } },
    };
    const ok = await request(proxy.server).post("/__admin/saved-requests").send({
      name: "Checked thing",
      instanceId: INSTANCE_ID,
      path: "/api/thing",
      expect: expectation,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.request.expect).toEqual(expectation);

    const bad = await request(proxy.server)
      .post("/__admin/saved-requests")
      .send({
        name: "Unhonourable",
        instanceId: INSTANCE_ID,
        path: "/api/thing",
        expect: { schema: { allOf: [] } },
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('"allOf"');
  });

  test("a request saved without one stores null, not a missing key", async () => {
    const res = await request(proxy.server)
      .post("/__admin/saved-requests")
      .send({ name: "Unchecked thing", instanceId: INSTANCE_ID, path: "/api/thing" });
    expect(res.body.request.expect).toBeNull();
  });
});

// ── Sending a saved request by id ────────────────────────────────────────────
// The route exists so that "what a saved request becomes on the wire" is
// written once. Four things need it — the dashboard runner, the CLI, and the
// three drop-in clients — and four hand-assembled payloads is how a newly added
// field stops being sent by three of them.

describe("POST /__admin/saved-requests/:id/send", () => {
  const save = (payload) =>
    request(proxy.server).post("/__admin/saved-requests").send(payload);
  const run = (id, body) =>
    request(proxy.server)
      .post(`/__admin/saved-requests/${encodeURIComponent(id)}/send`)
      .send(body || {});

  test("sends the whole record, expectation included", async () => {
    const saved = await save({
      name: "Run me",
      instanceId: INSTANCE_ID,
      method: "GET",
      path: "/api/thing",
      expect: { status: 200, schema: { type: "object", required: ["thing"] } },
    });

    const res = await run(saved.body.request.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: 200,
      expect: { passed: true, errors: [] },
    });
  });

  test("carries headers and body through, not just the path", async () => {
    const saved = await save({
      name: "Run me with a body",
      instanceId: INSTANCE_ID,
      method: "POST",
      path: "/api/echo",
      headers: { "x-token": "abc" },
      body: { hello: "world" },
      // The echo mock reflects what it received, so the expectation *is* the
      // assertion that every field survived the trip.
      expect: {
        schema: {
          type: "object",
          properties: {
            method: { const: "POST" },
            token: { const: "abc" },
            body: { type: "object", properties: { hello: { const: "world" } } },
          },
        },
      },
    });

    const res = await run(saved.body.request.id);
    expect(res.body.expect).toEqual({ passed: true, errors: [] });
  });

  test("a request with no expectation just sends", async () => {
    const saved = await save({
      name: "Unchecked run",
      instanceId: INSTANCE_ID,
      path: "/api/thing",
    });
    expect((await run(saved.body.request.id)).body).toEqual({ ok: true, status: 200 });
  });

  test("an expectation in the body replaces the stored one", async () => {
    const saved = await save({
      name: "Overridable",
      instanceId: INSTANCE_ID,
      path: "/api/thing",
      expect: { status: 200 },
    });
    // Keeping schemas in the caller's own repo, next to the tests that use
    // them, rather than only inside the dashboard.
    const res = await run(saved.body.request.id, {
      expect: { schema: { type: "object", required: ["missing"] } },
    });
    expect(res.body.expect.errors).toEqual(["/missing: required property is missing"]);
  });

  test("an explicit null expectation checks nothing", async () => {
    const saved = await save({
      name: "Silenceable",
      instanceId: INSTANCE_ID,
      path: "/api/thing",
      expect: { status: 404 },
    });
    expect((await run(saved.body.request.id, { expect: null })).body).toEqual({
      ok: true,
      status: 200,
    });
  });

  test("404 for an id that is not there, and for one shaped wrong", async () => {
    expect((await run("no-such-request")).status).toBe(404);
    expect((await run("..%2f..%2fetc%2fpasswd")).status).toBe(404);
  });

  test("a hand-edited file with an unhonourable expectation fails up front", async () => {
    // `requests/` is a directory somebody can edit. Trusting what is in it
    // would mean the refusal arrives mid-run instead of before anything is sent.
    const saved = await save({
      name: "Edited by hand",
      instanceId: INSTANCE_ID,
      path: "/api/thing",
    });
    const file = path.join(REQUESTS_DIR, `${saved.body.request.id}.request.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.expect = { schema: { $ref: "#/definitions/Thing" } };
    fs.writeFileSync(file, JSON.stringify(record, null, 2));

    const res = await run(saved.body.request.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("cannot be honoured");
    expect(res.body.error).toContain('"$ref"');
  });
});

describe("{{ variables }}", () => {
  const send = (payload) =>
    request(proxy.server)
      .post("/__admin/send")
      .send({ instanceId: INSTANCE_ID, ...payload });

  test("resolves into the path, the headers and the body the mock receives", async () => {
    const res = await send({
      method: "POST",
      path: "/api/echo/{{ id }}?q={{ q | encodeURIComponent }}",
      headers: { "x-token": "Bearer {{ token }}", "content-type": "application/json" },
      body: { ref: "{{ id }}" },
      variables: { id: "42", q: "a b&c", token: "s3cret" },
    });
    expect(res.status).toBe(200);

    // Asserted against what the mock actually received, not against the send
    // returning 200: the braces resolving is the whole feature, and a test that
    // only checks the call went out would pass with none of it working.
    const history = await request(proxy.server).get("/__admin/log-history");
    const entry = history.body.find((e) => e.path.startsWith("/api/echo/42"));
    expect(entry).toBeDefined();
    expect(entry.responseBody).toMatchObject({
      url: "/api/echo/42?q=a%20b%26c",
      token: "Bearer s3cret",
      body: { ref: "42" },
    });
  });

  test("a string body resolves too, and is declared text/plain so it survives", async () => {
    // A body the editor could not parse as JSON — XML, a form, a line of text.
    // It used to go out with no content-type at all, which meant no parser
    // claimed it: the mock saw no body and the activity log recorded none, so a
    // request that was sent perfectly well read as though its body was dropped.
    await send({
      method: "POST",
      path: "/api/echo/text",
      body: "hola {{ name }}",
      variables: { name: "mundo" },
    });

    const history = await request(proxy.server).get("/__admin/log-history");
    const entry = history.body.find((e) => e.path === "/api/echo/text");
    expect(entry.requestHeaders["content-type"]).toMatch(/^text\/plain/);
    // Both halves matter: the mock got it, and the log can show it back.
    expect(entry.responseBody.body).toBe("hola mundo");
    expect(entry.requestBody).toBe("hola mundo");
  });

  test("what the mock received is resolved, not the braces", async () => {
    await send({
      path: "/api/echo/{{ id }}?q={{ q | encodeURIComponent }}",
      headers: { "x-token": "{{ token }}" },
      variables: { id: "42", q: "a b&c", token: "s3cret" },
    });

    const history = await request(proxy.server).get("/__admin/log-history");
    const entry = history.body.find((e) => e.path.startsWith("/api/echo/42"));
    expect(entry).toBeDefined();
    expect(entry.path).toBe("/api/echo/42?q=a%20b%26c");
    expect(entry.requestHeaders["x-token"]).toBe("s3cret");
  });

  test("an undefined variable is a 400 naming it, and nothing is sent", async () => {
    const res = await send({ path: "/api/echo", headers: { "x-token": "{{ nope }}" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/"nope" is not defined/);
  });

  test("an unknown filter is a 400 before anything leaves", async () => {
    const res = await send({
      path: "/api/echo/{{ id | encodeUri }}",
      variables: { id: "42" },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/"encodeUri" is not a filter/);
  });

  test("a value carrying CRLF cannot inject a header", async () => {
    // The security property. `validateRequestFields` checks the template text,
    // where the newline is not yet present; the pass that catches this is the
    // one that runs on the *resolved* request, which is why it exists.
    const res = await send({
      path: "/api/echo",
      headers: { "x-token": "{{ evil }}" },
      variables: { evil: "ok\r\nx-injected: yes" },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/line breaks/);
  });

  test("a value cannot break the path either", async () => {
    const res = await send({
      path: "{{ evil }}",
      variables: { evil: "/api/echo\r\nGET /elsewhere HTTP/1.1" },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/single line/);
  });

  test("no variables means the request is sent exactly as before", async () => {
    const res = await send({ path: "/api/thing" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("PATCH /__admin/saved-requests/:id", () => {
  const save = (extra) =>
    request(proxy.server)
      .post("/__admin/saved-requests")
      .send({
        name: "Patchable",
        instanceId: INSTANCE_ID,
        method: "GET",
        path: "/api/echo/{{ id }}",
        ...extra,
      });

  test("updates the variables and leaves everything else alone", async () => {
    const created = await save({
      variables: { id: "1" },
      headers: { "x-token": "keep" },
    });
    expect(created.status).toBe(200);
    const id = created.body.request.id;

    const patched = await request(proxy.server)
      .patch(`/__admin/saved-requests/${id}`)
      .send({ variables: { id: "42" } });

    expect(patched.status).toBe(200);
    expect(patched.body.request.variables).toEqual({ id: "42" });
    // The narrow scope is the point: a Send writes variables back, and must not
    // quietly persist the path and body edits that are meant to be temporary.
    expect(patched.body.request.path).toBe("/api/echo/{{ id }}");
    expect(patched.body.request.headers).toEqual({ "x-token": "keep" });
  });

  test("an empty map clears them rather than storing {}", async () => {
    const id = (await save({ variables: { id: "1" } })).body.request.id;

    const patched = await request(proxy.server)
      .patch(`/__admin/saved-requests/${id}`)
      .send({ variables: {} });

    expect(patched.body.request.variables).toBeNull();
  });

  test("refuses anything but variables, and a variable map it would refuse on send", async () => {
    const id = (await save({})).body.request.id;

    const wrongField = await request(proxy.server)
      .patch(`/__admin/saved-requests/${id}`)
      .send({ path: "/somewhere-else" });
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.error).toMatch(/Only `variables`/);

    const badName = await request(proxy.server)
      .patch(`/__admin/saved-requests/${id}`)
      .send({ variables: { "not a name": "x" } });
    expect(badName.status).toBe(400);
    expect(badName.body.error).toMatch(/not a usable variable name/);
  });

  test("404s for a request that no longer exists", async () => {
    const res = await request(proxy.server)
      .patch("/__admin/saved-requests/gone")
      .send({ variables: {} });
    expect(res.status).toBe(404);
  });
});

describe("a large composed body", () => {
  test("goes through — the dashboard API is not a 100kb wall", async () => {
    // Express's default `express.json()` limit is 100kb, and a composed request
    // carries its whole body inside the envelope posted to /__admin/send. A
    // real sync payload for a real account runs to a hundred thousand
    // characters, so the API refused it before `/send` ever saw it — and
    // answered with an HTML error page, which reads as the request being cut
    // rather than refused.
    const big = {
      rows: Array.from({ length: 1500 }, (_, i) => ({
        ID: String(i),
        DESC: "FIREHAWK AS BL 235/50R18 97V 50,000 Mile Limited Warranty",
        TOTAL: "587.96",
      })),
    };
    // Past the old 100kb ceiling, which is the point — and under
    // IR_PROXY_BODY_CHARS, so the log keeps the whole thing and this can assert on
    // what actually arrived rather than on a status code.
    expect(JSON.stringify(big).length).toBeGreaterThan(120_000);
    expect(JSON.stringify(big).length).toBeLessThan(requestLog.MAX_BODY_CHARS);

    const res = await request(proxy.server)
      .post("/__admin/send")
      .send({
        instanceId: INSTANCE_ID,
        method: "POST",
        path: "/api/echo/big",
        headers: { "Content-Type": "application/json" },
        body: big,
      });
    expect(res.status).toBe(200);

    // The mock echoes what the instance app parsed, so this is the whole body
    // arriving — not a status code that happened to be 200.
    const history = await request(proxy.server).get("/__admin/log-history");
    const entry = history.body.find((e) => e.path === "/api/echo/big");
    expect(entry.responseBody.body.rows).toHaveLength(1500);
  });

  test("a broken payload is refused as JSON, not as an HTML error page", async () => {
    // Every caller of this API reads `{ error }` out of JSON. Express's default
    // handler answers a body-parser failure with HTML, which arrives as a parse
    // failure carrying nothing — the caller cannot say what went wrong.
    const res = await request(proxy.server)
      .post("/__admin/send")
      .set("Content-Type", "application/json")
      .send("{ not json");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toMatch(/not valid JSON/);
  });
});

describe("a form body with a nested document", () => {
  test("sends the document as JSON instead of [object Object]", async () => {
    // The shape a real sync endpoint takes: one scalar field and one field
    // holding a whole document. Written as nested JSON, which is the only way
    // it is editable — hand-escaping it into a string was the workaround.
    const res = await request(proxy.server)
      .post("/__admin/send")
      .send({
        instanceId: INSTANCE_ID,
        method: "POST",
        path: "/api/echo/form",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: {
          email: "{{email}}",
          data: {
            DRIVER: [
              { ADDRESS: "520%20NW%20St", EMAIL: "{{email | encodeURIComponent}}" },
            ],
          },
        },
        variables: { email: "ivan@example.com" },
      });
    expect(res.status).toBe(200);

    // The mock echoes `req.body`, which is what express.urlencoded parsed —
    // i.e. what a real upstream would see after decoding the form once.
    const history = await request(proxy.server).get("/__admin/log-history");
    const entry = history.body.find((e) => e.path === "/api/echo/form");
    const form = entry.responseBody.body;

    expect(form.email).toBe("ivan@example.com");
    // Not "[object Object]", and the pre-encoded value came back untouched.
    expect(JSON.parse(form.data)).toEqual({
      DRIVER: [{ ADDRESS: "520%20NW%20St", EMAIL: "ivan%40example.com" }],
    });
  });
});

describe("header name case, end to end", () => {
  test("the log records the spellings the client used, next to the folded map", async () => {
    await throughProxy(proxy.port, "127.0.0.1", "/api/thing", {
      tokenId: "abc123",
      "x-all-lower": "1",
    });

    const history = await request(proxy.server).get("/__admin/log-history");
    const entry = history.body.find(
      (e) => e.path === "/api/thing" && e.requestHeaders?.tokenid === "abc123"
    );
    expect(entry).toBeDefined();
    // The map itself stays lowercase — it is Node's parse, it is what mocks
    // match on, and it is what the capture clients are documented to read.
    expect(entry.requestHeaders.tokenId).toBeUndefined();
    // Only the names that differ are remembered — `x-all-lower` arrived
    // lowercase, so there is nothing to put back. (`Host`/`Connection` are in
    // here too: Node's own client capitalises them, and that is what was sent.)
    expect(entry.requestHeaderCase.tokenid).toBe("tokenId");
    expect(entry.requestHeaderCase).not.toHaveProperty("x-all-lower");
  });

  test("a composed request's spellings reach the log", async () => {
    const res = await request(proxy.server)
      .post("/__admin/send")
      .send({
        instanceId: INSTANCE_ID,
        method: "GET",
        path: "/api/echo/composed-case",
        headers: { appName: "MyApp", "x-token": "plain" },
      });
    expect(res.status).toBe(200);

    const history = await request(proxy.server).get("/__admin/log-history");
    const entry = history.body.find((e) => e.path === "/api/echo/composed-case");
    expect(entry.requestHeaderCase.appname).toBe("appName");
    expect(entry.requestHeaderCase).not.toHaveProperty("x-token");
  });

  test("a replay re-sends the captured spellings, not the folded ones", async () => {
    // The whole point of a replay is that it is the same request again. Without
    // the case going back on, the replayed entry differs from the original in
    // the one way the proxy is supposed to be transparent about.
    await throughProxy(proxy.port, "127.0.0.1", "/api/echo/replay-case", {
      tokenId: "abc123",
    });

    const before = await request(proxy.server).get("/__admin/log-history");
    const original = before.body.find((e) => e.path === "/api/echo/replay-case");
    expect(original.requestHeaderCase.tokenid).toBe("tokenId");

    const replay = await request(proxy.server)
      .post("/__admin/replay")
      .send({ id: original.id });
    expect(replay.status).toBe(200);

    const after = await request(proxy.server).get("/__admin/log-history");
    const entries = after.body.filter((e) => e.path === "/api/echo/replay-case");
    expect(entries).toHaveLength(2);
    expect(entries[0].replayed).toBe(true);
    expect(entries[0].requestHeaderCase.tokenid).toBe("tokenId");
  });

  test("a retry that re-sends the shown spelling does not send the header twice", async () => {
    // The editor prefills from the capture, so it sends `tokenId` back while the
    // log still holds `tokenid` — `normalize` in sendViaProxy folds them, and
    // the edited value is the one that survives.
    await throughProxy(proxy.port, "127.0.0.1", "/api/echo/retry-case", {
      tokenId: "original",
    });
    const before = await request(proxy.server).get("/__admin/log-history");
    const original = before.body.find((e) => e.path === "/api/echo/retry-case");

    const replay = await request(proxy.server)
      .post("/__admin/replay")
      .send({
        id: original.id,
        overrides: { headers: { tokenId: "edited", "x-token": "s3cret" } },
      });
    expect(replay.status).toBe(200);

    const after = await request(proxy.server).get("/__admin/log-history");
    const retried = after.body.filter((e) => e.path === "/api/echo/retry-case")[0];
    expect(retried.replayed).toBe(true);
    expect(retried.requestHeaders.tokenid).toBe("edited");
    expect(retried.requestHeaderCase.tokenid).toBe("tokenId");
    // The mock echoes what the instance app parsed, so this is the value that
    // would have reached a real upstream.
    expect(retried.responseBody.token).toBe("s3cret");
  });
});
