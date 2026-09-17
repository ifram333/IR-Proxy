/**
 * mock-conflicts unit tests.
 *
 * The same rule `tests/conflicts.test.js` exercises through `/config`, but
 * reached directly — which is the whole reason it was pulled out of the admin
 * router. Cases like "three mocks share a signature but only two of them can
 * ever meet" need a fixture of scopes, not a fixture of files on disk.
 */
const { scopesOverlap, findConflicts } = require("../utils/mock-conflicts");

/** A mock is only ever inspected for `name`, `match` and `servers`. */
const mock = (name, servers, match = "(req) => req.path === '/a'") => ({
  name,
  servers,
  match: { toString: () => match },
});

describe("scopesOverlap", () => {
  test("an unscoped mock overlaps everything", () => {
    expect(scopesOverlap(mock("a", null), mock("b", ["api"]))).toBe(true);
    expect(scopesOverlap(mock("a", ["api"]), mock("b", null))).toBe(true);
    expect(scopesOverlap(mock("a", null), mock("b", null))).toBe(true);
  });

  test("two explicit scopes meet only where they intersect", () => {
    expect(scopesOverlap(mock("a", ["api"]), mock("b", ["auth"]))).toBe(false);
    expect(scopesOverlap(mock("a", ["api", "auth"]), mock("b", ["auth"]))).toBe(true);
  });
});

describe("findConflicts", () => {
  test("a signature nobody shares is not a conflict", () => {
    const found = findConflicts([
      mock("Alone", null, "(req) => req.path === '/a'"),
      mock("Other", null, "(req) => req.path === '/b'"),
    ]);
    expect([...found]).toEqual([]);
  });

  test("two unscoped mocks with the same signature collide", () => {
    const found = findConflicts([mock("One", null), mock("Two", null)]);
    expect([...found].sort()).toEqual(["One", "Two"]);
  });

  test("the same mock recorded for two environments is not a conflict", () => {
    // The case that made the badge noise: one mock per host, each scoped to its
    // own instance, so they are never in the same pipeline.
    const found = findConflicts([
      mock("Offers (api)", ["api"]),
      mock("Offers (auth)", ["auth"]),
    ]);
    expect([...found]).toEqual([]);
  });

  test("in a group of three, only the pair that can meet is flagged", () => {
    // Precisely what the pairwise check exists for: grouping by signature alone
    // would flag all three.
    const found = findConflicts([
      mock("A", ["api"]),
      mock("B", ["api"]),
      mock("C", ["auth"]),
    ]);
    expect([...found].sort()).toEqual(["A", "B"]);
  });

  test("an unscoped mock drags every same-signature mock into the conflict", () => {
    const found = findConflicts([
      mock("Global", null),
      mock("Scoped api", ["api"]),
      mock("Scoped auth", ["auth"]),
    ]);
    expect([...found].sort()).toEqual(["Global", "Scoped api", "Scoped auth"]);
  });

  test("whitespace differences do not hide a shared signature", () => {
    const found = findConflicts([
      mock("Spaced", null, "(req) =>   req.path === '/a'"),
      mock("Tight", null, "(req) => req.path === '/a'"),
    ]);
    expect([...found].sort()).toEqual(["Spaced", "Tight"]);
  });

  test("an empty registry is not an error", () => {
    expect([...findConflicts([])]).toEqual([]);
  });
});
