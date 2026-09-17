/**
 * access-gate.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The approval gate, and the routes that answer it.
 *
 * The assertions worth reading twice are the ones about who may *grant* access.
 * A gate whose decision endpoint is itself reachable from the network is not a
 * gate — the caller lets itself in — so that asymmetry is pinned from both
 * sides: loopback decides, and everything else is refused outright rather than
 * being turned into a prompt somebody might click through.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const accessGate = require("../utils/access-gate");
const createAdminRouter = require("../utils/admin-router");
const loadMocks = require("../utils/mock-loader");

let MOCKS_DIR;

/**
 * Mount the admin router while pretending the caller came from `ip`.
 *
 * Returns a **listening server**, not the app: supertest binds a fresh
 * ephemeral port for every request it is handed an app for, and this file asks
 * for nine. See helpers/serve.js.
 */
function appAsClient(ip) {
  const app = express();
  app.use(express.json());
  // supertest always connects over loopback, so the source address has to be
  // faked at the socket level — the gate reads `req.socket.remoteAddress` and
  // deliberately ignores every header.
  if (ip) {
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: ip,
        configurable: true,
      });
      next();
    });
  }
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE: null,
      store: { instanceStatus: {}, instanceSettings: {}, profiles: {}, hostSettings: {} },
      serverConfigs: [],
      saveState: () => {},
      instanceId: "test",
    })
  );
  return serve(app);
}

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-gate-"));
  loadMocks.invalidate();
});

afterAll(() => fs.rmSync(MOCKS_DIR, { recursive: true, force: true }));

afterEach(() => accessGate.reset());

describe("normalizeIp", () => {
  test("unwraps IPv4-mapped IPv6, which is what a dual-stack socket reports", () => {
    expect(accessGate.normalizeIp("::ffff:192.168.1.20")).toBe("192.168.1.20");
    expect(accessGate.normalizeIp("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  test("folds both spellings of IPv6 loopback onto 127.0.0.1", () => {
    expect(accessGate.normalizeIp("::1")).toBe("127.0.0.1");
    expect(accessGate.normalizeIp("0:0:0:0:0:0:0:1")).toBe("127.0.0.1");
  });

  test("strips brackets and tolerates junk", () => {
    expect(accessGate.normalizeIp("[::1]")).toBe("127.0.0.1");
    expect(accessGate.normalizeIp("")).toBeNull();
    expect(accessGate.normalizeIp(undefined)).toBeNull();
  });
});

describe("isLoopback", () => {
  test.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"])(
    "%s is local",
    (ip) => {
      expect(accessGate.isLoopback(ip)).toBe(true);
    }
  );

  test.each(["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.20", "8.8.8.8"])(
    "%s is not",
    (ip) => {
      expect(accessGate.isLoopback(ip)).toBe(false);
    }
  );
});

describe("granting access", () => {
  test("a request waits until somebody answers, then resolves true", async () => {
    const pending = accessGate.request({ ip: "192.168.1.20", path: "/__admin/config" });
    const [entry] = accessGate.listPending();
    expect(entry).toMatchObject({ ip: "192.168.1.20", path: "/__admin/config" });

    expect(accessGate.decide(entry.id, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(accessGate.isAllowed("192.168.1.20")).toBe(true);
  });

  test("a denial resolves false and grants nothing", async () => {
    const pending = accessGate.request({ ip: "192.168.1.21", path: "/x" });
    accessGate.decide(accessGate.listPending()[0].id, false);
    await expect(pending).resolves.toBe(false);
    expect(accessGate.isAllowed("192.168.1.21")).toBe(false);
  });

  test("an approved machine never waits again", async () => {
    const first = accessGate.request({ ip: "192.168.1.22", path: "/a" });
    accessGate.decide(accessGate.listPending()[0].id, true);
    await first;

    await expect(accessGate.request({ ip: "192.168.1.22", path: "/b" })).resolves.toBe(
      true
    );
    expect(accessGate.listPending()).toHaveLength(0);
  });

  test("the mapped and bare forms of one address are the same machine", async () => {
    const pending = accessGate.request({ ip: "::ffff:192.168.1.23", path: "/a" });
    accessGate.decide(accessGate.listPending()[0].id, true);
    await pending;
    // Miss the normalisation and the phone gets prompted again on its next
    // request, or worse, an approval silently fails to apply.
    expect(accessGate.isAllowed("192.168.1.23")).toBe(true);
  });

  test("several requests from one machine share a single prompt", async () => {
    const a = accessGate.request({ ip: "192.168.1.24", path: "/a" });
    const b = accessGate.request({ ip: "192.168.1.24", path: "/b" });
    const c = accessGate.request({ ip: "192.168.1.24", path: "/c" });

    // A dashboard load fires several XHRs at once; one prompt per request would
    // be unusable, and approval is a property of the machine anyway.
    expect(accessGate.listPending()).toHaveLength(1);
    accessGate.decide(accessGate.listPending()[0].id, true);
    await expect(Promise.all([a, b, c])).resolves.toEqual([true, true, true]);
  });

  test("deciding on an id that is no longer waiting reports so", () => {
    expect(accessGate.decide("acc-nope", true)).toBe(false);
  });
});

describe("remembering", () => {
  test("a plain approval is not written to disk", async () => {
    const pending = accessGate.request({ ip: "192.168.1.30", path: "/a" });
    accessGate.decide(accessGate.listPending()[0].id, true);
    await pending;

    expect(accessGate.isAllowed("192.168.1.30")).toBe(true);
    // Session and durable are separate sets on purpose: otherwise a "just this
    // once" approval ends up persisted by the next unrelated save.
    expect(accessGate.remembered()).toEqual([]);
    expect(accessGate.allowedNow()).toEqual(["192.168.1.30"]);
  });

  test("remember: true persists, and calls back exactly once", async () => {
    const persist = jest.fn();
    accessGate.configure({ persist });

    const pending = accessGate.request({ ip: "192.168.1.31", path: "/a" });
    accessGate.decide(accessGate.listPending()[0].id, true, { remember: true });
    await pending;

    expect(accessGate.remembered()).toEqual(["192.168.1.31"]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  test("seeding at boot allows without asking", () => {
    accessGate.setRemembered(["::ffff:192.168.1.32", "10.0.0.9"]);
    expect(accessGate.isAllowed("192.168.1.32")).toBe(true);
    expect(accessGate.remembered()).toEqual(["10.0.0.9", "192.168.1.32"]);
  });

  test("revoking drops it from both sets and persists", () => {
    const persist = jest.fn();
    accessGate.configure({ persist });
    accessGate.setRemembered(["192.168.1.33"]);

    expect(accessGate.revoke("192.168.1.33")).toBe(true);
    expect(accessGate.isAllowed("192.168.1.33")).toBe(false);
    expect(accessGate.remembered()).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(accessGate.revoke("192.168.1.33")).toBe(false);
  });
});

describe("caps", () => {
  test("beyond MAX_PENDING_IPS, further machines are denied outright", async () => {
    const held = [];
    for (let i = 0; i < accessGate.MAX_PENDING_IPS; i++) {
      held.push(accessGate.request({ ip: `10.1.0.${i}`, path: "/a" }));
    }
    expect(accessGate.listPending()).toHaveLength(accessGate.MAX_PENDING_IPS);

    // Each held request is a live response plus a timer. Uncapped, a loop of
    // curls is memory exhaustion that needs no credentials.
    await expect(accessGate.request({ ip: "10.1.9.9", path: "/a" })).resolves.toBe(false);
    expect(accessGate.listPending()).toHaveLength(accessGate.MAX_PENDING_IPS);

    accessGate.reset();
    await Promise.all(held);
  });

  test("beyond MAX_WAITERS_PER_IP, extra requests are denied but the prompt stands", async () => {
    const ip = "10.2.0.1";
    const held = [];
    for (let i = 0; i < accessGate.MAX_WAITERS_PER_IP; i++) {
      held.push(accessGate.request({ ip, path: `/${i}` }));
    }
    await expect(accessGate.request({ ip, path: "/extra" })).resolves.toBe(false);
    expect(accessGate.listPending()).toHaveLength(1);

    accessGate.reset();
    await Promise.all(held);
  });
});

describe("timeout", () => {
  test("an unanswered request is denied, and not remembered", async () => {
    jest.useFakeTimers();
    try {
      const pending = accessGate.request({ ip: "192.168.1.40", path: "/a" });
      jest.advanceTimersByTime(accessGate.TIMEOUT_MS + 1);
      await expect(pending).resolves.toBe(false);
      expect(accessGate.isAllowed("192.168.1.40")).toBe(false);
      // Nothing is recorded, so the machine can simply try again once somebody
      // is looking at the screen.
      expect(accessGate.listPending()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("the decision routes", () => {
  test("loopback can list and decide", async () => {
    const app = appAsClient("127.0.0.1");
    const pending = accessGate.request({ ip: "192.168.1.50", path: "/__admin/config" });

    const list = await request(app).get("/__admin/access").expect(200);
    expect(list.body.pending).toHaveLength(1);

    await request(app)
      .post("/__admin/access/decision")
      .send({ id: list.body.pending[0].id, allow: true })
      .expect(200);

    await expect(pending).resolves.toBe(true);
  });

  test("a remote caller cannot approve itself", async () => {
    const app = appAsClient("192.168.1.51");
    accessGate.request({ ip: "192.168.1.51", path: "/__admin/config" });
    const id = accessGate.listPending()[0].id;

    // The whole mechanism rests on this. Reachable from the network, the gate
    // would be decorative: the caller would simply let itself in.
    await request(app)
      .post("/__admin/access/decision")
      .send({ id, allow: true })
      .expect(403);

    expect(accessGate.isAllowed("192.168.1.51")).toBe(false);
  });

  test("a remote caller cannot read who is waiting, or revoke", async () => {
    const app = appAsClient("192.168.1.52");
    await request(app).get("/__admin/access").expect(403);
    await request(app).delete("/__admin/access/192.168.1.52").expect(403);
  });

  test("an IPv6-mapped remote address is still remote", async () => {
    const app = appAsClient("::ffff:192.168.1.53");
    await request(app).get("/__admin/access").expect(403);
  });

  test("rejects a malformed decision", async () => {
    const app = appAsClient("127.0.0.1");
    await request(app).post("/__admin/access/decision").send({ allow: true }).expect(400);
    await request(app).post("/__admin/access/decision").send({ id: "x" }).expect(400);
    // Nothing waiting under that id.
    await request(app)
      .post("/__admin/access/decision")
      .send({ id: "acc-gone", allow: true })
      .expect(404);
  });
});
