/**
 * Proxy configuration.
 *
 * Targets do NOT live here any more. Every host the proxy knows about — the ones
 * shipped as a starting point and the ones added from the dashboard alike — is
 * described in `state.json`, one entry per host (see utils/state-store.js). That
 * file is gitignored runtime state; `state.example.json` is the versioned
 * starting point, copied on first boot when there is nothing to load.
 *
 * The proxy *records* every host a device reaches for, but only decrypts the
 * ones with SSL proxying switched on (`ssl: true` on that host's entry — see
 * utils/interception.js). Everything else passes through as an unmodified TCP
 * tunnel.
 */
module.exports = {
  proxy: {
    /**
     * Tried first. If busy, the next available port is used and printed to the
     * console at startup — port 8888 is often already held by another proxy.
     */
    preferredPort: 8888,

    /**
     * Whether to start the optional per-instance Express servers at boot. Off by
     * default; the persisted choice in state.json wins once one exists.
     */
    standaloneInstances: false,
  },
};
