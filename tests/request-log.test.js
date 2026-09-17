const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");
const requestLog = require("../utils/request-log");
const { execFileSync } = require("child_process");

describe("request-log", () => {
  beforeEach(() => {
    requestLog.clearLog();
    requestLog.setPaused(false);
  });

  test("addEntry stores and returns an entry with id + timestamp", () => {
    const rec = requestLog.addEntry({ method: "GET", path: "/a", status: 200 });
    expect(rec.id).toEqual(expect.any(String));
    expect(rec.timestamp).toEqual(expect.any(String));
    expect(rec.method).toBe("GET");
    expect(requestLog.getHistory()).toHaveLength(1);
  });

  test("getHistory returns newest-first", () => {
    requestLog.addEntry({ path: "/first" });
    requestLog.addEntry({ path: "/second" });
    const history = requestLog.getHistory();
    expect(history[0].path).toBe("/second");
    expect(history[1].path).toBe("/first");
  });

  test("the log is capped at 1000 entries", () => {
    for (let i = 0; i < 1050; i++) requestLog.addEntry({ path: `/p${i}` });
    expect(requestLog.getHistory(1500)).toHaveLength(1000);
    // newest retained, oldest dropped
    expect(requestLog.getHistory()[0].path).toBe("/p1049");
  });

  test("clearLog empties the history", () => {
    requestLog.addEntry({ path: "/x" });
    requestLog.clearLog();
    expect(requestLog.getHistory()).toHaveLength(0);
  });

  describe("clearLog filtering", () => {
    const seed = () => {
      requestLog.addEntry({ path: "/a", host: "a.example.com", instanceId: "a" });
      requestLog.addEntry({ path: "/b", host: "b.example.com", instanceId: "b" });
      requestLog.addEntry({ path: "/a2", host: "a.example.com", instanceId: "a" });
    };

    test("no filter still clears everything", () => {
      seed();
      // The CLI and the dashboard's Clear button both post an empty body, so
      // this has to keep meaning "all".
      expect(requestLog.clearLog()).toBe(3);
      expect(requestLog.getHistory()).toHaveLength(0);
    });

    test("an empty filter object also clears everything", () => {
      seed();
      // express.json() turns a bodyless POST into `{}` — not a narrowing.
      expect(requestLog.clearLog({})).toBe(3);
      expect(requestLog.getHistory()).toHaveLength(0);
    });

    test("{ host } clears only that host's entries", () => {
      seed();
      expect(requestLog.clearLog({ host: "a.example.com" })).toBe(2);
      const remaining = requestLog.getHistory();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].host).toBe("b.example.com");
    });

    test("{ instanceId } clears only that instance's entries", () => {
      seed();
      expect(requestLog.clearLog({ instanceId: "b" })).toBe(1);
      expect(requestLog.getHistory()).toHaveLength(2);
    });

    test("clearing an unknown host removes nothing", () => {
      seed();
      expect(requestLog.clearLog({ host: "nope.example.com" })).toBe(0);
      expect(requestLog.getHistory()).toHaveLength(3);
    });
  });

  describe("createLoggerMiddleware origin + duration", () => {
    const capture = async (opts, mutate) => {
      const app = express();
      if (mutate) app.use(mutate);
      app.use(requestLog.createLoggerMiddleware("inst", opts));
      app.get("/thing", (_req, res) => res.json({ ok: true }));
      await request(serve(app)).get("/thing").expect(200);
      return requestLog.getHistory()[0];
    };

    test("keeps working when called with only an instanceId", () => {
      // Four existing test suites still use the 1-arg form.
      expect(() => requestLog.createLoggerMiddleware("inst")).not.toThrow();
    });

    test("records a duration in milliseconds", async () => {
      const entry = await capture();
      expect(typeof entry.durationMs).toBe("number");
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("prefers the host stashed on the MITM socket over the Host header", async () => {
      const entry = await capture(undefined, (req, _res, next) => {
        req.socket.__irProxyHost = "real.example.com";
        req.socket.__irProxyPort = 8443;
        next();
      });
      expect(entry).toMatchObject({
        host: "real.example.com",
        port: 8443,
        protocol: "http",
      });
    });

    test("falls back to the Host header when there is no tunnel", async () => {
      const app = express();
      app.use(requestLog.createLoggerMiddleware("inst"));
      app.get("/thing", (_req, res) => res.json({ ok: true }));
      await request(serve(app))
        .get("/thing")
        .set("Host", "api.example.com:8080")
        .expect(200);

      expect(requestLog.getHistory()[0]).toMatchObject({
        host: "api.example.com",
        port: 8080,
      });
    });

    test("does not split an IPv6 literal Host header on its colons", async () => {
      const app = express();
      app.use(requestLog.createLoggerMiddleware("inst"));
      app.get("/thing", (_req, res) => res.json({ ok: true }));
      await request(serve(app)).get("/thing").set("Host", "[::1]:8443").expect(200);

      // Stored without brackets, matching what the CONNECT path stashes on the
      // socket. The two used to disagree, which would have shown one IPv6 host
      // as two separate rows in the tree.
      expect(requestLog.getHistory()[0]).toMatchObject({ host: "::1", port: 8443 });
    });

    test("ignores the Host header when it describes this server, not the origin", async () => {
      // The standalone per-instance servers see `localhost:3000`; logging that
      // would put a bogus host in the tree.
      const entry = await capture({
        trustHostHeader: false,
        targetUrl: () => "https://api.example.com",
      });
      expect(entry).toMatchObject({ host: "api.example.com", protocol: "https" });
    });

    test("survives a missing target with no host rather than throwing", async () => {
      const entry = await capture({ trustHostHeader: false, targetUrl: () => undefined });
      expect(entry.host).toBeNull();
    });
  });

  test("addEntry broadcasts SSE-formatted data to registered clients", () => {
    const writes = [];
    const fakeRes = { write: (s) => writes.push(s), on: () => {} };
    requestLog.addSSEClient(fakeRes);

    requestLog.addEntry({ method: "POST", path: "/sse", status: 201 });

    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith("data: ")).toBe(true);
    expect(writes[0].endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(writes[0].slice("data: ".length));
    expect(payload.path).toBe("/sse");
    expect(payload.status).toBe(201);
  });

  test("dead or backed-up SSE clients are evicted instead of buffering forever", () => {
    const makeClient = (props = {}) => {
      const client = {
        writes: 0,
        destroys: 0,
        write() {
          this.writes++;
        },
        destroy() {
          this.destroys++;
        },
        on: () => {},
        ...props,
      };
      requestLog.addSSEClient(client);
      return client;
    };

    const healthy = makeClient();
    const dead = makeClient({ destroyed: true });
    const backedUp = makeClient({ writableLength: 10 * 1024 * 1024 });

    requestLog.addEntry({ path: "/evict-1" });
    requestLog.addEntry({ path: "/evict-2" });

    expect(healthy.writes).toBe(2);
    // Never written to, torn down, and gone from the client set (no writes
    // reach them on the second broadcast either).
    expect(dead.writes).toBe(0);
    expect(backedUp.writes).toBe(0);
    expect(dead.destroys).toBe(1);
    expect(backedUp.destroys).toBe(1);
  });
});

/**
 * Memory accounting and the pause switch.
 *
 * The log is where this process's memory actually goes — measured at roughly
 * 187 MB RSS for 1000 entries of 128 KB bodies — so the numbers the dashboard
 * shows have to move with reality, and pausing has to mean nothing is kept.
 */
describe("stats and pausing", () => {
  beforeEach(() => {
    requestLog.clearLog();
    requestLog.setPaused(false);
  });
  afterAll(() => {
    requestLog.clearLog();
    requestLog.setPaused(false);
  });

  test("an empty log costs nothing", () => {
    expect(requestLog.stats()).toMatchObject({ entries: 0, bytes: 0, paused: false });
  });

  test("bytes track the bodies actually retained", () => {
    const body = "x".repeat(50_000);
    requestLog.addEntry({ path: "/a", requestBody: body, responseBody: body });
    const { entries, bytes } = requestLog.stats();

    expect(entries).toBe(1);
    // Both bodies plus overhead — an estimate, so assert the magnitude rather
    // than an exact figure that would break on any field being added.
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBeLessThan(120_000);
  });

  test("a truncated body is counted at its capped size, not its original", () => {
    const huge = "x".repeat(requestLog.MAX_BODY_CHARS * 3);
    requestLog.addEntry({ path: "/big", responseBody: huge });
    expect(requestLog.stats().bytes).toBeLessThan(requestLog.MAX_BODY_CHARS + 5000);
  });

  test("a truncated body is not still holding the whole original", () => {
    // `str.slice()` in V8 is a view onto its parent, so cutting a body to the
    // cap used to keep the entire upstream response alive: 300 × 8 MB responses
    // cost 2.4 GB of heap while `stats()` reported 75 MB, because the number it
    // tracks is what was *stored* and the cost was in what was still
    // referenced. Raising or lowering IR_PROXY_BODY_CHARS barely moved it, which is
    // the symptom that says the setting is not what you are paying for.
    //
    // Measured in a child process on purpose: `heapUsed` in a Jest worker moves
    // with whatever else that worker has been doing, and a memory assertion
    // that reads a neighbour's garbage is worse than no assertion at all. Here
    // nothing else is running.
    const script = `
      const log = require(${JSON.stringify(require.resolve("../utils/request-log"))});
      const N = 20, BIG = log.MAX_BODY_CHARS * 8;
      // Between the collections, not just back to back: the 40 MB of oversized
      // strings this makes are garbage the moment addEntry returns, and a
      // synchronous run of gc() does not give V8 the turns it needs to hand
      // them back. Left tighter, this measured the churn instead of the leak.
      const settle = async () => {
        for (let i = 0; i < 4; i++) {
          global.gc();
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      (async () => {
        await settle();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < N; i++) {
          // Distinct each time — a shared string is stored once and proves nothing.
          log.addEntry({ path: "/big/" + i, responseBody: String(i).padStart(9, "0") + "x".repeat(BIG) });
        }
        await settle();
        process.stdout.write(JSON.stringify({
          held: process.memoryUsage().heapUsed - before,
          stored: N * log.MAX_BODY_CHARS,
          seen: N * BIG,
        }));
      })();
    `;
    const out = execFileSync(process.execPath, ["--expose-gc", "-e", script], {
      encoding: "utf8",
    });
    const { held, stored, seen } = JSON.parse(out);

    // What was stored is 20 × the cap; what was *seen* is eight times that. The
    // threshold sits between them with room on both sides — the regression this
    // catches is an 8× overshoot, not a 20% one.
    expect(held).toBeLessThan(stored * 3);
    expect(held).toBeLessThan(seen / 2);
  });

  test("a single chunk larger than the cap is clipped, not swallowed whole", async () => {
    // On the proxy path `responseInterceptor` hands the whole body over as one
    // chunk, so a rule that only decides whether to take the *next* chunk never
    // declined anything: the cap was real for a streamed response and inert for
    // every proxied one.
    const app = express();
    app.use(requestLog.createLoggerMiddleware("inst"));
    app.get("/one-big-chunk", (_req, res) => {
      res.type("text/plain").end("z".repeat(requestLog.MAX_BODY_CHARS * 4));
    });
    await request(serve(app)).get("/one-big-chunk").expect(200);

    const entry = requestLog.getHistory().find((e) => e.path === "/one-big-chunk");
    expect(entry.responseTruncated).toBe(true);
    // Stored at the cap plus the "…[truncated]" marker, not at 4× it.
    expect(entry.responseBody.length).toBeLessThan(requestLog.MAX_BODY_CHARS + 100);
    expect(entry.responseBody.endsWith("…[truncated]")).toBe(true);
  });

  test("eviction gives the bytes back", () => {
    const body = "y".repeat(10_000);
    for (let i = 0; i < requestLog.MAX_LOG_SIZE + 50; i++) {
      requestLog.addEntry({ path: `/p${i}`, responseBody: body });
    }
    const { entries, bytes } = requestLog.stats();
    expect(entries).toBe(requestLog.MAX_LOG_SIZE);
    // Would keep climbing forever if the pop path didn't subtract.
    expect(bytes).toBeLessThan(requestLog.MAX_LOG_SIZE * 11_000);
  });

  test("clearing resets the accounting, not just the array", () => {
    requestLog.addEntry({ path: "/a", responseBody: "z".repeat(9000) });
    requestLog.clearLog();
    expect(requestLog.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  test("a filtered clear subtracts only what it removed", () => {
    requestLog.addEntry({ path: "/a", host: "a.test", responseBody: "a".repeat(9000) });
    requestLog.addEntry({ path: "/b", host: "b.test", responseBody: "b".repeat(9000) });
    const both = requestLog.stats().bytes;

    requestLog.clearLog({ host: "a.test" });
    const one = requestLog.stats().bytes;

    expect(requestLog.stats().entries).toBe(1);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(both * 0.75);
  });

  test("paused keeps nothing, and tells no one", () => {
    const seen = [];
    const off = requestLog.onEntry((e) => seen.push(e));

    requestLog.setPaused(true);
    expect(requestLog.addEntry({ path: "/ignored" })).toBeNull();

    expect(requestLog.getHistory()).toHaveLength(0);
    expect(requestLog.stats()).toMatchObject({ entries: 0, bytes: 0, paused: true });
    // Listeners feed the host counters and capture sessions. "Paused" that still
    // fanned records out would be a lie with a memory cost attached.
    expect(seen).toHaveLength(0);

    requestLog.setPaused(false);
    requestLog.addEntry({ path: "/kept" });
    expect(requestLog.getHistory()).toHaveLength(1);
    expect(seen).toHaveLength(1);
    off();
  });

  test("the pause switch reports its own state", () => {
    expect(requestLog.isPaused()).toBe(false);
    expect(requestLog.setPaused(true)).toBe(true);
    expect(requestLog.isPaused()).toBe(true);
    requestLog.setPaused(false);
  });
});

describe("caps from the environment", () => {
  const withEnv = (vars, fn) => {
    const previous = {};
    Object.entries(vars).forEach(([k, v]) => {
      previous[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    jest.resetModules();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      return fn(require("../utils/request-log"), warn);
    } finally {
      warn.mockRestore();
      Object.entries(previous).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
      jest.resetModules();
    }
  };

  test("IR_PROXY_LOG_SIZE changes how many entries are retained", () => {
    withEnv({ IR_PROXY_LOG_SIZE: "5" }, (log) => {
      for (let i = 0; i < 20; i++) log.addEntry({ path: `/p${i}` });
      expect(log.getHistory(100)).toHaveLength(5);
      expect(log.stats().maxEntries).toBe(5);
    });
  });

  test("IR_PROXY_BODY_CHARS changes where bodies are cut", () => {
    withEnv({ IR_PROXY_BODY_CHARS: "100" }, (log) => {
      const rec = log.addEntry({ path: "/a", responseBody: "x".repeat(500) });
      expect(rec.responseTruncated).toBe(true);
      expect(rec.responseBody.length).toBeLessThan(200);
    });
  });

  test("a nonsense value is ignored and complained about, not obeyed", () => {
    // Silently reading a typo as "retain 0 requests" would look like the log
    // being broken, with nothing to connect it to a stale shell profile.
    withEnv({ IR_PROXY_LOG_SIZE: "banana" }, (log, warn) => {
      expect(log.stats().maxEntries).toBe(1000);
      expect(warn).toHaveBeenCalled();
    });
    withEnv({ IR_PROXY_LOG_SIZE: "0" }, (log) =>
      expect(log.stats().maxEntries).toBe(1000)
    );
    withEnv({ IR_PROXY_LOG_SIZE: "-5" }, (log) =>
      expect(log.stats().maxEntries).toBe(1000)
    );
    withEnv({ IR_PROXY_LOG_SIZE: "1.5" }, (log) =>
      expect(log.stats().maxEntries).toBe(1000)
    );
  });
});
