/**
 * Schema files — `utils/schema-store.js` and the routes over it.
 *
 * Two things are worth holding down here, and neither is "does it write a
 * file":
 *
 *  • **The file is the schema.** No envelope, no id key, no savedAt — because
 *    the whole point of these files is that `--schema-file` and CI read them
 *    directly. A test that only round-trips through `get()` would keep passing
 *    if somebody wrapped the document, so the round-trip assertions read the
 *    raw bytes off disk.
 *  • **Nothing unrunnable can be saved.** A schema the validator would refuse
 *    is refused here, at save time, by name.
 *
 * Hermetic: IR_PROXY_SCHEMAS_DIR points at a tmpdir, and the routes are mounted on
 * a bare Express app — `registerSchemas` takes only the router, so there is no
 * proxy to boot.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const schemaStore = require("../utils/schema-store");
const registerSchemas = require("../utils/admin/schemas");

const SCHEMA = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

let DIR;
let app;

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-schemas-"));
  process.env.IR_PROXY_SCHEMAS_DIR = DIR;

  app = express();
  app.use(express.json());
  const router = express.Router();
  registerSchemas(router);
  app.use("/__admin", router);
  // Bound here, not once per request — see helpers/serve.js. Per-test, because
  // this file builds a fresh app per test; the helper closes them all at the end.
  app = serve(app);
});

afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  delete process.env.IR_PROXY_SCHEMAS_DIR;
});

const raw = (id) =>
  JSON.parse(fs.readFileSync(path.join(DIR, `${id}.schema.json`), "utf8"));

describe("schema-store", () => {
  test("writes the schema itself, with nothing wrapped around it", () => {
    const saved = schemaStore.save("Order response", SCHEMA);
    expect(saved.id).toBe("order-response");

    // The assertion that matters: what is on disk is a JSON Schema document,
    // feedable to --schema-file as-is. An `id`, a `savedAt` or a `schema` key
    // appearing here is the regression this file exists to catch.
    const onDisk = raw("order-response");
    expect(Object.keys(onDisk).sort()).toEqual([
      "properties",
      "required",
      "title",
      "type",
    ]);
    expect(onDisk.type).toBe("object");
    expect(onDisk.properties).toEqual(SCHEMA.properties);
  });

  test("carries the display name as `title`, and keeps one the schema arrived with", () => {
    schemaStore.save("Order response", SCHEMA);
    expect(raw("order-response").title).toBe("Order response");

    // A schema pasted out of an API's docs keeps the title it came with — the
    // file is meant to stay recognisable as that document.
    schemaStore.save("Renamed by me", { ...SCHEMA, title: "Order (v3)" });
    expect(raw("renamed-by-me").title).toBe("Order (v3)");
  });

  test("get() and remove() refuse an id that isn't shaped like one", () => {
    schemaStore.save("Order response", SCHEMA);
    expect(schemaStore.get("../../etc/passwd")).toBeNull();
    expect(schemaStore.get("Order Response")).toBeNull();
    expect(schemaStore.remove("../order-response")).toBe(false);
    // The real file is untouched by either attempt.
    expect(schemaStore.get("order-response")).not.toBeNull();
  });

  test("lists newest first, falls back to the id for an untitled file, ignores the rest", () => {
    fs.writeFileSync(path.join(DIR, "hand-written.schema.json"), '{"type":"object"}');
    fs.writeFileSync(path.join(DIR, "notes.txt"), "not a schema");
    fs.writeFileSync(path.join(DIR, "broken.schema.json"), "{ nope");
    fs.writeFileSync(path.join(DIR, "an-array.schema.json"), "[1,2]");
    schemaStore.save("Order response", SCHEMA);
    // Backdated explicitly: `mtime` is only as fine as the filesystem's clock,
    // and two files written in the same millisecond would tie.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(DIR, "hand-written.schema.json"), old, old);

    const list = schemaStore.list();
    expect(list.map((f) => f.id)).toEqual(["order-response", "hand-written"]);
    expect(list[0].title).toBe("Order response");
    expect(list[1].title).toBe("hand-written");
    // Metadata comes off the filesystem, which is the honest source for a file
    // anybody may also edit in their editor or pull from a branch.
    expect(list[0].bytes).toBeGreaterThan(0);
    expect(Date.parse(list[0].savedAt)).not.toBeNaN();
  });

  test("saving the same name again overwrites rather than numbering", () => {
    schemaStore.save("Order response", SCHEMA);
    schemaStore.save("Order response", { type: "array" });

    expect(schemaStore.list().map((f) => f.id)).toEqual(["order-response"]);
    expect(schemaStore.get("order-response").type).toBe("array");
  });

  test("refuses a name with nothing to slug, a non-object, and an oversized document", () => {
    expect(() => schemaStore.save("!!!", SCHEMA)).toThrow(/at least one letter or digit/);
    expect(() => schemaStore.save("Fine", [SCHEMA])).toThrow(/must be a JSON object/);
    expect(() => schemaStore.save("Fine", null)).toThrow(/must be a JSON object/);

    const huge = { type: "object", description: "x".repeat(schemaStore.MAX_BYTES) };
    expect(() => schemaStore.save("Huge", huge)).toThrow(/too large/);
    expect(schemaStore.list()).toEqual([]);
  });

  test("an empty directory is not an error", () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    expect(schemaStore.list()).toEqual([]);
  });
});

describe("/__admin/schemas", () => {
  test("saves, lists and reads back", async () => {
    const created = await request(app)
      .post("/__admin/schemas")
      .send({ name: "Order response", schema: SCHEMA });
    expect(created.status).toBe(200);
    expect(created.body.id).toBe("order-response");

    const listed = await request(app).get("/__admin/schemas");
    expect(listed.status).toBe(200);
    expect(listed.body.schemas).toHaveLength(1);
    expect(listed.body.schemas[0]).toMatchObject({
      id: "order-response",
      title: "Order response",
    });
    // The listing feeds a picker, so it carries names and not documents.
    expect(listed.body.schemas[0].schema).toBeUndefined();

    const read = await request(app).get("/__admin/schemas/order-response");
    expect(read.status).toBe(200);
    expect(read.body.schema.properties).toEqual(SCHEMA.properties);
  });

  test("refuses a schema the runner would refuse, by name, before writing it", async () => {
    const res = await request(app)
      .post("/__admin/schemas")
      .send({
        name: "From the docs",
        schema: { type: "object", properties: { user: { $ref: "#/$defs/user" } } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\$ref/);
    // Nothing was written: a file saved from here can never be one that fails
    // halfway through somebody's run.
    expect(schemaStore.list()).toEqual([]);
  });

  test("refuses a pattern that doesn't compile, so it fails in the editor", async () => {
    const res = await request(app)
      .post("/__admin/schemas")
      .send({ name: "Bad regex", schema: { type: "string", pattern: "([" } });

    expect(res.status).toBe(400);
    expect(schemaStore.list()).toEqual([]);
  });

  test("holds the name to the same standard as every other client-supplied label", async () => {
    const empty = await request(app).post("/__admin/schemas").send({ schema: SCHEMA });
    expect(empty.status).toBe(400);

    const long = await request(app)
      .post("/__admin/schemas")
      .send({ name: "n".repeat(65), schema: SCHEMA });
    expect(long.status).toBe(400);
  });

  test("404s for a schema that isn't there, and for an id shaped like a path", async () => {
    expect((await request(app).get("/__admin/schemas/nope")).status).toBe(404);
    expect((await request(app).delete("/__admin/schemas/nope")).status).toBe(404);
    expect((await request(app).delete("/__admin/schemas/..")).status).toBe(404);
  });

  test("deletes", async () => {
    await request(app)
      .post("/__admin/schemas")
      .send({ name: "Order response", schema: SCHEMA });

    const gone = await request(app).delete("/__admin/schemas/order-response");
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ ok: true, id: "order-response" });
    expect((await request(app).get("/__admin/schemas/order-response")).status).toBe(404);
  });
});
