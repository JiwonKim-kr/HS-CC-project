import { Fluid } from './fluid.js';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { alpha: false });
const $ = (id) => document.getElementById(id);

// ── 화질(격자 해상도) ────────────────────────────────────────────
// 단계마다 최대 칸 수가 약 2배씩 늘어난다. 칸이 적을수록 도트가 커지고 계산이 가벼워진다.
const LEVELS = ['min', 'low', 'mid', 'high'];
const MAX_CELLS = { min: 2400, low: 5000, mid: 11000, high: 22000 };
const MIN_CELL_PX = 3;

let quality = load('quality', 'auto');
if (quality !== 'auto' && !LEVELS.includes(quality)) quality = 'auto';
let level = quality === 'auto' ? 'mid' : quality;

function gridFor(lv) {
  const cw = Math.max(1, window.innerWidth), ch = Math.max(1, window.innerHeight);
  const cell = Math.max(MIN_CELL_PX, Math.sqrt((cw * ch) / MAX_CELLS[lv]));
  return [Math.max(16, Math.round(cw / cell)), Math.max(16, Math.round(ch / cell))];
}

const fluid = new Fluid(...gridFor(level));
let image, pixels;

function applyGrid() {
  const [w, h] = gridFor(level);
  fluid.resize(w, h);
  canvas.width = w;
  canvas.height = h;
  image = ctx.createImageData(w, h);
  pixels = new Uint32Array(image.data.buffer);
  $('grid').textContent = `${w}×${h}`;
}

// ── 도트 렌더링 ─────────────────────────────────────────────────
// 칸의 액체 밀도로 채움 여부를 정하고, 가장자리와 색 단계에는 4×4 디더링 패턴을 입힌다.
const STEPS = 5;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((m) => (m + 0.5) / 16);
const LUT = Array.from({ length: STEPS + 1 }, (_, q) => Math.round((255 * q) / STEPS));
const BG_PIXEL = 0xff000000 | (24 << 16) | (12 << 8) | 10;
const EDGE = 0.45; // 이 밀도 아래는 빈 칸
const EDGE_SPAN = 0.8; // 가장자리가 디더링되는 밀도 폭
const SHINE = 0.45; // 수면 한 줄을 밝히는 정도

function render(now) {
  const { w, h, nx, dens, cr, cg, cb } = fluid;
  let o = 0;
  for (let j = 1; j <= h; j++) {
    let c = j * nx + 1;
    const row = ((j & 3) << 2);
    for (let i = 1; i <= w; i++, c++) {
      const t = BAYER[row | (i & 3)];
      const d = dens[c];
      if (d <= EDGE + EDGE_SPAN * t) {
        pixels[o++] = BG_PIXEL;
        continue;
      }
      let R = cr[c] / d, G = cg[c] / d, B = cb[c] / d;
      if (dens[c - nx] <= EDGE) {
        R += (1 - R) * SHINE;
        G += (1 - G) * SHINE;
        B += (1 - B) * SHINE;
      }
      const qr = Math.min(STEPS, (R * STEPS + t) | 0);
      const qg = Math.min(STEPS, (G * STEPS + t) | 0);
      const qb = Math.min(STEPS, (B * STEPS + t) | 0);
      pixels[o++] = 0xff000000 | (LUT[qb] << 16) | (LUT[qg] << 8) | LUT[qr];
    }
  }
  drawMarkers(now, w, h);
  ctx.putImageData(image, 0, 0);
}

// ── 다른 접속자의 위치: 마지막으로 쏟은 자리에 십자 도트를 잠깐 띄운다 ──
const MARKER_MS = 900;
const markers = new Map(); // id → { x, y, t }

function drawMarkers(now, w, h) {
  for (const [id, m] of markers) {
    if (now - m.t > MARKER_MS) {
      markers.delete(id);
      continue;
    }
    const ci = Math.min(w - 1, Math.floor(m.x * w)), cj = Math.min(h - 1, Math.floor(m.y * h));
    for (const [di, dj] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const i = ci + di, j = cj + dj;
      if (i >= 0 && i < w && j >= 0 && j < h) pixels[i + j * w] = 0xffffffff;
    }
  }
}

// ── 색 ──────────────────────────────────────────────────────────
function hueToRgb(hue) {
  const f = (n) => {
    const k = (n + hue / 60) % 6;
    return 1 - Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((c) => 0.06 + 0.94 * c);
}

let myId = null;
let myColor = hueToRgb(Math.random() * 360);

function showMyColor() {
  $('swatch').style.background = `rgb(${myColor.map((c) => Math.round(c * 255)).join(',')})`;
}

// ── 입력: 누르고 있는 동안 그 자리에서 액체가 쏟아진다 ───────────
const pointers = new Map(); // 누르고 있는 포인터
let touched = false;
let lastActivity = performance.now(); // 누군가 마지막으로 액체를 쏟은 시각

function pos(e) {
  return [
    Math.min(1, Math.max(0, e.clientX / window.innerWidth)),
    Math.min(1, Math.max(0, e.clientY / window.innerHeight)),
  ];
}

function emit(x, y, dx, dy) {
  lastActivity = performance.now();
  fluid.pour(x, y, dx, dy, myColor);
  send(x, y, dx, dy);
  if (!touched) {
    touched = true;
    $('hint').classList.add('hidden');
  }
}

canvas.addEventListener('pointerdown', (e) => {
  const [x, y] = pos(e);
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // 캡처가 안 되어도 캔버스 안에서는 그대로 동작한다.
  }
  pointers.set(e.pointerId, { x, y, px: x, py: y });
  emit(x, y, 0, 0);
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (p) [p.x, p.y] = pos(e);
});

for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, (e) => pointers.delete(e.pointerId));
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function flushPointer(p) {
  const dx = Math.max(-0.5, Math.min(0.5, p.x - p.px));
  const dy = Math.max(-0.5, Math.min(0.5, p.y - p.py));
  p.px = p.x;
  p.py = p.y;
  emit(p.x, p.y, dx, dy);
}

// ── 네트워크: 입력만 주고받고 시뮬레이션은 각자 계산한다 ──────────
let ws = null;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    $('status').textContent = '연결됨';
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m[0] === 'h') {
      myId = m[1];
      myColor = hueToRgb(m[2]);
      showMyColor();
      $('count').textContent = m[3];
    } else if (m[0] === 'c') {
      $('count').textContent = m[1];
    } else if (m[0] === 'b' && !document.hidden) {
      const now = performance.now();
      for (const [id, hue, x, y, dx, dy] of m[1]) {
        if (id === myId) continue;
        fluid.pour(x, y, dx, dy, hueToRgb(hue));
        markers.set(id, { x, y, t: now });
        lastActivity = now;
      }
    }
  };
  ws.onclose = () => {
    myId = null;
    $('status').textContent = '재연결 중…';
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}

const round = (n) => Math.round(n * 1e4) / 1e4;

function send(x, y, dx, dy) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(['s', round(x), round(y), round(dx), round(dy)]));
  }
}

// ── 메인 루프 ───────────────────────────────────────────────────
const SEND_INTERVAL = 33; // 쏟는 주기이자 전송 주기(ms)
let last = performance.now();
let lastFlush = last;
let cost = 0; // 프레임당 계산 시간의 이동 평균(ms)
let frames = 0;
let sinceChange = 0;
let fpsFrames = 0;
let fpsTime = last;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (now - lastFlush >= SEND_INTERVAL) {
    lastFlush = now;
    for (const p of pointers.values()) flushPointer(p);
    if (now - lastActivity > IDLE_MS) attract(now);
  }

  const t0 = performance.now();
  fluid.step(dt);
  render(now);
  const ms = performance.now() - t0;
  cost = frames++ === 0 ? ms : cost * 0.95 + ms * 0.05;

  if (quality === 'auto' && ++sinceChange > 90) autoTune();

  fpsFrames++;
  if (now - fpsTime >= 1000) {
    $('fps').textContent = Math.round((fpsFrames * 1000) / (now - fpsTime));
    fpsFrames = 0;
    fpsTime = now;
  }
}

// 한동안 아무도 건드리지 않으면 화면이 비지 않도록 위에서 조금씩 쏟는다.
// 이 액체는 내 화면에만 생기고 서버로 보내지 않는다.
const IDLE_MS = 6000;
const ATTRACT_PERIOD = 5; // 초
const ATTRACT_POUR = 1.2; // 주기마다 쏟는 시간(초)

function attract(now) {
  const t = now / 1000;
  if (t % ATTRACT_PERIOD > ATTRACT_POUR) return;
  const turn = Math.floor(t / ATTRACT_PERIOD);
  const x = 0.5 + 0.38 * Math.sin(turn * 2.4);
  fluid.pour(x, 0.12, 0, 0, hueToRgb((turn * 67) % 360));
}

// 계산이 프레임 예산을 넘으면 한 단계 낮추고, 충분히 남으면 한 단계 올린다.
function autoTune() {
  const i = LEVELS.indexOf(level);
  if (cost > 11 && i > 0) setLevel(LEVELS[i - 1]);
  else if (cost < 4 && i < LEVELS.length - 1) setLevel(LEVELS[i + 1]);
  else sinceChange = 0;
}

function setLevel(lv) {
  level = lv;
  sinceChange = 0;
  frames = 0;
  applyGrid();
}

// ── 시작 ────────────────────────────────────────────────────────
const select = $('quality');
select.value = quality;
select.addEventListener('change', () => {
  quality = select.value;
  save('quality', quality);
  if (quality !== 'auto') setLevel(quality);
  else sinceChange = 0;
});

window.addEventListener('resize', applyGrid);

// QR 초대 화면
$('share').addEventListener('click', () => {
  $('qr-img').src = '/qr.svg';
  $('qr-url').textContent = location.host;
  $('qr').hidden = false;
});
$('qr').addEventListener('click', () => {
  $('qr').hidden = true;
});

function load(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장소를 쓸 수 없으면 이번 접속에만 적용한다.
  }
}

applyGrid();
showMyColor();
connect();
requestAnimationFrame(frame);
