import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "chrome-extension/dist/**",
    "next-env.d.ts",
  ]),
  {
    // The extension is a Vite app, not Next.js: next/image does not exist
    // there, so a plain <img> is correct.
    files: ["chrome-extension/**/*.{ts,tsx}"],
    rules: { "@next/next/no-img-element": "off" },
  },
]);

export default eslintConfig;
