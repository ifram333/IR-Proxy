/**
 * security.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The hardening that is easy to undo by accident.
 *
 * Each of these guards something whose failure is silent: a profile name that
 * carries markup looks fine until it runs, and a private key with the wrong mode
 * looks fine forever. Neither shows up in ordinary use, so only a test keeps
 * them true.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const createAdminRouter = require("../utils/admin-router");
const loadMocks = require("../utils/mock-loader");

const INSTANCE_ID = "test";

let MOCKS_DIR;
let store;
let app;

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-sec-"));
  loadMocks.invalidate();

  store = {
    instanceStatus: { [INSTANCE_ID]: { Login: true } },
    instanceSettings: {
      [INSTANCE_ID]: { isActive: true, targetUrl: "http://example.test", latency: 0 },
    },
    profiles: {},
    hostSettings: {},
  };

  app = express();
  app.use(express.json());
  app.use(
    "/__admin",
    createAdminRouter({
      MOCKS_DIR,
      STATE_FILE: null,
      store,
      serverConfigs: [
        { id: INSTANCE_ID, port: 3999, target: "http://example.test", name: "Test" },
      ],
      saveState: () => {},
      instanceId: INSTANCE_ID,
    })
  );
});

// Bind the app once, instead of letting supertest bind a fresh ephemeral
// port per request. Declared as its own hook so it runs after the setup
// above, whatever that setup looks like. See helpers/serve.js.
beforeAll(() => {
  app = serve(app);
});

afterAll(() => fs.rmSync(MOCKS_DIR, { recursive: true, force: true }));

describe("profile names", () => {
  // A profile name went from the wire straight into innerHTML and into an
  // onclick attribute. With the admin API reachable from the network, that was
  // stored XSS in the one page that can read every decrypted request.
  const HOSTILE = [
    "<img src=x onerror=alert(1)>",
    `" onmouseover="alert(1)`,
    "it's fine'); alert(1); ('",
    "back`tick",
    "new\nline",
  ];

  test.each(HOSTILE)("rejects %j", async (name) => {
    const res = await request(app).post("/__admin/profiles/save").send({ name });
    expect(res.status).toBe(400);
    expect(store.profiles).not.toHaveProperty(name);
  });

  test("an ordinary name is accepted, and trimmed", async () => {
    await request(app)
      .post("/__admin/profiles/save")
      .send({ name: "  Smoke tests (QA)  " })
      .expect(200);
    expect(store.profiles).toHaveProperty("Smoke tests (QA)");
  });

  test("a missing name is still a 400", async () => {
    await request(app).post("/__admin/profiles/save").send({}).expect(400);
  });
});

describe("CA private key", () => {
  // Loaded fresh per test: cert-manager reads its directory from the
  // environment at require time, and caches the CA in module state.
  const withCertsDir = (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-ca-"));
    const previous = process.env.IR_PROXY_CERTS_DIR;
    process.env.IR_PROXY_CERTS_DIR = dir;
    jest.resetModules();
    const logs = jest.spyOn(console, "log").mockImplementation(() => {});
    const warns = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      return fn(dir, require("../utils/cert-manager"), warns);
    } finally {
      logs.mockRestore();
      warns.mockRestore();
      if (previous === undefined) delete process.env.IR_PROXY_CERTS_DIR;
      else process.env.IR_PROXY_CERTS_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const modeOf = (file) => fs.statSync(file).mode & 0o777;

  // POSIX modes on Windows are a fiction, so there is nothing to assert there.
  const itPosix = process.platform === "win32" ? test.skip : test;

  itPosix("is created owner-only", () => {
    withCertsDir((dir, certManager) => {
      certManager.ensureCA();
      // Anyone who can read this key can mint certificates that every device
      // you onboarded already trusts.
      expect(modeOf(path.join(dir, "ca.key"))).toBe(0o600);
    });
  });

  itPosix("a key left world-readable is tightened on load, loudly", () => {
    withCertsDir((dir, certManager, warns) => {
      certManager.ensureCA();
      const keyPath = path.join(dir, "ca.key");
      // Simulate a CA generated before the mode was enforced.
      fs.chmodSync(keyPath, 0o644);

      jest.resetModules();
      require("../utils/cert-manager").ensureCA();

      expect(modeOf(keyPath)).toBe(0o600);
      // Silently changing permissions on someone's key would be worse than
      // leaving them: the warning is what tells them to consider regenerating.
      expect(warns).toHaveBeenCalled();
      expect(warns.mock.calls.flat().join(" ")).toMatch(/tightened to 600/);
    });
  });

  itPosix("a key that is already 600 is left alone and says nothing", () => {
    withCertsDir((dir, certManager, warns) => {
      certManager.ensureCA();
      warns.mockClear();

      jest.resetModules();
      require("../utils/cert-manager").ensureCA();

      expect(warns).not.toHaveBeenCalled();
    });
  });
});
