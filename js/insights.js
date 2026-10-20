import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { seriesColors } from './stats.js';
import { DAY_MS, el, icon, refreshIcons } from './ui.js';

/* ----------------- Statystyki: tempo czytania, rekordy, rozkład długości książek ----------------- */
const MONTH_NAMES = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];

const firstName = name => (name || '?').split(' ')[0];
const formatRate = n => (n < 10 ? n.toFixed(1).replace('.', ',') : String(Math.round(n)));
const plural = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

// Dni czytania książki z datą rozpoczęcia (minimum 1, żeby nie dzielić przez zero)
const daysOf = b => Math.max(1, (new Date(b.created_at) - new Date(b.started_at)) / DAY_MS);
const isTimed = b => !!b.started_at && !b.unfinished;

function empty(text) {
  return el('div', { class: 'status-box', text });
}

/* ----- 1. Tempo czytania ----- */
function renderPace(readers, colors) {
  const container = document.getElementById('pace-chart');
  const stats = readers
    .map(r => {
      const timed = r.books.filter(isTimed);
      if (!timed.length) return null;
      const days = timed.reduce((sum, b) => sum + daysOf(b), 0);
      const pages = timed.reduce((sum, b) => sum + b.pages, 0);
      return { reader: r, n: timed.length, avgDays: days / timed.length, perDay: pages / days };
    })
    .filter(Boolean)
    .sort((a, b) => b.perDay - a.perDay);

  if (!stats.length) {
    container.replaceChildren(empty('Pojawi się, gdy zaczniecie dodawać książki przez „Zaczynam czytać”.'));
    return;
  }

  const max = stats[0].perDay;
  container.replaceChildren(...stats.map(s => {
    const bar = el('span', { class: 'bar', title: `${firstName(s.reader.name)}: ${formatRate(s.perDay)} str./dzień` });
    bar.style.width = `${Math.max(4, (s.perDay / max) * 65)}%`;  // zostaje miejsce na podpis z wartością
    bar.style.background = colors.get(s.reader.key);
    return el('div', { class: 'insight-item' }, [
      el('div', { class: 'bar-row' }, [
        el('span', { class: 'bar-label', text: firstName(s.reader.name) }),
        el('span', { class: 'bar-track' }, [bar, el('span', { class: 'bar-value', text: `${formatRate(s.perDay)} str./dzień` })]),
      ]),
      el('div', { class: 'insight-meta', text: `średnio ${formatRate(s.avgDays)} ${plural(Math.round(s.avgDays), 'dzień', 'dni', 'dni')} na książkę · ${s.n} ${plural(s.n, 'książka', 'książki', 'książek')} z datą startu` }),
    ]);
  }));
}

/* ----- 2. Rekordy ----- */
function mondayOf(date) {
  const d = new Date(date);
  const back = (d.getDay() + 6) % 7;  // poniedziałek = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

function bestBucket(rows, keyOf) {
  const sums = new Map();
  rows.forEach(r => {
    const key = `${r.user_id}|${keyOf(new Date(r.created_at))}`;
    sums.set(key, (sums.get(key) || 0) + bookPoints(r));
  });
  let best = null;
  sums.forEach((points, key) => {
    if (!best || points > best.points) best = { points, key };
  });
  if (!best) return null;
  const [userId, bucket] = best.key.split('|');
  return { userId, bucket, points: best.points };
}

function record(iconName, label, main, sub) {
  return el('div', { class: 'record' }, [
    el('span', { class: 'record-icon' }, [icon(iconName)]),
    el('span', { class: 'record-label', text: label }),
    el('span', { class: 'record-main', text: main }),
    el('span', { class: 'record-sub', text: sub }),
  ]);
}

function renderRecords(readers, rows) {
  const container = document.getElementById('records-grid');
  const nameOf = new Map(readers.map(r => [r.key, firstName(r.name)]));
  const who = id => nameOf.get(id) || '?';
  const items = [];

  const timed = rows.filter(isTimed);
  if (timed.length) {
    const fastest = timed.reduce((best, b) => (b.pages / daysOf(b) > best.pages / daysOf(best) ? b : best));
    const days = Math.max(1, Math.round(daysOf(fastest)));
    items.push(record('zap', 'Najszybsza książka', fastest.title || 'bez tytułu', `${who(fastest.user_id)} · ${fastest.pages} str. w ${days} ${plural(days, 'dzień', 'dni', 'dni')}`));

    const slowest = timed.reduce((best, b) => (daysOf(b) > daysOf(best) ? b : best));
    const slowDays = Math.max(1, Math.round(daysOf(slowest)));
    items.push(record('turtle', 'Najwolniejsza książka', slowest.title || 'bez tytułu', `${who(slowest.user_id)} · ${slowDays} ${plural(slowDays, 'dzień', 'dni', 'dni')}`));
  }

  if (rows.length) {
    const top = rows.reduce((best, b) => (bookPoints(b) > bookPoints(best) ? b : best));
    items.push(record('gem', 'Najwięcej punktów za książkę', top.title || 'bez tytułu', `${who(top.user_id)} · ${bookPoints(top)} pkt`));

    const week = bestBucket(rows, d => mondayOf(d).getTime());
    if (week) {
      const monday = new Date(Number(week.bucket));
      items.push(record('calendar-days', 'Najlepszy tydzień', `${week.points} pkt`, `${who(week.userId)} · od ${monday.getDate()} ${MONTH_NAMES[monday.getMonth()].slice(0, 3)}`));
    }
    const month = bestBucket(rows, d => d.getMonth());
    if (month) {
      items.push(record('calendar', 'Najlepszy miesiąc', `${month.points} pkt`, `${who(month.userId)} · ${MONTH_NAMES[Number(month.bucket)]}`));
    }
  }

  container.replaceChildren(...(items.length ? items : [empty('Brak wpisów w tym roku.')]));
}

/* ----- 5. Rozkład długości książek ----- */
const BUCKETS = [
  { label: 'do 150 str.', test: p => p <= 150 },
  { label: '151–300', test: p => p > 150 && p <= 300 },
  { label: '301–500', test: p => p > 300 && p <= 500 },
  { label: '501–800', test: p => p > 500 && p <= 800 },
  { label: '800+', test: p => p > 800 },
];

function renderLengths(readers, rows, colors) {
  const container = document.getElementById('length-chart');
  const legend = document.getElementById('length-legend');
  const finished = rows.filter(r => !r.unfinished);
  if (!finished.length) {
    container.replaceChildren(empty('Brak skończonych książek w tym roku.'));
    legend.replaceChildren();
    return;
  }

  const data = BUCKETS.map(b => {
    const perReader = new Map();
    finished.filter(r => b.test(r.pages)).forEach(r => perReader.set(r.user_id, (perReader.get(r.user_id) || 0) + 1));
    return { ...b, perReader, total: [...perReader.values()].reduce((s, n) => s + n, 0) };
  });
  const max = Math.max(1, ...data.map(d => d.total));
  const order = [...readers].sort((a, b) => a.name.localeCompare(b.name, 'pl'));

  container.replaceChildren(...data.map(d => {
    const fill = el('div', { class: 'length-fill' }, order.filter(r => d.perReader.has(r.key)).map(r => {
      const seg = el('span', { class: 'length-seg', title: `${firstName(r.name)}: ${d.perReader.get(r.key)}` });
      seg.style.flexGrow = String(d.perReader.get(r.key));
      seg.style.background = colors.get(r.key);
      return seg;
    }));
    fill.style.width = d.total ? `${Math.max(6, (d.total / max) * 100)}%` : '0%';
    return el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label', text: d.label }),
      el('span', { class: 'bar-track' }, [fill, el('span', { class: 'bar-value', text: String(d.total) })]),
    ]);
  }));

  legend.replaceChildren(...order.map(r => {
    const key = el('span', { class: 'legend-line' });
    key.style.background = colors.get(r.key);
    return el('span', { class: 'legend-item' }, [key, el('span', { text: firstName(r.name) })]);
  }));
}

export function renderInsights(readers, rows) {
  const colors = seriesColors(readers);
  renderPace(readers, colors);
  renderRecords(readers, rows);
  renderLengths(readers, rows, colors);
  refreshIcons();
}
