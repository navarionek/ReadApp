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
const COMET_PARTS = 8;    // z ilu nakładających się kawałków jest kometa (więcej = płynniejszy ogon)
const COMET_HEAD = 0.14;  // jaka część łuku to sama głowa (najkrótszy kawałek)
const COMET_ALPHA = 0.17; // jasność jednego kawałka; przy głowie nakłada się wszystkie, więc jest najjaśniej
const SPIN_MAX = 300;   // prędkość okręgów w chwili wystrzału (razy zwykła)
const SPIN_RAMP = 8000; // tyle trzeba trzymać palec, żeby okręgi wystrzeliły (ms)
const SPIN_JUMP = 8;   // zryw na starcie: tyle razy szybciej już po ułamku sekundy
const SPIN_JUMP_MS = 180; // jak szybko przychodzi zryw (stała czasu, ms)
const SPIN_CURVE = 2.4; // im większa, tym bardziej przyspieszanie narasta pod koniec
const GLOW_FROM = 37;  // od tej prędkości (razy zwykła) wokół okręgów narasta poświata przed wybuchem
const SPIN_DOWN = 650;  // zwalnianie po puszczeniu: stała czasu (ms), do zwykłego tempa ok. 3 s
const SWAP_SPIN = 14;    // prędkość okręgów na starcie zmiany osoby (razy zwykła)
const SWAP_SPIN_MS = 2200; // tyle trwa wyhamowanie do zwykłego tempa (ms)
const FLY_GAP = 32;    // odstęp między kolejnymi wystrzałami okręgów (ms)
const FLY_MS = 380;     // lot jednego okręgu
const FLY_DIST = 300;   // jak daleko odlatuje okrąg (jednostki rysunku orbity)
const SPARKS = 30;      // iskry przy eksplozji
// Prędkość po t ms trzymania: szybki zryw na starcie, potem coraz ostrzejsze przyspieszanie do SPIN_MAX
const holdRate = t => (t = Math.max(0, t), 1 + SPIN_JUMP * (1 - Math.exp(-t / SPIN_JUMP_MS)) + (SPIN_MAX - 1 - SPIN_JUMP) * Math.min(1, t / SPIN_RAMP) ** SPIN_CURVE);
// Odwrotnie: po ilu ms trzymania jest dana prędkość (żeby ponowne przytrzymanie dokładało od bieżącej)
function holdTime(rate) {
  let lo = 0;
  let hi = SPIN_RAMP;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (holdRate(mid) < rate) lo = mid;
    else hi = mid;
  }
  return lo;
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Orbita żyje tak długo jak karta. Przy zmianie osoby każdy okrąg płynnie przechodzi w okrąg nowej osoby
// (promień, długość łuku, grubość, obrót, kolor), nadmiarowe zwijają się i gasną, brakujące wyrastają.
// Liczymy to sami w każdej klatce (atrybuty SVG działają wszędzie, także na iPhonie); całe warstwy
// dalej obracają się na karcie graficznej.
class Orbit {
  constructor(slot) {
    const uid = `orb${++orbitCount}`;
    this.layers = Array.from({ length: LAYERS }, (_, i) => svg(`orb-layer l${i}`, []));
    // Poświata przed wystrzałem (narasta z prędkością, rozbłyskuje przy wystrzale), pod słońcem i okręgami
    this.glow = el('div', { class: 'orb-glow' });
    this.root = el('div', { class: 'orb' }, [
      this.glow,
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
    // Łuk jak kometa: COMET_PARTS nakładających się kawałków, każdy krótszy (bliżej „planety”), odrobinę
    // grubszy i dokładający trochę jasności, więc ogon płynnie gaśnie bez widocznych schodków. Wewnętrzne
    // kawałki mają proste końce (zaokrąglone robiły jaśniejsze kropki na granicach), zaokrąglona jest tylko głowa.
    const parts = Array.from({ length: COMET_PARTS }, (_, k) => {
      const part = node('circle', { cx: C, cy: C, pathLength: 360, class: 'orb-arc mid' });
      if (k < COMET_PARTS - 1) part.style.strokeLinecap = 'butt';
      return part;
    });
    const halo = node('circle', { r: 5.5, class: 'orb-halo mid' });
    const dot = node('circle', { class: 'orb-dot mid' });
    g.append(track, ...parts, halo, dot);
    this.layers[i % LAYERS].appendChild(g);
    // Nowy okrąg wyrasta: zaczyna mniejszy, bez łuku i niewidoczny
    const now = { r: target.r * 0.7, len: 0, width: target.width, tilt: target.tilt - 60, op: 0, arc: 0 };
    const ring = { g, track, parts, halo, dot, now, from: { ...now }, to: target, kind: null, empty: null };
    this.rings.push(ring);
    return ring;
  }

  // Przytrzymanie karty: od razu zryw, a potem okręgi kręcą się coraz szybciej, i to coraz ostrzej
  // (prędkość rośnie z potęgą czasu trzymania, holdRate). Po SPIN_RAMP okręgi wystrzeliwują jeden po drugim
  // („piu, piu”), a po puszczeniu palca wyrastają z powrotem ze środka. Puszczenie wcześniej = okręgi
  // płynnie wyhamowują. Prędkość zmieniamy przez playbackRate animacji CSS warstw.
  hold(on) {
    if (reducedMotion()) return;
    if (on && !this.holding) this.holdStart = performance.now() - holdTime(this.spinRate || 1);  // dokładamy od bieżącej prędkości
    this.holding = on;
    this.press(on);
    if (!on && this.launch === 'out') this.regrow();
    if (this.spinRaf) return;
    this.spinRate = this.spinRate || 1;
    let last = performance.now();
    const step = now => {
      const dt = Math.min(64, now - last);
      last = now;
      if (this.holding) {
        // Znacznik czasu klatki bywa odrobinę wcześniejszy niż chwila naciśnięcia: czas trzymania nie może być ujemny
        const held = Math.max(0, now - this.holdStart);
        this.spinRate = holdRate(held);
        if (held >= SPIN_RAMP && !this.launch) this.fire();
      } else {
        this.spinRate = 1 + (this.spinRate - 1) * Math.exp(-dt / SPIN_DOWN);
      }
      if (!Number.isFinite(this.spinRate)) this.spinRate = 1;
      const done = !this.holding && this.spinRate < 1.02;
      if (done) this.spinRate = 1;
      this.charge(now);
      // Tylko obrót (warstwy jeszcze „oddychają”, tego nie przyspieszamy, bo przy rozkręceniu migałoby)
      this.applySpin();
      this.spinRaf = done ? 0 : requestAnimationFrame(step);
    };
    this.spinRaf = requestAnimationFrame(step);
  }

  applySpin() {
    const rate = Math.max(this.spinRate || 1, this.swapRate || 1);
    this.layers.flatMap(layer => layer.getAnimations().filter(anim => anim.animationName === 'orb-spin'))
      .forEach(anim => (anim.updatePlaybackRate ? anim.updatePlaybackRate(rate) : (anim.playbackRate = rate)));
  }

  // Zmiana osoby: okręgi na chwilę kręcą się szybciej, potem płynnie wracają do zwykłego tempa
  swapSpin() {
    if (reducedMotion()) return;
    const t0 = performance.now();
    const had = !!this.swapRaf;
    this.swapT0 = t0;
    if (had) return;
    const step = now => {
      const p = Math.min(1, (now - this.swapT0) / SWAP_SPIN_MS);
      this.swapRate = 1 + (SWAP_SPIN - 1) * (1 - p) ** 2;
      if (p >= 1) this.swapRate = 1;
      this.applySpin();
      this.swapRaf = p >= 1 ? 0 : requestAnimationFrame(step);
    };
    this.swapRaf = requestAnimationFrame(step);
  }

  // Naładowanie przed wybuchem: od GLOW_FROM razy zwykłej prędkości wokół okręgów narasta poświata, a orbita
  // drży coraz mocniej. Przy wystrzale poświata rozbłyskuje i gaśnie. Sama przezroczystość i przesunięcia.
  // Wciśnięcie karty: cień karty się kurczy (klasa pressed, style.css), a poświatę pod kartą (osobny element,
  // żeby nie malować cienia karty w każdej klatce) ustawiamy pod nią w jej kolorze
  press(on) {
    const hero = this.root.closest('.shelf-hero');
    hero?.classList.toggle('pressed', on);
    const shadow = document.getElementById('shelf-hero-shadow');
    if (!on || !hero || !shadow) return;
    this.shadow = shadow;
    shadow.style.top = `${hero.offsetTop + hero.offsetHeight * 0.45}px`;
    shadow.style.height = `${hero.offsetHeight * 0.6}px`;
    colorVars(shadow, hero.style.getPropertyValue('--aura-h'), hero.style.getPropertyValue('--aura-s'));
  }

  charge(now) {
    // Postęp ładowania 0..1 z prędkości: od razu widać zryw, rośnie z trzymaniem, opada razem z hamowaniem
    const p = Math.min(1, Math.max(0, (this.spinRate - 1) / (SPIN_MAX - 1))) ** (1 / SPIN_CURVE);
    if (this.shadow) {
      // Poświata dopiero przy mocniejszym rozkręceniu: najpierw widać sam dociśnięty cień karty (style.css)
      const q = Math.max(0, (p - 0.3) / 0.7);
      this.shadow.style.opacity = (0.6 * q).toFixed(3);
      this.shadow.style.transform = `translateY(${(6 + 12 * p).toFixed(1)}px) scale(${(0.95 + 0.07 * p).toFixed(3)}, ${(0.92 + 0.25 * p).toFixed(3)})`;
    }
    let g;
    if (this.launch) {
      g = this.burstAt ? Math.exp(-(now - this.burstAt) / 420) : 0;
    } else {
      g = Math.min(1, Math.max(0, (this.spinRate - GLOW_FROM) / (SPIN_MAX - GLOW_FROM))) ** 1.3;
    }
    this.glow.style.opacity = g.toFixed(3);
    this.glow.style.transform = `scale(${(0.8 + 0.45 * g).toFixed(3)})`;
    const shake = !this.launch && this.holding ? 4 * g : 0;
    this.root.style.transform = shake > 0.2
      ? `translate(${((Math.random() - 0.5) * shake).toFixed(2)}px, ${((Math.random() - 0.5) * shake).toFixed(2)}px)`
      : '';
  }

  // Wystrzał: od zewnętrznego okręgu, co FLY_GAP ms jeden okrąg odlatuje na zewnątrz i gaśnie, słońce
  // przy każdym błyska, a telefon (Android) lekko pyka
  fire() {
    this.launch = 'flying';
    this.burstAt = performance.now();
    this.explode();
    const order = this.rings.filter(ring => ring.now.op > 0.05).reverse();
    const t0 = performance.now();
    order.forEach((ring, k) => { ring.fly = { at: t0 + k * FLY_GAP, r: ring.now.r, op: ring.now.op, width: ring.now.width }; });
    const core = this.root.querySelector('.orb-core-svg');
    let fired = 0;
    const step = now => {
      let flying = false;
      order.forEach(ring => {
        const p = (now - ring.fly.at) / FLY_MS;
        if (p < 0) {
          flying = true;
          return;
        }
        if (!ring.fly.shot) {
          ring.fly.shot = true;
          fired++;
          core.classList.remove('pop');
          void core.getBoundingClientRect();  // błysk od nowa przy każdym wystrzale
          core.classList.add('pop');
          // Pyknięcia dopiero po wibracji wybuchu (nowa wibracja przerywa poprzednią), co trzeci okrąg
          if (fired % 3 === 0 && now - t0 > 160) navigator.vibrate?.(5);
        }
        const q = Math.min(1, p);
        // Gwałtownie na starcie, z wytracaniem prędkości (jak odrzucone wybuchem), gasną pod koniec lotu
        ring.now.r = ring.fly.r + FLY_DIST * (1 - (1 - q) ** 3);
        ring.now.op = ring.fly.op * (1 - q) ** 1.2;
        ring.now.width = ring.fly.width * (1 + 2 * q);
        this.paint(ring);
        if (q < 1) flying = true;
      });
      if (flying) {
        requestAnimationFrame(step);
        return;
      }
      this.launch = 'out';
      if (!this.holding) this.regrow();
    };
    requestAnimationFrame(step);
  }

  // Eksplozja: błysk ze słońca, dwie fale uderzeniowe, iskry we wszystkie strony i wstrząs karty.
  // Wszystko to elementy z animacjami CSS (przezroczystość i transformacje), usuwane po chwili.
  explode() {
    const slot = this.root.parentElement;
    const sparks = Array.from({ length: SPARKS }, () => {
      const spark = el('span', { class: `orb-spark${Math.random() < 0.45 ? ' hot' : ''}` });
      spark.style.setProperty('--a', `${Math.round(Math.random() * 360)}deg`);
      spark.style.setProperty('--dist', `${Math.round(90 + Math.random() * 120)}px`);
      spark.style.setProperty('--len', `${Math.round(10 + Math.random() * 22)}px`);
      spark.style.setProperty('--dur', `${(0.45 + Math.random() * 0.45).toFixed(2)}s`);
      return spark;
    });
    const fx = el('div', { class: 'orb-fx' }, [
      el('span', { class: 'orb-flash' }),
      el('span', { class: 'orb-shock' }),
      el('span', { class: 'orb-shock s2' }),
      ...sparks,
    ]);
    slot.appendChild(fx);
    setTimeout(() => fx.remove(), 1300);
    const hero = this.root.closest('.shelf-hero');
    if (hero) {
      hero.classList.remove('boom');
      void hero.offsetWidth;  // wstrząs od nowa przy kolejnej eksplozji
      hero.classList.add('boom');
      setTimeout(() => hero.classList.remove('boom'), 600);
    }
    navigator.vibrate?.([35, 40, 70]);
  }

  // Po wystrzale okręgi wyrastają z powrotem ze środka (zwykłe przejście do docelowego kształtu)
  regrow() {
    this.launch = 'regrow';
    this.rings.forEach(ring => {
      delete ring.fly;
      Object.assign(ring.now, { r: ring.to.r * 0.25, len: 0, op: 0, arc: 0 });
    });
    this.start(true);
    setTimeout(() => { if (this.launch === 'regrow') this.launch = null; }, MORPH_MS);
  }

  // Wejście na Półkę: okręgi wyrastają od nowa ze środka do swoich miejsc (jak przy pierwszym rysowaniu)
  replay() {
    if (reducedMotion() || this.launch || !this.rings.length) return;
    this.rings.forEach(ring => Object.assign(ring.now, { r: ring.to.r * 0.3, len: 0, op: 0, arc: 0, tilt: ring.to.tilt - 70 }));
    this.start(true);
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
    if (animate) this.swapSpin();
    this.start(animate);
  }

  start(animate) {
    this.rings.forEach(ring => { ring.from = { ...ring.now }; });
    this.colorFrom = { ...this.color };
    this.t0 = performance.now();
    this.last = this.t0;
    this.duration = animate && !reducedMotion() ? MORPH_MS : 0;
    if (!this.raf) this.raf = requestAnimationFrame(t => this.frame(t));
  }

  frame(time) {
    // Długa przerwa w klatkach (apka w tle): przejście czeka, zamiast od razu przeskoczyć do końca. Próg 1 s:
    // krótsze przycięcia (np. przy wejściu na ekran) nie mogą wstrzymywać przejścia
    if (time - this.last > 1000) this.t0 += time - this.last - 16;
    this.last = time;
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
      for (const part of [...ring.parts, ring.halo, ring.dot]) part.setAttribute('class', `${part.classList[0]} ${kind}`);
    }
    const empty = late ? !!to.empty : ring.empty ?? !!to.empty;
    if (empty !== ring.empty) {
      ring.empty = empty;
      ring.track.classList.toggle('empty', empty);
    }
    this.paint(ring);
  }

  // Wpisuje bieżący kształt okręgu (ring.now) w SVG
  paint(ring) {
    const { now } = ring;
    const r = now.r.toFixed(2);
    ring.g.setAttribute('transform', `rotate(${now.tilt.toFixed(2)} ${C} ${C})`);
    ring.g.setAttribute('opacity', now.op.toFixed(3));
    ring.track.setAttribute('r', r);
    // Kometa: każdy kawałek to ten sam okrąg, przycięty kreskowaniem do końcówki łuku (przesunięcie
    // zamiast kreski zerowej długości, która z zaokrąglonym końcem rysowała kropkę na starcie)
    const partOp = (now.arc * COMET_ALPHA).toFixed(3);
    ring.parts.forEach((part, k) => {
      const t = k / (COMET_PARTS - 1);                  // 0 = cały ogon, 1 = sama głowa
      const seg = now.len * (1 - t * (1 - COMET_HEAD));
      part.setAttribute('r', r);
      part.setAttribute('stroke-dasharray', `${seg.toFixed(2)} 360`);
      part.setAttribute('stroke-dashoffset', (-(now.len - seg)).toFixed(2));
      part.setAttribute('stroke-width', (now.width * (0.35 + 0.65 * t)).toFixed(2));
      part.setAttribute('opacity', partOp);
    });
    // „Planeta” na końcu łuku (łuk zaczyna się na godzinie 3 i idzie zgodnie z zegarem)
    const a = (now.len * Math.PI) / 180;
    const px = (C + now.r * Math.cos(a)).toFixed(2);
    const py = (C + now.r * Math.sin(a)).toFixed(2);
    const arcOp = now.arc.toFixed(3);
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

// Warstwa koloru: gradient i plamy. Plamy siedzą w dwóch opakowaniach: „wir” rusza całą grupą, a każde
// opakowanie plamy osobno (np. wyrasta przy rozkwicie); sama plama w tym czasie dalej dryfuje.
function paintLayer(h, s) {
  const paint = el('div', { class: 'aura-paint' }, [
    el('div', { class: 'aura-swirl' }, [1, 2, 3, 4].map(i => el('span', { class: `blob-wrap w${i}` }, [el('span', { class: `mesh-blob m${i}` })]))),
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
    starField(),
    slot,
    el('span', { class: 'aura-grain' }),
  ]);
}

/* ----- Gwiazdy w tle karty ----- */
// Niebo rysowane raz na canvasie (na nowo tylko przy zmianie rozmiaru karty): mnóstwo drobnych gwiazd
// w odcieniach bieli, błękitu i ciepłej bieli, jaśniejsze z poświatą, do tego delikatne pasmo jak Droga
// Mleczna. Nad nim kilka migoczących gwiazd z czteroramiennym błyskiem i co jakiś czas spadająca gwiazda.
// Ruch to tylko przezroczystość i przesunięcia (style.css), niebo powoli dryfuje.
const STAR_TINTS = [[255, 255, 255], [255, 255, 255], [255, 255, 255], [200, 220, 255], [210, 228, 255], [255, 232, 205]];

function drawSky(canvas) {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!W || !H) return;
  // Niebo jest większe od karty (krąży wokół słońca), więc na dużych ekranach mniej pikseli na punkt
  const dpr = Math.min(2, window.devicePixelRatio || 1, 1600 / Math.max(W, H));
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const rand = seeded('czytanko-niebo');
  const star = (x, y, r, alpha) => {
    const [cr, cg, cb] = STAR_TINTS[Math.floor(rand() * STAR_TINTS.length)];
    if (r > 0.8) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.5);
      glow.addColorStop(0, `rgb(${cr} ${cg} ${cb} / ${alpha * 0.28})`);
      glow.addColorStop(1, `rgb(${cr} ${cg} ${cb} / 0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(x - r * 3.5, y - r * 3.5, r * 7, r * 7);
    }
    ctx.fillStyle = `rgb(${cr} ${cg} ${cb} / ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  // Pasmo jak Droga Mleczna: ukośna, ledwo widoczna poświata i zagęszczenie drobnych gwiazd wzdłuż niej
  const band = (x, y) => Math.abs((x / W) * 0.55 + (1 - y / H) * 0.45 - 0.62);
  const haze = ctx.createLinearGradient(0, H, W, 0);
  haze.addColorStop(0.3, 'rgb(255 255 255 / 0)');
  haze.addColorStop(0.62, 'rgb(220 225 255 / 0.05)');
  haze.addColorStop(0.9, 'rgb(255 255 255 / 0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);
  const count = Math.round((W * H) / 520);
  for (let i = 0; i < count; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const near = Math.max(0, 1 - band(x, y) * 6);  // 1 na środku pasma, 0 z dala
    if (rand() > 0.35 + 0.65 * near && rand() < 0.5) continue;  // poza pasmem rzadziej
    // Przeważnie drobniutkie punkciki, tylko nieliczne trochę większe
    const r = 0.22 + rand() ** 5 * 0.95;
    star(x, y, r, 0.35 + rand() * 0.6);
  }
}

function starField() {
  const rand = seeded('czytanko-iskry');
  const canvas = el('canvas', { class: 'stars-sky' });
  // Migoczące gwiazdy: więcej po prawej (tam orbita), każda w swoim rytmie
  const twinkles = Array.from({ length: 6 }, () => {
    const s = el('span', { class: 'star-twinkle' });
    s.style.left = `${(25 + rand() * 72).toFixed(1)}%`;
    s.style.top = `${(6 + rand() * 80).toFixed(1)}%`;
    s.style.setProperty('--size', `${Math.round(5 + rand() * 4)}px`);
    s.style.setProperty('--dur', `${(2.6 + rand() * 3.4).toFixed(2)}s`);
    s.style.setProperty('--delay', `${(-rand() * 6).toFixed(2)}s`);
    return s;
  });
  const shooting = [0, 1].map(i => el('span', { class: `star-shoot s${i}` }));
  const drift = el('div', { class: 'stars-drift' }, [canvas]);
  const field = el('div', { class: 'aura-stars' }, [drift, ...twinkles, ...shooting]);
  // Niebo krąży wokół słońca orbity (prawa strona karty): to kwadratowa warstwa ze środkiem w słońcu,
  // na tyle duża, żeby przy każdym kącie obrotu zakrywała całą kartę. Rysujemy je, gdy karta ma wymiary,
  // i od nowa przy zmianie rozmiaru (obrót telefonu).
  let size = '';
  new ResizeObserver(() => {
    const W = field.clientWidth;
    const H = field.clientHeight;
    const next = `${W}x${H}`;
    if (!W || !H || next === size) return;
    size = next;
    const sunX = W * SKY_PIVOT[0];
    const sunY = H * SKY_PIVOT[1];
    const reach = Math.ceil(Math.max(Math.hypot(sunX, sunY), Math.hypot(W - sunX, sunY), Math.hypot(sunX, H - sunY), Math.hypot(W - sunX, H - sunY)) + 8);
    Object.assign(drift.style, { left: `${sunX - reach}px`, top: `${sunY - reach}px`, width: `${reach * 2}px`, height: `${reach * 2}px` });
    drawSky(canvas);
  }).observe(field);
  return field;
}

const SKY_PIVOT = [0.84, 0.43];  // gdzie na karcie jest słońce orbity (środek krążenia nieba), części szer. i wys.

// Przejścia warstwy koloru (opis w style.css); losowane, nigdy dwa razy to samo pod rząd
const EFFECTS = ['bloom', 'sweep', 'swirl'];
let lastEffect = null;

function pickEffect() {
  const options = EFFECTS.filter(fx => fx !== lastEffect);
  lastEffect = options[Math.floor(Math.random() * options.length)];
  return lastEffect;
}

// animate: nowa warstwa wchodzi nad starą jednym z przejść; przy wietrze i wirze kolor płynie przez odcień
// pośredni (warstwa-pomost w połowie drogi po kole barw). Każda warstwa jest malowana raz, potem tylko
// się przesuwa, obraca i przenika.
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
  const fx = pickEffect();
  paints.dataset.fx = fx;
  old.forEach(o => o.classList.add('leaving'));
  const added = [];
  // Krótsza droga po kole barw; przy bliskich kolorach pomost nie jest potrzebny
  const delta = ((((h - prevH) % 360) + 540) % 360) - 180;
  if ((fx === 'sweep' || fx === 'swirl') && Number.isFinite(prevH) && Math.abs(delta) > 40 && sat >= 10 && prevS >= 10) {
    const bridge = paintLayer(Math.round((prevH + delta / 2 + 360) % 360), Math.round((prevS + sat) / 2));
    bridge.classList.add('bridge');
    added.push(bridge);
  }
  fresh.classList.add('entering');
  added.push(fresh);
  paints.append(...added);
  // Gdy nowa warstwa całkiem przykryje resztę (przejścia trwają do ok. 2 s, równo z okręgami), stare i pomost znikają
  setTimeout(() => {
    [...old, ...added.filter(a => a !== fresh)].forEach(o => o.remove());
    fresh.classList.remove('entering');
  }, 2150);
}

const orbitOf = hero => hero.querySelector('.aura-orbit')._orbit;

export function replayOrbit(hero) {
  orbitOf(hero)?.replay();
}

export function holdOrbit(hero, on) {
  orbitOf(hero)?.hold(on);
}

// books = null: książki nowej osoby się wczytują (okręgi czekają przygaszone); potem przechodzą w nowe.
// animate = false: od razu w docelowym kształcie.
export function setOrbit(hero, books, seed, animate) {
  orbitOf(hero).setTargets(books && ringTargets(books, seed), animate);
}

// Apka w tle: animacje karty (obrót okręgów, dryf plam) stoją. Inaczej ich czas leci dalej i po powrocie
// wszystko przeskakuje w inne miejsce. Pauza przez Web Animations działa od razu, bez czekania na klatkę.
let frozen = [];
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    frozen = [...document.querySelectorAll('.shelf-aura')]
      .flatMap(aura => aura.getAnimations({ subtree: true }))
      .filter(anim => anim.playState === 'running');
    frozen.forEach(anim => anim.pause());
  } else {
    frozen.forEach(anim => anim.play());
    frozen = [];
  }
});
