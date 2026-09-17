/**
 * hosts-api.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The /__admin/hosts surface: what the tree's right-click menu drives.
 *
 * The invariants worth protecting are the destructive ones — enabling SSL on a
 * host that's already intercepted must not be treated as a duplicate, and
 * turning SSL back off must not take the host's mock toggles down with it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const createAdminRouter = require("../utils/admin-router");
const instanceManager = require("../utils/instance-manager");
const hostRegistry = require("../utils/host-registry");
const requestLog = require("../utils/request-log");
const loadMocks = require("../utils/mock-loader");

const KNOWN_HOST = "a.test";
const NEW_HOST = "cdn.example.com";

let MOCKS_DIR;
let store;
let serverConfigs;
let app;
let persisted;

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-hosts-"));
  loadMocks.invalidate();
});

afterAll(() => fs.rmSync(MOCKS_DIR, { recursive: true, force: true }));

beforeEach(() => {
  persisted = 0;
  hostRegistry.reset();
  requestLog.clearLog();

  store = {
    instanceStatus: { api: { "Account Locked": true } },
    instanceSettings: {
      api: { isActive: true, targetUrl: `https://${KNOWN_HOST}`, latency: 0 },
    },
    profiles: {},
    hostSettings: {
      [KNOWN_HOST]: { ssl: true, focus: "none", instanceId: "api" },
    },
    dynamicInstances: [],
  };

  serverConfigs = [{ id: "api", port: 3000, target: `https://${KNOWN_HOST}`, name: "A" }];

  hostRegistry.configure(() => store.hostSettings);

  instanceManager.configure(
    instanceManager.createImpl({
      serverConfigs,
      store,
      initInstanceState: (inst) => {
        store.instanceStatus[inst.id] = {};
        store.instanceSettings[inst.id] = {
          isActive: true,
          targetUrl: inst.target,
          latency: 0,
        };
      },
      persist: () => persisted++,
    })
  );

  app = express();
  app.use(express.json());
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE: null,
      store,
      serverConfigs,
      saveState: () => persisted++,
      instanceId: "api",
    })
  );
  // Bound here, not once per request — see helpers/serve.js. Per-test, because
  // this file builds a fresh app per test; the helper closes them all at the end.
  app = serve(app);
});

describe("GET /__admin/hosts", () => {
  test("lists observed hosts with their settings merged in", async () => {
    hostRegistry.seen({ host: KNOWN_HOST, port: 443, protocol: "https" });
    hostRegistry.seen({ host: NEW_HOST, port: 443, protocol: "https" });

    const res = await request(app).get("/__admin/hosts").expect(200);
    const byHost = Object.fromEntries(res.body.hosts.map((h) => [h.host, h]));

    expect(byHost[KNOWN_HOST]).toMatchObject({ ssl: true, instanceId: "api" });
    // A host we merely watched go by is reported, and defaults to not decrypted.
    expect(byHost[NEW_HOST]).toMatchObject({ ssl: false, focus: "none" });
  });

  test("reports connections separately from decrypted requests", async () => {
    hostRegistry.seen({ host: NEW_HOST, port: 443, protocol: "https" });
    hostRegistry.noteRequest({ host: NEW_HOST, status: 200 });

    const res = await request(app).get("/__admin/hosts").expect(200);
    const record = res.body.hosts.find((h) => h.host === NEW_HOST);
    expect(record).toMatchObject({ connections: 1, requests: 1 });
  });
});

describe("POST /__admin/hosts/ssl", () => {
  test("enabling on an already-intercepted host reuses its instance", async () => {
    // Must NOT behave like POST /instances, which 409s on a duplicate host.
    const res = await request(app)
      .post("/__admin/hosts/ssl")
      .send({ host: KNOWN_HOST, enabled: true })
      .expect(200);

    expect(res.body).toMatchObject({ ok: true, ssl: true, instanceId: "api" });
    expect(serverConfigs.filter((c) => c.target.includes(KNOWN_HOST))).toHaveLength(1);
  });

  test("enabling on a discovered host promotes it to an instance", async () => {
    hostRegistry.seen({ host: NEW_HOST, port: 443, protocol: "https" });

    const res = await request(app)
      .post("/__admin/hosts/ssl")
      .send({ host: NEW_HOST, enabled: true })
      .expect(200);

    expect(res.body.ssl).toBe(true);
    const created = serverConfigs.find((c) => c.target === `https://${NEW_HOST}`);
    expect(created).toBeDefined();
    expect(res.body.instanceId).toBe(created.id);
    expect(store.hostSettings[NEW_HOST]).toMatchObject({ ssl: true });
    // A promoted host gets a real port now, so the standalone tier can serve it
    // too. It used to be null to stop one listener opening per browsed host;
    // that set is bounded by the SSL flag instead, and the flag is also what
    // gates the listener.
    expect(created.port).toBe(3001);
  });

  test("a promoted host gets its own mock-state slice", async () => {
    await request(app)
      .post("/__admin/hosts/ssl")
      .send({ host: NEW_HOST, enabled: true })
      .expect(200);

    const created = serverConfigs.find((c) => c.target === `https://${NEW_HOST}`);
    expect(store.instanceSettings[created.id]).toBeDefined();
    expect(store.instanceStatus[created.id]).toBeDefined();
  });

  test("disabling preserves the instance and its mock toggles", async () => {
    // Turning SSL off is not "delete this target" — losing the toggles would be
    // a destructive surprise from what reads like a view switch.
    await request(app)
      .post("/__admin/hosts/ssl")
      .send({ host: KNOWN_HOST, enabled: false })
      .expect(200);

    expect(store.hostSettings[KNOWN_HOST].ssl).toBe(false);
    expect(serverConfigs.some((c) => c.id === "api")).toBe(true);
    expect(store.instanceStatus.api["Account Locked"]).toBe(true);
    expect(store.instanceSettings.api).toBeDefined();
  });

  test("the choice is persisted", async () => {
    await request(app)
      .post("/__admin/hosts/ssl")
      .send({ host: KNOWN_HOST, enabled: false })
      .expect(200);
    expect(persisted).toBeGreaterThan(0);
  });

  test("rejects a missing host or a non-boolean flag", async () => {
    await request(app).post("/__admin/hosts/ssl").send({ enabled: true }).expect(400);
    await request(app)
      .post("/__admin/hosts/ssl")
      .send({ host: NEW_HOST, enabled: "yes" })
      .expect(400);
  });
});

describe("POST /__admin/hosts/focus", () => {
  test("moves a host between tree sections", async () => {
    for (const focus of ["focus", "ignore", "none"]) {
      const res = await request(app)
        .post("/__admin/hosts/focus")
        .send({ host: NEW_HOST, focus })
        .expect(200);
      expect(res.body.focus).toBe(focus);
      expect(store.hostSettings[NEW_HOST].focus).toBe(focus);
    }
  });

  test("focusing a host leaves its SSL setting alone", async () => {
    await request(app)
      .post("/__admin/hosts/focus")
      .send({ host: KNOWN_HOST, focus: "focus" })
      .expect(200);
    expect(store.hostSettings[KNOWN_HOST].ssl).toBe(true);
  });

  test("rejects an unknown focus value", async () => {
    await request(app)
      .post("/__admin/hosts/focus")
      .send({ host: NEW_HOST, focus: "starred" })
      .expect(400);
  });
});

describe("POST /__admin/log-clear", () => {
  beforeEach(() => {
    requestLog.addEntry({ path: "/a", host: KNOWN_HOST, instanceId: "api" });
    requestLog.addEntry({ path: "/b", host: NEW_HOST, instanceId: "other" });
  });

  test("with no body it still clears everything", async () => {
    await request(app).post("/__admin/log-clear").expect(200);
    expect(requestLog.getHistory()).toHaveLength(0);
  });

  test("with a host it clears only that host and resets its counters", async () => {
    hostRegistry.seen({ host: KNOWN_HOST, port: 443, protocol: "https" });

    const res = await request(app)
      .post("/__admin/log-clear")
      .send({ host: KNOWN_HOST })
      .expect(200);

    expect(res.body.removed).toBe(1);
    expect(requestLog.getHistory().map((e) => e.host)).toEqual([NEW_HOST]);
    expect(hostRegistry.get(KNOWN_HOST).connections).toBe(0);
  });
});

describe("DELETE /__admin/hosts/:host", () => {
  test("forgets the host and the instance behind it, leaving no trace", async () => {
    hostRegistry.seen({ host: KNOWN_HOST, port: 443, protocol: "https" });

    const res = await request(app).delete(`/__admin/hosts/${KNOWN_HOST}`).expect(200);

    expect(res.body).toMatchObject({ ok: true, removed: true, instanceId: "api" });
    expect(hostRegistry.get(KNOWN_HOST)).toBeNull();
    expect(store.hostSettings[KNOWN_HOST]).toBeUndefined();
    // The instance used to survive so its mock toggles did too, which is how a
    // "deleted" host kept turning up in the other sections of state.json.
    // Deleting means deleting; the dashboard warns about the toggles first.
    expect(serverConfigs.some((c) => c.id === "api")).toBe(false);
    expect(store.instanceStatus.api).toBeUndefined();
    expect(store.instanceSettings.api).toBeUndefined();
  });

  test("a host with no instance behind it is still forgotten", async () => {
    store.hostSettings[NEW_HOST] = { ssl: false, focus: "ignore", instanceId: null };
    hostRegistry.seen({ host: NEW_HOST, port: 443, protocol: "https" });

    const res = await request(app).delete(`/__admin/hosts/${NEW_HOST}`).expect(200);

    expect(res.body).toMatchObject({ removed: true, instanceId: null });
    expect(store.hostSettings[NEW_HOST]).toBeUndefined();
  });

  test("deleting an unknown host is harmless", async () => {
    const res = await request(app).delete("/__admin/hosts/nope.example.com").expect(200);
    expect(res.body.removed).toBe(false);
  });
});

describe("GET /__admin/proxy/status", () => {
  test("reports the mode the proxy will actually use per target", async () => {
    store.hostSettings[KNOWN_HOST].ssl = false;
    const res = await request(app).get("/__admin/proxy/status").expect(200);
    expect(res.body.interceptedTargets[0]).toMatchObject({
      id: "api",
      host: KNOWN_HOST,
      mode: "TUNNEL",
    });

    store.hostSettings[KNOWN_HOST].ssl = true;
    const on = await request(app).get("/__admin/proxy/status").expect(200);
    expect(on.body.interceptedTargets[0].mode).toBe("MITM");
  });
});

describe("GET /__admin/config", () => {
  test("exposes hostSettings alongside the existing keys", async () => {
    const res = await request(app).get("/__admin/config").expect(200);
    expect(res.body.hostSettings[KNOWN_HOST]).toMatchObject({ ssl: true });
    // Every key the CLI reads is still there.
    ["instances", "mocks", "states", "instanceSettings", "profiles"].forEach((k) =>
      expect(res.body).toHaveProperty(k)
    );
  });
});
