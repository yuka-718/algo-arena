import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../shared/api.js';
import { createFileStore } from './file-store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const store = await createFileStore(process.env.DATA_FILE || join(root, 'server', 'data', 'arena.json'));
const api = createApi(store);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const security = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

async function readIncoming(req) {
  if (Number(req.headers['content-length']) > 16384) { req.resume(); throw Object.assign(new Error('送信データが大きすぎます。'), { status: 413 }); }
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > 16384) { rejected = true; reject(Object.assign(new Error('送信データが大きすぎます。'), { status: 413 })); }
      else parts.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(parts)); });
    req.on('error', reject);
  });
}
const server = createServer(async (req, res) => {
  try {
    const origin = process.env.PUBLIC_ORIGIN || `http://${req.headers.host || 'localhost'}`;
    const url = new URL(req.url || '/', origin);
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      headers.delete('cf-connecting-ip');
      headers.set('x-arena-ip', req.socket.remoteAddress || 'unknown');
      const body = !['GET', 'HEAD'].includes(req.method) ? await readIncoming(req) : undefined;
      const request = new Request(url, { method: req.method, headers, ...(body?.length ? { body } : {}) });
      const response = await api(request);
      res.writeHead(response.status, { ...security, ...Object.fromEntries(response.headers) });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404, security); res.end('Not found'); return; }
    const data = await readFile(join(root, asset[0]));
    res.writeHead(200, { ...security, 'content-type': asset[1], 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(error.status || 500, { ...security, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.status ? error.message : 'サーバーでエラーが発生しました。', code: error.status === 413 ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR' }));
  }
});
server.listen(Number(process.env.PORT || 4173), process.env.HOST || '0.0.0.0', () => {
  console.log(`ALGO ARENA running at http://localhost:${process.env.PORT || 4173}`);
});
