/**
 * Certificate downloads and proxy status.
 *
 * The certificate routes stay reachable without approval on purpose: a phone has to
 * install the CA before it can get far enough to ask for access.
 *
 * Registered onto the shared /__admin router by admin-router.js.
 */

"use strict";

const certManager = require("../cert-manager");
const networkWatch = require("../network-watch");
const { hostOf } = require("../interception");

module.exports = function registerProxyInfo(router, ctx) {
  const { store, serverConfigs } = ctx;

  // ── Proxy: certificate downloads & status ────────────────────────────────

  /** Download the Root CA in PEM format (macOS, Linux, Android, Windows). */
  router.get("/proxy/ca.pem", (_req, res) => {
    const pem = certManager.getCACertPem();
    if (!pem) return res.status(503).send("CA not initialized yet.");
    res.setHeader("Content-Type", "application/x-pem-file");
    res.setHeader("Content-Disposition", 'attachment; filename="ir-proxy-ca.pem"');
    res.send(pem);
  });

  /** Download the Root CA in DER format (iOS — install as Configuration Profile). */
  router.get("/proxy/ca.cer", (_req, res) => {
    const der = certManager.getCACertDer();
    if (!der) return res.status(503).send("CA not initialized yet.");
    res.setHeader("Content-Type", "application/x-x509-ca-cert");
    res.setHeader("Content-Disposition", 'attachment; filename="ir-proxy-ca.cer"');
    res.send(der);
  });

  /**
   * Download a pre-built network_security_config.xml for Android apps (API 24+).
   * Trusts the system CA store AND the user-installed CA store so apps that
   * don't ship their own network security config can see MITM traffic.
   */
  router.get("/proxy/network-security-config", (_req, res) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<!--
  IR Proxy — Android Network Security Config
  ─────────────────────────────────────────────────
  Place this file at: app/src/main/res/xml/network_security_config.xml
  Then add to your AndroidManifest.xml <application> tag:
      android:networkSecurityConfig="@xml/network_security_config"

  This config trusts both the system CA store (production certs) AND
  the user-installed CA store (the IR Proxy CA you installed).
  Remove or revert before publishing to production.
-->
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <!-- Trust preinstalled CAs (e.g. Let's Encrypt, DigiCert) -->
            <certificates src="system" />
            <!-- Trust user-installed CAs (e.g. IR Proxy CA) -->
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="network_security_config.xml"'
    );
    res.send(xml);
  });

  /** Proxy status: port, intercepted targets, pass-through mode. */
  router.get("/proxy/status", (_req, res) => {
    // `mode` used to be hardcoded "MITM" for every config entry, which was
    // already only true by accident. It now reports what the proxy will
    // actually do with the host on its next connection.
    const targets = serverConfigs.map((c) => {
      const host = hostOf(c.target);
      const ssl = host ? store.hostSettings[host]?.ssl === true : false;
      return {
        id: c.id,
        name: c.name,
        target: c.target,
        host,
        mode: ssl ? "MITM" : "TUNNEL",
      };
    });

    // Detect local IPs to help the user configure devices
    const localIPs = networkWatch.localIPs();

    res.json({
      proxyEnabled: true,
      caReady: !!certManager.getCACertPem(),
      localIPs,
      interceptedTargets: targets,
      passThrough: "All other hosts tunnel transparently (no decryption).",
    });
  });

  /**
   * Local IPs + bound port, for the static setup page. The page used to tell
   * the reader to go and find these themselves, which they could not do from
   * the phone they were setting up.
   */
  router.get("/proxy/info", (_req, res) => {
    const localIPs = networkWatch.localIPs();

    res.json({
      localIPs,
      port: store.proxyPort || null,
      caReady: !!certManager.getCACertPem(),
    });
  });

  /**
   * The install guide is now a static page (public/install-guide.html) so it
   * can be edited without touching the backend, and so mobile visitors to the
   * dashboard can be sent somewhere real. Kept as a redirect because this URL
   * is printed at startup and is very likely bookmarked.
   */
  router.get("/proxy/install-guide", (_req, res) => {
    res.redirect(302, "/install-guide.html");
  });
};
