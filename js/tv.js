import { groupByReader } from './data.js';
import { daysSince } from './form.js';
import { hideRace3d, showRace3d } from './race3d.js';
import { avatar } from './ranking.js';
import { closeSettings } from './shell.js';
import { coverEl } from './shelf.js';
import { state } from './state.js';
import { compactNumber, formatDay, seriesColors } from './stats.js';
import { supabaseClient } from './supabase.js';
import { hideTowers3d, showTowers3d } from './towers3d.js';
import { currentYear, el, friendlyError, icon, refreshIcons, showToast } from './ui.js';

/* ----------------- Widok TV (?tv=token) ----------------- */
// Telewizor (np. Fully Kiosk Browser) otwiera czytanko.com/?tv=token i bez logowania pokazuje
// na zmianę: ranking, wyścig 3D, wieże okładek i „Teraz czytają”. Dane przychodzą z funkcji
// tv-feed, która sprawdza token. Nic tu nie da się kliknąć ani zmienić.

const TOKEN_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';  // bez l/1/o/0/i: łatwo wpisać pilotem
const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const PANELS = [
  { id: 'ranking', title: 'Ranking', ms: 15000 },
  { id: 'race', title: 'Wyścig', ms: 27000 },
  { id: 'towers', title: 'Wieże z książek', ms: 22000 },
  { id: 'reading', title: 'Teraz czytają', ms: 18000 },
];
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

async function saveToken() {
  const token = newToken();
  const { error } = await supabaseClient.from('tv_tokens').upsert({ user_id: state.currentUser.id, token }, { onConflict: 'user_id' });
  if (error) throw error;
  return token;
}

export async function openTvLinkDialog() {
  closeSettings();
  let token;
  try {
    token = (await ownToken()) || (await saveToken());
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
      token = await saveToken();
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
  prize: '',
  loaded: false,
};

export async function startTv(token) {
  tv.token = token.trim().toLowerCase();
  // Telewizor zawsze po ciemku (lepiej wygląda na dużym ekranie i nie razi wieczorem)
  document.documentElement.classList.add('dark-mode', 'tv-mode');
  document.querySelector('main.container').hidden = true;
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
  tv.dots = el('div', { class: 'tv-dots' }, PANELS.map(() => el('i')));
  tv.stage = el('div', { class: 'tv-stage' });
  tv.message = el('div', { class: 'tv-message', hidden: '' });
  tv.stage.appendChild(tv.message);

  PANELS.forEach(p => {
    const panel = el('section', { class: `tv-panel tv-panel-${p.id}`, hidden: '' });
    tv.panels.set(p.id, panel);
    tv.stage.appendChild(panel);
  });
  // Karty 3D przenosimy z ekranu Statystyki (tam w trybie TV i tak nikt nie zajrzy)
  tv.panels.get('race').appendChild(document.getElementById('race3d'));
  tv.panels.get('towers').appendChild(document.getElementById('towers3d'));

  tv.root = el('div', { id: 'tv', class: 'tv' }, [
    el('header', { class: 'tv-header' }, [
      el('span', { class: 'tv-brand', text: 'Czytanko' }),
      tv.title,
      el('div', { class: 'tv-time' }, [tv.clock, tv.date]),
    ]),
    tv.stage,
    tv.dots,
  ]);
  document.body.appendChild(tv.root);
}

function tickClock() {
  const now = new Date();
  tv.clock.textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
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
  hideRace3d();
  hideTowers3d();
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
  tv.prize = data.prize || '';
  renderRanking();
  renderReading();
  tv.message.hidden = true;
  if (!tv.loaded) {
    tv.loaded = true;
    next();
  } else {
    // Odświeżenie w trakcie: aktualny panel 3D sam przebuduje scenę, jeśli dane się zmieniły
    const current = PANELS[tv.index]?.id;
    if (current === 'race') showRace3d(false);
    if (current === 'towers') showTowers3d(false);
  }
}

// Kolejny panel: chowamy poprzedni (3D przestaje rysować), pokazujemy następny
function next() {
  const prev = PANELS[tv.index];
  tv.index = (tv.index + 1) % PANELS.length;
  const panel = PANELS[tv.index];
  if (prev) tv.panels.get(prev.id).hidden = true;
  if (prev?.id === 'race') hideRace3d();
  if (prev?.id === 'towers') hideTowers3d();

  tv.panels.get(panel.id).hidden = false;
  tv.title.textContent = panel.title;
  [...tv.dots.children].forEach((dot, i) => dot.classList.toggle('on', i === tv.index));
  // Wyścig i wieże za każdym razem odgrywają się od początku
  if (panel.id === 'race') requestAnimationFrame(() => showRace3d(true));
  if (panel.id === 'towers') requestAnimationFrame(() => showTowers3d(true));
  clearTimeout(tv.timer);
  tv.timer = setTimeout(next, panel.ms);
}

function renderRanking() {
  const readers = [...state.statsReaders].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'pl'));
  const colors = seriesColors(state.statsReaders);
  const max = Math.max(1, ...readers.map(r => r.points));
  const rows = readers.map((r, i) => {
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
  });
  tv.panels.get('ranking').replaceChildren(
    el('div', { class: 'tv-rank' }, rows.length ? rows : [el('div', { class: 'tv-message', text: 'Jeszcze nikt nic nie przeczytał w tym roku.' })]),
    ...(tv.prize ? [el('div', { class: 'tv-prize' }, [icon('gift'), el('span', { text: `Nagroda ${currentYear()}: ${tv.prize}` })])] : []),
  );
  refreshIcons();
}

function bookCard(book, lines) {
  return el('div', { class: 'tv-book' }, [
    coverEl(book, 'large'),
    el('strong', { class: 'tv-book-title', text: book.title || 'bez tytułu' }),
    ...lines.map(text => el('span', { class: 'tv-book-meta', text })),
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
