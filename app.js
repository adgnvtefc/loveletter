// app.js: the reading flow.
//   1. the postman walks up and asks who the letter is from + the password
//   2. the envelope flies to you, everything else fades
//   3. slide across the dotted line to cut it open; the photos and paper peek out
//   4. swipe up to read

import { createScene, envelopeCanvas, scissorsCanvas, patternURL, ENV_W, ENV_H, CUT_ROW } from './scene.js';
import { openLetter } from './store.js';
import { demoLetter } from './demo.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), contents = $('contents'), wrap = $('envWrap');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

document.body.style.background = `url(${patternURL()}) repeat, var(--bg)`;
const scene = createScene($('scene'));

let phase = 'greet';   // greet → fly → cut → opening → preview → read
let letter = null;

// ---------- the postman talks ----------

let skipTyping = null;
function say(text) {
  const el = $('say');
  skipTyping?.();
  return new Promise(resolve => {
    let i = 0, timer = 0;
    const finish = () => { clearInterval(timer); el.textContent = text; skipTyping = null; resolve(); };
    skipTyping = finish;
    if (reduce) return finish();
    timer = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) finish(); }, 30);
  });
}
$('dialog').addEventListener('click', e => { if (!e.target.closest('form')) skipTyping?.(); });

async function tapToContinue() {
  $('more').hidden = false;
  await wait(0);   // so the tap that skipped the typing doesn't also count as this one
  return new Promise(resolve => stage.addEventListener('click', () => { $('more').hidden = true; resolve(); }, { once: true }));
}

async function greet() {
  scene.start();
  await scene.walkIn(reduce ? 0 : 4800);
  await wait(250);
  $('dialog').hidden = false;
  await say('hey, you have a letter!');
  await tapToContinue();
  await say('can i confirm some details first?');
  $('details').hidden = false;
  if (matchMedia('(pointer: fine)').matches) $('sender').focus();
}

$('details').addEventListener('submit', async e => {
  e.preventDefault();
  const sender = $('sender').value, password = $('password').value;
  if (!sender.trim()) return say("who's it from? i need a name.");
  if (!password.trim()) return say('and the password?');
  for (const el of $('details').elements) el.disabled = true;
  document.activeElement?.blur();
  say('one sec, let me check my bag…');
  const lookup = Promise.resolve(demoLetter(sender, password) ?? openLetter(sender, password)).catch(() => 'closed');
  const [found] = await Promise.all([lookup, wait(1100)]);
  if (!found || found === 'closed') {
    for (const el of $('details').elements) el.disabled = false;
    return say(found === 'closed'
      ? "oh no, i can't reach the post office right now. try again in a bit?"
      : `hmm… nothing from "${sender.trim()}" with that password. try again?`);
  }
  letter = found;
  $('details').hidden = true;
  $('writeLink').hidden = true;
  scene.holdLetter();
  await say('here you go ♥');
  await wait(900);
  $('dialog').hidden = true;
  handOff();
});

// ---------- the envelope flies to you ----------

let S = 6;   // CSS pixels per envelope pixel

function drawEnvelope(cut) {
  const full = envelopeCanvas({ dashes: true, cut });
  const strip = $('envStrip').getContext('2d'), body = $('envBody').getContext('2d');
  strip.clearRect(0, 0, ENV_W, CUT_ROW);
  strip.drawImage(full, 0, 0, ENV_W, CUT_ROW, 0, 0, ENV_W, CUT_ROW);
  body.clearRect(0, 0, ENV_W, ENV_H - CUT_ROW);
  body.drawImage(full, 0, CUT_ROW, ENV_W, ENV_H - CUT_ROW, 0, 0, ENV_W, ENV_H - CUT_ROW);
}

// A photo shrunk to a few pixels wide: how it looks peeking out of the envelope.
async function pixelated(src, width) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.max(1, Math.round(width * img.naturalHeight / img.naturalWidth));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

async function buildEnvelope() {
  S = Math.max(3, Math.floor(Math.min(stage.clientWidth * 0.84 / ENV_W, stage.clientHeight * 0.42 / ENV_H)));
  Object.assign(wrap.style, { width: ENV_W * S + 'px', height: ENV_H * S + 'px', marginLeft: -ENV_W * S / 2 + 'px', marginTop: -ENV_H * S / 2 + 'px' });
  wrap.style.setProperty('--s', S + 'px');
  $('envStrip').width = ENV_W; $('envStrip').height = CUT_ROW;
  $('envBody').width = ENV_W; $('envBody').height = ENV_H - CUT_ROW;
  drawEnvelope(null);
  const sc = $('scissors'), art = scissorsCanvas();
  sc.width = art.width; sc.height = art.height;
  sc.getContext('2d').drawImage(art, 0, 0);
  placeScissors(1, 1);

  const paper = document.createElement('div');
  paper.className = 'paper-peek';
  const peeks = await Promise.all(letter.photos.slice(0, 2).map(async (src, i) => {
    const fig = document.createElement('div');
    fig.className = 'polaroid-peek';
    fig.style.setProperty('--tilt', i ? '7deg' : '-4deg');
    fig.style.setProperty('--shift', i ? '14%' : '0%');
    fig.append(await pixelated(src, 18));
    return fig;
  }));
  contents.replaceChildren(paper, ...peeks.reverse());
}

async function handOff() {
  phase = 'fly';
  await buildEnvelope();
  $('openView').hidden = false;
  const from = scene.letterRect(), stageBox = stage.getBoundingClientRect(), box = wrap.getBoundingClientRect();
  const to = { left: box.left - stageBox.left, top: box.top - stageBox.top, width: box.width };
  const s = from.width / to.width, dx = from.left - to.left, dy = from.top - to.top;
  scene.hideLetter();
  $('scene').classList.add('gone');
  await wrap.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
    { transform: `translate(${dx * 0.35}px, ${dy * 0.35 - 40}px) scale(${0.55 + s * 0.45}) rotate(-7deg)`, offset: 0.55 },
    { transform: 'none' },
  ], { duration: reduce ? 1 : 1000, easing: 'cubic-bezier(.45,0,.25,1)' }).finished;
  setTimeout(() => scene.stop(), 600);
  phase = 'cut';
  hint('slide along the dotted line to open ✂');
}

// ---------- cut it open ----------

let cut = null, cutting = false, dir = 1;

function placeScissors(x, d) {
  const sc = $('scissors');
  sc.style.left = (x * S - 3.5 * S) + 'px';   // the scissors are 7 envelope-pixels wide (see style.css)
  sc.style.transform = d < 0 ? 'scaleX(-1)' : 'none';
}

function cutTo(x) {
  x = clamp(Math.round(x), 1, ENV_W - 2);
  if (!cut) cut = [x, x];
  else {
    if (x < cut[0]) dir = -1; else if (x > cut[1]) dir = 1;
    cut = [Math.min(cut[0], x), Math.max(cut[1], x)];
  }
  drawEnvelope(cut);
  placeScissors(x, dir);
  $('scissors').classList.remove('wiggle');
  if (cut[1] - cut[0] >= ENV_W - 9) finishCut();
}

function cutAt(e) {
  const r = $('envBody').getBoundingClientRect();
  cutTo((e.clientX - r.left) / r.width * ENV_W);
}

async function finishCut() {
  phase = 'opening';
  cutting = false;
  drawEnvelope([1, ENV_W - 2]);
  navigator.vibrate?.(12);
  hint('');
  $('scissors').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });
  $('envStrip').animate([
    { transform: 'none', opacity: 1 },
    { transform: 'translate(-14%, -260%) rotate(-12deg)', opacity: 0 },
  ], { duration: 750, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
  await wait(300);
  await riseTo(15 * S, 700, 'cubic-bezier(.2,1.3,.4,1)');
  phase = 'preview';
  hint('swipe up to read ↑');
}

// ---------- swipe up to read ----------

let risen = 0, swipe = null;
function setRise(px) { risen = px; contents.style.transform = `translateY(${-px}px)`; }
function riseTo(px, ms, easing) {
  const from = risen;
  setRise(px);
  return contents.animate([{ transform: `translateY(${-from}px)` }, { transform: `translateY(${-px}px)` }], { duration: reduce ? 1 : ms, easing }).finished;
}

stage.addEventListener('pointerdown', e => {
  if (phase === 'cut' && !e.target.closest('.hint')) { cutting = true; stage.setPointerCapture(e.pointerId); cutAt(e); }
  else if (phase === 'preview' && !e.target.closest('.hint')) { swipe = { y: e.clientY, dy: 0 }; stage.setPointerCapture(e.pointerId); }
});
stage.addEventListener('pointermove', e => {
  if (phase === 'cut' && cutting) cutAt(e);
  else if (phase === 'preview' && swipe) {
    swipe.dy = Math.min(0, e.clientY - swipe.y);
    setRise(15 * S - swipe.dy * 0.9);
  }
});
const release = () => {
  cutting = false;
  if (phase !== 'preview' || !swipe) return;
  if (swipe.dy < -50) read();
  else riseTo(15 * S, 300, 'cubic-bezier(.2,1.3,.4,1)');
  swipe = null;
};
stage.addEventListener('pointerup', release);
stage.addEventListener('pointercancel', release);

// The hint doubles as a button, for anyone who can't drag.
function hint(text) { $('hint').textContent = text; }
$('hint').addEventListener('click', async () => {
  if (phase === 'cut') {
    for (let x = cut ? cut[1] : 1; phase === 'cut' && x < ENV_W - 1; x += 2) { cutTo(x); await wait(16); }
  } else if (phase === 'preview') read();
});

async function read() {
  phase = 'read';
  hint('');
  const h = stage.clientHeight;
  contents.animate([{ transform: `translateY(${-risen}px)` }, { transform: `translateY(${-risen - h}px)` }],
    { duration: 650, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
  await $('envBody').animate([{ transform: 'none' }, { transform: `translateY(${h}px)` }],
    { duration: 650, delay: 120, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' }).finished;
  $('openView').hidden = true;
  showLetter();
}

// ---------- the letter ----------

// Photos "develop": they start as a few big pixels and sharpen into the real picture.
async function develop(fig, src, delay) {
  const img = new Image();
  img.src = src;
  img.alt = '';
  await img.decode();
  if (img.naturalWidth > img.naturalHeight * 1.6) fig.classList.add('wide');
  const c = document.createElement('canvas');
  c.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
  fig.replaceChildren(c);
  const steps = reduce ? [] : [5, 9, 16, 28, 48, 90];
  for (const [i, w] of steps.entries()) {
    c.width = w; c.height = Math.max(1, Math.round(w * img.naturalHeight / img.naturalWidth));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    await wait(i ? 150 : delay);
  }
  fig.replaceChildren(img);
}

function showLetter() {
  $('readView').hidden = false;
  $('photos').replaceChildren(...letter.photos.map((src, i) => {
    const fig = document.createElement('figure');
    fig.className = 'polaroid';
    fig.style.setProperty('--tilt', (i % 2 ? 2.5 : -2.5) + 'deg');
    fig.style.animationDelay = i * 0.2 + 's';
    develop(fig, src, 300 + i * 250);
    fig.addEventListener('click', () => { $('lightboxImg').src = src; $('lightbox').hidden = false; });
    return fig;
  }));
  $('letterText').textContent = letter.message;
  $('sig').textContent = letter.sender;
}

$('again').addEventListener('click', () => location.reload());
$('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });

greet();
