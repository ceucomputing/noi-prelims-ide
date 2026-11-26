// A local web server for dist/. It sends the same headers that a real host should send (see dist/_headers).
//
// Usage: node serve.mjs [port] [--bare]
//
//   --bare  Send no security headers. This tests how the IDE copes with a host that cannot send them.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? 8130);
const bare = process.argv.includes('--bare');
const { csp } = JSON.parse(fs.readFileSync(path.join(root, 'build.json')));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.whl': 'application/zip',
  '.pdf': 'application/pdf',
};

const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': csp,
};

/**
 * Find the file for a request path.
 * @param {string} pathname
 * @returns {string|null} The file, or null if there is none.
 */
function findFile(pathname) {
  let file = path.join(root, decodeURIComponent(pathname));
  if (file.endsWith(path.sep)) file = path.join(file, 'index.html');
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return null;
  }
  return file;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  let file = findFile(url.pathname);
  if (!file) {
    response.writeHead(404);
    response.end();
    return;
  }

  const headers = {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    // Files under /b/ have the build's id in their path, so they never change and can be cached for good.
    'Cache-Control': url.pathname.startsWith('/b/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  };
  if (!bare) Object.assign(headers, SECURITY_HEADERS);

  // Send the compressed copy, if there is one and the browser accepts it.
  const acceptsBrotli = /\bbr\b/.test(request.headers['accept-encoding'] ?? '');
  if (acceptsBrotli && fs.existsSync(`${file}.br`)) {
    file += '.br';
    headers['Content-Encoding'] = 'br';
    headers.Vary = 'Accept-Encoding';
  }

  headers['Content-Length'] = fs.statSync(file).size;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(file).pipe(response);
});

server.listen(port, () => {
  console.log(`http://localhost:${port}/${bare ? ' (without security headers)' : ''}`);
});
