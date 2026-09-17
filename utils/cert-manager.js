/**
 * cert-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the proxy CA certificate lifecycle:
 *  - Generates a self-signed Root CA on first run and persists it to disk.
 *  - Signs per-hostname TLS certificates on-the-fly (cached in memory).
 *  - Exposes helpers to retrieve the CA in PEM and DER format for download.
 */

const forge = require("node-forge");
const fs = require("fs");
const path = require("path");

// Defaults to <repo>/certs; override with IR_PROXY_CERTS_DIR (used by tests
// to point the CA at a throwaway temp directory).
const CERTS_DIR = process.env.IR_PROXY_CERTS_DIR || path.join(__dirname, "../certs");
const CA_KEY_PATH = path.join(CERTS_DIR, "ca.key");
const CA_CRT_PATH = path.join(CERTS_DIR, "ca.crt");

const CA_CN = "IR Proxy CA";
const CA_ORG = "IR Proxy";
const CA_VALIDITY_YEARS = 5;

// ── In-memory state ──────────────────────────────────────────────────────────

let _caKey = null; // forge private key object
let _caCert = null; // forge certificate object
let _caCertPem = ""; // PEM string (for serving as download)

// hostname → { key: pemString, cert: pemString }
const _hostCertCache = new Map();

// ── CA bootstrap ─────────────────────────────────────────────────────────────

/**
 * Ensure the CA key/cert exist on disk. If not, generate and save them.
 * Loads them into memory on every startup.
 * Must be called before any other function in this module.
 */
/**
 * Narrow an already-written CA key to owner-only.
 *
 * Keys generated before this was enforced are sitting on disk world-readable,
 * and nothing about loading one fixes that — so the repair happens here rather
 * than as a warning nobody acts on. Announced, not silent: changing permissions
 * on someone's file should show up in the log that explains why.
 */
function tightenCAKeyPermissions() {
  // Windows POSIX modes are a fiction; chmod there reports success and changes
  // nothing meaningful, so a warning would only ever be noise.
  if (process.platform === "win32") return;
  try {
    const mode = fs.statSync(CA_KEY_PATH).mode & 0o777;
    if ((mode & 0o077) === 0) return;
    fs.chmodSync(CA_KEY_PATH, 0o600);
    console.warn(
      `🔒 [Proxy CA] ${CA_KEY_PATH} was ${mode.toString(8)} — tightened to 600.\n` +
        `   That key signs certificates your devices trust; anyone who could read\n` +
        `   it could impersonate any site to them. Consider regenerating it.`
    );
  } catch (err) {
    console.warn(`⚠️  [Proxy CA] Could not check the key's permissions: ${err.message}`);
  }
}

function ensureCA() {
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }

  if (fs.existsSync(CA_KEY_PATH) && fs.existsSync(CA_CRT_PATH)) {
    // Load existing CA
    const keyPem = fs.readFileSync(CA_KEY_PATH, "utf8");
    const certPem = fs.readFileSync(CA_CRT_PATH, "utf8");
    _caKey = forge.pki.privateKeyFromPem(keyPem);
    _caCert = forge.pki.certificateFromPem(certPem);
    _caCertPem = certPem;
    console.log("🔐 [Proxy CA] Loaded existing CA certificate from disk.");
    tightenCAKeyPermissions();
  } else {
    // Generate new CA
    console.log("🔑 [Proxy CA] Generating new Root CA (this may take a moment)…");
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = _randomSerial();

    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now);
    cert.validity.notAfter.setFullYear(now.getFullYear() + CA_VALIDITY_YEARS);

    const attrs = [
      { name: "commonName", value: CA_CN },
      { name: "organizationName", value: CA_ORG },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      {
        name: "keyUsage",
        keyCertSign: true,
        cRLSign: true,
        digitalSignature: true,
        critical: true,
      },
      {
        name: "subjectKeyIdentifier",
      },
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    _caKey = keys.privateKey;
    _caCert = cert;
    _caCertPem = forge.pki.certificateToPem(cert);

    // Owner-only. This key signs certificates that the developer's machine and
    // every phone they onboarded have been told to trust, so anyone who can read
    // it can impersonate any site to those devices. The default umask would
    // otherwise leave it world-readable.
    fs.writeFileSync(CA_KEY_PATH, forge.pki.privateKeyToPem(keys.privateKey), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.writeFileSync(CA_CRT_PATH, _caCertPem, "utf8");
    console.log(`✅ [Proxy CA] New Root CA generated and saved to ${CERTS_DIR}`);
  }
}

// ── Per-hostname certificate ─────────────────────────────────────────────────

/**
 * Returns a TLS key+cert pair for the given hostname, signed by the proxy CA.
 * Results are cached in memory so generation only happens once per hostname.
 *
 * @param {string} hostname
 * @returns {{ key: string, cert: string }} PEM strings
 */
function getHostCert(hostname) {
  if (_hostCertCache.has(hostname)) {
    return _hostCertCache.get(hostname);
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = _randomSerial();

  const now = new Date();
  cert.validity.notBefore = new Date(now - 60 * 1000); // 1 min leeway
  cert.validity.notAfter = new Date(now);
  cert.validity.notAfter.setFullYear(now.getFullYear() + 1);

  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer(_caCert.subject.attributes);

  cert.setExtensions([
    {
      name: "subjectAltName",
      altNames: [{ type: 2 /* DNS */, value: hostname }],
    },
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
    },
  ]);

  cert.sign(_caKey, forge.md.sha256.create());

  const pair = {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };

  _hostCertCache.set(hostname, pair);
  return pair;
}

// ── CA export helpers ────────────────────────────────────────────────────────

/** Returns the CA certificate as a PEM string. */
function getCACertPem() {
  return _caCertPem;
}

/**
 * Returns the CA certificate as a DER-encoded Buffer (for iOS .cer download).
 */
function getCACertDer() {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(_caCert));
  return Buffer.from(der.getBytes(), "binary");
}

/** Returns the absolute path to the CA cert file on disk. */
function getCACertPath() {
  return CA_CRT_PATH;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _randomSerial() {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { ensureCA, getHostCert, getCACertPem, getCACertDer, getCACertPath };
