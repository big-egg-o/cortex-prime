import js from "@eslint/js";
import globals from "globals";

/** Foundry globals available to client code (not to module/rules/). */
const foundryGlobals = Object.fromEntries([
  "foundry", "game", "CONFIG", "CONST", "Hooks", "ui", "canvas", "Handlebars", "PIXI",
  "Actor", "Item", "ChatMessage", "Combat", "Roll", "TextEditor", "User",
  "fromUuid", "fromUuidSync", "getDocumentClass", "_loc"
].map(name => [name, "readonly"]));

/** Globals that must never appear in pure rules code. */
const forbiddenInRules = Object.keys(foundryGlobals).map(name => ({
  name,
  message: "module/rules/ must stay free of Foundry: pass data in, return results out."
}));

export default [
  { ignores: ["reference/**", "node_modules/**", "dist/**", "coverage/**"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "eqeqeq": ["error", "smart"],
      "prefer-const": "error"
    }
  },
  {
    // Client code: browser + Foundry globals.
    files: ["module/**/*.mjs"],
    ignores: ["module/rules/**", "module/data/chat/contest-mapping.mjs"],
    languageOptions: { globals: { ...globals.browser, ...foundryGlobals } }
  },
  {
    // Pure rules, and the pure mapping of the contest message: ECMAScript built-ins only.
    // Imports staying inside module/rules/ are checked by tests/unit/rules-boundary.test.mjs.
    files: ["module/rules/**/*.mjs", "module/data/chat/contest-mapping.mjs"],
    rules: {
      "no-restricted-globals": ["error", ...forbiddenInRules]
    }
  },
  {
    files: ["tests/unit/**/*.mjs", "*.config.mjs", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ["tests/quench/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...foundryGlobals, quench: "readonly" } }
  },
  {
    // scripts/run-quench.mjs: Node code that also hands small functions to
    // page.evaluate()/waitForFunction(), which run inside the Foundry browser page.
    files: ["scripts/run-quench.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...foundryGlobals, quench: "readonly", Mocha: "readonly" }
    }
  }
];
