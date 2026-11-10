// 정적 파일 제공 + 붓질 중계 서버.
// 시뮬레이션은 각 브라우저가 계산하고, 서버는 입력만 모아 주기적으로 모두에게 전달한다.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const TICK_MS = 50; // 중계 주기
const MAX_CLIENTS = 300;
const MAX_PER_SECOND = 45; // 접속자 한 명이 초당 보낼 수 있는 붓질 수
const MAX_BATCH = 600; // 한 주기에 전달하는 붓질 수 상한

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: wss.clients.size }));
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(PUBLIC_DIR, pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname !== '/ws' || wss.clients.size >= MAX_CLIENTS) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

let nextId = 1;
let pending = [];

function broadcast(message) {
  const text = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(text);
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

wss.on('connection', (ws) => {
  const id = nextId++;
  const hue = Math.round((id * 137.508) % 360); // 황금각으로 돌려 서로 다른 색을 배정
  let tokens = MAX_PER_SECOND;
  let refilled = Date.now();
  ws.alive = true;

  ws.send(JSON.stringify(['h', id, hue, wss.clients.size]));
  broadcast(['c', wss.clients.size]);

  ws.on('pong', () => {
    ws.alive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;

    const now = Date.now();
    tokens = Math.min(MAX_PER_SECOND, tokens + ((now - refilled) / 1000) * MAX_PER_SECOND);
    refilled = now;
    if (tokens < 1) return;
    tokens -= 1;

    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!Array.isArray(m) || m.length !== 5 || m[0] !== 's') return;
    const nums = m.slice(1);
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    if (pending.length >= MAX_BATCH) return;

    const [x, y, dx, dy] = nums;
    pending.push([id, hue, clamp(x, 0, 1), clamp(y, 0, 1), clamp(dx, -0.5, 0.5), clamp(dy, -0.5, 0.5)]);
  });

  ws.on('close', () => broadcast(['c', wss.clients.size]));
  ws.on('error', () => ws.terminate());
});

setInterval(() => {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  broadcast(['b', batch]);
}, TICK_MS);

// 응답 없는 연결을 정리한다.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`dot-fluid listening on http://${HOST}:${PORT}`);
});
