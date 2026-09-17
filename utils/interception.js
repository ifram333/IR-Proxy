/**
 * interception.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The proxy's interception predicate, extracted as a **pure** module: no I/O, no
 * requires, no shared mutable state of its own. Everything it needs arrives as
 * arguments.
 *
 * This exists because the decision "do we TLS-terminate this host or tunnel it
 * blind?" is the single most consequential branch in the codebase — it lives in
 * proxy-server.js, which has historically had no test coverage because starting
 * a real proxy in a test is awkward. Pulling the predicate out here makes it
 * unit-testable without a socket in sight.
 */

"use strict";

/** Per-host defaults. A host nobody has touched is observed but never decrypted. */
const DEFAULT_HOST_SETTINGS = Object.freeze({
  ssl: false,
  focus: "none", // "none" | "focus" | "ignore"
  instanceId: null,
  // Path prefixes whose requests are killed outright (see utils/blocking.js).
  // Frozen, and shared by every host that has none: the rule builders return
  // new arrays, so anything that tries to push onto this throws here instead of
  // silently blocking a path on every other host.
  blocks: Object.freeze([]),
});

/**
 * Extract the hostname from a target URL.
 * @param {string} target e.g. "https://api.example.com"
 * @returns {string|null} null when the URL is malformed
 */
function hostOf(target) {
  try {
    return new URL(target).hostname;
  } catch {
    return null;
  }
}

/**
 * Split a "host:port" pair — a CONNECT target or a Host header.
 *
 * A naive `split(":")` mangles IPv6 literals: `[::1]:443` comes back as
 * hostname `[` and port NaN, and everything downstream (the registry, the cert
 * cache, the MITM branch, the log's host field) is keyed on that hostname.
 *
 * @param {string} value
 * @returns {{hostname: string|null, port: number|null}} port is null when absent
 */
function splitHostPort(value) {
  const raw = String(value || "").trim();
  if (!raw) return { hostname: null, port: null };

  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(raw);
  if (!match) return { hostname: null, port: null };

  // Brackets stay off the hostname: tls/net and the cert manager want the bare
  // address, and that's what the Host header carries too.
  const hostname = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1];
  return { hostname, port: match[2] ? Number(match[2]) : null };
}

/**
 * Split a CONNECT request target, defaulting to the HTTPS port when the client
 * omits it.
 * @param {string} target
 * @returns {{hostname: string|null, port: number}}
 */
function parseConnectTarget(target) {
  const { hostname, port } = splitHostPort(target);
  return { hostname, port: port ?? 443 };
}

/**
 * Find the server config whose `target` URL shares this hostname.
 *
 * Matching ignores protocol, port and path — exactly as it always has, so
 * `example.com:8443` resolves to a config declared as `https://example.com`.
 *
 * @param {string} hostname
 * @param {Array<{id:string,target:string}>} serverConfigs
 * @returns {object|null}
 */
function resolveInstanceForHost(hostname, serverConfigs) {
  if (!hostname || !Array.isArray(serverConfigs)) return null;
  return serverConfigs.find((cfg) => hostOf(cfg.target) === hostname) || null;
}

/**
 * Should the proxy MITM this host, or tunnel it as opaque TCP?
 *
 * The user decides, per host, via `hostSettings[host].ssl`. Hosts nobody has
 * enabled are tunneled untouched — which is why merely browsing through the
 * proxy is safe, and why a host with certificate pinning keeps working until
 * you deliberately turn SSL proxying on for it.
 *
 * An instance must also exist, because that's what owns the mock pipeline the
 * decrypted request gets fed into. Enabling SSL creates one (see
 * `ensureInstanceForHost`), so in practice the two travel together; the check
 * guards the window where settings outlive their instance.
 *
 * @param {string} hostname
 * @param {object} ctx
 * @param {Array}  ctx.serverConfigs
 * @param {object} [ctx.hostSettings]
 * @returns {boolean}
 */
function shouldMitm(hostname, { serverConfigs, hostSettings } = {}) {
  if (!hostname) return false;
  const entry = hostSettings && hostSettings[hostname];
  if (!entry || entry.ssl !== true) return false;
  return !!resolveInstanceForHost(hostname, serverConfigs);
}

/**
 * Read a host's settings, filling in the defaults for anything absent.
 * Always returns a fresh object — callers must not mutate the store through it.
 *
 * @param {object} hostSettings
 * @param {string} hostname
 * @returns {{ssl:boolean, focus:string, instanceId:string|null}}
 */
function settingsFor(hostSettings, hostname) {
  return {
    ...DEFAULT_HOST_SETTINGS,
    ...((hostSettings && hostSettings[hostname]) || {}),
  };
}

module.exports = {
  DEFAULT_HOST_SETTINGS,
  hostOf,
  splitHostPort,
  parseConnectTarget,
  resolveInstanceForHost,
  shouldMitm,
  settingsFor,
};
