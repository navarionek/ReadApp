import { viewerId } from './admin.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { seriesColors } from './stats.js';
import { el, icon, refreshIcons, showToast } from './ui.js';

/* ----------------- Ranking: podium i paski „książka po książce” ----------------- */
const PODIUM_ORDER = [1, 0, 2];  // układ na ekranie: 2. miejsce, 1., 3.
const MEDALS = ['gold', 'silver', 'bronze'];

const firstName = name => (name || '?').split(' ')[0];

function avatar(reader, colors, extraClass = '') {
  const node = el('span', { class: `rank-avatar ${extraClass}`.trim(), 'aria-hidden': 'true', text: firstName(reader.name).charAt(0).toUpperCase() });
  node.style.background = colors.get(reader.key);
  return node;
}

function renderPodium(ranked, colors) {
  const top = ranked.slice(0, 3);
  const columns = PODIUM_ORDER.filter(i => top[i]).map(i => {
    const reader = top[i];
    const place = el('div', { class: `podium-place podium-${MEDALS[i]}` }, [
      ...(i === 0 ? [el('span', { class: 'podium-crown' }, [icon('crown')])] : []),
      avatar(reader, colors, 'rank-avatar-lg'),
      el('span', { class: 'podium-name', text: firstName(reader.name) }),
      el('span', { class: 'podium-points', text: `${reader.points} pkt` }),
      el('div', { class: 'podium-step' }, [el('span', { text: String(i + 1) })]),
    ]);
    place.style.setProperty('--delay', `${[1, 0, 2][i] * 120}ms`);
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
  fill.style.width = '0%';  // rośnie do docelowej szerokości zaraz po wstawieniu do strony
  track.appendChild(fill);

  const isMe = reader.key === viewerId();
  return el('div', { class: `rank-row${isMe ? ' me' : ''}` }, [
    el('div', { class: 'rank-head' }, [
      el('span', { class: 'rank-pos', text: `#${rank}` }),
      avatar(reader, colors),
      el('span', { class: 'rank-name', text: firstName(reader.name) + (isMe ? ' (ty)' : '') }),
      el('span', { class: 'rank-total', text: `${reader.points} pkt` }),
    ]),
    track,
    el('div', { class: 'rank-meta' }, [
      el('span', { text: `${n} ${n === 1 ? 'książka' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'książki' : 'książek'} · ${pages} stron` }),
      ...(rank > 1 ? [el('span', { class: 'rank-gap', text: `−${gap} do lidera` })] : []),
    ]),
  ]);
}

export function renderRankingViz(ranked) {
  const container = document.getElementById('ranking-viz');
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
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.querySelectorAll('.rank-fill').forEach(fill => { fill.style.width = `${fill.dataset.width}%`; });
  }));
}
