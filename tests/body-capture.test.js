/**
 * A request body reaches the upstream exactly as it was sent.
 *
 * Both halves of this were once wrong, and both were invisible from the client:
 * the round-trip through `fixRequestBody` rewrote form bodies, and Express's
 * default `100kb` parser limit turned a large one into a `413` the upstream
 * never sent. So every assertion here is on the **raw bytes the upstream
 * received**, not on a status code — a status code was 200 through the whole
 * bug.
 */
const http = require("http");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const { createProxyHandler } = require("../utils/mock-pipeline");
const bodyCapture = require("../utils/body-capture");

const INSTANCE_ID = "bc";

let upstream;
let seen; // raw bytes of the last body the upstream received
let parsed; // what req.body held inside the instance app
let app;

/** Build an instance app around a given body-capture module (real or re-read). */
const buildApp = (capture) => {
  const a = express();
  capture.parsers().forEach((p) => a.use(p));
  a.use((req, _res, next) => {
    parsed = req.body;
    next();
  });
  a.use(
    "/",
    createProxyHandler(INSTANCE_ID, {
      instanceSettings: {
        [INSTANCE_ID]: {
          isActive: true,
          targetUrl: `http://127.0.0.1:${upstream.address().port}`,
          latency: 0,
        },
      },
    })
  );
  return a;
};

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const bufs = [];
    req.on("data", (c) => bufs.push(c));
    req.on("end", () => {
      seen = Buffer.concat(bufs);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  app = serve(buildApp(bodyCapture));
});

afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
});

beforeEach(() => {
  seen = undefined;
  parsed = undefined;
});

describe("the body is forwarded verbatim", () => {
  test("a form body holding brackets is not rewritten by the qs round-trip", async () => {
    // The reported bug, at its smallest: `[` and `]` are nested-key notation to
    // `qs`, so parsing and re-stringifying a body that merely *contains* them
    // rebuilt something else. The real one lost 1146 of 1282 characters and
    // still answered 200.
    const body = '{"a": [], "b": {"c": "d%20e"}}';
    await request(app)
      .post("/save")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(body)
      .expect(200);

    expect(seen.toString("utf8")).toBe(body);
  });

  test("a JSON body keeps its whitespace and key order", async () => {
    // `fixRequestBody` re-serialises with JSON.stringify, which is lossless for
    // meaning and not for bytes — and a proxy is judged on bytes.
    const body = '{\n  "b": 1,\n  "a": 2\n}';
    await request(app)
      .post("/save")
      .set("Content-Type", "application/json")
      .send(body)
      .expect(200);

    expect(seen.toString("utf8")).toBe(body);
    // Still parsed, so mocks can match on it and the log can record it.
    expect(parsed).toEqual({ b: 1, a: 2 });
  });

  test("a text body is forwarded and parsed", async () => {
    const body = "<order><id>7</id></order>";
    await request(app)
      .post("/save")
      .set("Content-Type", "application/xml")
      .send(body)
      .expect(200);

    expect(seen.toString("utf8")).toBe(body);
    expect(parsed).toBe(body);
  });

  test("a type no parser claims streams through untouched", async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    await request(app)
      .post("/save")
      .set("Content-Type", "image/png")
      .send(body)
      .expect(200);

    expect(Buffer.compare(seen, body)).toBe(0);
    // Nothing read it, so it is invisible in the dashboard — see docs/ROADMAP.md.
    expect(parsed).toBeUndefined();
  });
});

describe("a body too large to hold", () => {
  let bigApp;
  let capture;

  beforeAll(() => {
    // Re-read the module with a tiny threshold: the same rule, without pushing
    // megabytes through a test.
    jest.resetModules();
    process.env.IR_PROXY_MAX_PARSE_BYTES = "512";
    capture = require("../utils/body-capture");
    delete process.env.IR_PROXY_MAX_PARSE_BYTES;
    bigApp = serve(buildApp(capture));
  });

  afterAll(() => {
    jest.resetModules();
  });

  test("is forwarded whole instead of being refused", async () => {
    // Express's parsers answer 413 past their limit, which made the proxy the
    // author of an error the upstream never sent — and only for the types a
    // parser claims, so the same payload sent as binary went through. A proxy
    // inventing a 4xx is worse than one that cannot show you the body.
    const body = JSON.stringify({ d: "x".repeat(2000) });
    expect(body.length).toBeGreaterThan(capture.MAX_PARSE_BYTES);

    await request(bigApp)
      .post("/save")
      .set("Content-Type", "application/json")
      .send(body)
      .expect(200);

    expect(seen.toString("utf8")).toBe(body);
    // The half that is given up: nothing read it, so it is not in the log.
    expect(parsed).toBeUndefined();
  });

  test("one under the threshold is still parsed", async () => {
    await request(bigApp)
      .post("/save")
      .set("Content-Type", "application/json")
      .send({ small: true })
      .expect(200);

    expect(parsed).toEqual({ small: true });
  });
});
