import { loadReads } from './data.js';
import { viewerId } from './admin.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { state } from './state.js';
import { supabaseClient } from './supabase.js';
import { el, friendlyError, icon, refreshIcons } from './ui.js';

/* ----------------- Oceny książek: kciuk w górę / w dół oraz ranking książek roku ----------------- */
const RATINGS = [
  { value: 1, icon: 'thumbs-up', label: 'Fajna' },
  { value: -1, icon: 'thumbs-down', label: 'Słaba' },
];

// Ocena zapisuje się od razu; kliknięcie w już wybrany kciuk zdejmuje ocenę.
// after: odrysowanie miejsca, w którym oceniono (okno książki na Półce)
async function rateBook(book, value, after) {
  const next = book.rating === value ? null : value;
  const { data, error } = await supabaseClient.from('reads').update({ rating: next }).eq('id', book.id).select('id');
  if (error || !data?.length) {
    alert('Nie udało się zapisać oceny: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
    return;
  }
  book.rating = next;
  after?.();
  await loadReads();
}

// Własne książki: dwa przyciski; cudze: sama ocena, jeśli jest.
// big: duże przyciski z podpisem (okno książki), inaczej małe ikonki
export function ratingControl(book, editable, after, { big = false } = {}) {
  if (!editable) {
    const known = RATINGS.find(r => r.value === book.rating);
    if (!known) return null;
    return el('span', { class: `rating-badge rating-${known.value > 0 ? 'up' : 'down'}${big ? ' rating-badge-big' : ''}`, title: known.label }, [
      icon(known.icon),
      ...(big ? [el('span', { text: known.label })] : []),
    ]);
  }
  if (big) {
    return el('div', { class: 'rating-big', role: 'group', 'aria-label': 'Ocena książki' }, RATINGS.map(r => {
      const on = book.rating === r.value;
      const btn = el('button', { type: 'button', class: `rating-big-btn rating-${r.value > 0 ? 'up' : 'down'}${on ? ' active' : ''}`, 'aria-pressed': String(on) }, [
        icon(r.icon),
        el('span', { text: r.label }),
      ]);
      btn.addEventListener('click', () => rateBook(book, r.value, after));
      return btn;
    }));
  }
  const group = el('span', { class: 'rating-buttons', role: 'group', 'aria-label': 'Ocena książki' }, RATINGS.map(r => {
    const btn = el('button', {
      type: 'button',
      class: `btn btn-outline btn-icon rating-btn rating-${r.value > 0 ? 'up' : 'down'}${book.rating === r.value ? ' active' : ''}`,
      'aria-label': r.label,
      'aria-pressed': String(book.rating === r.value),
      title: r.label,
    }, [icon(r.icon)]);
    btn.addEventListener('click', () => rateBook(book, r.value, after));
    return btn;
  }));
  return group;
}

// Od najfajniejszych do najmniej: kciuk w górę, bez oceny, kciuk w dół; w grupie wygrywa więcej punktów
export function sortByRating(books) {
  return [...books].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || bookPoints(b) - bookPoints(a));
}

// Karta na ekranie Ranking: książki roku wybranej osoby ułożone według ocen
export function renderBookRanking() {
  const card = document.getElementById('book-ranking-card');
  const list = document.getElementById('book-ranking-list');
  const mine = state.statsRows.filter(r => r.user_id === viewerId());
  card.hidden = !mine.length;
  if (!mine.length) return;

  const rated = mine.filter(r => r.rating !== null && r.rating !== undefined).length;
  document.getElementById('book-ranking-hint').textContent = rated
    ? `Ocenione: ${rated} z ${mine.length}. Oceniasz na Półce, w oknie książki.`
    : 'Oceń książki kciukiem na Półce (stuknij okładkę), a ułożą się tu od najfajniejszych.';

  list.replaceChildren(...sortByRating(mine).map((book, i) => el('li', { class: 'book-rank-item' }, [
    el('span', { class: 'book-rank-pos', text: String(i + 1) }),
    el('span', { class: 'book-rank-title', text: book.title || '—' }),
    ...[ratingControl(book, false)].filter(Boolean),
  ])));
  refreshIcons();
}
