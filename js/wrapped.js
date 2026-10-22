import { viewerId } from './admin.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { sortByRating } from './ratings.js';
import { state } from './state.js';
import { currentYear, el, icon, refreshIcons } from './ui.js';

/* ----------------- Czytanko Wrapped: podsumowanie roku jednej osoby ----------------- */
const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];

function slide(iconName, label, value, note) {
  return el('div', { class: 'wrapped-slide' }, [
    el('span', { class: 'wrapped-icon' }, [icon(iconName)]),
    el('span', { class: 'wrapped-label', text: label }),
    el('span', { class: 'wrapped-value', text: value }),
    ...(note ? [el('span', { class: 'wrapped-note', text: note })] : []),
  ]);
}

const bookLabel = book => `${book.title || 'bez tytułu'} · ${book.pages} str.`;

export function renderWrapped() {
  const root = document.getElementById('wrapped-content');
  if (!root) return;
  const id = viewerId();
  const mine = state.statsRows.filter(r => r.user_id === id);
  const year = currentYear();

  if (!mine.length) {
    root.replaceChildren(el('div', { class: 'status-box', text: `W ${year} nie ma jeszcze żadnej przeczytanej książki, więc nie ma czego podsumować.` }));
    return;
  }

  const pages = mine.reduce((sum, b) => sum + b.pages, 0);
  const points = mine.reduce((sum, b) => sum + bookPoints(b), 0);
  const ranked = [...state.statsReaders].sort((a, b) => b.points - a.points);
  const place = ranked.findIndex(r => r.key === id) + 1;
  const longest = mine.reduce((best, b) => (b.pages > best.pages ? b : best));
  const shortest = mine.reduce((best, b) => (b.pages < best.pages ? b : best));
  const ups = mine.filter(b => b.rating === 1).length;
  const downs = mine.filter(b => b.rating === -1).length;
  const favourite = sortByRating(mine)[0];

  const perMonth = new Array(12).fill(0);
  mine.forEach(b => { perMonth[new Date(b.created_at).getMonth()] += 1; });
  const busiest = perMonth.indexOf(Math.max(...perMonth));

  const slides = [
    slide('book-open', 'Przeczytane książki', String(mine.length), `${pages} stron razem`),
    slide('ruler', 'Średnia długość książki', `${Math.round(pages / mine.length)} str.`),
    slide('trophy', 'Miejsce w rankingu', `#${place}`, `${points} pkt`),
    slide('calendar-days', 'Najlepszy miesiąc', MONTHS[busiest], `${perMonth[busiest]} ${perMonth[busiest] === 1 ? 'książka' : 'książek'}`),
    slide('mountain', 'Najdłuższa książka', bookLabel(longest)),
    slide('feather', 'Najkrótsza książka', bookLabel(shortest)),
    ...(ups || downs
      ? [slide('thumbs-up', 'Oceny', `${ups} 👍 · ${downs} 👎`, favourite?.rating === 1 ? `Hit roku: ${favourite.title || 'bez tytułu'}` : undefined)]
      : []),
  ];

  root.replaceChildren(...slides);
  refreshIcons();
}
