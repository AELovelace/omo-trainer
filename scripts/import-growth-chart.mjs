import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-growth-chart.mjs <lidollquest/web/potty_chart>');
const destination = fileURLToPath(new URL('../potty_chart/', import.meta.url));
await mkdir(join(destination, 'icons'), { recursive: true });
for (const name of ['style.css', 'app.js', 'account.js', 'crt-init.js', 'pwa.js', 'icons/icon-192.png', 'icons/icon-512.png']) {
  await copyFile(join(resolve(source), name), join(destination, name)); // Bundle public assets so deployment never depends on a sibling checkout.
}
const html = (await readFile(join(resolve(source), 'index.html'), 'utf8'))
  .replace('name="tracker-base" content="/tracker/"', 'name="tracker-base" content="../"')
  .replace('<link rel="manifest" href="manifest.webmanifest">', '<meta name="chart-in-tracker" content="true">\n  <link rel="manifest" href="../manifest.webmanifest">')
  .replaceAll('href="../index.html"', 'href="/"');
await writeFile(join(destination, 'index.html'), html); // Keep chart routes inside the existing PWA and reuse its manifest/session.
console.log('Bundled Growth Chart into potty_chart/. Bump sw.js before deploying changed assets.');
