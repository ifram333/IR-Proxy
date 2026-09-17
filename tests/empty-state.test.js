/**
 * A first run — nothing configured at all.
 *
 * `state.example.json` seeds an **empty** `instances` list, so this is what a
 * fresh clone boots into, and it is also where you land after removing your
 * last host. Both have to be a working dashboard rather than a dead one, and
 * that was not free: `/__admin` used to be mounted only `if (serverConfigs[0])`
 * (`proxy-server.js`), so with no instances the static handler still served the
 * page and every call it made came back 404 — no tree, no config, and no way to
 * add the instance that would have brought the API back.
 *
 * The router is exercised here rather than through `startProxyServer`: what has
 * to hold is that every read the dashboard makes on load answers with an empty
 * store instead of throwing on the instance that isn't there. That the router is
 * *mounted* unconditionally is a two-line decision in `proxy-server.js`, and a
 * fifth listening proxy in this suite costs more in flakiness than that line is
 * worth in coverage.
 *
 * Hermetic: tmpdirs for mocks (empty, like a fresh clone's), saved requests and
 * schemas; no sockets.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const createAdminRouter = require("../utils/admin-router");
const loadMocks = require("../utils/mock-loader");

let MOCKS_DIR;
let REQUESTS_DIR;
let SCHEMAS_DIR;
let store;
let app;

beforeAll(() => {
  // Empty on purpose: `mocks/` ships with only a .gitkeep, because the mocks in
  // a checkout belong to whatever that team is mocking.
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-empty-"));
  REQUESTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-empty-saved-"));
  SCHEMAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-empty-schemas-"));
  process.env.IR_PROXY_REQUESTS_DIR = REQUESTS_DIR;
  process.env.IR_PROXY_SCHEMAS_DIR = SCHEMAS_DIR;

  // Exactly the shape state-store produces from the shipped seed.
  store = {
    instanceStatus: {},
    instanceSettings: {},
    hostSettings: {},
    profiles: {},
    proxyPort: null,
  };

  loadMocks.invalidate();

  app = express();
  app.use(express.json());
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE: null,
      store,
      serverConfigs: [], // ← the whole point
      saveState: () => {},
      // What proxy-server.js passes when there is no first instance. It is only
      // `/config`'s `currentInstanceId`, which the mock matrix uses to highlight
      // a column — and with no instances there is no column.
      instanceId: null,
    })
  );
});

// Bind the app once, instead of letting supertest bind a fresh ephemeral
// port per request. Declared as its own hook so it runs after the setup
// above, whatever that setup looks like. See helpers/serve.js.
beforeAll(() => {
  app = serve(app);
});

afterAll(() => {
  [MOCKS_DIR, REQUESTS_DIR, SCHEMAS_DIR].forEach((d) =>
    fs.rmSync(d, { recursive: true, force: true })
  );
  delete process.env.IR_PROXY_REQUESTS_DIR;
  delete process.env.IR_PROXY_SCHEMAS_DIR;
});

describe("the admin API with nothing configured", () => {
  test("/config answers with empty collections, not an error", async () => {
    const res = await request(app).get("/__admin/config");

    expect(res.status).toBe(200);
    expect(res.body.instances).toEqual([]);
    expect(res.body.mocks).toEqual([]);
    expect(res.body.states).toEqual({});
    // Null, not a stale id borrowed from somewhere: there is nothing current.
    expect(res.body.currentInstanceId).toBeNull();
  });

  test("every read the dashboard makes on load answers 200", async () => {
    for (const route of [
      "/__admin/hosts",
      "/__admin/hosts/blocks",
      "/__admin/log-history",
      "/__admin/mock-stats",
      "/__admin/saved-requests",
      "/__admin/collections",
      "/__admin/schemas",
      "/__admin/proxy/status",
    ]) {
      const res = await request(app).get(route);
      // The route is in the matcher so a failure names which one broke.
      expect([route, res.status]).toEqual([route, 200]);
    }
  });

  test("acting on an instance that isn't there is a clean 404, not a crash", async () => {
    const res = await request(app)
      .post("/__admin/toggle")
      .send({ instanceId: "nope", mockName: "Whatever", enabled: true });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error).toBeTruthy();
  });
});
