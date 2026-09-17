const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const createAdminRouter = require("../utils/admin-router");
const instanceManager = require("../utils/instance-manager");
const loadMocks = require("../utils/mock-loader");

let MOCKS_DIR;
let REQUESTS_DIR;
let store;
let serverConfigs;
let app;
let added = [];
let removed = [];
let renamed = [];

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-inst-"));
  // Saved requests are keyed by instance id too, so a rename has to carry them.
  // Read through the env var at call time, so setting it here is enough.
  REQUESTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-inst-saved-"));
  process.env.IR_PROXY_REQUESTS_DIR = REQUESTS_DIR;

  store = {
    instanceStatus: { api: {} },
    instanceSettings: {
      api: { isActive: true, targetUrl: "https://a.test", latency: 0 },
    },
    profiles: {},
    hostSettings: {
      "a.test": { ssl: true, focus: "none", instanceId: "api" },
    },
  };

  serverConfigs = [{ id: "api", port: 3000, target: "https://a.test", name: "A" }];

  // Exercise the real implementation (the same one server.js wires up), with
  // test stand-ins for the side effects.
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
      persist: () => {},
      onAdded: (inst) => added.push(inst.id),
      onRemoved: (inst) => removed.push(inst.id),
      onRenamed: (inst, oldId) => renamed.push(`${oldId}->${inst.id}`),
    })
  );

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
      instanceId: "api",
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
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
  fs.rmSync(REQUESTS_DIR, { recursive: true, force: true });
  delete process.env.IR_PROXY_REQUESTS_DIR;
});

describe("dynamic instances (integration)", () => {
  let newId;

  test("POST /instances adds an instance on the lowest free port", async () => {
    const res = await request(app)
      .post("/__admin/instances")
      .send({ target: "https://httpbin.test", name: "Bin" });
    expect(res.status).toBe(201);
    expect(res.body.instance).toMatchObject({
      target: "https://httpbin.test",
      name: "Bin",
      port: 3001,
    });
    newId = res.body.instance.id;
    // serverConfigs is mutated in place so the proxy intercepts it live, and the
    // store slice + onAdded hook fired.
    expect(serverConfigs.some((c) => c.id === newId)).toBe(true);
    expect(store.instanceSettings[newId]).toBeDefined();
    expect(added).toContain(newId);
  });

  test("GET /config reflects the new instance", async () => {
    const res = await request(app).get("/__admin/config");
    const inst = res.body.instances.find((i) => i.id === newId);
    expect(inst).toMatchObject({ target: "https://httpbin.test", port: 3001 });
  });

  test("a duplicate target is rejected with 409", async () => {
    const res = await request(app)
      .post("/__admin/instances")
      .send({ target: "https://httpbin.test" });
    expect(res.status).toBe(409);
  });

  test("a missing/invalid target is rejected with 400", async () => {
    expect((await request(app).post("/__admin/instances").send({})).status).toBe(400);
    expect(
      (await request(app).post("/__admin/instances").send({ target: "not a url" })).status
    ).toBe(400);
  });

  test("a name with HTML metacharacters is rejected with 400 (XSS guard)", async () => {
    const res = await request(app).post("/__admin/instances").send({
      target: "https://xss-guard.test",
      name: "<img src=x onerror=alert(1)>",
    });
    expect(res.status).toBe(400);
    // Nothing was registered for the rejected request.
    expect(serverConfigs.some((c) => c.target === "https://xss-guard.test")).toBe(false);
  });

  test("removing an unknown instance returns 404", async () => {
    const res = await request(app).delete("/__admin/instances/nope");
    expect(res.status).toBe(404);
  });

  test("rename re-keys every slice that was keyed by the old id", async () => {
    store.instanceStatus[newId] = { "Some mock": true };

    const res = await request(app)
      .post(`/__admin/instances/${newId}/rename`)
      .send({ id: "Bin Renamed" });

    expect(res.status).toBe(200);
    // Slugified rather than rejected, so the caller is told what it became.
    expect(res.body.id).toBe("bin-renamed");
    expect(serverConfigs.find((c) => c.id === "bin-renamed")).toBeDefined();
    expect(serverConfigs.some((c) => c.id === newId)).toBe(false);
    expect(store.instanceStatus["bin-renamed"]).toEqual({ "Some mock": true });
    expect(store.instanceStatus[newId]).toBeUndefined();
    expect(store.instanceSettings["bin-renamed"]).toBeDefined();
    expect(store.instanceSettings[newId]).toBeUndefined();
    expect(renamed).toContain(`${newId}->bin-renamed`);
    newId = "bin-renamed";
  });

  test("rename repoints the requests saved against that instance", async () => {
    // Saved requests are scoped by instance id exactly like mock files are, so
    // a rename that skipped them would leave them listed but unsendable —
    // pointing at an id that no longer exists.
    const saved = await request(app)
      .post("/__admin/saved-requests")
      .send({ name: "Bound to Bin", instanceId: newId, method: "GET", path: "/ping" });
    expect(saved.status).toBe(200);

    const res = await request(app)
      .post(`/__admin/instances/${newId}/rename`)
      .send({ id: "bin-again" });
    expect(res.status).toBe(200);
    expect(res.body.resaved).toBe(1);

    const list = await request(app).get("/__admin/saved-requests");
    expect(list.body.requests.find((r) => r.id === "bound-to-bin")).toMatchObject({
      instanceId: "bin-again",
      path: "/ping",
    });
    newId = "bin-again";
  });

  test("rename follows the instanceId held in hostSettings", async () => {
    expect(store.hostSettings["a.test"].instanceId).toBe("api");
    const res = await request(app)
      .post("/__admin/instances/api/rename")
      .send({ id: "api-qa" });

    expect(res.status).toBe(200);
    // Miss this and the host keeps a switch pointing at an instance that no
    // longer exists — shouldMitm then refuses to decrypt it.
    expect(store.hostSettings["a.test"].instanceId).toBe("api-qa");

    await request(app).post("/__admin/instances/api-qa/rename").send({ id: "api" });
  });

  test("rename onto an id that already exists is rejected with 409", async () => {
    const res = await request(app)
      .post(`/__admin/instances/${newId}/rename`)
      .send({ id: "api" });
    expect(res.status).toBe(409);
    expect(serverConfigs.some((c) => c.id === newId)).toBe(true);
  });

  test("rename to something with no slug survivors is rejected with 400", async () => {
    const res = await request(app)
      .post(`/__admin/instances/${newId}/rename`)
      .send({ id: "!!!" });
    expect(res.status).toBe(400);
  });

  test("the display name is editable, and trimmed", async () => {
    const res = await request(app)
      .post("/__admin/instance-settings")
      .send({ instanceId: newId, name: "  Renamed Bin  " });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed Bin");
    expect(serverConfigs.find((c) => c.id === newId).name).toBe("Renamed Bin");
    // Purely a label — the id it is scoped by is untouched.
    expect(serverConfigs.some((c) => c.id === newId)).toBe(true);
  });

  test("a name with HTML metacharacters is rejected, and changes nothing", async () => {
    const before = serverConfigs.find((c) => c.id === newId).name;
    const res = await request(app)
      .post("/__admin/instance-settings")
      .send({ instanceId: newId, name: "<img src=x onerror=alert(1)>", latency: 900 });

    expect(res.status).toBe(400);
    expect(serverConfigs.find((c) => c.id === newId).name).toBe(before);
    // The name is validated before anything else is written, so a rejected
    // request doesn't half-apply the rest of the payload.
    expect(store.instanceSettings[newId].latency).not.toBe(900);
  });

  test("an empty name is rejected rather than blanking the label", async () => {
    const res = await request(app)
      .post("/__admin/instance-settings")
      .send({ instanceId: newId, name: "   " });
    expect(res.status).toBe(400);
  });

  test("renaming an unknown instance returns 404", async () => {
    const res = await request(app)
      .post("/__admin/instances/nope/rename")
      .send({ id: "whatever" });
    expect(res.status).toBe(404);
  });

  test("DELETE removes an instance and every slice keyed by it", async () => {
    const res = await request(app).delete(`/__admin/instances/${newId}`);
    expect(res.status).toBe(200);
    expect(serverConfigs.some((c) => c.id === newId)).toBe(false);
    expect(store.instanceStatus[newId]).toBeUndefined();
    expect(store.instanceSettings[newId]).toBeUndefined();
    expect(removed).toContain(newId);
  });

  test("the port a removed instance held is handed to the next one", async () => {
    // The old high-water-mark allocator would have jumped past it forever.
    const res = await request(app)
      .post("/__admin/instances")
      .send({ target: "https://reuse.test" });
    expect(res.status).toBe(201);
    expect(res.body.instance.port).toBe(3001);
  });

  test("every instance is removable now that config.js declares none", async () => {
    const res = await request(app).delete("/__admin/instances/api");
    expect(res.status).toBe(200);
    expect(serverConfigs.some((c) => c.id === "api")).toBe(false);
    // The host's own row goes too — that is what "no trace" means.
    expect(store.hostSettings["a.test"]).toBeUndefined();
  });
});
