/**
 * Single-instance guard — boots the real proxy on an ephemeral high port, then
 * checks what a *second* boot does.
 *
 * The distinction under test is the whole point: a busy port that answers as our
 * server must abort the boot, while a busy port holding anything else (the
 * developer's other debugging proxy on 8888, the case the scan exists for) must
 * still be stepped over.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { startProxyServer } = require("../proxy-server");
const loadMocks = require("../utils/mock-loader");
const { basePort } = require("./helpers/ports");

const INSTANCE_ID = "solo";
const BASE_PORT = basePort();

let MOCKS_DIR;
let logSpy;
const started = []; // proxies to tear down
const listeners = []; // plain http servers to tear down

function bootArgs(preferredPort) {
  return {
    serverConfigs: [
      { id: INSTANCE_ID, port: 3997, target: "http://127.0.0.1:9", name: "Solo" },
    ],
    store: {
      instanceStatus: {},
      instanceSettings: {
        [INSTANCE_ID]: { isActive: true, targetUrl: "http://127.0.0.1:1", latency: 0 },
      },
      profiles: {},
      hostSettings: {},
      proxyPort: null,
    },
    MOCKS_DIR,
    STATE_FILE: null,
    saveState: () => {},
    preferredPort,
  };
}

async function boot(preferredPort) {
  const proxy = await startProxyServer(bootArgs(preferredPort));
  started.push(proxy);
  if (!proxy.server.listening) {
    await new Promise((resolve) => proxy.server.once("listening", resolve));
  }
  return proxy;
}

/** Occupy a port with something that is emphatically not our admin server. */
function occupy(port, body) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => res.end(body));
    listeners.push(server);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

beforeAll(() => {
  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-solo-"));
  // The boot banner is several lines long and this suite boots repeatedly.
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  logSpy.mockRestore();
  for (const proxy of started) {
    if (proxy?.server) await new Promise((r) => proxy.server.close(r));
  }
  for (const server of listeners) {
    await new Promise((r) => server.close(r));
  }
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  loadMocks.invalidate();
  delete process.env.ALLOW_MULTIPLE_INSTANCES;
});

describe("second boot with our proxy already running", () => {
  test("refuses to start, naming the port that is already serving", async () => {
    const first = await boot(BASE_PORT);
    expect(first.port).toBe(BASE_PORT);

    // Before this guard existed, this call quietly returned a second proxy on
    // BASE_PORT + 1, sharing state.json with the first.
    await expect(startProxyServer(bootArgs(BASE_PORT))).rejects.toMatchObject({
      code: "EPROXYRUNNING",
      port: BASE_PORT,
    });
  });

  test("ALLOW_MULTIPLE_INSTANCES=1 opts back into the old behaviour", async () => {
    process.env.ALLOW_MULTIPLE_INSTANCES = "1";
    // BASE_PORT is still held by the first test's proxy.
    const second = await boot(BASE_PORT);
    expect(second.port).toBeGreaterThan(BASE_PORT);
  });
});

describe("a busy port that is not ours", () => {
  test("is scanned past, which is what the scan is for", async () => {
    const port = BASE_PORT + 10;
    await occupy(port, "not a mock proxy");

    const proxy = await boot(port);
    expect(proxy.port).toBe(port + 1);
  });

  test("JSON that isn't our health payload is still not us", async () => {
    const port = BASE_PORT + 20;
    // Shape matters, not merely parseability: `status` alone must not match.
    await occupy(port, JSON.stringify({ status: "ok" }));

    const proxy = await boot(port);
    expect(proxy.port).toBe(port + 1);
  });
});
