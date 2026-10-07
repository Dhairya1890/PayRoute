import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Disable cross-file parallelism so that integration tests sharing the real
    // PostgreSQL and Redis instances (with tables and keys like provider_config and health buckets)
    // do not suffer from cross-file race conditions or database state collisions.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
