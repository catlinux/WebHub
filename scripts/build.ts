/** Empaqueta el cliente (src/client) en public/app.js con esbuild. */
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/client/main.ts'],
  outfile: 'public/app.js',
  bundle: true,
  format: 'esm' as const,
  target: ['es2022'],
  minify: !watch,
  sourcemap: watch,
  legalComments: 'none' as const,
  logLevel: 'info' as const,
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
