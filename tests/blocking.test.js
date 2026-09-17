/**
 * blocking — the pure rule behind "make this service die".
 *
 * Pulled out for the same reason `interception.js` was: this decides whether a
 * request lives, and a test should be able to ask it without a socket.
 */
const {
  BLOCKED_SOURCE,
  normalizeBlockPath,
  blockCovering,
  isBlocked,
  addBlock,
  removeBlock,
} = require("../utils/blocking");

describe("normalizeBlockPath", () => {
  test("strips the query, the fragment and any trailing slash", () => {
    expect(normalizeBlockPath("/orders/42?x=1")).toBe("/orders/42");
    expect(normalizeBlockPath("/orders/#top")).toBe("/orders");
    expect(normalizeBlockPath("/orders///")).toBe("/orders");
  });

  test("adds the leading slash and collapses empty segments", () => {
    expect(normalizeBlockPath("orders/42")).toBe("/orders/42");
    expect(normalizeBlockPath("//orders//42")).toBe("/orders/42");
  });

  test("the root survives as the root", () => {
    expect(normalizeBlockPath("/")).toBe("/");
  });

  test("nothing usable is null, not an empty rule that matches everything", () => {
    expect(normalizeBlockPath("")).toBeNull();
    expect(normalizeBlockPath("   ")).toBeNull();
    expect(normalizeBlockPath(null)).toBeNull();
    expect(normalizeBlockPath("?x=1")).toBeNull();
  });
});

describe("isBlocked", () => {
  test("no rules blocks nothing", () => {
    expect(isBlocked("/orders", [])).toBe(false);
    expect(isBlocked("/orders", undefined)).toBe(false);
  });

  test("a rule blocks the exact path", () => {
    expect(isBlocked("/orders", ["/orders"])).toBe(true);
  });

  test("and everything under it — blocking a folder blocks its children", () => {
    expect(isBlocked("/orders/42", ["/orders"])).toBe(true);
    expect(isBlocked("/orders/42/items", ["/orders"])).toBe(true);
  });

  test("but NOT a sibling whose name merely starts the same way", () => {
    // The whole reason the rule is not a raw `startsWith`: this is how you take
    // down a service nobody asked you to.
    expect(isBlocked("/orders-archive", ["/orders"])).toBe(false);
    expect(isBlocked("/ordersX", ["/orders"])).toBe(false);
  });

  test("a query string on the request does not save it", () => {
    expect(isBlocked("/orders/42?full=1", ["/orders"])).toBe(true);
  });

  test("blocking the root blocks only the root", () => {
    // `/` is a leaf beside the other paths in the tree, not their parent, so a
    // click on that row must not mean "block the entire host".
    expect(isBlocked("/", ["/"])).toBe(true);
    expect(isBlocked("/orders", ["/"])).toBe(false);
  });

  test("any one rule in the list is enough", () => {
    expect(isBlocked("/health", ["/orders", "/health"])).toBe(true);
  });

  test("rules stored unnormalised still match", () => {
    expect(isBlocked("/orders/42", ["/orders/"])).toBe(true);
    expect(isBlocked("/orders/42", ["orders"])).toBe(true);
  });
});

describe("blockCovering", () => {
  test("names the rule, so the UI can say what to lift", () => {
    expect(blockCovering("/orders/42", ["/orders"])).toBe("/orders");
  });

  test("names the most specific rule when several apply", () => {
    expect(blockCovering("/orders/42/items", ["/orders", "/orders/42"])).toBe(
      "/orders/42"
    );
  });

  test("null when nothing covers it", () => {
    expect(blockCovering("/health", ["/orders"])).toBeNull();
  });
});

describe("addBlock", () => {
  test("adds a rule to an empty list", () => {
    expect(addBlock([], "/orders")).toEqual(["/orders"]);
    expect(addBlock(undefined, "/orders")).toEqual(["/orders"]);
  });

  test("normalises what it stores", () => {
    expect(addBlock([], "orders/42/?x=1")).toEqual(["/orders/42"]);
  });

  test("a broader rule absorbs the ones it now covers", () => {
    // Otherwise the list grows rules that no longer decide anything, and a list
    // of dead rules is one nobody trusts.
    expect(addBlock(["/orders/42", "/orders/7"], "/orders")).toEqual(["/orders"]);
  });

  test("adding something already covered changes nothing", () => {
    expect(addBlock(["/orders"], "/orders/42")).toEqual(["/orders"]);
    expect(addBlock(["/orders"], "/orders")).toEqual(["/orders"]);
  });

  test("unrelated rules are kept", () => {
    expect(addBlock(["/health"], "/orders")).toEqual(["/health", "/orders"]);
  });

  test("a sibling with a shared prefix is not absorbed", () => {
    expect(addBlock(["/orders-archive"], "/orders")).toEqual([
      "/orders",
      "/orders-archive",
    ]);
  });

  test("returns a new list rather than mutating the stored one", () => {
    const before = ["/health"];
    const after = addBlock(before, "/orders");
    expect(before).toEqual(["/health"]);
    expect(after).not.toBe(before);
  });

  test("an unusable path is refused without disturbing the list", () => {
    expect(addBlock(["/orders"], "")).toEqual(["/orders"]);
  });
});

describe("removeBlock", () => {
  test("lifts exactly the named rule", () => {
    expect(removeBlock(["/orders", "/health"], "/orders")).toEqual(["/health"]);
  });

  test("removing a child of a rule does NOT lift the parent", () => {
    // A click on a child row must never quietly unblock its whole parent tree.
    expect(removeBlock(["/orders"], "/orders/42")).toEqual(["/orders"]);
  });

  test("normalises before comparing", () => {
    expect(removeBlock(["/orders"], "orders/")).toEqual([]);
  });

  test("returns a new list rather than mutating the stored one", () => {
    const before = ["/orders"];
    const after = removeBlock(before, "/orders");
    expect(before).toEqual(["/orders"]);
    expect(after).not.toBe(before);
  });
});

test("the log source is a distinct value the UI can badge", () => {
  expect(BLOCKED_SOURCE).toBe("blocked");
});
