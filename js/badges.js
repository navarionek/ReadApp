import { BADGE_INFO } from '../supabase/functions/_shared/badges.js';
import { bookPoints, normalizeTitle } from '../supabase/functions/_shared/logic.js';
import { state } from './state.js';
import { viewerId } from './admin.js';
import { supabaseClient } from './supabase.js';
import { currentYear, DAY_MS, el, icon } from './ui.js';
import { pendingBadgeIds, showBadgeAward } from './badgeaward.js';

/* ----------------- Odznaki ----------------- */
// Liczone z wpisów bieżącego roku, więc resetują się razem z rywalizacją. Zdobytą odznakę aplikacja
// zapisuje na stałe w tabeli user_badges (osobno dla każdego roku) i już jej nie odbiera, nawet gdy wpis
// zostanie potem usunięty. Przy wyświetlaniu liczy się to, co zapisane, plus to, co właśnie wychodzi z wpisów.
const DEFINITIONS = [
  { id: 'first', icon: 'book-open', test: s => s.books >= 1 },
  { id: 'five', icon: 'library', test: s => s.books >= 5 },
  { id: 'ten', icon: 'library-big', test: s => s.books >= 10 },
  { id: 'twenty', icon: 'landmark', test: s => s.books >= 20 },
  { id: 'pages1k', icon: 'flame', test: s => s.pages >= 1000 },
  { id: 'pages5k', icon: 'rocket', test: s => s.pages >= 5000 },
  { id: 'brick', icon: 'brick-wall', test: s => s.longest >= 500 },
  { id: 'gigabrick', icon: 'castle', test: s => s.longest >= 800 },
  { id: 'bonus', icon: 'sparkles', test: s => s.bonus >= 3 },
  { id: 'double', icon: 'badge-percent', test: s => s.doubleBonus >= 1 },
  { id: 'streak', icon: 'calendar-check', test: s => s.monthStreak >= 3 },
  { id: 'leader', icon: 'crown', test: s => s.rank === 1 },
  { id: 'dominator', icon: 'swords', test: s => s.rank === 1 && s.lead >= 500 },
  { id: 'deadline', icon: 'timer', test: s => s.lastWeek >= 1 },
  { id: 'thin', icon: 'feather', test: s => s.thin >= 1 },
  { id: 'jackpot', icon: 'gem', test: s => s.bestBook >= 1000 },
  { id: 'hamster', icon: 'squirrel', test: s => s.reading >= 3 },
  { id: 'lightning', icon: 'zap', test: s => s.fast >= 1 },
  { id: 'turtle', icon: 'turtle', test: s => s.slow >= 1 },
  { id: 'english', icon: 'languages', test: s => s.english >= 5 },
  { id: 'scientist', icon: 'flask-conical', test: s => s.science >= 5 },
  { id: 'loyal', icon: 'pen-line', test: s => s.sameAuthor >= 2 },
  { id: 'classic', icon: 'scroll-text', test: s => s.classic >= 1 },
  { id: 'nonstop', icon: 'calendar-range', test: s => s.fromJanuary },
  { id: 'giant', icon: 'mountain', test: s => s.giant },
];

const INFO = new Map(BADGE_INFO.map(b => [b.id, b]));
export const BADGES = DEFINITIONS.map(d => ({ ...INFO.get(d.id), ...d }));

const hasLabel =(book, label) => (book.multiplier_labels || []).some(l => l.toLowerCase() === label);

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

  // Pełne miesiące od stycznia do ostatniego zakończonego: w każdym musi być wpis (min. 4, czyli styczeń–kwiecień)
  const lastFullMonth = new Date().getMonth() - 1;
  const fromJanuary = lastFullMonth >= 3 && Array.from({ length: lastFullMonth + 1 }, (_, m) => m).every(m => months.has(m));

  // Najdłuższa skończona książka: ściśle dłuższa niż każda u pozostałych (przy remisie nikt nie dostaje)
  const longestFinished = r => r.books.reduce((max, b) => (b.unfinished ? max : Math.max(max, b.pages)), 0);
  const othersLongest = Math.max(0, ...ranked.filter(r => r.key !== reader.key).map(longestFinished));
  const giant = ranked.length > 1 && longestFinished(reader) > othersLongest;

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
    fromJanuary,
    giant,
  };
}

export function earnedBadges(reader, rank, ranked = []) {
  const stats = badgeStats(reader, rank, ranked);
  return BADGES.filter(b => b.test(stats));
}

const storedBadges = userId => state.badges.get(userId) || new Set();

// Odznaki do pokazania: zapisane (nikt ich nie odbiera) plus te, które wychodzą z wpisów, a jeszcze
// nie trafiły do bazy (u innych osób zapisują się, gdy otworzą aplikację)
export function shownBadges(reader, rank, ranked = []) {
  const stored = storedBadges(reader.key);
  const computed = new Set(earnedBadges(reader, rank, ranked).map(b => b.id));
  return BADGES.filter(b => stored.has(b.id) || computed.has(b.id));
}

export async function loadStoredBadges() {
  const { data, error } = await supabaseClient.from('user_badges').select('user_id, badge_id').eq('year', currentYear());
  if (error) {
    console.error('Error loading badges:', error);
    return;
  }
  const byUser = new Map();
  (data || []).forEach(row => {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, new Set());
    byUser.get(row.user_id).add(row.badge_id);
  });
  state.badges = byUser;
}

// Wpisy sprzed wprowadzenia zapisywania odznak: osoba, która je ma, dostaje swoje obecne odznaki bez powiadomień
// dla reszty (odznaki nie są „nowe” dla innych). Dla wpisów dodanych później powiadomienia idą normalnie.
const BADGES_LAUNCH = new Date('2026-10-28T18:00:00+01:00');
let syncing = false;

// Odznaki zapisane przy poprzednim wejściu, których okno nie zdążyło się pokazać (raz na wczytanie strony)
let resumed = false;
function resumePendingAward(stored) {
  if (resumed) return;
  resumed = true;
  const ids = new Set(pendingBadgeIds());
  const badges = BADGES.filter(b => ids.has(b.id) && stored.has(b.id));
  if (badges.length) showBadgeAward(badges);
}

// Zapisuje świeżo zdobyte odznaki zalogowanej osoby i pokazuje je na pełnym ekranie
export async function syncMyBadges(ranked) {
  const me = state.currentUser;
  if (!me || viewerId() !== me.id || syncing) return;
  const index = ranked.findIndex(r => r.key === me.id);
  if (index < 0) return;
  const reader = ranked[index];
  const stored = storedBadges(me.id);
  resumePendingAward(stored);
  const fresh = earnedBadges(reader, index + 1, ranked).filter(b => !stored.has(b.id));
  if (!fresh.length) return;

  syncing = true;
  try {
    const silent = stored.size === 0 && reader.books.some(b => new Date(b.created_at) < BADGES_LAUNCH);
    const year = currentYear();
    const notifiedAt = new Date().toISOString();
    const { data, error } = await supabaseClient
      .from('user_badges')
      .upsert(
        fresh.map(b => ({ year, badge_id: b.id, ...(silent ? { notified_at: notifiedAt } : {}) })),
        { onConflict: 'user_id,year,badge_id', ignoreDuplicates: true },
      )
      .select('badge_id');
    if (error) throw error;
    const all = new Set([...stored, ...fresh.map(b => b.id)]);  // także te, które inne urządzenie zapisało przed chwilą
    state.badges.set(me.id, all);
    // Pokazujemy tylko to, co naprawdę trafiło do bazy teraz (drugie urządzenie nie pokaże tego samego)
    const added = new Set((data || []).map(row => row.badge_id));
    const shown = fresh.filter(b => added.has(b.id));
    if (shown.length) showBadgeAward(shown);
  } catch (err) {
    console.error('Error saving badges:', err);
  } finally {
    syncing = false;
  }
}

export function renderBadgesCard(ranked) {
  const grid = document.getElementById('badges-grid');
  const index = ranked.findIndex(r => r.key === viewerId());
  const me = ranked[index] || { key: viewerId(), books: [] };
  const earned = new Set(shownBadges(me, index + 1, ranked).map(b => b.id));

  document.getElementById('badges-count').textContent = `${earned.size}/${BADGES.length}`;
  grid.replaceChildren(...BADGES.map(b => el('div', { class: `badge-item${earned.has(b.id) ? ' earned' : ''}` }, [
    el('span', { class: 'badge-icon' }, [icon(b.icon)]),
    el('span', { class: 'badge-text' }, [
      el('span', { class: 'badge-name', text: b.name }),
      el('span', { class: 'badge-desc', text: b.desc }),
    ]),
  ])));
}
