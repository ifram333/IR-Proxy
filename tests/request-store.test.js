/**
 * request-store unit tests — the on-disk layout of saved requests.
 *
 * Hermetic: IR_PROXY_REQUESTS_DIR points at a fresh os.tmpdir() directory per run,
 * so nothing here can touch the real `requests/` folder.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let DIR;
let store;

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-reqstore-"));
  process.env.IR_PROXY_REQUESTS_DIR = DIR;
  jest.resetModules();
  store = require("../utils/request-store");
});

afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  delete process.env.IR_PROXY_REQUESTS_DIR;
});

const base = {
  name: "Login as QA",
  instanceId: "api",
  method: "POST",
  path: "/api/login",
  headers: { "content-type": "application/json" },
  body: { user: "qa" },
};

describe("save / get / list", () => {
  test("round-trips a saved request", () => {
    const saved = store.save(base);
    expect(saved.id).toBe("login-as-qa");
    expect(saved.savedAt).toEqual(expect.any(String));

    const read = store.get("login-as-qa");
    expect(read).toMatchObject({
      id: "login-as-qa",
      name: "Login as QA",
      instanceId: "api",
      method: "POST",
      path: "/api/login",
      body: { user: "qa" },
    });
  });

  test("the id is a slug of the name, and the name is what's stored", () => {
    // Decoupling the two is what keeps the filename safe: it's generated, never
    // taken from the client.
    const saved = store.save({ ...base, name: "Get user // profile (QA)" });
    expect(saved.id).toBe("get-user-profile-qa");
    expect(store.get(saved.id).name).toBe("Get user // profile (QA)");
  });

  test("saving the same name again is an update, not a duplicate", () => {
    store.save(base);
    const second = store.save({ ...base, path: "/api/login/v2" });
    expect(second.id).toBe("login-as-qa");
    expect(store.list()).toHaveLength(1);
    expect(store.get("login-as-qa").path).toBe("/api/login/v2");
  });

  test("a different name that slugs the same gets its own id", () => {
    // Otherwise "Get user (QA)" would silently replace "Get user — QA".
    const a = store.save({ ...base, name: "Get user (QA)" });
    const b = store.save({ ...base, name: "Get user — QA" });
    expect(a.id).toBe("get-user-qa");
    expect(b.id).toBe("get-user-qa-2");
    expect(store.list()).toHaveLength(2);
  });

  test("list is newest-first", async () => {
    store.save({ ...base, name: "First" });
    await new Promise((r) => setTimeout(r, 5)); // distinct savedAt
    store.save({ ...base, name: "Second" });
    expect(store.list().map((r) => r.name)).toEqual(["Second", "First"]);
  });

  test("an empty or missing directory lists as nothing, not an error", () => {
    expect(store.list()).toEqual([]);
    fs.rmSync(DIR, { recursive: true, force: true });
    expect(store.list()).toEqual([]);
  });

  test("a file hand-edited into nonsense is skipped, not fatal", () => {
    store.save(base);
    fs.writeFileSync(path.join(DIR, "broken.request.json"), "{not json");
    expect(store.list().map((r) => r.id)).toEqual(["login-as-qa"]);
  });

  test("only .request.json files are listed", () => {
    store.save(base);
    fs.writeFileSync(path.join(DIR, "notes.txt"), "hello");
    expect(store.list()).toHaveLength(1);
  });

  test("rejects a name with nothing sluggable in it", () => {
    expect(() => store.save({ ...base, name: "///" })).toThrow(/letter or digit/);
  });

  test("refuses a request larger than the cap", () => {
    const huge = "x".repeat(store.MAX_BYTES + 1);
    expect(() => store.save({ ...base, body: huge })).toThrow(/too large/);
  });
});

describe("remove", () => {
  test("deletes the file and reports it", () => {
    store.save(base);
    expect(store.remove("login-as-qa")).toBe(true);
    expect(store.get("login-as-qa")).toBeNull();
    expect(store.remove("login-as-qa")).toBe(false);
  });
});

describe("ids from a client never reach the filesystem unchecked", () => {
  // This check is the only thing standing between a DELETE and an arbitrary
  // unlink, so it is tested as the security control it is.
  const hostile = [
    "../../../etc/passwd",
    "..",
    "./login-as-qa",
    "login-as-qa/../../x",
    "login%2fas%2fqa",
    "Login-As-QA", // uppercase isn't a slug we generate
    "-leading-dash",
    "",
    null,
  ];

  test.each(hostile)("get(%p) refuses", (id) => {
    expect(store.get(id)).toBeNull();
  });

  test.each(hostile)("remove(%p) refuses", (id) => {
    expect(store.remove(id)).toBe(false);
  });

  test("a traversing id does not delete a real file outside the directory", () => {
    const victim = path.join(DIR, "..", `victim-${path.basename(DIR)}.json`);
    fs.writeFileSync(victim, "keep me");
    try {
      expect(store.remove(`../${path.basename(victim)}`)).toBe(false);
      expect(fs.existsSync(victim)).toBe(true);
    } finally {
      fs.rmSync(victim, { force: true });
    }
  });
});

describe("renameInstance", () => {
  test("repoints saved requests and leaves others alone", () => {
    store.save({ ...base, name: "One", instanceId: "api" });
    store.save({ ...base, name: "Two", instanceId: "api" });
    store.save({ ...base, name: "Three", instanceId: "auth" });

    expect(store.renameInstance("api", "api-qa")).toBe(2);
    const byName = Object.fromEntries(store.list().map((r) => [r.name, r.instanceId]));
    expect(byName).toEqual({ One: "api-qa", Two: "api-qa", Three: "auth" });
  });

  test("preserves everything else about the record", () => {
    const saved = store.save(base);
    store.renameInstance("api", "renamed");
    const after = store.get(saved.id);
    expect(after).toMatchObject({
      name: base.name,
      method: "POST",
      path: "/api/login",
      headers: base.headers,
      body: base.body,
      savedAt: saved.savedAt,
    });
  });

  test("a no-op rename rewrites nothing", () => {
    store.save(base);
    expect(store.renameInstance("api", "api")).toBe(0);
    expect(store.renameInstance("", "x")).toBe(0);
  });
});

// ── Expectations ─────────────────────────────────────────────────────────────
// `expect` is what a good response looks like: `{ status?, schema? }`, already
// validated by the route. The store's only job is to keep it byte-for-byte and
// to keep the file shape the same whether or not one was ever set.

describe("expect", () => {
  const expectation = {
    status: 200,
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  };

  test("round-trips untouched", () => {
    const saved = store.save({ ...base, expect: expectation });
    expect(saved.expect).toEqual(expectation);
    expect(store.get(saved.id).expect).toEqual(expectation);
  });

  test("is null, not absent, when none was given", () => {
    const saved = store.save(base);
    expect(saved.expect).toBeNull();
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(DIR, `${saved.id}.request.json`), "utf8")
    );
    expect(Object.hasOwn(onDisk, "expect")).toBe(true);
    expect(onDisk.expect).toBeNull();
  });

  test("survives an instance rename", () => {
    // The rename path re-serialises the record, so it is the one place an
    // expectation could quietly be dropped on the floor.
    const saved = store.save({ ...base, expect: expectation });
    store.renameInstance("api", "api-qa");
    expect(store.get(saved.id)).toMatchObject({
      instanceId: "api-qa",
      expect: expectation,
    });
  });

  test("a file written before expectations existed still reads, and gains the key on rename", () => {
    // No migration: the field simply is not there, and nothing goes looking.
    fs.writeFileSync(
      path.join(DIR, "legacy.request.json"),
      JSON.stringify({ name: "Legacy", instanceId: "api", method: "GET", path: "/old" })
    );
    expect(store.get("legacy")).toMatchObject({ name: "Legacy", path: "/old" });
    expect(store.get("legacy").expect).toBeUndefined();

    store.renameInstance("api", "api-qa");
    expect(store.get("legacy").expect).toBeNull();
  });

  test("counts toward the size cap like everything else in the file", () => {
    const huge = {
      ...base,
      expect: {
        schema: { type: "object", description: "x".repeat(store.MAX_BYTES) },
      },
    };
    expect(() => store.save(huge)).toThrow(/too large/);
  });
});

describe("variables", () => {
  test("survive the round trip, and null is stored rather than absent", () => {
    const saved = store.save({
      name: "With vars",
      instanceId: "api",
      method: "GET",
      path: "/orders/{{ id }}",
      variables: { id: "42" },
    });
    expect(store.get(saved.id).variables).toEqual({ id: "42" });

    const plain = store.save({ name: "No vars", instanceId: "api", path: "/x" });
    // Null, not missing: a rename rewrites the file, and an absent key there
    // would be a different shape than a save produces.
    const raw = JSON.parse(
      fs.readFileSync(path.join(DIR, `${plain.id}.request.json`), "utf8")
    );
    expect(raw).toHaveProperty("variables", null);
  });

  test("follow an instance rename, like everything else keyed by instance id", () => {
    store.save({
      name: "Renamed with vars",
      instanceId: "old",
      path: "/orders/{{ id }}",
      variables: { id: "42" },
    });
    store.renameInstance("old", "new");

    const moved = store.list().find((r) => r.name === "Renamed with vars");
    expect(moved.instanceId).toBe("new");
    expect(moved.variables).toEqual({ id: "42" });
  });

  test("a file written before variables existed still reads", () => {
    fs.writeFileSync(
      path.join(DIR, "legacy-vars.request.json"),
      JSON.stringify({ name: "Legacy", instanceId: "api", method: "GET", path: "/x" })
    );
    expect(store.get("legacy-vars")).toMatchObject({ name: "Legacy" });
    expect(store.get("legacy-vars").variables).toBeUndefined();
  });
});
