/**
 * Global state store for all proxy instances.
 * instanceStatus: { [instanceId]: { [mockName]: boolean } }
 * instanceSettings: { [instanceId]: { isActive: boolean, targetUrl: string, latency: number } }
 *   `latency` adds N ms to every response of the instance (mock and proxied)
 *   to simulate slow networks; 0 disables it.
 *   `targetUrl` is where unmocked requests are *forwarded*, which is not
 *   necessarily the host being *intercepted* — see utils/state-store.js.
 *
 * These slices are keyed by instance id; `hostSettings` below is keyed by
 * hostname. On disk both are folded into a single entry per host.
 */
module.exports = {
  instanceStatus: {},
  instanceSettings: {},
  profiles: {},
  // Durable per-host preferences, keyed by bare hostname:
  //   { ssl: boolean, focus: "none"|"focus"|"ignore", instanceId: string|null }
  // `ssl` is what decides whether the proxy TLS-terminates the host; `focus`
  // drives which section of the dashboard tree it appears in. Only entries the
  // user actually acted on reach the disk (utils/state-store.js drops the
  // all-default ones) — the transient "we saw this host" data lives in
  // utils/host-registry.js instead.
  hostSettings: {},
  // Whether the optional direct per-instance servers (:3000/:3001/:3002) are
  // running. Persisted so the choice survives restarts; toggled at runtime from
  // the dashboard or CLI via the standalone-manager.
  standaloneInstances: false,
  // Machines allowed through the access gate with "remember" ticked, as
  // normalised IP strings. The live set is owned by utils/access-gate.js; this
  // is only what gets written to disk. See its header for why remembering an
  // address is opt-in.
  allowedClients: [],
  // Port the unified proxy actually bound at runtime (preferredPort or the
  // next free one). Set by proxy-server.js after listen so the admin router
  // can loop requests back through the proxy (replay). Never persisted —
  // saveState() whitelists what it writes.
  proxyPort: null,
};
