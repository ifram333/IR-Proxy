/**
 * mock-stats.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Did my mock fire?"
 *
 * The assertion that carries the design is the one about the activity log: these
 * counters must **not** empty when the log rotates. The log is a thousand-entry
 * window, so a counter tied to it would delete its own evidence after a busy
 * minute — precisely when somebody is asking whether the mock ran.
 */

const mockStats = require("../utils/mock-stats");
const requestLog = require("../utils/request-log");

const hit = (instanceId, mockName, extra = {}) => ({
  source: "mock",
  instanceId,
  mockName,
  timestamp: new Date().toISOString(),
  ...extra,
});

beforeEach(() => mockStats.reset());

describe("counting", () => {
  test("counts a mock-answered request, per instance", () => {
    mockStats.noteEntry(hit("api", "Login"));
    mockStats.noteEntry(hit("api", "Login"));
    mockStats.noteEntry(hit("auth", "Login"));

    expect(mockStats.get("api", "Login").count).toBe(2);
    expect(mockStats.get("auth", "Login").count).toBe(1);
    // The same mock on two hosts is two counters — that distinction is the
    // whole point of the matrix it feeds.
    expect(mockStats.summary()).toEqual({
      api: { Login: expect.objectContaining({ count: 2 }) },
      auth: { Login: expect.objectContaining({ count: 1 }) },
    });
  });

  test("records when it last fired", () => {
    mockStats.noteEntry(hit("api", "Login", { timestamp: "2026-01-01T00:00:00.000Z" }));
    mockStats.noteEntry(hit("api", "Login", { timestamp: "2026-02-02T00:00:00.000Z" }));
    expect(mockStats.get("api", "Login").lastAt).toBe("2026-02-02T00:00:00.000Z");
  });

  test("ignores anything a mock didn't answer", () => {
    mockStats.noteEntry({ source: "proxy", instanceId: "api", mockName: null });
    mockStats.noteEntry({ source: "intercept", instanceId: "api", mockName: "Login" });
    mockStats.noteEntry({ source: "server-off", instanceId: "api" });
    mockStats.noteEntry(null);
    mockStats.noteEntry({ source: "mock", instanceId: "api" }); // no name

    // `intercept` means the mock transformed a *proxied* response rather than
    // answering, so it is not a hit.
    expect(mockStats.summary()).toEqual({});
  });

  test("a mock with no hits simply isn't there", () => {
    expect(mockStats.get("api", "Never")).toBeNull();
  });
});

describe("independence from the activity log", () => {
  afterEach(() => requestLog.clearLog());

  test("clearing the log leaves the counters alone", () => {
    requestLog.onEntry(mockStats.noteEntry);
    requestLog.addEntry(hit("api", "Login"));
    requestLog.addEntry(hit("api", "Login"));
    expect(mockStats.get("api", "Login").count).toBe(2);

    requestLog.clearLog();

    // The log is a rolling window; the counters are the record of this run.
    expect(requestLog.getHistory()).toHaveLength(0);
    expect(mockStats.get("api", "Login").count).toBe(2);
  });

  test("counters survive entries being evicted by the cap", () => {
    // Simulated rather than driven through the real cap, which would need a
    // thousand entries to prove a point about two.
    mockStats.noteEntry(hit("api", "Login"));
    requestLog.clearLog();
    mockStats.noteEntry(hit("api", "Login"));
    expect(mockStats.get("api", "Login").count).toBe(2);
  });
});

describe("reset", () => {
  beforeEach(() => {
    mockStats.noteEntry(hit("api", "Login"));
    mockStats.noteEntry(hit("api", "Offers"));
    mockStats.noteEntry(hit("auth", "Login"));
  });

  test("with no filter, everything goes", () => {
    expect(mockStats.reset()).toBe(3);
    expect(mockStats.summary()).toEqual({});
  });

  test("with an instance, only that instance's", () => {
    expect(mockStats.reset({ instanceId: "api" })).toBe(2);
    expect(mockStats.summary()).toEqual({
      auth: { Login: expect.objectContaining({ count: 1 }) },
    });
  });

  test("resetting an unknown instance removes nothing", () => {
    expect(mockStats.reset({ instanceId: "nope" })).toBe(0);
    expect(Object.keys(mockStats.summary())).toHaveLength(2);
  });
});

describe("rename", () => {
  test("counters follow an instance to its new id", () => {
    mockStats.noteEntry(hit("api", "Login"));
    mockStats.noteEntry(hit("api", "Login"));
    mockStats.noteEntry(hit("auth", "Login"));

    expect(mockStats.renameInstance("api", "api-v2")).toBe(1);

    // Miss this and renaming a host silently zeroes its evidence.
    expect(mockStats.get("api-v2", "Login").count).toBe(2);
    expect(mockStats.get("api", "Login")).toBeNull();
    expect(mockStats.get("auth", "Login").count).toBe(1);
  });

  test("a no-op rename is a no-op", () => {
    mockStats.noteEntry(hit("api", "Login"));
    expect(mockStats.renameInstance("api", "api")).toBe(0);
    expect(mockStats.renameInstance("api", "")).toBe(0);
    expect(mockStats.get("api", "Login").count).toBe(1);
  });

  test("renaming onto an id that already has counters keeps both mocks", () => {
    mockStats.noteEntry(hit("old", "A"));
    mockStats.noteEntry(hit("new", "B"));
    mockStats.renameInstance("old", "new");
    expect(mockStats.summary().new).toEqual({
      A: expect.objectContaining({ count: 1 }),
      B: expect.objectContaining({ count: 1 }),
    });
  });
});

describe("the cap", () => {
  test("stops growing, and keeps what fired most recently", () => {
    // Mock names come off disk, so renaming and deleting over a long session
    // leaves keys behind that nothing else prunes. This is the backstop.
    const old = "2020-01-01T00:00:00.000Z";
    for (let i = 0; i < mockStats.MAX_TRACKED + 500; i++) {
      mockStats.noteEntry(hit("inst", `Mock ${i}`, { timestamp: old }));
    }
    const total = Object.keys(mockStats.summary().inst || {}).length;
    expect(total).toBeLessThanOrEqual(mockStats.MAX_TRACKED);

    // A recent hit outlives the flood of stale ones around it.
    mockStats.noteEntry(hit("inst", "Fresh", { timestamp: "2030-01-01T00:00:00.000Z" }));
    for (let i = 0; i < 600; i++) {
      mockStats.noteEntry(hit("inst", `Filler ${i}`, { timestamp: old }));
    }
    expect(mockStats.get("inst", "Fresh")).not.toBeNull();
  });
});
