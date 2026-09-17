/**
 * mock-conflicts.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Do these two mocks actually fight?"
 *
 * Pulled out of the admin router because it is pure — a mock registry in, a set
 * of names out — and because the scope half of the rule is subtle enough to
 * deserve tests of its own instead of only being reachable through /config.
 */

"use strict";

/**
 * Can these two mocks ever be live in the same pipeline?
 *
 * A pipeline is built per instance, and `inScope` in mock-pipeline.js reads
 * `!m.servers || m.servers.includes(instanceId)` — so a null scope means every
 * instance, and two explicit scopes only meet where they intersect.
 */
const scopesOverlap = (a, b) =>
  !a.servers || !b.servers || a.servers.some((id) => b.servers.includes(id));

/**
 * Names of mocks that share a `match()` with another mock they can actually
 * collide with.
 *
 * The scope check is the whole point. Grouping by signature alone flagged
 * "Offers Store (api)" against "Offers Store (auth)" — the same mock recorded
 * twice for two different hosts, each scoped to its own instance and therefore
 * never in the same pipeline. A warning that fires on the normal way of
 * mocking two environments is a warning people learn to ignore.
 */
const findConflicts = (mockRegistry) => {
  const bySignature = new Map();
  mockRegistry.forEach((m) => {
    const sig = m.match.toString().replace(/\s+/g, " ").trim();
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig).push(m);
  });

  const conflicted = new Set();
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    group.forEach((mock, i) => {
      // Pairwise rather than "the group is big": in a group of three, two may
      // overlap while the third is scoped somewhere neither of them reaches.
      const collides = group.some((other, j) => j !== i && scopesOverlap(mock, other));
      if (collides) conflicted.add(mock.name);
    });
  }
  return conflicted;
};

module.exports = { scopesOverlap, findConflicts };
