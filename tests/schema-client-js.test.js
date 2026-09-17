/**
 * SchemaClient (JS) against the real proxy.
 *
 * Not admin-router-only, unlike the other client tests: this client's whole job
 * is to send a request through the pipeline and report what came back, so
 * anything short of a real proxy would be testing a mock of the thing under
 * test. `startProxyServer` on a high port, with a mock that answers known JSON.
 *
 * What is proven here is the half a client can get wrong: that a failed check
 * is reported as a *failure of the response* rather than of the send, that a
 * collection runs in order, and — the one that matters most — that a request
 * checking nothing is never reported as a pass.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { startProxyServer } = require("../proxy-server");
const requestLog = require("../utils/request-log");
const loadMocks = require("../utils/mock-loader");
const { basePort } = require("./helpers/ports");
const { SchemaClient, ExpectationFailed } = require("../clients/js/schema-client");

const INSTANCE_ID = "sc";
const PREFERRED_PORT = basePort();

let MOCKS_DIR;
let REQUESTS_DIR;
let store;
let proxy;
let client;

/** Save a request straight through the API the dashboard uses. */
async function save(payload) {
  const res = await fetch(`http://127.0.0.1:${proxy.port}/__admin/saved-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId: INSTANCE_ID, path: "/api/order", ...payload }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body.request;
}

async function collection(name) {
  const res = await fetch(`http://127.0.0.1:${proxy.port}/__admin/collections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).collection;
}

beforeAll(async () => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-schemaclient-"));
  REQUESTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-schemaclient-saved-"));
  process.env.IR_PROXY_REQUESTS_DIR = REQUESTS_DIR;

  fs.writeFileSync(
    path.join(MOCKS_DIR, "order.mock.js"),
    `module.exports = {
       name: "Order",
       match: (req) => req.path === "/api/order",
       respond: (req, res) =>
         res.status(200).json({ id: 42, name: "Ada", items: [{ sku: "ABC-1" }] }),
     };`
  );

  store = {
    instanceStatus: { [INSTANCE_ID]: { Order: true } },
    instanceSettings: {
      [INSTANCE_ID]: { isActive: true, targetUrl: "http://127.0.0.1:1", latency: 0 },
    },
    profiles: {},
    hostSettings: { "127.0.0.1": { ssl: true, focus: "none", instanceId: INSTANCE_ID } },
    proxyPort: null,
  };

  loadMocks.invalidate();
  requestLog.clearLog();

  proxy = await startProxyServer({
    serverConfigs: [
      { id: INSTANCE_ID, port: 3994, target: "http://127.0.0.1:9", name: "Order API" },
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

  // Explicit port: autodetection scans 8888+ and would find the developer's own
  // proxy rather than this one.
  client = new SchemaClient({ host: "127.0.0.1", port: proxy.port });
});

afterAll(async () => {
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
  fs.rmSync(REQUESTS_DIR, { recursive: true, force: true });
  delete process.env.IR_PROXY_REQUESTS_DIR;
  if (proxy?.server) await new Promise((resolve) => proxy.server.close(resolve));
});

const GOOD = {
  type: "object",
  required: ["id", "items"],
  properties: {
    id: { type: "integer" },
    items: { type: "array", minItems: 1, items: { type: "object", required: ["sku"] } },
  },
};

describe("run", () => {
  test("reports a passing check", async () => {
    const saved = await save({ name: "Pass me", expect: { status: 200, schema: GOOD } });
    expect(await client.run(saved.id)).toEqual({
      status: 200,
      checked: true,
      passed: true,
      errors: [],
    });
  });

  test("a failed check is a 200 that did not pass, not a failed send", async () => {
    const saved = await save({
      name: "Fail me",
      expect: { status: 201, schema: { type: "object", required: ["total"] } },
    });
    const result = await client.run(saved.id);
    // The distinction the whole feature rests on: the request went out and came
    // back fine (200), the *answer* was wrong.
    expect(result.status).toBe(200);
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([
      "expected status 201, got 200",
      "/total: required property is missing",
    ]);
  });

  test("checked is false, and passed is not true, when nothing was checked", async () => {
    const saved = await save({ name: "Check nothing" });
    expect(await client.run(saved.id)).toEqual({
      status: 200,
      checked: false,
      passed: false,
      errors: [],
    });
  });

  test("an expect argument replaces the stored one", async () => {
    const saved = await save({ name: "Overridable", expect: { status: 404 } });
    const result = await client.run(saved.id, {
      expect: { schema: { type: "object", required: ["id"] } },
    });
    expect(result.passed).toBe(true); // the stored "expect 404" was not applied
  });

  test("an explicit null expect checks nothing", async () => {
    const saved = await save({ name: "Silenceable", expect: { status: 404 } });
    expect((await client.run(saved.id, { expect: null })).checked).toBe(false);
  });

  test("a schema the server cannot honour surfaces as an error, not a pass", async () => {
    const saved = await save({ name: "Unhonourable at send" });
    await expect(
      client.run(saved.id, { expect: { schema: { $ref: "#/x" } } })
    ).rejects.toThrow(/\$ref/);
  });

  test("a missing id is an error", async () => {
    await expect(client.run("no-such-thing")).rejects.toThrow(/no longer exists/);
  });
});

describe("assertPasses", () => {
  test("returns the result when the check passed", async () => {
    const saved = await save({ name: "Assert pass", expect: { schema: GOOD } });
    expect((await client.assertPasses(saved.id)).passed).toBe(true);
  });

  test("throws ExpectationFailed with the errors as a list", async () => {
    const saved = await save({
      name: "Assert fail",
      expect: { schema: { type: "object", properties: { id: { type: "string" } } } },
    });
    // Its own type, so a suite can catch a wrong *answer* separately from a
    // request that could not be sent at all. And `.errors` is a list, not one
    // long string, so a runner can print one problem per line.
    await expect(client.assertPasses(saved.id)).rejects.toBeInstanceOf(ExpectationFailed);
    await expect(client.assertPasses(saved.id)).rejects.toMatchObject({
      errors: ["/id: expected string, got number"],
    });
  });

  test("throws on a request that checks nothing rather than passing it", async () => {
    // The guard the whole client exists for: an assertion that looked at
    // nothing and returned green is worse than no assertion at all.
    const saved = await save({ name: "Hollow assert" });
    await expect(client.assertPasses(saved.id)).rejects.toThrow(/has no expectation/);
  });

  test("requireCheck: false accepts one, deliberately", async () => {
    const saved = await save({ name: "Hollow but intended" });
    const lenient = new SchemaClient({
      host: "127.0.0.1",
      port: proxy.port,
      requireCheck: false,
    });
    expect((await lenient.assertPasses(saved.id)).checked).toBe(false);
  });

  test("an expectation supplied here satisfies the guard", async () => {
    const saved = await save({ name: "Hollow but supplied" });
    expect(
      (await client.assertPasses(saved.id, { expect: { schema: GOOD } })).passed
    ).toBe(true);
  });
});

describe("checks", () => {
  test("says which saved requests check anything", async () => {
    const checked = await save({ name: "Has a check", expect: { status: 200 } });
    const bare = await save({ name: "Has none" });

    const byId = Object.fromEntries((await client.checks()).map((c) => [c.id, c]));
    expect(byId[checked.id]).toMatchObject({
      checked: true,
      method: "GET",
      path: "/api/order",
    });
    expect(byId[bare.id].checked).toBe(false);
    expect(byId[bare.id].expect).toBeNull();
  });
});

describe("collections", () => {
  test("runs in order, does not stop at the first failure, and labels each row", async () => {
    const group = await collection("Ordered flow");
    // Saved in this order, and the run has to follow it — "log in, then call
    // the thing that needs the token" is the shape these have.
    const first = await save({
      name: "Step one",
      collectionId: group.id,
      expect: { schema: GOOD },
    });
    const second = await save({
      name: "Step two",
      collectionId: group.id,
      expect: { schema: { type: "object", required: ["nope"] } },
    });
    const third = await save({ name: "Step three", collectionId: group.id });

    const results = await client.runCollection(group.id);
    expect(results.map((r) => r.id)).toEqual([first.id, second.id, third.id]);
    expect(results.map((r) => r.name)).toEqual(["Step one", "Step two", "Step three"]);
    // The row after the red one still ran: a run is how you find out *where* a
    // flow breaks.
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[2].checked).toBe(false);
  });

  test("can be addressed by name as well as by id", async () => {
    const group = await collection("By name");
    await save({ name: "Only step", collectionId: group.id, expect: { schema: GOOD } });
    expect(await client.runCollection("By name")).toHaveLength(1);
  });

  test("assertCollectionPasses names the request beside each problem", async () => {
    const group = await collection("Failing flow");
    await save({ name: "Fine", collectionId: group.id, expect: { schema: GOOD } });
    await save({
      name: "Broken",
      collectionId: group.id,
      expect: { status: 500, schema: { type: "object", required: ["absent"] } },
    });

    await expect(client.assertCollectionPasses(group.id)).rejects.toMatchObject({
      // "something in the flow broke" is not an answer anybody can act on.
      errors: [
        "Broken: expected status 500, got 200",
        "Broken: /absent: required property is missing",
      ],
    });
  });

  test("an unchecked request in a collection is a problem, not a pass", async () => {
    const group = await collection("Half-checked flow");
    await save({
      name: "Checked step",
      collectionId: group.id,
      expect: { schema: GOOD },
    });
    await save({ name: "Unchecked step", collectionId: group.id });

    await expect(client.assertCollectionPasses(group.id)).rejects.toMatchObject({
      errors: ["Unchecked step: nothing was checked"],
    });
  });

  test("passes when every request checked and every check passed", async () => {
    const group = await collection("Green flow");
    await save({
      name: "All good one",
      collectionId: group.id,
      expect: { schema: GOOD },
    });
    await save({ name: "All good two", collectionId: group.id, expect: { status: 200 } });
    expect(await client.assertCollectionPasses(group.id)).toHaveLength(2);
  });

  test("an unknown collection lists the ones that exist", async () => {
    await expect(client.runCollection("ghost")).rejects.toThrow(/Known: /);
  });
});
