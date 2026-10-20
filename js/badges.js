import { viewerId } from './admin.js';
import { el, icon } from './ui.js';

/* ----------------- Odznaki ----------------- */
// Liczone z wpisów bieżącego roku, więc resetują się razem z rywalizacją
export const BADGES = [
  { id: 'first', icon: 'book-open', name: 'Pierwsza książka', desc: 'Pierwszy wpis w tym roku', test: s => s.books >= 1 },
  { id: 'five', icon: 'library', name: 'Piątka', desc: '5 książek', test: s => s.books >= 5 },
  { id: 'ten', icon: 'library-big', name: 'Dycha', desc: '10 książek', test: s => s.books >= 10 },
  { id: 'twenty', icon: 'landmark', name: 'Dwudziestka', desc: '20 książek', test: s => s.books >= 20 },
  { id: 'brick', icon: 'brick-wall', name: 'Cegła', desc: 'Książka mająca co najmniej 500 stron', test: s => s.longest >= 500 },
  { id: 'pages1k', icon: 'flame', name: 'Tysiąc stron', desc: '1000 przeczytanych stron', test: s => s.pages >= 1000 },
  { id: 'pages5k', icon: 'rocket', name: 'Pięć tysięcy stron', desc: '5000 przeczytanych stron', test: s => s.pages >= 5000 },
  { id: 'bonus', icon: 'sparkles', name: 'Z bonusem', desc: '3 książki z mnożnikiem powyżej 1x', test: s => s.bonus >= 3 },
  { id: 'streak', icon: 'calendar-check', name: 'Regularność', desc: 'Wpisy w 3 kolejnych miesiącach', test: s => s.monthStreak >= 3 },
  { id: 'leader', icon: 'crown', name: 'Korona', desc: 'Aktualnie 1. miejsce w rankingu', test: s => s.rank === 1 },
];

export function badgeStats(reader, rank) {
  const months = new Set(reader.books.map(b => new Date(b.created_at).getMonth()));
  let monthStreak = 0;
  let run = 0;
  for (let m = 0; m < 12; m++) {
    run = months.has(m) ? run + 1 : 0;
    monthStreak = Math.max(monthStreak, run);
  }
  return {
    books: reader.books.length,
    pages: reader.books.reduce((sum, b) => sum + b.pages, 0),
    longest: reader.books.reduce((max, b) => Math.max(max, b.pages), 0),
    bonus: reader.books.filter(b => Number(b.multiplier) > 1).length,
    monthStreak,
    rank,
  };
}

export function earnedBadges(reader, rank) {
  const stats = badgeStats(reader, rank);
  return BADGES.filter(b => b.test(stats));
}

export function renderBadgesCard(ranked) {
  const grid = document.getElementById('badges-grid');
  const index = ranked.findIndex(r => r.key === viewerId());
  const me = ranked[index] || { books: [] };
  const earned = new Set(earnedBadges(me, index + 1).map(b => b.id));

  document.getElementById('badges-count').textContent = `${earned.size}/${BADGES.length}`;
  grid.replaceChildren(...BADGES.map(b => el('div', { class: `badge-item${earned.has(b.id) ? ' earned' : ''}` }, [
    el('span', { class: 'badge-icon' }, [icon(b.icon)]),
    el('span', { class: 'badge-text' }, [
      el('span', { class: 'badge-name', text: b.name }),
      el('span', { class: 'badge-desc', text: b.desc }),
    ]),
  ])));
}
