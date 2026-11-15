// creator.js: write a letter (name, password, photos, message) and seal it.

import { sealLetter, normalize, letterLink } from '../store.js';
import { DEMO } from '../demo.js';
import { envelopeCanvas, patternURL } from '../scene.js';
import { authHeaders, shelve, signedInAs } from '../account.js';
import { mountAccount } from '../shelf.js';

const $ = id => document.getElementById(id);
const MAX_PHOTOS = 4;
let photos = [];   // data URLs, already shrunk

document.body.style.background = `url(${patternURL()}) repeat, var(--bg)`;
// Re-reading happens on the front page, where the postman hands it over.
mountAccount(document.body, { onRead: id => { location.href = new URL(`../${location.search}#read=${id}`, location).href; } });
$('logo').append(envelopeCanvas());
$('sealedEnv').append(envelopeCanvas());

// ---------- photos ----------
// Real phone photos need care:
//  - rotation: iPhones often store a photo sideways plus an EXIF "rotate me" tag.
//    Decoding through <img> applies that tag in every current browser.
//  - HEIC: Apple's format. Safari decodes it (and iPhone Safari usually hands us a JPEG
//    anyway), but Chrome and Firefox can't. Only then do we fetch a HEIC decoder (~3 MB).
//  - size: a 12–48 MP photo is shrunk to 1280px on its longest side, in halving steps
//    so it stays sharp.
//  - colour: iPhone photos are wide-gamut (Display P3); we keep P3 where the browser can.

const MAX_SIDE = 1280;
const HEIC_DECODER = 'https://cdn.jsdelivr.net/npm/heic-to@1.6.6/dist/heic-to.js';

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('cannot decode')); };
    img.src = url;
  });
}

async function isHeic(file) {
  if (/image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name)) return true;
  const brand = new TextDecoder().decode(await file.slice(4, 12).arrayBuffer());
  return /^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand);
}

async function decode(file) {
  try { return await loadImage(file); }
  catch (err) {
    if (!(await isHeic(file))) throw err;
    const { heicTo } = await import(HEIC_DECODER);
    return heicTo({ blob: file, type: 'bitmap' });
  }
}

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { colorSpace: 'display-p3' }) || c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
}

async function shrink(file) {
  const src = await decode(file);
  let w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, from = src;
  const s = Math.min(1, MAX_SIDE / Math.max(w, h)), tw = Math.round(w * s), th = Math.round(h * s);
  while (w / 2 >= tw * 1.5) {        // halve until close, then one final resize
    w = Math.round(w / 2); h = Math.round(h / 2);
    const [c, ctx] = canvas2d(w, h);
    ctx.drawImage(from, 0, 0, w, h);
    from = c;
  }
  const [c, ctx] = canvas2d(tw, th);
  ctx.drawImage(from, 0, 0, tw, th);
  src.close?.();
  return c.toDataURL('image/jpeg', 0.85);
}

function renderThumbs() {
  $('thumbs').replaceChildren(...photos.map((src, i) => {
    const fig = document.createElement('div'), img = new Image(), x = document.createElement('button');
    fig.className = 'thumb';
    img.src = src; img.alt = `photo ${i + 1}`;
    x.type = 'button'; x.textContent = '×'; x.ariaLabel = `remove photo ${i + 1}`;
    x.onclick = () => { photos.splice(i, 1); renderThumbs(); };
    fig.append(img, x);
    return fig;
  }));
  $('pick').closest('label').hidden = photos.length >= MAX_PHOTOS;
}

$('pick').addEventListener('change', async e => {
  const files = [...e.target.files].slice(0, MAX_PHOTOS - photos.length);
  e.target.value = '';
  showError('');
  const label = $('pick').closest('label'), text = label.lastChild;
  text.textContent = 'developing…';
  for (const file of files) {
    try { photos.push(await shrink(file)); renderThumbs(); }
    catch { showError(`couldn't open ${file.name}. try a jpeg or png?`); }
  }
  text.textContent = '+ add photos';
  renderThumbs();
});

function showError(text) { $('error').textContent = text; }

$('write').addEventListener('submit', async e => {
  e.preventDefault();
  const sender = $('sender').value.trim(), password = $('password').value.trim(), message = $('message').value.trim();
  if (!message && !photos.length) return showError('add a photo or write something first.');
  if (normalize(sender) === DEMO.sender && normalize(password) === DEMO.password) return showError("that's the sample letter's password. pick another one.");
  showError('');
  $('seal').disabled = true;
  $('seal').textContent = 'sealing…';
  const sealed = await sealLetter({ sender, password, message, photos }, authHeaders()).catch(() => ({ status: 'closed' }));
  const result = sealed.status;
  if (result === 'ok') await shelve(sealed.id, sealed.keyBytes, { sender, message, photos });   // signed in: onto your shelf
  $('seal').disabled = false;
  $('seal').textContent = 'seal it ♥';
  const problem = {
    taken: "you've already sealed a letter with this name and password. pick another password.",
    'too-big': 'this letter is too heavy to post. try fewer photos.',
    busy: 'the post office is swamped. try again in a little while.',
    full: "the post office is full. that's on us, sorry!",
    closed: "couldn't reach the post office. check your connection and try again.",
    error: 'something went wrong sealing it. try again?',
  }[result];
  if (problem) return showError(problem);

  const link = letterLink(new URL(`../${location.search}`, location).href, sealed.id, sealed.keyBytes);
  $('sendText').textContent = 'Hi! You have a letter! You can click on the link to view, or enter the "from" and password.'
    + `\n\n${link}\n\nfrom: ${sender}\npassword: ${password}`;
  $('onShelf').hidden = !signedInAs();
  $('write').hidden = true;
  $('sealed').hidden = false;
  scrollTo(0, 0);
});

// The message: the link opens the letter with no name or password (its key rides after the #,
// which browsers never send); the "from" + password open it through the postman instead.
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('sendText').textContent); $('copy').textContent = 'copied ♥'; }
  catch { $('copy').textContent = "couldn't copy"; }
  setTimeout(() => { $('copy').textContent = 'copy'; }, 1600);
});

// Back to home: the yard, with the postman waiting at the gate (keeps ?office= while testing locally).
$('home').href = new URL(`../${location.search}#home`, location).href;

$('another').addEventListener('click', () => {
  $('write').reset();
  photos = [];
  renderThumbs();
  $('sealed').hidden = true;
  $('write').hidden = false;
});
