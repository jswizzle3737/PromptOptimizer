/**
 * Build the Chrome Web Store upload: dist/promptoptimizer-<version>.zip.
 *
 *   node package.mjs
 *
 * Ships only what ship-files.json lists — research notes, design previews,
 * tests and dev scripts stay out of the package. Fails if the manifest points
 * at a file that would not be shipped.
 */
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const { files } = JSON.parse(readFileSync(join(root, 'ship-files.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

/* Every path the manifest (and the offscreen bridge) needs must be shipped. */
const needed = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  'offscreen/offscreen.html',
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap(c => [...c.js, ...(c.css || [])]),
  ...manifest.web_accessible_resources.flatMap(w => w.resources)
];
const shipped = p => files.some(f => p === f || p.startsWith(`${f}/`));
const missing = needed.filter(p => !shipped(p) || !existsSync(join(root, p)));
if (missing.length) {
  console.error(`Not packaged or missing on disk:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const dist = join(root, 'dist');
const stage = join(dist, 'stage');
const zip = join(dist, `promptoptimizer-${manifest.version}.zip`);
rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(stage, { recursive: true });
for (const f of files) cpSync(join(root, f), join(stage, f), { recursive: true });

/* Windows PowerShell's Compress-Archive writes backslash paths, which the Web
   Store rejects; the bsdtar that ships with Windows writes standard zips. */
const result = process.platform === 'win32'
  ? spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
    ['-a', '-c', '-f', zip, ...files], { cwd: stage, stdio: 'inherit' })
  : spawnSync('zip', ['-qr', zip, ...files], { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
if (result.status !== 0) {
  console.error('Zipping failed.');
  process.exit(result.status || 1);
}

const count = dir => readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1), 0);
const total = files.reduce((n, f) => n + (statSync(join(root, f)).isDirectory() ? count(join(root, f)) : 1), 0);
console.log(`${zip}\n${total} files, ${(statSync(zip).size / 1024).toFixed(0)} KB`);
