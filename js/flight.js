import { hideRace3d, showRace3d } from './race3d.js';
import { state } from './state.js';
import { createTron } from './tron.js';
import { el } from './ui.js';

/* ----------------- Karta „Wyścig na żywo” na Statystykach ----------------- */
// Jedna karta, dwa wyścigi do wyboru przełącznikiem: neonowy lot przez rok (domyślnie; ten sam
// co wygaszacz na TV, js/tron.js) albo książkowy tor 3D (js/race3d.js; three.js wczytuje się
// dopiero po przełączeniu). Lot leci, gdy karta jest w kadrze, poza tym stoi (oszczędza
// baterię). Dwuklik = pełny ekran.

const view = { active: false, visible: false, full: false, running: false };
let tron = null;
let host = null;

function mount() {
  if (tron) return true;
  host = document.getElementById('flight');
  if (!host) return false;
  // Neonowa czcionka napisów (bez niej rysuje się systemową)
  document.head.appendChild(el('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700;800&display=swap' }));
  tron = createTron(host, { maxScale: Math.min(window.devicePixelRatio || 1, 2) });
  new ResizeObserver(() => tron.resize()).observe(host);
  new IntersectionObserver(entries => {
    view.visible = entries.some(e => e.isIntersecting);
    update();
  }, { threshold: 0.2 }).observe(host);
  document.addEventListener('visibilitychange', update);
  host.addEventListener('dblclick', toggleFull);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && view.full) toggleFull();
  });
  return true;
}

function update() {
  const run = view.active && view.visible && document.visibilityState === 'visible';
  if (run === view.running) return;
  view.running = run;
  if (run) tron.start();
  else tron.stop();
}

function showFlight() {
  view.active = true;
  if (!state.hasData || !mount()) return;
  tron.setData(state.statsReaders, state.statsRows);
  update();
}

function hideFlight() {
  view.active = false;
  if (view.full) toggleFull();
  if (tron) update();
}

function toggleFull() {
  view.full = !view.full;
  host.classList.toggle('flight-full', view.full);
  document.body.classList.toggle('r3d-lock', view.full);
}

/* ----- Przełącznik neonowy / książkowy ----- */
let mode = 'neon';
let onScreen = false;  // jesteśmy na Statystykach

export function showRaceCard(replay = false) {
  onScreen = true;
  if (mode === 'neon') showFlight();
  else showRace3d(replay);
}

export function hideRaceCard() {
  onScreen = false;
  hideFlight();
  hideRace3d();
}

function setRaceMode(next) {
  if (next === mode) return;
  mode = next;
  document.querySelectorAll('.race-mode-btn').forEach(btn => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('[data-race-mode]').forEach(node => { node.hidden = node.dataset.raceMode !== mode; });
  if (!onScreen) return;
  if (mode === 'neon') {
    hideRace3d();
    showFlight();
  } else {
    hideFlight();
    showRace3d(true);
  }
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.race-mode-btn');
  if (btn) setRaceMode(btn.dataset.mode);
});
