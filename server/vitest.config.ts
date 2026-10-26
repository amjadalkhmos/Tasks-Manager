import { defineConfig } from "vitest/config";

const include = ["src/**/*.test.ts"];

// Every test runs against SQLite and against PostgreSQL (PGlite: real PostgreSQL inside the process), so a query that
// only works on one of them fails here. Set TEST_DATABASE_URL to also run the suite against a real PostgreSQL server.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "sqlite", include, env: { TEST_DB: "sqlite" } } },
      { test: { name: "pglite", include, env: { TEST_DB: "pglite" }, testTimeout: 30_000, hookTimeout: 60_000 } },
      ...(process.env.TEST_DATABASE_URL
        ? [
            {
              test: {
                name: "postgres",
                include,
                env: { TEST_DB: "postgres", TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
                testTimeout: 30_000,
                hookTimeout: 60_000,
                // one shared database: run files one after another
                fileParallelism: false,
              },
            },
          ]
        : []),
    ],
  },
});
