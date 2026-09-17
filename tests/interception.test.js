/**
 * interception.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Covers the proxy's MITM predicate. These run without a socket because
 * utils/interception.js is deliberately pure.
 *
 * The back-fill that used to live here (`seedHostSettings`) and the
 * "is this worth writing to disk?" rule (`isPersistworthy`) both moved into
 * utils/state-store.js when state.json became the only source of targets — they
 * are only meaningful against a file layout now. See tests/state-store.test.js.
 */

const {
  DEFAULT_HOST_SETTINGS,
  hostOf,
  resolveInstanceForHost,
  shouldMitm,
  settingsFor,
} = require("../utils/interception");

const CONFIGS = [
  { id: "api", target: "https://api-qa.example.com" },
  { id: "auth", target: "https://auth-qa.example.com" },
];

describe("hostOf", () => {
  test("extracts the hostname, ignoring protocol, port and path", () => {
    expect(hostOf("https://api.example.com")).toBe("api.example.com");
    expect(hostOf("http://api.example.com:8443/v1/things?a=1")).toBe("api.example.com");
  });

  test("returns null for malformed or missing targets", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});

describe("resolveInstanceForHost", () => {
  test("matches a configured target by hostname", () => {
    expect(resolveInstanceForHost("auth-qa.example.com", CONFIGS).id).toBe("auth");
  });

  test("returns null for an unknown host", () => {
    expect(resolveInstanceForHost("cdn.example.com", CONFIGS)).toBeNull();
  });

  test("is not fooled by a suffix or substring match", () => {
    expect(resolveInstanceForHost("evil-auth-qa.example.com", CONFIGS)).toBeNull();
    expect(resolveInstanceForHost("somewhere-else.com", CONFIGS)).toBeNull();
  });

  test("skips configs whose target is a malformed URL", () => {
    const configs = [{ id: "broken", target: "://nope" }, ...CONFIGS];
    expect(resolveInstanceForHost("auth-qa.example.com", configs).id).toBe("auth");
    expect(resolveInstanceForHost("nope", configs)).toBeNull();
  });

  test("tolerates a missing hostname or serverConfigs", () => {
    expect(resolveInstanceForHost(undefined, CONFIGS)).toBeNull();
    expect(resolveInstanceForHost("auth-qa.example.com", undefined)).toBeNull();
  });
});

describe("shouldMitm", () => {
  const SSL_ON = {
    "auth-qa.example.com": { ssl: true, focus: "none", instanceId: "auth" },
    "cdn.example.com": { ssl: true, focus: "none", instanceId: null },
    "api-qa.example.com": {
      ssl: false,
      focus: "none",
      instanceId: "api",
    },
  };

  test("intercepts a host with SSL proxying enabled", () => {
    expect(
      shouldMitm("auth-qa.example.com", {
        serverConfigs: CONFIGS,
        hostSettings: SSL_ON,
      })
    ).toBe(true);
  });

  test("tunnels a configured host whose SSL proxying is off", () => {
    // The whole point of the switch: being in config.js is no longer enough.
    expect(
      shouldMitm("api-qa.example.com", {
        serverConfigs: CONFIGS,
        hostSettings: SSL_ON,
      })
    ).toBe(false);
  });

  test("tunnels a host nobody has enabled", () => {
    expect(
      shouldMitm("other.example.com", { serverConfigs: CONFIGS, hostSettings: SSL_ON })
    ).toBe(false);
  });

  test("tunnels when SSL is on but no instance backs the host", () => {
    // Nothing would own the mock pipeline, so decrypting would be pointless.
    expect(
      shouldMitm("cdn.example.com", { serverConfigs: CONFIGS, hostSettings: SSL_ON })
    ).toBe(false);
  });

  test("tunnels when there are no settings or no context at all", () => {
    expect(shouldMitm("auth-qa.example.com", { serverConfigs: CONFIGS })).toBe(false);
    expect(shouldMitm("cdn.example.com")).toBe(false);
    expect(shouldMitm(undefined, { serverConfigs: CONFIGS, hostSettings: SSL_ON })).toBe(
      false
    );
  });
});

describe("settingsFor", () => {
  test("fills in defaults for an unseen host", () => {
    expect(settingsFor({}, "cdn.example.com")).toEqual(DEFAULT_HOST_SETTINGS);
  });

  test("merges partial entries over the defaults", () => {
    const merged = settingsFor({ "a.com": { ssl: true } }, "a.com");
    expect(merged).toEqual({ ssl: true, focus: "none", instanceId: null, blocks: [] });
  });

  test("the default block list is frozen, so it cannot be pushed onto", () => {
    // Every host without rules of its own shares this one array. A push here
    // would block a path on all of them at once; freezing turns that into a
    // throw at the mistake instead of a mystery later.
    const merged = settingsFor({}, "a.com");
    expect(Object.isFrozen(merged.blocks)).toBe(true);
    expect(() => merged.blocks.push("/x")).toThrow();
  });

  test("returns a copy, so callers can't mutate the store through it", () => {
    const hostSettings = { "a.com": { ssl: true, focus: "none", instanceId: null } };
    settingsFor(hostSettings, "a.com").ssl = false;
    expect(hostSettings["a.com"].ssl).toBe(true);
  });
});
