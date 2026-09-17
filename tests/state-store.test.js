/**
 * state-store.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The file layout is the one thing in this repo that runs unattended over data
 * nobody can reconstruct — months of mock toggles, per-host SSL decisions, ports
 * that other tools are pointed at. So the migration is tested against a fixture
 * shaped like a real state.json rather than a minimal one, and the round-trip is
 * asserted to be stable: `load(save(x))` has to be `x`, or every restart quietly
 * rewrites something.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const stateStore = require("../utils/state-store");

let DIR;
let FILE;

// Shaped after the real thing: static targets whose port and name lived in
// config.js, dynamic ones that carried their own, a host promoted by enabling
// SSL (port: null), and a host the user only ever chose to ignore.
const V1 = {
  instanceStatus: {
    api: { "Account Locked": true, "All Offers": false },
    "prod-api": {},
    promoted: { "Some mock": true },
  },
  instanceSettings: {
    api: {
      isActive: true,
      targetUrl: "https://api-qa.example.com",
      latency: 0,
    },
    "prod-api": {
      isActive: false,
      targetUrl: "https://www.example.com",
      latency: 750,
    },
    promoted: { isActive: true, targetUrl: "https://promoted.test", latency: 0 },
  },
  profiles: { smoke: { api: {} } },
  hostSettings: {
    "api-qa.example.com": {
      ssl: true,
      focus: "focus",
      instanceId: "api",
    },
    "www.example.com": {
      ssl: true,
      focus: "none",
      instanceId: "prod-api",
    },
    "promoted.test": { ssl: true, focus: "none", instanceId: "promoted" },
    "ads.example.com": { ssl: false, focus: "ignore", instanceId: null },
  },
  standaloneInstances: true,
  dynamicInstances: [
    {
      id: "prod-api",
      port: 3002,
      target: "https://www.example.com",
      name: "PROD API",
      dynamic: true,
    },
    {
      id: "promoted",
      port: null,
      target: "https://promoted.test",
      name: "promoted.test",
      dynamic: true,
      discovered: true,
    },
  ],
};

// The successor of the `servers` block that used to live in config.js.
const SEEDS = {
  version: 2,
  proxy: { standalone: false },
  instances: [
    {
      id: "api",
      name: "My API",
      host: "api-qa.example.com",
      upstream: "https://api-qa.example.com",
      port: 3000,
      ssl: true,
    },
  ],
  profiles: {},
};

const write = (doc) => fs.writeFileSync(FILE, JSON.stringify(doc, null, 4), "utf8");
const read = () => JSON.parse(fs.readFileSync(FILE, "utf8"));
const entryFor = (doc, host) => doc.instances.find((e) => e.host === host);

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-state-"));
  FILE = path.join(DIR, "state.json");
});

afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("migration from v1", () => {
  test("keeps every mock toggle, which is the data nobody can reconstruct", () => {
    write(V1);
    const loaded = stateStore.load(FILE, { seeds: SEEDS });

    expect(loaded.migrated).toBe(true);
    expect(loaded.instanceStatus.api).toEqual({
      "Account Locked": true,
      "All Offers": false,
    });
    expect(loaded.instanceStatus.promoted).toEqual({ "Some mock": true });
  });

  test("recovers port and name for targets that used to live in config.js", () => {
    write(V1);
    stateStore.load(FILE, { seeds: SEEDS });

    const api = entryFor(read(), "api-qa.example.com");
    // Without the seeds these two are simply absent from a v1 state.json, and
    // "My API" on port 3000 would come back as the bare hostname on a
    // freshly allocated port.
    expect(api.port).toBe(3000);
    expect(api.name).toBe("My API");
  });

  test("gives a host promoted with port:null a port of its own", () => {
    write(V1);
    stateStore.load(FILE, { seeds: SEEDS });

    const promoted = entryFor(read(), "promoted.test");
    expect(Number.isInteger(promoted.port)).toBe(true);
    // Not one already spoken for by another entry.
    expect([3000, 3002]).not.toContain(promoted.port);
  });

  test("carries the non-default settings across", () => {
    write(V1);
    const loaded = stateStore.load(FILE, { seeds: SEEDS });

    expect(loaded.instanceSettings["prod-api"]).toEqual({
      isActive: false,
      targetUrl: "https://www.example.com",
      latency: 750,
    });
    expect(loaded.hostSettings["api-qa.example.com"]).toEqual({
      ssl: true,
      focus: "focus",
      instanceId: "api",
      blocks: [], // v1 had no block rules; the slice still carries the field
    });
    expect(loaded.standaloneInstances).toBe(true);
    expect(loaded.profiles).toEqual({ smoke: { api: {} } });
  });

  test("keeps a host the user only ever chose to ignore", () => {
    write(V1);
    const loaded = stateStore.load(FILE, { seeds: SEEDS });

    const ads = entryFor(read(), "ads.example.com");
    expect(ads).toEqual({ host: "ads.example.com", focus: "ignore" });
    // No id means no instance — just an opinion about a host.
    expect(loaded.serverConfigs.some((c) => c.target.includes("ads.example.com"))).toBe(
      false
    );
    expect(loaded.hostSettings["ads.example.com"].instanceId).toBeNull();
  });

  test("leaves the original next to the new one", () => {
    write(V1);
    stateStore.load(FILE, { seeds: SEEDS });

    const backup = JSON.parse(fs.readFileSync(`${FILE}.v1.bak`, "utf8"));
    expect(backup).toEqual(V1);
  });

  test("runs once — a second load finds v2 and leaves it alone", () => {
    write(V1);
    stateStore.load(FILE, { seeds: SEEDS });
    const afterFirst = read();

    const second = stateStore.load(FILE, { seeds: SEEDS });
    expect(second.migrated).toBe(false);
    expect(read()).toEqual(afterFirst);
  });

  test("survives the seeds being missing", () => {
    write(V1);
    const loaded = stateStore.load(FILE);
    expect(loaded.migrated).toBe(true);
    expect(loaded.instanceStatus.api["Account Locked"]).toBe(true);
  });
});

describe("round trip", () => {
  const runtime = () => ({
    serverConfigs: [
      { id: "api", port: 3000, target: "https://a.test", name: "A" },
      { id: "plain", port: 3001, target: "http://b.test", name: "B" },
    ],
    store: {
      instanceStatus: { api: { "Mock one": true }, plain: {} },
      instanceSettings: {
        api: { isActive: true, targetUrl: "https://elsewhere.test", latency: 250 },
        plain: { isActive: false, targetUrl: "http://b.test", latency: 0 },
      },
      hostSettings: {
        // The block rules ride along so the round trip below covers them too.
        "a.test": {
          ssl: true,
          focus: "focus",
          instanceId: "api",
          blocks: ["/orders", "/health"],
        },
        "b.test": { ssl: true, focus: "none", instanceId: "plain", blocks: [] },
        "ads.test": { ssl: false, focus: "ignore", instanceId: null, blocks: [] },
      },
      profiles: { p: {} },
      standaloneInstances: true,
    },
  });

  test("save then load returns what went in", () => {
    const before = runtime();
    stateStore.save(FILE, before);
    const after = stateStore.load(FILE);

    expect(after.serverConfigs).toEqual(before.serverConfigs);
    expect(after.instanceStatus).toEqual(before.store.instanceStatus);
    expect(after.instanceSettings).toEqual(before.store.instanceSettings);
    // Sorted on write, so the file diffs cleanly however the rules were added.
    expect(after.hostSettings["a.test"].blocks).toEqual(["/health", "/orders"]);
    expect(after.hostSettings).toEqual({
      ...before.store.hostSettings,
      "a.test": {
        ...before.store.hostSettings["a.test"],
        blocks: ["/health", "/orders"],
      },
    });
    expect(after.profiles).toEqual(before.store.profiles);
    expect(after.standaloneInstances).toBe(true);
  });

  test("a host kept only by a block rule survives the save", () => {
    // Rows nobody has an opinion about are dropped from the file; a block rule
    // is very much an opinion, so it has to keep its row alive on its own.
    const input = runtime();
    input.store.hostSettings["blocked-only.test"] = {
      ssl: false,
      focus: "none",
      instanceId: null,
      blocks: ["/dead"],
    };
    stateStore.save(FILE, input);

    expect(entryFor(read(), "blocked-only.test")).toEqual({
      host: "blocked-only.test",
      blocks: ["/dead"],
    });
    expect(stateStore.load(FILE).hostSettings["blocked-only.test"].blocks).toEqual([
      "/dead",
    ]);
  });

  test("rules are normalised on the way in from a hand-edited file", () => {
    write({
      version: 2,
      proxy: {},
      instances: [{ host: "a.test", ssl: true, blocks: ["orders/", "/x?y=1", "  "] }],
      profiles: {},
    });
    // Otherwise a rule can look like it blocks something and match nothing.
    expect(stateStore.load(FILE).hostSettings["a.test"].blocks).toEqual([
      "/orders",
      "/x",
    ]);
  });

  test("is stable — a second save produces a byte-identical file", () => {
    stateStore.save(FILE, runtime());
    const first = fs.readFileSync(FILE, "utf8");

    const reloaded = stateStore.load(FILE);
    stateStore.save(FILE, {
      serverConfigs: reloaded.serverConfigs,
      store: reloaded,
    });

    // Not cosmetic: an unstable round trip means every restart rewrites the file
    // and every `git diff` on it is noise.
    expect(fs.readFileSync(FILE, "utf8")).toBe(first);
  });

  test("keeps an upstream that points somewhere other than the host", () => {
    stateStore.save(FILE, runtime());
    const api = entryFor(read(), "a.test");
    // The whole point of the two fields: intercept a.test, answer from
    // elsewhere.test.
    expect(api.upstream).toBe("https://elsewhere.test");
    expect(stateStore.load(FILE).instanceSettings.api.targetUrl).toBe(
      "https://elsewhere.test"
    );
  });

  test("remembers a plain-http target", () => {
    stateStore.save(FILE, runtime());
    expect(entryFor(read(), "b.test").protocol).toBe("http");
    expect(stateStore.load(FILE).serverConfigs[1].target).toBe("http://b.test");
  });
});

describe("what reaches the file", () => {
  test("omits the defaults, which is what makes it readable", () => {
    stateStore.save(FILE, {
      serverConfigs: [{ id: "a", port: 3000, target: "https://a.test", name: "A" }],
      store: {
        instanceStatus: { a: {} },
        instanceSettings: {
          a: { isActive: true, targetUrl: "https://a.test", latency: 0 },
        },
        hostSettings: { "a.test": { ssl: true, focus: "none", instanceId: "a" } },
      },
    });

    expect(entryFor(read(), "a.test")).toEqual({
      host: "a.test",
      id: "a",
      name: "A",
      upstream: "https://a.test",
      port: 3000,
      ssl: true,
    });
  });

  test("drops a host nobody has an opinion about", () => {
    // Browsing through the proxy surfaces hundreds of CDN and analytics hosts.
    // Writing them all is how state.json used to grow without bound.
    stateStore.save(FILE, {
      serverConfigs: [],
      store: {
        hostSettings: {
          "cdn.test": { ssl: false, focus: "none", instanceId: null },
          "kept.test": { ssl: false, focus: "ignore", instanceId: null },
        },
      },
    });

    expect(read().instances.map((e) => e.host)).toEqual(["kept.test"]);
  });

  test("orders instances before bare hosts, and each group by key", () => {
    stateStore.save(FILE, {
      serverConfigs: [
        { id: "zeta", port: 3001, target: "https://z.test", name: "Z" },
        { id: "alpha", port: 3000, target: "https://a.test", name: "A" },
      ],
      store: {
        instanceSettings: {},
        hostSettings: {
          "z.test": { ssl: true, instanceId: "zeta" },
          "a.test": { ssl: true, instanceId: "alpha" },
          "zzz.test": { ssl: false, focus: "ignore", instanceId: null },
          "aaa.test": { ssl: false, focus: "ignore", instanceId: null },
        },
      },
    });

    expect(read().instances.map((e) => e.id || e.host)).toEqual([
      "alpha",
      "zeta",
      "aaa.test",
      "zzz.test",
    ]);
  });
});

describe("load", () => {
  test("returns null when there is no file yet", () => {
    expect(stateStore.load(path.join(DIR, "absent.json"))).toBeNull();
  });

  test("skips an entry with no host rather than poisoning the registry", () => {
    write({
      version: 2,
      proxy: { standalone: false },
      instances: [
        { id: "broken", name: "Broken" },
        { host: "fine.test", focus: "focus" },
      ],
      profiles: {},
    });

    const loaded = stateStore.load(FILE);
    expect(Object.keys(loaded.hostSettings)).toEqual(["fine.test"]);
    expect(loaded.serverConfigs).toHaveLength(0);
  });
});
