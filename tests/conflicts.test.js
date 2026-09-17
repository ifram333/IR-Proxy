/**
 * conflicts.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The CONFLICT badge on the mocks screen.
 *
 * A conflict means "two enabled mocks would both match, and which one answers is
 * an accident of load order". That can only happen inside one instance's
 * pipeline, so two mocks scoped to different instances are not a conflict — they
 * are the ordinary way of mocking the same endpoint for two environments, and
 * flagging that is how a warning becomes noise people click past.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const createAdminRouter = require("../utils/admin-router");
const loadMocks = require("../utils/mock-loader");

const SAME_MATCH = `(req) => req.method === "GET" && req.path === "/offers"`;
/** A distinct match() source, so mocks land in a group of their own. */
const matchOn = (p) => `(req) => req.method === "GET" && req.path === "${p}"`;

let MOCKS_DIR;
let app;

/** One mock per file; mocks sharing a match() source land in the same group. */
const writeMock = (file, name, servers, match = SAME_MATCH) => {
  fs.writeFileSync(
    path.join(MOCKS_DIR, file),
    `module.exports = {
       name: ${JSON.stringify(name)},
       ${servers ? `servers: ${JSON.stringify(servers)},` : ""}
       match: ${match},
       respond: (req, res) => res.status(200).json({ from: ${JSON.stringify(name)} }),
     };`
  );
};

const conflicts = async () => {
  const res = await request(app).get("/__admin/config").expect(200);
  return res.body.mocks
    .filter((m) => m.hasConflict)
    .map((m) => m.name)
    .sort();
};

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-conflict-"));

  // One signature group per case, deliberately. Put an unscoped mock in with the
  // per-host pair below and it legitimately collides with both, which would make
  // the first assertion test the fixture rather than the rule.

  // The shape this came from: the same endpoint recorded once per host.
  writeMock("offers_a.mock.js", "Offers (api)", ["api"]);
  writeMock("offers_b.mock.js", "Offers (auth)", ["auth"]);
  // Same scope, same match — a real collision.
  writeMock("dup_a.mock.js", "Dup one", ["api"], matchOn("/dup"));
  writeMock("dup_b.mock.js", "Dup two", ["api"], matchOn("/dup"));
  // Unscoped: live in every pipeline, so it meets the scoped one beside it.
  writeMock("global_a.mock.js", "Everywhere", null, matchOn("/global"));
  writeMock("global_b.mock.js", "Only on auth", ["auth"], matchOn("/global"));
  // A match nobody else shares.
  writeMock("alone.mock.js", "Alone", ["ghost"], matchOn("/alone"));

  loadMocks.invalidate();

  const serverConfigs = [
    { id: "api", port: 3999, target: "http://a.test", name: "A" },
    { id: "auth", port: 3998, target: "http://b.test", name: "B" },
  ];

  app = express();
  app.use(express.json());
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE: null,
      store: {
        instanceStatus: {},
        instanceSettings: { api: { isActive: true, targetUrl: "http://a.test" } },
        profiles: {},
      },
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

afterAll(() => fs.rmSync(MOCKS_DIR, { recursive: true, force: true }));

describe("CONFLICT detection", () => {
  test("mocks scoped to different instances are not in conflict", async () => {
    // This is the bug: identical match(), disjoint scopes. Neither can ever see
    // the other, because a pipeline is built for one instance at a time.
    const flagged = await conflicts();
    expect(flagged).not.toContain("Offers (api)");
    expect(flagged).not.toContain("Offers (auth)");
  });

  test("mocks sharing a scope and a match are in conflict", async () => {
    const flagged = await conflicts();
    expect(flagged).toEqual(expect.arrayContaining(["Dup one", "Dup two"]));
  });

  test("an unscoped mock conflicts with any scoped one sharing its match", async () => {
    // A null scope is live in every pipeline, so it meets everything.
    const flagged = await conflicts();
    expect(flagged).toEqual(expect.arrayContaining(["Everywhere", "Only on auth"]));
  });

  test("a mock with a match of its own is never flagged", async () => {
    expect(await conflicts()).not.toContain("Alone");
  });

  test("nothing else is flagged", async () => {
    // Pinned exactly: a rule that over-flags is the bug being fixed, and an
    // arrayContaining assertion would not have caught it.
    expect(await conflicts()).toEqual([
      "Dup one",
      "Dup two",
      "Everywhere",
      "Only on auth",
    ]);
  });
});

describe("CONFLICT detection, scoped pairs only", () => {
  let scopedApp;
  let SCOPED_DIR;

  beforeAll(() => {
    SCOPED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-conflict2-"));
    const write = (file, name, servers) =>
      fs.writeFileSync(
        path.join(SCOPED_DIR, file),
        `module.exports = {
           name: ${JSON.stringify(name)},
           servers: ${JSON.stringify(servers)},
           match: ${SAME_MATCH},
           respond: (req, res) => res.status(200).json({}),
         };`
      );
    write("a.mock.js", "Scoped A", ["api"]);
    write("b.mock.js", "Scoped B", ["auth"]);
    write("c.mock.js", "Scoped C", ["prod"]);
    // Overlaps A but not B or C.
    write("d.mock.js", "Scoped D", ["api", "staging"]);

    loadMocks.invalidate();
    scopedApp = express();
    scopedApp.use(express.json());
    scopedApp.use(
      "/__admin",
      createAdminRouter({
        MOCKS_DIR: SCOPED_DIR,
        STATE_FILE: null,
        store: { instanceStatus: {}, instanceSettings: {}, profiles: {} },
        serverConfigs: [],
        saveState: () => {},
        instanceId: "api",
      })
    );
  });

  afterAll(() => {
    fs.rmSync(SCOPED_DIR, { recursive: true, force: true });
    loadMocks.invalidate();
  });

  test("only the pair that actually overlaps is flagged", async () => {
    const res = await request(scopedApp).get("/__admin/config").expect(200);
    const flagged = res.body.mocks
      .filter((m) => m.hasConflict)
      .map((m) => m.name)
      .sort();
    // Four mocks, one match() between them, but only A and D share an instance.
    // A group being large is not the test — being pairwise reachable is.
    expect(flagged).toEqual(["Scoped A", "Scoped D"]);
  });
});
