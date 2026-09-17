/**
 * Blocking, end to end — the part the pure rule cannot prove.
 *
 * Boots the real unified proxy and sends real requests through it, because the
 * three claims worth checking are all about sockets: the connection **dies**
 * rather than answering, the attempt still **lands in the log** (a block that
 * leaves no trace is indistinguishable from a broken proxy), and the proxy is
 * **still serving** afterwards — killing a client socket must not take the
 * process with it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const request = require("supertest");

const { startProxyServer } = require("../proxy-server");
const requestLog = require("../utils/request-log");
const loadMocks = require("../utils/mock-loader");
const { basePort } = require("./helpers/ports");

const INSTANCE_ID = "blk";
const PREFERRED_PORT = basePort();

let MOCKS_DIR;
let store;
let proxy;

/** A proxy-style request, resolving to a status or rejecting with the socket error. */
function throughProxy(targetPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://127.0.0.1${targetPath}`,
        method: "GET",
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const setBlocks = (blocks) => {
  store.hostSettings["127.0.0.1"].blocks = blocks;
};

beforeAll(async () => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-blk-"));
  fs.writeFileSync(
    path.join(MOCKS_DIR, "any.mock.js"),
    `module.exports = {
       name: "Any",
       match: () => true,
       respond: (req, res) => res.status(200).json({ ok: true, path: req.path }),
     };`
  );

  store = {
    instanceStatus: { [INSTANCE_ID]: { Any: true } },
    instanceSettings: {
      [INSTANCE_ID]: { isActive: true, targetUrl: "http://127.0.0.1:1", latency: 0 },
    },
    profiles: {},
    hostSettings: {
      "127.0.0.1": { ssl: true, focus: "none", instanceId: INSTANCE_ID, blocks: [] },
    },
    proxyPort: null,
  };

  loadMocks.invalidate();
  requestLog.clearLog();

  proxy = await startProxyServer({
    serverConfigs: [
      { id: INSTANCE_ID, port: 3994, target: "http://127.0.0.1:9", name: "Blocked" },
    ],
    store,
    MOCKS_DIR,
    STATE_FILE: null,
    saveState: () => {},
    preferredPort: PREFERRED_PORT,
  });
  if (!proxy.server.listening) {
    await new Promise((resolve) => proxy.server.once("listening", resolve));
  }
});

afterEach(() => setBlocks([]));

afterAll(async () => {
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
  if (proxy?.server) await new Promise((resolve) => proxy.server.close(resolve));
});

describe("a blocked path", () => {
  test("kills the connection instead of answering", async () => {
    setBlocks(["/orders"]);
    // Not a status — no response at all. That is the whole feature: a client
    // that copes with a 503 has not been shown what a dead service looks like.
    await expect(throughProxy("/orders")).rejects.toMatchObject({
      code: expect.stringMatching(/ECONNRESET|ECONNABORTED|EPIPE|ERR_STREAM/),
    });
  });

  test("beats the mock that would otherwise have answered", async () => {
    // The mock here matches everything, so a 200 would mean the block ran late.
    setBlocks(["/orders"]);
    await expect(throughProxy("/orders")).rejects.toBeDefined();
    expect((await throughProxy("/health")).status).toBe(200);
  });

  test("takes its children with it", async () => {
    setBlocks(["/orders"]);
    await expect(throughProxy("/orders/42")).rejects.toBeDefined();
    await expect(throughProxy("/orders/42/items")).rejects.toBeDefined();
  });

  test("spares a sibling whose name merely starts the same way", async () => {
    setBlocks(["/orders"]);
    expect((await throughProxy("/orders-archive")).status).toBe(200);
  });

  test("still lands in the activity log, flagged and with no status", async () => {
    // A block that leaves no trace is indistinguishable from a broken proxy,
    // and "did my block fire?" is the only question anyone asks of it.
    requestLog.clearLog();
    setBlocks(["/orders"]);
    await expect(throughProxy("/orders/42?deep=1")).rejects.toBeDefined();

    const history = await request(proxy.server).get("/__admin/log-history");
    const entry = history.body.find((e) => e.path.startsWith("/orders/42"));
    expect(entry).toBeDefined();
    expect(entry.source).toBe("blocked");
    expect(entry.status).toBe(0);
    expect(entry.host).toBe("127.0.0.1");
  });

  test("logs the attempt exactly once", async () => {
    requestLog.clearLog();
    setBlocks(["/orders"]);
    await expect(throughProxy("/orders")).rejects.toBeDefined();
    // The socket dying can fire the recorder twice; the guard is what stops a
    // single call showing up as two rows.
    const history = await request(proxy.server).get("/__admin/log-history");
    expect(history.body.filter((e) => e.path === "/orders")).toHaveLength(1);
  });

  test("the proxy is still serving afterwards", async () => {
    // Destroying a client socket must not take the process with it.
    setBlocks(["/orders"]);
    for (let i = 0; i < 5; i++) {
      await expect(throughProxy("/orders")).rejects.toBeDefined();
    }
    expect((await throughProxy("/health")).status).toBe(200);
    expect((await request(proxy.server).get("/__admin/health")).status).toBe(200);
  });

  test("lifting the rule brings the path back", async () => {
    setBlocks(["/orders"]);
    await expect(throughProxy("/orders")).rejects.toBeDefined();
    setBlocks([]);
    expect((await throughProxy("/orders")).status).toBe(200);
  });

  test("the admin route is what the dashboard drives it with", async () => {
    const block = (payload) =>
      request(proxy.server).post("/__admin/hosts/block").send(payload);

    const on = await block({ host: "127.0.0.1", path: "/orders/", blocked: true });
    expect(on.status).toBe(200);
    expect(on.body.blocks).toEqual(["/orders"]); // normalised on the way in
    await expect(throughProxy("/orders")).rejects.toBeDefined();

    const off = await block({ host: "127.0.0.1", path: "/orders", blocked: false });
    expect(off.body.blocks).toEqual([]);
    expect((await throughProxy("/orders")).status).toBe(200);
  });

  test("the read route reports the rules, so a CLI can see what it did", async () => {
    // Reads store.hostSettings, not the host registry: the registry is
    // runtime-only and evicts hosts kept alive purely by a block rule, so a
    // busy session could hide rules that are still killing requests.
    const blocks = (query = "") =>
      request(proxy.server).get(`/__admin/hosts/blocks${query}`);

    setBlocks(["/orders"]);

    const all = await blocks();
    expect(all.status).toBe(200);
    expect(all.body.blocks["127.0.0.1"]).toEqual(["/orders"]);

    const one = await blocks("?host=127.0.0.1");
    expect(one.body.blocks).toEqual(["/orders"]);
    // Reported on every read: with SSL off the rule is stored and inert.
    expect(one.body.ssl).toBe(true);

    // A host with no rules is absent from the map, not an empty array.
    expect((await blocks("?host=nobody.test")).body.blocks).toEqual([]);
    expect(Object.keys((await blocks()).body.blocks)).toEqual(["127.0.0.1"]);
  });

  test("the read route answers 'would this path die', naming the rule", async () => {
    // Exists so the prefix rule stays in one place — a client evaluating it
    // locally would be a third copy of blockCovering, free to drift from the
    // one the proxy enforces.
    const ask = (target) =>
      request(proxy.server).get(
        `/__admin/hosts/blocks?host=127.0.0.1&path=${encodeURIComponent(target)}`
      );

    setBlocks(["/orders"]);

    const child = await ask("/orders/42?deep=1");
    expect(child.body).toMatchObject({
      path: "/orders/42",
      rule: "/orders",
      blocked: true,
    });
    // And the answer matches what the socket actually does.
    await expect(throughProxy("/orders/42?deep=1")).rejects.toBeDefined();

    const sibling = await ask("/orders-archive");
    expect(sibling.body).toMatchObject({ rule: null, blocked: false });
    expect((await throughProxy("/orders-archive")).status).toBe(200);
  });

  test("the read route refuses a path with no host to resolve it against", async () => {
    const res = await request(proxy.server).get("/__admin/hosts/blocks?path=/orders");
    expect(res.status).toBe(400);
    const blank = await request(proxy.server).get(
      "/__admin/hosts/blocks?host=127.0.0.1&path=%20%20"
    );
    expect(blank.status).toBe(400);
  });

  test("the admin route refuses what it cannot act on", async () => {
    const block = (payload) =>
      request(proxy.server).post("/__admin/hosts/block").send(payload);
    expect((await block({ path: "/x", blocked: true })).status).toBe(400);
    expect((await block({ host: "127.0.0.1", blocked: true })).status).toBe(400);
    expect((await block({ host: "127.0.0.1", path: "/x" })).status).toBe(400);
    expect((await block({ host: "127.0.0.1", path: "  ", blocked: true })).status).toBe(
      400
    );
  });
});
