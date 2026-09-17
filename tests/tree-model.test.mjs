/**
 * tree-model.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The left panel's data layer. This is `.mjs` because the dashboard ships as
 * native ES modules with no build step — Jest reads it as ESM directly (see the
 * NODE_OPTIONS flag on the `test` script).
 *
 * What's worth protecting: a chatty endpoint must collapse to ONE leaf (the
 * old log tree made a sibling per request and became unusable), and the
 * focus/ignore partition must never silently drop a host.
 */

import {
  buildTree,
  partitionHosts,
  pathSegments,
  findNode,
  collectEntries,
  SECTIONS,
} from "../public/js/modules/tree-model.js";

const HOST = "api.example.com";

const entry = (over = {}) => ({
  id: Math.random().toString(36).slice(2),
  host: HOST,
  method: "GET",
  path: "/v1/offers",
  status: 200,
  source: "proxy",
  timestamp: "2026-08-04T10:00:00.000Z",
  ...over,
});

const hostRecord = (over = {}) => ({
  host: HOST,
  ssl: true,
  focus: "none",
  instanceId: "api",
  ...over,
});

const sectionOf = (model, key) => model.sections.find((s) => s.key === key);
const firstHost = (model, key = "none") => sectionOf(model, key).hosts[0];

describe("pathSegments", () => {
  test("drops the query string and empty segments", () => {
    expect(pathSegments("/v1//offers/?store=12&x=1")).toEqual(["v1", "offers"]);
  });

  test("returns nothing for a root or missing path", () => {
    expect(pathSegments("/")).toEqual([]);
    expect(pathSegments("")).toEqual([]);
    expect(pathSegments(undefined)).toEqual([]);
  });
});

describe("partitionHosts", () => {
  test("splits hosts into the three sections", () => {
    const out = partitionHosts([
      hostRecord({ host: "a", focus: "focus" }),
      hostRecord({ host: "b", focus: "none" }),
      hostRecord({ host: "c", focus: "ignore" }),
    ]);
    expect(out.focus.map((h) => h.host)).toEqual(["a"]);
    expect(out.none.map((h) => h.host)).toEqual(["b"]);
    expect(out.ignore.map((h) => h.host)).toEqual(["c"]);
  });

  test("an unknown or missing focus falls back to the default section", () => {
    const out = partitionHosts([
      hostRecord({ host: "a", focus: undefined }),
      hostRecord({ host: "b", focus: "starred" }),
    ]);
    expect(out.none.map((h) => h.host)).toEqual(["a", "b"]);
  });

  test("no host is ever dropped", () => {
    const hosts = Array.from({ length: 20 }, (_, i) =>
      hostRecord({ host: `h${i}`, focus: SECTIONS[i % 3] })
    );
    const out = partitionHosts(hosts);
    expect(out.focus.length + out.none.length + out.ignore.length).toBe(20);
  });

  test("tolerates a missing list", () => {
    expect(partitionHosts()).toEqual({ focus: [], none: [], ignore: [] });
  });
});

describe("buildTree structure", () => {
  test("nests path segments into folders under the host", () => {
    const model = buildTree({
      hosts: [hostRecord()],
      entries: [entry({ path: "/v1/offers" })],
    });

    const host = firstHost(model);
    expect(host.kind).toBe("host");
    expect(host.children).toHaveLength(1);

    const folder = host.children[0];
    expect(folder).toMatchObject({ kind: "folder", name: "v1", path: "/v1" });

    const leaf = folder.children[0];
    expect(leaf).toMatchObject({ kind: "leaf", name: "offers", path: "/v1/offers" });
  });

  test("a repeated endpoint collapses into ONE leaf carrying a hit count", () => {
    // The whole reason the old tree fell over: 200 polls made 200 sibling rows.
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry({ timestamp: `2026-08-04T10:00:${String(i % 60).padStart(2, "0")}.000Z` })
    );
    const model = buildTree({ hosts: [hostRecord()], entries });

    const leaf = firstHost(model).children[0].children[0];
    expect(leaf.hits).toBe(200);
    expect(leaf.entries).toHaveLength(200);
    expect(firstHost(model).children[0].children).toHaveLength(1);
  });

  test("sibling endpoints share their parent folder", () => {
    const model = buildTree({
      hosts: [hostRecord()],
      entries: [entry({ path: "/v1/offers" }), entry({ path: "/v1/login" })],
    });

    const folder = firstHost(model).children[0];
    expect(folder.name).toBe("v1");
    expect(folder.children.map((c) => c.name).sort()).toEqual(["login", "offers"]);
    expect(folder.hits).toBe(2);
  });

  test("hosts are sorted alphabetically, not by recency", () => {
    // The registry hands them over most-recently-seen first. Keeping that order
    // would make rows jump under the pointer on every live update.
    const model = buildTree({
      hosts: [
        hostRecord({ host: "zebra.example.com" }),
        hostRecord({ host: "alpha.example.com" }),
        hostRecord({ host: "middle.example.com" }),
      ],
      entries: [],
    });
    expect(sectionOf(model, "none").hosts.map((h) => h.host)).toEqual([
      "alpha.example.com",
      "middle.example.com",
      "zebra.example.com",
    ]);
  });

  test("the same path under different hosts stays separate", () => {
    const model = buildTree({
      hosts: [hostRecord(), hostRecord({ host: "other.example.com" })],
      entries: [entry(), entry({ host: "other.example.com" })],
    });
    expect(sectionOf(model, "none").hosts).toHaveLength(2);
    sectionOf(model, "none").hosts.forEach((h) => expect(h.hits).toBe(1));
  });

  test("a request to the root gets its own clickable leaf", () => {
    const model = buildTree({ hosts: [hostRecord()], entries: [entry({ path: "/" })] });
    const leaf = firstHost(model).children[0];
    expect(leaf).toMatchObject({ kind: "leaf", name: "/", path: "/" });
  });

  test("folders sort before leaves, then alphabetically", () => {
    const model = buildTree({
      hosts: [hostRecord()],
      entries: [
        entry({ path: "/zebra" }),
        entry({ path: "/alpha" }),
        entry({ path: "/beta/nested" }),
      ],
    });
    expect(firstHost(model).children.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "folder:beta",
      "leaf:alpha",
      "leaf:zebra",
    ]);
  });

  test("query strings do not fragment a leaf", () => {
    const model = buildTree({
      hosts: [hostRecord()],
      entries: [entry({ path: "/v1/offers?a=1" }), entry({ path: "/v1/offers?a=2" })],
    });
    const leaf = firstHost(model).children[0].children[0];
    expect(leaf.hits).toBe(2);
  });
});

describe("buildTree: a path that is both an endpoint and a prefix", () => {
  // The bug this covers: `/service-status` and `/service-status/123` used to
  // build a "leaf" and a "folder" side by side carrying the SAME id. Selection
  // is by id, so whichever one `findNode` reached first won and the other was
  // permanently unreachable — the endpoint you could see but never open.
  const model = () =>
    buildTree({
      hosts: [hostRecord()],
      entries: [
        entry({ id: "child", path: "/service-status/123456", status: 200 }),
        entry({ id: "own", path: "/service-status", method: "POST", status: 201 }),
      ],
    });

  test("collapses into ONE node, not a folder and a leaf side by side", () => {
    const host = firstHost(model());
    expect(host.children).toHaveLength(1);
    expect(host.children[0].path).toBe("/service-status");
  });

  test("that node is a folder, and keeps its own calls", () => {
    const node = firstHost(model()).children[0];
    expect(node.kind).toBe("folder");
    expect(node.entries.map((e) => e.id)).toEqual(["own"]);
    expect(node.children.map((c) => c.path)).toEqual(["/service-status/123456"]);
  });

  test("it reports its own latest call, not its child's", () => {
    const node = firstHost(model()).children[0];
    expect(node.method).toBe("POST");
    expect(node.status).toBe(201);
    expect(node.methods).toEqual(["POST"]);
  });

  test("hits count the direct call plus everything beneath", () => {
    const node = firstHost(model()).children[0];
    expect(node.hits).toBe(2);
    expect(node.entries).toHaveLength(1);
  });

  test("every node has a distinct id, so a selection resolves to one thing", () => {
    const built = model();
    const parent = firstHost(built).children[0];
    const child = parent.children[0];
    expect(parent.id).not.toBe(child.id);
    expect(findNode(built, parent.id)).toBe(parent);
    expect(findNode(built, child.id)).toBe(child);
  });

  test("selecting it lists its own call together with its children's", () => {
    // Without this the calls that made it a folder in the first place would be
    // the only ones you could not see.
    const node = firstHost(model()).children[0];
    expect(
      collectEntries(node)
        .map((e) => e.id)
        .sort()
    ).toEqual(["child", "own"]);
  });

  test("order of arrival does not change the result", () => {
    // The child may well be logged before the parent endpoint is ever called.
    const reversed = buildTree({
      hosts: [hostRecord()],
      entries: [
        entry({ id: "own", path: "/service-status", method: "POST", status: 201 }),
        entry({ id: "child", path: "/service-status/123456" }),
      ],
    });
    const node = firstHost(reversed).children[0];
    expect(node.kind).toBe("folder");
    expect(node.hits).toBe(2);
    expect(node.entries.map((e) => e.id)).toEqual(["own"]);
  });

  test("a prefix nobody called directly stays a plain folder with no calls", () => {
    const built = buildTree({
      hosts: [hostRecord()],
      entries: [entry({ path: "/service-status/123456" })],
    });
    const node = firstHost(built).children[0];
    expect(node.kind).toBe("folder");
    expect(node.entries).toEqual([]);
    expect(node.method).toBeNull();
  });

  test("errors on the endpoint itself roll up alongside its children's", () => {
    const built = buildTree({
      hosts: [hostRecord()],
      entries: [
        entry({ path: "/service-status", status: 500 }),
        entry({ path: "/service-status/123456", status: 404 }),
        entry({ path: "/service-status/123456", status: 200 }),
      ],
    });
    const node = firstHost(built).children[0];
    expect(node.errors).toBe(2);
    expect(firstHost(built).errors).toBe(2);
  });
});

describe("buildTree blocking", () => {
  // The rule itself is tested in tests/blocking.test.js; what matters here is
  // that the tree marks the right rows, including ones no request ever hit.
  const built = (blocks, paths = ["/orders", "/orders/42", "/health"]) =>
    buildTree({
      hosts: [hostRecord({ blocks })],
      entries: paths.map((path) => entry({ path })),
    });

  const nodeAt = (model, path) => findNode(model, `${HOST}${path}`);

  test("nothing is blocked when the host has no rules", () => {
    const model = built(undefined);
    expect(nodeAt(model, "/health").blockedBy).toBeNull();
    expect(nodeAt(model, "/health").blockOwner).toBe(false);
  });

  test("the node named by a rule owns it", () => {
    const node = nodeAt(built(["/orders"]), "/orders");
    expect(node.blockedBy).toBe("/orders");
    expect(node.blockOwner).toBe(true);
  });

  test("its children are blocked too, but do not own the rule", () => {
    // Both facts are needed: the child is just as dead, and lifting the rule is
    // not its to offer.
    const child = nodeAt(built(["/orders"]), "/orders/42");
    expect(child.blockedBy).toBe("/orders");
    expect(child.blockOwner).toBe(false);
  });

  test("siblings are untouched", () => {
    expect(nodeAt(built(["/orders"]), "/health").blockedBy).toBeNull();
  });

  test("a sibling whose name merely starts the same way is untouched", () => {
    const model = built(["/orders"], ["/orders", "/orders-archive"]);
    expect(nodeAt(model, "/orders-archive").blockedBy).toBeNull();
  });

  test("a folder that only exists as a prefix still reports the rule", () => {
    // Nobody called /orders directly here, so this node exists purely as a
    // parent — and it is still where the BLOCK tag has to appear.
    const model = built(["/orders"], ["/orders/42"]);
    const folder = nodeAt(model, "/orders");
    expect(folder.kind).toBe("folder");
    expect(folder.entries).toEqual([]);
    expect(folder.blockedBy).toBe("/orders");
    expect(folder.blockOwner).toBe(true);
  });

  test("the most specific rule is the one reported", () => {
    const model = built(["/orders", "/orders/42"], ["/orders/42"]);
    expect(nodeAt(model, "/orders/42").blockedBy).toBe("/orders/42");
    expect(nodeAt(model, "/orders/42").blockOwner).toBe(true);
  });

  test("blocking the root blocks only the root", () => {
    const model = built(["/"], ["/", "/orders"]);
    expect(nodeAt(model, "/").blockOwner).toBe(true);
    expect(nodeAt(model, "/orders").blockedBy).toBeNull();
  });
});

describe("buildTree summaries", () => {
  test("a leaf reports the newest hit and rolls up its methods", () => {
    const model = buildTree({
      hosts: [hostRecord()],
      entries: [
        entry({
          method: "POST",
          status: 500,
          source: "mock",
          timestamp: "2026-08-04T10:00:09.000Z",
        }),
        entry({
          method: "GET",
          status: 200,
          source: "proxy",
          timestamp: "2026-08-04T10:00:01.000Z",
        }),
      ],
    });

    const leaf = firstHost(model).children[0].children[0];
    // Entries arrive newest-first, so the newest is the summary.
    expect(leaf).toMatchObject({ method: "POST", status: 500, source: "mock" });
    expect(leaf.methods.sort()).toEqual(["GET", "POST"]);
    expect(leaf.entries[0].method).toBe("POST");
  });

  test("errors roll up through folders to the host", () => {
    const model = buildTree({
      hosts: [hostRecord()],
      entries: [
        entry({ path: "/v1/a", status: 500 }),
        entry({ path: "/v1/b", status: 0 }),
        entry({ path: "/v1/c", status: 200 }),
      ],
    });

    const host = firstHost(model);
    expect(host).toMatchObject({ hits: 3, errors: 2 });
    expect(host.children[0]).toMatchObject({ hits: 3, errors: 2 });
  });
});

describe("buildTree hosts without traffic", () => {
  test("a known host with no requests still appears, so it can be enabled", () => {
    const model = buildTree({ hosts: [hostRecord({ ssl: false })], entries: [] });
    const host = firstHost(model);
    expect(host.host).toBe(HOST);
    expect(host.hits).toBe(0);
    expect(host.children).toHaveLength(0);
  });

  test("traffic from a host missing from the registry is not dropped", () => {
    const model = buildTree({ hosts: [], entries: [entry()] });
    const host = firstHost(model);
    expect(host).toMatchObject({ host: HOST, synthetic: true, ssl: false });
    expect(host.hits).toBe(1);
  });

  test("entries with no host are ignored rather than making a phantom row", () => {
    const model = buildTree({ hosts: [], entries: [entry({ host: null }), null] });
    expect(sectionOf(model, "none").hosts).toHaveLength(0);
  });
});

describe("buildTree filtering", () => {
  const model = (query) =>
    buildTree({
      hosts: [hostRecord(), hostRecord({ host: "cdn.other.com" })],
      entries: [
        entry({ path: "/v1/offers" }),
        entry({ path: "/v1/login" }),
        entry({ host: "cdn.other.com", path: "/assets/app.js" }),
      ],
      query,
    });

  test("matching a path keeps its host visible", () => {
    // Hiding the host of a matching endpoint would make search look broken.
    const hosts = sectionOf(model("offers"), "none").hosts;
    expect(hosts.map((h) => h.host)).toEqual([HOST]);
    expect(hosts[0].children[0].children.map((c) => c.name)).toEqual(["offers"]);
  });

  test("matching a hostname keeps that host AND all of its requests", () => {
    // Filtering the entries too would show the host row with an empty subtree,
    // which reads as "this host has no traffic" — the opposite of the truth.
    const hosts = sectionOf(model(HOST), "none").hosts;
    expect(hosts.map((h) => h.host)).toEqual([HOST]);
    expect(hosts[0].hits).toBe(2);
    expect(hosts[0].children[0].children.map((c) => c.name).sort()).toEqual([
      "login",
      "offers",
    ]);
  });

  test("a partial hostname match still brings the whole host across", () => {
    const hosts = sectionOf(model("cdn.other"), "none").hosts;
    expect(hosts.map((h) => h.host)).toEqual(["cdn.other.com"]);
    expect(hosts[0].hits).toBe(1);
  });

  test("filters on method and source too", () => {
    expect(sectionOf(model("get"), "none").hosts.length).toBeGreaterThan(0);
    expect(sectionOf(model("proxy"), "none").hosts.length).toBeGreaterThan(0);
  });

  test("reports how many entries survived the filter", () => {
    expect(model("offers").matched).toBe(1);
    expect(model("").matched).toBe(3);
    expect(model("").total).toBe(3);
  });

  test("a filter matching nothing yields empty sections, not a crash", () => {
    const m = model("zzzznope");
    expect(sectionOf(m, "none").hosts).toHaveLength(0);
    expect(m.matched).toBe(0);
  });
});

describe("findNode", () => {
  const model = buildTree({
    hosts: [hostRecord()],
    entries: [entry({ path: "/v1/offers" })],
  });

  test("finds a host, a folder and a leaf by id", () => {
    expect(findNode(model, `host:${HOST}`).kind).toBe("host");
    expect(findNode(model, `${HOST}/v1`).kind).toBe("folder");
    expect(findNode(model, `${HOST}/v1/offers`).kind).toBe("leaf");
  });

  test("returns null for an unknown or missing id", () => {
    expect(findNode(model, "nope")).toBeNull();
    expect(findNode(model, null)).toBeNull();
  });
});

describe("collectEntries", () => {
  const model = buildTree({
    hosts: [hostRecord()],
    entries: [
      entry({ path: "/v1/offers", timestamp: "2026-08-04T10:00:03.000Z" }),
      entry({ path: "/v1/login", timestamp: "2026-08-04T10:00:02.000Z" }),
      entry({ path: "/other", timestamp: "2026-08-04T10:00:01.000Z" }),
    ],
  });

  test("a leaf yields just its own calls", () => {
    expect(collectEntries(findNode(model, `${HOST}/v1/offers`))).toHaveLength(1);
  });

  test("a folder yields everything beneath it, newest first", () => {
    const entries = collectEntries(findNode(model, `${HOST}/v1`));
    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe("/v1/offers");
  });

  test("a host yields all of its calls", () => {
    expect(collectEntries(findNode(model, `host:${HOST}`))).toHaveLength(3);
  });

  test("returns an empty list for nothing selected", () => {
    expect(collectEntries(null)).toEqual([]);
  });
});
