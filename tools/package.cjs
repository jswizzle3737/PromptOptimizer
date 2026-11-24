// Build the Chrome Web Store upload: dist/promptoptimizer-<version>.zip.
//
//   node tools/package.cjs
//
// Ships only what Chrome loads (SHIP below). Fails if the manifest, a page or a
// module points at a file that would not be shipped, so a broken package is
// caught here rather than by the store review.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const SHIP = ['manifest.json', 'background', 'content', 'shared', 'popup', 'options', 'offscreen', 'icons', 'assets/logo.png'];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const shipped = p => SHIP.some(s => p === s || p.startsWith(s + '/'));
const posix = p => p.split(path.sep).join('/');

/* Everything the manifest names. */
const needed = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon || {}),
  ...manifest.content_scripts.flatMap(c => [...c.js, ...(c.css || [])]),
  ...manifest.web_accessible_resources.flatMap(w => w.resources)
]);

/* Everything shipped pages and scripts reference relatively. */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const shippedFiles = SHIP.flatMap(s => {
  const full = path.join(root, s);
  return fs.statSync(full).isDirectory() ? walk(full) : [full];
}).map(f => posix(path.relative(root, f)));

for (const file of shippedFiles) {
  if (!/\.(js|html|css)$/.test(file)) continue;
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  // Imports and page links resolve against the file; getURL paths against the extension root.
  const relative = [
    ...src.matchAll(/(?:import|export)[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g),
    ...src.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
    ...src.matchAll(/(?:src|href)="(?!https?:|#|data:|mailto:|\/)([^"]+\.(?:js|css|html|png|svg))"/g)
  ].map(m => m[1]);
  for (const ref of relative) needed.add(posix(path.normalize(path.join(path.dirname(file), ref))));
  for (const m of src.matchAll(/runtime\.getURL\(\s*['"]([^'"]+\.[a-z]+)['"]/g)) needed.add(m[1]);
}
// Files built from a folder prefix at run time (content.js: 'shared/' + name, 'content/' + name).
['offscreen/offscreen.html'].forEach(f => needed.add(f));

const missing = [...needed].filter(p => !shipped(p) || !fs.existsSync(path.join(root, p)));
if (missing.length) {
  console.error('Not packaged or missing on disk:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage');
const zip = path.join(dist, `promptoptimizer-${manifest.version}.zip`);
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
for (const s of SHIP) fs.cpSync(path.join(root, s), path.join(stage, s), { recursive: true });

/* Windows PowerShell's Compress-Archive writes backslash entry names, which some
   unzip tools mis-read; write each entry with a forward-slash name instead. */
const winZip = `
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $stage = '${stage}'
  $zip = [IO.Compression.ZipFile]::Open('${zip}', 'Create')
  try {
    Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
      $name = $_.FullName.Substring($stage.Length + 1).Replace('\\', '/')
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name, 'Optimal')
    }
  } finally { $zip.Dispose() }`;
const result = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-Command', winZip], { stdio: 'inherit' })
  : spawnSync('zip', ['-qr', '-X', zip, '.'], { cwd: stage, stdio: 'inherit' });
if (result.status !== 0) {
  console.error('Zipping failed.');
  process.exit(1);
}

const kb = Math.round(fs.statSync(zip).size / 1024);
console.log(`${path.relative(root, zip)}: ${shippedFiles.length} files, ${kb} KB (checked ${needed.size} references)`);
