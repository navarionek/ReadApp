import { viewerId } from './admin.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { confettiBurst, confettiFountain } from './confetti.js';
import { currentScreen } from './shell.js';
import { seriesColors } from './stats.js';
import { el, icon, refreshIcons, showToast } from './ui.js';

/* ----------------- Ranking: podium i paski „książka po książce” ----------------- */
const PODIUM_ORDER = [1, 0, 2];  // układ na ekranie: 2. miejsce, 1., 3.
const MEDALS = ['gold', 'silver', 'bronze'];
const STEP_MS = 380;             // odstęp między wejściem kolejnych miejsc na podium

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const firstName = name => (name || '?').split(' ')[0];

// Zdjęcie z Google w żądanym rozmiarze (px); bez zdjęcia albo przy błędzie ładowania: kolorowe kółko z inicjałem
function googleAvatarUrl(url, size) {
  return `${url.replace(/=s\d+(-c)?$/, '')}=s${size}-c`;
}

function avatar(reader, colors, extraClass = '') {
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

// Pasek jednej osoby: długość = punkty względem lidera, a w środku kolejne książki jako segmenty
function renderBar(reader, rank, leaderPoints, colors) {
  const pages = reader.books.reduce((sum, b) => sum + b.pages, 0);
  const n = reader.books.length;
  const gap = leaderPoints - reader.points;

  const track = el('div', { class: 'rank-track' });
  const fill = el('div', { class: 'rank-fill' }, reader.books.map((book, i) => {
    const pts = bookPoints(book);
    const seg = el('button', {
      type: 'button',
      class: `rank-seg${i % 2 ? ' alt' : ''}`,
      title: `${book.title || 'bez tytułu'}: ${pts} pkt`,
      'aria-label': `${book.title || 'bez tytułu'}, ${pts} punktów`,
    });
    seg.style.flexGrow = String(Math.max(pts, 1));
    seg.style.background = colors.get(reader.key);
    seg.addEventListener('click', () => showToast(`${book.title || 'bez tytułu'}: ${pts} pkt`));
    return seg;
  }));
  fill.dataset.width = String(leaderPoints ? Math.max(4, (reader.points / leaderPoints) * 100) : 0);
  fill.style.width = `${fill.dataset.width}%`;
  track.appendChild(fill);

  const isMe = reader.key === viewerId();
  const row = el('div', { class: `rank-row${isMe ? ' me' : ''}${rank === 1 ? ' leader' : ''}` }, [
    el('div', { class: 'rank-head' }, [
      el('span', { class: 'rank-pos', text: `#${rank}` }),
      avatar(reader, colors),
      el('span', { class: 'rank-name', text: firstName(reader.name) + (isMe ? ' (ty)' : '') }),
      el('span', { class: 'rank-total', 'data-count': String(reader.points), text: `${reader.points} pkt` }),
    ]),
    track,
    el('div', { class: 'rank-meta' }, [
      el('span', { text: `${n} ${n === 1 ? 'książka' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'książki' : 'książek'} · ${pages} stron` }),
      ...(rank > 1 ? [el('span', { class: 'rank-gap', text: `−${gap} do lidera` })] : []),
    ]),
  ]);
  row.style.setProperty('--row', String(rank - 1));
  return row;
}

let viewerIsFirst = false;
let introWanted = false;

export function renderRankingViz(ranked) {
  const container = document.getElementById('ranking-viz');
  viewerIsFirst = ranked.length > 0 && ranked[0].key === viewerId();
  if (!ranked.length) {
    container.replaceChildren();
    return;
  }
  const colors = seriesColors(ranked);
  const leaderPoints = ranked[0].points;
  const bars = el('div', { class: 'rank-bars' }, ranked.map((r, i) => renderBar(r, i + 1, leaderPoints, colors)));
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
  const barsStart = hasPodium ? 3 * STEP_MS + 350 : 150;

  // Paski: po kolei od lidera
  fills.forEach((f, i) => {
    f.style.transition = `width 1.1s cubic-bezier(0.2, 0.8, 0.2, 1) ${barsStart + i * 170}ms`;
    f.style.width = `${f.dataset.width}%`;
  });
  viz.style.setProperty('--bars-start', `${barsStart}ms`);

  // Liczniki punktów
  viz.querySelectorAll('.podium-place').forEach(place => {
    const rank = Number(place.style.getPropertyValue('--rank'));
    const pts = place.querySelector('.podium-points');
    countUp(pts, Number(pts.dataset.count), rank * STEP_MS + 450, 900);
  });
  viz.querySelectorAll('.rank-total').forEach((node, i) => {
    countUp(node, Number(node.dataset.count), barsStart + i * 170, 1100);
  });

  // Wodotrysk dla lidera (gdy to ja jestem pierwszy): z awatara na szczycie podium
  if (viewerIsFirst) {
    const delay = hasPodium ? 450 + 350 : 200;
    setTimeout(() => {
      if (currentScreen() !== 'ranking') return;
      const target = viz.querySelector('.podium-gold .rank-avatar') || viz.querySelector('.rank-row.leader');
      if (!target) return;
      const r = target.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      confettiBurst(x, y, { count: 110, speed: 900, spread: Math.PI });
      confettiFountain(x, y, { duration: 2200, rate: 180, speed: 1150 });
    }, delay);
  }
}
