/* ----------------- Tryb czytnika (e-ink) ----------------- */
// Eksperyment: Start w wersji na ekrany e-ink (czytniki Onyx Boox itp.): czarno na białym, bez animacji,
// cieni, rozmycia i okładek w tle, z dużym drukiem. Domyślnie wyłączony, zapamiętany na tym urządzeniu.
// Klasę `eink` na <html> ustawia też skrypt w <head>, żeby nie migał zwykły wygląd.
const STORAGE_KEY = 'eink';

export function einkEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function syncEinkToggle() {
  const on = einkEnabled();
  document.documentElement.classList.toggle('eink', on);
  document.getElementById('eink-toggle')?.setAttribute('aria-checked', String(on));
  document.getElementById('eink-switch')?.classList.toggle('on', on);
}

// afterChange: odświeżenie rzeczy zależnych od trybu (np. tło z okładkami na Starcie)
export function toggleEink(afterChange) {
  try {
    localStorage.setItem(STORAGE_KEY, einkEnabled() ? 'off' : 'on');
  } catch {}
  syncEinkToggle();
  afterChange?.();
}
