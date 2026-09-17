/**
 * template.js
 * ─────────────────────────────────────────────────────────────────────────────
 * `{{ variables }}` in a request's path, headers and body — resolved just
 * before it goes out.
 *
 * Pure, like `blocking.js` and `schema-validate.js` and for the same reason:
 * this decides what actually leaves the machine, and that belongs somewhere a
 * test can reach without a socket.
 *
 * ## The syntax, and what it refuses
 *
 *     {{ token }}                          a value
 *     {{ query | encodeURIComponent }}     through a filter
 *     {{ user | trim | lowercase }}        through several, left to right
 *
 * Filters are a **closed list** (`FILTERS`), and anything else is refused by
 * name. There is deliberately no expression evaluation: `{{ a + b }}` is an
 * error rather than a thing that quietly works, because the alternative is
 * `eval` on the send path, and because a template language that grows
 * expressions grows a debugger next.
 *
 * An **undefined variable is an error**, never an empty string. Substituting
 * nothing produces a request that goes out with a blank token and comes back
 * 401 — a failure that says nothing about its own cause. Naming the variable
 * costs one 400 and answers the question.
 *
 * A `{{ … }}` whose contents are not a name-and-filters is refused too, rather
 * than passed through as literal text: `{{ user id }}` is somebody reaching for
 * a variable, and silently sending the braces is the same class of lie. To send
 * a literal `{{`, put it in a variable — no escape syntax needed, and none to
 * remember.
 *
 * ## Variables are values, not templates
 *
 * `{{a}}` inside a variable's *value* stays literal. One pass, no recursion,
 * therefore no cycles and no ordering rules — and nothing is lost, because the
 * place you would want composition (`{{base}}/orders`) is the field itself.
 */

"use strict";

/**
 * The filters, and what each is for. The list is closed: `assertResolvable`
 * refuses anything not in it, by name, the same way `schema-validate.js`
 * refuses a keyword it has never heard of.
 */
const FILTERS = {
  encodeURIComponent: (s) => encodeURIComponent(s),
  encodeURI: (s) => encodeURI(s),
  uppercase: (s) => s.toUpperCase(),
  lowercase: (s) => s.toLowerCase(),
  trim: (s) => s.trim(),
  /** For a `Basic` header, which is the reason this one is here. */
  base64: (s) => Buffer.from(s, "utf8").toString("base64"),
  /** JSON-quotes the value — escaping one into a string body. */
  json: (s) => JSON.stringify(s),
};

/** Same shape as an env var, and deliberately not anything that needs quoting. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** `{{` … `}}`, non-greedy so two on one line are two templates. */
const TEMPLATE_RE = /\{\{([\s\S]*?)\}\}/g;

/** How many variables one request may carry, and how long a value may be. */
const MAX_VARIABLES = 64;
const MAX_VALUE_CHARS = 8192;

const fail = (message) => {
  const err = new Error(message);
  err.status = 400;
  throw err;
};

/**
 * Normalise and check the variable map itself.
 *
 * Values are coerced to strings here rather than at substitution time, so a
 * number in the editor behaves the same everywhere it is used.
 *
 * @param {object|null|undefined} variables
 * @returns {Record<string,string>} always an object, possibly empty
 */
function validateVariables(variables) {
  if (variables == null) return {};
  if (typeof variables !== "object" || Array.isArray(variables)) {
    fail("variables must be an object");
  }

  const entries = Object.entries(variables);
  if (entries.length > MAX_VARIABLES) {
    fail(`too many variables (limit ${MAX_VARIABLES})`);
  }

  const out = {};
  for (const [name, value] of entries) {
    if (!NAME_RE.test(name)) {
      fail(
        `"${name}" is not a usable variable name — letters, digits, "_" and "-", starting with a letter or "_"`
      );
    }
    if (value === null || typeof value === "object") {
      fail(`variable "${name}" must be a string, number or boolean`);
    }
    const str = String(value);
    if (str.length > MAX_VALUE_CHARS) {
      fail(`variable "${name}" is too long (limit ${MAX_VALUE_CHARS} characters)`);
    }
    out[name] = str;
  }
  return out;
}

/**
 * Read one `{{ … }}`'s contents into a name and its filter chain.
 * @returns {{name: string, filters: string[]}}
 */
function _parseExpression(raw, where) {
  const parts = String(raw)
    .split("|")
    .map((p) => p.trim());
  const [name, ...filters] = parts;

  if (!name) fail(`empty {{ }} in ${where}`);
  if (!NAME_RE.test(name)) {
    // The common shapes people try first, answered specifically rather than
    // with a generic "bad syntax".
    const hint = /[()]/.test(name)
      ? ' — filters are written with "|", as {{ name | encodeURIComponent }}'
      : /\s/.test(name)
        ? " — a variable name has no spaces"
        : "";
    fail(`"{{ ${raw.trim()} }}" in ${where} is not a variable${hint}`);
  }
  for (const filter of filters) {
    if (!Object.hasOwn(FILTERS, filter)) {
      fail(
        `"${filter}" is not a filter (in ${where}) — available: ${Object.keys(FILTERS).join(", ")}`
      );
    }
  }
  return { name, filters };
}

/**
 * Substitute into one string.
 *
 * @param {string} text
 * @param {Record<string,string>} variables
 * @param {string} where  Human label for the error message ("the path", `header "x"`).
 */
function resolve(text, variables, where = "the request") {
  if (typeof text !== "string" || !text.includes("{{")) return text;

  return text.replace(TEMPLATE_RE, (_match, raw) => {
    const { name, filters } = _parseExpression(raw, where);
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables);
      fail(
        `"${name}" is not defined (used in ${where})` +
          (known.length
            ? ` — defined: ${known.join(", ")}`
            : " — no variables are defined")
      );
    }
    return filters.reduce((value, filter) => FILTERS[filter](value), variables[name]);
  });
}

/**
 * Every string inside a body, substituted.
 *
 * Object **keys** are left alone: a variable naming a JSON key is not something
 * anybody has wanted here, and templating both halves would make a body's shape
 * depend on its values.
 */
function _resolveBody(body, variables) {
  if (typeof body === "string") return resolve(body, variables, "the body");
  if (Array.isArray(body)) return body.map((v) => _resolveBody(v, variables));
  if (body && typeof body === "object") {
    return Object.fromEntries(
      Object.entries(body).map(([k, v]) => [k, _resolveBody(v, variables)])
    );
  }
  return body;
}

/**
 * Resolve a whole request.
 *
 * Returns a **new** fields object; the caller keeps the unresolved one, which
 * is what gets stored and what the editor shows.
 *
 * @param {{path?: string, headers?: object, body?: *}} fields
 * @param {Record<string,string>} variables  already through `validateVariables`
 */
function resolveFields(fields, variables) {
  const out = { ...fields };

  if (typeof fields.path === "string") {
    out.path = resolve(fields.path, variables, "the path");
  }

  if (fields.headers && typeof fields.headers === "object") {
    out.headers = Object.fromEntries(
      Object.entries(fields.headers).map(([key, value]) => [
        key,
        typeof value === "string" ? resolve(value, variables, `header "${key}"`) : value,
      ])
    );
  }

  if ("body" in fields) out.body = _resolveBody(fields.body, variables);

  return out;
}

/**
 * Check a request's templates without needing the values — every `{{ … }}`
 * parses, and every filter exists.
 *
 * This is what runs on **save**: a request stored with `{{ token | encodeUri }}`
 * would otherwise fail in the middle of a collection run, long after the typo
 * left the screen. Undefined *variables* are deliberately not an error here — a
 * suite is expected to supply them at send time.
 */
function assertParsable(fields) {
  const seen = new Set();
  const scan = (text, where) => {
    if (typeof text !== "string") return;
    for (const [, raw] of text.matchAll(TEMPLATE_RE)) {
      seen.add(_parseExpression(raw, where).name);
    }
  };
  const walk = (value, where) => {
    if (typeof value === "string") return scan(value, where);
    if (Array.isArray(value)) return value.forEach((v) => walk(v, where));
    if (value && typeof value === "object") {
      Object.values(value).forEach((v) => walk(v, where));
    }
  };

  scan(fields.path, "the path");
  if (fields.headers && typeof fields.headers === "object") {
    Object.entries(fields.headers).forEach(([k, v]) => scan(v, `header "${k}"`));
  }
  if ("body" in fields) walk(fields.body, "the body");

  return [...seen];
}

module.exports = {
  FILTERS,
  MAX_VARIABLES,
  MAX_VALUE_CHARS,
  NAME_RE,
  validateVariables,
  resolve,
  resolveFields,
  assertParsable,
};
