import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * SchemaClient -- Java helper for running the proxy's saved requests and
 * checking what came back.
 *
 * <p>The other three clients in this folder stage a condition; this one
 * <b>asserts an outcome</b>. A saved request can carry an expectation -- an
 * expected status, a JSON Schema for the body, or both -- and this runs it
 * through the proxy and tells you whether the response met it:
 *
 * <pre>
 *   SchemaClient client = new SchemaClient();
 *
 *   // Throws, listing every problem, if the response didn't match:
 *   client.assertPasses("get-order");
 *
 *   // A whole collection, in order, one at a time:
 *   client.assertCollectionPasses("checkout-flow");
 *
 *   // Or with a schema kept in *your* repo, next to this test:
 *   client.assertPasses("get-order",
 *       "{\"status\":200,\"schema\":" + Files.readString(schemaPath) + "}");
 * </pre>
 *
 * <p><b>The schema is never evaluated here.</b> Every check is answered by the
 * same utils/schema-validate.js the dashboard uses, so this file cannot drift
 * from what the proxy actually enforces -- the same reason BlockClient asks the
 * server whether a path is blocked instead of re-deriving the prefix rule.
 *
 * <p><b>A request with no expectation does not pass.</b> assertPasses throws on
 * one, because an assertion that checked nothing and returned green is the
 * failure this whole feature exists to prevent. Pass your own expectation, or
 * construct with {@code requireCheck = false} if you genuinely mean "just send
 * it".
 *
 * <p><b>Why this one carries a JSON reader and its siblings don't.</b>
 * CaptureClient and BlockClient pull scalars out with targeted regexes and hand
 * back raw JSON for anything nested. That cannot work here: running a
 * collection means reading an <i>ordered</i> list of request ids out of
 * /collections, whose records include each saved request's <b>body</b> -- and a
 * body containing {@code "id"} would poison a regex sweep and silently run the
 * wrong requests, in the wrong order. The reader at the bottom is the price of
 * that being correct, and it keeps the file zero-dependency all the same.
 *
 * <p>Standalone on purpose: JDK 11+ only, no build file, no package. The port
 * autodetection below intentionally duplicates MockClient / CaptureClient /
 * BlockClient / scripts/cli.js -- keeping the client droppable beats sharing.
 */
public class SchemaClient {

  private static final int PREFERRED_PORT = 8888; // proxy's preferred port
  private static final int PORT_SCAN = 20; // matches the proxy's fallback scan

  /**
   * Distinguishes "no override" from an override of {@code null}, which means
   * the opposite thing: send this request and check nothing at all.
   */
  private static final String NO_OVERRIDE = " no-override";

  private final String host;
  private final HttpClient http =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
  private final boolean requireCheck;
  private Integer port;

  public SchemaClient() {
    this(null, null, true);
  }

  public SchemaClient(Integer port) {
    this(null, port, true);
  }

  /**
   * @param host defaults to MOCK_HOST, then localhost
   * @param port explicit port skips autodetection (recommended in hermetic
   *     tests); defaults to MOCK_PORT, then a scan
   * @param requireCheck false lets assertPasses accept a request that checks
   *     nothing, instead of throwing to say the assertion was hollow
   */
  public SchemaClient(String host, Integer port, boolean requireCheck) {
    String envHost = System.getenv("MOCK_HOST");
    String envPort = System.getenv("MOCK_PORT");
    this.host = host != null ? host : (envHost != null ? envHost : "localhost");
    this.port = port != null ? port : (envPort != null ? Integer.parseInt(envPort) : null);
    this.requireCheck = requireCheck;
  }

  // -- Results ---------------------------------------------------------------

  /** What one run produced. */
  public static final class Result {
    public final String id;
    public final String name;
    public final int status;
    /** Whether anything was checked at all. Never conflate this with passed. */
    public final boolean checked;
    /** Only meaningful when {@link #checked}; false otherwise. */
    public final boolean passed;
    public final List<String> errors;

    Result(String id, String name, int status, boolean checked, boolean passed,
        List<String> errors) {
      this.id = id;
      this.name = name;
      this.status = status;
      this.checked = checked;
      this.passed = passed;
      this.errors = Collections.unmodifiableList(new ArrayList<>(errors));
    }

    @Override
    public String toString() {
      String verdict = !checked ? "unchecked" : passed ? "passed" : "FAILED";
      return String.format("%s -> %d %s", name != null ? name : id, status, verdict);
    }
  }

  /** One saved request and whether it checks its response. */
  public static final class Check {
    public final String id;
    public final String name;
    public final String method;
    public final String path;
    public final boolean checked;

    Check(String id, String name, String method, String path, boolean checked) {
      this.id = id;
      this.name = name;
      this.method = method;
      this.path = path;
      this.checked = checked;
    }

    @Override
    public String toString() {
      return String.format("%s %s [%s] %s", method, path, checked ? "{ }" : "no check", name);
    }
  }

  /** Thrown when the run API returns an error response, or cannot be reached. */
  public static class SchemaException extends IOException {
    private static final long serialVersionUID = 1L;

    public SchemaException(String message) {
      super(message);
    }
  }

  /**
   * Thrown when a response did not match what was expected.
   *
   * <p>Its own type because it is the one failure worth catching separately:
   * the request went out and came back fine, the <i>answer</i> was wrong.
   */
  public static class ExpectationFailedException extends SchemaException {
    private static final long serialVersionUID = 1L;

    /** ArrayList, not List: the field of a serializable class has to be one. */
    private final ArrayList<String> errors;

    public ExpectationFailedException(String label, List<String> errors) {
      super(label + " failed its check:\n  " + String.join("\n  ", errors));
      this.errors = new ArrayList<>(errors);
    }

    public List<String> getErrors() {
      return Collections.unmodifiableList(errors);
    }
  }

  /** Thrown when an assertion was made about a request that checks nothing. */
  public static class NothingCheckedException extends SchemaException {
    private static final long serialVersionUID = 1L;

    public NothingCheckedException(String message) {
      super(message);
    }
  }

  // -- Reading ---------------------------------------------------------------

  /** Every saved request, newest first. */
  public String savedRequestsRaw() throws IOException, InterruptedException {
    return get("/saved-requests");
  }

  /** Every collection, ids already resolved into whole records. */
  public String collectionsRaw() throws IOException, InterruptedException {
    return get("/collections");
  }

  /**
   * Which saved requests actually check their response.
   *
   * <p>Worth asking out loud before trusting a green run: a suite of requests
   * that assert nothing passes every time.
   */
  public List<Check> checks() throws IOException, InterruptedException {
    List<Object> records = list(map(Json.parse(savedRequestsRaw())).get("requests"));
    List<Check> out = new ArrayList<>();
    for (Object entry : records) {
      Map<String, Object> r = map(entry);
      out.add(new Check(str(r.get("id")), str(r.get("name")),
          r.get("method") != null ? str(r.get("method")) : "GET", str(r.get("path")),
          r.get("expect") != null));
    }
    return out;
  }

  // -- Running ---------------------------------------------------------------

  /** Send one saved request, using whatever expectation it was saved with. */
  public Result run(String requestId) throws IOException, InterruptedException {
    return run(requestId, NO_OVERRIDE);
  }

  /**
   * Send one saved request through the proxy and report what came back.
   *
   * <p>Does <b>not</b> throw on a failed expectation -- that is
   * {@link #assertPasses}. This is for when you want the verdict as data.
   *
   * @param expectJson raw JSON that <b>replaces</b> the stored expectation for
   *     this call -- e.g. {@code {"status":200,"schema":{...}}} -- which is how
   *     you keep schemas in your own repo next to the tests that use them.
   *     {@code null} sends without checking anything.
   */
  public Result run(String requestId, String expectJson)
      throws IOException, InterruptedException {
    String body =
        NO_OVERRIDE.equals(expectJson)
            ? "{}"
            : "{\"expect\":" + (expectJson == null ? "null" : expectJson) + "}";
    Map<String, Object> res =
        map(Json.parse(post("/saved-requests/" + urlEncode(requestId) + "/send", body)));

    Object verdict = res.get("expect");
    if (verdict == null) {
      return new Result(requestId, null, intOf(res.get("status")), false, false,
          new ArrayList<>());
    }
    Map<String, Object> e = map(verdict);
    List<String> errors = new ArrayList<>();
    for (Object line : list(e.get("errors"))) {
      errors.add(str(line));
    }
    return new Result(requestId, null, intOf(res.get("status")), true,
        Boolean.TRUE.equals(e.get("passed")), errors);
  }

  /** Send one saved request and throw unless the response met its check. */
  public Result assertPasses(String requestId) throws IOException, InterruptedException {
    return assertPasses(requestId, NO_OVERRIDE);
  }

  /**
   * Send one saved request and throw unless the response met its check.
   *
   * @throws ExpectationFailedException when the check failed (see getErrors)
   * @throws NothingCheckedException when the request had no check at all
   */
  public Result assertPasses(String requestId, String expectJson)
      throws IOException, InterruptedException {
    Result result = run(requestId, expectJson);
    if (!result.checked) {
      if (!requireCheck) {
        return result;
      }
      throw new NothingCheckedException(
          "SchemaClient: saved request \"" + requestId + "\" has no expectation, so this "
              + "assertion checked nothing and would pass whatever came back. Add one from "
              + "the dashboard's Expect tab, pass your own expectation, or construct with "
              + "requireCheck = false if sending without checking is intended.");
    }
    if (!result.passed) {
      throw new ExpectationFailedException("\"" + requestId + "\"", result.errors);
    }
    return result;
  }

  /**
   * Run a whole collection, <b>in order, one at a time</b>.
   *
   * <p>Sequential because that is the shape these have -- "log in, then call the
   * thing that needs the token". It does not stop at the first failure: a run is
   * how you find out <i>where</i> a flow breaks, and the results after the red
   * one are part of that answer.
   */
  public List<Result> runCollection(String nameOrId)
      throws IOException, InterruptedException {
    List<Object> groups = list(map(Json.parse(collectionsRaw())).get("collections"));

    Map<String, Object> group = null;
    List<String> known = new ArrayList<>();
    for (Object entry : groups) {
      Map<String, Object> g = map(entry);
      known.add(str(g.get("id")));
      if (nameOrId.equals(g.get("id")) || nameOrId.equals(g.get("name"))) {
        group = g;
      }
    }
    if (group == null) {
      throw new SchemaException("SchemaClient: no collection \"" + nameOrId + "\". Known: "
          + (known.isEmpty() ? "none" : String.join(", ", known)));
    }

    List<Result> results = new ArrayList<>();
    for (Object entry : list(group.get("requests"))) {
      Map<String, Object> record = map(entry);
      String id = str(record.get("id"));
      String name = str(record.get("name"));
      Result outcome;
      try {
        Result raw = run(id);
        outcome = new Result(id, name, raw.status, raw.checked, raw.passed, raw.errors);
      } catch (SchemaException exc) {
        // A request that could not be sent at all -- SSL off for its target, its
        // instance gone, a stored schema that cannot be honoured. It belongs in
        // the results as a failure, not as a throw that hides the rows after it.
        outcome = new Result(id, name, 0, true, false, List.of(exc.getMessage()));
      }
      results.add(outcome);
    }
    return results;
  }

  /**
   * Run a collection and throw unless <b>every</b> request met its check.
   *
   * <p>The message names each failure with its request, because "something in
   * checkout-flow broke" is not an answer anybody can act on. Unchecked requests
   * are reported the same way assertPasses treats one: they are not passes.
   */
  public List<Result> assertCollectionPasses(String nameOrId)
      throws IOException, InterruptedException {
    List<Result> results = runCollection(nameOrId);

    List<String> problems = new ArrayList<>();
    for (Result r : results) {
      String label = r.name != null ? r.name : r.id;
      if (!r.checked) {
        if (requireCheck) {
          problems.add(label + ": nothing was checked");
        }
        continue;
      }
      if (!r.passed) {
        for (String line : r.errors) {
          problems.add(label + ": " + line);
        }
      }
    }

    if (!problems.isEmpty()) {
      throw new ExpectationFailedException("Collection \"" + nameOrId + "\"", problems);
    }
    return results;
  }

  // -- HTTP ------------------------------------------------------------------

  private int resolvePort() throws IOException, InterruptedException {
    if (port != null) {
      return port;
    }
    for (int p = PREFERRED_PORT; p <= PREFERRED_PORT + PORT_SCAN; p++) {
      if (probe(p)) {
        port = p;
        return p;
      }
    }
    throw new SchemaException("SchemaClient: no mock proxy found on " + host + ":"
        + PREFERRED_PORT + "-" + (PREFERRED_PORT + PORT_SCAN)
        + " (is the server running? set MOCK_PORT to override)");
  }

  /** Probe a port for OUR admin server (another proxy on 8888 won't match). */
  private boolean probe(int candidate) throws InterruptedException {
    try {
      HttpResponse<String> res = http.send(
          HttpRequest
              .newBuilder(URI.create("http://" + host + ":" + candidate + "/__admin/health"))
              .timeout(Duration.ofMillis(500)).GET().build(),
          HttpResponse.BodyHandlers.ofString());
      return res.statusCode() == 200 && res.body().contains("\"status\":\"ok\"")
          && res.body().contains("\"instances\"");
    } catch (IOException e) {
      return false;
    }
  }

  private String get(String path) throws IOException, InterruptedException {
    return send(HttpRequest.newBuilder(uri(path)).GET(), "GET", path);
  }

  private String post(String path, String body) throws IOException, InterruptedException {
    return send(HttpRequest.newBuilder(uri(path)).header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8)), "POST", path);
  }

  private URI uri(String path) throws IOException, InterruptedException {
    return URI.create("http://" + host + ":" + resolvePort() + "/__admin" + path);
  }

  private String send(HttpRequest.Builder builder, String method, String path)
      throws IOException, InterruptedException {
    HttpResponse<String> res = http.send(builder.timeout(Duration.ofSeconds(35)).build(),
        HttpResponse.BodyHandlers.ofString());
    if (res.statusCode() < 200 || res.statusCode() >= 300) {
      throw new SchemaException("SchemaClient: " + method + " " + path + " failed ("
          + res.statusCode() + "): " + errorOf(res.body()));
    }
    return res.body();
  }

  private static String errorOf(String body) {
    try {
      Object message = map(Json.parse(body)).get("error");
      if (message != null) {
        return str(message);
      }
    } catch (RuntimeException ignored) {
      // Not our JSON shape -- the raw body is a better message than a crash.
    }
    return body;
  }

  private static String urlEncode(String s) {
    return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
  }

  // -- Reading parsed JSON ---------------------------------------------------

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object value) {
    if (!(value instanceof Map)) {
      throw new IllegalStateException("expected a JSON object");
    }
    return (Map<String, Object>) value;
  }

  @SuppressWarnings("unchecked")
  private static List<Object> list(Object value) {
    if (value == null) {
      return new ArrayList<>();
    }
    if (!(value instanceof List)) {
      throw new IllegalStateException("expected a JSON array");
    }
    return (List<Object>) value;
  }

  private static String str(Object value) {
    return value == null ? null : String.valueOf(value);
  }

  private static int intOf(Object value) {
    return value instanceof Number ? ((Number) value).intValue() : 0;
  }

  // -- A minimal JSON reader -------------------------------------------------
  // Not a general-purpose library: it reads the proxy's own responses, which are
  // produced by JSON.stringify and are therefore always well-formed. What it
  // must be is *structurally* correct rather than a regex sweep, because a saved
  // request's body is arbitrary JSON and a body containing "id" would otherwise
  // be mistaken for a record's id -- running the wrong requests, in the wrong
  // order, and reporting green.

  private static final class Json {
    private final String s;
    private int i;

    private Json(String source) {
      this.s = source;
    }

    static Object parse(String source) {
      try {
        Json reader = new Json(source);
        reader.ws();
        return reader.value();
      } catch (RuntimeException e) {
        throw new IllegalStateException("SchemaClient: could not read the server's JSON", e);
      }
    }

    private void ws() {
      while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
        i++;
      }
    }

    private Object value() {
      switch (s.charAt(i)) {
        case '{':
          return object();
        case '[':
          return array();
        case '"':
          return string();
        case 't':
          i += 4;
          return Boolean.TRUE;
        case 'f':
          i += 5;
          return Boolean.FALSE;
        case 'n':
          i += 4;
          return null;
        default:
          return number();
      }
    }

    private Map<String, Object> object() {
      Map<String, Object> out = new LinkedHashMap<>();
      i++; // '{'
      ws();
      if (s.charAt(i) == '}') {
        i++;
        return out;
      }
      while (true) {
        ws();
        String key = string();
        ws();
        i++; // ':'
        ws();
        out.put(key, value());
        ws();
        if (s.charAt(i) == ',') {
          i++;
          continue;
        }
        i++; // '}'
        return out;
      }
    }

    private List<Object> array() {
      List<Object> out = new ArrayList<>();
      i++; // '['
      ws();
      if (s.charAt(i) == ']') {
        i++;
        return out;
      }
      while (true) {
        ws();
        out.add(value());
        ws();
        if (s.charAt(i) == ',') {
          i++;
          continue;
        }
        i++; // ']'
        return out;
      }
    }

    private String string() {
      StringBuilder b = new StringBuilder();
      i++; // opening quote
      while (true) {
        char ch = s.charAt(i++);
        if (ch == '"') {
          return b.toString();
        }
        if (ch != '\\') {
          b.append(ch);
          continue;
        }
        char esc = s.charAt(i++);
        switch (esc) {
          case 'n':
            b.append('\n');
            break;
          case 't':
            b.append('\t');
            break;
          case 'r':
            b.append('\r');
            break;
          case 'b':
            b.append('\b');
            break;
          case 'f':
            b.append('\f');
            break;
          case 'u':
            b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
            i += 4;
            break;
          default:
            b.append(esc);
        }
      }
    }

    private Number number() {
      int start = i;
      while (i < s.length() && "-+.eE0123456789".indexOf(s.charAt(i)) >= 0) {
        i++;
      }
      String raw = s.substring(start, i);
      // Integers stay integers: a status rendered as "200.0" in a message is the
      // kind of small wrongness nobody trusts the rest of the output after.
      return raw.contains(".") || raw.contains("e") || raw.contains("E")
          ? (Number) Double.valueOf(raw)
          : (Number) Long.valueOf(raw);
    }
  }
}
