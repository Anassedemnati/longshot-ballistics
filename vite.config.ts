import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The HDRI tests decode multi-megabyte .hdr files; with every file running
    // in parallel they can pass 5 s on a busy machine.
    testTimeout: 30_000,
  },
});
