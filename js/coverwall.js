import { coverEl } from './shelf.js';
import { state } from './state.js';
import { el } from './ui.js';

/* ----------------- Ściana okładek ----------------- */
// Okładki w kolumnach na cały ekran, kolumny na zmianę jadą w górę i w dół, każda w swoim
// tempie. Kolumna to pasek okładek powtórzony dwa razy, przesuwany animacją CSS o połowę
// swojej wysokości: pętla bez przeskoku. Na TV to wygaszacz, na telefonie tło ekranu Start.

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Okładka jako kafelek ściany; kafelki wjeżdżają w kadr ruchem, nie przewijaniem, więc bez lazy
export function wallCover(book) {
  const cover = coverEl(book);
  if (cover.tagName === 'IMG') cover.loading = 'eager';
  return cover;
}

// Wymiary w pikselach: tile = szerokość okładki, speed = [min, max] px/s
export function buildCoverWall(books, { width, height, tile, gap, speed, tileEl }) {
  const tileH = tile * 1.5 + gap;  // okładka 2:3 + odstęp
  // Ściana jest lekko obrócona i powiększona, więc kolumn i kafelków potrzeba z zapasem
  const cols = Math.ceil((width * 1.35) / (tile + gap)) + 1;
  const perColumn = Math.ceil((height * 1.5) / tileH) + 1;
  // Każda kolumna dostaje własny losowy wybór (nie wszystkie okładki), żeby nie było na ekranie
  // tysiąca obrazków; z zapasem na kilka ekranów, żeby pętla się nie rzucała w oczy
  const take = Math.max(perColumn + 2, Math.min(books.length, perColumn * 2));
  const columns = Array.from({ length: cols }, (_, c) => {
    let list = shuffle(books);
    while (list.length < take) list = list.concat(shuffle(books));
    list = list.slice(0, take);
    const strip = el('div', { class: 'tv-wall-strip' }, [...list, ...list].map(tileEl));
    const loopS = (list.length * tileH) / (speed[0] + Math.random() * (speed[1] - speed[0]));
    strip.style.animationDuration = `${loopS}s`;
    strip.style.animationDelay = `${-Math.random() * loopS}s`;  // każda kolumna startuje w innym miejscu
    return el('div', { class: `tv-wall-col${c % 2 ? ' down' : ''}` }, [strip]);
  });
  const wall = el('div', { class: 'tv-wall' }, columns);
  wall.style.setProperty('--tile', `${tile}px`);
  wall.style.setProperty('--gap', `${gap}px`);
  return wall;
}

/* ----- Tło ekranu Start (telefon i komputer) ----- */
// Przygaszona ściana z okładek tego roku i tych czytanych teraz. Widać ją tylko na Starcie
// (pilnuje tego CSS), poza nim display: none, więc animacja nic nie kosztuje.
// Eksperyment: można go wyłączyć w ustawieniach (zapamiętane na tym urządzeniu).
const STORAGE_KEY = 'coverBg';
const CACHE_KEY = 'coverBgBooks';  // okładki z ostatniego razu: intro rusza, zanim dojdą dane
let startSig = null;
let intro = null;                  // trwa intro; przebudowę ściany odkładamy na jego koniec
let introPlayed = false;           // tylko raz po włączeniu apki
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

export function startWallEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function syncStartWallToggle() {
  const on = startWallEnabled();
  document.getElementById('cover-bg-toggle')?.setAttribute('aria-checked', String(on));
  document.getElementById('cover-bg-switch')?.classList.toggle('on', on);
}

export function toggleStartWall() {
  const on = !startWallEnabled();
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {}
  syncStartWallToggle();
  startSig = null;
  renderStartWall();
}

export function renderStartWall() {
  if (!startWallEnabled()) {
    document.getElementById('cover-bg')?.remove();
    startSig = null;
    return;
  }
  if (intro) {
    intro.pending = true;
    return;
  }
  // Bez danych zostaje to, co jest (np. ściana z pamięci po intro), zamiast pustego tła
  if (!state.hasData) return;
  const all = [...state.statsRows, ...state.readingNow].map(r => ({ title: r.title, author: r.author, cover_url: r.cover_url }));
  // Same kolorowe zaślepki z tytułami robią w tle bałagan: jeśli okładek jest dość, tylko one
  const withCovers = all.filter(b => b.cover_url);
  const books = withCovers.length >= 6 ? withCovers : all;
  if (books.length) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(books.slice(-150)));
    } catch {}
  }
  mountStartWall(books);
}

function mountStartWall(books) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Wysokość zmienia się na telefonie przy chowaniu paska adresu; ściana ma zapas, więc liczy się szerokość
  const sig = `${width}|${books.map(b => `${b.title}|${b.cover_url}`).join('~')}`;
  if (sig === startSig) return;
  startSig = sig;
  let bg = document.getElementById('cover-bg');
  if (!books.length) {
    bg?.remove();
    return;
  }
  if (!bg) {
    bg = el('div', { id: 'cover-bg', class: 'cover-bg', 'aria-hidden': 'true' });
    document.body.prepend(bg);
  }
  // Drobne okładki, dużo kolumn: bardziej faktura niż pojedyncze książki
  const tile = Math.max(58, Math.min(100, Math.min(width, height) * 0.17));
  bg.replaceChildren(buildCoverWall(books, {
    width,
    height,
    tile,
    gap: tile * 0.1,
    speed: [tile * 0.08, tile * 0.16],
    tileEl: b => el('div', { class: 'tv-wall-tile' }, [wallCover(b)]),
  }));
}

/* ----- Intro po włączeniu apki ----- */
// Najpierw mnóstwo drobnych okładek (ściana z daleka), kamera przybliża się do zwykłego
// rozmiaru tła, a kolumny w tym czasie rozpędzają się i hamują. Potem ściana gaśnie w tło,
// a karty wjeżdżają. Oddalona ściana to jeden canvas, bo tyle okładek w DOM (a zwłaszcza tak
// wielkie warstwy do przeskalowania) to za dużo dla telefonu; na koniec canvas przenika się
// ze zwykłą ścianą pod spodem. Okładki są z pamięci (z ostatniego razu), więc nie czekamy na dane.
const INTRO_ZOOM = 1150;   // przybliżanie
const INTRO_REVEAL = 700;  // ściana gaśnie w tło, wjeżdżają karty
const INTRO_FROM = 0.3;    // skala na starcie (ile razy mniejsze okładki niż w tle)
const INTRO_TO = 1.08;     // skala zwykłej ściany (.tv-wall)
const INTRO_PEAK = 22;     // ile razy szybciej niż zwykle jadą kolumny w połowie przybliżania

const cards = () => [...document.querySelectorAll('.screen[data-screen="start"] :is(.stat-card, .card, .goal-card, .prize-banner)')]
  .filter(card => card.offsetParent !== null);

const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

function shuffleIdx(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Oddalona ściana na canvasie: te same kolumny, obrót i odstępy co .tv-wall
function introCanvas(bg, books) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = el('canvas', { class: 'cover-intro' });
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  bg.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const bgColor = getComputedStyle(document.body).backgroundColor;
  const tile = Math.max(58, Math.min(100, Math.min(W, H) * 0.17));
  const gap = tile * 0.1;
  const tileH = tile * 1.5;
  const step = tileH + gap;
  // Kolumn tyle, żeby przy najmniejszej skali (i obrocie) wypełnić cały ekran
  const reach = Math.hypot(W, H) / 2 / INTRO_FROM;
  const cols = Math.ceil((reach * 2) / (tile + gap)) + 2;
  const images = new Map();
  const items = books.map(b => {
    let img = null;
    if (b.cover_url) {
      if (!images.has(b.cover_url)) {
        img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.src = b.cover_url;
        images.set(b.cover_url, img);
      }
      img = images.get(b.cover_url);
    }
    let h = 0;
    for (const ch of b.title || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
    return { img, color: `hsl(${h} 40% 32%)` };
  });
  const columns = Array.from({ length: cols }, (_, c) => ({
    x: (c - (cols - 1) / 2) * (tile + gap) - tile / 2,
    order: shuffleIdx(items.length),
    dir: c % 2 ? 1 : -1,                        // na zmianę w górę i w dół, jak w ścianie
    speed: tile * (0.08 + Math.random() * 0.08),  // px/s, jak zwykła ściana
    pos: Math.random() * items.length * step,
  }));

  return (scale, boost, dt) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.rotate((-7 * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 0.85;  // jak filtr przyciemnienia kafelków w ścianie
    const half = Math.hypot(W, H) / 2 / scale;
    const loop = items.length * step;
    columns.forEach(col => {
      col.pos = (col.pos + col.dir * col.speed * boost * dt / 1000 + loop) % loop;
      if (col.x + tile < -half || col.x > half) return;
      const first = Math.floor((-half - col.pos) / step);
      for (let j = first; j * step + col.pos < half; j++) {
        const it = items[col.order[((j % items.length) + items.length) % items.length]];
        const y = j * step + col.pos;
        if (it.img?.complete && it.img.naturalWidth) ctx.drawImage(it.img, col.x, y, tile, tileH);
        else {
          ctx.fillStyle = it.color;
          ctx.fillRect(col.x, y, tile, tileH);
        }
      }
    });
    ctx.globalAlpha = 1;
  };
}

export function playStartIntro() {
  if (introPlayed || !startWallEnabled() || calm.matches) return;
  introPlayed = true;
  let cached = [];
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY)) || [];
  } catch {}
  if (!cached.length) return;  // pierwsze uruchomienie: jeszcze nie znamy okładek
  mountStartWall(cached);
  const bg = document.getElementById('cover-bg');
  if (!bg) return;
  intro = { pending: false };
  const body = document.body;
  body.classList.add('wall-intro');
  const draw = introCanvas(bg, cached);
  const canvas = bg.querySelector('.cover-intro');
  let t0 = null;
  let prev = 0;
  let revealed = false;
  const step = now => {
    t0 ??= now;
    const t = now - t0;
    const dt = Math.min(50, now - (prev || now));
    prev = now;
    const z = Math.min(1, t / INTRO_ZOOM);
    if (!revealed) {
      // Przybliżanie z wygładzeniem; kolumny najszybciej w połowie drogi
      draw(INTRO_FROM + (INTRO_TO - INTRO_FROM) * easeInOut(z), 1 + (INTRO_PEAK - 1) * Math.sin(Math.PI * z) ** 2, dt);
    }
    if (t >= INTRO_ZOOM && !revealed) {
      revealed = true;
      // Canvas przenika się ze zwykłą ścianą, a karty wjeżdżają po kolei, od góry
      canvas.classList.add('gone');
      cards().forEach((card, i) => card.style.setProperty('--intro-delay', `${i * 0.04}s`));
      body.classList.replace('wall-intro', 'wall-intro-reveal');
    }
    if (t < INTRO_ZOOM + INTRO_REVEAL) {
      requestAnimationFrame(step);
      return;
    }
    canvas.remove();
    body.classList.remove('wall-intro-reveal');
    cards().forEach(card => card.style.removeProperty('--intro-delay'));
    const { pending } = intro;
    intro = null;
    if (pending) renderStartWall();
  };
  requestAnimationFrame(step);
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (startSig !== null && !document.documentElement.classList.contains('tv-mode')) renderStartWall();
  }, 300);
});
