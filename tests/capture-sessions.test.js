const requestLog = require("../utils/request-log");
const captureSessions = require("../utils/capture-sessions");

describe("capture-sessions", () => {
  beforeEach(() => {
    requestLog.clearLog();
    captureSessions.clearAll();
  });

  afterEach(() => jest.useRealTimers());

  test("an active session accumulates entries chronologically with full fields", () => {
    const meta = captureSessions.startSession({ name: "flow" });
    requestLog.addEntry({
      instanceId: "api",
      method: "POST",
      path: "/api/login",
      status: 200,
      source: "mock",
      requestBody: { user: "u" },
    });
    requestLog.addEntry({
      instanceId: "api",
      method: "GET",
      path: "/api/me",
      status: 200,
    });

    const requests = captureSessions.getRequests(meta.id);
    expect(requests).toHaveLength(2);
    expect(requests[0].path).toBe("/api/login"); // oldest first
    expect(requests[0].requestBody).toEqual({ user: "u" });
    expect(requests[0].id).toEqual(expect.any(String));
    expect(requests[1].path).toBe("/api/me");
  });

  test("stop freezes accumulation and is idempotent", () => {
    const meta = captureSessions.startSession();
    requestLog.addEntry({ path: "/before" });
    const stopped = captureSessions.stopSession(meta.id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.stoppedAt).toEqual(expect.any(String));

    requestLog.addEntry({ path: "/after" });
    const again = captureSessions.stopSession(meta.id);
    expect(again.status).toBe("stopped");
    expect(again.stoppedAt).toBe(stopped.stoppedAt);
    expect(again.entries.map((e) => e.path)).toEqual(["/before"]);
  });

  test("two concurrent sessions both capture the same entry", () => {
    const a = captureSessions.startSession({ name: "a" });
    const b = captureSessions.startSession({ name: "b" });
    requestLog.addEntry({ path: "/shared" });

    expect(captureSessions.getRequests(a.id)).toHaveLength(1);
    expect(captureSessions.getRequests(b.id)).toHaveLength(1);
    // shared reference to the same immutable record
    expect(captureSessions.getRequests(a.id)[0]).toBe(
      captureSessions.getRequests(b.id)[0]
    );
  });

  test("an instanceId-filtered session only captures matching entries", () => {
    const meta = captureSessions.startSession({ instanceId: "api" });
    requestLog.addEntry({ instanceId: "api", path: "/yes" });
    requestLog.addEntry({ instanceId: "auth", path: "/no" });

    const requests = captureSessions.getRequests(meta.id);
    expect(requests.map((e) => e.path)).toEqual(["/yes"]);
  });

  test("entries beyond the per-session cap are counted, not stored", () => {
    const meta = captureSessions.startSession();
    const extra = 5;
    for (let i = 0; i < captureSessions.MAX_ENTRIES_PER_SESSION + extra; i++) {
      requestLog.addEntry({ path: `/p${i}` });
    }
    const session = captureSessions.getSession(meta.id);
    expect(session.entries).toHaveLength(captureSessions.MAX_ENTRIES_PER_SESSION);
    expect(session.droppedCount).toBe(extra);
  });

  test("abandoned active sessions expire after the TTL but keep their entries", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-12T10:00:00Z"));

    const meta = captureSessions.startSession();
    requestLog.addEntry({ path: "/in-window" });

    jest.setSystemTime(new Date(Date.now() + captureSessions.ACTIVE_TTL_MS + 1000));
    requestLog.addEntry({ path: "/too-late" });

    const session = captureSessions.getSession(meta.id);
    expect(session.status).toBe("expired");
    expect(session.entries.map((e) => e.path)).toEqual(["/in-window"]);
  });

  test("finished sessions are evicted oldest-first past the retention cap", () => {
    const ids = [];
    for (let i = 0; i < captureSessions.MAX_FINISHED_SESSIONS + 3; i++) {
      const meta = captureSessions.startSession({ name: `s${i}` });
      captureSessions.stopSession(meta.id);
      ids.push(meta.id);
    }
    const remaining = captureSessions.listSessions().map((s) => s.id);
    expect(remaining).toHaveLength(captureSessions.MAX_FINISHED_SESSIONS);
    expect(remaining).not.toContain(ids[0]);
    expect(remaining).not.toContain(ids[1]);
    expect(remaining).toContain(ids[ids.length - 1]);
  });

  test("startSession throws a CAPACITY error at the active-session cap", () => {
    for (let i = 0; i < captureSessions.MAX_ACTIVE_SESSIONS; i++) {
      captureSessions.startSession();
    }
    expect(() => captureSessions.startSession()).toThrow(
      /Too many active capture sessions/
    );
    try {
      captureSessions.startSession();
    } catch (err) {
      expect(err.code).toBe("CAPACITY");
    }
  });

  test("clearing the rolling activity log does not destroy captured entries", () => {
    const meta = captureSessions.startSession();
    requestLog.addEntry({ path: "/kept" });
    requestLog.clearLog();
    expect(captureSessions.getRequests(meta.id)).toHaveLength(1);
  });

  test("getRequests applies method/path/pathPrefix/source filters", () => {
    const meta = captureSessions.startSession();
    requestLog.addEntry({ method: "POST", path: "/api/login", source: "mock" });
    requestLog.addEntry({ method: "GET", path: "/api/items?lang=en", source: "proxy" });

    expect(captureSessions.getRequests(meta.id, { method: "post" })).toHaveLength(1);
    // exact path matches the pathname even when the entry carries a query string
    expect(captureSessions.getRequests(meta.id, { path: "/api/items" })).toHaveLength(1);
    expect(captureSessions.getRequests(meta.id, { pathPrefix: "/api/" })).toHaveLength(2);
    expect(captureSessions.getRequests(meta.id, { source: "proxy" })).toHaveLength(1);
    expect(captureSessions.getRequests(meta.id, { source: "intercept" })).toHaveLength(0);
  });

  test("deleteSession removes it; listSessions exposes metadata without entries", () => {
    const meta = captureSessions.startSession({ name: "meta-only" });
    requestLog.addEntry({ path: "/x" });

    const listed = captureSessions.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "meta-only", status: "active", count: 1 });
    expect(listed[0].entries).toBeUndefined();

    expect(captureSessions.deleteSession(meta.id)).toBe(true);
    expect(captureSessions.getSession(meta.id)).toBeNull();
    expect(captureSessions.deleteSession(meta.id)).toBe(false);
  });

  test("getRequests/getSession return null for unknown sessions", () => {
    expect(captureSessions.getSession("nope")).toBeNull();
    expect(captureSessions.getRequests("nope")).toBeNull();
  });
});
