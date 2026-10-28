import { onScreenShown } from './wallpause.js';
import { moveNavIndicator } from './navbar.js';
import { playRankingIntro } from './ranking.js';
import { resetForm } from './form.js';
import { hideRaceCard, showRaceCard } from './flight.js';
import { closeBookModal, loadShelf } from './shelf.js';
import { state } from './state.js';
import { drawTimeline, playRace } from './stats.js';
import { renderWrapped } from './wrapped.js';
import { icon, refreshIcons } from './ui.js';

export const AUTH_ONLY_SECTIONS = ['user-panel', 'app-nav', 'app-screens'];
export const SCREENS = ['start', 'dodaj', 'polka', 'ranking', 'statystyki', 'postepy', 'wrapped', 'admin'];
/* ----------------- Ekrany (menu) ----------------- */
// Ekran wynika z #hash w adresie, więc działa przycisk Wstecz.
// Nieznany hash (np. #access_token po powrocie z logowania Google) = Start; nie nadpisujemy go,
// bo supabase-js sam go czyta i czyści.
export function currentScreen() {
  const name = window.location.hash.slice(1);
  return SCREENS.includes(name) ? name : 'start';
}

let shownScreen = null;

export function showScreen(name) {
  if (name === 'admin' && !state.isAdmin) name = 'start';
  if (name === 'wrapped') name = 'start';  // Wrapped ukryty, dopóki nie będzie dopracowany
  // Postępy są teraz w Rankingu (wiersz osoby rozwija jej książki); stare linki prowadzą tam
  const toProgress = name === 'postepy';
  if (toProgress) name = 'ranking';
  // Wyjście z formularza w trakcie kończenia książki = porzucenie, żeby „Dodaj” było znowu puste
  if (name !== 'dodaj' && state.finishing) resetForm();
  // Karty nowego ekranu wjeżdżają po kolei (style.css, .screen-enter). Nie w trakcie intro na Starcie,
  // które samo wprowadza karty. Animacje ruszają same, gdy ekran przestaje być ukryty.
  const intro = document.documentElement.classList.contains('intro-pending')
    || document.body.classList.contains('wall-intro') || document.body.classList.contains('wall-intro-reveal');
  document.querySelectorAll('.screen').forEach(screen => {
    const shown = screen.dataset.screen === name;
    if (shown && name !== shownScreen) screen.classList.toggle('screen-enter', !intro);
    screen.hidden = !shown;
  });
  onScreenShown(name);
  shownScreen = name;
  document.querySelectorAll('.nav-item').forEach(item => {
    const active = item.dataset.screen === name;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  moveNavIndicator();
  window.scrollTo(0, 0);
  if (toProgress) requestAnimationFrame(() => document.getElementById('ranking-viz')?.scrollIntoView({ block: 'start' }));

  if (name === 'polka' && state.currentUser) loadShelf();
  if (name === 'ranking') playRankingIntro();
  if (name === 'wrapped') renderWrapped();
  if (name !== 'polka') closeBookModal();

  // Wyścig odpala się przy każdym wejściu na Statystyki (po wczytaniu danych)
  if (name === 'statystyki') {
    if (state.hasData) requestAnimationFrame(() => { drawTimeline(); playRace(); showRaceCard(true); });
    else state.racePending = true;
  } else {
    hideRaceCard();
    if (state.raceFrame !== null) {
      cancelAnimationFrame(state.raceFrame);
      state.raceFrame = null;
    }
  }
}

export function goTo(name) {
  if (window.location.hash === '#' + name) showScreen(name);
  else window.location.hash = name;
}

/* ----------------- Theme handling ----------------- */
export function setTheme(isDark) {
  document.documentElement.classList.toggle('dark-mode', isDark);
  // Pasek statusu telefonu w kolorze tła apki
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#0f172a' : '#f8fafc');
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) themeIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  document.getElementById('theme-toggle')?.setAttribute('aria-checked', String(isDark));
  document.getElementById('theme-switch')?.classList.toggle('on', isDark);
  try {
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  } catch {}
  refreshIcons();
}

export function toggleSettings() {
  const menu = document.getElementById('settings-menu');
  menu.hidden = !menu.hidden;
  document.getElementById('settings-btn').setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) menu.querySelector('.settings-item:not([hidden])')?.focus();
}

export function closeSettings() {
  const menu = document.getElementById('settings-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  document.getElementById('settings-btn').setAttribute('aria-expanded', 'false');
}

export function toggleTheme() {
  setTheme(!document.documentElement.classList.contains('dark-mode'));
}
