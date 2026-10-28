/* ----------------- Tryb czytnika (e-ink) ----------------- */
// Eksperyment: Start w wersji na ekrany e-ink (czytniki Onyx Boox itp.): czarno na białym, bez animacji,
// cieni, rozmycia i okładek w tle, z dużym drukiem. Domyślnie wyłączony, zapamiętany na tym urządzeniu.
// Klasę `eink` na <html> ustawia też skrypt w <head>, żeby nie migał zwykły wygląd.
// Drugi styl czytnika, „Gazeta” (klasa `gazeta` obok `eink`): winieta z gotyckim tytułem i paskiem daty,
// nagłówki działów kapitalikami, inicjały, podwójne linie i ozdobniki jak w dzienniku.
const STORAGE_KEY = 'eink';
const STYLE_KEY = 'einkStyle';
const MASTHEAD_FONT = 'https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&display=swap';

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function einkEnabled() {
  return read(STORAGE_KEY) === 'on';
}

export function gazetaEnabled() {
  return einkEnabled() && read(STYLE_KEY) === 'gazeta';
}

const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const roman = n => ROMAN.reduce((out, [value, sign]) => {
  while (n >= value) {
    out += sign;
    n -= value;
  }
  return out;
}, '');

// Pasek pod winietą: rocznik, numer wydania (dzień roku), data i „cena”, jak w dzienniku
function dateline() {
  const now = new Date();
  const issue = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const date = now.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const line = document.createElement('div');
  line.className = 'gazeta-dateline';
  line.setAttribute('aria-hidden', 'true');
  for (const text of [`Rok ${roman(Math.max(1, now.getFullYear() - 2025))} · Nr ${issue}`, date, 'Cena: jedna strona']) {
    const part = document.createElement('span');
    part.textContent = text;
    line.appendChild(part);
  }
  return line;
}

function syncGazeta(on) {
  document.documentElement.classList.toggle('gazeta', on);
  document.getElementById('gazeta-toggle')?.setAttribute('aria-checked', String(on));
  document.getElementById('gazeta-switch')?.classList.toggle('on', on);
  const header = document.querySelector('main.container > header');
  header?.querySelector('.gazeta-dateline')?.remove();
  if (!on) return;
  header?.appendChild(dateline());
  // Gotycki krój winiety dociągamy dopiero, gdy styl jest włączony (bez sieci zostaje zwykły szeryfowy)
  if (!document.getElementById('gazeta-font')) {
    const link = document.createElement('link');
    link.id = 'gazeta-font';
    link.rel = 'stylesheet';
    link.href = MASTHEAD_FONT;
    document.head.appendChild(link);
  }
}

export function syncEinkToggle() {
  const on = einkEnabled();
  document.documentElement.classList.toggle('eink', on);
  document.getElementById('eink-toggle')?.setAttribute('aria-checked', String(on));
  document.getElementById('eink-switch')?.classList.toggle('on', on);
  syncGazeta(gazetaEnabled());
}

// afterChange: odświeżenie rzeczy zależnych od trybu (np. tło z okładkami na Starcie)
export function toggleEink(afterChange) {
  write(STORAGE_KEY, einkEnabled() ? 'off' : 'on');
  syncEinkToggle();
  afterChange?.();
}

// Styl gazety: włączenie włącza też tryb czytnika (gazeta to jego odmiana)
export function toggleGazeta(afterChange) {
  const on = !gazetaEnabled();
  write(STYLE_KEY, on ? 'gazeta' : 'plain');
  if (on) write(STORAGE_KEY, 'on');
  syncEinkToggle();
  afterChange?.();
}
