/**
 * schema-validate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Is this response the shape my app expects?" — a **subset of JSON Schema**,
 * evaluated against a parsed response body.
 *
 * Pure, like `blocking.js` and `interception.js` and for the same reason: this
 * decides whether a run is green or red, and that belongs somewhere a test can
 * reach without a socket or a filesystem.
 *
 * ## Why a subset, and why it refuses out loud
 *
 * The one failure mode that would make this feature **worse than not having
 * it** is a false green — a schema that silently passes because the validator
 * skipped the keyword that carried the actual constraint. So there is no
 * "ignore what I don't understand" path anywhere below: `assertSupported`
 * walks the whole schema first and **throws, naming the keyword**, for anything
 * outside the list. Paste a `$ref` from your API docs and you get a 400 the
 * moment you save it, not a green run six weeks later that meant nothing.
 *
 * That is also why unknown keywords are refused rather than ignored: a keyword
 * this file has never heard of is, by definition, one whose meaning it cannot
 * honour.
 *
 * ## Supported
 *
 * `type` (a name or a list of them), `required`, `properties`, `items`,
 * `additionalProperties` (boolean), `enum`, `const`, `minimum`, `maximum`,
 * `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`.
 *
 * `title`, `description`, `default`, `examples`, `$schema`, `$id` and
 * `$comment` are carried without meaning — they are annotations, and stripping
 * them out of a pasted schema would be pointless friction.
 *
 * ## Refused
 *
 * `$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`, `format`,
 * `patternProperties`, `dependentSchemas`, `additionalProperties` as a
 * sub-schema. Each with a message that says which one and where.
 */

"use strict";

/** JSON Schema type names this understands. `integer` refines `number`. */
const TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/** Carried but not enforced — documentation that rides along with a schema. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "$schema",
  "$id",
  "$comment",
]);

/**
 * Keywords refused by name. The value is the half of the message that explains
 * *why it matters* — a bare "unsupported" invites the reader to assume it was
 * close enough.
 */
const REFUSED = {
  $ref: "references are not resolved here — inline the definition",
  $defs: "references are not resolved here — inline the definition",
  definitions: "references are not resolved here — inline the definition",
  allOf: "schema combinators are not evaluated here",
  anyOf: "schema combinators are not evaluated here",
  oneOf: "schema combinators are not evaluated here",
  not: "schema combinators are not evaluated here",
  if: "conditional schemas are not evaluated here",
  then: "conditional schemas are not evaluated here",
  else: "conditional schemas are not evaluated here",
  format: "formats are not checked — use `pattern` for the ones that matter",
  patternProperties: "only named `properties` are checked",
  dependentSchemas: "schema dependencies are not evaluated here",
  dependentRequired: "schema dependencies are not evaluated here",
  propertyNames: "property-name schemas are not evaluated here",
  contains: "`contains` is not evaluated here — use `items` with `minItems`",
  prefixItems: "positional item schemas are not evaluated here",
  uniqueItems: "`uniqueItems` is not checked here",
  multipleOf: "`multipleOf` is not checked here",
  exclusiveMinimum: "use `minimum` — exclusive bounds are not checked here",
  exclusiveMaximum: "use `maximum` — exclusive bounds are not checked here",
};

/**
 * How deep a schema may nest. `requests/*.request.json` is hand-editable, so
 * this is the same reflex every other outside-supplied structure in this repo
 * gets: a bound, so a pathological file costs a readable 400 rather than the
 * send path's stack.
 */
const MAX_DEPTH = 24;

/**
 * How many errors one validation reports. An array of 10 000 items failing on
 * every element would otherwise produce 10 000 strings for a `title` attribute
 * nobody can read. The count of what was dropped is kept, because "and 9 950
 * more" is itself the finding.
 */
const MAX_ERRORS = 50;

const fail = (message) => {
  const err = new Error(message);
  err.status = 400;
  throw err;
};

/** Plain JSON object — not null, not an array. */
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The JSON type name of a value, as a schema would spell it. */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // object | string | number | boolean
}

const isNonNegativeInt = (v) => Number.isInteger(v) && v >= 0;

/** Where an error happened, in a form that reads at the start of a sentence. */
const label = (path) => path || "(root)";

// ── Validating the schema itself ─────────────────────────────────────────────

/**
 * Walk a schema and throw unless every keyword in it is one this file honours.
 *
 * Runs when a request is **saved** and again when it is **sent**, which is the
 * same arrangement `validateRequestFields` already has: nothing unsendable can
 * be saved, and nothing unhonourable can be sent.
 *
 * @param {*} schema
 * @param {string} [path]  location in the schema, for the message
 * @param {number} [depth]
 * @throws {Error} with `.status = 400` and a message safe to hand back
 */
function assertSupported(schema, path = "", depth = 0) {
  if (!isPlainObject(schema)) {
    fail(`schema at ${label(path)} must be a JSON object`);
  }
  if (depth > MAX_DEPTH) {
    fail(`schema nests deeper than ${MAX_DEPTH} levels at ${label(path)}`);
  }

  for (const [keyword, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;

    if (Object.hasOwn(REFUSED, keyword)) {
      fail(
        `this validator does not support "${keyword}" at ${label(path)} — ` +
          `${REFUSED[keyword]}`
      );
    }

    switch (keyword) {
      case "type": {
        const names = Array.isArray(value) ? value : [value];
        if (!names.length) fail(`"type" at ${label(path)} must name at least one type`);
        names.forEach((name) => {
          if (!TYPES.has(name)) {
            fail(
              `unknown type "${name}" at ${label(path)} — one of: ` +
                `${[...TYPES].join(", ")}`
            );
          }
        });
        break;
      }

      case "required":
        if (!Array.isArray(value) || value.some((n) => typeof n !== "string")) {
          fail(`"required" at ${label(path)} must be an array of property names`);
        }
        break;

      case "properties": {
        if (!isPlainObject(value)) {
          fail(`"properties" at ${label(path)} must be an object`);
        }
        for (const [name, sub] of Object.entries(value)) {
          assertSupported(sub, `${path}/${name}`, depth + 1);
        }
        break;
      }

      case "items":
        // An array here would be draft-04 positional items, which is
        // `prefixItems` by another name and equally not evaluated.
        if (Array.isArray(value)) {
          fail(`"items" at ${label(path)} must be one schema, not a list per position`);
        }
        assertSupported(value, `${path}/*`, depth + 1);
        break;

      case "additionalProperties":
        if (typeof value !== "boolean") {
          fail(
            `"additionalProperties" at ${label(path)} must be true or false — ` +
              "a sub-schema there is not evaluated here"
          );
        }
        break;

      case "enum":
        if (!Array.isArray(value) || !value.length) {
          fail(`"enum" at ${label(path)} must be a non-empty array`);
        }
        break;

      case "const":
        break; // any JSON value is a legitimate constant

      case "minimum":
      case "maximum":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fail(`"${keyword}" at ${label(path)} must be a number`);
        }
        break;

      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
        if (!isNonNegativeInt(value)) {
          fail(`"${keyword}" at ${label(path)} must be a non-negative integer`);
        }
        break;

      case "pattern":
        if (typeof value !== "string") {
          fail(`"pattern" at ${label(path)} must be a string`);
        }
        // Compiled here so a broken regex is a 400 while you are looking at
        // the schema, rather than an exception halfway through a send.
        try {
          new RegExp(value);
        } catch (err) {
          fail(`"pattern" at ${label(path)} is not a valid regex: ${err.message}`);
        }
        break;

      default:
        fail(
          `unknown schema keyword "${keyword}" at ${label(path)} — ` +
            "this validator only honours the keywords it lists, so it cannot " +
            "quietly ignore this one"
        );
    }
  }

  return schema;
}

// ── Validating a value against a schema ──────────────────────────────────────

/** Structural equality for `enum` / `const`, both sides being parsed JSON. */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
    );
  }
  return false;
}

/** A value as it should read inside an error message. */
function show(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return String(value);
  return json.length > 40 ? `${json.slice(0, 39)}…` : json;
}

function matchesType(value, name) {
  if (name === "integer") return Number.isInteger(value);
  if (name === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === name;
}

function _check(value, schema, path, out) {
  if (out.length >= MAX_ERRORS) {
    out.dropped++;
    return;
  }
  const push = (message) => {
    if (out.length >= MAX_ERRORS) out.dropped++;
    else out.push(`${label(path)}: ${message}`);
  };

  // Type first, and **stop here when it fails**. Checking the properties of a
  // schema-object against a number produces a page of errors that all restate
  // the one real problem.
  if (schema.type !== undefined) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!names.some((name) => matchesType(value, name))) {
      push(`expected ${names.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }

  if (
    schema.enum !== undefined &&
    !schema.enum.some((option) => sameValue(value, option))
  ) {
    push(`${show(value)} is not one of ${schema.enum.map(show).join(", ")}`);
  }

  if (schema.const !== undefined && !sameValue(value, schema.const)) {
    push(`expected ${show(schema.const)}, got ${show(value)}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      push(`shorter than ${schema.minLength} characters (${value.length})`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      push(`longer than ${schema.maxLength} characters (${value.length})`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      push(`${show(value)} does not match /${schema.pattern}/`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      push(`below the minimum of ${schema.minimum} (${value})`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      push(`above the maximum of ${schema.maximum} (${value})`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      push(`expected at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      push(`expected at most ${schema.maxItems} items, got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, i) => _check(item, schema.items, `${path}/${i}`, out));
    }
  }

  if (isPlainObject(value)) {
    (schema.required || []).forEach((name) => {
      if (!Object.hasOwn(value, name)) {
        // Reported against the missing property's own path, so the message
        // reads the same way as every other one and points where you'd look.
        if (out.length >= MAX_ERRORS) out.dropped++;
        else out.push(`${path}/${name}: required property is missing`);
      }
    });

    if (schema.properties) {
      for (const [name, sub] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, name)) _check(value[name], sub, `${path}/${name}`, out);
      }
    }

    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}));
      Object.keys(value).forEach((name) => {
        if (!known.has(name)) {
          if (out.length >= MAX_ERRORS) out.dropped++;
          else out.push(`${path}/${name}: unexpected property`);
        }
      });
    }
  }
}

/**
 * Check a parsed value against a schema.
 *
 * Errors accumulate rather than stopping at the first: "these four fields are
 * wrong" is one round of fixing, and four runs to discover the same thing is
 * four.
 *
 * @param {*} value   a parsed JSON body
 * @param {object} schema  already through `assertSupported`
 * @returns {string[]} empty when it matches
 */
function validate(value, schema) {
  const out = [];
  out.dropped = 0;
  _check(value, schema, "", out);
  const errors = [...out];
  if (out.dropped) errors.push(`…and ${out.dropped} more`);
  return errors;
}

module.exports = {
  MAX_DEPTH,
  MAX_ERRORS,
  TYPES,
  assertSupported,
  validate,
};
