import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
  resolve: {
    // Match the @/* alias from tsconfig.json so tests can import
    // from src/* the same way app code does.
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
