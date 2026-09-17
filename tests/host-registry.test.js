/**
 * host-registry.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The registry is what the dashboard tree is built from, so the invariants that
 * matter are: a host is never lost once the user commits to it, the two
 * counters stay honest about what was actually observed, and nothing a listener
 * does can break tracking on the CONNECT hot path.
 */

const hostRegistry = require("../utils/host-registry");

const CDN = "cdn.example.com";
const API = "api.example.com";

describe("host-registry", () => {
  beforeEach(() => {
    hostRegistry.reset();
    hostRegistry.configure(() => ({}));
  });

  test("seen() creates a record and accumulates ports and protocols", () => {
    hostRegistry.seen({ host: API, port: 443, protocol: "https" });
    hostRegistry.seen({ host: API, port: 8443, protocol: "https" });
    hostRegistry.seen({ host: API, port: 80, protocol: "http" });

    const record = hostRegistry.get(API);
    expect(record.connections).toBe(3);
    expect(record.ports).toEqual([443, 8443, 80]);
    expect(record.protocols).toEqual(["https", "http"]);
    expect(record.firstSeen).toEqual(expect.any(String));
  });

  test("seen() ignores a missing host instead of creating a junk record", () => {
    expect(hostRegistry.seen({})).toBeNull();
    expect(hostRegistry.seen({ host: "" })).toBeNull();
    expect(hostRegistry.list()).toHaveLength(0);
  });

  test("connections and requests are counted separately", () => {
    // One CONNECT tunnel carries many HTTP requests — reporting the tunnel as
    // a request would overstate what we can actually see with SSL off.
    hostRegistry.seen({ host: API, port: 443, protocol: "https" });
    hostRegistry.noteRequest({ host: API, status: 200, protocol: "https" });
    hostRegistry.noteRequest({ host: API, status: 200, protocol: "https" });
    hostRegistry.noteRequest({ host: API, status: 500, protocol: "https" });

    const record = hostRegistry.get(API);
    expect(record.connections).toBe(1);
    expect(record.requests).toBe(3);
    expect(record.errors).toBe(1);
  });

  test("noteRequest counts a status 0 as an error", () => {
    hostRegistry.noteRequest({ host: API, status: 0 });
    expect(hostRegistry.get(API).errors).toBe(1);
  });

  test("noteRequest can create a record for a host seen only inside a tunnel", () => {
    hostRegistry.noteRequest({ host: API, status: 200 });
    expect(hostRegistry.get(API).requests).toBe(1);
  });

  test("noteRequest ignores entries with no host", () => {
    hostRegistry.noteRequest({ status: 200 });
    hostRegistry.noteRequest(null);
    expect(hostRegistry.list()).toHaveLength(0);
  });

  test("records merge in the durable per-host settings", () => {
    hostRegistry.configure(() => ({
      [API]: { ssl: true, focus: "focus", instanceId: "api" },
    }));
    hostRegistry.seen({ host: API, port: 443, protocol: "https" });
    hostRegistry.seen({ host: CDN, port: 443, protocol: "https" });

    expect(hostRegistry.get(API)).toMatchObject({
      ssl: true,
      focus: "focus",
      instanceId: "api",
    });
    // An untouched host reports the defaults rather than undefined.
    expect(hostRegistry.get(CDN)).toMatchObject({
      ssl: false,
      focus: "none",
      instanceId: null,
    });
  });

  test("list() is newest-seen first", () => {
    hostRegistry.seen({ host: CDN, port: 443 });
    hostRegistry.seen({ host: API, port: 443 });
    expect(hostRegistry.list()[0].host).toBe(API);
  });

  test("ordering is stable for hosts seen within the same millisecond", () => {
    // ISO timestamps only resolve to the ms, and a browser opens plenty of
    // connections inside one. Without a monotonic tiebreaker these tie and sort
    // arbitrarily, making rows jump around the tree between renders.
    const frozen = new Date("2026-08-04T10:00:00.000Z");
    const spy = jest.spyOn(global, "Date").mockImplementation(() => frozen);

    try {
      ["a", "b", "c", "d"].forEach((h) => hostRegistry.seen({ host: h, port: 443 }));
      const order = hostRegistry.list().map((r) => r.host);
      expect(order).toEqual(["d", "c", "b", "a"]);
      // Re-touching the oldest moves it to the front, ties notwithstanding.
      hostRegistry.seen({ host: "a", port: 443 });
      expect(hostRegistry.list()[0].host).toBe("a");
    } finally {
      spy.mockRestore();
    }
  });

  test("get() returns null for an unknown host", () => {
    expect(hostRegistry.get("nope.example.com")).toBeNull();
  });

  describe("ensure", () => {
    test("creates a record without claiming the host was contacted", () => {
      // Configured hosts must be visible (and configurable) before any traffic.
      const record = hostRegistry.ensure(API);
      expect(record).toMatchObject({ connections: 0, requests: 0, errors: 0 });
      expect(hostRegistry.get(API).firstSeen).toBeNull();
    });

    test("is idempotent and never resets a live record", () => {
      hostRegistry.seen({ host: API, port: 443, protocol: "https" });
      hostRegistry.ensure(API);
      expect(hostRegistry.get(API).connections).toBe(1);
      expect(hostRegistry.list().filter((r) => r.host === API)).toHaveLength(1);
    });

    test("ignores a missing host", () => {
      expect(hostRegistry.ensure()).toBeNull();
      expect(hostRegistry.list()).toHaveLength(0);
    });
  });

  test("clearCounters resets the counts but keeps the host in the tree", () => {
    hostRegistry.seen({ host: API, port: 443 });
    hostRegistry.noteRequest({ host: API, status: 500 });

    expect(hostRegistry.clearCounters(API)).toBe(true);
    const record = hostRegistry.get(API);
    expect(record).toMatchObject({ connections: 0, requests: 0, errors: 0 });
    expect(hostRegistry.clearCounters("nope.example.com")).toBe(false);
  });

  test("forget() removes a single host", () => {
    hostRegistry.seen({ host: API, port: 443 });
    expect(hostRegistry.forget(API)).toBe(true);
    expect(hostRegistry.get(API)).toBeNull();
  });

  describe("eviction", () => {
    const overfill = (extra = 20) => {
      for (let i = 0; i < hostRegistry.MAX_HOSTS + extra; i++) {
        hostRegistry.seen({ host: `h${i}.example.com`, port: 443 });
      }
    };

    test("caps the map at MAX_HOSTS, dropping the least recently seen", () => {
      overfill();
      expect(hostRegistry.list()).toHaveLength(hostRegistry.MAX_HOSTS);
      expect(hostRegistry.get("h0.example.com")).toBeNull();
    });

    test("never evicts a host with SSL enabled or explicitly focused", () => {
      hostRegistry.configure(() => ({
        "keep-ssl.example.com": { ssl: true, focus: "none", instanceId: "k" },
        "keep-focus.example.com": { ssl: false, focus: "focus", instanceId: null },
        "drop-me.example.com": { ssl: false, focus: "ignore", instanceId: null },
      }));

      hostRegistry.seen({ host: "keep-ssl.example.com", port: 443 });
      hostRegistry.seen({ host: "keep-focus.example.com", port: 443 });
      hostRegistry.seen({ host: "drop-me.example.com", port: 443 });
      overfill();

      expect(hostRegistry.get("keep-ssl.example.com")).not.toBeNull();
      expect(hostRegistry.get("keep-focus.example.com")).not.toBeNull();
      // An ignored host is a candidate like any other unfocused one.
      expect(hostRegistry.get("drop-me.example.com")).toBeNull();
    });
  });

  describe("broadcasting", () => {
    test("batches everything seen in one window into a single notification", () => {
      const batches = [];
      const off = hostRegistry.onHosts((batch) => batches.push(batch));

      hostRegistry.seen({ host: API, port: 443 });
      hostRegistry.seen({ host: CDN, port: 443 });
      hostRegistry.seen({ host: API, port: 443 });

      // Nothing fires synchronously — a browser opening 60 connections must
      // not produce 60 notifications.
      expect(batches).toHaveLength(0);

      hostRegistry.flush();

      expect(batches).toHaveLength(1);
      expect(batches[0].map((r) => r.host).sort()).toEqual([API, CDN].sort());
      off();
    });

    test("unsubscribing stops delivery", () => {
      const batches = [];
      const off = hostRegistry.onHosts((batch) => batches.push(batch));
      off();

      hostRegistry.seen({ host: API, port: 443 });
      hostRegistry.flush();
      expect(batches).toHaveLength(0);
    });

    test("a throwing listener cannot break host tracking", () => {
      const seenBy = [];
      hostRegistry.onHosts(() => {
        throw new Error("boom");
      });
      const off = hostRegistry.onHosts((batch) => seenBy.push(batch));

      expect(() => {
        hostRegistry.seen({ host: API, port: 443 });
        hostRegistry.flush();
      }).not.toThrow();
      expect(seenBy).toHaveLength(1);
      expect(hostRegistry.get(API).connections).toBe(1);
      off();
    });

    test("flush with nothing pending is a no-op", () => {
      const batches = [];
      const off = hostRegistry.onHosts((batch) => batches.push(batch));
      hostRegistry.flush();
      expect(batches).toHaveLength(0);
      off();
    });
  });
});
