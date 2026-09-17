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
const { CaptureClient } = require("../clients/js/capture-client");

const INSTANCE_ID = "test";

let MOCKS_DIR;
let app;
let server;
let client;

beforeAll((done) => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-client-"));
  fs.writeFileSync(
    path.join(MOCKS_DIR, "login.mock.js"),
    `module.exports = {
       name: "Login",
       match: (req) => req.path === "/api/login" && req.method === "POST",
       respond: (req, res) => res.status(200).json({ token: "abc123" }),
     };`
  );

  const store = {
    instanceStatus: { [INSTANCE_ID]: { Login: true } },
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
      saveState: () => {},
      instanceId: INSTANCE_ID,
    })
  );
  app.use(createMockMiddleware(INSTANCE_ID, store, MOCKS_DIR));
  app.use((req, res) => res.status(404).send("no mock matched"));

  // Explicit port bypasses the client's network autodetection scan — hermetic.
  server = app.listen(0, () => {
    client = new CaptureClient({ port: server.address().port });
    done();
  });
});

beforeEach(() => {
  requestLog.clearLog();
  captureSessions.clearAll();
  client.sessionId = null;
});

// Bind the app once, instead of letting supertest bind a fresh ephemeral
// port per request. Declared as its own hook so it runs after the setup
// above, whatever that setup looks like. See helpers/serve.js.
beforeAll(() => {
  app = serve(app);
});

afterAll((done) => {
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
  server.close(done);
});

describe("CaptureClient (JS)", () => {
  test("full flow: start → app traffic → stop → assert exact payload", async () => {
    const sessionId = await client.start({ name: "js-client-flow" });
    expect(sessionId).toEqual(expect.any(String));

    // App traffic goes through the same app instance (shared singleton log).
    await request(app)
      .post("/api/login")
      .set("X-Test", "yes")
      .send({ email: "a@b.com", password: "secret" });

    const result = await client.stop();
    expect(result.status).toBe("stopped");
    expect(result.count).toBe(1);

    const login = result.requests.find((r) => r.path === "/api/login");
    expect(login.requestBody).toEqual({ email: "a@b.com", password: "secret" });
    expect(login.requestHeaders["x-test"]).toBe("yes");
    expect(login.responseBody).toEqual({ token: "abc123" });
  });

  test("getRequests applies filters; getSession returns metadata", async () => {
    await client.start();
    await request(app).post("/api/login").send({ a: 1 });
    await request(app).get("/api/items?lang=en");

    expect(await client.getRequests(undefined, { method: "POST" })).toHaveLength(1);
    expect(await client.getRequests(undefined, { path: "/api/items" })).toHaveLength(1);

    const meta = await client.getSession();
    expect(meta.status).toBe("active");
    expect(meta.count).toBe(2);
  });

  test("delete cleans up the session server-side", async () => {
    const sessionId = await client.start();
    await client.delete();
    expect(client.sessionId).toBeNull();
    await expect(client.getSession(sessionId)).rejects.toThrow(/404/);
  });

  test("server errors surface as descriptive exceptions", async () => {
    await expect(client.stop("nope")).rejects.toThrow(/not found/);
    await expect(client.stop()).rejects.toThrow(/no active session/);
  });
});
