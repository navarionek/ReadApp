import { einkEnabled } from './eink.js';
import { currentScreen, goTo } from './shell.js';

/* ----------------- Przyciski do zmiany zakładek (tryb czytnika) ----------------- */
// Fizyczne przyciski czytnika (np. Onyx Boox) wysyłają do przeglądarki klawisze PageDown / PageUp.
// Tu przełączają zakładki apki (Start, Dodaj, Półka, Ranking, Statystyki): w przód i wstecz, po ostatniej
// wraca się na pierwszą. Nic nie przewija strony.
const ORDER = ['start', 'dodaj', 'polka', 'ranking', 'statystyki'];
const NEXT = new Set(['PageDown', 'ArrowRight', 'MediaTrackNext']);
const PREV = new Set(['PageUp', 'ArrowLeft', 'MediaTrackPrevious']);
const NEXT_CODES = new Set([34, 39, 176]);  // starsze przeglądarki podają tylko keyCode
const PREV_CODES = new Set([33, 37, 177]);

function blocked(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return true;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return true;
  // Okno książki, edytor, menu i inne pełnoekranowe widoki mają własną obsługę
  if (document.body.classList.contains('be-lock') || document.body.classList.contains('r3d-lock')) return true;
  if (!document.getElementById('book-modal').hidden || !document.getElementById('settings-menu').hidden) return true;
  return document.getElementById('app-screens').hidden;
}

function switchTab(direction) {
  const index = ORDER.indexOf(currentScreen());
  if (index < 0) return;
  goTo(ORDER[(index + direction + ORDER.length) % ORDER.length]);
  // Nowa zakładka zawsze od góry (ekran zmienia się po zdarzeniu hashchange)
  setTimeout(() => window.scrollTo({ top: 0, behavior: 'instant' }), 80);
}

export function initPageKeys() {
  document.addEventListener('keydown', e => {
    if (!einkEnabled() || blocked(e)) return;
    const direction = NEXT.has(e.key) || NEXT_CODES.has(e.keyCode) ? 1 : PREV.has(e.key) || PREV_CODES.has(e.keyCode) ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    switchTab(direction);
  });
}
