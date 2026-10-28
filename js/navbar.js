/* ----------------- Pasek menu: wskaźnik aktywnej zakładki ----------------- */
// Kolorowa pigułka pod aktywną zakładką. Przy zmianie zakładki przeskakuje do niej (sprężyście, z lekkim
// rozciągnięciem w locie), a jej kolor płynnie przechodzi w kolor nowej zakładki (kolory w style.css,
// po data-active na pasku). Ruch to wyłącznie transformacje, więc telefon składa go na karcie graficznej.
let indicator = null;
let ready = false;

function place(animate) {
  const nav = document.getElementById('app-nav');
  const active = nav?.querySelector('.nav-item.active');
  if (!indicator || !active || !nav.offsetWidth) return;
  nav.dataset.active = active.dataset.screen;
  const x = `${active.offsetLeft}px`;
  const moved = indicator.style.getPropertyValue('--x') !== x;
  indicator.style.setProperty('--x', x);
  indicator.style.setProperty('--y', `${active.offsetTop}px`);
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.height = `${active.offsetHeight}px`;
  if (!ready) {
    // Pierwsze ustawienie bez przejazdu; przejścia włączamy klatkę później
    requestAnimationFrame(() => requestAnimationFrame(() => { nav.classList.add('ready'); ready = true; }));
    return;
  }
  if (animate && moved) {
    indicator.classList.remove('stretch');
    void indicator.offsetWidth;  // od nowa, także przy szybkim przeklikiwaniu
    indicator.classList.add('stretch');
  }
}

export function moveNavIndicator() {
  place(true);
}

export function initNavIndicator() {
  const nav = document.getElementById('app-nav');
  if (!nav || indicator) return;
  indicator = document.createElement('span');
  indicator.className = 'nav-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  nav.prepend(indicator);
  // Pasek bywa ukryty (przed zalogowaniem) albo zmienia szerokość (obrót telefonu): wtedy ustawiamy od nowa
  new ResizeObserver(() => place(false)).observe(nav);
  place(false);
}
