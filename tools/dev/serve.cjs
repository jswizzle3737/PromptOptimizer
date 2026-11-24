// Local preview server for the extension's pages, outside Chrome's extension system.
//
//   node tools/dev/serve.cjs [port]          (default 8765, bound to 127.0.0.1)
//
// Serves the project at / and this folder at /__test/. Every extension HTML page
// gets tools/dev/chrome-mock.js injected first, so the popup and Options render
// in a normal tab:
//   http://127.0.0.1:8765/popup/popup.html
//   http://127.0.0.1:8765/options/options.html
//   http://127.0.0.1:8765/options/email-reply.html
//   http://127.0.0.1:8765/__test/panel.html    in-page panel (call openPanel())
//   http://127.0.0.1:8765/__test/gmail.html    mock Gmail with the reply buttons
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const testDir = __dirname;
const port = Number(process.argv[2]) || 8765;
const types = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const isTest = pathname.startsWith('/__test/');
  const base = isTest ? testDir : root;
  const file = path.resolve(base, isTest ? pathname.slice(8) : pathname.slice(1));
  if (!file.startsWith(base)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    if (!isTest && path.extname(file) === '.html') {
      res.end(data.toString('utf8').replace('<head>', '<head><script src="/__test/chrome-mock.js"></script>'));
      return;
    }
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`Preview server on http://127.0.0.1:${port}/`));
