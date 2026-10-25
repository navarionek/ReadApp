import { renderInsights } from './insights.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { showFlight } from './flight.js';
import { showRace3d } from './race3d.js';
import { showTowers3d } from './towers3d.js';
import { currentScreen } from './shell.js';
import { state } from './state.js';
import { currentYear, DAY_MS, el } from './ui.js';

/* ----------------- Statystyki i wyścig ----------------- */
export const MONTHS_PL = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const SERIES_SLOTS = 8;
export const RACE_DURATION_MS = 6000;
export const RACE_LOOKAHEAD_DAYS = 45;     // skala „widzi” wpisy z najbliższych ~6 tygodni
export const RACE_SCALE_SMOOTH_MS = 400;   // jak szybko skala dojeżdża do celu (stała czasowa)


export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.appendChild(child);
  return node;
}

export function formatDay(date) {
  return `${date.getDate()} ${MONTHS_PL[date.getMonth()]}`;
}

// Kolor idzie za osobą (stała kolejność alfabetyczna), nie za miejscem w rankingu,
// więc nie zmienia się, gdy ktoś kogoś wyprzedzi. Własny kolor osoby (z profilu) ma pierwszeństwo.
export function seriesColors(readers) {
  const sorted = [...readers].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  return new Map(sorted.map((r, i) => [r.key, r.color || (i < SERIES_SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)')]));
}

export function niceMax(value) {
  if (value <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * power >= value) return m * power;
  }
  return 10 * power;
}

export function compactNumber(n) {
  if (n < 1000) return String(n);
  return `${String(Math.round(n / 100) / 10).replace('.', ',')}K`;  // 11000 -> 11K, 12150 -> 12,2K
}

// Punkty narastająco. Książka z datą rozpoczęcia „przyrasta” równomiernie od startu do końca
// czytania (rampa), książka bez niej wskakuje w całości w dniu dodania (schodek).
export function buildRaceSeries(readers, rows) {
  const colors = seriesColors(readers);
  const t0 = new Date(currentYear(), 0, 1).getTime();
  const byKey = new Map(readers.map(r => [r.key, { key: r.key, name: r.name, color: colors.get(r.key), books: [], total: 0 }]));
  rows.forEach(row => {
    const s = byKey.get(row.user_id);
    if (!s) return;
    const end = new Date(row.created_at).getTime();
    // Zaczęte w zeszłym roku: całe punkty rozkładamy w tym roku
    const start = row.started_at ? Math.min(end, Math.max(t0, new Date(row.started_at).getTime())) : end;
    const pts = bookPoints(row);
    s.total += pts;
    s.books.push({ start, end, pts });
  });

  // Punkty załamania linii: początki i końce książek. Między nimi wartość zmienia się liniowo,
  // a w miejscu schodka są dwa punkty o tym samym czasie (przed i po).
  byKey.forEach(s => {
    const times = [...new Set(s.books.flatMap(b => [b.start, b.end]))].sort((a, b) => a - b);
    s.points = [];
    times.forEach(t => {
      const before = valueAt(s, t, true);
      const after = valueAt(s, t);
      if (before !== after) s.points.push({ t, v: before });
      s.points.push({ t, v: after });
    });
  });
  return [...byKey.values()];
}

// Wartość w chwili t; strictly = granica z lewej (schodek dnia t jeszcze nie wliczony)
export function valueAt(series, t, strictly = false) {
  let v = 0;
  for (const b of series.books) {
    if (b.end === b.start) {
      if (strictly ? b.end < t : b.end <= t) v += b.pts;
    } else if (t >= b.end) {
      v += b.pts;
    } else if (t > b.start) {
      v += (b.pts * (t - b.start)) / (b.end - b.start);
    }
  }
  return Math.round(v);
}

export function renderStats(readers, rows) {
  state.statsReaders = readers;
  state.statsRows = rows;
  renderStatTiles(rows);
  renderBooksChart(readers);
  renderInsights(readers, rows);
  if (currentScreen() !== 'statystyki') return;
  drawTimeline();
  showRace3d(state.racePending);
  showTowers3d(state.racePending);
  showFlight();
  if (state.racePending) {
    state.racePending = false;
    playRace();
  } else if (state.raceFrame === null) {
    // W tle (np. po powrocie do apki) tylko przerysuj; animacja startuje przy wejściu na ekran
    drawRace();
    setRaceProgress(state.raceProgress);
  }
}

/* ----------------- Kto co czytał kiedy (oś czasu) ----------------- */
export function drawTimeline() {
  const container = document.getElementById('timeline-chart');
  const width = container.clientWidth;
  if (!width) return;  // ekran niewidoczny

  const year = currentYear();
  const t0 = new Date(year, 0, 1).getTime();
  const t1 = Math.max(Date.now(), t0 + DAY_MS);
  const colors = seriesColors(state.statsReaders);
  const nameOf = new Map(state.statsReaders.map(r => [r.key, r.name]));
  state.readingNow.forEach(item => { if (!nameOf.has(item.user_id)) nameOf.set(item.user_id, item.profiles?.display_name || '?'); });

  // Odcinki: skończone książki z datą rozpoczęcia + czytane teraz (do dziś)
  const spans = [
    ...state.statsRows.filter(r => r.started_at).map(r => ({
      user: r.user_id, title: r.title || 'bez tytułu', open: false,
      start: Math.max(t0, new Date(r.started_at).getTime()), end: new Date(r.created_at).getTime(),
    })),
    ...state.readingNow.map(item => ({
      user: item.user_id, title: item.title, open: true,
      start: Math.max(t0, new Date(item.started_at).getTime()), end: t1,
    })),
  ].filter(s => s.end >= t0);

  if (!spans.length) {
    container.replaceChildren(el('div', { class: 'status-box', text: 'Pojawi się, gdy zaczniecie dodawać książki przez „Zaczynam czytać”.' }));
    return;
  }

  const people = [...new Set(spans.map(s => s.user))]
    .sort((a, b) => (nameOf.get(a) || '').localeCompare(nameOf.get(b) || '', 'pl'));
  const narrow = width < 480;
  const m = { top: 4, right: 8, bottom: 22, left: narrow ? 64 : 96 };
  const lane = 14;
  const x = t => m.left + ((t - t0) / (t1 - t0)) * (width - m.left - m.right);

  // Tory: książki czytane równolegle przez jedną osobę idą jedna pod drugą
  let yCursor = m.top;
  const rows = people.map(user => {
    const lanes = [];
    const items = spans.filter(s => s.user === user).sort((a, b) => a.start - b.start).map(s => {
      let i = lanes.findIndex(endT => endT < s.start);
      if (i === -1) { i = lanes.length; lanes.push(0); }
      lanes[i] = s.end;
      return { ...s, lane: i };
    });
    const row = { user, items, y: yCursor, h: Math.max(1, lanes.length) * lane + 8 };
    yCursor += row.h;
    return row;
  });
  const height = yCursor + m.bottom;

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'timeline-svg', role: 'img', 'aria-label': 'Kto co czytał kiedy' });

  const lastMonth = new Date(t1).getMonth();
  for (let month = 0; month <= lastMonth; month += narrow ? 2 : 1) {
    const mx = x(new Date(year, month, 1).getTime());
    svg.appendChild(svgEl('line', { x1: mx, x2: mx, y1: m.top, y2: height - m.bottom, class: 'grid-line' }));
    const label = svgEl('text', { x: mx, y: height - 8, class: 'axis-text' });
    label.textContent = MONTHS_PL[month];
    svg.appendChild(label);
  }

  rows.forEach((row, i) => {
    if (i > 0) svg.appendChild(svgEl('line', { x1: 0, x2: width, y1: row.y, y2: row.y, class: 'grid-line' }));
    const name = svgEl('text', { x: 0, y: row.y + 4 + lane / 2 + 4, class: 'timeline-name' });
    name.textContent = (nameOf.get(row.user) || '?').split(' ')[0];
    svg.appendChild(name);

    row.items.forEach(s => {
      const bx = x(s.start);
      const bw = Math.max(6, x(s.end) - bx);
      const bar = svgEl('rect', {
        x: bx, y: row.y + 4 + s.lane * lane + 3, width: bw, height: 8, rx: 4,
        class: s.open ? 'timeline-bar open' : 'timeline-bar',
        style: `fill: ${colors.get(s.user) || 'var(--series-other)'}`,
      });
      const days = Math.max(1, Math.round((s.end - s.start) / DAY_MS));
      const tip = svgEl('title');
      tip.textContent = s.open
        ? `${s.title}: od ${formatDay(new Date(s.start))}, czyta ${days} ${days === 1 ? 'dzień' : 'dni'}`
        : `${s.title}: ${formatDay(new Date(s.start))} – ${formatDay(new Date(s.end))} (${days} ${days === 1 ? 'dzień' : 'dni'})`;
      bar.appendChild(tip);
      svg.appendChild(bar);
    });
  });

  container.replaceChildren(svg);
}

export function renderStatTiles(rows) {
  const pages = rows.reduce((sum, r) => sum + r.pages, 0);
  const longest = rows.reduce((best, r) => (!best || r.pages > best.pages ? r : best), null);
  document.getElementById('tile-pages').textContent = compactNumber(pages);
  document.getElementById('tile-books').textContent = String(rows.length);
  document.getElementById('tile-avg').textContent = rows.length ? String(Math.round(pages / rows.length)) : '0';
  document.getElementById('tile-longest').textContent = longest ? `${longest.title || 'bez tytułu'} · ${longest.pages} str.` : '—';
}

export function renderBooksChart(readers) {
  const chart = document.getElementById('books-chart');
  if (!readers.length) {
    chart.replaceChildren(el('div', { class: 'status-box', text: 'Brak wpisów w tym roku.' }));
    return;
  }
  const colors = seriesColors(readers);
  const max = Math.max(...readers.map(r => r.books.length));
  const sorted = [...readers].sort((a, b) => b.books.length - a.books.length || a.name.localeCompare(b.name, 'pl'));

  chart.replaceChildren(...sorted.map(r => {
    const count = r.books.length;
    const bar = el('span', { class: 'bar', title: `${r.name}: ${count}` });
    bar.style.width = `${(count / max) * 100}%`;
    bar.style.background = colors.get(r.key);
    return el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label', text: r.name }),
      el('span', { class: 'bar-track' }, [bar, el('span', { class: 'bar-value', text: String(count) })]),
    ]);
  }));
}

export function renderRaceLegend(series) {
  document.getElementById('race-legend').replaceChildren(...series.map(s => {
    const key = el('span', { class: 'legend-line' });
    key.style.background = s.color;
    return el('span', { class: 'legend-item' }, [key, el('span', { text: s.name })]);
  }));
}

export function drawRace() {
  const container = document.getElementById('race-chart');
  const width = container.clientWidth;
  if (!width) return;  // ekran niewidoczny, nie ma czego mierzyć

  const series = buildRaceSeries(state.statsReaders, state.statsRows);
  renderRaceLegend(series);
  if (!series.length) {
    state.race = null;
    container.replaceChildren(el('div', { class: 'status-box', text: 'Brak wpisów w tym roku.' }));
    return;
  }

  const narrow = width < 480;
  const height = narrow ? 240 : 300;
  const m = { top: 12, right: narrow ? 92 : 120, bottom: 26, left: 40 };
  const year = currentYear();
  const t0 = new Date(year, 0, 1).getTime();
  const t1 = Math.max(Date.now(), t0 + DAY_MS);
  const plotRight = width - m.right;
  const x = t => m.left + ((t - t0) / (t1 - t0)) * (plotRight - m.left);

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'race-svg', role: 'img', 'aria-label': 'Punkty narastająco w ciągu roku dla każdej osoby' });

  // Siatka i oś Y przerysowywane w każdej klatce, bo skala rośnie razem z wynikami
  const grid = svgEl('g');
  svg.appendChild(grid);

  // Oś X: miesiące (na wąskim ekranie co drugi)
  const lastMonth = new Date(t1).getMonth();
  for (let month = 0; month <= lastMonth; month += narrow ? 2 : 1) {
    const label = svgEl('text', { x: x(new Date(year, month, 1).getTime()), y: height - 8, 'text-anchor': 'start', class: 'axis-text' });
    label.textContent = MONTHS_PL[month];
    svg.appendChild(label);
  }

  const lines = svgEl('g');
  series.forEach(s => {
    s.path = svgEl('path', { class: 'race-line', style: `stroke: ${s.color}` });
    lines.appendChild(s.path);
  });
  svg.appendChild(lines);

  const crosshair = svgEl('line', { y1: m.top, y2: height - m.bottom, class: 'crosshair', visibility: 'hidden' });
  svg.appendChild(crosshair);

  const leaders = svgEl('g');
  const dots = svgEl('g');
  const labels = svgEl('g');
  svg.append(leaders, dots, labels);

  series.forEach(s => {
    s.dot = svgEl('circle', { r: 4.5, class: 'race-dot', style: `fill: ${s.color}` });
    s.leader = svgEl('line', { class: 'leader-line' });
    s.label = svgEl('text', { class: 'race-label' });
    s.labelName = svgEl('tspan', { class: 'race-label-name' });
    s.labelValue = svgEl('tspan', { class: 'race-label-value', dx: 4 });
    s.label.append(s.labelName, s.labelValue);
    dots.appendChild(s.dot);
    leaders.appendChild(s.leader);
    labels.appendChild(s.label);
  });

  // Warstwa do najechania: krzyżyk szuka daty, dymek pokazuje wszystkich
  const overlay = svgEl('rect', { x: m.left, y: m.top, width: plotRight - m.left, height: height - m.top - m.bottom, class: 'race-overlay', tabindex: 0, 'aria-label': 'Przesuń, aby zobaczyć punkty w danym dniu' });
  svg.appendChild(overlay);

  const tooltip = el('div', { class: 'chart-tooltip', hidden: '' });
  container.replaceChildren(svg, tooltip);

  state.race = { series, x, t0, t1, m, width, height, plotRight, grid, crosshair, tooltip, focusT: t1, vMax: 100 };

  const onPointer = e => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    showRaceTooltip(t0 + ((px - m.left) / (plotRight - m.left)) * (t1 - t0));
  };
  overlay.addEventListener('pointermove', onPointer);
  overlay.addEventListener('pointerdown', onPointer);  // stuknięcie na telefonie
  overlay.addEventListener('pointerleave', hideRaceTooltip);
  overlay.addEventListener('focus', () => showRaceTooltip(state.race.focusT));
  overlay.addEventListener('blur', hideRaceTooltip);
  overlay.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    state.race.focusT += (e.key === 'ArrowRight' ? 7 : -7) * DAY_MS;
    showRaceTooltip(state.race.focusT);
  });
}

export function drawRaceGrid(y, vMax) {
  const { grid, m, plotRight } = state.race;
  const step = niceMax(vMax / 4);  // „ładny” krok osi: 1, 2, 2.5, 5 × 10^n
  const items = [];
  for (let v = 0; v <= vMax; v += step) {
    items.push(svgEl('line', { x1: m.left, x2: plotRight, y1: y(v), y2: y(v), class: v === 0 ? 'axis-line' : 'grid-line' }));
    const label = svgEl('text', { x: m.left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    label.textContent = compactNumber(Math.round(v));
    items.push(label);
  }
  grid.replaceChildren(...items);
}

// dt = czas od poprzedniej klatki animacji; null = narysuj od razu (bez wygładzania skali)
export function setRaceProgress(p, dt = null) {
  state.raceProgress = p;
  if (!state.race) return;
  const { series, x, t0, t1, m, plotRight, height } = state.race;
  const tCur = t0 + p * (t1 - t0);
  const xCur = x(tCur);
  document.getElementById('race-date').textContent = p < 1 ? formatDay(new Date(tCur)) : '';

  // Oś Y rośnie razem z liderem, ale płynnie: cel liczymy z wyprzedzeniem (wpis za kilka
  // tygodni już jest w skali), a pokazana skala dojeżdża do celu z wygładzaniem zamiast skakać
  const values = series.map(s => valueAt(s, tCur));
  const tAhead = Math.min(t1, tCur + RACE_LOOKAHEAD_DAYS * DAY_MS);
  // Minimum 20% wyniku końcowego: na początku roku nie robimy zbliżenia na prawie pusty wykres
  const floor = Math.max(100, Math.max(...series.map(s => s.total)) * 0.2);
  const target = Math.max(floor, Math.max(...series.map(s => valueAt(s, tAhead))) * 1.1);
  if (dt === null || !state.race.vMax) {
    state.race.vMax = target;
  } else {
    state.race.vMax += (target - state.race.vMax) * (1 - Math.exp(-dt / RACE_SCALE_SMOOTH_MS));
  }
  // Nigdy mniej niż bieżący lider, żeby linia nie wyszła ponad wykres
  state.race.vMax = Math.max(state.race.vMax, Math.max(...values) * 1.02);
  state.race.vMaxTarget = Math.max(target, state.race.vMax);
  const vMax = state.race.vMax;
  const y = v => height - m.bottom - (v / vMax) * (height - m.top - m.bottom);
  state.race.y = y;
  drawRaceGrid(y, vMax);

  // Linie do bieżącego dnia: proste odcinki między punktami załamania (rampy i schodki)
  series.forEach(s => {
    let d = `M${x(t0)},${y(0)}`;
    for (const pt of s.points) {
      if (pt.t > tCur) break;
      d += ` L${x(pt.t)},${y(pt.v)}`;
    }
    s.path.setAttribute('d', `${d} L${xCur},${y(valueAt(s, tCur))}`);
  });

  // Etykiety przy końcach linii; gdy się nakładają, rozsuwamy je i łączymy linią z kropką
  const items = series.map((s, i) => ({ s, v: values[i], dotY: y(values[i]), labelY: y(values[i]) }))
    .sort((a, b) => a.dotY - b.dotY);

  const gap = 16;
  for (let i = 1; i < items.length; i++) {
    items[i].labelY = Math.max(items[i].labelY, items[i - 1].labelY + gap);
  }
  const overflow = items.length ? items[items.length - 1].labelY - (height - m.bottom) : 0;
  if (overflow > 0) items.forEach(it => { it.labelY -= overflow; });
  for (let i = items.length - 2; i >= 0; i--) {
    items[i].labelY = Math.min(items[i].labelY, items[i + 1].labelY - gap);
  }

  const labelX = Math.min(xCur, plotRight) + 10;
  items.forEach(({ s, v, dotY, labelY }) => {
    s.dot.setAttribute('cx', xCur);
    s.dot.setAttribute('cy', dotY);
    s.label.setAttribute('x', labelX);
    s.label.setAttribute('y', labelY + 4);
    s.labelName.textContent = s.name.split(' ')[0];
    s.labelValue.textContent = String(v);
    const moved = Math.abs(labelY - dotY) > 3;
    s.leader.setAttribute('visibility', moved ? 'visible' : 'hidden');
    if (moved) {
      s.leader.setAttribute('x1', xCur + 5);
      s.leader.setAttribute('y1', dotY);
      s.leader.setAttribute('x2', labelX - 3);
      s.leader.setAttribute('y2', labelY);
    }
  });
}

export function playRace() {
  cancelAnimationFrame(state.raceFrame);
  state.raceFrame = null;
  drawRace();
  hideRaceTooltip();
  if (!state.race) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setRaceProgress(1);
    return;
  }

  const start = performance.now();
  let last = start;
  const step = now => {
    const p = Math.min(1, (now - start) / RACE_DURATION_MS);
    setRaceProgress(p, now - last);
    last = now;
    // Po dojściu do dziś skala jeszcze chwilę dojeżdża do celu, zamiast przeskoczyć na koniec
    const settled = Math.abs(state.race.vMaxTarget - state.race.vMax) < state.race.vMaxTarget * 0.002;
    state.raceFrame = p < 1 || !settled ? requestAnimationFrame(step) : null;
  };
  setRaceProgress(0);
  state.raceFrame = requestAnimationFrame(step);
}

export function showRaceTooltip(t) {
  if (!state.race || state.raceFrame !== null) return;  // w trakcie animacji bez dymka
  const { series, x, t0, t1, crosshair, tooltip, plotRight, m } = state.race;
  t = Math.min(t1, Math.max(t0, t));
  state.race.focusT = t;
  const px = x(t);
  crosshair.setAttribute('x1', px);
  crosshair.setAttribute('x2', px);
  crosshair.setAttribute('visibility', 'visible');

  const rows = series
    .map(s => ({ s, v: valueAt(s, t) }))
    .sort((a, b) => b.v - a.v)
    .map(({ s, v }) => {
      const key = el('span', { class: 'legend-line' });
      key.style.background = s.color;
      return el('div', { class: 'tooltip-row' }, [key, el('strong', { text: String(v) }), el('span', { text: s.name })]);
    });
  tooltip.replaceChildren(el('div', { class: 'tooltip-date', text: formatDay(new Date(t)) }), ...rows);
  tooltip.hidden = false;

  // Dymek po tej stronie krzyżyka, gdzie jest więcej miejsca
  const tipWidth = tooltip.offsetWidth;
  const left = px + 12 + tipWidth > state.race.width ? px - 12 - tipWidth : px + 12;
  tooltip.style.left = `${Math.max(m.left, Math.min(left, plotRight))}px`;
  tooltip.style.top = `${m.top}px`;
}

export function hideRaceTooltip() {
  if (!state.race) return;
  state.race.crosshair.setAttribute('visibility', 'hidden');
  state.race.tooltip.hidden = true;
}

let raceResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(raceResizeTimer);
  raceResizeTimer = setTimeout(() => {
    if (currentScreen() !== 'statystyki') return;
    drawTimeline();
    if (state.raceFrame !== null) return;
    drawRace();
    setRaceProgress(state.raceProgress);
  }, 150);
});
