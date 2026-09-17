/**
 * BlockClient (JS) against the real admin router.
 *
 * Hermetic: only the router is mounted, so nothing here decrypts or destroys a
 * socket — `tests/blocking-api.test.js` owns that half. What is proven here is
 * the half a client can get wrong: that the rule it sets is the rule the server
 * ends up holding, that `withBlock` puts the host back exactly as it found it
 * even when adding a rule *removed* others, and that a rule which cannot
 * possibly fire is reported as such instead of quietly succeeding.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const createAdminRouter = require("../utils/admin-router");
const loadMocks = require("../utils/mock-loader");
const { BlockClient } = require("../clients/js/block-client");

const INSTANCE_ID = "test";
const HOST = "api.example.test";
const TUNNELED = "cdn.example.test";

let MOCKS_DIR;
let server;
let store;
let client;

beforeAll((done) => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-blockclient-"));

  store = {
    instanceStatus: { [INSTANCE_ID]: {} },
    instanceSettings: {
      [INSTANCE_ID]: { isActive: true, targetUrl: `http://${HOST}`, latency: 0 },
    },
    profiles: {},
    hostSettings: {},
  };
  const serverConfigs = [
    { id: INSTANCE_ID, port: 3998, target: `http://${HOST}`, name: "Test" },
  ];

  loadMocks.invalidate();

  const app = express();
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

  // Explicit port bypasses the client's network autodetection scan — hermetic.
  server = app.listen(0, () => {
    client = new BlockClient({ port: server.address().port });
    done();
  });
});

beforeEach(() => {
  // Mutate in place — the router holds this ref.
  store.hostSettings[HOST] = {
    ssl: true,
    focus: "none",
    instanceId: INSTANCE_ID,
    blocks: [],
  };
  store.hostSettings[TUNNELED] = {
    ssl: false,
    focus: "none",
    instanceId: null,
    blocks: [],
  };
});

afterAll((done) => {
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
  server.close(done);
});

describe("BlockClient (JS)", () => {
  test("block returns the resulting rules; unblock lifts them", async () => {
    expect(await client.block(HOST, "/orders")).toEqual(["/orders"]);
    expect(await client.listBlocks(HOST)).toEqual(["/orders"]);
    expect(await client.unblock(HOST, "/orders")).toEqual([]);
  });

  test("the path is normalised on the way in", async () => {
    // The dashboard sends paths straight off the tree; a CLI user types them.
    expect(await client.block(HOST, "/orders/?page=2")).toEqual(["/orders"]);
  });

  test("blocking a folder absorbs the narrower rules under it", async () => {
    await client.block(HOST, "/orders/42");
    // Two rules where one decides everything is a list nobody trusts.
    expect(await client.block(HOST, "/orders")).toEqual(["/orders"]);
  });

  test("ruleFor names the rule in play, so a child can point at its parent", async () => {
    await client.block(HOST, "/orders");
    expect(await client.ruleFor(HOST, "/orders/42")).toBe("/orders");
    expect(await client.isBlocked(HOST, "/orders/42")).toBe(true);
    // Prefix matching on raw strings is how you take down a neighbour.
    expect(await client.ruleFor(HOST, "/orders-archive")).toBeNull();
    expect(await client.isBlocked(HOST, "/orders-archive")).toBe(false);
  });

  test("unblock is exact — a child stays blocked by its parent's rule", async () => {
    await client.block(HOST, "/orders");
    expect(await client.unblock(HOST, "/orders/42")).toEqual(["/orders"]);
    expect(await client.isBlocked(HOST, "/orders/42")).toBe(true);
  });

  test("listBlocks with no host reports every host that has rules", async () => {
    await client.block(HOST, "/orders");
    const all = await client.listBlocks();
    expect(all).toEqual({ [HOST]: ["/orders"] });
    // A host with no rules is absent, not an empty array.
    expect(Object.keys(all)).not.toContain(TUNNELED);
  });

  test("clearBlocks lifts everything on the host", async () => {
    await client.block(HOST, "/orders");
    await client.block(HOST, "/health");
    expect(await client.clearBlocks(HOST)).toEqual([]);
    expect(await client.listBlocks(HOST)).toEqual([]);
  });

  test("withBlock restores the prior rules and returns the callback result", async () => {
    await client.block(HOST, "/health");

    const result = await client.withBlock({ host: HOST, path: "/orders" }, async () => {
      expect(await client.isBlocked(HOST, "/orders/42")).toBe(true);
      return "did-work";
    });

    expect(result).toBe("did-work");
    expect(await client.listBlocks(HOST)).toEqual(["/health"]);
  });

  test("withBlock restores even if the callback throws", async () => {
    await expect(
      client.withBlock({ host: HOST, path: "/orders" }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await client.listBlocks(HOST)).toEqual([]);
  });

  test("withBlock resurrects a rule its own block absorbed", async () => {
    // The case an unblock-what-I-added restore gets wrong: blocking /orders
    // DROPS /orders/42, so lifting /orders alone leaves the host less blocked
    // than it started.
    await client.block(HOST, "/orders/42");
    await client.withBlock({ host: HOST, path: "/orders" }, async () => {
      expect(await client.listBlocks(HOST)).toEqual(["/orders"]);
    });
    expect(await client.listBlocks(HOST)).toEqual(["/orders/42"]);
  });

  test("blocking a tunneled host throws instead of storing a rule that never fires", async () => {
    await expect(client.block(TUNNELED, "/orders")).rejects.toThrow(
      /SSL proxying is off/
    );
    expect(await client.isIntercepted(TUNNELED)).toBe(false);
    expect(await client.isIntercepted(HOST)).toBe(true);
    // The rule IS stored — the guard is about the caller's expectations, not
    // about refusing the write.
    expect(await client.listBlocks(TUNNELED)).toEqual(["/orders"]);
  });

  test("requireSsl: false stages rules on a host not yet intercepted", async () => {
    const staging = new BlockClient({
      port: server.address().port,
      requireSsl: false,
    });
    expect(await staging.block(TUNNELED, "/orders")).toEqual(["/orders"]);
  });

  test("errors surface as descriptive exceptions", async () => {
    await expect(client.block(HOST, "   ")).rejects.toThrow(/path is required/);
    await expect(client.block("", "/orders")).rejects.toThrow(/host is required/);
  });
});
