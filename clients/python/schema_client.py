"""SchemaClient -- Python helper for running the proxy's saved requests and
checking what came back.

The other three clients in this folder stage a condition; this one **asserts an
outcome**. A saved request can carry an expectation -- an expected status, a
JSON Schema for the body, or both -- and this runs it through the proxy and
tells you whether the response met it:

    from schema_client import SchemaClient, ExpectationFailed

    client = SchemaClient()

    # Raises, listing every problem, if the response didn't match:
    client.assert_passes("get-order")

    # A whole collection, in order, one at a time:
    client.assert_collection_passes("checkout-flow")

    # Or with a schema kept in *your* repo, next to this test:
    client.assert_passes("get-order", expect={
        "status": 200,
        "schema": json.load(open("schemas/order.json")),
    })

**The schema is never evaluated here.** Every check is answered by the same
utils/schema-validate.js the dashboard uses, so this file cannot drift from what
the proxy actually enforces -- the same reason BlockClient asks the server
whether a path is blocked instead of re-deriving the prefix rule.

**A request with no expectation does not pass.** assert_passes() raises on one,
because an assertion that checked nothing and returned green is the failure this
whole feature exists to prevent. Pass your own `expect`, or construct with
require_check=False if you genuinely mean "just send it".

Standalone on purpose: stdlib only, so this file can be copied into any QA repo.
The port autodetection below intentionally duplicates mock_client.py /
capture_client.py / block_client.py / scripts/cli.js -- keeping the client
droppable beats sharing code.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

PREFERRED_PORT = 8888  # proxy's preferred port (often already taken)
PORT_SCAN = 20  # matches the proxy's own fallback scan range

# Distinguishes "no expect argument" from "expect=None", which means the
# opposite thing: send this request and check nothing at all.
_UNSET = object()


class SchemaError(Exception):
    """Raised when the run API returns an error response."""


class ExpectationFailed(SchemaError):
    """Raised when a response did not match what was expected.

    Its own type because it is the one failure worth catching separately: the
    request went out and came back fine, the *answer* was wrong. `.errors` is
    the list, so a test runner can print one per line.
    """

    def __init__(self, label, errors):
        super().__init__("{} failed its check:\n  {}".format(label, "\n  ".join(errors)))
        self.errors = list(errors)


class NothingCheckedError(SchemaError):
    """Raised when an assertion was made about a request that checks nothing.

    Separate from a failure because it is the opposite problem: nothing went
    wrong, and that is exactly why you cannot trust the green.
    """


def _probe(host, port):
    """Probe a port for OUR admin server (another proxy on 8888 won't match)."""
    url = "http://{}:{}/__admin/health".format(host, port)
    try:
        with urllib.request.urlopen(url, timeout=0.5) as res:
            body = json.loads(res.read().decode("utf-8"))
            return body.get("status") == "ok" and isinstance(body.get("instances"), list)
    except Exception:
        return False


class SchemaClient:
    """Run saved requests through the proxy and assert on the responses.

    An explicit `port` skips autodetection (recommended in hermetic tests).
    Defaults honor the MOCK_HOST / MOCK_PORT environment variables.
    `require_check=False` lets assert_passes() accept a request that checks
    nothing, instead of raising to say the assertion was hollow.
    """

    def __init__(self, host=None, port=None, require_check=True):
        self.host = host or os.environ.get("MOCK_HOST", "localhost")
        env_port = os.environ.get("MOCK_PORT")
        self.port = port or (int(env_port) if env_port else None)
        self.require_check = require_check

    def _resolve_port(self):
        if self.port:
            return self.port
        for candidate in range(PREFERRED_PORT, PREFERRED_PORT + PORT_SCAN + 1):
            if _probe(self.host, candidate):
                self.port = candidate
                return candidate
        raise SchemaError(
            "SchemaClient: no mock proxy found on {}:{}-{} "
            "(is the server running? set MOCK_PORT to override)".format(
                self.host, PREFERRED_PORT, PREFERRED_PORT + PORT_SCAN
            )
        )

    def _request(self, method, path, body=_UNSET):
        port = self._resolve_port()
        url = "http://{}:{}/__admin{}".format(self.host, port, path)
        data = None if body is _UNSET else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method=method, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=35) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                message = json.loads(raw).get("error", raw)
            except ValueError:
                message = raw
            raise SchemaError(
                "SchemaClient: {} {} failed ({}): {}".format(
                    method, path, exc.code, message
                )
            ) from exc
        except urllib.error.URLError as exc:
            raise SchemaError(
                "SchemaClient: could not reach {}: {}".format(url, exc.reason)
            ) from exc

    def saved_requests(self):
        """Every saved request, newest first -- id, name, path, and its expect."""
        return self._request("GET", "/saved-requests").get("requests", [])

    def collections(self):
        """Every collection, ids already resolved into whole records."""
        return self._request("GET", "/collections").get("collections", [])

    def checks(self):
        """Which saved requests actually check their response.

        Worth asking out loud before trusting a green run: a suite of requests
        that assert nothing passes every time.
        """
        return [
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "method": r.get("method") or "GET",
                "path": r.get("path"),
                "checked": bool(r.get("expect")),
                "expect": r.get("expect"),
            }
            for r in self.saved_requests()
        ]

    def run(self, request_id, expect=_UNSET):
        """Send one saved request through the proxy and report what came back.

        Does **not** raise on a failed expectation -- that is assert_passes().
        This is for when you want the verdict as data.

        `expect` **replaces** the stored expectation for this call, which is how
        you keep schemas in your own repo next to the tests that use them.
        `expect=None` sends without checking anything.

        Returns {"status", "checked", "passed", "errors"}.
        """
        body = {} if expect is _UNSET else {"expect": expect}
        res = self._request(
            "POST",
            "/saved-requests/{}/send".format(urllib.parse.quote(str(request_id), safe="")),
            body,
        )
        verdict = res.get("expect")
        return {
            "status": res.get("status"),
            "checked": bool(verdict),
            # "passed" is only meaningful when something was checked; "checked"
            # is what tells the two apart, and callers must not conflate them.
            "passed": bool(verdict and verdict.get("passed")),
            "errors": list(verdict.get("errors", [])) if verdict else [],
        }

    def assert_passes(self, request_id, expect=_UNSET):
        """Send one saved request and raise unless the response met its check.

        Raises ExpectationFailed (with .errors) when the check failed, and
        NothingCheckedError when the request had no check at all.
        """
        result = self.run(request_id, expect)
        if not result["checked"]:
            if not self.require_check:
                return result
            raise NothingCheckedError(
                'SchemaClient: saved request "{}" has no expectation, so this '
                "assertion checked nothing and would pass whatever came back. Add "
                "one from the dashboard's Expect tab, pass your own expect=..., or "
                "construct with require_check=False if sending without checking is "
                "intended.".format(request_id)
            )
        if not result["passed"]:
            raise ExpectationFailed('"{}"'.format(request_id), result["errors"])
        return result

    def run_collection(self, name_or_id):
        """Run a whole collection, **in order, one at a time**.

        Sequential because that is the shape these have -- "log in, then call
        the thing that needs the token". It does not stop at the first failure:
        a run is how you find out *where* a flow breaks, and the results after
        the red one are part of that answer.
        """
        groups = self.collections()
        group = next(
            (g for g in groups if g.get("id") == name_or_id or g.get("name") == name_or_id),
            None,
        )
        if group is None:
            known = ", ".join(g.get("id", "?") for g in groups) or "none"
            raise SchemaError(
                'SchemaClient: no collection "{}". Known: {}'.format(name_or_id, known)
            )

        results = []
        for record in group.get("requests", []):
            try:
                outcome = self.run(record["id"])
            except SchemaError as exc:
                # A request that could not be sent at all -- SSL off for its
                # target, its instance gone, a stored schema that cannot be
                # honoured. It belongs in the results as a failure, not as a
                # raise that hides the rows after it.
                outcome = {"status": 0, "checked": True, "passed": False, "errors": [str(exc)]}
            outcome["id"] = record["id"]
            outcome["name"] = record.get("name")
            results.append(outcome)
        return results

    def assert_collection_passes(self, name_or_id):
        """Run a collection and raise unless **every** request met its check.

        The message names each failure with its request, because "something in
        checkout-flow broke" is not an answer anybody can act on. Unchecked
        requests are reported the same way assert_passes() treats one: they are
        not passes. Turn that off with require_check=False.
        """
        results = self.run_collection(name_or_id)

        problems = []
        for r in results:
            if not r["checked"]:
                if self.require_check:
                    problems.append("{}: nothing was checked".format(r["name"]))
                continue
            if not r["passed"]:
                problems.extend("{}: {}".format(r["name"], line) for line in r["errors"])

        if problems:
            raise ExpectationFailed('Collection "{}"'.format(name_or_id), problems)
        return results


def check(request_id, expect=_UNSET, host=None, port=None, require_check=True):
    """Module-level shortcut mirroring capture() / mock_set() / blocked():
    send one saved request and raise unless the response met its check."""
    client = SchemaClient(host=host, port=port, require_check=require_check)
    return client.assert_passes(request_id, expect)
