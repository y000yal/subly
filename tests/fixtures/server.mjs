// Tiny static server for the fixture pages. localhost:8901 vs 127.0.0.1:8901
// are different origins, which is how iframe-embed.html gets a genuine
// cross-origin iframe without a second machine.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = 8901;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.vtt': 'text/vtt' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  const file = join(root, path === '/' || path === '\\' ? 'texttrack.html' : path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`fixtures: http://localhost:${PORT}/texttrack.html`);
  console.log(`          http://localhost:${PORT}/dom-overlay.html`);
  console.log(`          http://localhost:${PORT}/iframe-embed.html  (iframe loads from 127.0.0.1)`);
});
