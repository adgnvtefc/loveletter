// demo.js: one sample letter, so there's something to open before anyone writes one.
// It is built in the page and never stored anywhere.
// From "billy", password "hello". Its two photos are drawn in code.

import { pix, bands, hash, dither, INK } from './scene.js';
import { normalize } from './store.js';

export const DEMO = { sender: 'billy', password: 'hello' };

const MESSAGE = `hi you,

this is the very first letter in the box. the postman walked all the way up the path for it, so be nice to him.

some days are long and some are short, but there will always be one of these waiting at the door.

see you tomorrow ♥`;

function upscale(p, by = 6) {
  const src = p.canvas(), c = document.createElement('canvas');
  c.width = p.w * by; c.height = p.h * by;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function sunset() {
  const p = pix(64, 48);
  bands(p, ['#8d8fe0', '#c39be0', '#f2a7c0', '#ffc2a0', '#ffdc9e'], 0, 27);
  for (let y = 18; y < 27; y++) for (let x = 32; x < 49; x++) if ((x - 40.5) ** 2 + (y - 26.5) ** 2 < 64) p.set(x, y, '#fff1c2');
  for (let y = 27; y < 37; y++) for (let x = 0; x < 64; x++) {
    const glint = Math.abs(x - 40.5) < 8 - (y - 27) * 0.5 && (x + y * 2) % 4 === 0;
    p.set(x, y, glint ? '#ffe3a8' : y % 3 === 0 ? '#7b88d6' : '#6b78c8');
  }
  for (let y = 37; y < 48; y++) for (let x = 0; x < 64; x++) p.set(x, y, dither(x, y) < 0.25 ? '#e8c08f' : '#f3d3a8');
  // two little people holding hands, and a heart
  for (const x of [22, 27]) { p.rect(x, 30, 2, 2, INK); p.rect(x - 1, 32, 4, 4, INK); p.rect(x, 36, 1, 2, INK); p.rect(x + 2, 36, 1, 2, INK); }
  p.rect(25, 33, 2, 1, INK);
  p.sprite(['r.r', 'rrr', '.r.'], { r: '#ff7f9e' }, 24, 26);
  return upscale(p);
}

function night() {
  const p = pix(64, 48);
  bands(p, ['#1f2350', '#2d3170', '#3e3f8a', '#5a4f9a'], 0, 48);
  for (let i = 0; i < 40; i++) p.set(hash(i, 1) * 64, hash(i, 2) * 30, hash(i, 3) < 0.3 ? '#ffffff' : '#fff6d6');
  for (let y = 4; y < 20; y++) for (let x = 40; x < 56; x++)
    if ((x - 47.5) ** 2 + (y - 11.5) ** 2 < 36 && (x - 50.5) ** 2 + (y - 9.5) ** 2 >= 26) p.set(x, y, '#fff3c4');
  [[0, 14, 30, 6], [13, 12, 26, 5], [24, 18, 33, 7], [41, 12, 28, 6], [52, 14, 31, 6]].forEach(([x, w, top, roof]) => {
    p.poly([[x - 1, top], [x + w + 1, top], [x + w / 2, top - roof]], '#231c3d');
    p.rect(x, top, w, 48 - top, '#2a2244');
    for (let wy = top + 3; wy < 44; wy += 6) for (let wx = x + 2; wx < x + w - 3; wx += 5)
      if (hash(wx, wy) < 0.55) p.rect(wx, wy, 2, 3, '#ffd66e');
  });
  return upscale(p);
}

// The sample letter lives right here in the page, never on the server.
export function demoLetter(sender, password) {
  if (normalize(sender) !== DEMO.sender || normalize(password) !== DEMO.password) return null;
  return { sender: DEMO.sender, message: MESSAGE, photos: [sunset(), night()] };
}
