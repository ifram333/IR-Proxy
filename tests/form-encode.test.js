/**
 * `encodeForm` — what a composed body looks like as `a=1&b=2`.
 *
 * The case that produced this: a body whose `data` field held the document to
 * send. `new URLSearchParams(body)` rendered it as the literal text
 * `[object Object]`, and the request went out well-formed, 49 bytes long, and
 * came back 200 — so the only symptom was an API that quietly did nothing.
 */
const { encodeForm } = require("../utils/form-encode");

describe("encodeForm", () => {
  test("a nested object becomes JSON, not [object Object]", () => {
    const out = encodeForm({ email: "a@b.com", data: { x: 1, y: "z" } });
    expect(out).toBe("email=a%40b.com&data=%7B%22x%22%3A1%2C%22y%22%3A%22z%22%7D");
    // What the receiving end gets back after one decode: the document intact.
    expect(new URLSearchParams(out).get("data")).toBe('{"x":1,"y":"z"}');
  });

  test("percent signs already in the values survive the round trip", () => {
    // The values in a real payload are often pre-encoded (`520%20NW%20St`), so
    // the `%` is encoded again to `%25` on the wire and decodes back to `%20`.
    // Getting this wrong in either direction silently corrupts every address.
    const data = { ADDRESS: "520%20NW%20St", PHONE: "%28630%29%20337%2D7822" };
    const out = encodeForm({ data });
    expect(new URLSearchParams(out).get("data")).toBe(JSON.stringify(data));
  });

  test("an array becomes repeated keys, the way the parser reads them back", () => {
    expect(encodeForm({ tag: ["a", "b"] })).toBe("tag=a&tag=b");
  });

  test("an array of objects repeats the key with JSON, not [object Object]", () => {
    const out = encodeForm({ item: [{ a: 1 }, { b: 2 }] });
    expect(new URLSearchParams(out).getAll("item")).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("primitives keep URLSearchParams' own coercion", () => {
    // Nothing that already worked may change shape, `null` included.
    const body = { s: "x", n: 1, t: true, z: null };
    expect(encodeForm(body)).toBe(new URLSearchParams(body).toString());
  });

  test("a body that was never a form is left to URLSearchParams", () => {
    expect(encodeForm("a=1&b=2")).toBe("a=1&b=2");
  });

  test("an empty object is an empty payload", () => {
    expect(encodeForm({})).toBe("");
  });
});
