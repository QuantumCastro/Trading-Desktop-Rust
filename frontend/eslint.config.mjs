import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import astroPlugin from "eslint-plugin-astro";
import globals from "globals";
import { fileURLToPath } from "node:url";

const astroRecommended = astroPlugin.configs["flat/recommended"];
const tsconfigRootDir = fileURLToPath(new URL("./", import.meta.url));

const tsConfigs = tseslint.configs["flat/recommended-type-checked"].map((config) => ({
  ...config,
  files: ["src/**/*.{ts,tsx,js,jsx}"],
  languageOptions: {
    ...config.languageOptions,
    parser: tsParser,
    parserOptions: {
      ...(config.languageOptions?.parserOptions ?? {}),
      project: "./tsconfig.json",
      tsconfigRootDir,
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: {
        jsx: true,
      },
    },
    globals: {
      ...(config.languageOptions?.globals ?? {}),
      ...globals.browser,
    },
  },
}));

const reactConfig = {
  files: ["src/**/*.{tsx,jsx}"],
  plugins: {
    react: reactPlugin,
    "react-hooks": reactHooksPlugin,
  },
  settings: {
    react: {
      version: "detect",
    },
  },
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir,
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: {
        jsx: true,
      },
    },
    globals: {
      ...globals.browser,
    },
  },
  rules: {
    ...reactPlugin.configs.flat.recommended.rules,
    ...reactHooksPlugin.configs.flat.recommended.rules,
  },
};

const vitestOverrides = {
  files: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}"],
  languageOptions: {
    globals: {
      ...globals.browser,
      ...globals.node,
      ...globals.vitest,
    },
  },
};

const customRules = {
  files: ["src/**/*.{ts,tsx,js,jsx}"],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "react/react-in-jsx-scope": "off",
    "react-hooks/set-state-in-effect": "off",
  },
};

export default [
  {
    ignores: [
      "dist/**",
      ".astro/**",
      "node_modules/**",
      "frontend/dist/**",
      "src-tauri/**",
      "e2e/**",
    ],
  },
  ...astroRecommended,
  ...tsConfigs,
  reactConfig,
  vitestOverrides,
  customRules,
];
