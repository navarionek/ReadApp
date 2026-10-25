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
// Najpierw mnóstwo drobnych, pędzących okładek (ściana z daleka), kamera przybliża się do
// zwykłego rozmiaru tła, a kolumny w tym czasie hamują do zwykłego tempa. W połowie drogi
// karty już wjeżdżają, a na końcu ściana gaśnie w tło.
// Oddalona ściana to jeden canvas, ale rysuje dokładnie zwykłą ścianę spod spodu: te same
// kolumny, okładki i pozycje (czytane raz z DOM i z postępu animacji CSS). Zwykła ściana na
// czas intro stoi, a pozycje jej kolumn liczymy sami; na końcu przestawiamy ją jednym ruchem
// tam, gdzie był canvas, i puszczamy dalej, więc pod znikającym canvasem są te same okładki.
// Żeby telefon nadążał: każda kolumna jest raz rysowana do gotowego paska (potem tylko go
// przesuwamy), canvas ma rozdzielczość CSS (okładki są małe i pędzą, ostrość nie ma znaczenia),
// a zwykłej ściany nie ruszamy co klatkę (to wymuszało przeliczanie kilkuset okładek w DOM).
const INTRO_ZOOM = 1150;   // przybliżanie
const INTRO_CARDS = 500;   // od tej chwili wjeżdżają karty (jeszcze w trakcie przybliżania)
const INTRO_FADE = 450;    // na końcu przybliżania canvas znika, zostaje zwykła ściana
const INTRO_FROM = 0.6;    // skala na starcie (ile razy mniejsze okładki niż w tle)
const INTRO_TO = 1.08;     // skala zwykłej ściany (.tv-wall)
const INTRO_PEAK = 30;     // ile razy szybciej niż zwykle jadą kolumny na samym początku

const cards = () => [...document.querySelectorAll('.screen[data-screen="start"] :is(.stat-card, .card, .goal-card, .prize-banner)')]
  .filter(card => card.offsetParent !== null);

const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

function placeholderColor(text) {
  let h = 0;
  for (const ch of text || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 40% 32%)`;
}

// Odczyt zwykłej ściany (musi już być widoczna, inaczej nie ma animacji ani wymiarów)
function introScene(bg) {
  const wall = bg.querySelector('.tv-wall');
  const strips = [...wall.querySelectorAll('.tv-wall-strip')];
  if (!strips.length || !strips[0].children.length || !wall.offsetWidth) return null;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const canvas = el('canvas', { class: 'cover-intro' });
  canvas.width = W;
  canvas.height = H;
  bg.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  const bgColor = getComputedStyle(document.body).backgroundColor;
  const first = strips[0].children;
  const tileW = first[0].offsetWidth;
  const tileH = first[0].offsetHeight;
  const step = first.length > 1 ? first[1].offsetTop - first[0].offsetTop : tileH * 1.07;
  const pitch = strips.length > 1 ? strips[1].offsetLeft - strips[0].offsetLeft : tileW * 1.1;
  // Środek ściany na ekranie (obrót i skala CSS idą od środka)
  const cx = wall.offsetLeft + wall.offsetWidth / 2;
  const cy = wall.offsetTop + wall.offsetHeight / 2;

  // Gotowy pasek kolumny: okładki narysowane raz, jedna pod drugą (okres powtarzania)
  const bake = col => {
    const g = col.bitmap.getContext('2d');
    g.fillStyle = bgColor;
    g.fillRect(0, 0, col.bitmap.width, col.bitmap.height);
    col.waiting = 0;
    col.items.forEach((it, j) => {
      if (it.img?.complete && it.img.naturalWidth) g.drawImage(it.img, 0, j * step, tileW, tileH);
      else {
        if (it.img) col.waiting++;
        g.fillStyle = it.color || '#334';
        g.fillRect(0, j * step, tileW, tileH);
      }
    });
  };
  const columns = strips.map(strip => {
    const tiles = [...strip.children];
    const items = tiles.slice(0, tiles.length / 2).map(tile => {
      const img = tile.querySelector('img');
      return img ? { img } : { color: placeholderColor(tile.textContent) };
    });
    const anim = strip.getAnimations()[0] || null;
    anim?.pause();
    const timing = anim?.effect.getComputedTiming();
    const bitmap = document.createElement('canvas');
    bitmap.width = Math.ceil(tileW);
    bitmap.height = Math.ceil(items.length * step);
    const col = {
      x: strip.offsetLeft - wall.offsetWidth / 2,
      top: strip.offsetTop - wall.offsetHeight / 2,
      items, anim, bitmap,
      p0: timing?.progress || 0,
      duration: Number(timing?.duration) || 1,
      down: strip.parentElement.classList.contains('down'),
      height: strip.offsetHeight,
    };
    bake(col);
    return col;
  });
  // Dodatkowe kolumny po bokach (widoczne tylko z daleka): paski pożyczone ze zwykłych kolumn
  const reach = Math.hypot(W, H) / 2 / INTRO_FROM;
  const extra = Math.max(0, Math.ceil((reach - (columns.length * pitch) / 2) / pitch) + 1);
  const extras = [];
  for (let k = 1; k <= extra; k++) {
    [-1, 1].forEach(dir => {
      const src = columns[Math.floor(Math.random() * columns.length)];
      const edge = dir < 0 ? columns[0] : columns[columns.length - 1];
      const idx = dir < 0 ? -k : columns.length - 1 + k;
      extras.push({
        x: edge.x + dir * k * pitch,
        src,
        sign: ((idx % 2) + 2) % 2 ? 1 : -1,  // na zmianę w dół i w górę, jak w ścianie
        speed: tileW * (0.08 + Math.random() * 0.08),
        pos: Math.random() * src.bitmap.height,
      });
    });
  }

  // Pasek powtarzany w pionie, tyle kopii, ile trzeba do zakrycia widoku
  const drawStrip = (bitmap, x, offset, half) => {
    if (x + tileW < -half || x > half) return;
    const period = bitmap.height;
    for (let y = offset - Math.ceil((offset + half) / period) * period; y < half; y += period) {
      ctx.drawImage(bitmap, x, y);
    }
  };

  let advance = 0;  // o ile czasu animacji (ms) przesunęła się zwykła ściana
  let frameNo = 0;
  return {
    canvas,
    // Ustawia zwykłą ścianę tam, gdzie jest canvas, i puszcza ją dalej w zwykłym tempie
    release() {
      columns.forEach(col => {
        if (!col.anim || col.anim.playState !== 'paused') return;
        col.anim.currentTime = (Number(col.anim.currentTime) || 0) + advance;
        col.anim.play();
      });
    },
    draw(scale, boost, dt) {
      advance += dt * boost;
      // Okładki, które doczytały się w trakcie intro, dopisujemy do pasków (rzadko)
      if (++frameNo % 10 === 0) columns.forEach(col => { if (col.waiting) bake(col); });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, W, H);
      ctx.translate(cx, cy);
      ctx.rotate((-7 * Math.PI) / 180);
      ctx.scale(scale, scale);
      const half = Math.hypot(W, H) / 2 / scale + tileH;
      columns.forEach(col => {
        // Pozycja paska dokładnie jak w CSS: translateY(0 → -50%) w górę, odwrotnie w dół
        const p = (((col.p0 + advance / col.duration) % 1) + 1) % 1;
        const shift = -0.5 * col.height * (col.down ? 1 - p : p);
        drawStrip(col.bitmap, col.x, col.top + shift, half);
      });
      extras.forEach(col => {
        col.pos += (col.sign * col.speed * boost * dt) / 1000;
        drawStrip(col.src.bitmap, col.x, col.pos, half);
      });
      // Przyciemnienie jak filtr brightness(0.82) na kafelkach ściany
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.fillRect(0, 0, W, H);
    },
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
  // Ściana staje się widoczna dopiero, gdy Start się pokaże (chwilę po zalogowaniu), więc
  // canvas budujemy w pierwszej klatce, w której już ma wymiary i animacje
  let scene = null;
  let t0 = null;
  let prev = 0;
  let revealed = false;
  let faded = false;
  const step = now => {
    scene ??= introScene(bg);
    t0 ??= now;
    const t = now - t0;
    const dt = Math.min(50, now - (prev || now));
    prev = now;
    const z = Math.min(1, t / INTRO_ZOOM);
    // Kolumny pędzą od pierwszej klatki i hamują do zwykłego tempa
    if (!faded) scene?.draw(INTRO_FROM + (INTRO_TO - INTRO_FROM) * easeInOut(z), 1 + (INTRO_PEAK - 1) * (1 - z) ** 1.6, dt);
    if (t >= INTRO_CARDS && !revealed) {
      revealed = true;
      // Karty wjeżdżają po kolei, od góry, na tle jeszcze przybliżającej się ściany
      cards().forEach((card, i) => card.style.setProperty('--intro-delay', `${i * 0.03}s`));
      body.classList.replace('wall-intro', 'wall-intro-reveal');
    }
    if (t >= INTRO_ZOOM && !faded) {
      faded = true;
      scene?.release();
      scene?.canvas.classList.add('gone');  // znika nad zwykłą ścianą
    }
    if (t < INTRO_ZOOM + INTRO_FADE) {
      requestAnimationFrame(step);
      return;
    }
    scene?.canvas.remove();
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
