const fs = require("fs");
const os = require("os");
const path = require("path");

const loadMocks = require("../utils/mock-loader");

/** Create a throwaway mocks directory with a single .mock.js file. */
function makeMocksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-mocks-"));
  fs.writeFileSync(
    path.join(dir, "sample.mock.js"),
    `module.exports = {
       name: "Sample",
       match: (req) => req.path === "/sample",
       respond: (req, res) => res.json({ ok: true }),
     };`
  );
  return dir;
}

describe("mock-loader", () => {
  let dir;

  beforeEach(() => {
    dir = makeMocksDir();
    loadMocks.invalidate();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("loads .mock.js files and normalizes metadata", () => {
    const mocks = loadMocks(dir);
    expect(mocks).toHaveLength(1);
    expect(mocks[0].name).toBe("Sample");
    expect(mocks[0].file).toBe("sample.mock.js");
    expect(mocks[0].folder).toBe("Root");
    expect(typeof mocks[0].match).toBe("function");
  });

  test("nested folders are reflected in the folder field", () => {
    const sub = path.join(dir, "account");
    fs.mkdirSync(sub);
    fs.writeFileSync(
      path.join(sub, "login.mock.js"),
      `module.exports = { name: "Login", match: () => false, respond: () => {} };`
    );
    loadMocks.invalidate();
    const mocks = loadMocks(dir);
    const login = mocks.find((m) => m.name === "Login");
    expect(login.folder).toBe("account");
    expect(login.file).toBe("account/login.mock.js");
  });

  test("returns a cached reference until invalidated", () => {
    const first = loadMocks(dir);
    const second = loadMocks(dir);
    expect(second).toBe(first); // same array reference = served from cache

    loadMocks.invalidate();
    const third = loadMocks(dir);
    expect(third).not.toBe(first); // reloaded from disk
  });

  test("returns an empty array for a non-existent directory", () => {
    loadMocks.invalidate();
    expect(loadMocks(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});
