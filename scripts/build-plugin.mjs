import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const uiHtml = readFileSync('dist/ui.html', 'utf8');

await build({
  entryPoints: ['src/plugin/code.ts'],
  bundle: true,
  target: 'es2017',
  outfile: 'dist/plugin/code.js',
  define: {
    __html__: JSON.stringify(uiHtml),
  },
});
