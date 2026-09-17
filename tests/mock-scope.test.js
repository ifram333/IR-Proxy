const { setMockServers } = require("../utils/mock-scope");

const SINGLE = `module.exports = {
  name: "Foo",
  match: (req) => true,
  respond: (req, res) => res.json({}),
};
`;

const ARRAY = `module.exports = [
  {
    name: "Alpha",
    match: (req) => req.path === "/a",
    respond: (req, res) => res.json({}),
  },
  {
    name: "Beta",
    match: (req) => req.path === "/b",
    respond: (req, res) => res.json({}),
  },
];
`;

describe("setMockServers", () => {
  test("inserts a servers field after the name line", () => {
    const out = setMockServers(SINGLE, "Foo", ["api", "auth"]);
    expect(out).toMatch(/name: "Foo",\n\s*servers: \["api", "auth"\],/);
  });

  test("replaces an existing servers field", () => {
    const once = setMockServers(SINGLE, "Foo", ["api", "auth"]);
    const twice = setMockServers(once, "Foo", ["auth"]);
    expect(twice).toMatch(/servers: \["auth"\],/);
    expect(twice).not.toMatch(/api/);
    // only one servers line
    expect(twice.match(/servers:/g)).toHaveLength(1);
  });

  test("removes the field when scope is null/empty (→ all servers)", () => {
    const scoped = setMockServers(SINGLE, "Foo", ["api"]);
    expect(setMockServers(scoped, "Foo", null)).not.toMatch(/servers:/);
    expect(setMockServers(scoped, "Foo", [])).not.toMatch(/servers:/);
  });

  test("targets the right mock by name inside an array-form file", () => {
    const out = setMockServers(ARRAY, "Beta", ["analytics"]);
    expect(out).toMatch(/name: "Beta",\n\s*servers: \["analytics"\],/);
    // Alpha is untouched
    expect(out).not.toMatch(/name: "Alpha",\n\s*servers:/);
  });

  test("throws when the mock name is not found", () => {
    expect(() => setMockServers(SINGLE, "Missing", ["api"])).toThrow(/not found/);
  });
});
