/**
 * schema-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * JSON Schemas as files in `schemas/` — "what a good response looks like",
 * kept next to the code it holds to account instead of only inside one saved
 * request.
 *
 * ## The file *is* the schema
 *
 * No envelope, no `id` key, no `savedAt`: what lands on disk is exactly what
 * you paste out of your API docs and exactly what `--schema-file` already
 * reads. Wrapping it would mean a file written from the dashboard could not be
 * handed to the CLI without unwrapping it first — and being handed to the CLI
 * is the whole reason these are files rather than a field inside the request.
 *
 * The consequence is that the metadata comes from the filesystem (`mtime`,
 * size) rather than from inside the document, which is the honest source for a
 * file anybody may also edit in their editor or pull from a branch.
 *
 * The display name rides along as `title` — JSON Schema's own field for it, and
 * one `schema-validate.js` already carries as an annotation. Inventing a
 * private key for the same thing would have made the file that little bit less
 * like the schema you pasted in.
 *
 * ## Why this one is not gitignored, when `requests/` is
 *
 * A saved request carries headers, and headers carry `Authorization` —
 * committing one would put a token in the history. A schema carries the
 * contract. It belongs in the repo, in review, in the diff when somebody
 * changes what the API is allowed to return.
 *
 * ## Ids
 *
 * The **id is a slug of the name**, generated here and never taken from a
 * client — that is what makes the filename safe. Ids arriving *from* a client
 * are checked against `ID_RE` before they touch the filesystem, the same belt
 * and braces `request-store.js` wears: that check is the only thing between a
 * DELETE and an arbitrary unlink.
 *
 * Saving over an existing id **overwrites**, where `request-store.js` would
 * disambiguate with a number. The difference is that here the id is the *whole*
 * identity — it is the name you type after `--schema-file` — so a silent
 * `order-2.schema.json` would be a file nobody meant to make and nobody would
 * think to reference. The dashboard warns before overwriting instead, which is
 * the same call `validateMockPath` makes: an overwrite is a legitimate thing to
 * want.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/** Overridable so tests can point at `os.tmpdir()` (see CLAUDE.md). */
const DIR = () =>
  process.env.IR_PROXY_SCHEMAS_DIR || path.join(__dirname, "..", "schemas");

const SUFFIX = ".schema.json";

/**
 * Ids are produced by `slugify`; anything else is refused before it reaches the
 * filesystem. An allowlist rather than a `path.resolve` containment check —
 * there is no legitimate id this rejects, and it can't be defeated by
 * normalisation tricks.
 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Serialised size one schema may reach. A schema is a description, not a
 * payload: anything approaching this is a pasted response body that somebody
 * meant to run *through* a schema rather than save as one.
 */
const MAX_BYTES = 256 * 1024;

/** Same rule as saved-request ids: a schema name is a phrase, not a token. */
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const fileFor = (id) => path.join(DIR(), `${id}${SUFFIX}`);

const fail = (status, message) => {
  const err = new Error(message);
  err.status = status;
  throw err;
};

/** Read one file, returning null for anything unreadable or not a schema. */
function _read(id) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
    // A file hand-edited into nonsense — or a JSON array — shouldn't take out
    // the list. Whether the *keywords* are supported is `schema-validate`'s
    // call, made on save and again on send; this only asks whether it is a
    // document at all.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Every schema file, newest first — id, display name and the filesystem facts.
 *
 * The schemas themselves are deliberately left out: the list feeds a picker,
 * and sending every document to fill a dropdown would be paying for all of them
 * to open one.
 */
function list() {
  let names;
  try {
    names = fs.readdirSync(DIR());
  } catch {
    return []; // directory not created yet — nothing saved is not an error
  }
  return (
    names
      .filter((n) => n.endsWith(SUFFIX))
      .map((n) => {
        const id = n.slice(0, -SUFFIX.length);
        const schema = _read(id);
        if (!schema) return null;
        let stat;
        try {
          stat = fs.statSync(fileFor(id));
        } catch {
          return null;
        }
        return {
          id,
          // `title` is the name somebody typed; falling back to the id keeps a
          // schema written by hand — or pasted without one — from listing blank.
          title: typeof schema.title === "string" && schema.title ? schema.title : id,
          bytes: stat.size,
          savedAt: stat.mtime.toISOString(),
        };
      })
      .filter(Boolean)
      // Newest first — the one you just saved is the one you want next. The id is
      // the tiebreaker because `mtime` is only as fine as the filesystem's clock:
      // two files written in the same millisecond would otherwise fall back to
      // readdir order, and a picker that reshuffles itself between renders is a
      // small lie about which file is newer.
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id))
  );
}

/** One schema document, or null. Refuses an id that isn't shaped like one. */
function get(id) {
  if (!ID_RE.test(String(id || ""))) return null;
  return _read(id);
}

/**
 * Write a schema file, returning `{ id, title, schema }`.
 *
 * The caller is expected to have run it past `schema-validate.assertSupported`
 * first — this writes what it is given. Keeping that check in the route rather
 * than here is what lets the same refusal message serve a save, a send and a
 * `--schema-file`.
 *
 * @param {string} name  Display name; slugged into the filename.
 * @param {object} schema
 */
function save(name, schema) {
  const id = slugify(name);
  if (!id) fail(400, "name must contain at least one letter or digit");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    fail(400, "schema must be a JSON object");
  }

  // Set, not overwritten: a schema that arrived from an API's docs with its own
  // `title` keeps it. The file is meant to stay recognisable as the document it
  // came from.
  const stored =
    typeof schema.title === "string" && schema.title
      ? schema
      : { title: name, ...schema };

  const json = `${JSON.stringify(stored, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_BYTES) {
    fail(413, `schema is too large (limit ${Math.floor(MAX_BYTES / 1024)} KB)`);
  }

  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(fileFor(id), json, "utf8");
  return { id, title: stored.title, schema: stored };
}

/** Delete one. Returns false when there was nothing to delete. */
function remove(id) {
  if (!ID_RE.test(String(id || ""))) return false;
  try {
    fs.unlinkSync(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

/** Where the files live — for the CLI hint and the dashboard's empty state. */
const dir = () => DIR();

module.exports = { ID_RE, MAX_BYTES, SUFFIX, slugify, list, get, save, remove, dir };
