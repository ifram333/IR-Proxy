/**
 * blocking.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Make this service die." A blocked path's connection is **destroyed** rather
 * than answered — the client sees a reset, which is what a service that is
 * genuinely down looks like from the outside.
 *
 * That is deliberately not what the two neighbouring switches already do. The
 * `isActive: false` switch answers `503`, and any mock can answer any status;
 * both are *responses*, and a client that handles them is not proving it
 * survives the network failing. Killing the socket is the one failure mode this
 * proxy could not previously produce.
 *
 * **A block is a path prefix**, which is what makes one rule cover both things
 * the tree can offer it on: blocking the folder `/orders` and blocking the
 * endpoint `/orders` are the same request — "this service, and everything
 * under it". `/orders` therefore blocks `/orders` and `/orders/42`, and
 * pointedly not `/orders-archive`: prefix matching on raw strings is how you
 * accidentally take down a neighbour whose name starts the same way.
 *
 * `/` is the exception, matched exactly. In the tree it is a leaf beside the
 * other paths rather than their parent (`buildHostTree` gives a request to the
 * root its own node), so blocking it there must not silently mean "block the
 * entire host" — which is a decision nobody made by clicking that row.
 *
 * Pure, like `interception.js` and for the same reason: this decides whether a
 * request lives or dies, and that belongs somewhere a test can reach without a
 * socket.
 */

"use strict";

/** `source` on a log entry the block killed; the UI badges it `BLOCK`. */
const BLOCKED_SOURCE = "blocked";

/**
 * Canonical form of a blockable path: no query, no trailing slash, one leading
 * slash. The UI sends paths straight off the tree, so they arrive clean; this
 * is what keeps a hand-edited `state.json` from producing a rule that silently
 * matches nothing.
 *
 * @param {string} value
 * @returns {string|null} null when there is no usable path in it
 */
function normalizeBlockPath(value) {
  const raw = String(value || "")
    .split("?")[0]
    .split("#")[0]
    .trim();
  if (!raw) return null;
  const segments = raw.split("/").filter(Boolean);
  return segments.length ? `/${segments.join("/")}` : "/";
}

/**
 * Which rule blocks this path, if any.
 *
 * Returns the rule rather than a boolean so the dashboard can say *why* a child
 * row is blocked — "blocked by /orders" — instead of showing an unblock action
 * that would silently do nothing.
 *
 * @param {string} path       request path (query tolerated)
 * @param {string[]} [blocks] the host's rules
 * @returns {string|null}
 */
function blockCovering(path, blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const target = normalizeBlockPath(path);
  if (!target) return null;

  // Longest first, so the answer names the most specific rule in play.
  const sorted = [...blocks].map(normalizeBlockPath).filter(Boolean);
  sorted.sort((a, b) => b.length - a.length);

  return (
    sorted.find(
      (rule) => rule === target || (rule !== "/" && target.startsWith(`${rule}/`))
    ) || null
  );
}

/**
 * @param {string} path
 * @param {string[]} [blocks]
 * @returns {boolean}
 */
function isBlocked(path, blocks) {
  return blockCovering(path, blocks) !== null;
}

/**
 * Add a rule, returning a **new** list.
 *
 * Rules the new one already covers are dropped: blocking `/orders` after
 * `/orders/42` leaves one rule, not two, because the second no longer decides
 * anything and a list of dead rules is a list nobody trusts. Adding a rule
 * already covered by a broader one is a no-op for the same reason.
 *
 * @param {string[]} blocks
 * @param {string} path
 * @returns {string[]}
 */
function addBlock(blocks, path) {
  const rule = normalizeBlockPath(path);
  const current = (Array.isArray(blocks) ? blocks : [])
    .map(normalizeBlockPath)
    .filter(Boolean);
  if (!rule) return current;
  if (blockCovering(rule, current)) return current; // already covered

  return [...current.filter((existing) => !isBlocked(existing, [rule])), rule].sort();
}

/**
 * Remove exactly this rule, returning a **new** list.
 *
 * Exact only: a path is unblocked by lifting the rule that named it, and the
 * dashboard is what points at the right one. Removing "whatever covers this"
 * would let a click on a child quietly unblock its whole parent tree.
 *
 * @param {string[]} blocks
 * @param {string} path
 * @returns {string[]}
 */
function removeBlock(blocks, path) {
  const rule = normalizeBlockPath(path);
  const current = (Array.isArray(blocks) ? blocks : [])
    .map(normalizeBlockPath)
    .filter(Boolean);
  return rule ? current.filter((existing) => existing !== rule) : current;
}

module.exports = {
  BLOCKED_SOURCE,
  normalizeBlockPath,
  blockCovering,
  isBlocked,
  addBlock,
  removeBlock,
};
