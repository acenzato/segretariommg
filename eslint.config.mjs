// Il lint serve soprattutto a mantenere i confini tra i moduli:
// - src/engine non deve usare API del browser, di Chrome o di Node;
// - src/extension gira solo nel content script (browser + Chrome);
// - src/standalone e tools girano solo in Node.
import globals from "globals";

const boundaryRules = {
  "no-undef": "error",
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-unreachable": "error",
};

const portableGlobals = {
  ...globals.es2024,
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  AbortController: "readonly",
};

export default [
  {
    files: ["src/engine/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: portableGlobals,
    },
    rules: boundaryRules,
  },
  {
    files: ["src/extension/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: boundaryRules,
  },
  {
    files: ["src/standalone/**/*.js", "tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: boundaryRules,
  },
  {
    files: ["tools/**/*.mjs"],
    languageOptions: { sourceType: "module" },
  },
];
