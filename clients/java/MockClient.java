import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * MockClient — Java helper for the mock proxy's mock-toggle API.
 *
 * Lets automated tests turn individual mocks ON or OFF for a given backend
 * instance, read back the resulting state, and (optionally) restore the prior
 * state after a block — so a suite can stage a scenario without touching the
 * dashboard:
 *
 * <pre>
 *   MockClient client = new MockClient();
 *   boolean now = client.setMock("api", "locked_user", true);  // turn it ON
 *   Boolean state = client.getState("api", "locked_user");     // TRUE | FALSE | null
 *
 *   // Or scoped to a block, auto-restoring the previous state afterwards:
 *   try (AutoCloseable r = client.temporarilySet("api", "locked_user", true)) {
 *     // ...drive the app...
 *   }
 * </pre>
 *
 * Standalone on purpose: single file, no package, Java 11+ HttpClient, zero
 * dependencies — copy it into any QA repo. Like CaptureClient it returns raw
 * JSON strings from the list/state readers so the test's own JSON library
 * (Jackson, Gson, org.json…) does the parsing; the few single scalars it needs
 * (the echoed `enabled`, one mock's state) are extracted with a targeted regex.
 * The port autodetection intentionally duplicates the project's
 * CaptureClient.java / scripts/cli.js — keeping the client droppable beats
 * sharing code.
 */
public final class MockClient {

  private static final int PREFERRED_PORT = 8888; // often already taken
  private static final int PORT_SCAN = 20; // matches the proxy's fallback range
  private static final Pattern ENABLED =
      Pattern.compile("\"enabled\"\\s*:\\s*(true|false)");

  private final HttpClient http =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
  private final String host;
  private int port; // 0 = not yet resolved

  /** Autodetect host/port (honors MOCK_HOST / MOCK_PORT environment variables). */
  public MockClient() {
    String envHost = System.getenv("MOCK_HOST");
    String envPort = System.getenv("MOCK_PORT");
    this.host = envHost != null ? envHost : "localhost";
    this.port = envPort != null ? Integer.parseInt(envPort) : 0;
  }

  /** Explicit host/port skips autodetection (recommended in hermetic tests). */
  public MockClient(String host, int port) {
    this.host = host;
    this.port = port;
  }

  /**
   * Turns a single mock ON or OFF for an instance; returns the server's
   * resulting state (the authoritative value, no second round-trip needed).
   * Throws IOException on 404 (unknown instance/mock) or 409 (mock not scoped
   * to the instance) — the server's error message is included.
   */
  public boolean setMock(String instanceId, String mockName, boolean enabled)
      throws IOException, InterruptedException {
    String body = "{\"instanceId\":\"" + jsonEscape(instanceId)
        + "\",\"mockName\":\"" + jsonEscape(mockName)
        + "\",\"enabled\":" + enabled + "}";
    String json = request("POST", "/toggle", body);
    Matcher m = ENABLED.matcher(json);
    if (!m.find()) throw new IOException("MockClient: no `enabled` in response: " + json);
    return Boolean.parseBoolean(m.group(1));
  }

  /** Convenience: turn a mock ON. */
  public boolean enable(String instanceId, String mockName)
      throws IOException, InterruptedException {
    return setMock(instanceId, mockName, true);
  }

  /** Convenience: turn a mock OFF. */
  public boolean disable(String instanceId, String mockName)
      throws IOException, InterruptedException {
    return setMock(instanceId, mockName, false);
  }

  /**
   * Current toggle state of a single mock, as a TRI-STATE:
   * Boolean.TRUE (explicitly ON), Boolean.FALSE (explicitly OFF), or null
   * (unset — no explicit toggle, so the pipeline's default applies).
   *
   * <p>Lightweight extraction: looks for {@code "<mockName>": true|false} in the
   * instance state. Mock names containing JSON-special characters (quotes,
   * backslashes) aren't supported here — fall back to {@link #getInstanceStateRaw}
   * and your JSON library for those.
   */
  public Boolean getState(String instanceId, String mockName)
      throws IOException, InterruptedException {
    String json = getInstanceStateRaw(instanceId);
    Matcher m = Pattern.compile("\"" + Pattern.quote(mockName) + "\"\\s*:\\s*(true|false)")
        .matcher(json);
    return m.find() ? Boolean.parseBoolean(m.group(1)) : null;
  }

  /**
   * Bulk turn many mocks ON or OFF in one round-trip; returns the raw response
   * JSON { ok, instanceId, enabled, count, mocks: [...] }. Mocks not scoped to
   * the instance are skipped server-side (not an error).
   */
  public String setMocksRaw(String instanceId, List<String> mockNames, boolean enabled)
      throws IOException, InterruptedException {
    StringBuilder arr = new StringBuilder("[");
    for (int i = 0; i < mockNames.size(); i++) {
      if (i > 0) arr.append(",");
      arr.append("\"").append(jsonEscape(mockNames.get(i))).append("\"");
    }
    arr.append("]");
    String body = "{\"instanceId\":\"" + jsonEscape(instanceId)
        + "\",\"mockNames\":" + arr + ",\"enabled\":" + enabled + "}";
    return request("POST", "/toggle-bulk", body);
  }

  /** Raw JSON of all known mocks: { mocks: [{ name, file, folder, delay, servers }] }. */
  public String listMocksRaw() throws IOException, InterruptedException {
    return request("GET", "/mocks", null);
  }

  /**
   * Raw JSON of an instance's full state: { instanceId, isActive, targetUrl,
   * latency, summary: { on, off, unset }, states }.
   */
  public String getInstanceStateRaw(String instanceId)
      throws IOException, InterruptedException {
    return request("GET", "/state/" + urlEncode(instanceId), null);
  }

  /**
   * Sets a mock for the duration of a try-with-resources block, then RESTORES
   * its prior tri-state on close (runs even if the block throws):
   *
   * <pre>
   *   try (AutoCloseable r = client.temporarilySet("api", "locked_user", true)) {
   *     // ...drive the app...
   *   }
   * </pre>
   */
  public AutoCloseable temporarilySet(String instanceId, String mockName, boolean enabled)
      throws IOException, InterruptedException {
    Boolean prior = getState(instanceId, mockName);
    setMock(instanceId, mockName, enabled);
    // prior == null means "unset"; the toggle API has no "unset", so the closest
    // faithful restore is the pre-block boolean if one existed, else OFF (the
    // pipeline default for an absent entry).
    boolean restore = prior != null && prior;
    return () -> setMock(instanceId, mockName, restore);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private String request(String method, String path, String body)
      throws IOException, InterruptedException {
    int p = resolvePort();
    HttpRequest.Builder builder =
        HttpRequest.newBuilder()
            .uri(URI.create("http://" + host + ":" + p + "/__admin" + path))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/json")
            .method(method, body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
    HttpResponse<String> res = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    if (res.statusCode() < 200 || res.statusCode() >= 300) {
      throw new IOException("MockClient: " + method + " " + path + " failed ("
          + res.statusCode() + "): " + res.body());
    }
    return res.body();
  }

  private int resolvePort() throws IOException {
    if (port != 0) return port;
    for (int p = PREFERRED_PORT; p <= PREFERRED_PORT + PORT_SCAN; p++) {
      if (probe(p)) {
        port = p;
        return p;
      }
    }
    throw new IOException("MockClient: no mock proxy found on " + host + ":"
        + PREFERRED_PORT + "-" + (PREFERRED_PORT + PORT_SCAN)
        + " (is the server running? set MOCK_PORT to override)");
  }

  /** Probes a port for OUR admin server (another proxy on 8888 won't match). */
  private boolean probe(int p) {
    try {
      HttpRequest req = HttpRequest.newBuilder()
          .uri(URI.create("http://" + host + ":" + p + "/__admin/health"))
          .timeout(Duration.ofMillis(500))
          .GET()
          .build();
      HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
      return res.statusCode() == 200
          && res.body().contains("\"status\":\"ok\"")
          && res.body().contains("\"instances\":[");
    } catch (Exception e) {
      return false;
    }
  }

  private static String jsonEscape(String s) {
    StringBuilder out = new StringBuilder();
    for (char c : s.toCharArray()) {
      switch (c) {
        case '"': out.append("\\\""); break;
        case '\\': out.append("\\\\"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        default:
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
      }
    }
    return out.toString();
  }

  private static String urlEncode(String s) {
    return URLEncoder.encode(s, StandardCharsets.UTF_8);
  }
}
