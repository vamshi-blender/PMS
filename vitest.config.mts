import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "@openai/agents/realtime": fileURLToPath(new URL("./node_modules/@openai/agents/dist/realtime/index.mjs", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
});
