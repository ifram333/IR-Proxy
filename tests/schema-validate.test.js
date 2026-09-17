/**
 * schema-validate unit tests — the pure rule behind response expectations.
 *
 * No filesystem, no sockets: this is the whole point of the module living on
 * its own. Two halves, tested as two things — `assertSupported` decides what a
 * schema is *allowed to say*, `validate` decides whether a body says it.
 *
 * The heaviest block here is the refusals. A validator that silently ignores
 * the keyword carrying the actual constraint reports green for a response it
 * never checked, which is the one behaviour that would make this worse than
 * having nothing.
 */
const {
  assertSupported,
  validate,
  MAX_DEPTH,
  MAX_ERRORS,
} = require("../utils/schema-validate");

const supported = (schema) => () => assertSupported(schema);

describe("assertSupported — what a schema may say", () => {
  test("accepts the keywords it honours", () => {
    expect(
      supported({
        $schema: "https://json-schema.org/draft-07/schema#",
        title: "Order",
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { type: "integer", minimum: 1 },
          name: { type: ["string", "null"], minLength: 1, maxLength: 64 },
          state: { enum: ["open", "closed"] },
          kind: { const: "order" },
          sku: { type: "string", pattern: "^[A-Z]{3}-\\d+$" },
          items: { type: "array", minItems: 1, maxItems: 10, items: { type: "object" } },
        },
      })
    ).not.toThrow();
  });

  test.each([
    ["$ref", { $ref: "#/definitions/Order" }],
    ["definitions", { definitions: {} }],
    ["allOf", { allOf: [] }],
    ["anyOf", { anyOf: [] }],
    ["oneOf", { oneOf: [] }],
    ["not", { not: {} }],
    ["if", { if: {} }],
    ["format", { type: "string", format: "date-time" }],
    ["patternProperties", { patternProperties: {} }],
    ["uniqueItems", { type: "array", uniqueItems: true }],
    ["multipleOf", { type: "number", multipleOf: 2 }],
    ["exclusiveMinimum", { type: "number", exclusiveMinimum: 0 }],
    ["contains", { type: "array", contains: {} }],
    ["propertyNames", { propertyNames: {} }],
  ])("refuses %s by name", (keyword, schema) => {
    // `expect.assertions` is what makes this a real test: without it a schema
    // that quietly passed would skip the catch block and report green — the
    // exact failure this module exists to prevent.
    expect.assertions(2);
    try {
      assertSupported(schema);
    } catch (err) {
      // Named in the message, and a 400: it has to be obvious *which* keyword
      // was the problem while you are still looking at the schema.
      expect(err.message).toContain(JSON.stringify(keyword));
      expect(err.status).toBe(400);
    }
  });

  test("refuses a keyword it has never heard of rather than ignoring it", () => {
    expect(supported({ type: "string", contentEncoding: "base64" })).toThrow(
      /unknown schema keyword "contentEncoding"/
    );
  });

  test("names where in the schema the problem is", () => {
    expect(
      supported({
        type: "object",
        properties: { order: { type: "object", properties: { at: { format: "date" } } } },
      })
    ).toThrow(/at \/order\/at/);
  });

  test("reports a root-level problem as the root", () => {
    expect(supported({ format: "uuid" })).toThrow(/at \(root\)/);
  });

  test("refuses a non-object schema", () => {
    expect(supported("string")).toThrow(/must be a JSON object/);
    expect(supported(null)).toThrow(/must be a JSON object/);
    expect(supported([{ type: "string" }])).toThrow(/must be a JSON object/);
  });

  test("refuses an unknown type name", () => {
    expect(supported({ type: "int" })).toThrow(/unknown type "int"/);
    expect(supported({ type: [] })).toThrow(/at least one type/);
  });

  test("refuses a malformed keyword value", () => {
    expect(supported({ required: "id" })).toThrow(/array of property names/);
    expect(supported({ minItems: -1 })).toThrow(/non-negative integer/);
    expect(supported({ minimum: "3" })).toThrow(/must be a number/);
    expect(supported({ enum: [] })).toThrow(/non-empty array/);
    expect(supported({ properties: [] })).toThrow(/must be an object/);
  });

  test("refuses additionalProperties as a sub-schema", () => {
    // Silently treating `{...}` as `true` would drop the constraint entirely.
    expect(supported({ additionalProperties: { type: "string" } })).toThrow(
      /must be true or false/
    );
  });

  test("refuses positional items", () => {
    expect(supported({ type: "array", items: [{ type: "string" }] })).toThrow(
      /not a list per position/
    );
  });

  test("compiles patterns, so a broken regex fails while you can still see it", () => {
    expect(supported({ type: "string", pattern: "[" })).toThrow(/not a valid regex/);
  });

  test("caps how deep a schema may nest", () => {
    let schema = { type: "string" };
    for (let i = 0; i < MAX_DEPTH + 4; i++) {
      schema = { type: "object", properties: { down: schema } };
    }
    expect(supported(schema)).toThrow(new RegExp(`deeper than ${MAX_DEPTH} levels`));
  });
});

describe("validate — does the body say it", () => {
  test("a matching body has no errors", () => {
    const schema = {
      type: "object",
      required: ["id", "items"],
      properties: {
        id: { type: "integer" },
        name: { type: ["string", "null"] },
        items: { type: "array", minItems: 1, items: { type: "string" } },
      },
    };
    expect(validate({ id: 4, name: null, items: ["a"] }, schema)).toEqual([]);
  });

  test("reports a missing required property against its own path", () => {
    expect(validate({}, { type: "object", required: ["id"] })).toEqual([
      "/id: required property is missing",
    ]);
  });

  test("reports a wrong type with both sides named", () => {
    expect(validate({ id: "4" }, { properties: { id: { type: "integer" } } })).toEqual([
      "/id: expected integer, got string",
    ]);
  });

  test("integer is stricter than number", () => {
    expect(validate(1.5, { type: "integer" })).toEqual([
      "(root): expected integer, got number",
    ]);
    expect(validate(1.5, { type: "number" })).toEqual([]);
  });

  test("a type list lets null through where it is allowed", () => {
    expect(validate(null, { type: ["string", "null"] })).toEqual([]);
    expect(validate(null, { type: "string" })).toEqual([
      "(root): expected string, got null",
    ]);
  });

  test("null is not an object", () => {
    // typeof null === "object" is the classic way this check goes wrong.
    expect(validate(null, { type: "object" })).toEqual([
      "(root): expected object, got null",
    ]);
  });

  test("an array is not an object", () => {
    expect(validate([], { type: "object" })).toEqual([
      "(root): expected object, got array",
    ]);
  });

  test("stops at a wrong type instead of cascading", () => {
    // Checking the properties of a schema-object against a number would report
    // every one of them missing, all restating the single real problem.
    const errors = validate(7, {
      type: "object",
      required: ["a", "b", "c"],
      properties: { a: { type: "string" } },
    });
    expect(errors).toEqual(["(root): expected object, got number"]);
  });

  test("reports every problem, not just the first", () => {
    const errors = validate(
      { id: "x", items: [] },
      {
        type: "object",
        required: ["id", "total"],
        properties: {
          id: { type: "integer" },
          items: { type: "array", minItems: 1 },
        },
      }
    );
    expect(errors).toHaveLength(3);
    expect(errors).toContain("/total: required property is missing");
    expect(errors).toContain("/id: expected integer, got string");
    expect(errors).toContain("/items: expected at least 1 items, got 0");
  });

  test("walks into arrays with the index in the path", () => {
    expect(
      validate(
        { items: [{ sku: "A" }, { sku: 2 }] },
        {
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                required: ["sku"],
                properties: { sku: { type: "string" } },
              },
            },
          },
        }
      )
    ).toEqual(["/items/1/sku: expected string, got number"]);
  });

  test("enum, const and pattern", () => {
    expect(validate("pending", { enum: ["open", "closed"] })).toEqual([
      '(root): "pending" is not one of "open", "closed"',
    ]);
    expect(validate("order", { const: "invoice" })).toEqual([
      '(root): expected "invoice", got "order"',
    ]);
    expect(validate("abc-1", { type: "string", pattern: "^[A-Z]{3}-\\d+$" })).toEqual([
      '(root): "abc-1" does not match /^[A-Z]{3}-\\d+$/',
    ]);
  });

  test("enum and const compare structurally", () => {
    expect(validate({ a: [1, 2] }, { const: { a: [1, 2] } })).toEqual([]);
    expect(validate({ a: [1, 2] }, { const: { a: [2, 1] } })).toEqual([
      '(root): expected {"a":[2,1]}, got {"a":[1,2]}',
    ]);
  });

  test("string and number bounds", () => {
    expect(validate("", { type: "string", minLength: 1 })).toEqual([
      "(root): shorter than 1 characters (0)",
    ]);
    expect(validate(0, { type: "integer", minimum: 1 })).toEqual([
      "(root): below the minimum of 1 (0)",
    ]);
    expect(validate(11, { type: "integer", maximum: 10 })).toEqual([
      "(root): above the maximum of 10 (11)",
    ]);
  });

  test("additionalProperties: false names the unexpected key", () => {
    expect(
      validate(
        { id: 1, extra: true },
        {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "integer" } },
        }
      )
    ).toEqual(["/extra: unexpected property"]);
  });

  test("a property that is absent is not type-checked — that is what required is for", () => {
    expect(
      validate({}, { type: "object", properties: { id: { type: "integer" } } })
    ).toEqual([]);
  });

  test("caps the error list and says how many it dropped", () => {
    const value = { items: Array.from({ length: 400 }, () => 1) };
    const errors = validate(value, {
      properties: { items: { type: "array", items: { type: "string" } } },
    });
    expect(errors).toHaveLength(MAX_ERRORS + 1);
    expect(errors[MAX_ERRORS]).toMatch(/^…and \d+ more$/);
  });
});
