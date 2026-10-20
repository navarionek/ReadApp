/* ----------------- Konfetti na canvasie (bez bibliotek) ----------------- */
const COLORS = ['#f5c542', '#ef476f', '#06d6a0', '#118ab2', '#ff8c42', '#9b5de5', '#ffffff', '#ffd166'];
const GRAVITY = 1500;   // px/s²
const MAX_FALL = 620;   // prędkość opadania (opór powietrza), px/s

let canvas = null;
let ctx = null;
let dpr = 1;
let particles = [];
let emitters = [];
let frame = null;
let last = 0;

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (min, max) => min + Math.random() * (max - min);

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1300;';
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);
}

function spawn(x, y, angle, speed) {
  particles.push({
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    size: rand(6, 12),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    shape: Math.random() < 0.25 ? 'circle' : Math.random() < 0.5 ? 'strip' : 'rect',
    rot: rand(0, Math.PI * 2),
    vr: rand(-9, 9),
    tilt: rand(0, Math.PI * 2),
    vt: rand(6, 14),
  });
}

function draw(p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.fillStyle = p.color;
  const flutter = Math.cos(p.tilt);  // „obracanie się” kartki: szerokość oscyluje
  if (p.shape === 'circle') {
    ctx.beginPath();
    ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (p.shape === 'strip') {
    ctx.fillRect(-p.size / 2, -1.5, p.size, 3 * Math.max(0.3, Math.abs(flutter)));
  } else {
    ctx.fillRect(-p.size / 2, (-p.size / 3) * flutter, p.size, (p.size / 1.5) * Math.max(0.25, Math.abs(flutter)));
  }
  ctx.restore();
}

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  emitters = emitters.filter(e => now < e.until);
  for (const e of emitters) {
    e.carry += e.rate * dt;
    while (e.carry >= 1) {
      e.carry -= 1;
      spawn(e.x + rand(-6, 6), e.y, e.angle + rand(-e.spread, e.spread), rand(e.speed * 0.55, e.speed));
    }
  }

  const drag = Math.exp(-1.6 * dt);
  particles = particles.filter(p => {
    p.vx *= drag;
    p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.tilt += p.vt * dt;
    if (p.y > window.innerHeight + 30) return false;
    draw(p);
    return true;
  });

  if (particles.length || emitters.length) {
    frame = requestAnimationFrame(loop);
  } else {
    frame = null;
    canvas.remove();
    canvas = null;
  }
}

function start() {
  ensureCanvas();
  if (frame === null) {
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }
}

// Jednorazowy wybuch we wszystkie strony (albo w stożku wokół angle)
export function confettiBurst(x, y, { count = 90, speed = 700, spread = Math.PI, angle = -Math.PI / 2 } = {}) {
  if (reduced()) return;
  start();
  for (let i = 0; i < count; i++) spawn(x, y, angle + rand(-spread, spread), rand(speed * 0.3, speed));
}

// Wodotrysk: strumień konfetti w górę z jednego punktu, który opada w pobliżu
export function confettiFountain(x, y, { duration = 1800, rate = 160, speed = 1050, spread = 0.38, angle = -Math.PI / 2 } = {}) {
  if (reduced()) return;
  start();
  emitters.push({ x, y, angle, spread, speed, rate, carry: 0, until: performance.now() + duration });
}

// Deszcz z góry ekranu
export function confettiRain(duration = 2200) {
  if (reduced()) return;
  start();
  const until = performance.now() + duration;
  const tick = () => {
    if (performance.now() > until) return;
    for (let i = 0; i < 4; i++) spawn(rand(0, window.innerWidth), -10, Math.PI / 2 + rand(-0.4, 0.4), rand(80, 260));
    requestAnimationFrame(tick);
  };
  tick();
}
