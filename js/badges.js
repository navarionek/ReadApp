import { bookPoints, normalizeTitle } from '../supabase/functions/_shared/logic.js';
import { state } from './state.js';
import { viewerId } from './admin.js';
import { DAY_MS, el, icon } from './ui.js';

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
  { id: 'double', icon: 'badge-percent', name: 'Podwójny bonus', desc: 'Książka z mnożnikiem 2,25x (dwa mnożniki naraz)', test: s => s.doubleBonus >= 1 },
  { id: 'streak', icon: 'calendar-check', name: 'Regularność', desc: 'Wpisy w 3 kolejnych miesiącach', test: s => s.monthStreak >= 3 },
  { id: 'leader', icon: 'crown', name: 'Korona', desc: 'Aktualnie 1. miejsce w rankingu', test: s => s.rank === 1 },
  { id: 'dominator', icon: 'swords', name: 'Dominator', desc: '1. miejsce z przewagą co najmniej 500 punktów', test: s => s.rank === 1 && s.lead >= 500 },
  { id: 'deadline', icon: 'timer', name: 'Rzutem na taśmę', desc: 'Książka dodana w ostatnim tygodniu roku (25–31 grudnia)', test: s => s.lastWeek >= 1 },
  { id: 'thin', icon: 'feather', name: 'Na jedno posiedzenie', desc: 'Skończona książka do 150 stron (ulotki też się liczą)', test: s => s.thin >= 1 },
  { id: 'jackpot', icon: 'gem', name: 'Jackpot', desc: 'Jedna książka warta 1000 punktów', test: s => s.bestBook >= 1000 },
  { id: 'hamster', icon: 'squirrel', name: 'Chomik', desc: '3 zaczęte książki naraz w „Teraz czytam”', test: s => s.reading >= 3 },
  { id: 'lightning', icon: 'zap', name: 'Błyskawica', desc: 'Książka przeczytana w mniej niż tydzień', test: s => s.fast >= 1 },
  { id: 'turtle', icon: 'turtle', name: 'Żółw', desc: 'Książka czytana ponad 60 dni', test: s => s.slow >= 1 },
  { id: 'english', icon: 'languages', name: 'Anglofil', desc: '5 książek z mnożnikiem „Angielski”', test: s => s.english >= 5 },
  { id: 'scientist', icon: 'flask-conical', name: 'Naukowiec', desc: '5 książek z mnożnikiem „Naukowa”', test: s => s.science >= 5 },
  { id: 'loyal', icon: 'pen-line', name: 'Wierny autor', desc: '2 książki tego samego autora', test: s => s.sameAuthor >= 2 },
  { id: 'classic', icon: 'scroll-text', name: 'Klasyka', desc: 'Książka wydana przed 1950 rokiem', test: s => s.classic >= 1 },
];

const hasLabel = (book, label) => (book.multiplier_labels || []).some(l => l.toLowerCase() === label);

export function badgeStats(reader, rank, ranked = []) {
  const books = reader.books;
  const months = new Set(books.map(b => new Date(b.created_at).getMonth()));
  let monthStreak = 0;
  let run = 0;
  for (let m = 0; m < 12; m++) {
    run = months.has(m) ? run + 1 : 0;
    monthStreak = Math.max(monthStreak, run);
  }

  // Czas czytania znamy tylko dla wpisów z datą rozpoczęcia; niedokończone książki nie liczą się do tempa
  const readingDays = b => (new Date(b.created_at) - new Date(b.started_at)) / DAY_MS;
  const timed = books.filter(b => b.started_at && !b.unfinished);

  // Autor może być podany jako „A, B”: liczymy każdego osobno, raz na książkę
  const authorCounts = new Map();
  books.forEach(b => {
    new Set((b.author || '').split(',').map(a => normalizeTitle(a)).filter(Boolean))
      .forEach(a => authorCounts.set(a, (authorCounts.get(a) || 0) + 1));
  });

  return {
    books: books.length,
    pages: books.reduce((sum, b) => sum + b.pages, 0),
    longest: books.reduce((max, b) => Math.max(max, b.pages), 0),
    bonus: books.filter(b => Number(b.multiplier) > 1).length,
    doubleBonus: books.filter(b => Number(b.multiplier) >= 2.25 - 1e-9).length,
    monthStreak,
    rank,
    lead: rank === 1 && ranked.length > 1 ? reader.points - ranked[1].points : 0,
    lastWeek: books.filter(b => { const d = new Date(b.created_at); return d.getMonth() === 11 && d.getDate() >= 25; }).length,
    thin: books.filter(b => !b.unfinished && b.pages <= 150).length,
    bestBook: books.reduce((max, b) => Math.max(max, bookPoints(b)), 0),
    reading: state.readingNow.filter(item => item.user_id === reader.key).length,
    fast: timed.filter(b => readingDays(b) < 7).length,
    slow: timed.filter(b => readingDays(b) > 60).length,
    english: books.filter(b => hasLabel(b, 'angielski')).length,
    science: books.filter(b => hasLabel(b, 'naukowa')).length,
    sameAuthor: Math.max(0, ...authorCounts.values()),
    classic: books.filter(b => b.published_year != null && b.published_year < 1950).length,
  };
}

export function earnedBadges(reader, rank, ranked = []) {
  const stats = badgeStats(reader, rank, ranked);
  return BADGES.filter(b => b.test(stats));
}

export function renderBadgesCard(ranked) {
  const grid = document.getElementById('badges-grid');
  const index = ranked.findIndex(r => r.key === viewerId());
  const me = ranked[index] || { books: [] };
  const earned = new Set(earnedBadges(me, index + 1, ranked).map(b => b.id));

  document.getElementById('badges-count').textContent = `${earned.size}/${BADGES.length}`;
  grid.replaceChildren(...BADGES.map(b => el('div', { class: `badge-item${earned.has(b.id) ? ' earned' : ''}` }, [
    el('span', { class: 'badge-icon' }, [icon(b.icon)]),
    el('span', { class: 'badge-text' }, [
      el('span', { class: 'badge-name', text: b.name }),
      el('span', { class: 'badge-desc', text: b.desc }),
    ]),
  ])));
}
