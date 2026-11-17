import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CLI is a workspace project of the Notees monorepo — @notees/*
    // suites live in their own projects; this run covers the CLI's own
    // specs only.
    include: ["test/**/*.test.ts"],
  },
});
