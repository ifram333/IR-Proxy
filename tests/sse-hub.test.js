/**
 * sse-hub.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The hub multiplexes several producers onto one EventSource. The frame naming
 * is load-bearing: request-log entries must stay *unnamed* so an existing
 * dashboard tab (which only listens on `onmessage`) keeps receiving them, while
 * named channels stay invisible to it.
 */

const sseHub = require("../utils/sse-hub");

const makeClient = (props = {}) => ({
  writes: [],
  destroys: 0,
  write(s) {
    this.writes.push(s);
  },
  destroy() {
    this.destroys++;
  },
  on: () => {},
  ...props,
});

describe("sse-hub", () => {
  describe("frame", () => {
    test("omitting the event name produces a default-channel frame", () => {
      expect(sseHub.frame(null, { a: 1 })).toBe('data: {"a":1}\n\n');
    });

    test("naming the event prefixes an event line", () => {
      expect(sseHub.frame("hosts", [{ host: "a" }])).toBe(
        'event: hosts\ndata: [{"host":"a"}]\n\n'
      );
    });
  });

  describe("broadcast", () => {
    test("delivers one frame per client", () => {
      const a = makeClient();
      const b = makeClient();
      sseHub.addClient(a);
      sseHub.addClient(b);

      sseHub.broadcast(null, { path: "/x" });

      expect(a.writes).toHaveLength(1);
      expect(b.writes).toHaveLength(1);
      expect(a.writes[0]).toBe('data: {"path":"/x"}\n\n');
    });

    test("named and unnamed channels share the one connection", () => {
      const client = makeClient();
      sseHub.addClient(client);

      sseHub.broadcast(null, { path: "/x" });
      sseHub.broadcast("hosts", [{ host: "a.example.com" }]);

      expect(client.writes).toHaveLength(2);
      expect(client.writes[0].startsWith("data: ")).toBe(true);
      expect(client.writes[1].startsWith("event: hosts\n")).toBe(true);
    });

    test("is a no-op with no clients connected", () => {
      expect(() => sseHub.broadcast("hosts", [])).not.toThrow();
    });
  });

  describe("client eviction", () => {
    test("dead and backed-up clients are torn down instead of buffering", () => {
      const healthy = makeClient();
      const dead = makeClient({ destroyed: true });
      const backedUp = makeClient({ writableLength: 10 * 1024 * 1024 });
      const ended = makeClient({ writableEnded: true });

      [healthy, dead, backedUp, ended].forEach((c) => sseHub.addClient(c));

      sseHub.broadcast(null, { n: 1 });
      sseHub.broadcast(null, { n: 2 });

      expect(healthy.writes).toHaveLength(2);
      // Never written to, torn down once, and gone from the set — the second
      // broadcast doesn't reach them either.
      expect(dead.writes).toHaveLength(0);
      expect(backedUp.writes).toHaveLength(0);
      expect(ended.writes).toHaveLength(0);
      expect(dead.destroys).toBe(1);
      expect(backedUp.destroys).toBe(1);
    });

    test("a client whose write throws is dropped", () => {
      const throwing = makeClient({
        write() {
          throw new Error("EPIPE");
        },
      });
      const healthy = makeClient();
      sseHub.addClient(throwing);
      sseHub.addClient(healthy);

      const before = sseHub.clientCount();
      expect(() => sseHub.broadcast(null, { n: 1 })).not.toThrow();
      expect(sseHub.clientCount()).toBe(before - 1);
      expect(healthy.writes).toHaveLength(1);
    });

    test("closing a connection removes it from the set", () => {
      let onClose;
      const client = makeClient({
        on: (event, fn) => {
          if (event === "close") onClose = fn;
        },
      });
      sseHub.addClient(client);
      const before = sseHub.clientCount();

      onClose();

      expect(sseHub.clientCount()).toBe(before - 1);
    });
  });
});
