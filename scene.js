// scene.js: all the pixel art. There are no image files: every picture is drawn
// here, in code, at low resolution, then scaled up so each pixel stays square.
//
//   pix()            a tiny pixel canvas to draw on
//   createScene()    the first-person street: you at your door, the postman walking up
//   envelopeCanvas() the envelope (also used by the creator page)

export const INK = '#3a2440';   // outlines and text
export const BG = '#fde8dc';    // the page colour everything fades into

// ---------- drawing helpers ----------

const rgbCache = new Map();
function rgb(hex) {
  let c = rgbCache.get(hex);
  if (!c) { const n = parseInt(hex.slice(1), 16); c = [n >> 16, (n >> 8) & 255, n & 255]; rgbCache.set(hex, c); }
  return c;
}

// A w×h grid of pixels. Draw on it, then call .canvas() to get a real canvas.
export function pix(w, h) {
  const img = new ImageData(w, h), d = img.data;
  const set = (x, y, hex) => {
    x = Math.floor(x); y = Math.floor(y);
    if (!hex || x < 0 || y < 0 || x >= w || y >= h) return;
    const c = rgb(hex), i = (y * w + x) * 4;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  };
  const clear = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) d[(y * w + x) * 4 + 3] = 0; };
  const rect = (x, y, rw, rh, hex) => {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + rw), y1 = Math.round(y + rh);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) set(i, j, hex);
  };
  // Fill any polygon, row by row, so edges stay hard (no anti-aliasing).
  const poly = (pts, hex) => {
    const ys = pts.map(p => p[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys))), bottom = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) set(x, y, hex);
    }
  };
  const line = (x0, y0, x1, y1, hex) => {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      set(x0, y0, hex);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  // Draw a sprite written as strings: one character per pixel, '.' is see-through.
  const sprite = (rows, pal, ox = 0, oy = 0) =>
    rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== '.') set(ox + i, oy + j, pal[ch]); }));
  const canvas = () => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  };
  return { w, h, set, clear, rect, poly, line, sprite, canvas };
}

const mod = (a, n) => ((a % n) + n) % n;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Repeatable "random" number in [0, 1) for a grid cell, so textures don't flicker.
export function hash(a, b) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Ordered dithering: blends two colours with a checkered pattern, the old-console way.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const dither = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

// Paint a vertical gradient of flat colour bands, dithered where bands meet.
export function bands(p, colors, y0, y1, x0 = 0, x1 = p.w) {
  for (let y = y0; y < y1; y++) {
    const v = (y - y0) / Math.max(1, y1 - y0 - 1) * (colors.length - 1), i = Math.floor(v), fr = v - i;
    for (let x = x0; x < x1; x++) p.set(x, y, fr > dither(x, y) ? colors[Math.min(i + 1, colors.length - 1)] : colors[i]);
  }
}

// A soft round shape (tree, bush, cloud) built from overlapping circles,
// shaded light at the top-left and dark at the bottom-right in 4 steps.
function blob(p, cx, cy, R, parts, pal, flatBottom = Infinity) {
  for (let y = Math.floor(cy - R * 1.6); y <= cy + R * 1.6; y++) {
    if (y > flatBottom) break;
    for (let x = Math.floor(cx - R * 2); x <= cx + R * 2; x++) {
      let best = null;
      for (const [ox, oy, r] of parts) {
        const u = (x + 0.5 - (cx + ox * R)) / (r * R), v = (y + 0.5 - (cy + oy * R)) / (r * R), dd = u * u + v * v;
        if (dd <= 1 && (!best || dd < best.dd)) best = { u, v, dd };
      }
      if (!best) continue;
      const light = -(best.u * 0.5 + best.v * 0.85) * 0.9 + (1 - best.dd) * 0.5 + hash(x * 3 + 1, y * 7 + 2) * 0.5 - 0.25;
      p.set(x, y, pal[light < -0.3 ? 0 : light < 0.3 ? 1 : light < 0.85 ? 2 : 3]);
    }
  }
}

// ---------- the envelope ----------

export const ENV_W = 48, ENV_H = 32, CUT_ROW = 5;
const HEART = ['.RR..RR.', 'RrrRRrrR', 'RhrrrrrR', 'RrrrrrrR', '.RrrrrR.', '..RrrR..', '...RR...'];
const HEART_PAL = { R: '#a8344f', r: '#e0516e', h: '#ff9fb3' };

// The back of an envelope: flap, wax heart seal. `dashes` draws the cut line;
// `cut` = [from, to] columns already cut open.
export function envelopeCanvas({ dashes = false, cut = null } = {}) {
  const p = pix(ENV_W, ENV_H);
  p.rect(0, 0, ENV_W, ENV_H, INK);
  p.rect(1, 1, ENV_W - 2, ENV_H - 2, '#fff3df');
  p.rect(1, 26, ENV_W - 2, 5, '#f7e4c8');
  p.line(1, 30, 21, 17, '#ecd2b2');
  p.line(46, 30, 26, 17, '#ecd2b2');
  p.poly([[1, 1], [47, 1], [24, 19.5]], '#ffe9cf');
  p.line(1, 1, 23, 19, '#d6b591');
  p.line(46, 1, 24, 19, '#d6b591');
  p.sprite(HEART, HEART_PAL, 20, 15);
  if (dashes) for (let x = 2; x < 46; x++) if ((x >> 1) % 2 === 0) p.set(x, CUT_ROW, '#c9a98d');
  if (cut) for (let x = cut[0]; x <= cut[1]; x++) p.set(x, CUT_ROW, INK);
  return p.canvas();
}

// A faint tile of tiny hearts for the page background, pre-scaled so it stays crisp.
export function patternURL(by = 3) {
  const p = pix(40, 40), heart = ['.r.r.', 'rrrrr', '.rrr.', '..r..'];
  p.sprite(heart, { r: '#f8d6cb' }, 6, 8);
  p.sprite(heart, { r: '#f8d6cb' }, 26, 28);
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  c.width = c.height = 40 * by;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(p.canvas(), 0, 0, c.width, c.height);
  return c.toDataURL();
}

export function scissorsCanvas() {
  const p = pix(10, 8);
  p.sprite(['.ppp......', 'p...p...gg', 'p...p.gg..', '.ppppg....', '.ppppg....', 'p...p.gg..', 'p...p...gg', '.ppp......'],
    { p: '#e0516e', g: '#8f8fae' });
  return p.canvas();
}

// ---------- the postman ----------

// Left half of the postman (13 columns); the right half is its mirror image.
// Legs, bag and badge are added in code below.
const POSTMAN_HALF = [
  '........kkkkk',
  '......kkbbbbb',
  '.....kbbbbbbb',
  '.....kbbbbbbb',
  '.....kBBBBBBB',
  '...kkBBBBBBBB',
  '...kkkkkkkkkk',
  '.....khhsssss',
  '.....khssssss',
  '.....ksssesss',
  '.....ksssesss',
  '.....kspssmss',
  '.....ksssssmm',
  '......kssssss',
  '.......kkkkkk',
  '..........kSS',
  '....kkkkbbwww',
  '...kbbbbbbbbw',
  '...kbbbbbbbbb',
  '..kbbBbbbbbbb',
  '..kbbBbbbbbbb',
  '..kbbBbbbbbbb',
  '..kbbBbbbbbbb',
  '..kbbBbbbbbbb',
  '..kbbBRRRRRRy',
  '..kbbknnnnnnn',
  '..kssknnnnnnn',
  '..kssknnnnnnn',
];
const POSTMAN_PAL = {
  k: INK, b: '#5b7fe0', B: '#3d58b4', n: '#2e3768', s: '#f7cda9', S: '#e2a283', p: '#f59aaa',
  e: INK, m: '#c4506b', w: '#fffaf2', y: '#f6c84f', r: '#b06e44', R: '#7a4329', h: '#6b432b', g: '#7d7d99',
};
const SPRITE_W = 25, SPRITE_H = 42, POSTMAN_M = 1.8; // sprite size in pixels, and his height in metres

// pose: 'stand' or 'hold'; lift: how far each foot is raised (for walking).
function postmanSprite(pose, lift = [0, 0]) {
  const P = POSTMAN_PAL, p = pix(SPRITE_W, SPRITE_H);
  p.sprite(POSTMAN_HALF.map(r => r + [...r.slice(0, -1)].reverse().join('')), P);
  // legs and shoes
  [[6, lift[0]], [13, lift[1]]].forEach(([x0, L]) => {
    for (let y = 28; y < 40 - L; y++) { p.set(x0, y, P.k); for (let i = 1; i < 5; i++) p.set(x0 + i, y, P.n); p.set(x0 + 5, y, P.k); }
    p.rect(x0, 40 - L, 6, 2, P.k);
    p.set(x0 + 1, 40 - L, P.g);
  });
  p.rect(11, 2, 3, 2, P.y);                       // cap badge
  for (let i = 0; i < 9; i++) { p.set(7 + i, 16 + i, P.R); p.set(8 + i, 16 + i, P.R); } // bag strap
  p.sprite(['kkkkkkk', 'kRRRRRk', 'krrprrk', 'krrrrrk', 'krrrrrk', 'kkkkkkk'], P, 16, 24); // bag
  if (pose === 'hold') {
    // arms come up to hold the letter at his chest
    for (let y = 25; y < 28; y++) for (let x = 2; x < 5; x++) y === 25 ? p.set(x, y, P.k) : p.clear(x, y);
    p.rect(5, 19, 2, 3, P.s); p.rect(18, 19, 2, 3, P.s);
  }
  return p.canvas();
}

// ---------- the scene ----------

export function createScene(canvas) {
  const ctx = canvas.getContext('2d');
  const W = 160, CAM_H = 1.6, Z_START = 12.4, Z_STOP = 2.1;
  let H, f, y0, scale, bg, layers = [];
  const frames = {
    stand: postmanSprite('stand'), walkA: postmanSprite('stand', [2, 0]),
    walkB: postmanSprite('stand', [0, 2]), hold: postmanSprite('hold'),
  };
  const env = envelopeCanvas();
  const st = { z: Z_START, frame: 'stand', bob: 0, hopY: 0, hopT: 0, holding: false, envGone: false, running: false, last: 0 };
  let walk = null;
  const petals = Array.from({ length: 12 }, (_, i) => ({ x: hash(i, 1) * W, y: hash(i, 2) * 300, v: 5 + hash(i, 3) * 7, ph: hash(i, 4) * 6, big: hash(i, 5) < 0.3 }));

  // World → screen. x: metres right of you, y: metres up, z: metres ahead.
  const project = (x, y, z) => [W / 2 + x * f / z, y0 + (CAM_H - y) * f / z];

  function layout() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;   // not laid out yet; the next resize will do it
    scale = r.width / W;
    H = Math.max(200, Math.round(r.height / scale));
    canvas.width = W; canvas.height = H;
    f = W * 0.95; y0 = Math.round(H * 0.42);
    bg = background();
    layers = [fenceLayer(), treeLayer(4.6, 9.6, 'green'), treeLayer(-3.4, 7.4, 'blossom'),
      bushLayer(2.6, 4.6, ['#c7608a', '#ec8fb4', '#ffbfd6', '#fff0f6']),
      bushLayer(-2.3, 3.6, ['#5d73bd', '#8ea4ea', '#bccaf7', '#eef2ff']),
      plantLayer(), doorLayer()];
  }

  // What the ground is made of at a point on it.
  function ground(wx, z) {
    if (z > 22) return '#a7c98f';
    if (z > 20) return hash(Math.floor(wx / 0.3), Math.floor(z / 0.3)) < 0.3 ? '#86bf78' : '#97cc85';
    if (z > 18.5) return '#e7d3c8';
    if (z > 18.3) return '#c9b0a6';
    if (z > 13.15) {
      if (Math.abs(z - 15.75) < 0.12 && mod(wx, 3) < 1.5) return '#f8e6a6';
      return hash(Math.floor(wx / 0.25), Math.floor(z / 0.25)) < 0.15 ? '#6f6890' : '#7b7499';
    }
    if (z > 13) return '#c9b0a6';
    if (z > 11.6) return mod(wx, 1.4) < 0.06 ? '#ccb6aa' : '#e7d6cc';
    if (z > 2) return lawn(wx, z);
    if (z > 1.93) return '#7a4a33';
    return porch(wx, z);
  }
  function lawn(wx, z) {
    const i = Math.round((z - 2.55) / 0.92);   // stepping stones up the middle
    if (i >= 0 && i <= 9) {
      const dx = (wx - (i % 2 ? 0.12 : -0.12)) / 0.42, dz = (z - (2.55 + i * 0.92)) / 0.3, dd = dx * dx + dz * dz;
      if (dd < 1) return dd > 0.55 && dz < 0 ? '#bfae98' : '#e4d6c4';
    }
    const cx = Math.floor(wx / 0.16), cz = Math.floor(z / 0.16), h = hash(cx, cz);
    if (z > 10.7 && Math.abs(wx) > 0.7) {      // flower bed along the fence
      if (h < 0.35) return ['#ff9ec4', '#fff3f6', '#ffd66e', '#c9a3ff'][Math.floor(hash(cx + 5, cz) * 4)];
      return h < 0.65 ? '#5fa85a' : '#b07f60';
    }
    if (hash(cx + 999, cz) < 0.008) return hash(cx, cz + 3) < 0.5 ? '#fff3f6' : '#ffd66e';
    return h < 0.25 ? '#6cb85f' : h > 0.94 ? '#b4e79a' : '#86cf74';
  }
  function porch(wx, z) {
    if (Math.abs(wx) < 0.5 && z > 1.2 && z < 1.8) {
      const edge = Math.abs(wx) > 0.44 || z < 1.26 || z > 1.74;
      return edge ? '#c96f6a' : hash(Math.floor(wx / 0.07), Math.floor(z / 0.07)) < 0.5 ? '#ec9a8f' : '#e3918a';
    }
    if (mod(wx, 0.24) < 0.016) return '#8a5638';
    return hash(Math.floor(wx / 0.24), 7) < 0.5 ? '#c08860' : '#b87f58';
  }

  function background() {
    const p = pix(W, H);
    bands(p, ['#7f8fe0', '#9d96e4', '#c09ddf', '#e3a6cc', '#f6b6b0', '#ffcfa4'], 0, y0);
    // the sun, low and warm
    const sx = W * 0.7, sy = y0 - 9;
    for (let y = sy - 14; y <= sy + 14; y++) for (let x = sx - 14; x <= sx + 14; x++) {
      const dd = ((x + 0.5 - sx) ** 2 + (y + 0.5 - sy) ** 2) / 13 ** 2;
      if (dd < 1) p.set(x, y, dd < 0.6 ? '#fff6d6' : dd < 0.8 || dither(x, y) > 0.5 ? '#ffe9b0' : null);
    }
    const cloud = ['#f0c2d8', '#ffd9e6', '#fff0f4', '#fffafc'], cparts = [[0, 0, 1], [-0.9, 0.3, 0.7], [0.9, 0.35, 0.62], [0.4, -0.25, 0.7]];
    blob(p, 30, y0 * 0.32, 7, cparts, cloud, y0 * 0.32 + 4);
    blob(p, 118, y0 * 0.16, 9, cparts, cloud, y0 * 0.16 + 5);
    blob(p, 78, y0 * 0.55, 5, cparts, cloud, y0 * 0.55 + 3);
    // far hills
    for (let x = 0; x < W; x++) {
      const hh = 7 + 3 * Math.sin(x * 0.09) + 2 * Math.sin(x * 0.23 + 1);
      for (let y = Math.round(y0 - hh); y < y0; y++) p.set(x, y, y < y0 - hh + 2 ? '#e2adc8' : '#d39fc0');
    }
    // the ground: for each pixel, find the spot on the ground it shows
    for (let y = y0; y < H; y++) {
      const z = CAM_H * f / (y - y0 + 0.5);
      const fog = clamp((z - 7) / 26, 0, 0.6);
      for (let x = 0; x < W; x++) {
        const wx = (x + 0.5 - W / 2) * z / f;
        p.set(x, y, dither(x, y) < fog ? '#f2c4b6' : ground(wx, z));
      }
    }
    // houses across the street
    const k = f / 22, gy = y0 + CAM_H * k;
    const X = x => W / 2 + x * k, Y = h => gy - h * k;
    const win = (cx, top, w, h) => {
      p.rect(cx - w / 2, top, w, h, '#fffaf2');
      p.rect(cx - w / 2 + 1, top + 1, w - 2, h - 2, '#ffe39a');
      p.rect(Math.round(cx) - 0.5, top, 1, h, '#fffaf2');
    };
    [[-12.5, -7.3, 3.4, 2.2, '#f5b6c1', '#e39aa8', '#c76a80', '#9e4f66', '#8a5a72'],
     [-6.6, -1.4, 4.0, 1.9, '#f8dc98', '#e8c47a', '#d98a5f', '#b06a45', '#7a8fc9'],
     [-0.7, 4.9, 3.3, 2.4, '#acdcc6', '#8fc6ad', '#5f9a9a', '#467a7c', '#c7687e'],
     [5.6, 11.8, 3.8, 2.1, '#b0c2f0', '#94a8de', '#6b77c6', '#525ca3', '#e5a15a']]
      .forEach(([xa, xb, hw, hr, wall, shade, roof, roofDark, door]) => {
        const x0 = Math.round(X(xa)), x1 = Math.round(X(xb)), yt = Math.round(Y(hw)), yb = Math.round(gy);
        p.rect(x0, yt, x1 - x0, yb - yt, wall);
        p.rect(x1 - 2, yt, 2, yb - yt, shade);
        p.poly([[x0 - 2, yt + 1], [x1 + 2, yt + 1], [(x0 + x1) / 2, Y(hw + hr)]], roof);
        p.rect(x0 - 2, yt, x1 - x0 + 4, 1, roofDark);
        for (const wx of [xa + 1.3, xb - 1.3]) win(X(wx), Y(2.5), 1.1 * k, 1.1 * k);
        p.rect(X((xa + xb) / 2) - 0.5 * k, Y(2.0), k, 2 * k, door);
        p.set(X((xa + xb) / 2) + 0.25 * k, Y(1.0), '#ffe39a');
      });
    return p.canvas();
  }

  // Each thing standing in the yard is its own transparent layer, so the
  // postman can be drawn in front of or behind it depending on where he is.
  function fenceLayer() {
    const p = pix(W, H), z = 11.5, k = f / z, gy = project(0, 0, z)[1], top = h => gy - h * k;
    const white = '#fffaf4', shade = '#e5d5dd';
    for (const side of [-1, 1]) {
      const post = W / 2 + side * 0.8 * k;
      for (const h of [0.3, 0.68]) p.rect(side < 0 ? 0 : post, top(h), side < 0 ? post : W - post, Math.max(1, 0.06 * k), '#eadfe6');
      for (let x = 1.05; x < 13; x += 0.3) {
        const sx = W / 2 + side * x * k, pw = Math.max(1, Math.round(0.11 * k));
        p.rect(sx - pw / 2, top(0.9), pw, 0.9 * k, white);
        if (pw > 1) p.rect(sx + pw / 2 - 1, top(0.9), 1, 0.9 * k, shade);
        p.set(sx, top(0.9) - 1, white);
      }
      const pw = Math.max(2, Math.round(0.18 * k));
      p.rect(post - pw / 2, top(1.1), pw, 1.1 * k, white);
      p.rect(post - pw / 2 - 1, top(1.1) - 1, pw + 2, 2, shade);
    }
    // mailbox by the gate, flag up
    const mx = W / 2 + 1.5 * k;
    p.rect(mx - 0.05 * k, top(1.0), Math.max(1, 0.1 * k), 1.0 * k, '#9a6a4c');
    p.rect(mx - 0.25 * k, top(1.3), 0.5 * k, 0.3 * k, '#e8606f');
    p.rect(mx - 0.25 * k, top(1.3) + 0.3 * k - 1, 0.5 * k, 1, '#b8435a');
    p.rect(mx + 0.25 * k, top(1.5), 1, 0.25 * k, '#f6c84f');
    p.rect(mx + 0.25 * k + 1, top(1.5), 2, 2, '#f6c84f');
    return { z, canvas: p.canvas() };
  }
  function shadow(p, x, z, rx, hex) {
    const [sx, sy] = project(x, 0, z), k = f / z, ry = Math.max(1, 0.35 * rx * CAM_H * f / (z * z));
    for (let dy = -ry; dy <= ry; dy++) {
      const hw = rx * k * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2));
      p.rect(sx - hw, sy + dy, hw * 2, 1, hex);
    }
  }
  function treeLayer(x, z, kind) {
    const p = pix(W, H), k = f / z, [sx, sy] = project(x, 0, z);
    shadow(p, x, z, 1.4, '#6cb85f');
    p.rect(sx - 0.15 * k, sy - 2 * k, 0.3 * k, 2 * k, '#8a5a44');
    p.rect(sx, sy - 2 * k, 0.15 * k, 2 * k, '#6e4433');
    const pal = kind === 'blossom' ? ['#d9799c', '#f3a1bf', '#ffc9dc', '#fff0f5'] : ['#3f8a55', '#5cab62', '#86cc74', '#b8e89a'];
    blob(p, sx, sy - 2.7 * k, 1.4 * k, [[0, 0, 1], [-0.6, 0.25, 0.68], [0.62, 0.2, 0.7], [-0.25, -0.55, 0.7], [0.35, -0.5, 0.62]], pal);
    return { z, canvas: p.canvas() };
  }
  function bushLayer(x, z, flowers) {
    const p = pix(W, H), k = f / z, [sx, sy] = project(x, 0, z);
    shadow(p, x, z, 0.6, '#6cb85f');
    blob(p, sx, sy - 0.4 * k, 0.5 * k, [[0, 0, 1], [-0.6, 0.25, 0.7], [0.6, 0.25, 0.7]], ['#4f9a5a', flowers[1], flowers[2], flowers[3]], sy);
    return { z, canvas: p.canvas() };
  }
  function plantLayer() {   // a potted plant on the porch, just left of you
    const z = 1.45, p = pix(W, H), k = f / z, [sx, sy] = project(-0.62, 0, z);
    const pw = 0.26 * k, ph = 0.22 * k;
    p.poly([[sx - pw / 2, sy - ph], [sx + pw / 2, sy - ph], [sx + pw * 0.38, sy], [sx - pw * 0.38, sy]], '#d17a54');
    p.rect(sx + pw * 0.12, sy - ph, pw * 0.38, ph, '#b8613f');
    p.rect(sx - pw / 2 - 1, sy - ph - 0.05 * k, pw + 2, 0.05 * k, '#e8946a');
    blob(p, sx, sy - ph - 0.16 * k, 0.2 * k, [[0, 0, 1], [-0.7, 0.3, 0.6], [0.7, 0.25, 0.6], [0.1, -0.7, 0.55]],
      ['#3f8a55', '#5cab62', '#86cc74', '#b8e89a'], sy - ph);
    return { z, canvas: p.canvas() };
  }
  function doorLayer() {    // the door frame you're standing in
    const p = pix(W, H), t = 7;
    for (const x0 of [0, W - t]) { p.rect(x0, 0, t, H, '#a96a43'); p.rect(x0 ? x0 : t - 1, 0, 1, H, '#cf8f5f'); p.rect(x0 ? W - 1 : 0, 0, 1, H, '#76452a'); }
    p.rect(0, 0, W, 6, '#a96a43'); p.rect(t, 5, W - 2 * t, 1, '#cf8f5f'); p.rect(0, 0, W, 1, '#76452a');
    return { z: 0.05, canvas: p.canvas() };
  }

  // ---- per-frame drawing ----

  function envRect() {      // where the held letter is, in low-res pixels
    const z = st.z - 0.18, k = f / z, [cx, cy] = project(0, 0.95 + st.hopY, z);
    const w = 0.42 * k, h = w * ENV_H / ENV_W, u = POSTMAN_M / SPRITE_H * f / st.z;
    return { x: cx - w / 2, y: cy - h / 2 - st.bob * u, w, h };
  }
  function drawPostman() {
    const k = f / st.z, [sx, sy] = project(0, 0, st.z), u = POSTMAN_M / SPRITE_H * k;
    ctx.fillStyle = 'rgba(58,36,64,0.2)';
    const rx = 0.42 * k, ry = Math.max(1, 0.15 * CAM_H * f / st.z ** 2);
    for (let dy = -ry; dy <= ry; dy++) {
      const hw = rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2));
      ctx.fillRect(Math.round(sx - hw), Math.round(sy + dy), Math.round(hw * 2), 1);
    }
    const dw = Math.round(SPRITE_W * u), dh = Math.round(SPRITE_H * u);
    ctx.drawImage(frames[st.frame], Math.round(sx - dw / 2), Math.round(sy - dh - st.bob * u - st.hopY * k), dw, dh);
    if (st.holding && !st.envGone) {
      const r = envRect();
      ctx.drawImage(env, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
    }
  }
  function drawPetals(dt, now) {
    for (const pt of petals) {
      pt.y += pt.v * dt; pt.x += Math.sin(now / 900 + pt.ph) * 4 * dt + 3 * dt;
      if (pt.y > H) { pt.y = -2; pt.x = Math.random() * W; }
      if (pt.x > W) pt.x -= W;
      ctx.fillStyle = pt.big ? '#f3a1bf' : '#ffd6e4';
      ctx.fillRect(Math.round(pt.x), Math.round(pt.y), pt.big ? 2 : 1, 1);
    }
  }
  function tick(now) {
    if (!st.running) return;
    const dt = Math.min(0.05, (now - (st.last || now)) / 1000);
    st.last = now;
    if (walk) {
      const t = clamp((now - walk.t0) / walk.ms, 0, 1);   // rAF's clock can start a hair before t0
      st.z = Z_START + (Z_STOP - Z_START) * (1 - (1 - t) ** 1.8);
      const phase = mod(Math.floor((Z_START - st.z) / 0.28), 4);
      st.frame = ['walkA', 'stand', 'walkB', 'stand'][phase];
      st.bob = phase % 2;
      if (t >= 1) { const done = walk.resolve; walk = null; done(); }
    } else {
      st.frame = st.holding ? 'hold' : 'stand';
      st.bob = Math.floor(now / 800) % 2 ? 0 : 0.5;
    }
    const ht = (now - st.hopT) / 380;
    st.hopY = ht >= 0 && ht < 1 ? Math.sin(Math.PI * ht) * 0.07 : 0;
    if (!bg) { layout(); if (!bg) return requestAnimationFrame(tick); }

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bg, 0, 0);
    const items = layers.map(l => [l.z, () => ctx.drawImage(l.canvas, 0, 0)]);
    items.push([st.z, drawPostman], [0.5, () => drawPetals(dt, now)]);
    items.sort((a, b) => b[0] - a[0]).forEach(([, draw]) => draw());
    requestAnimationFrame(tick);
  }

  return {
    start() {
      layout();
      addEventListener('resize', layout);
      st.running = true;
      requestAnimationFrame(tick);
    },
    stop() { st.running = false; removeEventListener('resize', layout); },
    walkIn(ms) {
      if (!ms) { st.z = Z_STOP; return Promise.resolve(); }
      return new Promise(resolve => { walk = { t0: performance.now(), ms, resolve }; });
    },
    holdLetter() { st.holding = true; st.hopT = performance.now(); },
    hideLetter() { st.envGone = true; },
    // Where the top of the postman's cap is, in CSS pixels relative to the canvas (for the summon button).
    postmanTop() {
      if (!f) return null;
      const [sx, sy] = project(0, 0, st.z), u = POSTMAN_M / SPRITE_H * f / st.z;
      return { x: sx * scale, y: (sy - SPRITE_H * u) * scale };
    },
    // The held letter's box in CSS pixels, relative to the canvas, for the hand-off.
    letterRect() { const r = envRect(); return { left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }; },
  };
}
