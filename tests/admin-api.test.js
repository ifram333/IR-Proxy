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

const INSTANCE_ID = "test";

let MOCKS_DIR;
let store;
let app;

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-api-"));
  fs.writeFileSync(
    path.join(MOCKS_DIR, "login.mock.js"),
    `module.exports = {
       name: "Login",
       match: (req) => req.path === "/api/login" && req.method === "POST",
       respond: (req, res) => res.status(200).json({ token: "abc123" }),
     };`
  );

  store = {
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
  requestLog.clearLog();

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

// Bind the app once, instead of letting supertest bind a fresh ephemeral
// port per request. Declared as its own hook so it runs after the setup
// above, whatever that setup looks like. See helpers/serve.js.
beforeAll(() => {
  app = serve(app);
});

afterAll(() => fs.rmSync(MOCKS_DIR, { recursive: true, force: true }));

describe("mock pipeline (integration)", () => {
  test("an enabled mock serves its canned response", async () => {
    const res = await request(app)
      .post("/api/login")
      .set("X-Test", "yes")
      .send({ email: "a@b.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: "abc123" });
  });

  test("the request is captured in the activity log with full detail", async () => {
    const res = await request(app).get("/__admin/log-history");
    expect(res.status).toBe(200);
    const entry = res.body.find((e) => e.path === "/api/login");
    expect(entry).toBeDefined();
    expect(entry.source).toBe("mock");
    expect(entry.mockName).toBe("Login");
    expect(entry.requestHeaders["x-test"]).toBe("yes");
    expect(entry.requestBody).toEqual({ email: "a@b.com" });
    expect(entry.responseBody).toEqual({ token: "abc123" });
  });

  test("/__admin/config lists mocks and no longer exposes recording state", async () => {
    const res = await request(app).get("/__admin/config");
    expect(res.status).toBe(200);
    expect(res.body.mocks.map((m) => m.name)).toContain("Login");
    expect(res.body).not.toHaveProperty("recordingStates");
  });

  test("safePath blocks path traversal on mock-content", async () => {
    const res = await request(app).get(
      "/__admin/mock-content?file=" + encodeURIComponent("../../package.json")
    );
    expect(res.status).toBe(400);
  });

  test("toggling a mock off stops it from intercepting", async () => {
    const toggle = await request(app)
      .post("/__admin/toggle")
      .send({ instanceId: INSTANCE_ID, mockName: "Login", enabled: false });
    expect(toggle.status).toBe(200);
    expect(store.instanceStatus[INSTANCE_ID].Login).toBe(false);

    // With the mock off and no proxy handler, the request falls through to 404
    const res = await request(app).post("/api/login").send({ email: "a@b.com" });
    expect(res.status).toBe(404);
  });
});
