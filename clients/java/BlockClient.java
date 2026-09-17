import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * BlockClient — Java helper for the mock proxy's request-blocking API.
 *
 * <p>A blocked path's connection is <b>destroyed rather than answered</b>: the
 * client sees a reset, which is what a service that is genuinely down looks
 * like from the outside. That is the reason this is worth driving from a test —
 * turning a mock on gives you any status you like, and the 503 switch gives you
 * a 503, but neither shows an app what happens when the network simply stops:
 *
 * <pre>
 *   BlockClient client = new BlockClient();
 *   client.block("api.example.com", "/orders");
 *   // ...the app's calls to /orders and everything under it now die...
 *   client.unblock("api.example.com", "/orders");
 *
 *   // Or scoped to a block, restoring the host's prior rules afterwards:
 *   try (AutoCloseable r = client.temporarilyBlocked("api.example.com", "/orders")) {
 *     // ...drive the app...
 *   }
 * </pre>
 *
 * <p><b>A rule is a path prefix.</b> {@code /orders} kills {@code /orders} and
 * {@code /orders/42}, and pointedly not {@code /orders-archive}. Ask the server
 * rather than guessing — {@link #isBlocked} and {@link #ruleFor} are answered by
 * the same code the proxy enforces, so this file can never drift from it.
 *
 * <p><b>Blocking needs SSL on for the host.</b> The rule runs inside the
 * decrypted pipeline, so a tunneled host stores it and never fires it;
 * {@link #block} throws when SSL is off rather than leaving you with a rule that
 * silently does nothing.
 *
 * <p>Standalone on purpose: single file, no package, Java 11+ HttpClient, zero
 * dependencies — copy it into any QA repo. Like MockClient it offers raw JSON
 * getters so the test's own JSON library does the parsing, and extracts the few
 * scalars it needs with targeted regexes. The port autodetection intentionally
 * duplicates the project's MockClient.java / scripts/cli.js — keeping the client
 * droppable beats sharing code.
 */
public final class BlockClient {

  private static final int PREFERRED_PORT = 8888; // often already taken
  private static final int PORT_SCAN = 20; // matches the proxy's fallback range
  private static final Pattern BLOCKS_ARRAY =
      Pattern.compile("\"blocks\"\\s*:\\s*\\[(.*?)\\]", Pattern.DOTALL);
  private static final Pattern JSON_STRING =
      Pattern.compile("\"((?:[^\"\\\\]|\\\\.)*)\"");
  private static final Pattern RULE =
      Pattern.compile("\"rule\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|null)");
  private static final Pattern SSL = Pattern.compile("\"ssl\"\\s*:\\s*(true|false)");

  private final HttpClient http =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
  private final String host;
  private final boolean requireSsl;
  private int port; // 0 = not yet resolved

  /** Autodetect host/port (honors MOCK_HOST / MOCK_PORT environment variables). */
  public BlockClient() {
    String envHost = System.getenv("MOCK_HOST");
    String envPort = System.getenv("MOCK_PORT");
    this.host = envHost != null ? envHost : "localhost";
    this.port = envPort != null ? Integer.parseInt(envPort) : 0;
    this.requireSsl = true;
  }

  /** Explicit host/port skips autodetection (recommended in hermetic tests). */
  public BlockClient(String host, int port) {
    this(host, port, true);
  }

  /**
   * {@code requireSsl = false} downgrades the "SSL is off for this host" guard
   * on {@link #block} from a throw to a silent no-op — for the rare suite that
   * stages rules before turning interception on.
   */
  public BlockClient(String host, int port, boolean requireSsl) {
    this.host = host;
    this.port = port;
    this.requireSsl = requireSsl;
  }

  /**
   * Kills every call to {@code path} <b>and everything under it</b> on the host.
   *
   * <p>Returns the host's resulting rules — the authoritative list, no second
   * round-trip. It may be shorter than you expect: a rule the new one now covers
   * is dropped, because a list of rules that decide nothing is a list nobody
   * trusts.
   *
   * @throws IOException when SSL proxying is off for the host (see requireSsl)
   */
  public List<String> block(String targetHost, String path)
      throws IOException, InterruptedException {
    String json = request("POST", "/hosts/block", body(targetHost, path, true));
    if (requireSsl && !flag(SSL, json)) {
      // Not a warning: the caller is about to assert that requests die, and they
      // won't. Failing here names the reason; failing later names nothing.
      throw new IOException("BlockClient: SSL proxying is off for \"" + targetHost
          + "\", so the rule is stored but never fires — the host is tunneled, not"
          + " decrypted. Turn SSL on for it first (dashboard tree → right-click →"
          + " SSL), or construct with requireSsl = false if staging rules ahead of"
          + " time is intended.");
    }
    return blocksOf(json);
  }

  /**
   * Lifts exactly this rule. Exact, not "whatever covers this path": a path
   * blocked by an ancestor stays blocked, and unblocking a child that silently
   * lifted its whole parent tree is not something anyone asks for. Use
   * {@link #ruleFor} to find the rule actually in play.
   *
   * <p>Unblocking a path that was never a rule is a no-op, not an error.
   */
  public List<String> unblock(String targetHost, String path)
      throws IOException, InterruptedException {
    return blocksOf(request("POST", "/hosts/block", body(targetHost, path, false)));
  }

  /** A host's rules. */
  public List<String> listBlocks(String targetHost)
      throws IOException, InterruptedException {
    return blocksOf(request("GET", "/hosts/blocks?host=" + urlEncode(targetHost), null));
  }

  /** Raw JSON of every host that has rules: {@code { ok, blocks: { host: [...] } }}. */
  public String listAllBlocksRaw() throws IOException, InterruptedException {
    return request("GET", "/hosts/blocks", null);
  }

  /**
   * Which rule kills this path, or null. Answered server-side, by the same
   * {@code blockCovering} the proxy runs — so "would this die?" and "did this
   * die?" can never disagree.
   */
  public String ruleFor(String targetHost, String path)
      throws IOException, InterruptedException {
    String json = request(
        "GET", "/hosts/blocks?host=" + urlEncode(targetHost) + "&path=" + urlEncode(path),
        null);
    Matcher m = RULE.matcher(json);
    if (!m.find()) throw new IOException("BlockClient: no `rule` in response: " + json);
    return m.group(1) == null ? null : jsonUnescape(m.group(1));
  }

  /** Would a call to this path die? */
  public boolean isBlocked(String targetHost, String path)
      throws IOException, InterruptedException {
    return ruleFor(targetHost, path) != null;
  }

  /**
   * Whether the host is actually decrypted — i.e. whether a rule on it can fire
   * at all. Blocking is enforced inside the mock pipeline, and a tunneled host
   * never reaches it.
   */
  public boolean isIntercepted(String targetHost)
      throws IOException, InterruptedException {
    return flag(SSL, request("GET", "/hosts/blocks?host=" + urlEncode(targetHost), null));
  }

  /** Lifts every rule on a host (suite teardown). */
  public List<String> clearBlocks(String targetHost)
      throws IOException, InterruptedException {
    List<String> blocks = listBlocks(targetHost);
    for (String rule : new ArrayList<>(blocks)) blocks = unblock(targetHost, rule);
    return blocks;
  }

  /**
   * Blocks {@code path} for the duration of a try-with-resources block, then
   * <b>restores the host's prior rules</b> on close (runs even if the block
   * throws):
   *
   * <pre>
   *   try (AutoCloseable r = client.temporarilyBlocked("api.example.com", "/orders")) {
   *     // ...drive the app...
   *   }
   * </pre>
   *
   * <p>Restores the whole list rather than just lifting what it added, because
   * adding a rule can <i>remove</i> others — blocking {@code /orders} absorbs an
   * existing {@code /orders/42}, and an unblock alone would leave the host less
   * blocked than it started. Removals go first: re-adding a narrow rule while the
   * broad one is still in place is a no-op.
   */
  public AutoCloseable temporarilyBlocked(String targetHost, String path)
      throws IOException, InterruptedException {
    List<String> before = listBlocks(targetHost);
    block(targetHost, path);
    return () -> {
      List<String> after = listBlocks(targetHost);
      for (String rule : after) if (!before.contains(rule)) unblock(targetHost, rule);
      for (String rule : before) if (!after.contains(rule)) block(targetHost, rule);
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private static String body(String targetHost, String path, boolean blocked) {
    return "{\"host\":\"" + jsonEscape(targetHost)
        + "\",\"path\":\"" + jsonEscape(path)
        + "\",\"blocked\":" + blocked + "}";
  }

  /**
   * Pulls the {@code blocks} array out of a response. Lightweight by design (see
   * the class note): paths containing JSON-special characters are unescaped, but
   * if you need guarantees, parse {@link #listAllBlocksRaw} with your own library.
   */
  private static List<String> blocksOf(String json) throws IOException {
    Matcher array = BLOCKS_ARRAY.matcher(json);
    if (!array.find()) throw new IOException("BlockClient: no `blocks` in: " + json);
    List<String> out = new ArrayList<>();
    Matcher item = JSON_STRING.matcher(array.group(1));
    while (item.find()) out.add(jsonUnescape(item.group(1)));
    return out;
  }

  private static boolean flag(Pattern p, String json) {
    Matcher m = p.matcher(json);
    return m.find() && Boolean.parseBoolean(m.group(1));
  }

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
      throw new IOException("BlockClient: " + method + " " + path + " failed ("
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
    throw new IOException("BlockClient: no mock proxy found on " + host + ":"
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

  private static String jsonUnescape(String s) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c != '\\' || i + 1 >= s.length()) {
        out.append(c);
        continue;
      }
      char next = s.charAt(++i);
      switch (next) {
        case 'n': out.append('\n'); break;
        case 'r': out.append('\r'); break;
        case 't': out.append('\t'); break;
        case 'u':
          out.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
          i += 4;
          break;
        default: out.append(next);
      }
    }
    return out.toString();
  }

  private static String urlEncode(String s) {
    return URLEncoder.encode(s, StandardCharsets.UTF_8);
  }
}
