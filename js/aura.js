import { el } from './ui.js';

/* ----------------- Tło nagłówka Półki: abstrakcja w kolorze osoby ----------------- */
// Kolor osoby (własny albo z palety, może być zmienną CSS) zamieniamy na odcień i nasycenie; z nich style.css
// liczy wszystkie barwy (osobno dla jasnego i ciemnego motywu). Obraz jest rysowany w SVG i losowany z klucza
// osoby: u każdego inny układ, ale zawsze ten sam dla tej samej osoby. Warstwy od spodu: gradient,
// płynne plamy koloru, dwie wstęgi cienkich linii (skręcają się i rozchodzą jak nitki), okręgi jak szkło,
// siatka kropek, połysk i ziarno papieru.
const NS = 'http://www.w3.org/2000/svg';
const W = 800;
const H = 340;

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

function node(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  children.forEach(c => n.appendChild(c));
  return n;
}

const fmt = n => n.toFixed(1);

// Wstęga: kilkanaście linii, które w jednych miejscach zbiegają się w nitkę, w innych rozchodzą w wachlarz
function ribbon(rand, { lines, spread, amplitude, accentEvery, cls }) {
  const f1 = 0.55 + rand() * 1.0;
  const f2 = 0.8 + rand() * 1.3;
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const cy = H * (0.4 + rand() * 0.25);
  const group = node('g', { class: `ar-ribbon ${cls}` });
  for (let i = 0; i < lines; i++) {
    const t = i / (lines - 1) - 0.5;
    let d = '';
    for (let k = 0; k <= 72; k++) {
      const x = -160 + (k / 72) * (W + 320);
      const u = x / W;
      const wave = amplitude * Math.sin(Math.PI * 2 * f1 * u + p1);
      const fan = t * spread * (0.5 + 0.5 * Math.sin(Math.PI * 2 * f2 * u + p2));
      d += `${k ? 'L' : 'M'}${fmt(x)} ${fmt(cy + wave + fan)} `;
    }
    const accent = i % accentEvery === Math.floor(accentEvery / 2);
    group.appendChild(node('path', { d, class: `ln${accent ? ' ln-2' : ''}`, style: `opacity:${(0.45 + 0.55 * (1 - Math.abs(t) * 1.4)).toFixed(2)}` }));
  }
  return group;
}

// Ustawia kolory na nagłówku (to z nich liczy style.css) i zwraca tło do wstawienia pod treść
export function buildAura(hero, color, seed) {
  const [h, s] = colorToHsl(color);
  // Szarości zostają szare, reszta dostaje żywe, ale niekrzykliwe nasycenie
  const sat = s < 10 ? s : Math.min(90, Math.max(52, s));
  hero.style.setProperty('--aura-h', String(h));
  hero.style.setProperty('--aura-s', sat.toFixed(0));

  const rand = seeded(seed);
  const uid = `ar${hash(seed).toString(36)}`;
  const defs = node('defs');
  const radial = (id, stops) => {
    const g = node('radialGradient', { id: `${uid}-${id}` }, stops.map(([offset, css]) => node('stop', { offset, style: `stop-color:${css}` })));
    defs.appendChild(g);
    return `url(#${uid}-${id})`;
  };

  defs.appendChild(node('linearGradient', { id: `${uid}-base`, x1: 0, y1: 0, x2: 1, y2: 1 }, [
    node('stop', { offset: 0, style: 'stop-color:hsl(var(--h) var(--s-soft) var(--base-a))' }),
    node('stop', { offset: 1, style: 'stop-color:hsl(calc(var(--h) + 26) var(--s-soft) var(--base-b))' }),
  ]));

  // Plamy koloru: pokrewne odcienie plus jeden mały, kontrastowy akcent
  const blobSpec = [
    { dh: 0, l: 'var(--glow-1)', a: 0.95, r: 300 },
    { dh: 44, l: 'var(--glow-2)', a: 0.85, r: 260 },
    { dh: -40, l: 'var(--glow-3)', a: 0.8, r: 280 },
    { dh: 168 + Math.round(rand() * 24), l: 'var(--glow-accent)', a: 0.4, r: 150 },
  ];
  const blobs = node('g', { class: 'ar-blobs' });
  blobSpec.forEach((b, i) => {
    const fill = radial(`b${i}`, [
      ['0', `hsl(calc(var(--h) + ${b.dh}) var(--s-glow) ${b.l} / ${b.a})`],
      ['1', `hsl(calc(var(--h) + ${b.dh}) var(--s-glow) ${b.l} / 0)`],
    ]);
    const c = node('circle', { cx: fmt(80 + rand() * 640), cy: fmt(30 + rand() * 280), r: b.r, fill, class: `ar-blob b${i}` });
    blobs.appendChild(c);
  });

  // Dwa okręgi jak obręcze, jeden „szklany” w rogu i siatka kropek
  const ringX = rand() < 0.5 ? 150 + rand() * 120 : 560 + rand() * 130;
  const ringY = 40 + rand() * 120;
  const orbFill = radial('orb', [['0', 'rgb(255 255 255 / 0.55)'], ['0.55', 'rgb(255 255 255 / 0.12)'], ['1', 'rgb(255 255 255 / 0)']]);
  const art = node('g', { class: 'ar-art' }, [
    node('circle', { cx: fmt(ringX), cy: fmt(ringY), r: 130 + Math.round(rand() * 50), class: 'ar-ring' }),
    node('circle', { cx: fmt(ringX), cy: fmt(ringY), r: 86 + Math.round(rand() * 30), class: 'ar-ring ar-ring-2' }),
    node('circle', { cx: fmt(ringX), cy: fmt(ringY), r: 42 + Math.round(rand() * 14), fill: orbFill, class: 'ar-orb' }),
    node('rect', { x: fmt(rand() < 0.5 ? 20 : 650), y: fmt(190 + rand() * 40), width: 130, height: 70, fill: `url(#${uid}-dots)`, class: 'ar-dots' }),
  ]);
  defs.appendChild(node('pattern', { id: `${uid}-dots`, width: 14, height: 14, patternUnits: 'userSpaceOnUse' }, [node('circle', { cx: 2, cy: 2, r: 1.3, class: 'ar-dot' })]));

  const svg = node('svg', { class: 'ar-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid slice', focusable: 'false' }, [
    defs,
    node('rect', { width: W, height: H, fill: `url(#${uid}-base)` }),
    blobs,
    ribbon(rand, { lines: 18 + Math.floor(rand() * 8), spread: 150 + rand() * 90, amplitude: 36 + rand() * 46, accentEvery: 5, cls: 'ar-ribbon-a' }),
    ribbon(rand, { lines: 7 + Math.floor(rand() * 4), spread: 90 + rand() * 60, amplitude: 28 + rand() * 40, accentEvery: 3, cls: 'ar-ribbon-b' }),
    art,
  ]);

  return el('div', { class: 'shelf-aura', 'aria-hidden': 'true' }, [
    svg,
    el('span', { class: 'aura-sheen' }),
    el('span', { class: 'aura-grain' }),
  ]);
}
