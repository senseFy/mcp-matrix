import { build } from 'esbuild';

await build({
  bundle: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  entryPoints: ['server/index.ts'],
  external: ['vite'],
  format: 'esm',
  mainFields: ['module', 'main'],
  outfile: 'dist-server/index.js',
  platform: 'node',
  target: 'node20',
});
