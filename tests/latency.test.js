/**
 * Instance-wide simulated latency: admin validation, exposure in /config and
 * /health, and the actual delay applied to mock responses.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const createAdminRouter = require("../utils/admin-router");
const { createMockMiddleware } = require("../utils/mock-pipeline");
const loadMocks = require("../utils/mock-loader");

const INSTANCE_ID = "lat";

let MOCKS_DIR;
let store;
let app;

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-lat-"));
  fs.writeFileSync(
    path.join(MOCKS_DIR, "ping.mock.js"),
    `module.exports = {
       name: "Ping",
       match: (req) => req.path === "/api/ping",
       respond: (req, res) => res.status(200).json({ pong: true }),
     };`
  );

  store = {
    instanceStatus: { [INSTANCE_ID]: { Ping: true } },
    instanceSettings: {
      [INSTANCE_ID]: { isActive: true, targetUrl: "http://example.test", latency: 0 },
    },
    profiles: {},
  };

  const serverConfigs = [
    { id: INSTANCE_ID, port: 3997, target: "http://example.test", name: "Latency" },
  ];

  loadMocks.invalidate();

  app = express();
  app.use(express.json());
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
});

// Bind the app once, instead of letting supertest bind a fresh ephemeral
// port per request. Declared as its own hook so it runs after the setup
// above, whatever that setup looks like. See helpers/serve.js.
beforeAll(() => {
  app = serve(app);
});

afterAll(() => fs.rmSync(MOCKS_DIR, { recursive: true, force: true }));

describe("simulated latency", () => {
  test("rejects invalid latency values", async () => {
    for (const bad of [-5, 1.5, "fast", 999999]) {
      const res = await request(app)
        .post("/__admin/instance-settings")
        .send({ instanceId: INSTANCE_ID, latency: bad });
      expect(res.status).toBe(400);
    }
    expect(store.instanceSettings[INSTANCE_ID].latency).toBe(0);
  });

  test("accepts a valid latency and exposes it in /config, /health and /state", async () => {
    const res = await request(app)
      .post("/__admin/instance-settings")
      .send({ instanceId: INSTANCE_ID, latency: 80 });
    expect(res.status).toBe(200);
    expect(res.body.settings.latency).toBe(80);

    const cfg = await request(app).get("/__admin/config");
    expect(cfg.body.instanceSettings[INSTANCE_ID].latency).toBe(80);

    const health = await request(app).get("/__admin/health");
    expect(health.body.instances.find((i) => i.id === INSTANCE_ID).latency).toBe(80);

    const state = await request(app).get(`/__admin/state/${INSTANCE_ID}`);
    expect(state.body.latency).toBe(80);
  });

  test("delays mock responses by the configured latency", async () => {
    store.instanceSettings[INSTANCE_ID].latency = 80;
    const t0 = Date.now();
    const res = await request(app).get("/api/ping");
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
    // Allow a little timer slop, but the delay must clearly have applied.
    expect(elapsed).toBeGreaterThanOrEqual(70);

    store.instanceSettings[INSTANCE_ID].latency = 0;
    const t1 = Date.now();
    await request(app).get("/api/ping");
    expect(Date.now() - t1).toBeLessThan(70);
  });
});
