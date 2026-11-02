import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@deskpet/contracts': r('./packages/contracts/src/index.ts'),
      '@deskpet/harness': r('./packages/harness/src/index.ts'),
      '@deskpet/gateways': r('./packages/gateways/src/index.ts'),
      '@deskpet/output': r('./packages/output/src/index.ts'),
      '@deskpet/projector': r('./packages/projector/src/index.ts'),
      '@deskpet/llm': r('./packages/llm/src/index.ts'),
      '@deskpet/server': r('./packages/server/src/index.ts'),
      '@': r('./apps/web/src'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
