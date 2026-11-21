/* ----------------- Rok wydania na okładkach półki ----------------- */
// Przełącznik w ustawieniach (zapamiętany na tym urządzeniu). Kafelki zawsze mają rok w środku,
// a widać go tylko z klasą show-pub-year na <html>, więc przełączenie nie rysuje półki od nowa.
const STORAGE_KEY = 'pubYear';

function pubYearEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function syncPubYear() {
  const on = pubYearEnabled();
  document.documentElement.classList.toggle('show-pub-year', on);
  document.getElementById('pub-year-toggle')?.setAttribute('aria-checked', String(on));
  document.getElementById('pub-year-switch')?.classList.toggle('on', on);
}

export function togglePubYear() {
  try {
    localStorage.setItem(STORAGE_KEY, pubYearEnabled() ? 'off' : 'on');
  } catch {}
  syncPubYear();
}
