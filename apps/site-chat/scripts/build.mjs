// Сборка окна чата сайта в один файл: dist/widget.js (+ копия в apps/api/dist/site-chat/widget.js, откуда его отдаёт API).
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const LIMIT_KB = 40;
const targets = [join(root, 'dist/widget.js'), join(root, '../api/dist/site-chat/widget.js')];
const extra = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const result = await build({
  entryPoints: [join(root, 'src/widget.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const js = result.outputFiles[0].text;
const kb = Buffer.byteLength(js) / 1024;
if (kb > LIMIT_KB) throw new Error(`widget.js ${kb.toFixed(1)} КБ — больше ${LIMIT_KB} КБ (ТЗ)`);
for (const file of [...targets, ...extra]) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, js);
}
const size = (await stat(targets[0])).size;
console.log(`site-chat/widget.js собран: ${(size / 1024).toFixed(1)} КБ → ${targets.join(', ')}`);
