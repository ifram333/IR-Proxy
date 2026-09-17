/**
 * collection-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Collections: named, **ordered** groups of saved requests.
 *
 * A collection holds nothing but a name and a list of request ids. The requests
 * themselves stay exactly where they were — one file each, in `requests/` — and
 * are not touched by any of this. That split is the whole design:
 *
 *  • **Order is the feature.** "Log in, then call the thing that needs the
 *    token" only works if the order survives, which rules out deriving groups
 *    from a `collection` field on each request: a field can express membership
 *    but not position, and an `index` field goes stale the moment something is
 *    inserted or deleted.
 *
 *  • **Membership changes must stay cheap.** Moving a request between
 *    collections is metadata, and metadata should not rewrite a file that holds
 *    a request body and its headers. Here it rewrites one small index instead.
 *
 * That index is `_collections.json`, next to the requests it indexes: the
 * underscore and the missing `.request.json` suffix keep `request-store.list()`
 * from ever picking it up. It carries no bodies and no headers, so unlike
 * `state.json` — the other "one file, rewritten whole" store — there is nothing
 * expensive in it to rewrite.
 *
 * **A request belongs to at most one collection.** `assign` enforces it on
 * write by removing the id everywhere before placing it, and `groupRequests`
 * enforces it again on read, because the file is editable by hand and a request
 * listed twice would otherwise be run twice.
 *
 * Anything not listed in any collection is *ungrouped* — which is what every
 * request saved before collections existed is, with no migration needed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const requestStore = require("./request-store");

/** The index lives beside the requests it indexes; one directory, one env var. */
const FILE = () => path.join(requestStore.dir(), "_collections.json");

/** Same shape as a request id — generated here, never taken from a client. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const fail = (status, message) => {
  const err = new Error(message);
  err.status = status;
  throw err;
};

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/**
 * Read the index. Never throws: a missing file means "no collections yet", and
 * a file somebody hand-edited into nonsense must not take the screen down with
 * it — the requests are all still there, they just come back ungrouped.
 */
function _read() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.collections)) return [];
  return parsed.collections
    .filter((c) => c && ID_RE.test(String(c.id || "")))
    .map((c) => ({
      id: c.id,
      name: typeof c.name === "string" ? c.name : c.id,
      requests: Array.isArray(c.requests) ? c.requests.filter(isRequestId) : [],
      createdAt: c.createdAt || null,
    }));
}

const isRequestId = (id) => typeof id === "string" && requestStore.ID_RE.test(id);

function _write(collections) {
  fs.mkdirSync(requestStore.dir(), { recursive: true });
  fs.writeFileSync(FILE(), `${JSON.stringify({ collections }, null, 2)}\n`, "utf8");
  return collections;
}

/** Every collection, in the order they were created. */
function list() {
  return _read();
}

function get(id) {
  return _read().find((c) => c.id === id) || null;
}

/**
 * Create one. The id is a slug of the name, uniquified — two collections may
 * share a display name, they just can't share a file entry.
 *
 * @param {string} name already validated by the caller (`validateName`)
 */
function create(name) {
  const collections = _read();
  const base = slugify(name);
  if (!base) fail(400, "name must contain at least one letter or digit");

  let id = base;
  for (let n = 2; collections.some((c) => c.id === id); n++) {
    id = `${base}-${n}`;
    if (n > 999) fail(409, "too many collections with similar names");
  }

  const created = { id, name, requests: [], createdAt: new Date().toISOString() };
  collections.push(created);
  _write(collections);
  return created;
}

/**
 * Rename in place. The **id does not change** — it is the key every request
 * membership is written against, and re-slugging it would detach the lot for a
 * cosmetic edit. Exactly the trade `request-store` makes for its own ids.
 */
function rename(id, name) {
  const collections = _read();
  const target = collections.find((c) => c.id === id);
  if (!target) return null;
  target.name = name;
  _write(collections);
  return target;
}

/** Delete a collection. Its requests survive, ungrouped — they are their own files. */
function remove(id) {
  const collections = _read();
  const next = collections.filter((c) => c.id !== id);
  if (next.length === collections.length) return false;
  _write(next);
  return true;
}

/**
 * Put a request in a collection, at a position — the one call behind every
 * membership change there is.
 *
 * Add, move between collections, reorder inside one, and remove
 * (`collectionId: null`) are all the same operation: take the id out of
 * wherever it is, then place it. Writing it once is what keeps "a request
 * belongs to at most one collection" true without anywhere else having to
 * remember it.
 *
 * @param {string} requestId
 * @param {string|null} collectionId  null → ungrouped
 * @param {number} [index]            where to insert; appended when omitted
 */
function assign(requestId, collectionId, index) {
  if (!isRequestId(requestId)) fail(400, "unknown request");

  const collections = _read();
  if (collectionId != null && !collections.some((c) => c.id === collectionId)) {
    fail(404, `Collection "${collectionId}" no longer exists`);
  }

  collections.forEach((c) => {
    c.requests = c.requests.filter((id) => id !== requestId);
  });

  if (collectionId != null) {
    const target = collections.find((c) => c.id === collectionId);
    const at =
      Number.isInteger(index) && index >= 0
        ? Math.min(index, target.requests.length)
        : target.requests.length;
    target.requests.splice(at, 0, requestId);
  }

  _write(collections);
  return collections;
}

/**
 * Forget a request everywhere. Called when the request itself is deleted:
 * `groupRequests` would hide the dangling id anyway, but leaving it in the file
 * means a later request that slugs to the same name silently inherits its
 * place.
 * @returns {number} how many collections were rewritten
 */
function removeRequest(requestId) {
  const collections = _read();
  let touched = 0;
  collections.forEach((c) => {
    const before = c.requests.length;
    c.requests = c.requests.filter((id) => id !== requestId);
    if (c.requests.length !== before) touched++;
  });
  if (touched) _write(collections);
  return touched;
}

/**
 * Resolve ids into records — the shape the dashboard actually renders.
 *
 * Pure, and separate from every function above, so the rules that decide what
 * appears on screen can be tested without a filesystem:
 *
 *  • an id with no request behind it **disappears** rather than rendering as a
 *    blank row (the file is hand-editable, and a request can be deleted by a
 *    second dashboard);
 *  • an id listed in two collections lands in the **first** one only;
 *  • everything left over is ungrouped, which is where requests saved before
 *    collections existed live without any migration.
 *
 * @param {Array} collections from `list()`
 * @param {Array} requests    from `requestStore.list()`
 */
function groupRequests(collections, requests) {
  const byId = new Map(requests.map((r) => [r.id, r]));
  const claimed = new Set();

  const grouped = collections.map((c) => {
    const items = [];
    c.requests.forEach((id) => {
      const record = byId.get(id);
      if (!record || claimed.has(id)) return;
      claimed.add(id);
      items.push(record);
    });
    return { id: c.id, name: c.name, createdAt: c.createdAt, requests: items };
  });

  return { collections: grouped, ungrouped: requests.filter((r) => !claimed.has(r.id)) };
}

module.exports = {
  ID_RE,
  slugify,
  list,
  get,
  create,
  rename,
  remove,
  assign,
  removeRequest,
  groupRequests,
};
