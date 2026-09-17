"""MockClient -- Python helper for the mock proxy's mock-toggle API.

Lets automated tests turn individual mocks ON or OFF for a given backend
instance, read back the resulting state, and (optionally) restore the prior
state after a block -- so a suite can stage a scenario without touching the
dashboard:

    from mock_client import MockClient, mock_enabled

    client = MockClient()
    client.set_mock("api", "locked_user", True)        # turn it ON
    state = client.get_state("api", "locked_user")     # True | False | None

    # Or scoped to a block, auto-restoring the previous state afterwards:
    with mock_enabled("api", "locked_user"):
        ...drive the app...

Standalone on purpose: stdlib only, so this file can be copied into any QA
repo. The port autodetection below intentionally duplicates capture_client.py /
scripts/cli.js -- keeping the client droppable beats sharing code.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager

PREFERRED_PORT = 8888  # proxy's preferred port (often already taken)
PORT_SCAN = 20  # matches the proxy's own fallback scan range


class MockError(Exception):
    """Raised when the toggle API returns an error response."""


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


class MockClient:
    def __init__(self, host=None, port=None):
        """Explicit `port` skips autodetection (recommended in hermetic tests).
        Defaults honor the MOCK_HOST / MOCK_PORT environment variables."""
        self.host = host or os.environ.get("MOCK_HOST", "localhost")
        env_port = os.environ.get("MOCK_PORT")
        self.port = port or (int(env_port) if env_port else None)

    def _resolve_port(self):
        if self.port:
            return self.port
        for p in range(PREFERRED_PORT, PREFERRED_PORT + PORT_SCAN + 1):
            if _probe(self.host, p):
                self.port = p
                return p
        raise MockError(
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
            raise MockError(
                f"{method} {path} failed ({e.code}): {detail or e.reason}"
            ) from None

    def set_mock(self, instance_id, mock_name, enabled):
        """Turn a single mock ON or OFF for an instance. Returns the server's
        resulting state {"instanceId", "mockName", "enabled"} -- the
        authoritative value, no second round-trip needed. Raises MockError on
        404 (unknown instance/mock) or 409 (mock not scoped to instance)."""
        res = self._request(
            "POST", "/toggle",
            {"instanceId": instance_id, "mockName": mock_name, "enabled": enabled},
        )
        return {
            "instanceId": res["instanceId"],
            "mockName": res["mockName"],
            "enabled": res["enabled"],
        }

    def enable(self, instance_id, mock_name):
        """Convenience: turn a mock ON."""
        return self.set_mock(instance_id, mock_name, True)

    def disable(self, instance_id, mock_name):
        """Convenience: turn a mock OFF."""
        return self.set_mock(instance_id, mock_name, False)

    def get_state(self, instance_id, mock_name):
        """Current toggle state of a single mock, as a TRI-STATE:
        True (explicitly ON), False (explicitly OFF), or None (unset -- no
        explicit toggle, so the pipeline's default applies)."""
        states = self.get_instance_state(instance_id).get("states", {})
        return states.get(mock_name) if mock_name in states else None

    def set_mocks(self, instance_id, mock_names, enabled):
        """Bulk turn many mocks ON or OFF in one round-trip. Mocks not scoped to
        the instance are skipped server-side (not an error). Returns
        {"enabled", "count", "mocks"}."""
        res = self._request(
            "POST", "/toggle-bulk",
            {"instanceId": instance_id, "mockNames": list(mock_names), "enabled": enabled},
        )
        return {"enabled": res["enabled"], "count": res["count"], "mocks": res["mocks"]}

    def list_mocks(self):
        """All known mocks (name, file, folder, delay, servers) -- for discovery."""
        return self._request("GET", "/mocks")["mocks"]

    def get_instance_state(self, instance_id):
        """Full instance state: instanceId, isActive, targetUrl, latency,
        summary {on, off, unset}, states."""
        return self._request(
            "GET", f"/state/{urllib.parse.quote(instance_id)}"
        )

    @contextmanager
    def temporarily_set(self, instance_id, mock_name, enabled):
        """Set a mock for the duration of the block, then RESTORE its prior
        tri-state. Restoration runs even if the block raises.

            with client.temporarily_set("api", "locked_user", True):
                ...drive the app...
        """
        prior = self.get_state(instance_id, mock_name)
        self.set_mock(instance_id, mock_name, enabled)
        try:
            yield
        finally:
            # prior is None means "unset"; the toggle API has no "unset", so the
            # closest faithful restore is the pre-block boolean if one existed,
            # else OFF (the pipeline default for an absent entry).
            self.set_mock(instance_id, mock_name, False if prior is None else prior)


@contextmanager
def mock_set(instance_id, mock_name, enabled, host=None, port=None):
    """Module-level shortcut mirroring capture(): set a mock ON/OFF for the
    block, restoring the prior state afterwards."""
    client = MockClient(host=host, port=port)
    with client.temporarily_set(instance_id, mock_name, enabled):
        yield client


def mock_enabled(instance_id, mock_name, host=None, port=None):
    """Enable a mock for the duration of the block, then restore."""
    return mock_set(instance_id, mock_name, True, host=host, port=port)


def mock_disabled(instance_id, mock_name, host=None, port=None):
    """Disable a mock for the duration of the block, then restore."""
    return mock_set(instance_id, mock_name, False, host=host, port=port)
