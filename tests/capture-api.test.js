const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const createAdminRouter = require("../utils/admin-router");
const { createMockMiddleware } = require("../utils/mock-pipeline");
const { createLoggerMiddleware } = require("../utils/request-log");
const loadMocks = require("../utils/mock-loader");
const requestLog = require("../utils/request-log");
const captureSessions = require("../utils/capture-sessions");

const INSTANCE_ID = "test";

let MOCKS_DIR;
let store;
let app;

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-capture-"));
  fs.writeFileSync(
    path.join(MOCKS_DIR, "login.mock.js"),
    `module.exports = {
       name: "Login",
       match: (req) => req.path === "/api/login" && req.method === "POST",
       respond: (req, res) => res.status(200).json({ token: "abc123" }),
     };`
  );
  fs.writeFileSync(
    path.join(MOCKS_DIR, "items.mock.js"),
    `module.exports = {
       name: "Items",
       match: (req) => req.path === "/api/items" && req.method === "GET",
       respond: (req, res) => res.status(200).json({ items: [] }),
     };`
  );

  store = {
    instanceStatus: { [INSTANCE_ID]: { Login: true, Items: true } },
    instanceSettings: {
      [INSTANCE_ID]: { isActive: true, targetUrl: "http://example.test" },
    },
    profiles: {},
  };

  const serverConfigs = [
    { id: INSTANCE_ID, port: 3999, target: "http://example.test", name: "Test" },
  ];

  loadMocks.invalidate();

  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(createLoggerMiddleware(INSTANCE_ID));
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE: null,
      store,
      serverConfigs,
      saveState: () => {}, // no disk persistence in tests
      instanceId: INSTANCE_ID,
    })
  );
  app.use(createMockMiddleware(INSTANCE_ID, store, MOCKS_DIR));
  app.use((req, res) => res.status(404).send("no mock matched"));
});

beforeEach(() => {
  requestLog.clearLog();
  captureSessions.clearAll();
});

// Bind the app once, instead of letting supertest bind a fresh ephemeral
// port per request. Declared as its own hook so it runs after the setup
// above, whatever that setup looks like. See helpers/serve.js.
beforeAll(() => {
  app = serve(app);
});

afterAll(() => fs.rmSync(MOCKS_DIR, { recursive: true, force: true }));

async function startSession(body) {
  const res = await request(app)
    .post("/__admin/capture/start")
    .send(body || {});
  expect(res.status).toBe(200);
  return res.body.sessionId;
}

describe("capture API (integration)", () => {
  test("start → app traffic → stop returns the exact captured payloads", async () => {
    const sessionId = await startSession({ name: "login-flow" });

    await request(app)
      .post("/api/login")
      .set("X-Test", "yes")
      .send({ email: "a@b.com", password: "secret" });

    const res = await request(app).post("/__admin/capture/stop").send({ sessionId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe("stopped");
    expect(res.body.count).toBe(1);
    expect(res.body.droppedCount).toBe(0);

    const entry = res.body.requests[0];
    expect(entry.method).toBe("POST");
    expect(entry.path).toBe("/api/login");
    expect(entry.source).toBe("mock");
    expect(entry.mockName).toBe("Login");
    expect(entry.requestHeaders["x-test"]).toBe("yes");
    expect(entry.requestBody).toEqual({ email: "a@b.com", password: "secret" });
    expect(entry.responseBody).toEqual({ token: "abc123" });
  });

  test("admin traffic (/__admin/*) is never captured", async () => {
    const sessionId = await startSession();
    await request(app).get("/__admin/log-history");
    await request(app).get(`/__admin/capture/${sessionId}`);

    const res = await request(app).post("/__admin/capture/stop").send({ sessionId });
    expect(res.body.count).toBe(0);
  });

  test("stop is idempotent and later traffic stays out of the window", async () => {
    const sessionId = await startSession();
    await request(app).post("/api/login").send({ email: "in@window.com" });
    const first = await request(app).post("/__admin/capture/stop").send({ sessionId });

    await request(app).post("/api/login").send({ email: "late@window.com" });
    const second = await request(app).post("/__admin/capture/stop").send({ sessionId });

    expect(second.status).toBe(200);
    expect(second.body.count).toBe(1);
    expect(second.body.stoppedAt).toBe(first.body.stoppedAt);
  });

  test("GET /capture/:id/requests applies query filters", async () => {
    const sessionId = await startSession();
    await request(app).post("/api/login").send({ email: "a@b.com" });
    await request(app).get("/api/items?lang=en");

    const byMethod = await request(app).get(
      `/__admin/capture/${sessionId}/requests?method=post`
    );
    expect(byMethod.body.requests.map((e) => e.path)).toEqual(["/api/login"]);

    // exact `path` matches the pathname even when the request carried a query string
    const byPath = await request(app).get(
      `/__admin/capture/${sessionId}/requests?path=/api/items`
    );
    expect(byPath.body.requests).toHaveLength(1);
    expect(byPath.body.requests[0].path).toBe("/api/items?lang=en");

    const byPrefix = await request(app).get(
      `/__admin/capture/${sessionId}/requests?pathPrefix=/api/`
    );
    expect(byPrefix.body.count).toBe(2);

    const bySource = await request(app).get(
      `/__admin/capture/${sessionId}/requests?source=proxy`
    );
    expect(bySource.body.requests).toHaveLength(0);
  });

  test("GET /capture lists session metadata without entries", async () => {
    const sessionId = await startSession({ name: "listed" });
    await request(app).post("/api/login").send({});

    const res = await request(app).get("/__admin/capture");
    expect(res.status).toBe(200);
    const session = res.body.sessions.find((s) => s.id === sessionId);
    expect(session).toMatchObject({ name: "listed", status: "active", count: 1 });
    expect(session.entries).toBeUndefined();
  });

  test("GET /capture/:id returns metadata; DELETE removes the session", async () => {
    const sessionId = await startSession();

    const meta = await request(app).get(`/__admin/capture/${sessionId}`);
    expect(meta.status).toBe(200);
    expect(meta.body.session.status).toBe("active");

    const del = await request(app).delete(`/__admin/capture/${sessionId}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, sessionId });

    const gone = await request(app).get(`/__admin/capture/${sessionId}`);
    expect(gone.status).toBe(404);
  });

  test("start validates the instanceId filter against configured instances", async () => {
    const bad = await request(app)
      .post("/__admin/capture/start")
      .send({ instanceId: "nope" });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toMatch(/not configured/);

    const good = await request(app)
      .post("/__admin/capture/start")
      .send({ instanceId: INSTANCE_ID });
    expect(good.status).toBe(200);
    expect(good.body.filter).toEqual({ instanceId: INSTANCE_ID });
  });

  test("a body sent without Content-Type: application/json is rejected, not silently ignored", async () => {
    // Without this guard the filter would be dropped and the session would
    // capture every instance's traffic.
    const start = await request(app)
      .post("/__admin/capture/start")
      .set("Content-Type", "text/plain")
      .send(`{"instanceId":"${INSTANCE_ID}"}`);
    expect(start.status).toBe(400);
    expect(start.body.error).toMatch(/Content-Type: application\/json/);

    const form = await request(app)
      .post("/__admin/capture/start")
      .type("form")
      .send(`instanceId=${INSTANCE_ID}`);
    expect(form.status).toBe(400);

    const sessionId = await startSession();
    const stop = await request(app)
      .post("/__admin/capture/stop")
      .set("Content-Type", "text/plain")
      .send(`{"sessionId":"${sessionId}"}`);
    expect(stop.status).toBe(400);
    expect(stop.body.error).toMatch(/Content-Type: application\/json/);
  });

  test("start and stop also accept fields as query parameters", async () => {
    const start = await request(app).post(
      `/__admin/capture/start?name=qs-flow&instanceId=${INSTANCE_ID}`
    );
    expect(start.status).toBe(200);
    expect(start.body.name).toBe("qs-flow");
    expect(start.body.filter).toEqual({ instanceId: INSTANCE_ID });

    const stop = await request(app).post(
      `/__admin/capture/stop?sessionId=${start.body.sessionId}`
    );
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe("stopped");
  });

  test("error paths: missing/unknown sessionId", async () => {
    const noId = await request(app).post("/__admin/capture/stop").send({});
    expect(noId.status).toBe(400);

    const unknownStop = await request(app)
      .post("/__admin/capture/stop")
      .send({ sessionId: "nope" });
    expect(unknownStop.status).toBe(404);

    const unknownGet = await request(app).get("/__admin/capture/nope/requests");
    expect(unknownGet.status).toBe(404);

    const unknownDelete = await request(app).delete("/__admin/capture/nope");
    expect(unknownDelete.status).toBe(404);
  });

  test("start returns 429 at the active-session cap", async () => {
    for (let i = 0; i < captureSessions.MAX_ACTIVE_SESSIONS; i++) {
      await startSession();
    }
    const res = await request(app).post("/__admin/capture/start").send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Too many active capture sessions/);
  });
});
