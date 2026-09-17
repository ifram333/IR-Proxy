const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const createAdminRouter = require("../utils/admin-router");
const { createMockMiddleware } = require("../utils/mock-pipeline");
const loadMocks = require("../utils/mock-loader");

const SERVER_CONFIGS = [
  { id: "api", port: 3000, target: "http://api.test", name: "API" },
  { id: "auth", port: 3001, target: "http://auth.test", name: "Auth" },
];

let MOCKS_DIR;
let store;
let appApi;
let appBeta;

function buildApp(instanceId) {
  const app = express();
  app.use(express.json());
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE: null,
      store,
      serverConfigs: SERVER_CONFIGS,
      saveState: () => {},
      instanceId,
    })
  );
  app.use(createMockMiddleware(instanceId, store, MOCKS_DIR));
  app.use((req, res) => res.status(404).send("no mock"));
  return app;
}

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-scope-"));
  fs.writeFileSync(
    path.join(MOCKS_DIR, "scoped.mock.js"),
    `module.exports = {
       name: "ScopedBeta",
       servers: ["auth"],
       match: (req) => req.path === "/scoped",
       respond: (req, res) => res.status(200).json({ scoped: true }),
     };`
  );

  // Enabled on BOTH instances — scope, not the toggle, must gate it.
  store = {
    instanceStatus: { api: { ScopedBeta: true }, auth: { ScopedBeta: true } },
    instanceSettings: {
      api: { isActive: true, targetUrl: "http://api.test" },
      auth: { isActive: true, targetUrl: "http://auth.test" },
    },
    profiles: {},
  };

  loadMocks.invalidate();
  appApi = buildApp("api");
  appBeta = buildApp("auth");
});

afterAll(() => fs.rmSync(MOCKS_DIR, { recursive: true, force: true }));

describe("server scope gating", () => {
  test("a mock serves on an in-scope instance", async () => {
    const res = await request(appBeta).get("/scoped");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scoped: true });
  });

  test("the same mock is NOT served on an out-of-scope instance, even if toggled on", async () => {
    const res = await request(appApi).get("/scoped");
    expect(res.status).toBe(404);
  });

  test("/config exposes the mock's servers scope", async () => {
    const res = await request(appBeta).get("/__admin/config");
    const mock = res.body.mocks.find((m) => m.name === "ScopedBeta");
    expect(mock.servers).toEqual(["auth"]);
  });

  test("toggling on an out-of-scope instance is rejected", async () => {
    const res = await request(appApi)
      .post("/__admin/toggle")
      .send({ instanceId: "api", mockName: "ScopedBeta", enabled: true });
    expect(res.status).toBe(409);
  });

  // NB: these assert the endpoint result + the rewritten file on disk. The live
  // re-gating after a rewrite relies on mock hot-reload (require.cache eviction),
  // which Jest's module registry doesn't honor in-process — that path is covered
  // by the browser verification. Scope *gating* itself is proven above.
  test("POST /mock-scope rewrites the file to a single-server scope", async () => {
    const res = await request(appApi)
      .post("/__admin/mock-scope")
      .send({ file: "scoped.mock.js", name: "ScopedBeta", servers: ["api"] });
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual(["api"]);

    const src = fs.readFileSync(path.join(MOCKS_DIR, "scoped.mock.js"), "utf8");
    expect(src).toMatch(/servers: \["api"\],/);
  });

  test("selecting all servers clears the scope field (applies everywhere)", async () => {
    const res = await request(appApi)
      .post("/__admin/mock-scope")
      .send({ file: "scoped.mock.js", name: "ScopedBeta", servers: ["api", "auth"] });
    expect(res.status).toBe(200);
    expect(res.body.servers).toBeNull();

    const src = fs.readFileSync(path.join(MOCKS_DIR, "scoped.mock.js"), "utf8");
    expect(src).not.toMatch(/servers:/);
  });
});
