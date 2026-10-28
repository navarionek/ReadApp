import { einkEnabled } from './eink.js';
import { currentScreen, goTo } from './shell.js';

/* ----------------- Przyciski do przewracania stron (tryb czytnika) ----------------- */
// Czytniki z fizycznymi przyciskami (np. Onyx Boox) wysyłają do przeglądarki klawisze PageDown / PageUp.
// Działają jak przewracanie kartek: najpierw przewijają ekran o stronę, a na samym dole (górze) przechodzą
// do następnego (poprzedniego) ekranu apki. Poprzedni ekran otwiera się od końca, jak cofnięcie kartki.
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

function turn(direction) {
  const page = Math.round(window.innerHeight * 0.85);
  const root = document.documentElement;
  const atTop = window.scrollY <= 2;
  const atBottom = Math.ceil(window.scrollY + window.innerHeight) >= root.scrollHeight - 4;
  if (direction > 0 ? !atBottom : !atTop) {
    window.scrollBy({ top: direction * page, behavior: 'instant' });
    return;
  }
  const index = ORDER.indexOf(currentScreen());
  const target = ORDER[index + direction];
  if (index < 0 || !target) return;
  goTo(target);
  // Ekran zmienia się po zdarzeniu hashchange; potem ustawiamy początek (dalej) albo koniec (wstecz)
  setTimeout(() => window.scrollTo({ top: direction > 0 ? 0 : document.documentElement.scrollHeight, behavior: 'instant' }), 80);
}

export function initPageKeys() {
  document.addEventListener('keydown', e => {
    if (!einkEnabled() || blocked(e)) return;
    const direction = NEXT.has(e.key) || NEXT_CODES.has(e.keyCode) ? 1 : PREV.has(e.key) || PREV_CODES.has(e.keyCode) ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    turn(direction);
  });
}
