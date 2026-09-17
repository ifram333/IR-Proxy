"""BlockClient -- Python helper for the mock proxy's request-blocking API.

A blocked path's connection is **destroyed rather than answered**: the client
sees a reset, which is what a service that is genuinely down looks like from the
outside. That is the reason this is worth driving from a test -- turning a mock
on gives you any status you like, and the 503 switch gives you a 503, but
neither shows an app what happens when the network simply stops:

    from block_client import BlockClient, blocked

    client = BlockClient()
    client.block("api.example.com", "/orders")
    # ...the app's calls to /orders and everything under it now die...
    client.unblock("api.example.com", "/orders")

    # Or scoped to a block, restoring the host's prior rules afterwards:
    with blocked("api.example.com", "/orders"):
        ...drive the app...

**A rule is a path prefix.** "/orders" kills "/orders" and "/orders/42", and
pointedly not "/orders-archive". Ask the server rather than guessing --
is_blocked() and rule_for() are answered by the same code the proxy enforces,
so this file can never drift from it.

**Blocking needs SSL on for the host.** The rule runs inside the decrypted
pipeline, so a tunneled host stores it and never fires it; every method here
that touches a host reports `ssl`, and block() raises when it is off rather
than leaving you with a rule that silently does nothing.

Standalone on purpose: stdlib only, so this file can be copied into any QA
repo. The port autodetection below intentionally duplicates mock_client.py /
capture_client.py / scripts/cli.js -- keeping the client droppable beats
sharing code.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager

PREFERRED_PORT = 8888  # proxy's preferred port (often already taken)
PORT_SCAN = 20  # matches the proxy's own fallback scan range


class BlockError(Exception):
    """Raised when the blocking API returns an error response."""


class NotInterceptedError(BlockError):
    """Raised when a rule is set on a host the proxy does not decrypt.

    Its own type because it is the one failure worth catching separately: the
    call succeeded, the rule is stored, and nothing will ever act on it.
    """


def _probe(host, port):
    """Probe a port for OUR admin server (another proxy on 8888 won't match)."""
    try:
        with urllib.request.urlopen(
            f"http://{host}:{port}/__admin/health", timeout=0.5
        ) as res:
            data = json.loads(res.read().decode("utf-8"))
            return data.get("status") == "ok" and isinstance(data.get("instances"), list)
    except Exception:
        return False


class BlockClient:
    def __init__(self, host=None, port=None, require_ssl=True):
        """Explicit `port` skips autodetection (recommended in hermetic tests).
        Defaults honor the MOCK_HOST / MOCK_PORT environment variables.

        `require_ssl=False` downgrades the "SSL is off for this host" guard on
        block() from a raise to a returned flag -- for the rare suite that
        stages rules before turning interception on."""
        self.host = host or os.environ.get("MOCK_HOST", "localhost")
        env_port = os.environ.get("MOCK_PORT")
        self.port = port or (int(env_port) if env_port else None)
        self.require_ssl = require_ssl is not False

    def _resolve_port(self):
        if self.port:
            return self.port
        for p in range(PREFERRED_PORT, PREFERRED_PORT + PORT_SCAN + 1):
            if _probe(self.host, p):
                self.port = p
                return p
        raise BlockError(
            f"no mock proxy found on {self.host}:{PREFERRED_PORT}-"
            f"{PREFERRED_PORT + PORT_SCAN} (is the server running? "
            "set MOCK_PORT to override)"
        )

    def _request(self, method, path, body=None):
        port = self._resolve_port()
        url = f"http://{self.host}:{port}/__admin{path}"
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url, data=payload, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read().decode("utf-8")).get("error", "")
            except Exception:
                detail = ""
            raise BlockError(
                f"{method} {path} failed ({e.code}): {detail or e.reason}"
            ) from None

    def block(self, target_host, path):
        """Kill every call to `path` **and everything under it** on the host.

        Returns the host's resulting rules -- the authoritative list, no second
        round-trip. It may be shorter than you expect: a rule the new one now
        covers is dropped, because a list of rules that decide nothing is a
        list nobody trusts.

        Raises NotInterceptedError when SSL proxying is off for the host (see
        `require_ssl`)."""
        res = self._request(
            "POST", "/hosts/block",
            {"host": target_host, "path": path, "blocked": True},
        )
        if self.require_ssl and res.get("ssl") is not True:
            # Not a warning: the caller is about to assert that requests die,
            # and they won't. Raising here names the reason; failing later
            # names nothing.
            raise NotInterceptedError(
                f'SSL proxying is off for "{target_host}", so the rule is stored '
                "but never fires -- the host is tunneled, not decrypted. Turn SSL "
                "on for it first (dashboard tree -> right-click -> SSL), or "
                "construct with require_ssl=False if staging rules ahead of time "
                "is intended."
            )
        return res["blocks"]

    def unblock(self, target_host, path):
        """Lift exactly this rule. Exact, not "whatever covers this path": a
        path blocked by an ancestor stays blocked, and unblocking a child that
        silently lifted its whole parent tree is not something anyone asks for.
        Use rule_for() to find the rule actually in play.

        Unblocking a path that was never a rule is a no-op, not an error."""
        res = self._request(
            "POST", "/hosts/block",
            {"host": target_host, "path": path, "blocked": False},
        )
        return res["blocks"]

    def list_blocks(self, target_host=None):
        """A host's rules (list), or -- with no host -- every host that has any
        as {host: [paths]}."""
        if target_host is None:
            return self._request("GET", "/hosts/blocks")["blocks"]
        query = urllib.parse.urlencode({"host": target_host})
        return self._request("GET", f"/hosts/blocks?{query}")["blocks"]

    def rule_for(self, target_host, path):
        """Which rule kills this path, or None. Answered server-side, by the
        same blockCovering the proxy runs -- so "would this die?" and "did this
        die?" can never disagree."""
        query = urllib.parse.urlencode({"host": target_host, "path": path})
        return self._request("GET", f"/hosts/blocks?{query}")["rule"]

    def is_blocked(self, target_host, path):
        """Would a call to this path die?"""
        return self.rule_for(target_host, path) is not None

    def is_intercepted(self, target_host):
        """Whether the host is actually decrypted -- i.e. whether a rule on it
        can fire at all. Blocking is enforced inside the mock pipeline, and a
        tunneled host never reaches it."""
        query = urllib.parse.urlencode({"host": target_host})
        return self._request("GET", f"/hosts/blocks?{query}")["ssl"] is True

    def clear_blocks(self, target_host):
        """Lift every rule on a host (suite teardown)."""
        blocks = self.list_blocks(target_host)
        for rule in list(blocks):
            blocks = self.unblock(target_host, rule)
        return blocks

    @contextmanager
    def temporarily_blocked(self, target_host, path):
        """Block `path` for the duration of the block, then **restore the
        host's prior rules**. Restoration runs even if the block raises.

            with client.temporarily_blocked("api.example.com", "/orders"):
                ...drive the app...

        Restores the whole list rather than just lifting what it added, because
        adding a rule can *remove* others -- blocking "/orders" absorbs an
        existing "/orders/42", and an unblock alone would leave the host less
        blocked than it started. Removals go first: re-adding a narrow rule
        while the broad one is still in place is a no-op.
        """
        before = self.list_blocks(target_host)
        self.block(target_host, path)
        try:
            yield self
        finally:
            after = self.list_blocks(target_host)
            for rule in [r for r in after if r not in before]:
                self.unblock(target_host, rule)
            for rule in [r for r in before if r not in after]:
                self.block(target_host, rule)


@contextmanager
def blocked(target_host, path, host=None, port=None, require_ssl=True):
    """Module-level shortcut mirroring capture() / mock_set(): kill a path for
    the duration of the block, restoring the host's prior rules afterwards."""
    client = BlockClient(host=host, port=port, require_ssl=require_ssl)
    with client.temporarily_blocked(target_host, path):
        yield client
