import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

import { noFragileTextPxRule } from "./eslint-rules/no-fragile-text-px.mjs";

// React Hooksと文字サイズの共通規則。
export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
  },
  {
    files: ["**/*.{js,mjs,jsx,ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      niho: { rules: { "no-fragile-text-px": noFragileTextPxRule } },
      "react-hooks": reactHooks,
    },
    rules: {
      "niho/no-fragile-text-px": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
