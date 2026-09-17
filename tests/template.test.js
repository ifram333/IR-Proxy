/**
 * `{{ variables }}` — utils/template.js.
 *
 * Pure, so this is where the rules live that decide what actually leaves the
 * machine: which templates resolve, which are refused, and — the one that is a
 * security property rather than a convenience — that a value cannot smuggle a
 * newline into a header.
 */
const template = require("../utils/template");

const vars = (o) => template.validateVariables(o);

describe("validateVariables", () => {
  test("coerces to strings, so a number behaves the same everywhere", () => {
    expect(vars({ n: 42, b: true, s: "x" })).toEqual({ n: "42", b: "true", s: "x" });
  });

  test("no variables at all is an empty map, not an error", () => {
    expect(vars(null)).toEqual({});
    expect(vars(undefined)).toEqual({});
  });

  test("refuses names that are not usable, and values that are not scalars", () => {
    expect(() => vars({ "with space": "x" })).toThrow(/not a usable variable name/);
    expect(() => vars({ "2legit": "x" })).toThrow(/not a usable variable name/);
    expect(() => vars({ ok: { nested: true } })).toThrow(
      /must be a string, number or boolean/
    );
    expect(() => vars({ ok: null })).toThrow(/must be a string, number or boolean/);
    expect(() => vars([1, 2])).toThrow(/must be an object/);
  });

  test("caps how many and how long", () => {
    const many = Object.fromEntries(
      Array.from({ length: template.MAX_VARIABLES + 1 }, (_, i) => [`v${i}`, "x"])
    );
    expect(() => vars(many)).toThrow(/too many variables/);
    expect(() => vars({ big: "x".repeat(template.MAX_VALUE_CHARS + 1) })).toThrow(
      /too long/
    );
  });

  test("every refusal carries a 400, so a route can hand it straight back", () => {
    expect.assertions(1);
    try {
      vars({ "no good": "x" });
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });
});

describe("resolve", () => {
  test("substitutes, and leaves text with no braces untouched", () => {
    const v = vars({ id: "42" });
    expect(template.resolve("/orders/{{ id }}", v)).toBe("/orders/42");
    expect(template.resolve("/orders/42", v)).toBe("/orders/42");
    expect(template.resolve("/a/{{id}}/b/{{id}}", v)).toBe("/a/42/b/42");
  });

  test("applies filters left to right", () => {
    const v = vars({ q: " A B&C " });
    expect(template.resolve("{{ q | trim }}", v)).toBe("A B&C");
    expect(template.resolve("{{ q | trim | lowercase }}", v)).toBe("a b&c");
    expect(template.resolve("{{ q | trim | encodeURIComponent }}", v)).toBe("A%20B%26C");
  });

  test("encodeURIComponent is the one that makes a query param safe", () => {
    const v = vars({ q: "tyres & wheels?size=17" });
    expect(template.resolve("/search?q={{ q | encodeURIComponent }}", v)).toBe(
      "/search?q=tyres%20%26%20wheels%3Fsize%3D17"
    );
  });

  test("base64 exists for the Authorization header it was added for", () => {
    expect(template.resolve("Basic {{ creds | base64 }}", vars({ creds: "u:p" }))).toBe(
      "Basic dTpw"
    );
  });

  test("an undefined variable is an error naming it, never an empty string", () => {
    // Substituting nothing sends a blank token and comes back 401 — a failure
    // that says nothing about its own cause.
    expect(() =>
      template.resolve("{{ token }}", vars({ other: "x" }), "the path")
    ).toThrow(/"token" is not defined \(used in the path\) — defined: other/);
    expect(() => template.resolve("{{ token }}", vars({}))).toThrow(
      /no variables are defined/
    );
  });

  test("an unknown filter is refused by name, with the list", () => {
    expect(() => template.resolve("{{ a | encodeUri }}", vars({ a: "x" }))).toThrow(
      /"encodeUri" is not a filter/
    );
    expect(() => template.resolve("{{ a | encodeUri }}", vars({ a: "x" }))).toThrow(
      /encodeURIComponent/
    );
  });

  test("function syntax is refused, and the message says what to write instead", () => {
    // The shape everybody tries first. Answering it specifically is cheaper
    // than an expression evaluator, which is what the alternative really is.
    expect(() =>
      template.resolve("{{ encodeURIComponent(a) }}", vars({ a: "x" }))
    ).toThrow(/filters are written with "\|"/);
  });

  test("a malformed template is refused rather than sent as literal braces", () => {
    expect(() => template.resolve("{{ user id }}", vars({ user: "x" }))).toThrow(
      /a variable name has no spaces/
    );
    expect(() => template.resolve("{{ }}", vars({}))).toThrow(/empty \{\{ \}\}/);
  });

  test("a variable's value is a value, not a template", () => {
    // One pass: no recursion, therefore no cycles and no ordering rules.
    const v = vars({ a: "{{ b }}", b: "deep" });
    expect(template.resolve("{{ a }}", v)).toBe("{{ b }}");
  });
});

describe("resolveFields", () => {
  const v = vars({ id: "42", token: "s3cret", q: "a b" });

  test("covers the path, header values and the body's strings", () => {
    const out = template.resolveFields(
      {
        path: "/orders/{{ id }}?q={{ q | encodeURIComponent }}",
        headers: { authorization: "Bearer {{ token }}", "x-plain": "no braces" },
        body: { ref: "{{ id }}", nested: { deep: ["{{ token }}", 7] }, n: 1 },
      },
      v
    );

    expect(out.path).toBe("/orders/42?q=a%20b");
    expect(out.headers).toEqual({
      authorization: "Bearer s3cret",
      "x-plain": "no braces",
    });
    expect(out.body).toEqual({ ref: "42", nested: { deep: ["s3cret", 7] }, n: 1 });
  });

  test("leaves object keys alone, so a body's shape can't depend on its values", () => {
    const out = template.resolveFields({ body: { "{{ id }}": "{{ id }}" } }, v);
    expect(out.body).toEqual({ "{{ id }}": "42" });
  });

  test("a string body is templated whole", () => {
    expect(template.resolveFields({ body: "id={{ id }}" }, v).body).toBe("id=42");
  });

  test("does not mutate what it was given — the editor still shows the template", () => {
    const fields = { path: "/x/{{ id }}", headers: { a: "{{ id }}" } };
    template.resolveFields(fields, v);
    expect(fields.path).toBe("/x/{{ id }}");
    expect(fields.headers.a).toBe("{{ id }}");
  });
});

describe("assertParsable", () => {
  test("names every variable a request reaches for", () => {
    expect(
      template
        .assertParsable({
          path: "/{{ a }}",
          headers: { h: "{{ b | trim }}" },
          body: { deep: ["{{ c }}"] },
        })
        .sort()
    ).toEqual(["a", "b", "c"]);
  });

  test("catches a filter typo at save time, without needing the values", () => {
    // The whole point: this runs on save, so the typo is refused while the
    // editor that can fix it is still open — not halfway through a run.
    expect(() => template.assertParsable({ path: "/{{ a | encodeUri }}" })).toThrow(
      /is not a filter/
    );
  });

  test("an undefined variable is NOT an error here", () => {
    // A suite supplies them at send time; that is what sending by id with an
    // override is for.
    expect(template.assertParsable({ path: "/{{ anything }}" })).toEqual(["anything"]);
  });
});
