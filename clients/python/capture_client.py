"""CaptureClient -- Python helper for the mock proxy's capture-session API.

Lets automated tests mark a START, exercise the app through the proxy, mark
an END, and assert on the exact requests the app sent in that window:

    from capture_client import capture

    with capture(name="login-test") as session:
        app.login("user", "pass")  # drive the app through the proxy

    login = next(r for r in session.requests if r["path"] == "/api/login")
    assert login["requestBody"] == {"user": "user", "pass": "pass"}

Standalone on purpose: stdlib only, so this file can be copied into any QA
repo. The port autodetection below intentionally duplicates the project's
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


class CaptureError(Exception):
    """Raised when the capture API returns an error response."""


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


class CaptureClient:
    def __init__(self, host=None, port=None):
        """Explicit `port` skips autodetection (recommended in hermetic tests).
        Defaults honor the MOCK_HOST / MOCK_PORT environment variables."""
        self.host = host or os.environ.get("MOCK_HOST", "localhost")
        env_port = os.environ.get("MOCK_PORT")
        self.port = port or (int(env_port) if env_port else None)
        self.session_id = None

    def _resolve_port(self):
        if self.port:
            return self.port
        for p in range(PREFERRED_PORT, PREFERRED_PORT + PORT_SCAN + 1):
            if _probe(self.host, p):
                self.port = p
                return p
        raise CaptureError(
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
            raise CaptureError(
                f"{method} {path} failed ({e.code}): {detail or e.reason}"
            ) from None

    def start(self, name=None, instance_id=None):
        """Start a capture session; returns and remembers the session id.
        `instance_id` restricts the capture to one configured backend."""
        body = {}
        if name:
            body["name"] = name
        if instance_id:
            body["instanceId"] = instance_id
        res = self._request("POST", "/capture/start", body)
        self.session_id = res["sessionId"]
        return self.session_id

    def stop(self, session_id=None):
        """Stop the session; returns the full payload including `requests`
        (chronological, oldest first). Idempotent."""
        sid = session_id or self._require_session()
        return self._request("POST", "/capture/stop", {"sessionId": sid})

    def get_requests(self, session_id=None, method=None, path=None,
                     path_prefix=None, instance_id=None, source=None):
        """Captured requests with optional filters: method (exact,
        case-insensitive), path (exact pathname), path_prefix, instance_id,
        source ("mock" | "proxy" | "intercept" | "server-off")."""
        sid = session_id or self._require_session()
        params = {
            "method": method, "path": path, "pathPrefix": path_prefix,
            "instanceId": instance_id, "source": source,
        }
        qs = urllib.parse.urlencode({k: v for k, v in params.items() if v})
        suffix = f"?{qs}" if qs else ""
        res = self._request(
            "GET", f"/capture/{urllib.parse.quote(sid)}/requests{suffix}"
        )
        return res["requests"]

    def get_session(self, session_id=None):
        """Session metadata (status, count, droppedCount) without entries."""
        sid = session_id or self._require_session()
        return self._request("GET", f"/capture/{urllib.parse.quote(sid)}")["session"]

    def delete(self, session_id=None):
        """Delete a session server-side (e.g., in test teardown)."""
        sid = session_id or self._require_session()
        self._request("DELETE", f"/capture/{urllib.parse.quote(sid)}")
        if sid == self.session_id:
            self.session_id = None

    def _require_session(self):
        if not self.session_id:
            raise CaptureError("no active session (call start first)")
        return self.session_id


class _CaptureSession:
    """Result holder for the `capture` context manager."""

    def __init__(self, client):
        self.client = client
        self.session_id = None
        self.requests = None
        self.dropped_count = 0

    def get_requests(self, **filters):
        return self.client.get_requests(self.session_id, **filters)


@contextmanager
def capture(name=None, instance_id=None, host=None, port=None):
    """Capture everything the app sends through the proxy inside the block.

    with capture("checkout") as session:
        ...drive the app...
    assert session.requests[0]["requestBody"] == {...}
    """
    client = CaptureClient(host=host, port=port)
    session = _CaptureSession(client)
    session.session_id = client.start(name=name, instance_id=instance_id)
    try:
        yield session
    finally:
        result = client.stop(session.session_id)
        session.requests = result["requests"]
        session.dropped_count = result.get("droppedCount", 0)
