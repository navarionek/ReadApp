import { loadPrize, viewerId } from './admin.js';
import { renderBadgesCard } from './badges.js';
import { renderRankingViz } from './ranking.js';
import { applyFinishDefault, daysSince, formatMultiplier, handleDelete, myReadingNow, selectFinishing, startEdit, startFinishing, updateFormUI } from './form.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { coverEl, readingCoverOf } from './shelf.js';
import { state } from './state.js';
import { formatDay, renderStats } from './stats.js';
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
  document.getElementById('user-progress-container').replaceChildren(makeBox());
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
      .select('id, user_id, title, pages, multiplier, unfinished, created_at, started_at, author, published_year, multiplier_labels, profiles(display_name, in_money_prize, avatar_url)')
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
  // Formularz nie jest w trakcie edycji: odśwież listę zaczętych i domyślny wybór
  if (!state.editingId) {
    if (state.finishing && !myReadingNow().some(item => item.id === state.finishing.id)) selectFinishing(null);
    applyFinishDefault();
    updateFormUI();
  }

  state.hasData = true;
  const readers = groupByReader(rows || []);
  renderLeaderboard(readers);
  renderGoal(readers);
  renderReadingNow();
  renderUserProgress(readers);
  renderStats(readers, rows || []);
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
    return el('div', { class: 'reading-now-item' }, [
      ...(info?.cover_url ? [coverEl({ title: item.title, cover_url: info.cover_url }, 'mini')] : []),
      el('div', { class: 'reading-now-info' }, [
        el('span', { class: 'reading-now-title', text: item.title }),
        el('span', { class: 'reading-now-meta', text: readingNowLabel(item) }),
      ]),
      el('div', { class: 'reading-now-actions' }, actions),
    ]);
  }));
}

export async function handleDropReading(item) {
  if (!confirm(`Usunąć „${item.title}” z „Teraz czytam”? Książka nie trafi do rankingu.`)) return;
  const { data, error } = await supabaseClient.from('reading_now').delete().eq('id', item.id).select('id');
  if (error || !data?.length) {
    alert('Nie udało się usunąć: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
    return;
  }
  await loadReads();
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

export function renderGoal(readers) {
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
  renderRankingViz(ranked);
  renderBadgesCard(ranked);

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

export function renderUserProgress(readers) {
  const container = document.getElementById('user-progress-container');
  if (!readers.length) {
    container.replaceChildren(el('div', { class: 'status-box', text: 'Nikt jeszcze nic nie dodał w tym roku.' }));
    return;
  }

  // Najpierw moje postępy, potem pozostałe osoby w dotychczasowej kolejności
  const mineFirst = [...readers].sort((a, b) =>
    (b.key === viewerId()) - (a.key === viewerId()));

  const blocks = mineFirst.map(reader => {
    const isMine = state.currentUser && reader.key === state.currentUser.id;

    const rows = reader.books.map(book => {
      const cells = [
        el('td', {}, [
          document.createTextNode(book.title || '—'),
          ...(book.unfinished ? [el('span', { class: 'unfinished-tag', text: 'niedokończona' })] : []),
        ]),
        // Na telefonie kolumna mnożnika jest schowana, a mnożnik pokazuje się przed stronami,
        // żeby liczby stron były wyrównane do prawej w jednej linii
        el('td', { class: 'text-right pages-cell' }, [
          ...(Number(book.multiplier) !== 1 ? [el('span', { class: 'mult-inline', text: `${formatMultiplier(book.multiplier)}x` })] : []),
          document.createTextNode(String(book.pages)),
        ]),
        el('td', { class: 'text-right col-mult', text: `${book.multiplier}x` }),
        el('td', { class: 'text-right score', text: String(bookPoints(book)) }),
      ];
      if (isMine) {
        cells.push(el('td', { class: 'actions-cell' }, [
          actionButton('pencil', 'Edytuj wpis', () => startEdit(book)),
          actionButton('trash-2', 'Usuń wpis', () => handleDelete(book)),
        ]));
      }
      return el('tr', {}, cells);
    });

    const headers = [
      el('th', { text: 'Tytuł' }),
      el('th', { class: 'text-right', text: 'Strony' }),
      el('th', { class: 'text-right col-mult', text: 'Mnożnik' }),
      el('th', { class: 'text-right', text: 'Wynik' }),
    ];
    if (isMine) headers.push(el('th', { class: 'actions-cell', 'aria-label': 'Akcje' }));

    const table = el('table', {}, [
      el('thead', {}, [el('tr', {}, headers)]),
      el('tbody', {}, rows),
    ]);

    const current = state.readingNow.filter(item => item.user_id === reader.key);
    return el('div', { class: 'user-progress-block' }, [
      el('h3', { class: 'user-name', text: reader.name }),
      ...current.map(item => el('p', { class: 'reading-now-line' }, [
        icon('book-open'),
        el('span', { text: `Czyta teraz: ${item.title}` }),
        el('span', { class: 'reading-now-meta', text: ` (${readingNowLabel(item)})` }),
      ])),
      el('div', { class: 'table-container' }, [table]),
    ]);
  });

  container.replaceChildren(...blocks);
}
