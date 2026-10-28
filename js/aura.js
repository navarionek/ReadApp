import { el } from './ui.js';

/* ----------------- Karta osoby na Półce ----------------- */
// Ciemny „plakat” w kolorze osoby: siatka rozmytych plam w pokrewnych odcieniach, a po prawej orbita,
// w której każdy okrąg to jedna przeczytana książka (od najstarszej w środku do najnowszej na zewnątrz).
// Długość łuku to liczba stron, grubość to mnożnik, jasny akcent to ulubiona, przygaszony to słaba albo
// niedokończona. Kolor osoby (własny albo z palety, może być zmienną CSS) zamieniamy na odcień i nasycenie;
// barwy liczy z nich style.css.
//
// Wydajność (telefony): ruch to wyłącznie przezroczystość i transformacje całych warstw, które przeglądarka
// składa na karcie graficznej bez malowania od nowa. Dlatego kolory się nie animują: przy zmianie osoby
// nowa warstwa koloru przenika przez starą. Okręgi są w trzech warstwach obracanych w różnym tempie
// (a nie każdy osobno wewnątrz SVG, co wymuszało malowanie całej orbity w każdej klatce).
const NS = 'http://www.w3.org/2000/svg';
const C = 150;          // środek orbity w jednostkach viewBox 300×300
const MAX_RINGS = 24;
const LAYERS = 3;

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

const svg = (cls, children) => node('svg', { class: cls, viewBox: '0 0 300 300', focusable: 'false' }, children);

// Docelowy wygląd okręgów dla listy książek (od najnowszej, jak na półce): bierzemy ostatnie MAX_RINGS
// i układamy od najstarszej w środku. Pusta półka = kilka kropkowanych orbit bez łuków.
function ringTargets(books, seed) {
  const rand = seeded(seed);
  const list = books.slice(0, MAX_RINGS).reverse();
  const count = list.length || 5;
  const r0 = 34;
  const step = Math.min(11, (138 - r0) / Math.max(count - 1, 1));
  const maxPages = Math.max(1, ...list.map(b => b.pages || 0));
  return Array.from({ length: count }, (_, i) => {
    const book = list[i];
    const base = { r: r0 + i * step, tilt: Math.round(rand() * 360), op: 1 };
    if (!book) return { ...base, len: 0, width: 2.2, arc: 0, kind: 'mid', empty: true };
    const mult = Number(book.multiplier);
    return {
      ...base,
      len: 50 + 280 * Math.min(1, (book.pages || 0) / maxPages),
      width: 2.2 + (mult > 1 ? 1.6 : 0) + (mult >= 2.25 ? 1 : 0),
      arc: 1,
      kind: book.unfinished || book.rating === -1 ? 'dim' : book.rating === 1 ? 'hot' : 'mid',
      empty: false,
    };
  });
}

// Krzywa ruchu jak cubic-bezier(0.4, 0, 0.1, 1): łagodny start i długie, miękkie wyhamowanie na końcu
function bezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return x => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}
const ease = bezier(0.4, 0, 0.1, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const turn = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;  // najkrótsza zmiana kąta albo odcienia
const MORPH_MS = 1600;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Orbita żyje tak długo jak karta. Przy zmianie osoby każdy okrąg płynnie przechodzi w okrąg nowej osoby
// (promień, długość łuku, grubość, obrót, kolor), nadmiarowe zwijają się i gasną, brakujące wyrastają.
// Liczymy to sami w każdej klatce (atrybuty SVG działają wszędzie, także na iPhonie); całe warstwy
// dalej obracają się na karcie graficznej.
class Orbit {
  constructor(slot) {
    const uid = `orb${++orbitCount}`;
    this.layers = Array.from({ length: LAYERS }, (_, i) => svg(`orb-layer l${i}`, []));
    this.root = el('div', { class: 'orb' }, [
      svg('orb-core-svg', [
        node('defs', {}, [
          node('radialGradient', { id: `${uid}-core` }, [
            node('stop', { offset: 0, class: 'orb-core-0' }),
            node('stop', { offset: 0.4, class: 'orb-core-1' }),
            node('stop', { offset: 1, class: 'orb-core-2' }),
          ]),
        ]),
        node('circle', { cx: C, cy: C, r: 70, fill: `url(#${uid}-core)` }),
        node('circle', { cx: C, cy: C, r: 3.5, class: 'orb-center' }),
      ]),
      ...this.layers,
    ]);
    slot.appendChild(this.root);
    this.rings = [];
    this.color = null;      // { h, s } teraz
    this.colorTo = null;
    this.raf = 0;
  }

  addRing(i, target) {
    const g = node('g');
    const track = node('circle', { cx: C, cy: C, class: 'orb-track' });
    const arc = node('circle', { cx: C, cy: C, pathLength: 360, class: 'orb-arc mid' });
    const halo = node('circle', { r: 5.5, class: 'orb-halo mid' });
    const dot = node('circle', { class: 'orb-dot mid' });
    g.append(track, arc, halo, dot);
    this.layers[i % LAYERS].appendChild(g);
    // Nowy okrąg wyrasta: zaczyna mniejszy, bez łuku i niewidoczny
    const now = { r: target.r * 0.7, len: 0, width: target.width, tilt: target.tilt - 60, op: 0, arc: 0 };
    const ring = { g, track, arc, halo, dot, now, from: { ...now }, to: target, kind: null, empty: null };
    this.rings.push(ring);
    return ring;
  }

  setColor(h, s, animate) {
    this.colorTo = { h, s };
    if (!this.color || !animate) this.color = { h, s };
    this.start(animate);
  }

  // targets = null: książki nowej osoby jeszcze się wczytują (okręgi zostają, przygaszone)
  setTargets(targets, animate) {
    this.root.classList.toggle('pending', !targets);
    if (!targets) return;
    targets.forEach((target, i) => {
      const ring = this.rings[i] || this.addRing(i, target);
      ring.to = target;
    });
    // Nadmiarowe okręgi: zwijają łuk, odsuwają się i gasną, potem znikają
    this.rings.slice(targets.length).forEach(ring => {
      ring.to = { ...ring.now, r: ring.now.r + 14, len: 0, op: 0, arc: 0, remove: true };
    });
    this.start(animate);
  }

  start(animate) {
    this.rings.forEach(ring => { ring.from = { ...ring.now }; });
    this.colorFrom = { ...this.color };
    this.t0 = performance.now();
    this.duration = animate && !reducedMotion() ? MORPH_MS : 0;
    if (!this.raf) this.raf = requestAnimationFrame(t => this.frame(t));
  }

  frame(time) {
    const t = this.duration ? Math.min(1, (time - this.t0) / this.duration) : 1;
    const e = ease(t);
    if (this.colorTo) {
      const h = this.colorFrom.h + turn(this.colorFrom.h, this.colorTo.h) * e;
      this.color = { h: (h + 360) % 360, s: lerp(this.colorFrom.s, this.colorTo.s, e) };
      colorVars(this.root, this.color.h.toFixed(1), this.color.s.toFixed(1));
    }
    this.rings.forEach(ring => this.draw(ring, e));
    if (t < 1) {
      this.raf = requestAnimationFrame(next => this.frame(next));
      return;
    }
    this.raf = 0;
    this.rings = this.rings.filter(ring => {
      if (!ring.to.remove) return true;
      ring.g.remove();
      return false;
    });
  }

  draw(ring, e) {
    const { from, to, now } = ring;
    now.r = lerp(from.r, to.r, e);
    now.len = lerp(from.len, to.len, e);
    now.width = lerp(from.width, to.width, e);
    now.tilt = from.tilt + turn(from.tilt, to.tilt) * e;
    now.op = lerp(from.op, to.op, e);
    now.arc = lerp(from.arc, to.arc, e);
    // Rodzaj łuku (kolor) i kropkowanie zmieniają się w połowie przejścia, gdy okrąg jest w ruchu
    const late = e >= 0.5 || from.op === 0;
    const kind = late ? to.kind : ring.kind ?? to.kind;
    if (kind && kind !== ring.kind) {
      ring.kind = kind;
      for (const part of [ring.arc, ring.halo, ring.dot]) part.setAttribute('class', `${part.classList[0]} ${kind}`);
    }
    const empty = late ? !!to.empty : ring.empty ?? !!to.empty;
    if (empty !== ring.empty) {
      ring.empty = empty;
      ring.track.classList.toggle('empty', empty);
    }
    const r = now.r.toFixed(2);
    ring.g.setAttribute('transform', `rotate(${now.tilt.toFixed(2)} ${C} ${C})`);
    ring.g.setAttribute('opacity', now.op.toFixed(3));
    ring.track.setAttribute('r', r);
    ring.arc.setAttribute('r', r);
    ring.arc.setAttribute('stroke-dasharray', `${now.len.toFixed(2)} 360`);
    ring.arc.setAttribute('stroke-width', now.width.toFixed(2));
    // „Planeta” na końcu łuku (łuk zaczyna się na godzinie 3 i idzie zgodnie z zegarem)
    const a = (now.len * Math.PI) / 180;
    const px = (C + now.r * Math.cos(a)).toFixed(2);
    const py = (C + now.r * Math.sin(a)).toFixed(2);
    const arcOp = now.arc.toFixed(3);
    ring.arc.setAttribute('opacity', arcOp);
    for (const part of [ring.halo, ring.dot]) {
      part.setAttribute('cx', px);
      part.setAttribute('cy', py);
      part.setAttribute('opacity', arcOp);
    }
    ring.dot.setAttribute('r', (now.width / 2 + 0.9).toFixed(2));
  }
}

let orbitCount = 0;

// Kolor osoby jako zmienne na elemencie: warstwa koloru i orbita dostają własną kopię, więc stara warstwa
// zachowuje swoje barwy, gdy nowa przez nią przenika
function colorVars(target, h, s) {
  target.style.setProperty('--aura-h', String(h));
  target.style.setProperty('--aura-s', String(s));
}

// Warstwa koloru: gradient (przenika przezroczystością) i plamy w osobnym „wirze” (obraca się przy wejściu)
function paintLayer(h, s) {
  const paint = el('div', { class: 'aura-paint' }, [
    el('div', { class: 'aura-swirl' }, [1, 2, 3, 4].map(i => el('span', { class: `mesh-blob m${i}` }))),
  ]);
  colorVars(paint, h, s);
  return paint;
}

// Tło karty budujemy raz; przy zmianie osoby wymieniają się w nim warstwa koloru i orbita
export function createAura() {
  const slot = el('div', { class: 'aura-orbit' });
  slot._orbit = new Orbit(slot);
  return el('div', { class: 'shelf-aura', 'aria-hidden': 'true' }, [
    el('div', { class: 'aura-paints' }),
    slot,
    el('span', { class: 'aura-grain' }),
  ]);
}

// animate: kolor przechodzi przez odcień pośredni (warstwa-pomost w połowie drogi po kole barw), a plamy
// nowej warstwy wirują i osiadają. Każda warstwa jest malowana raz, potem tylko się obraca i przenika.
export function setAuraColor(hero, color, animate) {
  const [h, s] = colorToHsl(color);
  // Szarości zostają szare (wychodzi srebro), reszta dostaje żywe nasycenie
  const sat = Math.round(s < 10 ? s : Math.min(92, Math.max(58, s)));
  if (hero.dataset.aura === `${h}/${sat}`) return;
  hero.dataset.aura = `${h}/${sat}`;
  const prevH = parseFloat(hero.style.getPropertyValue('--aura-h'));
  const prevS = parseFloat(hero.style.getPropertyValue('--aura-s'));
  colorVars(hero, h, sat);
  orbitOf(hero).setColor(h, sat, animate);  // okręgi zmieniają barwę razem z kartą

  const paints = hero.querySelector('.aura-paints');
  const old = [...paints.children];
  const fresh = paintLayer(h, sat);
  if (!animate || !old.length) {
    old.forEach(o => o.remove());
    paints.appendChild(fresh);
    return;
  }
  old.forEach(o => o.classList.add('leaving'));
  const added = [];
  // Krótsza droga po kole barw; przy bliskich kolorach pomost nie jest potrzebny
  const delta = ((((h - prevH) % 360) + 540) % 360) - 180;
  if (Number.isFinite(prevH) && Math.abs(delta) > 40 && sat >= 10 && prevS >= 10) {
    const bridge = paintLayer(Math.round((prevH + delta / 2 + 360) % 360), Math.round((prevS + sat) / 2));
    bridge.classList.add('bridge');
    added.push(bridge);
  }
  fresh.classList.add('entering');
  added.push(fresh);
  paints.append(...added);
  // Gdy nowa warstwa całkiem przykryje resztę, stare i pomost znikają
  const cleanup = () => {
    [...old, ...added.filter(a => a !== fresh)].forEach(o => o.remove());
    fresh.classList.remove('entering');
  };
  fresh.addEventListener('animationend', e => { if (e.target === fresh) cleanup(); });
  setTimeout(cleanup, 1800);  // gdyby animacji nie było (karta w tle, ograniczony ruch)
}

const orbitOf = hero => hero.querySelector('.aura-orbit')._orbit;

// books = null: książki nowej osoby się wczytują (okręgi czekają przygaszone); potem przechodzą w nowe.
// animate = false: od razu w docelowym kształcie.
export function setOrbit(hero, books, seed, animate) {
  orbitOf(hero).setTargets(books && ringTargets(books, seed), animate);
}
