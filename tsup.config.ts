import { resolve } from 'node:path'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node18',
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  external: [
    'zod', 'commander', '@modelcontextprotocol/sdk', 'fast-glob',
    'gray-matter', 'lodash-es', 'ink', 'react', 'react-reconciler',
    'yoga-layout', 'react-devtools-core',
  ],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      'react-devtools-core': resolve('src/shims/react-devtools-core.ts'),
    }
  },
})
