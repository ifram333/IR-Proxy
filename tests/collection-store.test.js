/**
 * collection-store unit tests.
 *
 * Two halves, and the split is the point: `groupRequests` is pure and gets the
 * rules that decide what appears on screen (dangling ids, double-listed ids,
 * what counts as ungrouped) with no filesystem in sight; everything else is
 * exercised against a real directory under os.tmpdir(), because the on-disk
 * layout is what it exists to own.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let DIR;
let store;
let requestStore;

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-collections-"));
  process.env.IR_PROXY_REQUESTS_DIR = DIR;
  jest.resetModules();
  store = require("../utils/collection-store");
  requestStore = require("../utils/request-store");
});

afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  delete process.env.IR_PROXY_REQUESTS_DIR;
});

const saveRequest = (name) =>
  requestStore.save({ name, instanceId: "api", method: "GET", path: "/api/x" });

const idsIn = (id) => store.get(id).requests;

describe("create / rename / remove", () => {
  test("creates one with a slugged id and an empty request list", () => {
    const made = store.create("Auth flow");
    expect(made).toMatchObject({ id: "auth-flow", name: "Auth flow", requests: [] });
    expect(store.list().map((c) => c.id)).toEqual(["auth-flow"]);
  });

  test("two collections may share a display name; the ids are uniquified", () => {
    expect(store.create("Auth").id).toBe("auth");
    expect(store.create("Auth").id).toBe("auth-2");
  });

  test("a name with nothing sluggable is refused", () => {
    expect(() => store.create("???")).toThrow(/at least one letter or digit/);
  });

  test("renaming keeps the id, so memberships stay attached", () => {
    store.create("Auth");
    const request = saveRequest("Login");
    store.assign(request.id, "auth");

    const renamed = store.rename("auth", "Authentication");
    expect(renamed).toMatchObject({ id: "auth", name: "Authentication" });
    expect(idsIn("auth")).toEqual([request.id]);
  });

  test("renaming something that is gone reports it rather than creating it", () => {
    expect(store.rename("ghost", "Whatever")).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test("deleting a collection keeps its requests — they are their own files", () => {
    store.create("Auth");
    const request = saveRequest("Login");
    store.assign(request.id, "auth");

    expect(store.remove("auth")).toBe(true);
    expect(store.remove("auth")).toBe(false);
    expect(requestStore.get(request.id)).not.toBeNull();
  });
});

describe("assign", () => {
  beforeEach(() => {
    store.create("Auth");
    store.create("Orders");
  });

  test("appends by default, keeping the order things were added in", () => {
    ["One", "Two", "Three"].forEach((name) => store.assign(saveRequest(name).id, "auth"));
    expect(idsIn("auth")).toEqual(["one", "two", "three"]);
  });

  test("an explicit index inserts there", () => {
    ["One", "Two"].forEach((name) => store.assign(saveRequest(name).id, "auth"));
    store.assign(saveRequest("Middle").id, "auth", 1);
    expect(idsIn("auth")).toEqual(["one", "middle", "two"]);
  });

  test("an index past the end appends rather than leaving a hole", () => {
    store.assign(saveRequest("One").id, "auth");
    store.assign(saveRequest("Two").id, "auth", 99);
    expect(idsIn("auth")).toEqual(["one", "two"]);
  });

  test("re-assigning inside one collection is how reordering works", () => {
    ["One", "Two", "Three"].forEach((name) => store.assign(saveRequest(name).id, "auth"));
    store.assign("three", "auth", 0);
    expect(idsIn("auth")).toEqual(["three", "one", "two"]);
  });

  test("a request lands in exactly one collection, never two", () => {
    const request = saveRequest("Login");
    store.assign(request.id, "auth");
    store.assign(request.id, "orders");
    expect(idsIn("auth")).toEqual([]);
    expect(idsIn("orders")).toEqual([request.id]);
  });

  test("a null collection takes it out without deleting it", () => {
    const request = saveRequest("Login");
    store.assign(request.id, "auth");
    store.assign(request.id, null);
    expect(idsIn("auth")).toEqual([]);
    expect(requestStore.get(request.id)).not.toBeNull();
  });

  test("404s for a collection that no longer exists", () => {
    const request = saveRequest("Login");
    expect(() => store.assign(request.id, "ghost")).toThrow(/no longer exists/);
  });

  test("refuses an id that isn't shaped like one, before touching disk", () => {
    expect(() => store.assign("../../etc/passwd", "auth")).toThrow(/unknown request/);
  });
});

describe("removeRequest", () => {
  test("forgets the id everywhere and reports how many groups changed", () => {
    store.create("Auth");
    const request = saveRequest("Login");
    store.assign(request.id, "auth");

    expect(store.removeRequest(request.id)).toBe(1);
    expect(idsIn("auth")).toEqual([]);
    expect(store.removeRequest(request.id)).toBe(0);
  });
});

describe("the index file", () => {
  test("lives beside the requests, and is not itself listed as one", () => {
    store.create("Auth");
    saveRequest("Login");
    expect(fs.existsSync(path.join(DIR, "_collections.json"))).toBe(true);
    expect(requestStore.list().map((r) => r.id)).toEqual(["login"]);
  });

  test("nonsense on disk reads as no collections instead of throwing", () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, "_collections.json"), "{ not json");
    expect(store.list()).toEqual([]);
  });

  test("entries with an unusable id are dropped, the rest survive", () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DIR, "_collections.json"),
      JSON.stringify({
        collections: [
          { id: "../escape", name: "Bad", requests: [] },
          { id: "auth", name: "Auth", requests: ["login", "../../etc/passwd"] },
        ],
      })
    );
    expect(store.list()).toEqual([
      { id: "auth", name: "Auth", requests: ["login"], createdAt: null },
    ]);
  });
});

describe("groupRequests (pure)", () => {
  const record = (id) => ({ id, name: id, instanceId: "api", path: "/x" });

  test("resolves ids into records, in the collection's order", () => {
    const { collections } = store.groupRequests(
      [{ id: "auth", name: "Auth", requests: ["b", "a"], createdAt: null }],
      [record("a"), record("b")]
    );
    expect(collections[0].requests.map((r) => r.id)).toEqual(["b", "a"]);
  });

  test("an id with no request behind it disappears rather than rendering blank", () => {
    const { collections } = store.groupRequests(
      [{ id: "auth", name: "Auth", requests: ["gone", "a"], createdAt: null }],
      [record("a")]
    );
    expect(collections[0].requests.map((r) => r.id)).toEqual(["a"]);
  });

  test("a hand-edited file listing one request twice shows it once", () => {
    // Otherwise "run this collection" would send it twice, silently.
    const { collections, ungrouped } = store.groupRequests(
      [
        { id: "auth", name: "Auth", requests: ["a"], createdAt: null },
        { id: "orders", name: "Orders", requests: ["a"], createdAt: null },
      ],
      [record("a")]
    );
    expect(collections[0].requests.map((r) => r.id)).toEqual(["a"]);
    expect(collections[1].requests).toEqual([]);
    expect(ungrouped).toEqual([]);
  });

  test("everything nobody claimed is ungrouped", () => {
    const { ungrouped } = store.groupRequests(
      [{ id: "auth", name: "Auth", requests: ["a"], createdAt: null }],
      [record("a"), record("b"), record("c")]
    );
    expect(ungrouped.map((r) => r.id)).toEqual(["b", "c"]);
  });

  test("with no collections at all, every request is ungrouped", () => {
    // The state every request saved before collections existed is already in,
    // which is what makes the feature need no migration.
    const { collections, ungrouped } = store.groupRequests(
      [],
      [record("a"), record("b")]
    );
    expect(collections).toEqual([]);
    expect(ungrouped).toHaveLength(2);
  });
});
