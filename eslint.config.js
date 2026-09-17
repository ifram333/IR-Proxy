/**
 * ESLint flat config.
 * Two environments: the Node/CommonJS backend and the browser dashboard.
 * Formatting is owned by Prettier (.prettierrc); eslint-config-prettier
 * disables any stylistic rules that would conflict.
 */
const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

module.exports = [
  // Ignore generated / vendored / runtime artifacts
  {
    ignores: ["node_modules/**", "mocks/**", "certs/**", "coverage/**"],
  },

  js.configs.recommended,

  // Shared rule tweaks: allow intentionally-unused `_`-prefixed identifiers,
  // ignore unused catch bindings, and permit empty catch blocks.
  {
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Backend: Node, CommonJS
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },

  // Frontend: browser dashboard (ES modules). Some exported functions are
  // referenced only from inline onclick handlers in index.html, so unused-vars
  // is relaxed for exports.
  {
    files: ["public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ace: "readonly" },
    },
    rules: {
      "no-unused-vars": "off",
    },
  },

  // Tests: Jest globals. Backend suites stay CommonJS (inherited above).
  {
    files: ["tests/**/*.js", "**/*.test.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },

  // Frontend test suites are `.mjs` because they import the dashboard's ES
  // modules, and a `.js` file can't be ESM inside a CommonJS package.
  {
    files: ["tests/**/*.mjs", "**/*.test.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.jest },
    },
  },

  prettier,
];
