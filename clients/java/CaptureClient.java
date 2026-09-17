import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CaptureClient — Java helper for the mock proxy's capture-session API.
 *
 * Lets automated tests mark a START, exercise the app through the proxy,
 * mark an END, and assert on the exact requests the app sent in that window:
 *
 * <pre>
 *   CaptureClient client = new CaptureClient();
 *   String sessionId = client.start("login-test", null);
 *   // ... drive the app through the proxy ...
 *   String json = client.stopRaw(sessionId);
 *   // Parse with YOUR test suite's JSON library, e.g. Jackson:
 *   //   JsonNode requests = new ObjectMapper().readTree(json).get("requests");
 * </pre>
 *
 * Standalone on purpose: single file, no package, Java 11+ HttpClient, zero
 * dependencies — copy it into any QA repo. It deliberately returns raw JSON
 * strings from stopRaw/getRequestsRaw so the test's own JSON library (Jackson,
 * Gson, org.json…) does the parsing; hand-rolling a JSON parser here is not
 * worth it. The port autodetection intentionally duplicates the project's
 * scripts/cli.js — keeping the client droppable beats sharing code.
 */
public final class CaptureClient {

  private static final int PREFERRED_PORT = 8888; // often already taken
  private static final int PORT_SCAN = 20; // matches the proxy's fallback range
  private static final Pattern SESSION_ID =
      // Safe targeted extraction: server-generated ids only contain [0-9a-z-].
      Pattern.compile("\"sessionId\"\\s*:\\s*\"([^\"]+)\"");

  private final HttpClient http =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
  private final String host;
  private int port; // 0 = not yet resolved

  /** Autodetect host/port (honors MOCK_HOST / MOCK_PORT environment variables). */
  public CaptureClient() {
    String envHost = System.getenv("MOCK_HOST");
    String envPort = System.getenv("MOCK_PORT");
    this.host = envHost != null ? envHost : "localhost";
    this.port = envPort != null ? Integer.parseInt(envPort) : 0;
  }

  /** Explicit host/port skips autodetection (recommended in hermetic tests). */
  public CaptureClient(String host, int port) {
    this.host = host;
    this.port = port;
  }

  /** Starts a capture session; returns the session id. Args may be null. */
  public String start(String name, String instanceId) throws IOException, InterruptedException {
    StringBuilder body = new StringBuilder("{");
    if (name != null) body.append("\"name\":\"").append(jsonEscape(name)).append("\"");
    if (instanceId != null) {
      if (body.length() > 1) body.append(",");
      body.append("\"instanceId\":\"").append(jsonEscape(instanceId)).append("\"");
    }
    body.append("}");
    String json = request("POST", "/capture/start", body.toString());
    Matcher m = SESSION_ID.matcher(json);
    if (!m.find()) throw new IOException("CaptureClient: no sessionId in response: " + json);
    return m.group(1);
  }

  /**
   * Stops the session (idempotent) and returns the raw response JSON:
   * { ok, sessionId, status, count, droppedCount, requests: [...] } with the
   * requests in chronological order (oldest first).
   */
  public String stopRaw(String sessionId) throws IOException, InterruptedException {
    return request("POST", "/capture/stop",
        "{\"sessionId\":\"" + jsonEscape(sessionId) + "\"}");
  }

  /**
   * Raw JSON of the session's captured requests. Supported filter keys:
   * method (exact, case-insensitive), path (exact pathname), pathPrefix,
   * instanceId, source ("mock" | "proxy" | "intercept" | "server-off").
   * Pass null or an empty map for no filtering.
   */
  public String getRequestsRaw(String sessionId, Map<String, String> filters)
      throws IOException, InterruptedException {
    StringBuilder qs = new StringBuilder();
    if (filters != null) {
      for (Map.Entry<String, String> e : filters.entrySet()) {
        if (e.getValue() == null) continue;
        qs.append(qs.length() == 0 ? "?" : "&")
            .append(urlEncode(e.getKey()))
            .append("=")
            .append(urlEncode(e.getValue()));
      }
    }
    return request("GET", "/capture/" + urlEncode(sessionId) + "/requests" + qs, null);
  }

  /** Raw JSON of the session metadata (status, count, droppedCount). */
  public String getSessionRaw(String sessionId) throws IOException, InterruptedException {
    return request("GET", "/capture/" + urlEncode(sessionId), null);
  }

  /** Deletes a session server-side (e.g., in test teardown). */
  public void delete(String sessionId) throws IOException, InterruptedException {
    request("DELETE", "/capture/" + urlEncode(sessionId), null);
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
      throw new IOException("CaptureClient: " + method + " " + path + " failed ("
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
    throw new IOException("CaptureClient: no mock proxy found on " + host + ":"
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
