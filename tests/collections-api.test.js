/**
 * /__admin/collections — the endpoints the collections screen talks to.
 *
 * Mounts the admin router on a bare Express app rather than booting the proxy:
 * nothing here sends a request, so there is nothing for a proxy to carry. What
 * needs covering is the seam between the two stores — a saved request being
 * placed, moved, and taken with it when it is deleted.
 *
 * Hermetic: IR_PROXY_REQUESTS_DIR points at a fresh os.tmpdir() directory, so both
 * the request files and the collections index stay out of the real one.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const createAdminRouter = require("../utils/admin-router");
const loadMocks = require("../utils/mock-loader");

const INSTANCE_ID = "api";

let MOCKS_DIR;
let REQUESTS_DIR;
let app;

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-coll-"));
  REQUESTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-coll-saved-"));
  process.env.IR_PROXY_REQUESTS_DIR = REQUESTS_DIR;

  loadMocks.invalidate();

  app = express();
  app.use(express.json());
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE: null,
      store: {
        instanceStatus: { [INSTANCE_ID]: {} },
        instanceSettings: {
          [INSTANCE_ID]: { isActive: true, targetUrl: "https://a.test", latency: 0 },
        },
        profiles: {},
        hostSettings: { "a.test": { ssl: true, focus: "none", instanceId: INSTANCE_ID } },
      },
      serverConfigs: [
        { id: INSTANCE_ID, port: 3000, target: "https://a.test", name: "A" },
      ],
      saveState: () => {},
      instanceId: INSTANCE_ID,
    })
  );
});

afterEach(() => {
  // Each test starts from an empty store: these are files, and they outlive a
  // test the way nothing in memory does.
  fs.readdirSync(REQUESTS_DIR).forEach((name) =>
    fs.rmSync(path.join(REQUESTS_DIR, name), { force: true })
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

const createCollection = (name) =>
  request(app).post("/__admin/collections").send({ name });

const saveRequest = (name, extra = {}) =>
  request(app)
    .post("/__admin/saved-requests")
    .send({
      name,
      instanceId: INSTANCE_ID,
      method: "GET",
      path: `/api/${name.toLowerCase().replace(/\W+/g, "-")}`,
      ...extra,
    });

const fetchAll = async () => (await request(app).get("/__admin/collections")).body;

describe("GET /__admin/collections", () => {
  test("with nothing saved, both halves are empty", async () => {
    expect(await fetchAll()).toEqual({ collections: [], ungrouped: [] });
  });

  test("a request saved with no collection comes back ungrouped", async () => {
    await saveRequest("Login");
    const { collections, ungrouped } = await fetchAll();
    expect(collections).toEqual([]);
    expect(ungrouped.map((r) => r.id)).toEqual(["login"]);
  });

  test("resolves ids into whole records, ready to send", async () => {
    await createCollection("Auth");
    await saveRequest("Login", { headers: { "x-token": "t" }, body: { user: "qa" } });
    await request(app)
      .post("/__admin/collections/assign")
      .send({ requestId: "login", collectionId: "auth" });

    const { collections, ungrouped } = await fetchAll();
    expect(ungrouped).toEqual([]);
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ id: "auth", name: "Auth" });
    expect(collections[0].requests[0]).toMatchObject({
      id: "login",
      instanceId: INSTANCE_ID,
      method: "GET",
      headers: { "x-token": "t" },
      body: { user: "qa" },
    });
  });
});

describe("POST /__admin/collections", () => {
  test("creates one and lists it", async () => {
    const res = await createCollection("Auth flow");
    expect(res.status).toBe(200);
    expect(res.body.collection).toMatchObject({ id: "auth-flow", name: "Auth flow" });
    expect((await fetchAll()).collections.map((c) => c.id)).toEqual(["auth-flow"]);
  });

  test("400 for a name held to the same standard as every other label", async () => {
    expect((await createCollection(undefined)).status).toBe(400);
    expect((await createCollection("   ")).status).toBe(400);
    expect((await createCollection("<img src=x onerror=alert(1)>")).status).toBe(400);
    expect((await createCollection("x".repeat(65))).status).toBe(400);
  });
});

describe("PATCH /__admin/collections/:id", () => {
  test("renames without moving anything out of it", async () => {
    await createCollection("Auth");
    await saveRequest("Login");
    await request(app)
      .post("/__admin/collections/assign")
      .send({ requestId: "login", collectionId: "auth" });

    const res = await request(app)
      .patch("/__admin/collections/auth")
      .send({ name: "Authentication" });
    expect(res.status).toBe(200);

    const { collections } = await fetchAll();
    expect(collections[0]).toMatchObject({ id: "auth", name: "Authentication" });
    expect(collections[0].requests.map((r) => r.id)).toEqual(["login"]);
  });

  test("404 for one that is gone, 400 for a name that isn't allowed", async () => {
    expect(
      (await request(app).patch("/__admin/collections/ghost").send({ name: "x" })).status
    ).toBe(404);
    await createCollection("Auth");
    expect(
      (await request(app).patch("/__admin/collections/auth").send({ name: "" })).status
    ).toBe(400);
  });
});

describe("DELETE /__admin/collections/:id", () => {
  test("deletes the group and keeps the requests, now ungrouped", async () => {
    await createCollection("Auth");
    await saveRequest("Login");
    await request(app)
      .post("/__admin/collections/assign")
      .send({ requestId: "login", collectionId: "auth" });

    expect((await request(app).delete("/__admin/collections/auth")).status).toBe(200);

    const { collections, ungrouped } = await fetchAll();
    expect(collections).toEqual([]);
    expect(ungrouped.map((r) => r.id)).toEqual(["login"]);
  });

  test("404 the second time", async () => {
    await createCollection("Auth");
    await request(app).delete("/__admin/collections/auth");
    expect((await request(app).delete("/__admin/collections/auth")).status).toBe(404);
  });
});

describe("POST /__admin/collections/assign", () => {
  const assign = (payload) =>
    request(app).post("/__admin/collections/assign").send(payload);

  beforeEach(async () => {
    await createCollection("Auth");
    await createCollection("Orders");
  });

  test("order is what comes back, because order is what a run follows", async () => {
    for (const name of ["One", "Two", "Three"]) await saveRequest(name);
    await assign({ requestId: "three", collectionId: "auth" });
    await assign({ requestId: "one", collectionId: "auth" });
    await assign({ requestId: "two", collectionId: "auth", index: 1 });

    const { collections } = await fetchAll();
    const auth = collections.find((c) => c.id === "auth");
    expect(auth.requests.map((r) => r.id)).toEqual(["three", "two", "one"]);
  });

  test("moving to another collection takes it out of the first", async () => {
    await saveRequest("Login");
    await assign({ requestId: "login", collectionId: "auth" });
    await assign({ requestId: "login", collectionId: "orders" });

    const { collections } = await fetchAll();
    expect(collections.find((c) => c.id === "auth").requests).toEqual([]);
    expect(collections.find((c) => c.id === "orders").requests.map((r) => r.id)).toEqual([
      "login",
    ]);
  });

  test("a null collection sends it back to ungrouped, still saved", async () => {
    await saveRequest("Login");
    await assign({ requestId: "login", collectionId: "auth" });
    expect((await assign({ requestId: "login", collectionId: null })).status).toBe(200);

    const { collections, ungrouped } = await fetchAll();
    expect(collections.find((c) => c.id === "auth").requests).toEqual([]);
    expect(ungrouped.map((r) => r.id)).toEqual(["login"]);
  });

  test("404 for a request that isn't saved, or a collection that is gone", async () => {
    await saveRequest("Login");
    expect((await assign({ requestId: "ghost", collectionId: "auth" })).status).toBe(404);
    expect((await assign({ requestId: "login", collectionId: "ghost" })).status).toBe(
      404
    );
  });

  test("404, and no filesystem read, for an id that isn't shaped like one", async () => {
    expect(
      (await assign({ requestId: "../../etc/passwd", collectionId: "auth" })).status
    ).toBe(404);
  });
});

describe("the seam with saved requests", () => {
  test("saving with a collectionId places it there in one call", async () => {
    await createCollection("Auth");
    const res = await saveRequest("Login", { collectionId: "auth" });
    expect(res.status).toBe(200);

    const { collections, ungrouped } = await fetchAll();
    expect(collections[0].requests.map((r) => r.id)).toEqual(["login"]);
    expect(ungrouped).toEqual([]);
  });

  test("saving over it again without one leaves it where it is", async () => {
    // Re-saving says what the request is, not where it belongs.
    await createCollection("Auth");
    await saveRequest("Login", { collectionId: "auth" });
    await saveRequest("Login", { method: "POST" });

    const { collections } = await fetchAll();
    expect(collections[0].requests[0]).toMatchObject({ id: "login", method: "POST" });
  });

  test("deleting the request takes it out of the collection too", async () => {
    await createCollection("Auth");
    await saveRequest("Login", { collectionId: "auth" });
    expect((await request(app).delete("/__admin/saved-requests/login")).status).toBe(200);

    const { collections, ungrouped } = await fetchAll();
    expect(collections[0].requests).toEqual([]);
    expect(ungrouped).toEqual([]);

    // And the slot is really gone: a new request that slugs the same does not
    // inherit the deleted one's place.
    await saveRequest("Login");
    expect((await fetchAll()).ungrouped.map((r) => r.id)).toEqual(["login"]);
  });
});
