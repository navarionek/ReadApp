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
// Przy przewijaniu kolumny jadą za stroną wolniej niż karty (paralaksa), każda z inną
// głębią i na własnej sprężynie: lekko się spóźniają i dobijają, więc ściana faluje.
let startSig = null;
let springs = [];
let springFrame = null;
let springLast = 0;
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

export function renderStartWall() {
  const all = [...state.statsRows, ...state.readingNow].map(r => ({ title: r.title, author: r.author, cover_url: r.cover_url }));
  // Same kolorowe zaślepki z tytułami robią w tle bałagan: jeśli okładek jest dość, tylko one
  const withCovers = all.filter(b => b.cover_url);
  const books = withCovers.length >= 6 ? withCovers : all;
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Wysokość zmienia się na telefonie przy chowaniu paska adresu; ściana ma zapas, więc liczy się szerokość
  const sig = `${width}|${books.map(b => `${b.title}|${b.cover_url}`).join('~')}`;
  if (sig === startSig) return;
  startSig = sig;
  let bg = document.getElementById('cover-bg');
  if (!books.length) {
    bg?.remove();
    springs = [];
    return;
  }
  if (!bg) {
    bg = el('div', { id: 'cover-bg', class: 'cover-bg', 'aria-hidden': 'true' });
    document.body.prepend(bg);
  }
  // Drobne okładki, dużo kolumn: bardziej faktura niż pojedyncze książki
  const tile = Math.max(58, Math.min(100, Math.min(width, height) * 0.17));
  // Kolumny jadą za stroną najwyżej o 0,3 przewinięcia, więc paski muszą mieć zapas w dół
  const extra = Math.max(0, document.documentElement.scrollHeight - height) * 0.3;
  const wall = buildCoverWall(books, {
    width,
    height: height + extra,
    tile,
    gap: tile * 0.1,
    speed: [tile * 0.08, tile * 0.16],
    tileEl: b => el('div', { class: 'tv-wall-tile' }, [wallCover(b)]),
  });
  bg.replaceChildren(wall);
  springs = [...wall.children].map(col => {
    const stiff = 40 + Math.random() * 90;  // miękkie kolumny spóźniają się bardziej
    return { col, depth: 0.08 + Math.random() * 0.22, stiff, damp: 2 * Math.sqrt(stiff) * 0.55, pos: 0, vel: 0 };
  });
  springs.forEach(s => {
    s.pos = -window.scrollY * s.depth;
    s.col.style.transform = `translate3d(0, ${s.pos}px, 0)`;
  });
}

function stepSprings(now) {
  const dt = Math.min(0.05, (now - springLast) / 1000);
  springLast = now;
  let moving = false;
  springs.forEach(s => {
    const target = -window.scrollY * s.depth;
    s.vel += ((target - s.pos) * s.stiff - s.vel * s.damp) * dt;
    s.pos += s.vel * dt;
    if (Math.abs(target - s.pos) < 0.3 && Math.abs(s.vel) < 0.3) {
      s.pos = target;
      s.vel = 0;
    } else {
      moving = true;
    }
    s.col.style.transform = `translate3d(0, ${s.pos.toFixed(1)}px, 0)`;
  });
  springFrame = moving ? requestAnimationFrame(stepSprings) : null;
}

window.addEventListener('scroll', () => {
  if (!springs.length || springFrame !== null || calm.matches) return;
  if (!springs[0].col.getClientRects().length) return;  // tło niewidoczne (inny ekran)
  springLast = performance.now();
  springFrame = requestAnimationFrame(stepSprings);
}, { passive: true });

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (startSig !== null && !document.documentElement.classList.contains('tv-mode')) renderStartWall();
  }, 300);
});
