// 2D 액체 솔버 (PIC/FLIP 방식).
// 액체는 입자로 나르고, 압력은 격자에서 푼다. 입자가 없는 칸은 공기로 취급하므로
// 중력에 끌려 떨어진 액체가 바닥에 고이고 수면이 생긴다.
// 격자는 테두리 1칸이 벽이고, 좌표 단위는 칸이며 y는 아래 방향이다.

const SOLID = 0, AIR = 1, LIQUID = 2;
const REST = 2; // 가득 찬 칸 하나에 들어가는 입자 수
const RAD = 0.36; // 입자 반지름 (칸)
const MIN_DIST = RAD * 2;

const PARTICLE_FIELDS = ['x', 'y', 'vx', 'vy', 'r', 'g', 'b', 'life'];
const GRID_FIELDS = ['u', 'v', 'pu', 'pv', 'wu', 'wv', 'dens', 'cr', 'cg', 'cb'];
const CLEARED = ['u', 'v', 'wu', 'wv', 'dens', 'cr', 'cg', 'cb']; // 단계마다 새로 채우는 격자

export class Fluid {
  constructor(w, h) {
    this.gravity = 2.6; // 화면 높이의 배수 / 초²
    this.iterations = 14; // 압력 반복 횟수
    this.flip = 0.8; // FLIP 비율 (나머지는 PIC, 낮을수록 출렁임이 빨리 잦아든다)
    this.fill = 0.38; // 화면에서 액체가 차지할 수 있는 최대 비율
    this.lifetime = 45; // 입자 수명(초): 오래된 액체는 증발한다
    this.radius = 0.03; // 붓 반지름 (짧은 변 대비 비율)
    this.flow = 0.3; // 한 번에 붓 넓이의 몇 배를 쏟을지
    this.force = 30; // 이동량 → 속도 변환 (1/초)
    this.mix = 0.006; // 맞닿은 입자끼리 색이 섞이는 정도
    this.count = 0;
    this._alloc(w, h);
  }

  _alloc(w, h) {
    this.w = w;
    this.h = h;
    const nx = (this.nx = w + 2), ny = (this.ny = h + 2);
    const cells = nx * ny;
    for (const k of GRID_FIELDS) this[k] = new Float32Array(cells);
    this.type = new Uint8Array(cells);
    this.p = new Float32Array(cells); // 압력 (다음 단계의 초기값으로 재사용)
    this.cellStart = new Int32Array(cells + 1);
    this.liquid = new Int32Array(cells); // 이번 단계의 액체 칸 목록
    this.liquidCount = 0;
    // 칸의 네 면이 열려 있는지(1) 벽인지(0)
    for (const k of ['sl', 'sr', 'st', 'sb']) this[k] = new Float32Array(cells);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        this.sl[c] = i > 1 ? 1 : 0;
        this.sr[c] = i < nx - 2 ? 1 : 0;
        this.st[c] = j > 1 ? 1 : 0;
        this.sb[c] = j < ny - 2 ? 1 : 0;
      }
    }
    this.cap = Math.ceil(w * h * this.fill * REST);
    for (const k of PARTICLE_FIELDS) this[k] = new Float32Array(this.cap);
    this.sorted = new Int32Array(this.cap);
    this.count = 0;
  }

  // 격자 크기를 바꾸고 액체를 옮긴다. 화면에서 차지하는 양이 유지되도록 입자 수를 조정한다.
  resize(w, h) {
    if (w === this.w && h === this.h) return;
    const old = { count: this.count };
    for (const k of PARTICLE_FIELDS) old[k] = this[k];
    const sx = w / this.w, sy = h / this.h;
    const ratio = sx * sy;
    this._alloc(w, h);
    for (let i = 0; i < old.count; i++) {
      const copies = Math.floor(ratio) + (Math.random() < ratio % 1 ? 1 : 0);
      for (let c = 0; c < copies && this.count < this.cap; c++) {
        const j = this.count++;
        const jitter = c === 0 ? 0 : 1;
        this.x[j] = 1 + (old.x[i] - 1) * sx + jitter * (Math.random() - 0.5);
        this.y[j] = 1 + (old.y[i] - 1) * sy + jitter * (Math.random() - 0.5);
        this.vx[j] = old.vx[i] * sx;
        this.vy[j] = old.vy[i] * sy;
        this.r[j] = old.r[i];
        this.g[j] = old.g[i];
        this.b[j] = old.b[i];
        this.life[j] = old.life[i];
      }
    }
    this._collide();
  }

  // 정규화 좌표(0~1)의 (nx, ny)에 액체를 쏟는다. (ndx, ndy)는 붓의 이동량으로, 초기 속도가 된다.
  pour(nx, ny, ndx, ndy, color) {
    const { w, h } = this;
    const m = Math.min(w, h);
    const rad = Math.max(1.2, this.radius * m);
    let vx = ndx * w * this.force, vy = ndy * h * this.force;
    const speed = Math.hypot(vx, vy), maxSpeed = m * 4;
    if (speed > maxSpeed) {
      vx *= maxSpeed / speed;
      vy *= maxSpeed / speed;
    }
    const n = Math.max(1, Math.round(REST * Math.PI * rad * rad * this.flow));
    const cx = 1 + nx * w, cy = 1 + ny * h;
    const spread = m * 0.15;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, d = rad * Math.sqrt(Math.random());
      // 가득 찼으면 기존 입자 하나를 무작위로 대체한다.
      const i = this.count < this.cap ? this.count++ : (Math.random() * this.count) | 0;
      this.x[i] = cx + Math.cos(a) * d;
      this.y[i] = cy + Math.sin(a) * d;
      this.vx[i] = vx + (Math.random() - 0.5) * spread;
      this.vy[i] = vy + (Math.random() - 0.5) * spread;
      this.r[i] = color[0];
      this.g[i] = color[1];
      this.b[i] = color[2];
      this.life[i] = this.lifetime * (0.8 + 0.4 * Math.random());
    }
  }

  step(dt) {
    // 간격이 0에 가까운 프레임은 건너뛴다 (압력을 시간 간격으로 나누므로 0이면 안 된다).
    if (!(dt > 1e-4)) return;
    dt = Math.min(dt, 1 / 30);
    const sub = 2;
    for (let s = 0; s < sub; s++) this._substep(dt / sub, s === 0);
  }

  _substep(dt, separate) {
    this._integrate(dt);
    this._collide();
    if (separate) {
      this._separate();
      this._collide();
    }
    this._toGrid();
    this._solve(dt);
    this._toParticles();
  }

  _integrate(dt) {
    const { x, y, vx, vy, life } = this;
    const g = this.gravity * this.h * dt;
    const maxV = 1.6 / dt; // 한 번에 1.6칸 넘게 움직이지 않게 한다
    let n = this.count;
    for (let i = 0; i < n; i++) {
      life[i] -= dt;
      if (life[i] <= 0) {
        n--;
        for (const k of PARTICLE_FIELDS) this[k][i] = this[k][n];
        i--;
        continue;
      }
      let ax = vx[i], ay = vy[i] + g;
      if (ax > maxV) ax = maxV; else if (ax < -maxV) ax = -maxV;
      if (ay > maxV) ay = maxV; else if (ay < -maxV) ay = -maxV;
      vx[i] = ax;
      vy[i] = ay;
      x[i] += ax * dt;
      y[i] += ay * dt;
    }
    this.count = n;
  }

  _collide() {
    const { x, y, vx, vy, count } = this;
    const minX = 1 + RAD, maxX = this.nx - 1 - RAD;
    const minY = 1 + RAD, maxY = this.ny - 1 - RAD;
    for (let i = 0; i < count; i++) {
      if (x[i] < minX) { x[i] = minX; if (vx[i] < 0) vx[i] = 0; }
      else if (x[i] > maxX) { x[i] = maxX; if (vx[i] > 0) vx[i] = 0; }
      if (y[i] < minY) { y[i] = minY; if (vy[i] < 0) vy[i] = 0; }
      else if (y[i] > maxY) { y[i] = maxY; if (vy[i] > 0) vy[i] = 0; }
    }
  }

  // 겹친 입자를 서로 밀어내 뭉침을 막고, 맞닿은 입자끼리 색을 조금씩 섞는다.
  _separate() {
    const { x, y, r, g, b, nx, count, cellStart, sorted } = this;
    cellStart.fill(0);
    for (let i = 0; i < count; i++) cellStart[(x[i] | 0) + (y[i] | 0) * nx]++;
    let sum = 0;
    for (let c = 0; c < cellStart.length; c++) {
      sum += cellStart[c];
      cellStart[c] = sum;
    }
    for (let i = 0; i < count; i++) sorted[--cellStart[(x[i] | 0) + (y[i] | 0) * nx]] = i;

    // 같은 칸과, 오른쪽·아래쪽 이웃 칸만 살펴 입자 쌍을 한 번씩만 처리한다.
    const minD2 = MIN_DIST * MIN_DIST, mix = this.mix;
    const offsets = [0, 1, nx - 1, nx, nx + 1];
    for (let i = 0; i < count; i++) {
      const base = (x[i] | 0) + (y[i] | 0) * nx;
      for (let o = 0; o < 5; o++) {
        const c = base + offsets[o];
        for (let k = cellStart[c], end = cellStart[c + 1]; k < end; k++) {
          const j = sorted[k];
          if (o === 0 && j <= i) continue;
          const dx = x[j] - x[i], dy = y[j] - y[i];
          const d2 = dx * dx + dy * dy;
          if (d2 >= minD2) continue;
          if (d2 === 0) {
            // 완전히 겹친 입자(벽 모서리에 몰린 경우 등)는 임의 방향으로 살짝 떼어 놓는다.
            x[j] += (Math.random() - 0.5) * 0.02;
            y[j] += (Math.random() - 0.5) * 0.02;
            continue;
          }
          const d = Math.sqrt(d2);
          const s = (0.5 * (MIN_DIST - d)) / d;
          x[i] -= dx * s;
          y[i] -= dy * s;
          x[j] += dx * s;
          y[j] += dy * s;
          const mr = (r[j] - r[i]) * mix, mg = (g[j] - g[i]) * mix, mb = (b[j] - b[i]) * mix;
          r[i] += mr; r[j] -= mr;
          g[i] += mg; g[j] -= mg;
          b[i] += mb; b[j] -= mb;
        }
      }
    }
  }

  // 입자의 속도·밀도·색을 격자로 옮긴다.
  _toGrid() {
    const { x, y, vx, vy, r, g, b, nx, ny, count, u, v, wu, wv, dens, cr, cg, cb, type } = this;
    for (const k of CLEARED) this[k].fill(0);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        type[i + j * nx] = i === 0 || j === 0 || i === nx - 1 || j === ny - 1 ? SOLID : AIR;
      }
    }

    for (let p = 0; p < count; p++) {
      const px = x[p], py = y[p];
      type[(px | 0) + (py | 0) * nx] = LIQUID;

      // 가로 속도 u는 칸의 왼쪽 면 (i, j+0.5)에 놓인다.
      let fy = py - 0.5;
      let i0 = px | 0, j0 = fy | 0;
      let tx = px - i0, ty = fy - j0;
      let q = i0 + j0 * nx;
      let w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const pvx = vx[p];
      u[q] += w00 * pvx; wu[q] += w00;
      u[q + 1] += w10 * pvx; wu[q + 1] += w10;
      u[q + nx] += w01 * pvx; wu[q + nx] += w01;
      u[q + nx + 1] += w11 * pvx; wu[q + nx + 1] += w11;

      // 세로 속도 v는 칸의 위쪽 면 (i+0.5, j)에 놓인다.
      const fx = px - 0.5;
      i0 = fx | 0; j0 = py | 0;
      tx = fx - i0; ty = py - j0;
      q = i0 + j0 * nx;
      w00 = (1 - tx) * (1 - ty); w10 = tx * (1 - ty); w01 = (1 - tx) * ty; w11 = tx * ty;
      const pvy = vy[p];
      v[q] += w00 * pvy; wv[q] += w00;
      v[q + 1] += w10 * pvy; wv[q + 1] += w10;
      v[q + nx] += w01 * pvy; wv[q + nx] += w01;
      v[q + nx + 1] += w11 * pvy; wv[q + nx + 1] += w11;

      // 밀도와 색은 칸의 중심에 놓인다.
      j0 = fy | 0;
      ty = fy - j0;
      q = i0 + j0 * nx;
      w00 = (1 - tx) * (1 - ty); w10 = tx * (1 - ty); w01 = (1 - tx) * ty; w11 = tx * ty;
      const pr = r[p], pg = g[p], pb = b[p];
      dens[q] += w00; cr[q] += w00 * pr; cg[q] += w00 * pg; cb[q] += w00 * pb;
      dens[q + 1] += w10; cr[q + 1] += w10 * pr; cg[q + 1] += w10 * pg; cb[q + 1] += w10 * pb;
      dens[q + nx] += w01; cr[q + nx] += w01 * pr; cg[q + nx] += w01 * pg; cb[q + nx] += w01 * pb;
      dens[q + nx + 1] += w11; cr[q + nx + 1] += w11 * pr; cg[q + nx + 1] += w11 * pg; cb[q + nx + 1] += w11 * pb;
    }

    for (let c = 0; c < u.length; c++) {
      if (wu[c] > 0) u[c] /= wu[c];
      if (wv[c] > 0) v[c] /= wv[c];
    }
    // 벽에 닿은 면은 흐름이 없다.
    for (let j = 0; j < ny; j++) {
      u[j * nx] = u[1 + j * nx] = u[nx - 1 + j * nx] = 0;
      v[j * nx] = v[nx - 1 + j * nx] = 0;
    }
    for (let i = 0; i < nx; i++) {
      v[i] = v[i + nx] = v[i + (ny - 1) * nx] = 0;
      u[i] = u[i + (ny - 1) * nx] = 0;
    }
    this.pu.set(u);
    this.pv.set(v);

    let n = 0;
    for (let c = 0; c < type.length; c++) {
      if (type[c] === LIQUID) this.liquid[n++] = c;
      else this.p[c] = 0;
    }
    this.liquidCount = n;
  }

  // 액체 칸마다 들어오고 나가는 흐름이 같아지도록 압력을 푼다 (비압축성).
  // 입자가 과하게 몰린 칸은 바깥으로 밀어내 부피를 유지한다.
  _solve(dt) {
    const { u, v, p, dens, nx, liquid, liquidCount, sl, sr, st, sb } = this;
    const over = 1.9;
    // 고인 액체의 압력은 거의 변하지 않으므로, 지난 단계의 압력을 먼저 적용하고 시작한다.
    for (let k = 0; k < liquidCount; k++) {
      const c = liquid[k];
      const q = (p[c] *= dt);
      u[c] -= sl[c] * q;
      u[c + 1] += sr[c] * q;
      v[c] -= st[c] * q;
      v[c + nx] += sb[c] * q;
    }
    for (let n = 0; n < this.iterations; n++) {
      for (let k = 0; k < liquidCount; k++) {
        const c = liquid[k];
        let div = u[c + 1] - u[c] + v[c + nx] - v[c];
        const excess = dens[c] - REST;
        if (excess > 0) div -= excess;
        const q = (-div / (sl[c] + sr[c] + st[c] + sb[c])) * over;
        p[c] += q;
        u[c] -= sl[c] * q;
        u[c + 1] += sr[c] * q;
        v[c] -= st[c] * q;
        v[c + nx] += sb[c] * q;
      }
    }
    for (let k = 0; k < liquidCount; k++) p[liquid[k]] /= dt;
  }

  // 격자에서 바뀐 속도를 입자에 되돌린다. 공기뿐인 면은 값이 없으므로 제외한다.
  _toParticles() {
    const { x, y, vx, vy, nx, count, u, v, pu, pv, type } = this;
    const flip = this.flip;
    for (let p = 0; p < count; p++) {
      const px = x[p], py = y[p];

      let fy = py - 0.5;
      let i0 = px | 0, j0 = fy | 0;
      let tx = px - i0, ty = fy - j0;
      let q = i0 + j0 * nx;
      let w00 = type[q] !== AIR || type[q - 1] !== AIR ? (1 - tx) * (1 - ty) : 0;
      let w10 = type[q + 1] !== AIR || type[q] !== AIR ? tx * (1 - ty) : 0;
      let w01 = type[q + nx] !== AIR || type[q + nx - 1] !== AIR ? (1 - tx) * ty : 0;
      let w11 = type[q + nx + 1] !== AIR || type[q + nx] !== AIR ? tx * ty : 0;
      let sum = w00 + w10 + w01 + w11;
      if (sum > 0) {
        const pic = (w00 * u[q] + w10 * u[q + 1] + w01 * u[q + nx] + w11 * u[q + nx + 1]) / sum;
        const old = (w00 * pu[q] + w10 * pu[q + 1] + w01 * pu[q + nx] + w11 * pu[q + nx + 1]) / sum;
        vx[p] = flip * (vx[p] + pic - old) + (1 - flip) * pic;
      }

      const fx = px - 0.5;
      i0 = fx | 0; j0 = py | 0;
      tx = fx - i0; ty = py - j0;
      q = i0 + j0 * nx;
      w00 = type[q] !== AIR || type[q - nx] !== AIR ? (1 - tx) * (1 - ty) : 0;
      w10 = type[q + 1] !== AIR || type[q + 1 - nx] !== AIR ? tx * (1 - ty) : 0;
      w01 = type[q + nx] !== AIR || type[q] !== AIR ? (1 - tx) * ty : 0;
      w11 = type[q + nx + 1] !== AIR || type[q + 1] !== AIR ? tx * ty : 0;
      sum = w00 + w10 + w01 + w11;
      if (sum > 0) {
        const pic = (w00 * v[q] + w10 * v[q + 1] + w01 * v[q + nx] + w11 * v[q + nx + 1]) / sum;
        const old = (w00 * pv[q] + w10 * pv[q + 1] + w01 * pv[q + nx] + w11 * pv[q + nx + 1]) / sum;
        vy[p] = flip * (vy[p] + pic - old) + (1 - flip) * pic;
      }
    }
  }
}
