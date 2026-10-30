import { einkEnabled } from './eink.js';
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
  if (einkEnabled()) return false;  // czytnik: bez ruchomego tła
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

// keepWall: zaraz po intro nie tasujemy ściany od nowa (okładki podmieniłyby się na oczach),
// tylko zapamiętujemy aktualną listę; nowe okładki pojawią się przy następnym uruchomieniu
export function renderStartWall({ keepWall = false } = {}) {
  if (!startWallEnabled()) {
    document.getElementById('cover-bg')?.remove();
    startSig = null;
    return;
  }
  if (intro) {
    intro.pending = true;
    intro.dataDone?.();  // dane wczytane i narysowane: intro może ruszać
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
  mountStartWall(books, keepWall);
}

function mountStartWall(books, keepWall = false) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Wysokość zmienia się na telefonie przy chowaniu paska adresu; ściana ma zapas, więc liczy się szerokość
  const sig = `${width}|${books.map(b => `${b.title}|${b.cover_url}`).join('~')}`;
  if (sig === startSig) return;
  const hadWall = startSig !== null && !!document.getElementById('cover-bg');
  startSig = sig;
  if (keepWall && hadWall && books.length) return;
  let bg = document.getElementById('cover-bg');
  if (!books.length) {
    bg?.remove();
    return;
  }
  if (!bg) {
    bg = el('div', { id: 'cover-bg', class: 'cover-bg', 'aria-hidden': 'true' });
    document.body.prepend(bg);
  }
  // Okładki na tyle duże, żeby było widać pojedyncze książki (na telefonie ok. 1/4 szerokości)
  const tile = Math.max(80, Math.min(140, Math.min(width, height) * 0.25));
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
// Ściana okładek z bliska i rozpędzona odjeżdża do zwykłego tła, a karty wjeżdżają na jej tle.
// Cały ruch to transform i opacity na już istniejących elementach, czyli sama kompozycja na
// GPU: zero rysowania, zero przeliczania układu w trakcie. Wcześniej ścianę rysował od nowa
// canvas co klatkę, a karty animowały backdrop-filter, i to przycinało telefon.
const INTRO_ZOOM = 1100;      // czas odjeżdżania ściany do zwykłego rozmiaru
const INTRO_CARDS = 450;      // od tej chwili wjeżdżają karty (jeszcze w trakcie ruchu ściany)
const INTRO_SETTLE = 350;     // po zoomie: czas na dokończenie animacji kart
const INTRO_FROM = 1.9;       // skala ściany na starcie (zwykła to 1.08, patrz .tv-wall)
const INTRO_TO = 1.08;
const INTRO_WAIT_MAX = 2500;  // najdłużej tyle czekamy na dane i okładki przed animacją
// Tempo kolumn na początku i jego hamowanie do zwykłego, w kilku skokach (nie co klatkę)
const INTRO_RATES = [[0, 12], [250, 6], [500, 3], [800, 1.6], [INTRO_ZOOM, 1]];

const cards = () => [...document.querySelectorAll('.screen[data-screen="start"] :is(.stat-card, .card, .goal-card, .prize-banner)')]
  .filter(card => card.offsetParent !== null);

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
  intro = { pending: false, dataDone: null };
  const body = document.body;
  body.classList.add('wall-intro');

  // Najpierw wszystko się wczytuje (dane z bazy, karty Startu, okładki ściany), a w tym czasie
  // ekran jest pusty (samo tło). Animacja rusza dopiero, gdy telefon nie robi nic ciężkiego
  // w tle (inaczej przycinała), najpóźniej po INTRO_WAIT_MAX.
  bg.classList.add('intro-waiting');
  const dataReady = new Promise(resolve => { intro.dataDone = resolve; });
  const coversReady = () => {
    const urls = new Map();
    bg.querySelectorAll('.tv-wall img').forEach(img => { if (!urls.has(img.src)) urls.set(img.src, img); });
    // Czekamy na wczytanie (load), nie na decode(): decode() potrafi czekać, aż strona się narysuje
    return Promise.all([...urls.values()].map(img => (img.complete ? null : new Promise(resolve => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))));
  };
  const timeout = new Promise(resolve => setTimeout(resolve, INTRO_WAIT_MAX));
  // Ściana ma wymiary i obrazki dopiero, gdy Start jest widoczny (chwilę po zalogowaniu): klatka zwłoki
  requestAnimationFrame(() => {
    Promise.race([Promise.all([dataReady, coversReady()]), timeout])
      .then(() => requestAnimationFrame(() => requestAnimationFrame(start)));
  });

  const finish = () => {
    body.classList.remove('wall-intro', 'wall-intro-reveal');
    cards().forEach(card => card.style.removeProperty('--intro-delay'));
    const { pending } = intro;
    intro = null;
    if (pending) renderStartWall({ keepWall: true });
  };

  const start = () => {
    const wall = bg.querySelector('.tv-wall');
    bg.classList.remove('intro-waiting');
    if (!wall?.animate) {
      finish();
      return;
    }
    // Skala od INTRO_FROM do zwykłej, ściana wyłania się z przezroczystości na początku ruchu
    wall.animate([
      { transform: `rotate(-7deg) scale(${INTRO_FROM})`, opacity: 0 },
      { opacity: 1, offset: 0.3 },
      { transform: `rotate(-7deg) scale(${INTRO_TO})`, opacity: 1 },
    ], { duration: INTRO_ZOOM, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });

    // Kolumny pędzą i hamują do zwykłego tempa (updatePlaybackRate zachowuje ich położenie)
    const columns = [...wall.querySelectorAll('.tv-wall-strip')].flatMap(strip => strip.getAnimations());
    INTRO_RATES.forEach(([at, rate]) => {
      if (!at) columns.forEach(anim => anim.updatePlaybackRate(rate));
      else setTimeout(() => columns.forEach(anim => anim.updatePlaybackRate(rate)), at);
    });

    // Karty wjeżdżają po kolei, od góry, na tle jeszcze odjeżdżającej ściany
    setTimeout(() => {
      cards().forEach((card, i) => card.style.setProperty('--intro-delay', `${i * 0.03}s`));
      body.classList.replace('wall-intro', 'wall-intro-reveal');
    }, INTRO_CARDS);
    setTimeout(finish, INTRO_ZOOM + INTRO_SETTLE);
  };
}

// Animacje CSS liczą czas także wtedy, gdy apka jest w tle, więc po powrocie ściana
// przeskakiwała. Na czas schowania apki zatrzymujemy kolumny i puszczamy je z tego samego miejsca.
let frozen = [];
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (intro) return;  // intro samo steruje animacjami kolumn
    frozen = [...document.querySelectorAll('#cover-bg .tv-wall-strip')]
      .flatMap(strip => strip.getAnimations())
      .filter(anim => anim.playState === 'running');
    frozen.forEach(anim => anim.pause());
  } else {
    frozen.forEach(anim => anim.play());
    frozen = [];
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (startSig !== null && !document.documentElement.classList.contains('tv-mode')) renderStartWall();
  }, 300);
});
