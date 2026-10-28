import { el } from './ui.js';

/* ----------------- Tło nagłówka Półki w kolorze osoby ----------------- */
// Kolor osoby (własny albo z palety, może być zmienną CSS) zamieniamy na odcień i nasycenie. Z nich style.css
// buduje całe tło: poświata w trzech pokrewnych odcieniach, promień „lampki”, ziarno papieru i rząd grzbietów
// książek stojących na półce. Grzbiety są losowane z klucza osoby, więc u każdego wyglądają inaczej,
// ale zawsze tak samo dla tej samej osoby.

// Dowolny kolor CSS → [h 0..360, s 0..100, l 0..100]; sprawdza go przeglądarka, więc działają hex, hsl() i var()
export function colorToHsl(css) {
  const probe = el('span');
  probe.style.cssText = `position:absolute;visibility:hidden;color:${css}`;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const nums = (computed.match(/-?[\d.]+/g) || []).map(Number);
  if (nums.length < 3) return [250, 70, 50];
  const scale = computed.startsWith('color(') ? 255 : 1;  // color(srgb 0.2 0.4 0.6) ma kanały 0..1
  const [r, g, b] = nums.slice(0, 3).map(v => v * scale / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [Math.round((h * 60 + 360) % 360), s * 100, l * 100];
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function seeded(text) {
  let a = hash(text);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rząd książek: różne szerokości, wysokości i odcienie wokół koloru osoby, jedna oparta o sąsiada
function buildBooks(seed) {
  const rand = seeded(seed);
  const box = el('div', { class: 'shelf-hero-books', 'aria-hidden': 'true' });
  const count = 13 + Math.floor(rand() * 5);
  const leaning = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    const book = el('span', { class: `hb${rand() < 0.35 ? ' hb-band' : ''}${i === leaning ? ' hb-lean' : ''}` });
    book.style.width = `${(8 + rand() * 10).toFixed(1)}px`;
    book.style.height = `${Math.round(42 + rand() * 54)}%`;
    book.style.setProperty('--dh', String(Math.round((rand() - 0.5) * 80)));
    book.style.setProperty('--dl', String(Math.round((rand() - 0.5) * 28)));
    if (rand() < 0.14) book.style.marginLeft = '7px';
    box.appendChild(book);
  }
  return box;
}

// Ustawia kolory na nagłówku (to z nich liczy style.css) i zwraca [tło, rząd książek]
export function buildAura(hero, color, seed) {
  const [h, s] = colorToHsl(color);
  // Szarości zostają szare, reszta dostaje żywe, ale niekrzykliwe nasycenie
  const sat = s < 10 ? s : Math.min(86, Math.max(48, s));
  hero.style.setProperty('--aura-h', String(h));
  hero.style.setProperty('--aura-s', sat.toFixed(0));
  const aura = el('div', { class: 'shelf-aura', 'aria-hidden': 'true' }, [
    el('span', { class: 'aura-glow g1' }),
    el('span', { class: 'aura-glow g2' }),
    el('span', { class: 'aura-glow g3' }),
    el('span', { class: 'aura-lamp' }),
    el('span', { class: 'aura-grain' }),
  ]);
  return [aura, buildBooks(seed)];
}
