// Downloads the demo's files into downloads/noi/ and checks their SHA-256 hashes.
//
// Usage: node demo/fetch.mjs
//
// The demo uses the organisers' public repository for the NOI 2026 Preliminary Contest, at a fixed commit.
// It holds the statement, the tests and the organisers' solutions: https://github.com/noisg/noi-2026-prelim
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../downloads/noi');

const FILES = {
  'noi-2026-prelim.zip': {
    url: 'https://codeload.github.com/noisg/noi-2026-prelim/zip/f653489f0de45fd5839925aad6e3237978ff8999',
    sha256: '8d92611aea414e018e38b6a736df7bbe5e7420ef28d0c57515d8195d52c23da1',
  },
};

/**
 * Return the SHA-256 hash of some data, in hexadecimal.
 * @param {Buffer} data
 * @returns {string}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

for (const [name, { url, sha256: expected }] of Object.entries(FILES)) {
  const file = path.join(directory, name);
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === expected) continue;

  process.stdout.write(`Downloading ${url} … `);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256(data) !== expected) {
    throw new Error(`${name} does not have the expected SHA-256 hash.`);
  }

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`${(data.length / 2 ** 20).toFixed(1)} MB`);
}
console.log('The demo files are present and verified.');
