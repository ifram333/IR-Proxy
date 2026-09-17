/**
 * request-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Named requests for the composer — "the login call", "the one that 500s".
 *
 * **Files on disk, not state.json**, for two reasons that both matter:
 *
 *  • state.json is rewritten whole on every dashboard action — a mock toggle, a
 *    focus change. Putting request bodies in it would mean writing kilobytes of
 *    payload every time somebody flips a switch. It is also one entry per host,
 *    and a saved request is not a fact about a host.
 *
 *  • They carry **headers**, and headers carry `Authorization`. One file per
 *    request, in a gitignored directory, is a shape where that is contained and
 *    obvious — and where deleting one really deletes it.
 *
 * The **id is a slug of the name**, and the display name lives inside the file.
 * Decoupling the two is what makes the filename safe: it is generated here and
 * never taken from a client, so no amount of `../` in a name can escape the
 * directory. Ids that arrive *from* a client are still checked against `ID_RE`
 * before they touch the filesystem — belt and braces, because that check is the
 * only thing standing between a DELETE and an arbitrary unlink.
 *
 * Unlike `mock-loader` there is **no cache**. This is read when somebody opens
 * the composer, never on the request path, so a cache would only be a way for
 * the list to go stale.
 *
 * No cap on how many can be saved, deliberately: everything else in this
 * project that grew from *traffic* got one, but this grows one click at a time,
 * exactly like the mock files next to it.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/** Overridable so tests can point at `os.tmpdir()` (see CLAUDE.md). */
const DIR = () =>
  process.env.IR_PROXY_REQUESTS_DIR || path.join(__dirname, "..", "requests");

const SUFFIX = ".request.json";

/**
 * Ids are produced by `slugify`; anything else is refused before it reaches the
 * filesystem. An allowlist rather than a `path.resolve` containment check —
 * there is no legitimate id this rejects, and it can't be defeated by
 * normalisation tricks.
 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Serialised size one saved request may reach.
 *
 * The activity log caps a stored body at 256 KB, so anything composed from a
 * capture is already well under this. The cap is here for a body pasted
 * straight into the editor.
 */
const MAX_BYTES = 512 * 1024;

/** Same rule as instance ids, with more room: a request name is a sentence. */
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

/** Read one file, returning null for anything unreadable or not ours. */
function _read(id) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
    // A file somebody hand-edited into nonsense shouldn't take out the list.
    if (!parsed || typeof parsed !== "object") return null;
    return { ...parsed, id };
  } catch {
    return null;
  }
}

/**
 * Every saved request, newest first.
 *
 * Sorted by `savedAt` rather than filename: the one you just saved is the one
 * you are most likely to want next.
 */
function list() {
  let names;
  try {
    names = fs.readdirSync(DIR());
  } catch {
    return []; // directory not created yet — nothing saved is not an error
  }
  return names
    .filter((n) => n.endsWith(SUFFIX))
    .map((n) => _read(n.slice(0, -SUFFIX.length)))
    .filter(Boolean)
    .sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
}

/** One saved request, or null. Refuses an id that isn't shaped like one. */
function get(id) {
  if (!ID_RE.test(String(id || ""))) return null;
  return _read(id);
}

/**
 * Write a saved request, returning the stored record.
 *
 * Saving over a request **of the same name** is an update. A different name
 * that happens to slug the same gets a numbered id instead, the way instance
 * ids are disambiguated — otherwise "Get user (QA)" would silently replace
 * "Get user — QA".
 *
 * @param {object} record `{ name, instanceId, method, path, headers, body, expect }`
 */
function save(record) {
  const { name } = record || {};
  const base = slugify(name);
  if (!base) fail(400, "name must contain at least one letter or digit");

  let id = base;
  for (let n = 2; ; n++) {
    const existing = _read(id);
    if (!existing || existing.name === name) break;
    id = `${base}-${n}`;
    if (n > 999) fail(409, "too many saved requests with similar names");
  }

  const stored = {
    name,
    instanceId: record.instanceId,
    method: record.method || "GET",
    path: record.path,
    headers: record.headers || {},
    body: record.body === undefined ? null : record.body,
    // What a good response looks like: `{ status?, schema? }`, already through
    // `validateExpect`. Null is the normal case and the only thing a request
    // saved before this existed can be — which is why there is no migration.
    expect: record.expect || null,
    // `{{ name }}` values for the path, headers and body. Same null-not-absent
    // rule as `expect`, and the same reason: a rename must not rewrite a file
    // into a different shape than a save does.
    variables: record.variables || null,
    savedAt: new Date().toISOString(),
  };

  const json = _serialize(stored);
  if (Buffer.byteLength(json) > MAX_BYTES) {
    fail(413, `saved request is too large (limit ${Math.floor(MAX_BYTES / 1024)} KB)`);
  }

  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(fileFor(id), json, "utf8");
  return { ...stored, id };
}

/**
 * One canonical key order for every file we write, so a saved request that has
 * been through a rename still diffs cleanly against one that hasn't. `id` is
 * never stored — it is the filename.
 */
function _serialize({
  name,
  instanceId,
  method,
  path: reqPath,
  headers,
  body,
  expect,
  variables,
  savedAt,
}) {
  return `${JSON.stringify(
    // `expect ?? null` and not `expect`: a file written before expectations
    // existed has no such key, and letting `undefined` drop out of the JSON
    // would mean a rename silently rewrote it into a different shape than a
    // save does.
    {
      name,
      instanceId,
      method,
      path: reqPath,
      headers,
      body,
      expect: expect ?? null,
      variables: variables ?? null,
      savedAt,
    },
    null,
    2
  )}\n`;
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

/**
 * Carry saved requests across an instance rename, as the log and mock stats do.
 * Without this a rename detaches them silently — still listed, pointing at an
 * instance that no longer exists.
 * @returns {number} how many were rewritten
 */
function renameInstance(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return 0;
  let moved = 0;
  list().forEach((record) => {
    if (record.instanceId !== oldId) return;
    fs.writeFileSync(fileFor(record.id), _serialize({ ...record, instanceId: newId }));
    moved++;
  });
  return moved;
}

module.exports = {
  MAX_BYTES,
  ID_RE,
  slugify,
  /** Where the files live. Exported so `collection-store` can put its index
   *  beside them instead of re-deriving the path and drifting from it. */
  dir: DIR,
  list,
  get,
  save,
  remove,
  renameInstance,
};
