import { goalJokeThisOpen, isKrystian } from './discourage.js';
import { loadPrize, viewerId } from './admin.js';
import { loadStoredBadges, renderBadgesCard, syncMyBadges } from './badges.js';
import { renderStartWall } from './coverwall.js';
import { avatar, renderRankingViz } from './ranking.js';
import { applyFinishDefault, daysSince, formatMultiplier, myReadingNow, selectFinishing, startFinishing, updateFormUI } from './form.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { ratingControl, renderBookRanking } from './ratings.js';
import { renderWrapped } from './wrapped.js';
import { coverEl, openBookModal, openReadingModal, readingCoverOf } from './shelf.js';
import { state } from './state.js';
import { formatDay, renderStats, seriesColors } from './stats.js';
import { supabaseClient } from './supabase.js';
import { currentYear, DAY_MS, el, friendlyError, icon, refreshIcons } from './ui.js';

/* ----------------- Data loading ----------------- */

export function groupByReader(rows) {
  const readers = new Map();
  rows.forEach(r => {
    if (!readers.has(r.user_id)) {
      readers.set(r.user_id, {
        key: r.user_id,
        name: r.profiles?.display_name || '?',
        inMoneyPrize: !!r.profiles?.in_money_prize,
        avatarUrl: r.profiles?.avatar_url || null,
        color: r.profiles?.color || null,
        points: 0,
        books: [],
      });
    }
    const reader = readers.get(r.user_id);
    reader.points += bookPoints(r);
    reader.books.push(r);
  });
  return [...readers.values()];
}

// Komunikat zamiast danych: ładowanie, błąd (z przyciskiem ponów) albo pusto
export function renderStatus(text, withRetry = false) {
  const retry = () => {
    const btn = el('button', { type: 'button', class: 'btn btn-outline btn-sm', text: 'Spróbuj ponownie' });
    btn.addEventListener('click', loadReads);
    return btn;
  };

  const makeBox = () => {
    const box = el('div', { class: 'status-box' }, [el('span', { text })]);
    if (withRetry) box.appendChild(retry());
    return box;
  };
  document.getElementById('ranking-viz').replaceChildren(makeBox());
}

// Numer ostatniego żądania: wolniejsza, starsza odpowiedź nie nadpisze nowszych danych
let readsSeq = 0;

export function invalidateReads() {
  readsSeq++;
}

export async function loadReads() {
  const seq = ++readsSeq;
  const year = currentYear();
  document.querySelectorAll('.current-year').forEach(span => { span.textContent = year; });

  if (!state.hasData) renderStatus('Ładowanie…');
  loadPrize();

  // Rywalizacja resetuje się co roku: tylko wpisy od 1 stycznia (czas lokalny)
  const [readsResult, nowResult, queueResult] = await Promise.all([
    supabaseClient
      .from('reads')
      .select('id, user_id, title, pages, multiplier, unfinished, rating, created_at, started_at, author, published_year, cover_url, info_url, description, info_checked_at, multiplier_labels, profiles(display_name, in_money_prize, avatar_url, color)')
      .gte('created_at', new Date(year, 0, 1).toISOString())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    supabaseClient
      .from('reading_now')
      .select('id, user_id, title, started_at, cover_url, author, published_year, page_count, info_url, description, info_checked_at, profiles(display_name)')
      .order('started_at', { ascending: true }),
    supabaseClient
      .from('reading_queue')
      .select('id, title, author')
      .eq('user_id', state.currentUser.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    loadStoredBadges(),  // wynik trafia do state.badges, błąd nie blokuje reszty
  ]);
  const { data: rows, error } = readsResult;
  if (seq !== readsSeq) return;

  if (error) {
    console.error('Error loading reads:', error);
    // Przy odświeżeniu w tle zostawiamy to, co już widać
    if (!state.hasData) renderStatus('Nie udało się wczytać wpisów. ' + friendlyError(error), true);
    return;
  }
  if (nowResult.error) console.error('Error loading reading_now:', nowResult.error);
  state.readingNow = nowResult.data || [];
  if (queueResult.error) console.error('Error loading reading queue:', queueResult.error);
  state.myQueue = queueResult.data || [];
  if (state.startingFromQueue && !state.myQueue.some(q => q.id === state.startingFromQueue.id)) state.startingFromQueue = null;
  // Formularz: odśwież listę zaczętych i domyślny wybór
  if (state.finishing && !myReadingNow().some(item => item.id === state.finishing.id)) selectFinishing(null);
  applyFinishDefault();
  updateFormUI();

  state.hasData = true;
  const readers = groupByReader(rows || []);
  renderLeaderboard(readers);
  renderGoal(readers);
  renderReadingNow();
  renderStats(readers, rows || []);
  renderBookRanking();
  renderWrapped();
  renderStartWall();
  refreshIcons();
}

/* ----------------- Teraz czytam ----------------- */

export function readingNowLabel(item) {
  const days = daysSince(item.started_at);
  return `od ${formatDay(new Date(item.started_at))} · ${days} ${days === 1 ? 'dzień' : 'dni'}`;
}

export function renderReadingNow() {
  const mine = state.readingNow.filter(item => item.user_id === viewerId());
  const card = document.getElementById('reading-now-card');
  card.hidden = !mine.length;
  // W podglądzie jako ktoś inny bez przycisków: to nie nasze książki
  const canAct = viewerId() === state.currentUser?.id;

  document.getElementById('reading-now-list').replaceChildren(...mine.map(item => {
    const actions = canAct
      ? [
          (() => {
            const done = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, [icon('check'), el('span', { text: 'Skończone' })]);
            done.addEventListener('click', () => startFinishing(item));
            return done;
          })(),
          actionButton('x', 'Usuń z „Teraz czytam”', () => handleDropReading(item)),
        ]
      : [];
    const info = readingCoverOf(item);
    // Okładka i tytuł otwierają okno książki (okładka przelatuje do niego)
    const open = el('button', { type: 'button', class: 'reading-now-open', 'aria-label': `${item.title}: szczegóły` }, [
      ...(info?.cover_url ? [coverEl({ title: item.title, cover_url: info.cover_url }, 'mini')] : []),
      el('div', { class: 'reading-now-info' }, [
        el('span', { class: 'reading-now-title', text: item.title }),
        el('span', { class: 'reading-now-meta', text: readingNowLabel(item) }),
      ]),
    ]);
    open.addEventListener('click', () => openReadingModal(item, open.querySelector('.book-cover')));
    return el('div', { class: 'reading-now-item' }, [
      open,
      el('div', { class: 'reading-now-actions' }, actions),
    ]);
  }));
}

export async function handleDropReading(item) {
  if (!confirm(`Usunąć „${item.title}” z „Teraz czytam”? Książka nie trafi do rankingu.`)) return false;
  const { data, error } = await supabaseClient.from('reading_now').delete().eq('id', item.id).select('id');
  if (error || !data?.length) {
    alert('Nie udało się usunąć: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
    return false;
  }
  await loadReads();
  return true;
}

/* ----------------- Plan na 1. miejsce ----------------- */
// Liczba po polsku: małe z jednym miejscem po przecinku, większe zaokrąglone
export function formatRate(n) {
  return n < 10 ? n.toFixed(1).replace('.', ',') : String(Math.round(n));
}

// Tempo każdego = punkty od 1 stycznia / dni od 1 stycznia. Zakładamy, że rywale utrzymają tempo
// do końca roku, i liczymy, ile dziennie trzeba czytać, żeby skończyć rok przed najlepszym z nich.
// Para etykieta + wartość w jednym <div> (dozwolone w <dl>), żeby zajmowała jedną komórkę siatki
export function goalFact(label, value) {
  return [el('div', { class: 'goal-fact' }, [el('dt', { text: label }), el('dd', { text: value })])];
}

// Żart: co 6. otwarcie aplikacji Krystian czyta w tej karcie, że nic nie musi czytać
function applyGoalJoke(readers) {
  const me = readers.find(r => r.key === viewerId());
  const name = me?.name ?? document.getElementById('display-name').textContent;
  if (!goalJokeThisOpen || !isKrystian(name)) return;
  document.getElementById('goal-number').textContent = '';
  document.getElementById('goal-unit').textContent = 'Nic nie musisz czytać';
  document.getElementById('goal-sub').textContent = 'Masz wystarczająco stron.';
}

export function renderGoal(readers) {
  renderGoalCore(readers);
  applyGoalJoke(readers);
}

function renderGoalCore(readers) {
  const card = document.getElementById('goal-card');
  if (!state.currentUser) {
    card.hidden = true;
    return;
  }

  const now = new Date();
  const year = now.getFullYear();
  const daysElapsed = Math.max(1, (now - new Date(year, 0, 1)) / DAY_MS);
  const daysLeft = Math.max(1, (new Date(year + 1, 0, 1) - now) / DAY_MS);

  const me = readers.find(r => r.key === viewerId());
  const myPoints = me ? me.points : 0;
  const myPace = myPoints / daysElapsed;
  const others = readers.filter(r => r.key !== viewerId());

  const number = document.getElementById('goal-number');
  const unit = document.getElementById('goal-unit');
  const sub = document.getElementById('goal-sub');
  const facts = document.getElementById('goal-facts');
  card.hidden = false;

  if (!others.length) {
    number.textContent = '';
    unit.textContent = 'Na razie nie masz rywali w tym roku.';
    sub.textContent = '';
    facts.replaceChildren(...goalFact('Twoje tempo', `${formatRate(myPace)} str./dzień`));
    return;
  }

  const pace = r => r.points / daysElapsed;
  const projected = r => r.points + pace(r) * daysLeft;
  const rival = others.reduce((best, r) => (projected(r) > projected(best) ? r : best));
  const rivalFinal = projected(rival);
  const leaderNow = others.reduce((best, r) => (r.points > best.points ? r : best));
  const neededPerDay = (rivalFinal - myPoints + 1) / daysLeft;

  if (neededPerDay <= 0) {
    number.textContent = '';
    unit.textContent = 'Wygrywasz, nawet jeśli już nic nie przeczytasz';
    sub.textContent = 'przy obecnym tempie rywali';
  } else {
    const perDay = Math.ceil(neededPerDay);
    number.textContent = String(perDay);
    unit.textContent = 'stron dziennie';
    sub.textContent = `czyli ok. ${perDay * 7} tygodniowo do końca roku`;
  }

  const gapNow = leaderNow.points - myPoints;
  facts.replaceChildren(
    ...(gapNow >= 0
      ? goalFact('Do 1. miejsca', `${gapNow + 1} pkt`)
      : goalFact('Prowadzisz o', `${-gapNow} pkt`)),
    ...goalFact('Twoje tempo', `${formatRate(myPace)} str./dzień`),
    ...goalFact(`Rywal: ${rival.name.split(' ')[0]}`, `${formatRate(pace(rival))} str./dzień`),
    ...goalFact('Prognoza rywala', `${Math.round(rivalFinal)} pkt`),
  );
}

export function renderLeaderboard(readers) {
  const ranked = [...readers].sort((a, b) => b.points - a.points);
  state.lastRanked = ranked.map(r => ({ key: r.key, name: r.name, points: r.points }));
  renderRankingViz(ranked, personBooks);
  renderBadgesCard(ranked);
  syncMyBadges(ranked);

  if (state.currentUser) {
    const rankIndex = ranked.findIndex(r => r.key === viewerId());
    const me = ranked[rankIndex];
    document.getElementById('stat-total-points').textContent = me ? String(me.points) : '0';
    document.getElementById('stat-rank').textContent = rankIndex !== -1 ? `#${rankIndex + 1}` : '#--';
  }
}

export function actionButton(iconName, label, onClick) {
  const btn = el('button', { type: 'button', class: 'btn btn-outline btn-icon', 'aria-label': label, title: label }, [icon(iconName)]);
  btn.addEventListener('click', onClick);
  return btn;
}

// Książki jednej osoby, rozwijane z jej wiersza w rankingu: najpierw czytane teraz, potem
// przeczytane od najnowszej. Wiersz: mała okładka, tytuł, pod nim szary opis, wynik po prawej.
// Stuknięcie otwiera okno książki (jak na Półce): tam ocena i edycja.
function personBookRow(cover, title, meta, side, onOpen) {
  const row = el('button', { type: 'button', class: 'rb-book' }, [
    el('span', { class: 'rb-cover' }, [cover]),
    el('span', { class: 'rb-main' }, [
      el('span', { class: 'rb-title', text: title || '—' }),
      el('span', { class: 'rb-meta' }, meta),
    ]),
    el('span', { class: 'rb-side' }, side),
  ]);
  row.addEventListener('click', () => onOpen(row.querySelector('.book-cover')));
  return el('li', {}, [row]);
}

export function personBooks(reader) {
  const year = currentYear();

  const books = [...reader.books].reverse().map(book => {
    const when = new Date(book.created_at);
    const mult = Number(book.multiplier);
    const meta = [
      el('span', { text: `${formatDay(when)}${when.getFullYear() !== year ? ` ${when.getFullYear()}` : ''} · ${book.pages} str.` }),
      ...(mult !== 1 ? [el('span', { class: 'rb-mult', text: `×${formatMultiplier(mult).replace('.', ',')}` })] : []),
      ...(book.unfinished ? [el('span', { text: 'niedokończona' })] : []),
    ];
    const side = [
      ...[ratingControl(book, false)].filter(Boolean),
      el('span', { class: 'rb-score' }, [document.createTextNode(String(bookPoints(book))), el('small', { text: ' pkt' })]),
    ];
    return personBookRow(coverEl(book), book.title, meta, side, cover => openBookModal(book, cover));
  });

  const current = state.readingNow.filter(item => item.user_id === reader.key).map(item => {
    const info = readingCoverOf(item);
    return personBookRow(
      coverEl({ title: item.title, cover_url: info?.cover_url }),
      item.title,
      [el('span', { text: readingNowLabel(item) })],
      [el('span', { class: 'rb-now', text: 'czyta' })],
      cover => openReadingModal(item, cover),
    );
  });
  return [
    ...(current.length ? [el('ul', { class: 'rb-list' }, current)] : []),
    el('ul', { class: 'rb-list' }, books),
  ];
}
