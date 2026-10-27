import { viewerId } from './admin.js';
import { earnedBadges } from './badges.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { confettiBurst, confettiFountain } from './confetti.js';
import { currentScreen } from './shell.js';
import { seriesColors } from './stats.js';
import { currentYear, el, icon, refreshIcons } from './ui.js';

/* ----------------- Ranking: podium i paski „książka po książce” ----------------- */
const PODIUM_ORDER = [1, 0, 2];  // układ na ekranie: 2. miejsce, 1., 3.
const MEDALS = ['gold', 'silver', 'bronze'];
const STEP_MS = 180;             // odstęp między wejściem kolejnych miejsc na podium

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const firstName = name => (name || '?').split(' ')[0];

// Zdjęcie z Google w żądanym rozmiarze (px); bez zdjęcia albo przy błędzie ładowania: kolorowe kółko z inicjałem
function googleAvatarUrl(url, size) {
  return `${url.replace(/=s\d+(-c)?$/, '')}=s${size}-c`;
}

export function avatar(reader, colors, extraClass = '') {
  const classes = `rank-avatar ${extraClass}`.trim();
  const initial = () => {
    const node = el('span', { class: classes, 'aria-hidden': 'true', text: firstName(reader.name).charAt(0).toUpperCase() });
    node.style.background = colors.get(reader.key);
    return node;
  };
  if (!reader.avatarUrl) return initial();
  const size = extraClass.includes('lg') ? 160 : 96;
  const img = el('img', { class: classes, src: googleAvatarUrl(reader.avatarUrl, size), alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.style.background = colors.get(reader.key);
  img.addEventListener('error', () => img.replaceWith(initial()));
  return img;
}

function renderPodium(ranked, colors) {
  const top = ranked.slice(0, 3);
  const columns = PODIUM_ORDER.filter(i => top[i]).map(i => {
    const reader = top[i];
    const place = el('div', { class: `podium-place podium-${MEDALS[i]}` }, [
      el('div', { class: 'podium-who' }, [
        ...(i === 0 ? [el('span', { class: 'podium-crown' }, [icon('crown')])] : []),
        avatar(reader, colors, 'rank-avatar-lg'),
        el('span', { class: 'podium-name', text: firstName(reader.name) }),
        el('span', { class: 'podium-points', 'data-count': String(reader.points), text: `${reader.points} pkt` }),
      ]),
      el('div', { class: 'podium-step' }, [el('span', { text: String(i + 1) })]),
    ]);
    place.style.setProperty('--rank', String(i));
    return place;
  });
  return el('div', { class: 'podium', role: 'list', 'aria-label': 'Podium' }, columns);
}

/* ----- Dymek odznaki: pojawia się nad medalem, zamyka się po stuknięciu (w dymek, medal albo gdziekolwiek) ----- */
let badgePop = null;

function closeBadgePop() {
  badgePop?.remove();
  badgePop = null;
}

function toggleBadgePop(chip, badge) {
  toggleBubble(chip, badge.name, badge.desc);
}

// Dymek nad dowolnym elementem (medal, segment książki): tytuł + opis
function toggleBubble(chip, title, text) {
  const reopenSame = badgePop && badgePop.chip === chip;
  closeBadgePop();
  if (reopenSame) return;  // drugie stuknięcie w ten sam element zamyka dymek

  const bubble = el('div', { class: 'badge-pop', role: 'tooltip' }, [
    el('strong', { text: title }),
    el('span', { text }),
  ]);
  document.body.appendChild(bubble);

  const r = chip.getBoundingClientRect();
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  const centerX = r.left + r.width / 2;
  const left = Math.max(8, Math.min(centerX - w / 2, window.innerWidth - w - 8));
  const above = r.top - h - 10 >= 8;  // brak miejsca nad medalem: pod nim
  bubble.style.left = `${left}px`;
  bubble.style.top = `${above ? r.top - h - 10 : r.bottom + 10}px`;
  bubble.style.setProperty('--arrow-x', `${centerX - left}px`);
  bubble.classList.toggle('below', !above);

  badgePop = { chip, el: bubble, remove: () => bubble.remove() };
}

document.addEventListener('click', closeBadgePop);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBadgePop(); });
window.addEventListener('scroll', closeBadgePop, true);
window.addEventListener('resize', closeBadgePop);

// Rozwinięte wiersze (klucze osób): zostają rozwinięte po odświeżeniu danych, np. po edycji książki
const openRows = new Set();

// Pasek jednej osoby: długość = punkty względem lidera, a w środku kolejne książki jako segmenty.
// W zwiniętym wierszu nic nie przechwytuje stuknięć, więc stuknięcie gdziekolwiek rozwija
// listę: odznaki (z dymkami) i wszystkie książki tej osoby (booksOf buduje listę).
function renderBar(reader, rank, leaderPoints, colors, ranked, booksOf) {
  const pages = reader.books.reduce((sum, b) => sum + b.pages, 0);
  const n = reader.books.length;
  const gap = leaderPoints - reader.points;

  const track = el('div', { class: 'rank-track', 'aria-hidden': 'true' });
  const fill = el('div', { class: 'rank-fill' }, reader.books.map((book, i) => {
    const seg = el('span', { class: `rank-seg${i % 2 ? ' alt' : ''}` });
    seg.style.flexGrow = String(Math.max(bookPoints(book), 1));
    seg.style.background = colors.get(reader.key);
    return seg;
  }));
  fill.dataset.width = String(leaderPoints ? Math.max(4, (reader.points / leaderPoints) * 100) : 0);
  fill.style.width = `${fill.dataset.width}%`;
  track.appendChild(fill);

  const earned = earnedBadges(reader, rank, ranked);
  const isMe = reader.key === viewerId();
  const badges = earned.length
    ? [el('div', { class: 'rank-badges', 'aria-label': `Odznaki: ${earned.map(b => b.name).join(', ')}` },
        earned.map(b => {
          const chip = el('button', { type: 'button', class: 'badge-mini', 'aria-label': `${b.name}: ${b.desc}` }, [icon(b.icon)]);
          chip.addEventListener('click', e => {
            e.stopPropagation();  // globalny klik zamykałby dymek od razu
            toggleBadgePop(chip, b);
          });
          return chip;
        }))]
    : [];
  const inner = el('div', { class: 'rank-books-inner' });
  const panel = el('div', { class: 'rank-books' }, [inner]);
  const head = el('div', { class: 'rank-head', role: 'button', tabindex: '0', 'aria-expanded': 'false', 'aria-label': `${firstName(reader.name)}: pokaż książki` }, [
      el('span', { class: 'rank-pos', text: String(rank) }),
      avatar(reader, colors),
      el('span', { class: 'rank-who' }, [
        el('span', { class: 'rank-name' }, [
          el('span', { text: firstName(reader.name) + (isMe ? ' (ty)' : '') }),
          ...(reader.inMoneyPrize
            ? [el('span', { class: 'money-badge', title: 'Bierze udział w nagrodzie pieniężnej', 'aria-label': 'Nagroda pieniężna' }, [icon('coins')])]
            : []),
        ]),
        el('span', { class: 'rank-meta' }, [
          el('span', { text: `${n} ${n === 1 ? 'książka' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'książki' : 'książek'} · ${pages} str.` }),
          ...(earned.length ? [el('span', { class: 'rank-badge-count' }, [icon('award'), el('span', { text: String(earned.length) })])] : []),
        ]),
      ]),
      el('span', { class: 'rank-score' }, [
        el('span', { class: 'rank-total', 'data-count': String(reader.points), text: `${reader.points} pkt` }),
        ...(rank > 1 ? [el('span', { class: 'rank-gap', text: `−${gap}` })] : []),
      ]),
      el('span', { class: 'rank-more' }, [icon('chevron-down')]),
    ]);
  const row = el('div', { class: `rank-row${isMe ? ' me' : ''}${rank === 1 ? ' leader' : ''}` }, [
    head,
    track,
    panel,
  ]);
  row.style.setProperty('--row', String(rank - 1));

  const setOpen = open => {
    if (open && !inner.childElementCount) {
      inner.replaceChildren(...badges, ...booksOf(reader, colors));
      refreshIcons();
    }
    row.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    if (open) openRows.add(reader.key);
    else openRows.delete(reader.key);
  };
  // Klik w wiersz (poza segmentami paska, medalami i samą listą książek) rozwija i zwija
  row.addEventListener('click', e => {
    if (e.target.closest('.rank-books')) return;
    setOpen(!row.classList.contains('open'));
  });
  head.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    setOpen(!row.classList.contains('open'));
  });
  if (openRows.has(reader.key)) setOpen(true);
  return row;
}

// Licznik wejść w ranking jako lider (localStorage tego urządzenia; bez niego losowo 1 do 3)
function everyThirdLeaderVisit() {
  try {
    const visits = Number(localStorage.getItem('leaderVisits') || 0) + 1;
    localStorage.setItem('leaderVisits', String(visits));
    return visits % 3 === 0;
  } catch {
    return Math.random() < 1 / 3;
  }
}

let viewerIsFirst = false;
let introWanted = false;

// booksOf(reader, colors): lista książek osoby, pokazywana po rozwinięciu jej wiersza
export function renderRankingViz(ranked, booksOf) {
  const container = document.getElementById('ranking-viz');
  viewerIsFirst = ranked.length > 0 && ranked[0].key === viewerId();
  if (!ranked.length) {
    container.replaceChildren(el('div', { class: 'status-box', text: `Brak wpisów w ${currentYear()} roku. Dodaj pierwszy!` }));
    return;
  }
  const colors = seriesColors(ranked);
  const leaderPoints = ranked[0].points;
  const bars = el('div', { class: 'rank-bars' }, ranked.map((r, i) => renderBar(r, i + 1, leaderPoints, colors, ranked, booksOf)));
  container.replaceChildren(
    ...(ranked.length > 1 ? [renderPodium(ranked, colors)] : []),
    bars,
  );
  refreshIcons();
  // Pierwsze wczytanie danych, gdy ktoś już czeka na ekranie rankingu: odpal wejście teraz
  if (introWanted && currentScreen() === 'ranking') playRankingIntro();
}

// Licznik: liczba „dojeżdża” od 0 do wartości
function countUp(node, to, delay, duration) {
  node.textContent = '0 pkt';
  const startAt = performance.now() + delay;
  const step = now => {
    const t = Math.min(1, Math.max(0, (now - startAt) / duration));
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = `${Math.round(to * eased)} pkt`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Wejście: od 1. miejsca w dół. Najpierw stopnie podium rosną (1., 2., 3.), potem wskakują osoby
// z licznikami punktów, na końcu paski wyjeżdżają po kolei od lidera. Lider-widz dostaje wodotrysk.
export function playRankingIntro() {
  const viz = document.getElementById('ranking-viz');
  if (!viz.children.length) {
    introWanted = true;  // dane jeszcze się wczytują; odpalimy po pierwszym renderze
    return;
  }
  introWanted = false;

  viz.classList.remove('intro');
  const fills = [...viz.querySelectorAll('.rank-fill')];
  fills.forEach(f => { f.style.transition = 'none'; f.style.width = '0%'; });
  void viz.offsetWidth;  // wymuś przeliczenie, żeby animacje wystartowały od nowa

  if (reducedMotion()) {
    fills.forEach(f => { f.style.transition = 'none'; f.style.width = `${f.dataset.width}%`; });
    return;
  }

  viz.classList.add('intro');
  const hasPodium = !!viz.querySelector('.podium');
  const barsStart = hasPodium ? 3 * STEP_MS + 150 : 100;

  // Paski: po kolei od lidera
  fills.forEach((f, i) => {
    f.style.transition = `width 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) ${barsStart + i * 90}ms`;
    f.style.width = `${f.dataset.width}%`;
  });
  viz.style.setProperty('--bars-start', `${barsStart}ms`);

  // Liczniki punktów
  viz.querySelectorAll('.podium-place').forEach(place => {
    const rank = Number(place.style.getPropertyValue('--rank'));
    const pts = place.querySelector('.podium-points');
    countUp(pts, Number(pts.dataset.count), rank * STEP_MS + 250, 600);
  });
  viz.querySelectorAll('.rank-total').forEach((node, i) => {
    countUp(node, Number(node.dataset.count), barsStart + i * 90, 700);
  });

  // Wodotrysk dla lidera (gdy to ja jestem pierwszy): z awatara na szczycie podium,
  // krótki i tylko co 3. wejście w ranking jako lider
  if (viewerIsFirst && everyThirdLeaderVisit()) {
    const delay = hasPodium ? 450 : 150;
    setTimeout(() => {
      if (currentScreen() !== 'ranking') return;
      const target = viz.querySelector('.podium-gold .rank-avatar') || viz.querySelector('.rank-row.leader');
      if (!target) return;
      const r = target.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      confettiBurst(x, y, { count: 110, speed: 900, spread: Math.PI });
      confettiFountain(x, y, { duration: 400, rate: 170, speed: 1100 });
    }, delay);
  }
}
