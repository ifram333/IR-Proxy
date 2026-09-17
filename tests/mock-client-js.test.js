const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const createAdminRouter = require("../utils/admin-router");
const loadMocks = require("../utils/mock-loader");
const { MockClient } = require("../clients/js/mock-client");

const INSTANCE_ID = "test";

let MOCKS_DIR;
let app;
let server;
let store;
let client;

beforeAll((done) => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-mockclient-"));
  // Applies to every instance (no `servers` scope).
  fs.writeFileSync(
    path.join(MOCKS_DIR, "login.mock.js"),
    `module.exports = {
       name: "Login",
       match: (req) => req.path === "/api/login" && req.method === "POST",
       respond: (req, res) => res.status(200).json({ token: "abc123" }),
     };`
  );
  // Scoped to a different instance — out of scope for "test" (exercises 409).
  fs.writeFileSync(
    path.join(MOCKS_DIR, "scoped.mock.js"),
    `module.exports = {
       name: "Scoped",
       servers: ["other"],
       match: (req) => req.path === "/api/scoped",
       respond: (req, res) => res.status(200).json({ ok: true }),
     };`
  );

  store = {
    instanceStatus: { [INSTANCE_ID]: { Login: true } },
    instanceSettings: {
      [INSTANCE_ID]: { isActive: true, targetUrl: "http://example.test", latency: 0 },
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
  app.use((req, res) => res.status(404).send("no mock matched"));

  // Explicit port bypasses the client's network autodetection scan — hermetic.
  server = app.listen(0, () => {
    client = new MockClient({ port: server.address().port });
    done();
  });
});

beforeEach(() => {
  // Reset to a known baseline (mutate in place — the router holds this ref).
  store.instanceStatus[INSTANCE_ID] = { Login: true };
});

afterAll((done) => {
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
  server.close(done);
});

describe("MockClient (JS)", () => {
  test("setMock echoes the resulting state; getState reflects it", async () => {
    const off = await client.setMock(INSTANCE_ID, "Login", false);
    expect(off).toEqual({ instanceId: INSTANCE_ID, mockName: "Login", enabled: false });
    expect(await client.getState(INSTANCE_ID, "Login")).toBe(false);

    const on = await client.enable(INSTANCE_ID, "Login");
    expect(on.enabled).toBe(true);
    expect(await client.getState(INSTANCE_ID, "Login")).toBe(true);
  });

  test("getState is tri-state: null when the mock was never toggled", async () => {
    // "Scoped" has no entry in instanceStatus → unset.
    expect(await client.getState(INSTANCE_ID, "Scoped")).toBeNull();
  });

  test("setMocks toggles in bulk and skips out-of-scope mocks", async () => {
    const res = await client.setMocks(INSTANCE_ID, ["Login", "Scoped"], false);
    expect(res.count).toBe(1); // Scoped is skipped (scoped to "other")
    expect(res.mocks).toEqual(["Login"]);
    expect(await client.getState(INSTANCE_ID, "Login")).toBe(false);
  });

  test("listMocks lists every known mock", async () => {
    const names = (await client.listMocks()).map((m) => m.name).sort();
    expect(names).toEqual(["Login", "Scoped"]);
  });

  test("getInstanceState returns summary + states", async () => {
    const state = await client.getInstanceState(INSTANCE_ID);
    expect(state.instanceId).toBe(INSTANCE_ID);
    expect(state.isActive).toBe(true);
    expect(state.states.Login).toBe(true);
    expect(state.summary).toMatchObject({ on: 1 });
  });

  test("withMock restores the prior state and returns the callback result", async () => {
    await client.setMock(INSTANCE_ID, "Login", true);

    const result = await client.withMock(
      { instanceId: INSTANCE_ID, mockName: "Login", enabled: false },
      async () => {
        expect(await client.getState(INSTANCE_ID, "Login")).toBe(false);
        return "did-work";
      }
    );

    expect(result).toBe("did-work");
    expect(await client.getState(INSTANCE_ID, "Login")).toBe(true); // restored
  });

  test("withMock restores even if the callback throws", async () => {
    await client.setMock(INSTANCE_ID, "Login", true);
    await expect(
      client.withMock(
        { instanceId: INSTANCE_ID, mockName: "Login", enabled: false },
        async () => {
          throw new Error("boom");
        }
      )
    ).rejects.toThrow("boom");
    expect(await client.getState(INSTANCE_ID, "Login")).toBe(true); // restored
  });

  test("errors surface as descriptive exceptions", async () => {
    await expect(client.setMock("nope", "Login", true)).rejects.toThrow(/not found/);
    await expect(client.setMock(INSTANCE_ID, "Ghost", true)).rejects.toThrow(/not found/);
    // "Scoped" is scoped to instance "other" → 409 for "test".
    await expect(client.setMock(INSTANCE_ID, "Scoped", true)).rejects.toThrow(
      /does not apply/
    );
  });
});
