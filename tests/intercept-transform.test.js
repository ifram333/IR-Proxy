/**
 * Intercept/transform robustness — runs the real proxy handler against a local
 * upstream server and asserts:
 *   • JSON transforms still work (including gzip-encoded upstreams).
 *   • Binary payloads pass through byte-identical (no UTF-8 mangling).
 *   • Non-JSON content types skip the transform instead of corrupting it.
 *   • A throwing transform serves the original body and surfaces the error
 *     in the activity-log entry instead of failing silently.
 *   • An unreachable upstream answers 502 instead of hanging.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const { createMockMiddleware, createProxyHandler } = require("../utils/mock-pipeline");
const { createLoggerMiddleware } = require("../utils/request-log");
const requestLog = require("../utils/request-log");
const loadMocks = require("../utils/mock-loader");

const INSTANCE_ID = "tx";
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x01,
]);

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(Buffer.from(c)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

let MOCKS_DIR;
let upstream;
let store;
let app;

beforeAll(async () => {
  // Local upstream the proxy handler forwards to.
  upstream = http.createServer((req, res) => {
    if (req.url === "/json" || req.url === "/boom") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ value: 1 }));
    }
    if (req.url === "/gzip") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      });
      return res.end(zlib.gzipSync(JSON.stringify({ value: 1 })));
    }
    if (req.url === "/binary" || req.url === "/binary-plain") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PNG_BYTES);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  MOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-tx-"));
  fs.writeFileSync(
    path.join(MOCKS_DIR, "intercepts.mock.js"),
    `module.exports = [
       { name: "TxJson", match: (req) => req.path === "/json",
         interceptResponse: true, transform: (d) => ({ ...d, mocked: true }) },
       { name: "TxGzip", match: (req) => req.path === "/gzip",
         interceptResponse: true, transform: (d) => ({ ...d, mocked: true }) },
       { name: "TxBinary", match: (req) => req.path === "/binary",
         interceptResponse: true, transform: (d) => d },
       { name: "TxBoom", match: (req) => req.path === "/boom",
         interceptResponse: true, transform: () => { throw new Error("boom"); } },
     ];`
  );

  store = {
    instanceStatus: {
      [INSTANCE_ID]: { TxJson: true, TxGzip: true, TxBinary: true, TxBoom: true },
    },
    instanceSettings: {
      [INSTANCE_ID]: { isActive: true, targetUrl: upstreamUrl, latency: 0 },
    },
    profiles: {},
  };

  loadMocks.invalidate();
  requestLog.clearLog();

  app = express();
  app.use(createLoggerMiddleware(INSTANCE_ID));
  app.use(createMockMiddleware(INSTANCE_ID, store, MOCKS_DIR));
  app.use("/", createProxyHandler(INSTANCE_ID, store));
});

// Bind the app once, instead of letting supertest bind a fresh ephemeral
// port per request. Declared as its own hook so it runs after the setup
// above, whatever that setup looks like. See helpers/serve.js.
beforeAll(() => {
  app = serve(app);
});

afterAll(async () => {
  fs.rmSync(MOCKS_DIR, { recursive: true, force: true });
  await new Promise((resolve) => upstream.close(resolve));
});

describe("intercept-response transforms", () => {
  test("transforms a plain JSON upstream response", async () => {
    const res = await request(app).get("/json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ value: 1, mocked: true });

    const entry = requestLog.getHistory().find((e) => e.path === "/json");
    expect(entry.source).toBe("intercept");
    expect(entry.mockName).toBe("TxJson");
    expect(entry.transformError).toBeUndefined();
  });

  test("transforms a gzip-encoded JSON upstream response", async () => {
    const res = await request(app).get("/gzip");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ value: 1, mocked: true });
    // The interceptor pipeline serves the decompressed body.
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  test("binary responses pass through byte-identical when a transform is active", async () => {
    const res = await request(app).get("/binary").buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, PNG_BYTES)).toBe(0);

    // The skipped transform is surfaced in the log instead of corrupting bytes.
    const entry = requestLog.getHistory().find((e) => e.path === "/binary");
    expect(entry.transformError).toMatch(/not JSON/);
  });

  test("binary responses pass through byte-identical on the plain proxy path", async () => {
    const res = await request(app).get("/binary-plain").buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, PNG_BYTES)).toBe(0);

    const entry = requestLog.getHistory().find((e) => e.path === "/binary-plain");
    expect(entry.source).toBe("proxy");
    expect(entry.transformError).toBeUndefined();
  });

  test("a throwing transform serves the original body and logs the error", async () => {
    const res = await request(app).get("/boom");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ value: 1 });

    const entry = requestLog.getHistory().find((e) => e.path === "/boom");
    expect(entry.source).toBe("intercept");
    expect(entry.transformError).toBe("boom");
  });

  test("an unreachable upstream answers 502 instead of hanging", async () => {
    const original = store.instanceSettings[INSTANCE_ID].targetUrl;
    store.instanceSettings[INSTANCE_ID].targetUrl = "http://127.0.0.1:1";
    try {
      const res = await request(app).get("/unreachable");
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Upstream/);
    } finally {
      store.instanceSettings[INSTANCE_ID].targetUrl = original;
    }
  });
});
