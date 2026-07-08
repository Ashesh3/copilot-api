import config from "@echristian/eslint-config"

export default config(
  {
    ignores: [
      "src/routes/dashboard/page-generated.ts",
      "ui/dist",
      "ui/scripts",
    ],
    react: {
      enabled: true,
    },
    reactHooks: {
      enabled: true,
    },
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
  },
  {
    // React screen components legitimately exceed the server-code size caps
    files: ["ui/**/*.tsx"],
    rules: {
      "max-lines-per-function": "off",
      complexity: "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // Server code: no React here; rules-of-hooks false-positives on
    // functions like useFunctionApplyPatch
    files: ["src/**", "tests/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    // Flat aggregation of dashboard API route handlers; grows one function per
    // feature, so the default 800-line cap is not a useful signal here.
    files: ["src/routes/dashboard/api.ts"],
    rules: {
      "max-lines": ["error", 1200],
    },
  },
)
