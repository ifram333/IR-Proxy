const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the CA at a throwaway directory BEFORE requiring the module so the
// real repo certs/ is never touched.
const tmpCerts = fs.mkdtempSync(path.join(os.tmpdir(), "ir-proxy-certs-"));
process.env.IR_PROXY_CERTS_DIR = tmpCerts;

const certManager = require("../utils/cert-manager");
const forge = require("node-forge");

// RSA keygen is comparatively slow.
jest.setTimeout(30000);

afterAll(() => fs.rmSync(tmpCerts, { recursive: true, force: true }));

describe("cert-manager", () => {
  test("ensureCA generates and persists a CA on first run", () => {
    certManager.ensureCA();
    expect(fs.existsSync(path.join(tmpCerts, "ca.key"))).toBe(true);
    expect(fs.existsSync(path.join(tmpCerts, "ca.crt"))).toBe(true);
    expect(certManager.getCACertPem()).toContain("BEGIN CERTIFICATE");
  });

  test("ensureCA is idempotent (loads the existing CA, no regeneration)", () => {
    const before = fs.readFileSync(path.join(tmpCerts, "ca.crt"), "utf8");
    certManager.ensureCA();
    const after = fs.readFileSync(path.join(tmpCerts, "ca.crt"), "utf8");
    expect(after).toBe(before);
  });

  test("getCACertDer returns a DER Buffer", () => {
    const der = certManager.getCACertDer();
    expect(Buffer.isBuffer(der)).toBe(true);
    expect(der.length).toBeGreaterThan(0);
  });

  test("getHostCert signs a leaf cert for the hostname and caches it", () => {
    const pair = certManager.getHostCert("example.test");
    expect(pair.key).toContain("BEGIN RSA PRIVATE KEY");
    expect(pair.cert).toContain("BEGIN CERTIFICATE");

    // Subject CN should be the requested hostname
    const cert = forge.pki.certificateFromPem(pair.cert);
    expect(cert.subject.getField("CN").value).toBe("example.test");

    // Cached: a second call returns the same object reference
    expect(certManager.getHostCert("example.test")).toBe(pair);
  });
});
