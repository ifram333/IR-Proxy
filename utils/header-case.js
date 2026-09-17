/**
 * header-case.js — the spelling a client actually used for its header names.
 *
 * Node's HTTP parser folds every incoming field name to lowercase in
 * `req.headers`, and that map is what the whole pipeline works in: mocks match
 * on it, `blocking.js` reads it, and the activity log records it. It is the
 * right normal form to *work* in — but it is not what went over the wire, and
 * this proxy exists to show you what went over the wire.
 *
 * `req.rawHeaders` is where the original spelling survives, so both places that
 * need it read it through here: `mock-pipeline.js` to put the names back on the
 * way upstream, and `request-log.js` to record them alongside the normalised
 * map so the inspector can show what was sent without changing what the capture
 * clients read.
 *
 * Pure — no I/O, no Node HTTP objects. Only the flat array goes in.
 */

"use strict";

/**
 * The original spelling of each header name, keyed by its lowercase form.
 *
 * Only names that are **not** already lowercase are included, so the common
 * case — a browser, which sends lowercase — costs an empty object. The first
 * spelling wins when a name arrives twice, because Node has already folded
 * those into a single value and there is no longer a second one to name.
 *
 * @param {string[]|undefined} rawHeaders  Node's flat [name, value, …] array
 * @returns {Record<string,string>} lowercase name → the spelling it arrived with
 */
function originalNames(rawHeaders) {
  const out = {};
  if (!Array.isArray(rawHeaders)) return out;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (typeof name !== "string") continue;
    const lower = name.toLowerCase();
    if (name === lower || lower in out) continue;
    out[lower] = name;
  }
  return out;
}

/**
 * Re-key a header map with those original spellings.
 *
 * A name with no entry keeps whatever it already had, which is what lets this
 * run over a map that has been merged with hand-typed edits: the edit supplied
 * a *value*, and the name it should go out under is still the one the device
 * used.
 *
 * @param {object|undefined} headers
 * @param {Record<string,string>|undefined} names  from `originalNames`
 * @returns {object} a copy — the input is never mutated
 */
function applyNames(headers, names) {
  if (!headers) return {};
  if (!names || !Object.keys(names).length) return { ...headers };
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      names[key.toLowerCase()] || key,
      value,
    ])
  );
}

/**
 * Fold a header map to lowercase names, reporting the spellings that were
 * folded away.
 *
 * This is the inverse of `applyNames`, and the pair is how a request keeps the
 * caller's spelling without every rule in between having to match
 * case-insensitively: `sendViaProxy` normalises on the way in — its hop-by-hop
 * strip, its content-type check and its recomputed `content-length` all match on
 * the lowercase form — and renames once, last, before the request goes out.
 * Folding also collapses `Content-Type` and `content-type` into one field, which
 * is what a merge of captured headers with hand-typed edits produces and what
 * would otherwise go out twice.
 *
 * A name spelled lowercase **clears** any earlier spelling: typing it that way
 * is a choice, and the last one made is the one that meant it.
 *
 * @param {object|undefined} headers
 * @returns {{headers: object, names: Record<string,string>}}
 */
function normalize(headers) {
  const out = {};
  const names = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    out[lower] = value;
    if (key === lower) delete names[lower];
    else names[lower] = key;
  }
  return { headers: out, names };
}

module.exports = { originalNames, applyNames, normalize };
