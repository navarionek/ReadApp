import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { compactNumber, formatDay, seriesColors } from './stats.js';
import { currentYear, DAY_MS, el } from './ui.js';

/* ----------------- Wygaszacz TV: lot przez rok ----------------- */
// Abstrakcyjny lot bez końca przez tunel czasu. Kamera pędzi w głąb, a głębia to kalendarz:
// to, co daleko, dopiero nadejdzie. Każda osoba to świetlna wstęga na spirali (im więcej
// ostatnio czyta, tym grubiej świeci), a jej czoło wysuwa się tym dalej, im więcej ma punktów.
// Skończona książka to okładka w neonowej ramce nawleczona na wstęgę: zapala się, gdy czas
// do niej dojdzie, i przelatuje obok kamery. Po „dziś” skok z powrotem do stycznia i w kółko.
// Smugi za wszystkim daje wygaszanie poprzedniej klatki zamiast czyszczenia.
// Sam Canvas 2D (bez WebGL), bo telewizor nie uciągnie 3D.

const DAY = 1.6;          // jednostek głębi na dzień
const NEAR = 0.35;        // bliżej kamery nic nie rysujemy
const FAR = 75;           // jak daleko widać
const NOW_Z = 10;         // płaszczyzna „teraz” przed kamerą: tu okładki się zapalają
const RIBBON_R = 1.25;    // promień spirali wstęg (okładki siedzą na niej)
const RING_R = 2.7;       // pierścienie miesięcy
const TWIST = 0.075;      // skręt spirali na jednostkę głębi
const SPEED = 4.2;        // dni na sekundę (średnio, tempo faluje)
const TAIL_DAYS = 8;      // po „dziś” jeszcze chwila lotu przed skokiem do stycznia
const HEAT_DAYS = 20;     // jak długo wstęga świeci po skończonej książce
const STARS = 150;
const FONT = '"Orbitron", "Segoe UI", system-ui, sans-serif';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (dt, ms) => 1 - Math.exp(-dt / ms);
const rand = (a, b) => a + Math.random() * (b - a);
const firstName = name => (name || '?').split(' ')[0];
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Oś tunelu wije się w obu kierunkach (dwie sinusoidy, żeby nie było widać powtórzeń)
const pathX = z => 2.6 * Math.sin(z * 0.031) + 1.2 * Math.sin(z * 0.083 + 1.3);
const pathY = z => 1.8 * Math.cos(z * 0.027 + 0.7) + 0.9 * Math.sin(z * 0.067);

// Kolor osoby jako neon: ten sam odcień, pełne nasycenie, jasny
function neon(color) {
  const match = /^var\((--[\w-]+)\)$/.exec(color || '');
  const hex = (match ? getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() : color) || '#33e0ff';
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  let h = 190;
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    h = 0;
    if (max !== min) {
      const d = max - min;
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }
  }
  return { h, css: a => `hsla(${h}, 100%, 62%, ${a})`, solid: `hsl(${h} 100% 62%)` };
}

const covers = new Map();
function coverImage(url) {
  if (!url) return null;
  if (!covers.has(url)) {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.src = url;
    covers.set(url, img);
  }
  return covers.get(url);
}

export function createTron(container) {
  const fx = document.createElement('canvas');
  const hud = document.createElement('canvas');
  fx.className = 'tron-canvas';
  hud.className = 'tron-canvas';
  const date = el('strong', { class: 'tron-date' });
  const rank = el('ol', { class: 'tron-rank' });
  container.replaceChildren(el('div', { class: 'tron' }, [
    fx, hud,
    el('div', { class: 'tron-hud' }, [el('span', { class: 'tron-brand', text: 'CZYTANKO' }), date]),
    rank,
  ]));
  const ctx = fx.getContext('2d');
  const tx = hud.getContext('2d');

  let W = 1;
  let H = 1;
  let scale = 1;            // rozdzielczość rysowania; spada, gdy telewizor nie wyrabia
  let raf = null;
  let last = 0;
  let perf = { sum: 0, n: 0, skip: 30 };
  let racers = [];
  let events = [];
  let loopDays = 30;        // długość jednego przelotu przez rok (do dziś + ogon)
  let todayDay = 0;
  let t0 = 0;
  let heatNorm = 1;
  let travel = -4;          // ile dni przelecieliśmy od początku (rośnie bez końca)
  let time = 0;
  let kick = 0;             // chwilowe przyspieszenie (przelot okładki, skok do stycznia)
  let flash = 0;
  let flashColor = null;
  let sparks = [];
  let dateText = '';
  let rankSig = '';
  const stars = { x: new Float32Array(STARS), y: new Float32Array(STARS), z: new Float32Array(STARS), c: new Uint8Array(STARS) };

  // Kamera (liczone raz na klatkę)
  let camZ = 0;
  let camX = 0;
  let camY = 0;
  let camDX = 0;
  let camDY = 0;
  let focal = 1;
  let cosR = 1;
  let sinR = 0;
  let px = 0;
  let py = 0;
  let ps = 0;

  function resize() {
    W = Math.max(1, container.clientWidth);
    H = Math.max(1, container.clientHeight);
    [fx, hud].forEach(c => {
      c.width = Math.round(W * scale);
      c.height = Math.round(H * scale);
    });
    ctx.fillStyle = '#02030a';
    ctx.fillRect(0, 0, fx.width, fx.height);
  }

  function setData(readers, rows) {
    const colors = seriesColors(readers);
    t0 = new Date(currentYear(), 0, 1).getTime();
    todayDay = Math.max(0, (Date.now() - t0) / DAY_MS);
    loopDays = Math.floor(todayDay) + 1 + TAIL_DAYS;
    const sorted = [...readers].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    racers = sorted.map((r, i) => ({
      key: r.key,
      name: firstName(r.name).toUpperCase(),
      color: neon(colors.get(r.key)),
      phase: (i / Math.max(1, sorted.length)) * Math.PI * 2,
      events: [],
      cum: 0,
      lead: 0,
    }));
    const byKey = new Map(racers.map(r => [r.key, r]));
    events = rows
      .map(row => ({ row, r: byKey.get(row.user_id), d: (new Date(row.created_at).getTime() - t0) / DAY_MS }))
      .filter(e => e.r && e.d >= 0 && e.d < loopDays)
      .map(({ row, r, d }) => {
        const pts = bookPoints(row);
        return { r, d, pts, title: (row.title || 'bez tytułu').toUpperCase(), img: coverImage(row.cover_url), size: 0.8 + 0.5 * Math.min(1, pts / 600), tilt: rand(-0.12, 0.12) };
      })
      .sort((a, b) => a.d - b.d);
    events.forEach(e => e.r.events.push(e));
    // Najjaśniejszy moment wstęgi w roku = pełna grubość
    heatNorm = 1;
    racers.forEach(r => r.events.forEach(e => { heatNorm = Math.max(heatNorm, heat(r, e.d)); }));
    rankSig = '';
  }

  function heat(r, d) {
    let h = 0;
    for (const e of r.events) {
      if (e.d > d) break;
      h += e.pts * Math.exp(-(d - e.d) / HEAT_DAYS);
    }
    return h;
  }

  function cumAt(r, d) {
    let v = 0;
    for (const e of r.events) {
      if (e.d > d) break;
      v += e.pts;
    }
    return v;
  }

  // Dzień w bieżącym przelocie (światowe dni rosną bez końca, rok się zapętla)
  const loopDay = wd => wd - Math.floor(wd / loopDays) * loopDays;

  function start() {
    stop();
    resize();
    perf = { sum: 0, n: 0, skip: 30 };
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = null;
  }

  // Gdy klatki przez ~2 s idą wolniej niż ~40/s, rysujemy w mniejszej rozdzielczości
  // (wszystko i tak jest rozmyte smugami, różnicy prawie nie widać)
  function adapt(dt) {
    if (perf.skip > 0) {
      perf.skip--;
      return;
    }
    if (dt > 250) return;
    perf.sum += dt;
    perf.n++;
    if (perf.sum < 2000) return;
    const avg = perf.sum / perf.n;
    perf.sum = 0;
    perf.n = 0;
    if (avg > 25 && scale > 0.5) {
      scale = Math.max(0.5, scale - 0.25);
      resize();
      perf.skip = 30;
    }
  }

  // Punkt świata (x, y, głębia wz) na ekran: px, py i ps (pikseli na jednostkę); false = za kamerą.
  // Kamera patrzy wzdłuż osi tunelu, więc daleki koniec zakręca, a bliskie rzeczy zostają w kadrze.
  function project(x, y, wz) {
    const z = wz - camZ;
    if (z < NEAR) return false;
    const vx = x - camX - camDX * z;
    const vy = y - camY - camDY * z;
    ps = focal / z;
    px = W / 2 + (vx * cosR - vy * sinR) * ps;
    py = H / 2 + (vx * sinR + vy * cosR) * ps;
    return true;
  }

  const spiralX = (r, wz) => pathX(wz) + RIBBON_R * Math.cos(r.phase + wz * TWIST + time * 0.12);
  const spiralY = (r, wz) => pathY(wz) + RIBBON_R * Math.sin(r.phase + wz * TWIST + time * 0.12);

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, now - last);
    adapt(now - last);
    last = now;
    time += dt / 1000;

    // Tempo faluje (raz pędzi, raz prawie dryfuje), a przeloty okładek dają szarpnięcie do przodu
    kick *= Math.exp(-dt / 700);
    flash *= Math.exp(-dt / 350);
    const wave = 0.78 + 0.34 * Math.sin(time * 0.19) * Math.sin(time * 0.071 + 1);
    const prevTravel = travel;
    travel += (SPEED * wave * (1 + kick) * dt) / 1000;
    if (Math.floor(travel / loopDays) !== Math.floor(prevTravel / loopDays)) {
      kick += 1.6;  // skok z „dziś” do stycznia
      flash = 0.6;
      flashColor = null;
    }

    camZ = travel * DAY - NOW_Z;
    camX = pathX(camZ);
    camY = pathY(camZ);
    camDX = (pathX(camZ + 1) - pathX(camZ - 1)) / 2;
    camDY = (pathY(camZ + 1) - pathY(camZ - 1)) / 2;
    const roll = 0.3 * Math.sin(time * 0.05) + 0.18 * Math.sin(time * 0.11 + 2) - (camDX * 0.6);
    cosR = Math.cos(roll);
    sinR = Math.sin(roll);
    // Ogniskowa oddycha (powolny „zoom”), a przy szarpnięciu kadr się poszerza jak przy skoku
    focal = (H * 1.25 * (1 + 0.14 * Math.sin(time * 0.045))) / (1 + 0.22 * Math.min(kick, 2));

    const day = loopDay(travel);
    let maxCum = 0;
    racers.forEach(r => {
      r.cum = cumAt(r, day);
      maxCum = Math.max(maxCum, r.cum);
    });
    racers.forEach(r => {
      // Prowadzący jedzie najdalej w głąb, reszta za nim
      const goal = maxCum > 0 ? -4 + 9 * (r.cum / maxCum) : 0;
      r.lead += (goal - r.lead) * ease(dt, 600);
    });

    const visible = visibleEvents(prevTravel);

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(2, 3, 10, ${1 - Math.pow(0.7, dt / 16.7)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow();
    drawStars(dt);
    drawRings();
    racers.forEach(drawGuide);
    drawCovers(visible);
    ctx.globalCompositeOperation = 'lighter';
    racers.forEach(drawRibbon);
    drawSparks(dt);
    if (flash > 0.01) {
      ctx.fillStyle = flashColor ? flashColor.css(flash * 0.22) : `rgba(255, 255, 255, ${flash * 0.3})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalCompositeOperation = 'source-over';

    tx.setTransform(scale, 0, 0, scale, 0, 0);
    tx.clearRect(0, 0, W, H);
    if ('letterSpacing' in tx) tx.letterSpacing = '0.12em';
    drawMonthLabels();
    drawTitles(visible);
    racers.forEach(drawName);
    updateHud(day);
  }

  // Okładki w zasięgu wzroku (z obu sąsiednich przelotów przez rok) + zapalanie i przeloty
  function visibleEvents(prevTravel) {
    const out = [];
    const lo = (camZ + 0.9) / DAY;
    const hi = (camZ + FAR) / DAY;
    const flyBy = (NOW_Z - 2) / DAY;  // tyle dni po zapaleniu okładka mija kamerę
    for (let k = Math.floor(lo / loopDays); k <= Math.floor(hi / loopDays); k++) {
      for (const e of events) {
        const wd = k * loopDays + e.d;
        if (wd > prevTravel && wd <= travel) burst(e, wd);
        if (wd + flyBy > prevTravel && wd + flyBy <= travel) kick += 0.28 * e.size;
        if (wd < lo || wd > hi) continue;
        out.push({ e, wd, z: wd * DAY - camZ, lit: clamp((travel - wd) * 1.5, 0, 1) });
      }
    }
    return out.sort((a, b) => b.z - a.z);
  }

  // Poświata w punkcie zbiegu; kolor wędruje po kolorach osób
  function drawGlow() {
    if (!project(pathX(camZ + FAR), pathY(camZ + FAR), camZ + FAR)) return;
    const c = racers.length ? racers[Math.floor(time / 9) % racers.length].color : neon('#33e0ff');
    const R = H * 0.75;
    const g = ctx.createRadialGradient(px, py, 0, px, py, R);
    g.addColorStop(0, c.css(0.015));
    g.addColorStop(1, c.css(0));
    ctx.fillStyle = g;
    ctx.fillRect(px - R, py - R, R * 2, R * 2);
  }

  // Pył świetlny: kreski, które wydłużają się z prędkością (to on robi „ziuum”)
  function drawStars(dt) {
    const moved = (SPEED * DAY * dt) / 1000;
    const len = clamp(SPEED * DAY * 0.09 * (1 + kick), 0.2, 9);
    const paths = [new Path2D(), new Path2D(), new Path2D()];  // biały daleko, biały blisko, kolor
    for (let i = 0; i < STARS; i++) {
      let z = stars.z[i] - moved * (1 + kick);
      if (z < NEAR || stars.z[i] === 0) {
        z = stars.z[i] === 0 ? rand(NEAR, FAR) : FAR;
        const a = rand(0, Math.PI * 2);
        const rr = rand(0.5, 6);
        stars.x[i] = pathX(camZ + z) + Math.cos(a) * rr;
        stars.y[i] = pathY(camZ + z) + Math.sin(a) * rr;
        stars.c[i] = Math.random() < 0.25 ? 2 : 0;
      }
      stars.z[i] = z;
      if (!project(stars.x[i], stars.y[i], camZ + z + len)) continue;
      const x1 = px;
      const y1 = py;
      if (!project(stars.x[i], stars.y[i], camZ + z)) continue;
      const p = paths[stars.c[i] || (z < 18 ? 1 : 0)];
      p.moveTo(x1, y1);
      p.lineTo(px, py);
    }
    const accent = racers.length ? racers[Math.floor(time / 9) % racers.length].color : neon('#33e0ff');
    ctx.lineCap = 'round';
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(200, 225, 255, 0.35)';
    ctx.stroke(paths[0]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(220, 235, 255, 0.55)';
    ctx.stroke(paths[1]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = accent.css(0.6);
    ctx.stroke(paths[2]);
  }

  // Pierścienie na początkach miesięcy: przerywane, powoli się obracają
  function monthRings(fn) {
    const lo = (camZ + 1.5) / DAY;
    const hi = (camZ + FAR) / DAY;
    for (let k = Math.floor(lo / loopDays); k <= Math.floor(hi / loopDays); k++) {
      for (let m = 0; m < 12; m++) {
        const d = (new Date(currentYear(), m, 1).getTime() - t0) / DAY_MS;
        if (d >= loopDays) break;
        const wd = k * loopDays + d;
        if (wd >= lo && wd <= hi) fn(m, wd * DAY);
      }
    }
  }

  function drawRings() {
    ctx.lineWidth = 1.5;
    monthRings((m, wz) => {
      if (!project(pathX(wz), pathY(wz), wz)) return;
      const z = wz - camZ;
      const a = clamp((FAR - z) / 20, 0, 1) * clamp((z - 1.5) / 3, 0, 1);
      ctx.strokeStyle = m === 0 ? `rgba(255, 255, 255, ${a * 0.7})` : `rgba(170, 210, 255, ${a * 0.4})`;
      ctx.setLineDash([RING_R * ps * 0.5, RING_R * ps * 0.12]);
      ctx.lineDashOffset = time * ps * 0.4;
      ctx.beginPath();
      ctx.arc(px, py, RING_R * ps, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  function drawMonthLabels() {
    tx.textAlign = 'center';
    tx.textBaseline = 'bottom';
    monthRings((m, wz) => {
      const z = wz - camZ;
      if (z > 34 || z < 3) return;
      if (!project(pathX(wz), pathY(wz) - RING_R, wz)) return;
      const a = clamp((34 - z) / 8, 0, 1) * clamp((z - 3) / 3, 0, 1);
      const size = clamp(ps * 0.32, H * 0.02, H * 0.09);
      const name = m === 0 ? String(currentYear()) : new Intl.DateTimeFormat('pl', { month: 'long' }).format(new Date(currentYear(), m, 1)).toUpperCase();
      tx.font = `600 ${Math.round(size)}px ${FONT}`;
      tx.fillStyle = `rgba(210, 230, 255, ${a * 0.55})`;
      tx.fillText(name, px, py - size * 0.3);
    });
  }

  // Cienka przerywana linia toru przed czołem wstęgi (dokąd jedzie)
  function drawGuide(r) {
    const head = travel * DAY + r.lead;
    ctx.beginPath();
    let moved = false;
    for (let i = 0; i <= 24; i++) {
      const wz = head + (camZ + FAR - head) * (i / 24) ** 1.4;
      if (!project(spiralX(r, wz), spiralY(r, wz), wz)) continue;
      if (moved) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      moved = true;
    }
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 10]);
    ctx.strokeStyle = r.color.css(0.16);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Okładki zwrócone do widza, nawleczone na wstęgę osoby; przed „teraz” przygaszone
  function drawCovers(visible) {
    visible.forEach(({ e, wd, z, lit }) => {
      const wz = wd * DAY;
      if (!project(spiralX(e.r, wz), spiralY(e.r, wz), wz)) return;
      const fade = clamp((FAR - z) / 18, 0, 1) * clamp((z - 0.9) / 0.8, 0, 1);
      if (fade <= 0) return;
      const w = 1.1 * e.size * ps;
      const h = 1.65 * e.size * ps;
      const ang = Math.atan2(sinR, cosR) + e.tilt;
      ctx.setTransform(scale * Math.cos(ang), scale * Math.sin(ang), -scale * Math.sin(ang), scale * Math.cos(ang), px * scale, py * scale);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = fade * (0.22 + 0.73 * lit);
      if (e.img?.complete && e.img.naturalWidth) ctx.drawImage(e.img, -w / 2, -h / 2, w, h);
      else {
        ctx.fillStyle = e.r.color.css(0.14);
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = Math.max(4, 0.16 * ps);
      ctx.strokeStyle = e.r.color.css(fade * 0.14 * lit);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.lineWidth = Math.max(1, 0.03 * ps);
      ctx.strokeStyle = e.r.color.css(fade * (0.3 + 0.7 * lit));
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    });
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  // Tytuł i punkty przy zapalonej okładce, aż przeleci obok kamery
  function drawTitles(visible) {
    tx.textAlign = 'center';
    visible.forEach(({ e, wd, z, lit }) => {
      if (lit <= 0 || z < 1.2) return;
      const wz = wd * DAY;
      if (!project(spiralX(e.r, wz), spiralY(e.r, wz), wz)) return;
      const a = lit * clamp((z - 1.2) / 1.5, 0, 1);
      const size = clamp(ps * 0.16, H * 0.018, H * 0.05);
      const top = py - 0.83 * e.size * ps - size * 0.5;
      tx.textBaseline = 'bottom';
      tx.font = `800 ${Math.round(size)}px ${FONT}`;
      tx.fillStyle = `rgba(255, 255, 255, ${a})`;
      tx.fillText(short(e.title, 28), px, top);
      tx.font = `600 ${Math.round(size * 0.7)}px ${FONT}`;
      tx.fillStyle = e.r.color.css(a);
      tx.fillText(`${e.r.name}  +${e.pts}`, px, top - size * 1.15);
    });
  }

  // Wstęga: wielokąt od czoła do kamery, grubszy tam, gdzie osoba dużo czytała;
  // kilka warstw od szerokiej mgły do białego rdzenia = neon bez drogiego shadowBlur
  const N = 40;
  const xs = new Float32Array(N + 1);
  const ys = new Float32Array(N + 1);
  const hs = new Float32Array(N + 1);
  function drawRibbon(r) {
    const headZ = NOW_Z + r.lead;
    let n = 0;
    for (let i = 0; i <= N; i++) {
      const z = NEAR * 1.05 * Math.pow(headZ / (NEAR * 1.05), i / N);
      const wz = camZ + z;
      if (!project(spiralX(r, wz), spiralY(r, wz), wz)) continue;
      const hNorm = Math.min(1, heat(r, loopDay(wz / DAY)) / heatNorm);
      xs[n] = px;
      ys[n] = py;
      hs[n] = (0.018 + 0.075 * hNorm) * ps;
      n++;
    }
    if (n < 2) return;
    const hNow = Math.min(1, heat(r, loopDay(travel)) / heatNorm);
    [[5, 0.05], [2.2, 0.14], [1, 0.7]].forEach(([mult, a]) => {
      ribbonPath(n, mult);
      ctx.fillStyle = r.color.css(a * (0.55 + 0.45 * hNow));
      ctx.fill();
    });
    ribbonPath(n, 0.3);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fill();

    // Czoło: rozbłysk i jasny punkt
    const hx = xs[n - 1];
    const hy = ys[n - 1];
    const s = focal / headZ;
    const R = s * (0.5 + 0.3 * hNow);
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, R);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
    g.addColorStop(0.15, r.color.css(0.6));
    g.addColorStop(1, r.color.css(0));
    ctx.fillStyle = g;
    ctx.fillRect(hx - R, hy - R, R * 2, R * 2);
    r.hx = hx;
    r.hy = hy;
    r.hs = s;
  }

  function ribbonPath(n, mult) {
    ctx.beginPath();
    const side = (i, dir) => {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const len = Math.hypot(dx, dy) || 1;
      const w = hs[i] * mult * dir;
      return [xs[i] - (dy / len) * w, ys[i] + (dx / len) * w];
    };
    for (let i = 0; i < n; i++) {
      const [x, y] = side(i, 1);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const [x, y] = side(i, -1);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawName(r) {
    if (r.hx == null) return;
    const size = clamp(r.hs * 0.24, H * 0.016, H * 0.03);
    tx.font = `700 ${Math.round(size)}px ${FONT}`;
    tx.textAlign = 'left';
    tx.textBaseline = 'middle';
    tx.fillStyle = r.color.css(0.9);
    tx.fillText(r.name, r.hx + size * 1.1, r.hy);
  }

  // Zapalenie okładki: iskry w przestrzeni (zostają w świecie, więc kamera przez nie przelatuje)
  function burst(e, wd) {
    const wz = wd * DAY;
    const x = spiralX(e.r, wz);
    const y = spiralY(e.r, wz);
    for (let i = 0; i < 28; i++) {
      const life = rand(0.7, 1.4);
      sparks.push({ r: e.r, x, y, z: wz, vx: rand(-2.6, 2.6), vy: rand(-2.6, 2.6), vz: rand(-3, 3), life, max: life });
    }
    if (sparks.length > 300) sparks.splice(0, sparks.length - 300);
    flash = Math.max(flash, 0.25);
    flashColor = e.r.color;
  }

  function drawSparks(dt) {
    const s = dt / 1000;
    sparks = sparks.filter(sp => (sp.life -= s) > 0);
    const paths = new Map();
    sparks.forEach(sp => {
      const damp = Math.exp(-1.5 * s);
      sp.vx *= damp;
      sp.vy *= damp;
      sp.vz *= damp;
      sp.x += sp.vx * s;
      sp.y += sp.vy * s;
      sp.z += sp.vz * s;
      if (!project(sp.x - sp.vx * 0.06, sp.y - sp.vy * 0.06, sp.z - sp.vz * 0.06)) return;
      const x1 = px;
      const y1 = py;
      if (!project(sp.x, sp.y, sp.z)) return;
      if (!paths.has(sp.r)) paths.set(sp.r, new Path2D());
      const p = paths.get(sp.r);
      p.moveTo(x1, y1);
      p.lineTo(px, py);
    });
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    paths.forEach((p, r) => {
      ctx.strokeStyle = r.color.css(0.85);
      ctx.stroke(p);
    });
  }

  // Data i ranking w rogach (DOM: ostre litery, zmienia się rzadko)
  function updateHud(day) {
    const text = day >= todayDay ? 'DZIŚ' : formatDay(new Date(t0 + day * DAY_MS)).toUpperCase();
    if (text !== dateText) {
      dateText = text;
      date.textContent = text;
    }
    const ranked = [...racers].sort((a, b) => b.cum - a.cum || a.name.localeCompare(b.name));
    const sig = ranked.map(r => `${r.key}:${r.cum}`).join('|');
    if (sig === rankSig) return;
    rankSig = sig;
    rank.replaceChildren(...ranked.map(r => {
      const li = el('li', {}, [el('b', { text: r.name }), el('span', { text: compactNumber(Math.round(r.cum)) })]);
      li.style.setProperty('--c', r.color.solid);
      return li;
    }));
  }

  return { setData, start, stop, resize };
}
