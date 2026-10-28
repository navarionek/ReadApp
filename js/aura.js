import { el } from './ui.js';

/* ----------------- Karta osoby na Półce ----------------- */
// Ciemny „plakat” w kolorze osoby: siatka rozmytych plam w pokrewnych odcieniach, a po prawej orbita,
// w której każdy okrąg to jedna przeczytana książka (od najstarszej w środku do najnowszej na zewnątrz).
// Długość łuku to liczba stron, grubość to mnożnik, jasny akcent to ulubiona, przygaszony to słaba albo
// niedokończona. Okręgi obracają się w różnym tempie, przy wejściu łuki się rysują. Kolor osoby (własny
// albo z palety, może być zmienną CSS) zamieniamy na odcień i nasycenie; barwy liczy z nich style.css.
const NS = 'http://www.w3.org/2000/svg';
const C = 150;          // środek orbity w jednostkach viewBox 300×300
const MAX_RINGS = 24;

// Dowolny kolor CSS → [r, g, b] 0..255; sprawdza go przeglądarka, więc działają hex, hsl() i var()
export function colorToRgb(css) {
  const probe = el('span');
  probe.style.cssText = `position:absolute;visibility:hidden;color:${css}`;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const nums = (computed.match(/-?[\d.]+/g) || []).map(Number);
  if (nums.length < 3) return [99, 102, 241];
  const scale = computed.startsWith('color(') ? 255 : 1;  // color(srgb 0.2 0.4 0.6) ma kanały 0..1
  return nums.slice(0, 3).map(v => v * scale);
}

export function colorToHsl(css) {
  const [r, g, b] = colorToRgb(css).map(v => v / 255);
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

// Kolor napisu na tle w danym kolorze: biały albo prawie czarny, ten z lepszym kontrastem (WCAG)
const INK_DARK = '#0f172a';
export function inkFor(css) {
  const lum = colorToRgb(css).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
  const contrastWhite = 1.05 / (L + 0.05);
  const contrastDark = (L + 0.05) / (0.0137 + 0.05);  // luminancja #0f172a
  return contrastDark > contrastWhite ? INK_DARK : '#ffffff';
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

function node(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  children.forEach(c => n.appendChild(c));
  return n;
}

// books: przeczytane osoby od najnowszej (jak na półce); bierzemy ostatnie MAX_RINGS i układamy od najstarszej
function orbit(books, rand, uid) {
  const list = books.slice(0, MAX_RINGS).reverse();
  const count = list.length || 5;
  const r0 = 34;
  const step = Math.min(11, (138 - r0) / Math.max(count - 1, 1));
  const maxPages = Math.max(1, ...list.map(b => b.pages || 0));
  const rings = node('g', { class: 'orb-rings' });

  for (let i = 0; i < count; i++) {
    const r = (r0 + i * step).toFixed(1);
    const book = list[i];
    const spin = node('g', {
      class: `orb-spin${i % 2 ? ' rev' : ''}`,
      style: `animation-duration:${Math.round(70 + rand() * 110)}s`,
    });
    const tilt = node('g', { transform: `rotate(${Math.round(rand() * 360)} ${C} ${C})` });
    tilt.appendChild(node('circle', { cx: C, cy: C, r, class: `orb-track${book ? '' : ' empty'}` }));
    if (book) {
      const len = Math.round(50 + 280 * Math.min(1, (book.pages || 0) / maxPages));
      const kind = book.unfinished || book.rating === -1 ? 'dim' : book.rating === 1 ? 'hot' : 'mid';
      const mult = Number(book.multiplier);
      const width = 2.2 + (mult > 1 ? 1.6 : 0) + (mult >= 2.25 ? 1 : 0);
      const delay = 0.15 + i * 0.05;
      tilt.appendChild(node('circle', {
        cx: C, cy: C, r, pathLength: 360,
        class: `orb-arc ${kind}`,
        style: `--len:${len};stroke-width:${width.toFixed(1)};animation-delay:${delay.toFixed(2)}s`,
      }));
      // „Planeta” na końcu łuku (łuk zaczyna się na godzinie 3 i idzie zgodnie z zegarem)
      const a = (len * Math.PI) / 180;
      const px = (C + r * Math.cos(a)).toFixed(1);
      const py = (C + r * Math.sin(a)).toFixed(1);
      const pop = `animation-delay:${(delay + 0.55).toFixed(2)}s`;
      tilt.appendChild(node('circle', { cx: px, cy: py, r: 5.5, class: `orb-halo ${kind}`, style: pop }));
      tilt.appendChild(node('circle', { cx: px, cy: py, r: (width / 2 + 0.9).toFixed(1), class: `orb-dot ${kind}`, style: pop }));
    }
    spin.appendChild(tilt);
    rings.appendChild(spin);
  }

  return node('svg', { class: 'orb-svg', viewBox: '0 0 300 300', focusable: 'false' }, [
    node('defs', {}, [
      node('radialGradient', { id: `${uid}-core` }, [
        node('stop', { offset: 0, class: 'orb-core-0' }),
        node('stop', { offset: 0.4, class: 'orb-core-1' }),
        node('stop', { offset: 1, class: 'orb-core-2' }),
      ]),
    ]),
    node('circle', { cx: C, cy: C, r: 70, fill: `url(#${uid}-core)` }),
    rings,
    node('circle', { cx: C, cy: C, r: 3.5, class: 'orb-center' }),
  ]);
}

// Ustawia kolory na karcie (to z nich liczy style.css) i zwraca tło do wstawienia pod treść
export function buildAura(hero, color, seed, books = []) {
  const [h, s] = colorToHsl(color);
  // Szarości zostają szare (wychodzi srebro), reszta dostaje żywe nasycenie
  const sat = s < 10 ? s : Math.min(92, Math.max(58, s));
  hero.style.setProperty('--aura-h', String(h));
  hero.style.setProperty('--aura-s', sat.toFixed(0));
  const rand = seeded(seed);
  return el('div', { class: 'shelf-aura', 'aria-hidden': 'true' }, [
    el('div', { class: 'aura-mesh' }, [1, 2, 3, 4].map(i => el('span', { class: `mesh-blob m${i}` }))),
    el('div', { class: 'aura-orbit' }, [orbit(books, rand, `orb${hash(seed).toString(36)}`)]),
    el('span', { class: 'aura-grain' }),
    el('span', { class: 'aura-sheen' }),
  ]);
}
