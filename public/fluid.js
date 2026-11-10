// 2D 격자 유체 솔버 (Stable Fluids 방식: 이류 → 압력 투영).
// 격자가 작으므로 CPU의 Float32Array로 계산한다. 테두리 1칸은 경계 셀이다.

const FIELDS = ['u', 'v', 'u0', 'v0', 'p', 'div', 'curl', 'r', 'g', 'b', 'r0', 'g0', 'b0'];
const CARRIED = ['u', 'v', 'r', 'g', 'b'];

export class Fluid {
  constructor(w, h) {
    this.iterations = 14; // 압력 반복 횟수
    this.vorticity = 14; // 소용돌이 보강 세기
    this.velDamping = 0.35; // 속도 감쇠 (1/초)
    this.dyeDamping = 0.5; // 염료 감쇠 (1/초)
    this.radius = 0.035; // 붓 반지름 (짧은 변 대비 비율)
    this.force = 30; // 이동량 → 속도 변환 (1/초)
    this._alloc(w, h);
  }

  _alloc(w, h) {
    this.w = w;
    this.h = h;
    this.s = w + 2;
    const n = (w + 2) * (h + 2);
    for (const k of FIELDS) this[k] = new Float32Array(n);
  }

  // 격자 크기를 바꾸고 기존 상태를 새 격자로 옮긴다.
  resize(w, h) {
    if (w === this.w && h === this.h) return;
    const ow = this.w, oh = this.h, os = this.s;
    const old = {};
    for (const k of CARRIED) old[k] = this[k];
    this._alloc(w, h);
    const s = this.s;
    for (const k of CARRIED) {
      const src = old[k], dst = this[k];
      const scale = k === 'u' ? w / ow : k === 'v' ? h / oh : 1;
      for (let j = 1; j <= h; j++) {
        const y = ((j - 0.5) / h) * oh + 0.5;
        for (let i = 1; i <= w; i++) {
          const x = ((i - 0.5) / w) * ow + 0.5;
          dst[i + j * s] = scale * bilerp(src, os, x, y);
        }
      }
    }
  }

  // 정규화 좌표(0~1)의 끝점 (nx, ny)와 이동량 (ndx, ndy)로 붓질을 넣는다.
  // 이동량이 0이면 그 자리에서 퍼지는 물방울로 처리한다.
  splat(nx, ny, ndx, ndy, color) {
    const { w, h, s, u, v, r, g, b } = this;
    const rad = Math.max(1.6, this.radius * Math.min(w, h));
    const x1 = nx * w + 0.5, y1 = ny * h + 0.5;
    const ddx = ndx * w, ddy = ndy * h;
    const len = Math.hypot(ddx, ddy);

    if (len < 1e-6) {
      this._burst(x1, y1, rad * 1.7, color);
      return;
    }

    let tu = ddx * this.force, tv = ddy * this.force;
    const speed = Math.hypot(tu, tv);
    const maxSpeed = Math.min(w, h) * 6;
    if (speed > maxSpeed) {
      tu *= maxSpeed / speed;
      tv *= maxSpeed / speed;
    }

    // 빠르게 움직여도 선이 끊기지 않도록 구간을 나눠 찍는다.
    const n = Math.min(24, Math.max(1, Math.ceil(len / (rad * 0.6))));
    const amount = (0.25 + 0.75 * Math.min(1, len / rad)) / n;
    const inv = 1 / (rad * rad);
    for (let k = 1; k <= n; k++) {
      const t = 1 - k / n;
      const cx = x1 - ddx * t, cy = y1 - ddy * t;
      const i0 = Math.max(1, Math.floor(cx - 2.5 * rad)), i1 = Math.min(w, Math.ceil(cx + 2.5 * rad));
      const j0 = Math.max(1, Math.floor(cy - 2.5 * rad)), j1 = Math.min(h, Math.ceil(cy + 2.5 * rad));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = i - cx, dy = j - cy;
          const wgt = Math.exp(-(dx * dx + dy * dy) * inv);
          const idx = i + j * s;
          u[idx] += wgt * (tu - u[idx]);
          v[idx] += wgt * (tv - v[idx]);
          const a = wgt * amount;
          r[idx] += a * color[0];
          g[idx] += a * color[1];
          b[idx] += a * color[2];
        }
      }
    }
  }

  _burst(cx, cy, rad, color) {
    const { w, h, s, u, v, r, g, b } = this;
    const inv = 1 / (rad * rad);
    const push = Math.min(w, h) * 1.2;
    const i0 = Math.max(1, Math.floor(cx - 2.5 * rad)), i1 = Math.min(w, Math.ceil(cx + 2.5 * rad));
    const j0 = Math.max(1, Math.floor(cy - 2.5 * rad)), j1 = Math.min(h, Math.ceil(cy + 2.5 * rad));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i - cx, dy = j - cy;
        const wgt = Math.exp(-(dx * dx + dy * dy) * inv);
        const idx = i + j * s;
        u[idx] += (wgt * push * dx) / rad;
        v[idx] += (wgt * push * dy) / rad;
        const a = wgt * 1.4;
        r[idx] += a * color[0];
        g[idx] += a * color[1];
        b[idx] += a * color[2];
      }
    }
  }

  step(dt) {
    dt = Math.min(dt, 1 / 30);
    this._confineVorticity(dt);

    this.u0.set(this.u);
    this.v0.set(this.v);
    const vk = 1 / (1 + dt * this.velDamping);
    this._advect(this.u, this.u0, this.u0, this.v0, dt, vk);
    this._advect(this.v, this.v0, this.u0, this.v0, dt, vk);
    this._bound(this.u, 1);
    this._bound(this.v, 2);

    this._project();

    const dk = 1 / (1 + dt * this.dyeDamping);
    for (const [a, a0] of [['r', 'r0'], ['g', 'g0'], ['b', 'b0']]) {
      const src = this[a];
      this[a] = this[a0];
      this[a0] = src;
      this._advect(this[a], src, this.u, this.v, dt, dk);
      this._bound(this[a], 0);
    }
  }

  // 수치 확산으로 사라지는 작은 소용돌이를 되살린다.
  _confineVorticity(dt) {
    const { w, h, s, u, v, curl } = this;
    if (this.vorticity <= 0) return;
    for (let j = 1; j <= h; j++) {
      for (let i = 1; i <= w; i++) {
        const idx = i + j * s;
        curl[idx] = 0.5 * (v[idx + 1] - v[idx - 1] - (u[idx + s] - u[idx - s]));
      }
    }
    const k = dt * this.vorticity;
    for (let j = 2; j < h; j++) {
      for (let i = 2; i < w; i++) {
        const idx = i + j * s;
        let gx = 0.5 * (Math.abs(curl[idx + 1]) - Math.abs(curl[idx - 1]));
        let gy = 0.5 * (Math.abs(curl[idx + s]) - Math.abs(curl[idx - s]));
        const len = Math.hypot(gx, gy) + 1e-5;
        gx /= len;
        gy /= len;
        const c = curl[idx];
        u[idx] += k * gy * c;
        v[idx] -= k * gx * c;
      }
    }
  }

  // 반-라그랑주 이류: 각 셀에서 속도를 거슬러 올라간 지점의 값을 가져온다.
  _advect(dst, src, u, v, dt, k) {
    const { w, h, s } = this;
    const maxX = w + 0.5, maxY = h + 0.5;
    for (let j = 1; j <= h; j++) {
      let idx = j * s + 1;
      for (let i = 1; i <= w; i++, idx++) {
        let x = i - dt * u[idx], y = j - dt * v[idx];
        if (x < 0.5) x = 0.5; else if (x > maxX) x = maxX;
        if (y < 0.5) y = 0.5; else if (y > maxY) y = maxY;
        const i0 = x | 0, j0 = y | 0;
        const fx = x - i0, fy = y - j0;
        const q = i0 + j0 * s;
        dst[idx] = k * ((1 - fy) * ((1 - fx) * src[q] + fx * src[q + 1]) +
          fy * ((1 - fx) * src[q + s] + fx * src[q + s + 1]));
      }
    }
  }

  // 압력을 풀어 속도장의 발산을 제거한다 (비압축성).
  _project() {
    const { w, h, s, u, v, p, div } = this;
    for (let j = 1; j <= h; j++) {
      for (let i = 1; i <= w; i++) {
        const idx = i + j * s;
        div[idx] = -0.5 * (u[idx + 1] - u[idx - 1] + v[idx + s] - v[idx - s]);
      }
    }
    // 이전 프레임의 압력을 초기값으로 재사용해 수렴을 앞당긴다.
    for (let n = 0; n < this.iterations; n++) {
      for (let j = 1; j <= h; j++) {
        let idx = j * s + 1;
        for (let i = 1; i <= w; i++, idx++) {
          p[idx] = 0.25 * (div[idx] + p[idx - 1] + p[idx + 1] + p[idx - s] + p[idx + s]);
        }
      }
      this._bound(p, 0);
    }
    for (let j = 1; j <= h; j++) {
      for (let i = 1; i <= w; i++) {
        const idx = i + j * s;
        u[idx] -= 0.5 * (p[idx + 1] - p[idx - 1]);
        v[idx] -= 0.5 * (p[idx + s] - p[idx - s]);
      }
    }
    this._bound(u, 1);
    this._bound(v, 2);
  }

  // mode 0: 값 복사, 1: 좌우 벽에서 반사(u), 2: 상하 벽에서 반사(v)
  _bound(f, mode) {
    const { w, h, s } = this;
    const sx = mode === 1 ? -1 : 1, sy = mode === 2 ? -1 : 1;
    for (let j = 1; j <= h; j++) {
      const row = j * s;
      f[row] = sx * f[row + 1];
      f[row + w + 1] = sx * f[row + w];
    }
    const last = (h + 1) * s;
    for (let i = 0; i <= w + 1; i++) {
      f[i] = sy * f[i + s];
      f[last + i] = sy * f[last + i - s];
    }
  }
}

function bilerp(f, s, x, y) {
  const i0 = x | 0, j0 = y | 0;
  const fx = x - i0, fy = y - j0;
  const q = i0 + j0 * s;
  return (1 - fy) * ((1 - fx) * f[q] + fx * f[q + 1]) + fy * ((1 - fx) * f[q + s] + fx * f[q + s + 1]);
}
