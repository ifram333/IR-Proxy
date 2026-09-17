/**
 * network-watch.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Noticing that this machine's LAN address changed.
 *
 * Driven entirely through an injected interface reader: a test that depended on
 * the real network would pass or fail based on whether the laptop running it
 * happened to be on Wi-Fi.
 *
 * The assertion that matters most is the negative one — that a *reordering* is
 * not a change. Interface enumeration order isn't stable, so a naive comparison
 * would announce a phantom address change every few polls and train people to
 * ignore the one real notice.
 */

const networkWatch = require("../utils/network-watch");

/** Shaped like os.networkInterfaces(): named interfaces, mixed families. */
const interfaces =
  (v4 = [], extra = {}) =>
  () => ({
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en0: v4.map((address) => ({ family: "IPv4", internal: false, address })),
    ...extra,
  });

afterEach(() => networkWatch.reset());

describe("localIPs", () => {
  test("keeps external IPv4 only, sorted", () => {
    const read = interfaces(["192.168.1.20", "10.0.0.5"], {
      utun0: [{ family: "IPv6", internal: false, address: "fe80::1" }],
    });
    expect(networkWatch.localIPs(read)).toEqual(["10.0.0.5", "192.168.1.20"]);
  });

  test("an offline machine has none", () => {
    expect(networkWatch.localIPs(interfaces([]))).toEqual([]);
  });

  test("survives a reader that returns nothing", () => {
    expect(networkWatch.localIPs(() => null)).toEqual([]);
    expect(networkWatch.localIPs(() => ({ en0: null }))).toEqual([]);
  });
});

describe("watching", () => {
  const advance = (ms) => jest.advanceTimersByTime(ms);

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** A reader whose answer can be swapped mid-test. */
  const mutable = (initial) => {
    let list = initial;
    const read = () => interfaces(list)();
    read.set = (next) => (list = next);
    return read;
  };

  test("fires once when the address changes, with both sides", () => {
    const read = mutable(["192.168.1.20"]);
    const onChange = jest.fn();
    const seeded = networkWatch.start({
      onChange,
      intervalMs: 1000,
      readInterfaces: read,
    });

    expect(seeded).toEqual(["192.168.1.20"]);

    advance(1000);
    expect(onChange).not.toHaveBeenCalled();

    // The power-cut case: the router came back and handed out a different lease.
    read.set(["192.168.1.2"]);
    advance(1000);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      from: ["192.168.1.20"],
      to: ["192.168.1.2"],
    });

    // And it settles: the new address is now the baseline.
    advance(3000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(networkWatch.current()).toEqual(["192.168.1.2"]);
  });

  test("a reordering is not a change", () => {
    const read = mutable(["10.0.0.5", "192.168.1.20"]);
    const onChange = jest.fn();
    networkWatch.start({ onChange, intervalMs: 1000, readInterfaces: read });

    read.set(["192.168.1.20", "10.0.0.5"]);
    advance(2000);

    // Enumeration order isn't stable across platforms. Announcing this as an
    // address change would make the real one indistinguishable from noise.
    expect(onChange).not.toHaveBeenCalled();
  });

  test("gaining an address counts — a VPN coming up is a real change", () => {
    const read = mutable(["192.168.1.20"]);
    const onChange = jest.fn();
    networkWatch.start({ onChange, intervalMs: 1000, readInterfaces: read });

    read.set(["192.168.1.20", "10.8.0.2"]);
    advance(1000);

    expect(onChange).toHaveBeenCalledWith({
      from: ["192.168.1.20"],
      to: ["10.8.0.2", "192.168.1.20"],
    });
  });

  test("losing the network entirely is reported, not swallowed", () => {
    const read = mutable(["192.168.1.20"]);
    const onChange = jest.fn();
    networkWatch.start({ onChange, intervalMs: 1000, readInterfaces: read });

    read.set([]);
    advance(1000);

    expect(onChange).toHaveBeenCalledWith({ from: ["192.168.1.20"], to: [] });
  });

  test("a throwing handler doesn't stop the watch", () => {
    const read = mutable(["192.168.1.20"]);
    const onChange = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => {});
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});

    networkWatch.start({ onChange, intervalMs: 1000, readInterfaces: read });

    read.set(["192.168.1.2"]);
    advance(1000);
    read.set(["192.168.1.9"]);
    advance(1000);

    // Losing the watcher to a bad listener would mean the *next* change — the
    // one somebody cares about — goes unreported.
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  test("starting twice replaces the watch rather than stacking timers", () => {
    const read = mutable(["192.168.1.20"]);
    const first = jest.fn();
    const second = jest.fn();

    networkWatch.start({ onChange: first, intervalMs: 1000, readInterfaces: read });
    networkWatch.start({ onChange: second, intervalMs: 1000, readInterfaces: read });

    read.set(["192.168.1.2"]);
    advance(1000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("stop() ends it", () => {
    const read = mutable(["192.168.1.20"]);
    const onChange = jest.fn();
    networkWatch.start({ onChange, intervalMs: 1000, readInterfaces: read });

    networkWatch.stop();
    read.set(["192.168.1.2"]);
    advance(5000);

    expect(onChange).not.toHaveBeenCalled();
  });
});
