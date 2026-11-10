import { Fluid } from './fluid.js';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { alpha: false });
const $ = (id) => document.getElementById(id);

// ── 화질(격자 해상도) ────────────────────────────────────────────
// 단계마다 최대 셀 수가 약 2배씩 늘어난다. 셀이 적을수록 도트가 커지고 계산이 가벼워진다.
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

// ── 도트 렌더링: 색 단계를 줄이고 4×4 디더링 패턴을 입힌다 ────────
const STEPS = 5;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((m) => (m + 0.5) / 16);
const BG = [10, 12, 24];
const LUT = BG.map((bg) => Array.from({ length: STEPS + 1 }, (_, q) => Math.round(bg + ((255 - bg) * q) / STEPS)));

function render() {
  const { w, h, s, r, g, b } = fluid;
  let o = 0;
  for (let j = 1; j <= h; j++) {
    let idx = j * s + 1;
    const row = (j & 3) << 2;
    for (let i = 1; i <= w; i++, idx++) {
      const t = BAYER[row | (i & 3)];
      const R = r[idx], G = g[idx], B = b[idx];
      const qr = Math.min(STEPS, ((R / (1 + R)) * STEPS + t) | 0);
      const qg = Math.min(STEPS, ((G / (1 + G)) * STEPS + t) | 0);
      const qb = Math.min(STEPS, ((B / (1 + B)) * STEPS + t) | 0);
      pixels[o++] = 0xff000000 | (LUT[2][qb] << 16) | (LUT[1][qg] << 8) | LUT[0][qr];
    }
  }
  ctx.putImageData(image, 0, 0);
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

// ── 입력 ────────────────────────────────────────────────────────
const pointers = new Map();
let touched = false;

function pos(e) {
  return [
    Math.min(1, Math.max(0, e.clientX / window.innerWidth)),
    Math.min(1, Math.max(0, e.clientY / window.innerHeight)),
  ];
}

function emit(x, y, dx, dy) {
  fluid.splat(x, y, dx, dy, myColor);
  send(x, y, dx, dy);
  if (!touched) {
    touched = true;
    $('hint').classList.add('hidden');
  }
}

canvas.addEventListener('pointerdown', (e) => {
  const [x, y] = pos(e);
  pointers.set(e.pointerId, { x, y, px: x, py: y });
  emit(x, y, 0, 0);
});

canvas.addEventListener('pointermove', (e) => {
  const [x, y] = pos(e);
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = x;
    p.y = y;
  } else {
    pointers.set(e.pointerId, { x, y, px: x, py: y });
  }
});

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  canvas.addEventListener(type, (e) => {
    flushPointer(pointers.get(e.pointerId));
    pointers.delete(e.pointerId);
  });
}

function flushPointer(p) {
  if (!p) return;
  const dx = Math.max(-0.5, Math.min(0.5, p.x - p.px));
  const dy = Math.max(-0.5, Math.min(0.5, p.y - p.py));
  if (Math.abs(dx) + Math.abs(dy) < 1e-4) return;
  p.px = p.x;
  p.py = p.y;
  emit(p.x, p.y, dx, dy);
}

// ── 네트워크: 붓질만 주고받고 시뮬레이션은 각자 계산한다 ──────────
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
      for (const [id, hue, x, y, dx, dy] of m[1]) {
        if (id !== myId) fluid.splat(x, y, dx, dy, hueToRgb(hue));
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
const SEND_INTERVAL = 33; // 붓질 전송 주기(ms)
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
  }

  const t0 = performance.now();
  fluid.step(dt);
  render();
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

// 첫 화면이 비어 보이지 않도록 몇 번 휘저어 둔다.
for (let i = 0; i < 6; i++) {
  const a = Math.random() * Math.PI * 2;
  fluid.splat(0.2 + Math.random() * 0.6, 0.25 + Math.random() * 0.5, Math.cos(a) * 0.12, Math.sin(a) * 0.12,
    hueToRgb(Math.random() * 360));
}

connect();
requestAnimationFrame(frame);
