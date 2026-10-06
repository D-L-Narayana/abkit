import { defineConfig } from "vitest/config";

// Unit tests for the TypeScript statistics twin and app libraries. Browser flows live in e2e/ (Playwright).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    pool: "forks",
    poolOptions: { forks: { maxForks: 1, minForks: 1 } },
    testTimeout: 30_000,
    reporters: ["default"],
  },
});
