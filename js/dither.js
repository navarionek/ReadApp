import { einkEnabled } from './eink.js';

/* ----------------- Okładki pod e-ink ----------------- */
// W trybie czytnika okładki są przerabiane na 4 odcienie szarości z rozpraszaniem błędu (Floyd–Steinberg)
// i rozciągnięciem kontrastu, w rozdzielczości ekranu. Zwykła szarość wychodzi na e-ink płaska i ciemna,
// a tak widać szczegóły. Okładki z obcych serwerów bez nagłówków CORS (stare wpisy z Google) zostają bez
// zmian, bo przeglądarka nie pozwala odczytać ich pikseli.
const LEVELS = 4;
const MIN_WIDTH = 96;
const MAX_WIDTH = 480;
const PARALLEL = 2;
const results = new Map();  // adres|szerokość → adres przerobionego obrazka albo null (się nie da)
const waiting = [];
let working = 0;
let observer = null;
let scanTimer = null;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Szarość 0..255 z rozciągnięciem kontrastu (odcięte skrajne 1,5% pikseli), potem Floyd–Steinberg do LEVELS odcieni
function ditherPixels(rgba, w, h) {
  const gray = new Float32Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    const v = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    gray[i] = v;
    hist[Math.round(v)]++;
  }
  const cut = gray.length * 0.015;
  let lo = 0;
  let hi = 255;
  for (let sum = 0; lo < 255 && (sum += hist[lo]) < cut; lo++);
  for (let sum = 0; hi > 0 && (sum += hist[hi]) < cut; hi--);
  const span = Math.max(1, hi - lo);

  const step = 255 / (LEVELS - 1);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.min(255, Math.max(0, ((gray[i] - lo) / span) * 255));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = gray[i];
      const q = Math.round(old / step) * step;
      const err = old - q;
      gray[i] = q;
      if (x + 1 < w) gray[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += (err * 3) / 16;
        gray[i + w] += (err * 5) / 16;
        if (x + 1 < w) gray[i + w + 1] += err / 16;
      }
    }
  }
  for (let i = 0; i < gray.length; i++) {
    const v = Math.min(255, Math.max(0, Math.round(gray[i])));
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
}

async function render(src, width) {
  const key = `${src}|${width}`;
  if (results.has(key)) return results.get(key);
  let url = null;
  try {
    const im = await loadImage(src);
    const height = Math.round((width * im.naturalHeight) / im.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);  // rzuca dla obrazków bez CORS
    ditherPixels(pixels.data, width, height);
    ctx.putImageData(pixels, 0, 0);
    url = canvas.toDataURL('image/png');
  } catch {
    url = null;
  }
  results.set(key, url);
  return url;
}

async function process(img) {
  const src = img.getAttribute('src');
  if (!src || src.startsWith('data:')) return;
  const cssWidth = img.clientWidth || img.parentElement?.clientWidth || 120;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(cssWidth * (window.devicePixelRatio || 1))));
  const url = await render(src, width);
  // Tryb mógł się wyłączyć albo obrazek zmienić w trakcie przetwarzania
  if (!url || !einkEnabled() || !img.isConnected || img.getAttribute('src') !== src) return;
  img.dataset.orig = src;
  img.dataset.dithered = '1';
  img.src = url;
}

async function pump() {
  while (working < PARALLEL && waiting.length) {
    const img = waiting.shift();
    working++;
    process(img).finally(() => {
      delete img.dataset.queued;
      working--;
      pump();
    });
  }
}

function scan() {
  scanTimer = null;
  document.querySelectorAll('img.book-cover:not([data-dithered]):not([data-queued])').forEach(img => {
    img.dataset.queued = '1';
    waiting.push(img);
  });
  pump();
}

function scheduleScan() {
  if (scanTimer === null) scanTimer = setTimeout(scan, 60);
}

// Wołane przy starcie i po przełączeniu trybu czytnika: włącza śledzenie nowych okładek albo przywraca oryginały
export function syncCoverDither() {
  if (einkEnabled()) {
    if (!observer) {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    scan();
    return;
  }
  observer?.disconnect();
  observer = null;
  waiting.length = 0;
  document.querySelectorAll('img.book-cover[data-dithered]').forEach(img => {
    img.src = img.dataset.orig;
    delete img.dataset.dithered;
    delete img.dataset.orig;
  });
}
