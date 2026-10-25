import { state } from './state.js';
import { createTron } from './tron.js';
import { el } from './ui.js';

/* ----------------- Karta „Neonowy wyścig” na Statystykach ----------------- */
// Ten sam lot przez rok co wygaszacz na TV (js/tron.js), tylko w karcie. Leci, gdy karta jest
// na ekranie Statystyk i w kadrze, poza tym stoi (oszczędza baterię). Dwuklik = pełny ekran.

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

export function showFlight() {
  view.active = true;
  if (!state.hasData || !mount()) return;
  tron.setData(state.statsReaders, state.statsRows);
  update();
}

export function hideFlight() {
  view.active = false;
  if (view.full) toggleFull();
  if (tron) update();
}

function toggleFull() {
  view.full = !view.full;
  host.classList.toggle('flight-full', view.full);
  document.body.classList.toggle('r3d-lock', view.full);
}
