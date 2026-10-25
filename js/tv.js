import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { buildCoverWall, wallCover } from './coverwall.js';
import { groupByReader } from './data.js';
import { daysSince } from './form.js';
import { recordItems } from './insights.js';
import { avatar } from './ranking.js';
import { closeSettings } from './shell.js';
import { coverEl } from './shelf.js';
import { state } from './state.js';
import { buildRaceSeries, compactNumber, formatDay, MONTHS_PL as MONTHS_SHORT, seriesColors, valueAt } from './stats.js';
import { supabaseClient } from './supabase.js';
import { createTron } from './tron.js';
import { currentYear, DAY_MS, el, friendlyError, icon, refreshIcons, showToast } from './ui.js';

/* ----------------- Widok TV (?tv=token) ----------------- */
// Telewizor (np. Fully Kiosk Browser) otwiera czytanko.com/?tv=token i bez logowania pokazuje
// na zmianę kilka ekranów ze statystykami. Dane przychodzą z funkcji tv-feed, która sprawdza
// token. Nic tu nie da się kliknąć ani zmienić.

const TOKEN_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';  // bez l/1/o/0/i: łatwo wpisać pilotem
const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const DAYS_PL = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MONTHS_FULL = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

const firstName = name => (name || '?').split(' ')[0];
const pl = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

export function tvLink(token) {
  return `${window.location.origin}${window.location.pathname}?tv=${token}`;
}

/* ----------------- Ustawienia: „Link do TV” ----------------- */
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(b => TOKEN_CHARS[b % TOKEN_CHARS.length]).join('');
}

async function ownToken() {
  const { data, error } = await supabaseClient.from('tv_tokens').select('token').eq('user_id', state.currentUser.id).maybeSingle();
  if (error) throw error;
  return data?.token || null;
}

// Baza pozwala wpisać tylko token (user_id bierze się z konta), więc bez upsert:
// pierwszy link = insert, „Nowy link” = podmiana tokenu w istniejącym wierszu
async function saveToken(replace) {
  const token = newToken();
  const { error } = replace
    ? await supabaseClient.from('tv_tokens').update({ token, created_at: new Date().toISOString() }).eq('user_id', state.currentUser.id)
    : await supabaseClient.from('tv_tokens').insert({ token });
  if (error) throw error;
  return token;
}

export async function openTvLinkDialog() {
  closeSettings();
  let token;
  try {
    token = (await ownToken()) || (await saveToken(false));
  } catch (err) {
    showToast('Nie udało się przygotować linku: ' + friendlyError(err));
    return;
  }

  const linkText = el('code', { class: 'tv-link' });
  const setLink = t => { linkText.textContent = tvLink(t); };
  setLink(token);

  const copy = el('button', { type: 'button', class: 'btn btn-primary' }, [icon('copy'), el('span', { text: 'Kopiuj' })]);
  const preview = el('a', { class: 'btn btn-outline', href: tvLink(token), target: '_blank', rel: 'noopener' }, [icon('tv'), el('span', { text: 'Podgląd' })]);
  const renew = el('button', { type: 'button', class: 'btn btn-outline' }, [icon('refresh-cw'), el('span', { text: 'Nowy link' })]);
  const disable = el('button', { type: 'button', class: 'btn btn-outline cancel-btn' }, [icon('link-2-off'), el('span', { text: 'Wyłącz' })]);
  const close = el('button', { type: 'button', class: 'btn btn-outline', text: 'Zamknij' });

  const finish = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = e => { if (e.key === 'Escape') finish(); };

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tvLink(token));
      showToast('Skopiowano link.');
    } catch {
      showToast('Nie udało się skopiować; przepisz adres z okienka.');
    }
  });
  renew.addEventListener('click', async () => {
    if (!confirm('Nowy link? Stary przestanie działać na telewizorze.')) return;
    try {
      token = await saveToken(true);
      setLink(token);
      preview.href = tvLink(token);
      showToast('Nowy link gotowy.');
    } catch (err) {
      showToast('Nie udało się: ' + friendlyError(err));
    }
  });
  disable.addEventListener('click', async () => {
    if (!confirm('Wyłączyć link? Telewizor przestanie pokazywać Czytanko.')) return;
    const { error } = await supabaseClient.from('tv_tokens').delete().eq('user_id', state.currentUser.id);
    if (error) {
      showToast('Nie udało się: ' + friendlyError(error));
      return;
    }
    showToast('Link wyłączony.');
    finish();
  });
  close.addEventListener('click', finish);

  const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tv-link-title' }, [
    el('div', { class: 'modal-content tv-link-modal' }, [
      el('div', { class: 'modal-icon' }, [icon('tv')]),
      el('h2', { id: 'tv-link-title', class: 'modal-title', text: 'Czytanko na telewizorze' }),
      el('p', { text: 'Otwórz ten adres na telewizorze, np. w Fully Kiosk Browser jako stronę startową. Pokaże na zmianę ranking, wyścig 3D, wieże okładek i to, co teraz czytacie. Bez logowania, tylko do oglądania.' }),
      linkText,
      el('p', { class: 'hint', text: 'Kto ma link, ten widzi statystyki. Jeśli wyciekł, zrób nowy albo go wyłącz.' }),
      el('div', { class: 'tv-link-actions' }, [copy, preview, renew, disable, close]),
    ]),
  ]);
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', e => { if (e.target === overlay) finish(); });
  document.body.appendChild(overlay);
  refreshIcons();
}

/* ----------------- Sam widok TV ----------------- */
// Wszystko na zwykłym HTML/CSS (bez WebGL), bo procesory telewizorów nie dają rady scenom 3D.
// Każdy panel ma render (przy każdych nowych danych), a niektóre enter/leave: animacja rusza
// od początku przy każdym pokazaniu i staje, gdy panel znika. full = bez nagłówka, cały ekran.
const PANELS = [
  { id: 'wall', title: '', ms: 60000, full: true, render: renderWall, enter: startWall, leave: stopWall },
  { id: 'tron', title: '', ms: 60000, full: true, render: renderTron, enter: () => tv.tron?.start(), leave: () => tv.tron?.stop() },
  { id: 'ranking', title: 'Ranking', ms: 14000, render: renderRanking },
  { id: 'race', title: 'Wyścig roku', ms: 19000, render: renderRaceBars, enter: startRaceBars, leave: stopRaceBars },
  { id: 'mosaic', title: 'Okładki roku', ms: 18000, render: renderMosaic, enter: startMosaic, leave: stopMosaic },
  { id: 'numbers', title: 'Rok w liczbach', ms: 14000, render: renderNumbers, enter: startNumbers, leave: stopNumbers },
  { id: 'records', title: 'Rekordy', ms: 16000, render: renderRecordsTv },
  { id: 'calendar', title: 'Kalendarz czytania', ms: 15000, render: renderCalendar },
  { id: 'reading', title: 'Teraz czytają', ms: 16000, render: renderReading },
];
// Na razie telewizor pokazuje dwa wygaszacze na zmianę (okładki i Tron, co minutę); pozostałe
// ekrany są gotowe, wystarczy dopisać ich id, żeby wróciły do rotacji
const SHOWN = ['wall', 'tron'];
const ROTATION = PANELS.filter(p => SHOWN.includes(p.id));
const RACE_MS = 13000;     // cały rok w wyścigu słupkowym
const COUNT_MS = 1800;     // odliczanie liczb w „Rok w liczbach”
const GLOW_MS = 3200;      // co ile na ścianie podświetla się któraś okładka

const tv = {
  token: null,
  root: null,
  stage: null,
  panels: new Map(),
  dots: null,
  message: null,
  title: null,
  clock: null,
  date: null,
  index: -1,
  timer: null,
  loaded: false,
  race: null,
  raceFrame: null,
  countFrame: null,
  mosaicAnim: null,
  miniClock: null,
  wallSig: null,
  glowTimer: null,
  tron: null,
};

export async function startTv(token) {
  tv.token = token.trim().toLowerCase();
  // Telewizor zawsze po ciemku (lepiej wygląda na dużym ekranie i nie razi wieczorem)
  document.documentElement.classList.add('dark-mode', 'tv-mode');
  document.querySelector('main.container').hidden = true;
  // Neonowa czcionka do wygaszacza Tron (bez niej rysuje się systemową)
  document.head.appendChild(el('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700;800&display=swap' }));
  buildTv();
  tickClock();
  setInterval(tickClock, 15000);
  await load();
  setInterval(load, REFRESH_MS);
}

function buildTv() {
  tv.title = el('h2', { class: 'tv-title' });
  tv.clock = el('strong', { class: 'tv-clock' });
  tv.date = el('span', { class: 'tv-date' });
  tv.miniClock = el('div', { class: 'tv-mini-clock' });
  tv.dots = el('div', { class: 'tv-dots' }, ROTATION.map(() => el('i')));
  tv.stage = el('div', { class: 'tv-stage' });
  tv.message = el('div', { class: 'tv-message', hidden: '' });
  tv.stage.appendChild(tv.message);
  ROTATION.forEach(p => {
    const panel = el('section', { class: `tv-panel tv-panel-${p.id}`, hidden: '' });
    tv.panels.set(p.id, panel);
    tv.stage.appendChild(panel);
  });
  tv.root = el('div', { id: 'tv', class: 'tv' }, [
    el('header', { class: 'tv-header' }, [
      el('span', { class: 'tv-brand', text: 'Czytanko' }),
      tv.title,
      el('div', { class: 'tv-time' }, [tv.clock, tv.date]),
    ]),
    tv.stage,
    tv.dots,
    tv.miniClock,
  ]);
  document.body.appendChild(tv.root);
  // Ściana okładek liczy kolumny z rozmiaru ekranu
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!tv.loaded) return;
      ROTATION.forEach(p => p.render());
      ROTATION[tv.index]?.enter?.();
    }, 300);
  });
}

function tickClock() {
  const now = new Date();
  tv.clock.textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  tv.miniClock.textContent = tv.clock.textContent;
  tv.date.textContent = `${DAYS_PL[now.getDay()]}, ${now.getDate()} ${MONTHS_FULL[now.getMonth()]}`;
  // W nocy przygaszamy ekran
  const h = now.getHours();
  document.documentElement.classList.toggle('tv-night', h >= 23 || h < 6);
}

async function load() {
  const year = currentYear();
  try {
    const { data, error } = await supabaseClient.functions.invoke('tv-feed', {
      body: { token: tv.token, since: new Date(year, 0, 1).toISOString(), year },
    });
    if (error) {
      // 403 = zły albo wyłączony token; wtedy nie ma sensu pokazywać starych danych
      if (error.context?.status === 403) {
        showMessage('Ten link do telewizora jest nieaktywny. Zrób nowy w Czytanko: Ustawienia → Czytanko na telewizorze.');
        return;
      }
      throw error;
    }
    apply(data);
  } catch (err) {
    console.error('tv-feed failed:', err);
    // Gdy coś już widać, zostawiamy stare dane do następnego odświeżenia
    if (!tv.loaded) {
      showMessage('Nie udało się wczytać danych. Spróbuję ponownie za minutę.');
      setTimeout(load, RETRY_MS);
    }
  }
}

// Komunikat to osobna warstwa nad panelami: po udanym wczytaniu po prostu znika
function showMessage(text) {
  clearTimeout(tv.timer);
  ROTATION[tv.index]?.leave?.();
  tv.root.classList.remove('tv-full');
  tv.panels.forEach(panel => { panel.hidden = true; });
  tv.message.textContent = text;
  tv.message.hidden = false;
  tv.title.textContent = '';
  tv.loaded = false;
  tv.index = -1;
}

function apply(data) {
  const rows = data.reads || [];
  state.hasData = true;
  state.readingNow = data.readingNow || [];
  state.statsReaders = groupByReader(rows);
  state.statsRows = rows;
  ROTATION.forEach(p => p.render());
  refreshIcons();
  tv.message.hidden = true;
  if (!tv.loaded) {
    tv.loaded = true;
    next();
  } else {
    // Odświeżenie w trakcie: panel z animacją zaczyna ją od nowa na świeżych danych
    ROTATION[tv.index]?.enter?.();
  }
}

// Kolejny panel: poprzedni zatrzymuje animacje, następny zaczyna je od początku.
// Jeden panel w rotacji = zostaje na stałe.
function next() {
  const prev = ROTATION[tv.index];
  tv.index = (tv.index + 1) % ROTATION.length;
  const panel = ROTATION[tv.index];
  if (prev && prev !== panel) {
    prev.leave?.();
    tv.panels.get(prev.id).hidden = true;
  }
  tv.panels.get(panel.id).hidden = false;
  tv.root.classList.toggle('tv-full', !!panel.full);
  tv.title.textContent = panel.title;
  [...tv.dots.children].forEach((dot, i) => dot.classList.toggle('on', i === tv.index));
  requestAnimationFrame(() => panel.enter?.());
  clearTimeout(tv.timer);
  if (ROTATION.length > 1) tv.timer = setTimeout(next, panel.ms);
}

const sortedReaders = () => [...state.statsReaders].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'pl'));
const colorsOf = () => seriesColors(state.statsReaders);

function emptyPanel(id, text) {
  tv.panels.get(id).replaceChildren(el('div', { class: 'tv-message', text }));
}

/* ----- Ściana okładek (animacja „idle”, js/coverwall.js) ----- */
// Okładki z tego roku (i te czytane teraz); świecąca okładka pokazuje, kto ją czytał
function wallBooks() {
  const colors = colorsOf();
  const book = (r, userId, who) => ({
    title: r.title, author: r.author, cover_url: r.cover_url,
    who: firstName(who), color: colors.get(userId) || 'var(--series-other)',
  });
  return [
    ...state.statsRows.map(r => book(r, r.user_id, r.profiles?.display_name)),
    ...state.readingNow.map(i => book(i, i.user_id, i.profiles?.display_name)),
  ];
}

function wallTile(b) {
  const cover = wallCover(b);
  const who = el('span', { class: 'tv-tile-who', text: b.who });
  who.style.background = b.color;
  return el('div', { class: 'tv-wall-tile' }, [cover, who]);
}

function renderWall() {
  const books = wallBooks();
  // Bez zmian w okładkach i rozmiarze ekranu nie budujemy od nowa (animacja by przeskoczyła)
  const sig = `${window.innerWidth}x${window.innerHeight}|${books.map(b => `${b.title}|${b.cover_url}|${b.who}`).join('~')}`;
  if (sig === tv.wallSig) return;
  tv.wallSig = sig;
  if (!books.length) {
    emptyPanel('wall', 'Tu pojawią się okładki przeczytanych książek.');
    return;
  }
  const vh = window.innerHeight / 100;
  tv.panels.get('wall').replaceChildren(
    buildCoverWall(books, {
      width: window.innerWidth,
      height: window.innerHeight,
      tile: 17 * vh,
      gap: 1.6 * vh,
      speed: [1.8 * vh, 3.6 * vh],
      tileEl: wallTile,
    }),
    el('div', { class: 'tv-wall-shade' }),
  );
}

/* ----- Wygaszacz Tron (js/tron.js) ----- */
function renderTron() {
  tv.tron ||= createTron(tv.panels.get('tron'));
  tv.tron.setData(state.statsReaders, state.statsRows);
}

// Co kilka sekund któraś okładka w środkowej części ekranu delikatnie się powiększa i świeci
function startWall() {
  stopWall();
  tv.glowTimer = setInterval(() => {
    const tiles = [...tv.panels.get('wall').querySelectorAll('.tv-wall-tile:not(.glow)')];
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let tries = 0; tries < 12 && tiles.length; tries++) {
      const tile = tiles[Math.floor(Math.random() * tiles.length)];
      const r = tile.getBoundingClientRect();
      if (r.left > w * 0.12 && r.right < w * 0.88 && r.top > h * 0.12 && r.bottom < h * 0.88) {
        tile.classList.add('glow');
        setTimeout(() => tile.classList.remove('glow'), GLOW_MS * 0.85);
        break;
      }
    }
  }, GLOW_MS);
}

function stopWall() {
  clearInterval(tv.glowTimer);
  tv.glowTimer = null;
}

/* ----- Ranking ----- */
function renderRanking() {
  const readers = sortedReaders();
  const colors = colorsOf();
  if (!readers.length) {
    emptyPanel('ranking', 'Jeszcze nikt nic nie przeczytał w tym roku.');
    return;
  }
  const max = Math.max(1, ...readers.map(r => r.points));
  tv.panels.get('ranking').replaceChildren(el('div', { class: 'tv-rank' }, readers.map((r, i) => {
    const bar = el('span', { class: 'tv-bar-fill' });
    bar.style.width = `${(r.points / max) * 100}%`;
    bar.style.background = colors.get(r.key);
    return el('div', { class: `tv-rank-row${i === 0 ? ' lead' : ''}` }, [
      el('span', { class: 'tv-rank-pos', text: String(i + 1) }),
      avatar(r, colors, 'rank-avatar-lg'),
      el('div', { class: 'tv-rank-main' }, [
        el('div', { class: 'tv-rank-line' }, [
          el('span', { class: 'tv-rank-name', text: firstName(r.name) }),
          ...(i === 0 ? [el('span', { class: 'tv-crown' }, [icon('crown')])] : []),
          el('span', { class: 'tv-rank-books', text: `${r.books.length} ${pl(r.books.length, 'książka', 'książki', 'książek')}` }),
        ]),
        el('span', { class: 'tv-bar' }, [bar]),
      ]),
      el('strong', { class: 'tv-rank-pts', text: `${compactNumber(r.points)} pkt` }),
    ]);
  })));
}

/* ----- Wyścig słupkowy ----- */
// Paski osób rosną przez cały rok i zamieniają się miejscami, gdy ktoś kogoś wyprzedzi
function renderRaceBars() {
  const series = buildRaceSeries(state.statsReaders, state.statsRows);
  if (!series.length) {
    tv.race = null;
    emptyPanel('race', 'Wyścig ruszy po pierwszej książce.');
    return;
  }
  const colors = colorsOf();
  const byKey = new Map(state.statsReaders.map(r => [r.key, r]));
  const rowH = Math.min(13, 66 / series.length);  // vh na wiersz
  const rows = series.map(s => {
    const fill = el('span', { class: 'tv-race-fill' });
    fill.style.background = s.color;
    fill.style.color = s.color;  // poświata (box-shadow: currentColor) w kolorze osoby
    const value = el('strong', { class: 'tv-race-value' });
    const crown = el('span', { class: 'tv-crown', hidden: '' }, [icon('crown')]);
    const row = el('div', { class: 'tv-race-row' }, [
      avatar(byKey.get(s.key), colors, 'rank-avatar-lg'),
      el('span', { class: 'tv-race-name' }, [document.createTextNode(firstName(s.name)), crown]),
      el('span', { class: 'tv-race-track' }, [fill, value]),
    ]);
    row.style.height = `${rowH * 0.8}vh`;
    return { s, row, fill, value, crown };
  });
  const date = el('div', { class: 'tv-race-date' });
  const list = el('div', { class: 'tv-race-list' }, rows.map(r => r.row));
  list.style.height = `${rowH * series.length}vh`;
  const t0 = new Date(currentYear(), 0, 1).getTime();
  tv.race = { rows, date, rowH, t0, t1: Math.max(Date.now(), t0 + DAY_MS) };
  tv.panels.get('race').replaceChildren(date, list);
  setRaceFrame(1);
}

function setRaceFrame(p) {
  const { rows, date, rowH, t0, t1 } = tv.race;
  const t = t0 + p * (t1 - t0);
  const values = rows.map(r => valueAt(r.s, t));
  const max = Math.max(1, ...values);
  const order = rows.map((r, i) => i).sort((a, b) => values[b] - values[a] || rows[a].s.name.localeCompare(rows[b].s.name, 'pl'));
  order.forEach((i, rank) => {
    const r = rows[i];
    r.fill.style.width = `${(values[i] / max) * 100}%`;
    r.value.textContent = `${compactNumber(values[i])} pkt`;
    r.row.style.transform = `translateY(${rank * rowH}vh)`;
    r.crown.hidden = rank !== 0 || values[i] === 0;
  });
  date.textContent = p >= 1 ? 'dziś' : formatDay(new Date(t));
}

function startRaceBars() {
  stopRaceBars();
  if (!tv.race) return;
  const start = performance.now();
  const step = now => {
    // Pod koniec zwalnia, żeby ostatnie dni było widać
    const k = Math.min(1, (now - start) / RACE_MS);
    setRaceFrame(1 - (1 - k) ** 1.6);
    tv.raceFrame = k < 1 ? requestAnimationFrame(step) : null;
  };
  setRaceFrame(0);
  tv.raceFrame = requestAnimationFrame(step);
}

function stopRaceBars() {
  cancelAnimationFrame(tv.raceFrame);
  tv.raceFrame = null;
}

/* ----- Mozaika okładek ----- */
// Wszystkie okładki roku (najnowsze pierwsze); gdy się nie mieszczą, ściana powoli zjeżdża w dół
function renderMosaic() {
  const colors = colorsOf();
  const rows = [...state.statsRows].reverse();
  if (!rows.length) {
    emptyPanel('mosaic', 'Tu pojawią się okładki przeczytanych książek.');
    return;
  }
  const grid = el('div', { class: 'tv-mosaic' }, rows.map((r, i) => {
    const who = el('span', { class: 'tv-tile-who', text: firstName(r.profiles?.display_name) });
    who.style.background = colors.get(r.user_id);
    const tile = el('div', { class: 'tv-tile' }, [coverEl(r), who]);
    tile.style.animationDelay = `${Math.min(i, 30) * 40}ms`;
    return tile;
  }));
  tv.panels.get('mosaic').replaceChildren(el('div', { class: 'tv-mosaic-viewport' }, [grid]));
}

function startMosaic() {
  stopMosaic();
  const viewport = tv.panels.get('mosaic').querySelector('.tv-mosaic-viewport');
  const grid = viewport?.firstChild;
  if (!grid) return;
  const overflow = grid.scrollHeight - viewport.clientHeight;
  if (overflow <= 0) return;
  const duration = PANELS.find(p => p.id === 'mosaic').ms - 3000;
  tv.mosaicAnim = grid.animate(
    [{ transform: 'translateY(0)' }, { transform: `translateY(${-overflow}px)` }],
    { duration, delay: 1500, easing: 'ease-in-out', fill: 'forwards' },
  );
}

function stopMosaic() {
  tv.mosaicAnim?.cancel();
  tv.mosaicAnim = null;
}

/* ----- Rok w liczbach ----- */
function renderNumbers() {
  const rows = state.statsRows;
  if (!rows.length) {
    emptyPanel('numbers', 'Liczby pojawią się po pierwszej książce.');
    return;
  }
  const pages = rows.reduce((s, r) => s + r.pages, 0);
  const points = state.statsReaders.reduce((s, r) => s + r.points, 0);
  const longest = rows.reduce((a, b) => (b.pages > a.pages ? b : a));
  const dayOfYear = Math.max(1, Math.ceil((Date.now() - new Date(currentYear(), 0, 1).getTime()) / DAY_MS));
  // Kartka ma 2 strony i ~0,1 mm grubości
  const stackCm = Math.round((pages / 2) * 0.01);
  const stack = stackCm >= 100 ? `${String(Math.round(stackCm / 10) / 10).replace('.', ',')} m` : `${stackCm} cm`;
  const tile = (value, label, sub = '') => el('div', { class: 'tv-num' }, [
    el('strong', { class: 'tv-num-value', 'data-target': String(value), text: '0' }),
    el('span', { class: 'tv-num-label', text: label }),
    ...(sub ? [el('span', { class: 'tv-num-sub', text: sub })] : []),
  ]);
  tv.panels.get('numbers').replaceChildren(el('div', { class: 'tv-nums' }, [
    tile(pages, 'stron razem', `stos kartek wysokości ok. ${stack}`),
    tile(rows.length, pl(rows.length, 'książka', 'książki', 'książek')),
    tile(points, 'punktów'),
    tile(Math.round(pages / rows.length), 'średnio stron na książkę'),
    tile(Math.round(pages / dayOfYear), 'stron dziennie (razem)'),
    tile(longest.pages, 'stron ma najdłuższa', `${longest.title || 'bez tytułu'} · ${firstName(longest.profiles?.display_name)}`),
  ]));
  setCounts(1);
}

function setCounts(k) {
  tv.panels.get('numbers').querySelectorAll('.tv-num-value').forEach(node => {
    const target = Number(node.dataset.target);
    node.textContent = Math.round(target * k).toLocaleString('pl-PL');
  });
}

function startNumbers() {
  stopNumbers();
  const start = performance.now();
  const step = now => {
    const k = Math.min(1, (now - start) / COUNT_MS);
    setCounts(1 - (1 - k) ** 3);
    tv.countFrame = k < 1 ? requestAnimationFrame(step) : null;
  };
  setCounts(0);
  tv.countFrame = requestAnimationFrame(step);
}

function stopNumbers() {
  cancelAnimationFrame(tv.countFrame);
  tv.countFrame = null;
}

/* ----- Rekordy ----- */
function renderRecordsTv() {
  const items = recordItems(state.statsReaders, state.statsRows).slice(0, 6);
  if (!items.length) {
    emptyPanel('records', 'Rekordy pojawią się po pierwszej książce.');
    return;
  }
  tv.panels.get('records').replaceChildren(el('div', { class: 'tv-records' }, items.map((r, i) => {
    const card = el('div', { class: 'tv-record' }, [
      el('span', { class: 'tv-record-icon' }, [icon(r.icon)]),
      el('span', { class: 'tv-record-label', text: r.label }),
      el('strong', { class: 'tv-record-main', text: r.main }),
      el('span', { class: 'tv-record-sub', text: r.sub }),
    ]);
    card.style.animationDelay = `${i * 120}ms`;
    return card;
  })));
}

/* ----- Kalendarz czytania ----- */
// Tydzień po tygodniu: im więcej punktów za skończone w tym tygodniu książki, tym mocniejszy kolor
function renderCalendar() {
  const readers = sortedReaders();
  if (!readers.length) {
    emptyPanel('calendar', 'Kalendarz zapełni się, gdy zaczniecie czytać.');
    return;
  }
  const colors = colorsOf();
  const t0 = new Date(currentYear(), 0, 1).getTime();
  const week = iso => Math.floor((new Date(iso).getTime() - t0) / (7 * DAY_MS));
  const weeks = Math.max(1, week(new Date().toISOString()) + 1);
  const sums = new Map(readers.map(r => [r.key, new Array(weeks).fill(0)]));
  state.statsRows.forEach(row => {
    const w = week(row.created_at);
    const list = sums.get(row.user_id);
    if (list && w >= 0 && w < weeks) list[w] += bookPoints(row);
  });
  const max = Math.max(1, ...[...sums.values()].flat());

  const columns = `minmax(0, 11vw) repeat(${weeks}, minmax(0, 1fr))`;
  const months = el('div', { class: 'tv-cal-row tv-cal-months' }, [el('span')]);
  months.style.gridTemplateColumns = columns;
  for (let m = 0; m <= new Date().getMonth(); m++) {
    const label = el('span', { class: 'tv-cal-month', text: MONTHS_SHORT[m] });
    label.style.gridColumn = `${week(new Date(currentYear(), m, 1).toISOString()) + 2}`;
    months.appendChild(label);
  }
  const rows = readers.map(r => {
    const cells = sums.get(r.key).map(v => {
      const cell = el('i', { class: 'tv-cal-cell' });
      if (v > 0) {
        cell.style.background = colors.get(r.key);
        cell.style.opacity = String(0.35 + 0.65 * (v / max));
      }
      return cell;
    });
    const row = el('div', { class: 'tv-cal-row' }, [
      el('span', { class: 'tv-cal-who' }, [avatar(r, colors), el('span', { text: firstName(r.name) })]),
      ...cells,
    ]);
    row.style.gridTemplateColumns = columns;
    return row;
  });
  tv.panels.get('calendar').replaceChildren(el('div', { class: 'tv-cal' }, [
    months,
    ...rows,
    el('p', { class: 'tv-cal-hint', text: 'Każdy kwadrat to tydzień. Im mocniejszy kolor, tym więcej punktów za skończone wtedy książki.' }),
  ]));
}

/* ----- Teraz czytają ----- */
function bookCard(book, lines) {
  return el('div', { class: 'tv-book' }, [
    coverEl(book, 'large'),
    el('strong', { class: 'tv-book-title', text: book.title || 'bez tytułu' }),
    el('span', { class: 'tv-book-meta', text: lines.join(' · ') }),
  ]);
}

function renderReading() {
  const now = state.readingNow.map(item => {
    const days = daysSince(item.started_at);
    return bookCard(
      { title: item.title, author: item.author, cover_url: item.cover_url },
      [firstName(item.profiles?.display_name), `od ${days} ${days === 1 ? 'dnia' : 'dni'}`],
    );
  });
  const recent = [...state.statsRows].reverse().slice(0, 6).map(r => bookCard(r, [
    firstName(r.profiles?.display_name), `skończona ${formatDay(new Date(r.created_at))}`,
  ]));
  tv.panels.get('reading').replaceChildren(
    el('div', { class: 'tv-shelf' }, [
      el('h3', { class: 'tv-shelf-title', text: 'Teraz czytają' }),
      el('div', { class: 'tv-books' }, now.length ? now : [el('span', { class: 'tv-book-meta', text: 'Nikt teraz nic nie czyta.' })]),
    ]),
    el('div', { class: 'tv-shelf' }, [
      el('h3', { class: 'tv-shelf-title', text: 'Ostatnio skończone' }),
      el('div', { class: 'tv-books' }, recent),
    ]),
  );
}
