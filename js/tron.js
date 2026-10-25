import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { compactNumber, formatDay, seriesColors } from './stats.js';
import { currentYear, DAY_MS } from './ui.js';

/* ----------------- Wygaszacz TV: wyścig w stylu Tron ----------------- */
// Każda osoba to świetlny motocykl ciągnący neonową smugę. Czas płynie w prawo, a skończona
// książka to ostry skręt w górę o tyle, ile była warta punktów: smugi to po prostu wykres
// punktów narastająco, tylko z zakrętami pod kątem prostym jak w filmie. Na końcu kamera
// odjeżdża i pokazuje cały rok. Sam Canvas 2D (bez WebGL), bo telewizor nie uciągnie 3D.

const PLAY_MS = 40000;      // od 1 stycznia do dziś
const ZOOM_MS = 4000;       // odjazd kamery na cały rok
const WINDOW_DAYS = 70;     // ile dni widać w trakcie jazdy
const HEAD_X = 0.7;         // gdzie na ekranie jadą motocykle (ułamek szerokości)
const HORIZON = 0.8;        // linia horyzontu (ułamek wysokości); poniżej podłoga z siatką
const TOP = 0.2;            // najwyższy punkt wykresu (pod napisami)
const FONT = '"Orbitron", "Segoe UI", system-ui, sans-serif';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (dt, ms) => 1 - Math.exp(-dt / ms);
const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const rand = (a, b) => a + Math.random() * (b - a);
const firstName = name => (name || '?').split(' ')[0];

// Kolor osoby jako neon: ten sam odcień, pełne nasycenie, jasny
function neon(color) {
  const match = /^var\((--[\w-]+)\)$/.exec(color || '');
  const hex = (match ? getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() : color) || '#33e0ff';
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) return { h: 190, css: a => `hsla(190, 100%, 60%, ${a})` };
  const [r, g, b] = [m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  return { h, css: a => `hsla(${h}, 100%, 62%, ${a})` };
}

export function createTron(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'tron-canvas';
  container.replaceChildren(canvas);
  const ctx = canvas.getContext('2d');

  let W = 1;
  let H = 1;
  let scale = 1;            // rozdzielczość rysowania; spada, gdy telewizor nie wyrabia
  let raf = null;
  let startAt = 0;
  let last = 0;
  let perf = { sum: 0, n: 0, skip: 30 };
  let racers = [];
  let t0 = 0;
  let t1 = 1;
  let vMax = 150;
  let floorPhase = 0;
  let sparks = [];
  let texts = [];

  function resize() {
    W = Math.max(1, container.clientWidth);
    H = Math.max(1, container.clientHeight);
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
  }

  function setData(readers, rows) {
    const colors = seriesColors(readers);
    t0 = new Date(currentYear(), 0, 1).getTime();
    t1 = Math.max(Date.now(), t0 + DAY_MS);
    racers = [...readers]
      .sort((a, b) => a.name.localeCompare(b.name, 'pl'))
      .map(r => {
        const events = rows
          .filter(row => row.user_id === r.key)
          .map(row => ({ t: new Date(row.created_at).getTime(), pts: bookPoints(row), title: row.title || 'bez tytułu' }))
          .sort((a, b) => a.t - b.t);
        return { key: r.key, name: firstName(r.name).toUpperCase(), color: neon(colors.get(r.key)), events, total: events.reduce((s, e) => s + e.pts, 0), shown: 0, seen: 0, rank: 0 };
      });
  }

  function start() {
    stop();
    resize();
    racers.forEach(r => { r.shown = 0; r.seen = 0; });
    sparks = [];
    texts = [];
    vMax = 150;
    perf = { sum: 0, n: 0, skip: 30 };
    startAt = performance.now();
    last = startAt;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = null;
  }

  // Gdy klatki przez ~2 s idą wolniej niż ~40/s, rysujemy w mniejszej rozdzielczości
  // (neon i tak jest rozmyty, różnicy prawie nie widać)
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

  const valueAt = (r, t) => {
    let v = 0;
    for (const e of r.events) {
      if (e.t > t) break;
      v += e.pts;
    }
    return v;
  };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, now - last);
    adapt(now - last);
    last = now;
    const elapsed = now - startAt;
    const p = clamp(elapsed / PLAY_MS, 0, 1);
    const t = t0 + p * (t1 - t0);
    const zoom = easeInOut(clamp((elapsed - PLAY_MS - 600) / ZOOM_MS, 0, 1));

    // Skala czasu: w trakcie jazdy okno ~70 dni, po odjeździe kamery cały rok na ekranie
    const pxPerMsRide = (W * (HEAD_X - 0.04)) / (WINDOW_DAYS * DAY_MS);
    // Po odjeździe: rok od 6% do 82% szerokości, z prawej zostaje miejsce na imiona i punkty
    const pxPerMsAll = (W * 0.76) / (t1 - t0);
    const pxPerMs = pxPerMsRide + (pxPerMsAll - pxPerMsRide) * zoom;
    const headX = (HEAD_X + (0.82 - HEAD_X) * zoom) * W;
    const x = time => headX - (t - time) * pxPerMs;

    // Wartości, zdarzenia (skręty w górę) i skala pionowa, która rośnie razem z liderem
    let lead = 0;
    racers.forEach(r => {
      const v = valueAt(r, t);
      while (r.seen < r.events.length && r.events[r.seen].t <= t) {
        const before = r.events.slice(0, r.seen).reduce((s, ev) => s + ev.pts, 0);
        const e = r.events[r.seen++];
        if (p > 0) burst(r, e, before);
      }
      r.target = v;
      r.shown += (v - r.shown) * ease(dt, 140);  // szybki podjazd w górę zamiast przeskoku
      lead = Math.max(lead, v);
    });
    const vGoal = zoom > 0 ? Math.max(...racers.map(r => r.total), 150) * 1.12 : Math.max(150, lead * 1.18);
    vMax += (vGoal - vMax) * ease(dt, 500);
    const baseY = HORIZON * H;
    const y = v => baseY - (v / vMax) * (HORIZON - TOP) * H;

    floorPhase = (floorPhase + dt * 0.0011 * (1 - zoom * 0.7)) % 1;

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawSky();
    drawFloor();
    drawTimeGrid(x, baseY);
    ctx.globalCompositeOperation = 'lighter';
    racers.forEach(r => drawTrail(r, x, y, t));
    drawSparks(dt, x, y);
    ctx.globalCompositeOperation = 'source-over';
    fadeLeft();
    racers.forEach(r => drawHead(r, x(t), y(r.shown)));
    drawLabels(x(t), y);
    drawTexts(dt, x, y);
    drawHud(t, p);
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#010208');
    g.addColorStop(HORIZON * 0.75, '#050a1c');
    g.addColorStop(HORIZON, '#0b1030');
    g.addColorStop(1, '#020309');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Podłoga: perspektywiczna siatka pędząca w stronę widza i świecący horyzont
  function drawFloor() {
    const hy = HORIZON * H;
    const floorH = H - hy;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, hy, W, floorH);
    ctx.clip();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 46, 196, 0.35)';
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const z = i + 1 - floorPhase;
      const yy = hy + floorH / z;
      ctx.moveTo(0, yy);
      ctx.lineTo(W, yy);
    }
    const vx = W / 2;
    for (let k = -24; k <= 24; k++) {
      ctx.moveTo(vx, hy);
      ctx.lineTo(vx + k * W * 0.09, H);
    }
    ctx.stroke();
    ctx.restore();

    // Horyzont: szeroka poświata i ostra linia
    const glow = ctx.createLinearGradient(0, hy - H * 0.08, 0, hy + H * 0.05);
    glow.addColorStop(0, 'rgba(0, 220, 255, 0)');
    glow.addColorStop(0.62, 'rgba(0, 220, 255, 0.16)');
    glow.addColorStop(1, 'rgba(255, 46, 196, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, hy - H * 0.08, W, H * 0.13);
    ctx.fillStyle = 'rgba(160, 250, 255, 0.9)';
    ctx.fillRect(0, hy - 1, W, 2);
  }

  // Pionowe linie na początkach miesięcy i ich nazwy przy horyzoncie
  function drawTimeGrid(x, baseY) {
    ctx.font = `600 ${Math.round(H * 0.018)}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let m = 0; m <= new Date(t1).getMonth(); m++) {
      const xm = x(new Date(currentYear(), m, 1).getTime());
      if (xm < -10 || xm > W) continue;
      ctx.fillStyle = 'rgba(0, 220, 255, 0.07)';
      ctx.fillRect(xm, TOP * H * 0.8, 1, baseY - TOP * H * 0.8);
      ctx.fillStyle = 'rgba(0, 220, 255, 0.45)';
      ctx.fillText(formatDay(new Date(currentYear(), m, 1)).split(' ')[1].toUpperCase(), xm + 6, baseY + 8);
    }
  }

  // Smuga: poziomo (czas), pionowo w momencie skończenia książki; trzy warstwy = neon
  function drawTrail(r, x, y, t) {
    ctx.beginPath();
    let v = 0;
    ctx.moveTo(x(t0), y(0));
    for (let i = 0; i < r.seen; i++) {
      const e = r.events[i];
      const xe = x(e.t);
      ctx.lineTo(xe, y(v));
      // Ostatni skręt może jeszcze trwać: smuga sięga tylko tam, gdzie jest motocykl
      v = i === r.seen - 1 ? Math.max(v, r.shown) : v + e.pts;
      ctx.lineTo(xe, y(v));
    }
    ctx.lineTo(x(t), y(r.shown));
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    [[H * 0.04, 0.07], [H * 0.02, 0.16], [H * 0.009, 0.4], [H * 0.004, 1]].forEach(([w, a]) => {
      ctx.lineWidth = w;
      ctx.strokeStyle = r.color.css(a);
      ctx.stroke();
    });
    ctx.lineWidth = Math.max(1, H * 0.0012);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();
  }

  // Lewa krawędź gaśnie do tła: stare odcinki smug „wygasają” jak ściany świetlne
  function fadeLeft() {
    const g = ctx.createLinearGradient(0, 0, W * 0.22, 0);
    g.addColorStop(0, 'rgba(3, 5, 16, 1)');
    g.addColorStop(1, 'rgba(3, 5, 16, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W * 0.22, H * HORIZON);
  }

  function drawHead(r, hx, hy) {
    const R = H * 0.045;
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, R);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    g.addColorStop(0.18, r.color.css(0.8));
    g.addColorStop(1, r.color.css(0));
    ctx.fillStyle = g;
    ctx.fillRect(hx - R, hy - R, R * 2, R * 2);
    // Motocykl: krótka świetlna belka z ostrym nosem
    const len = H * 0.035;
    const th = H * 0.009;
    ctx.fillStyle = r.color.css(1);
    ctx.beginPath();
    ctx.moveTo(hx - len, hy - th);
    ctx.lineTo(hx + th * 0.6, hy - th);
    ctx.lineTo(hx + th * 1.8, hy);
    ctx.lineTo(hx + th * 0.6, hy + th);
    ctx.lineTo(hx - len, hy + th);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillRect(hx - len * 0.7, hy - th * 0.3, len * 0.7, th * 0.6);
  }

  // Imiona przy motocyklach; gdy się nakładają, rozsuwamy je w pionie
  function drawLabels(hx, y) {
    const size = Math.round(H * 0.026);
    const gap = size * 1.5;
    const items = racers.map(r => ({ r, ly: y(r.shown) })).sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < items.length; i++) items[i].ly = Math.max(items[i].ly, items[i - 1].ly + gap);
    const ranked = [...racers].sort((a, b) => b.target - a.target || a.name.localeCompare(b.name));
    ranked.forEach((r, i) => { r.rank = i + 1; });
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    items.forEach(({ r, ly }) => {
      ctx.font = `800 ${size}px ${FONT}`;
      ctx.shadowColor = r.color.css(0.9);
      ctx.shadowBlur = size * 0.6;
      ctx.fillStyle = r.color.css(1);
      ctx.fillText(r.name, hx + H * 0.035, ly);
      ctx.shadowBlur = 0;
      const nameW = ctx.measureText(r.name).width;
      ctx.font = `500 ${Math.round(size * 0.8)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillText(compactNumber(Math.round(r.target)), hx + H * 0.035 + nameW + size * 0.5, ly);
    });
  }

  // Skończona książka: iskry na zakręcie (przypięte do tego miejsca na wykresie, więc
  // przesuwają się razem z nim) i neonowy tytuł z punktami nad zakrętem
  function burst(r, e, before) {
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(0.05, 0.35) * H;
      const life = rand(0.5, 1);
      sparks.push({ r, t: e.t, v: before, vx: Math.cos(a) * s, vy: Math.sin(a) * s, dx: 0, dy: 0, life, max: life });
    }
    texts.push({ r, t: e.t, v: before + e.pts, text: `${e.title.toUpperCase()}  +${e.pts}`, age: 0 });
    if (texts.length > 4) texts.shift();
  }

  function drawSparks(dt, x, y) {
    const s = dt / 1000;
    sparks = sparks.filter(sp => (sp.life -= s) > 0);
    sparks.forEach(sp => {
      sp.vx *= Math.exp(-3 * s);
      sp.vy *= Math.exp(-3 * s);
      sp.dx += sp.vx * s;
      sp.dy += sp.vy * s;
      const k = sp.life / sp.max;
      ctx.fillStyle = sp.r.color.css(k);
      const size = H * 0.006 * (0.5 + k);
      ctx.fillRect(x(sp.t) + sp.dx - size / 2, y(sp.v) + sp.dy - size / 2, size, size);
    });
  }

  function drawTexts(dt, x, y) {
    const size = Math.round(H * 0.024);
    ctx.font = `700 ${size}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    texts = texts.filter(tx => (tx.age += dt) < 2600);
    texts.forEach(tx => {
      const k = tx.age / 2600;
      const alpha = k < 0.1 ? k / 0.1 : 1 - Math.max(0, (k - 0.6) / 0.4);
      ctx.shadowColor = tx.r.color.css(0.9);
      ctx.shadowBlur = size * 0.7;
      ctx.fillStyle = tx.r.color.css(alpha);
      ctx.fillText(tx.text, x(tx.t) - H * 0.015, y(tx.v) - H * 0.02 - k * H * 0.03);
    });
    ctx.shadowBlur = 0;
  }

  function drawHud(t, p) {
    const pad = H * 0.05;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(H * 0.022)}px ${FONT}`;
    ctx.fillStyle = 'rgba(0, 220, 255, 0.75)';
    ctx.fillText('CZYTANKO  //  WYŚCIG ROKU', pad, pad);
    ctx.font = `800 ${Math.round(H * 0.06)}px ${FONT}`;
    ctx.shadowColor = 'rgba(0, 220, 255, 0.8)';
    ctx.shadowBlur = H * 0.02;
    ctx.fillStyle = '#e8fdff';
    ctx.fillText(p >= 1 ? 'DZIŚ' : formatDay(new Date(t)).toUpperCase(), pad, pad + H * 0.035);
    ctx.shadowBlur = 0;

    // Ranking w prawym górnym rogu
    const size = Math.round(H * 0.024);
    ctx.textAlign = 'right';
    const ranked = [...racers].sort((a, b) => a.rank - b.rank);
    ranked.forEach((r, i) => {
      const yy = pad + i * size * 1.6;
      ctx.font = `800 ${size}px ${FONT}`;
      ctx.fillStyle = r.color.css(1);
      ctx.fillText(`${r.rank}. ${r.name}`, W - pad - size * 4.2, yy);
      ctx.font = `500 ${size}px ${FONT}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillText(compactNumber(Math.round(r.target)), W - pad, yy);
    });
  }

  return { setData, start, stop, resize };
}
