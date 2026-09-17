# Contributing

Thanks for helping improve the IR Proxy. This is a QA tool;
the bar is "clear, tested, and consistent with the existing code."

## Getting set up

```bash
npm install
npm run dev      # nodemon; dashboard at http://localhost:8888/ (or the printed port)
```

Node 18+ is required (enforced via `engines` in `package.json`).

## Before you push

```bash
npm run lint            # ESLint must pass
npm run format          # Prettier (writes); or `npm run format:check`
npm test                # Jest suite must be green
```

CI parity is just those three commands — keep them green.

## Adding or editing a mock

Mocks live in `mocks/` as `*.mock.js`, grouped into subfolders by domain
(`account/`, `offers/`, …). You can also create/edit them from the dashboard
(**+ New Mock**, or **Create Mock** from a logged request).

A mock exports an object — or an array of objects — shaped like:

```js
module.exports = {
  name: "Human readable name", // shown in the UI; keep it unique
  delay: 0, // optional artificial latency in ms
  match: (req) => req.path === "/api/example" && req.method === "GET",
  respond: (req, res) => res.status(200).json({ ok: true }),
};
```

- `match(req)` should be specific (path **and** method, and any body/query
  conditions) so it doesn't shadow other mocks. The dashboard flags mocks that
  share an identical `match` source as conflicts.
- Mocks hot-reload — no restart needed.
- Recorded/generated mocks and `state.json` are gitignored; don't commit them.

## Code conventions

- CommonJS on the backend, native ES modules in `public/js` (no bundler).
- Formatting is owned by Prettier (`.prettierrc`); don't hand-format.
- Keep backend modules small and documented with a short JSDoc header, matching
  the existing files in `utils/`.
- Frontend: put shared mutable state in `public/js/modules/state.js`; if you add
  a function referenced by an inline `onclick`, make sure it ends up on `window`
  (the entry module binds all exported handlers — see
  [ARCHITECTURE.md](./ARCHITECTURE.md#frontend)).

## Tests

Add tests under `tests/` for new backend behaviour. Unit-test pure utilities;
use supertest against an app built from the real factories for request-pipeline
behaviour. Tests must be hermetic — use `os.tmpdir()` for any filesystem work
and `IR_PROXY_CERTS_DIR` for anything touching the CA.

## Secrets

Captured traffic never belongs in a commit: mocks, saved requests, schemas,
`state.json` and `certs/` are gitignored because a recorded response can carry a
key from the upstream service. Two nets back that up — Gitleaks runs on every
push and pull request, and a `pre-commit` hook scans staged changes before they
leave your machine.

`npm install` wires the hook up for you (via `core.hooksPath`); it needs
[gitleaks](https://github.com/gitleaks/gitleaks) on your PATH (`brew install
gitleaks`) and warns instead of blocking when it isn't there.

## Architecture

New here? Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the two-tier server, the
request lifecycle, and the certificate/state/mock-loading internals.
