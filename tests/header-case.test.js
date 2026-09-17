/**
 * Header field-name case survives the proxy hop.
 *
 * Node's HTTP parser folds every incoming field name to lowercase in
 * `req.headers`, and http-proxy builds the upstream request straight from that
 * map — so without `restoreHeaderCase` a client that sends `tokenId` has it
 * forwarded as `tokenid`. RFC 9110 says a correct backend must not care; plenty
 * of real ones do, and either way a debugging proxy that rewrites what it is
 * forwarding makes itself the variable in whatever bug brought you here.
 *
 * Runs the real `createProxyHandler` against a local upstream that reports its
 * own `rawHeaders`, because that is the only place the wire truth still exists:
 * asserting on the upstream's `req.headers` would be asserting on Node's fold
 * and would pass with the fix removed.
 */
const http = require("http");
const express = require("express");
const request = require("supertest");
const { serve } = require("./helpers/serve");

const { createProxyHandler } = require("../utils/mock-pipeline");
const headerCase = require("../utils/header-case");

const INSTANCE_ID = "hc";

let upstream;
let seen; // rawHeaders of the last request the upstream received, as pairs
let app;

/** The name the upstream saw for `lower`, or undefined if it never arrived. */
const nameOf = (lower) => seen.find(([n]) => n.toLowerCase() === lower)?.[0];
/** Every name the upstream saw for `lower` — duplicates are the bug to catch. */
const namesOf = (lower) =>
  seen.filter(([n]) => n.toLowerCase() === lower).map(([n]) => n);
const valueOf = (lower) => seen.find(([n]) => n.toLowerCase() === lower)?.[1];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      seen.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ body: body || null }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  app = express();
  app.use(
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
});

beforeAll(() => {
  app = serve(app);
});

afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
});

describe("header field-name case", () => {
  test("forwards mixed-case names exactly as the client wrote them", async () => {
    const res = await request(app)
      .get("/anything")
      .set("tokenId", "abc123")
      .set("appName", "MyApp")
      .set("X-Device-Id", "phone-7");

    expect(res.status).toBe(200);
    expect(nameOf("tokenid")).toBe("tokenId");
    expect(nameOf("appname")).toBe("appName");
    expect(nameOf("x-device-id")).toBe("X-Device-Id");
    // The values are untouched by any of this.
    expect(valueOf("tokenid")).toBe("abc123");
  });

  test("leaves an all-lowercase name lowercase", async () => {
    // Restoring from rawHeaders must not mean capitalising on the way out:
    // browsers send lowercase, and rewriting those would be the same lie in
    // the other direction.
    await request(app).get("/anything").set("x-all-lower", "1");
    expect(nameOf("x-all-lower")).toBe("x-all-lower");
  });

  test("keeps the proxy's Host value even when the client spelled it Host", async () => {
    // `changeOrigin` owns this header's *value*; the case restore only ever
    // renames, and must never hand back the client's original.
    await request(app).get("/anything").set("Host", "not-the-target.example");
    expect(valueOf("host")).toBe(`127.0.0.1:${upstream.address().port}`);
  });

  test("a body still arrives, with exactly one content-length", async () => {
    // `restoreHeaderCase` runs before `fixRequestBody`, which writes the body
    // and flushes the header block. Running it after would throw; keying the
    // restore off anything but the lowercase name could duplicate the length.
    const res = await request(app)
      .post("/anything")
      .set("Content-Type", "application/json")
      .set("tokenId", "abc123")
      .send({ hello: "world" });

    expect(res.status).toBe(200);
    expect(res.body.body).toBe(JSON.stringify({ hello: "world" }));
    expect(namesOf("content-length")).toHaveLength(1);
    expect(nameOf("content-type")).toBe("Content-Type");
    expect(nameOf("tokenid")).toBe("tokenId");
  });
});

describe("utils/header-case", () => {
  test("originalNames reports only the names that are not already lowercase", () => {
    const names = headerCase.originalNames([
      "tokenId",
      "a",
      "content-type",
      "application/json",
      "X-Device-Id",
      "phone-7",
    ]);
    // `content-type` arrived lowercase, so there is nothing to remember.
    expect(names).toEqual({ tokenid: "tokenId", "x-device-id": "X-Device-Id" });
  });

  test("originalNames keeps the first spelling of a repeated name", () => {
    // Node has already folded the two values into one, so there is no second
    // header left for a second spelling to belong to.
    const names = headerCase.originalNames(["Cookie", "a=1", "cookie", "b=2"]);
    expect(names).toEqual({ cookie: "Cookie" });
  });

  test("originalNames survives a request with no rawHeaders", () => {
    expect(headerCase.originalNames(undefined)).toEqual({});
  });

  test("applyNames renames only what it knows, and copies", () => {
    const input = { tokenid: "a", "x-new": "b" };
    const out = headerCase.applyNames(input, { tokenid: "tokenId" });
    expect(out).toEqual({ tokenId: "a", "x-new": "b" });
    expect(input).toEqual({ tokenid: "a", "x-new": "b" });
  });

  test("normalize folds two spellings of one header into one field", () => {
    // What a retry produces: the captured header, plus the same header sent
    // back from the editor with the spelling the inspector showed.
    const { headers, names } = headerCase.normalize({
      "content-type": "text/plain",
      "Content-Type": "application/json",
    });
    expect(headers).toEqual({ "content-type": "application/json" });
    expect(names).toEqual({ "content-type": "Content-Type" });
  });

  test("normalize lets a lowercase spelling clear an earlier capitalised one", () => {
    const { names } = headerCase.normalize({ tokenId: "a", tokenid: "b" });
    expect(names).toEqual({});
  });

  test("normalize and applyNames round-trip", () => {
    const original = { tokenId: "a", "x-plain": "b", "Content-Type": "text/plain" };
    const { headers, names } = headerCase.normalize(original);
    expect(headerCase.applyNames(headers, names)).toEqual(original);
  });
});
