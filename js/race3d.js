import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { state } from './state.js';
import { buildRaceSeries, compactNumber, formatDay, niceMax } from './stats.js';
import { currentYear, DAY_MS, el, icon, refreshIcons } from './ui.js';

/* ----------------- Wyścig 3D (eksperyment, Three.js) ----------------- */
// Te same punkty co na wykresie wyścigu, tylko jako lot książek przez bibliotekę:
// odległość od startu = punkty narastająco, meta = dzisiejszy wynik lidera.
// Three.js dociągamy z CDN dopiero przy pierwszym wejściu, reszta apki go nie potrzebuje.
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
const PLAY_MS = 18000;       // cały rok przy prędkości 1×
const TRACK_LEN = 160;       // od startu do mety, jednostki sceny
const LANE_W = 2.4;
const HOVER = 1.4;           // wysokość lotu książek
const SPEEDS = [1, 2, 4];
const CAM_MODES = ['top', 'chase', 'side'];
const CAM_LABELS = { top: 'Z góry', chase: 'Pościg', side: 'Z boku' };
const BOARD_ROW = 22;        // px, wysokość wiersza tabeli wyników
const PARTICLES = 600;
const SPINE_COLORS = ['#8c2f39', '#2f4b7c', '#3d6b45', '#b08d2a', '#5a3d6e', '#a0522d', '#2e6f73', '#c4b49a', '#6b4226', '#7d8c97', '#9c3d54', '#d0c3a5'];

const THEMES = {
  dark: {
    bg: 0x0b1020, fogNear: 26, fogFar: 120,
    sky: 0x9fb0ff, ground: 0x24170c, hemi: 1.1, sun: 0xffe2b0, sunI: 1.7,
    floor: 0x8a7b70, carpet: 0x7a1d2c, wood: 0x6b4630, books: 0.75,
    lamp: 0xffd98a, glow: 0.9, dust: 0.75, trail: 0.5,
  },
  light: {
    bg: 0xf1e6d2, fogNear: 34, fogFar: 150,
    sky: 0xfff6e8, ground: 0x8a6a4a, hemi: 1.9, sun: 0xffffff, sunI: 2.3,
    floor: 0xffffff, carpet: 0xa82e3e, wood: 0x8a5a3a, books: 1,
    lamp: 0xffe0a0, glow: 0.45, dust: 0.35, trail: 0.6,
  },
};

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (dt, ms) => 1 - Math.exp(-dt / ms);   // wygładzanie niezależne od liczby klatek
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const firstName = name => (name || '?').split(' ')[0];

let THREE = null;
let threeLoad = null;
let r3 = null;     // renderer, kamera, stała część sceny i HUD (tworzone raz)
let world = null;  // tor i zawodnicy dla bieżących danych (przebudowywane, gdy dane się zmienią)

const view = {
  active: false,     // ekran Statystyki jest otwarty
  visible: false,    // karta jest w kadrze
  autoplay: false,   // przy najbliższym pokazaniu odpal wyścig od startu
  playing: false,
  p: 1,              // 0..1, dzień roku
  speed: 1,
  mode: 'top',
  showcase: false,   // po dojechaniu do mety kamera powoli krąży wokół lidera
  full: false,
};

/* ----------------- Wejście i wyjście z ekranu ----------------- */
export function showRace3d(replay = false) {
  view.active = true;
  if (replay) view.autoplay = true;
  if (!state.hasData) return;
  ensureMounted().then(ok => {
    if (!ok || !view.active) return;
    syncData();
    updateLoop();
  });
}

export function hideRace3d() {
  view.active = false;
  view.playing = false;
  if (view.full) toggleFull();
  if (r3) setPlayIcon();
  updateLoop();
}

function updateLoop() {
  if (!r3) return;
  const run = !!world && view.active && view.visible && document.visibilityState === 'visible';
  if (run && view.autoplay) {
    view.autoplay = false;
    if (reduced()) view.p = 1;
    else replay();
  }
  if (run && r3.raf === null) {
    r3.last = performance.now();
    r3.raf = requestAnimationFrame(frame);
  } else if (!run && r3.raf !== null) {
    cancelAnimationFrame(r3.raf);
    r3.raf = null;
  }
}

/* ----------------- Dane ----------------- */
// Wartość bez zaokrąglania (valueAt z wykresu zaokrągla), żeby ruch był płynny
function exactValue(series, t) {
  let v = 0;
  for (const b of series.books) {
    if (t >= b.end) v += b.pts;
    else if (b.end > b.start && t > b.start) v += (b.pts * (t - b.start)) / (b.end - b.start);
  }
  return v;
}

function resolveColor(color) {
  const match = /^var\((--[\w-]+)\)$/.exec(color || '');
  const value = match ? getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() : color;
  return value || '#898781';
}

function syncData() {
  const series = buildRaceSeries(state.statsReaders, state.statsRows);
  const rows = state.statsRows;
  const sig = [
    currentYear(), rows.length, rows.at(-1)?.created_at,
    ...series.map(s => `${s.key}:${s.total}:${s.name}:${s.color}`),
  ].join('|');
  if (world?.sig === sig) return;

  if (!series.length || Math.max(...series.map(s => s.total)) <= 0) {
    clearWorld();
    r3.status.textContent = 'Brak wpisów w tym roku.';
    r3.status.hidden = false;
    return;
  }
  r3.status.hidden = true;
  buildWorld(series, rows, sig);
}

/* ----------------- Silnik, kamera, HUD (raz) ----------------- */
async function ensureMounted() {
  if (r3) return true;
  const host = document.getElementById('race3d');
  if (!host) return false;
  if (!threeLoad) {
    host.replaceChildren(el('div', { class: 'r3d-status', text: 'Ładowanie sceny 3D…' }));
    threeLoad = import(THREE_URL).then(mod => { THREE = mod; });
  }
  try {
    await threeLoad;
  } catch (err) {
    console.error('three.js load failed:', err);
    threeLoad = null;
    host.replaceChildren(el('div', { class: 'r3d-status', text: 'Nie udało się wczytać silnika 3D. Sprawdź internet i wejdź jeszcze raz.' }));
    return false;
  }
  if (r3) return true;  // drugie równoległe wywołanie

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.error('WebGL unavailable:', err);
    host.replaceChildren(el('div', { class: 'r3d-status', text: 'Ta przeglądarka nie obsługuje grafiki 3D (WebGL).' }));
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.classList.add('r3d-canvas');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  scene.fog = new THREE.Fog(0x000000, 30, 120);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 400);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(-8, 18, 12);
  scene.add(hemi, sun);

  r3 = {
    renderer, scene, camera, hemi, sun, canvas, host,
    raf: null, last: 0, size: { w: 1, h: 1 },
    cam: { yaw: 0.3, pitch: 0.34, dist: 14, focus: 0, focusX: 0, spread: 0, tz: null, tx: null, offZ: 0, offX: 0 },
    camGoal: { yaw: 0.3, pitch: 0.34, dist: 14 },
    finalStretch: false,
    shake: 0, pops: [], bannerUntil: 0, bannerPriority: 0, bannerTimer: null,
    tmpV: new THREE.Vector3(), tmpColor: new THREE.Color(), dummy: new THREE.Object3D(),
  };
  buildShared();
  buildHud();
  buildParticles();
  applyTheme();

  new ResizeObserver(resize).observe(host);
  resize();
  new IntersectionObserver(entries => {
    view.visible = entries.some(e => e.isIntersecting);
    updateLoop();
  }, { threshold: 0.2 }).observe(host);
  document.addEventListener('visibilitychange', updateLoop);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  bindPointer();
  return true;
}

function resize() {
  const { host, renderer, camera } = r3;
  const w = Math.max(1, host.clientWidth);
  const h = Math.max(1, host.clientHeight);
  r3.size = { w, h };
  r3.portrait = w / h < 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = r3.portrait ? 62 : 50;  // pionowy telefon: szerszy kadr, żeby tor się mieścił
  camera.updateProjectionMatrix();
}

function keep(thing) {
  thing.userData.keep = true;
  return thing;
}

// Tekstury i materiały wspólne dla wszystkich przebudów świata (motyw zmienia tylko ich kolory)
function buildShared() {
  const repeat = tex => { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; return tex; };
  const floorTex = repeat(canvasTexture(256, 256, parquet));
  floorTex.anisotropy = 4;
  const glowTex = canvasTexture(64, 64, g => radial(g, 64, ['rgba(255,255,255,1)', 'rgba(255,230,170,0.35)', 'rgba(255,220,150,0)']));
  const shadowTex = canvasTexture(64, 64, g => radial(g, 64, ['rgba(0,0,0,0.55)', 'rgba(0,0,0,0.25)', 'rgba(0,0,0,0)']));
  const dustTex = canvasTexture(32, 32, g => radial(g, 32, ['rgba(255,255,255,1)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0)']));
  const checkerTex = repeat(canvasTexture(128, 32, g => {
    for (let x = 0; x < 8; x++) for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  }));

  r3.mats = {
    floor: keep(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.8 })),
    carpet: keep(new THREE.MeshStandardMaterial({ roughness: 0.95 })),
    wood: keep(new THREE.MeshStandardMaterial({ roughness: 0.7 })),
    books: keep(new THREE.MeshStandardMaterial({ roughness: 0.75 })),
    gold: keep(new THREE.MeshStandardMaterial({ color: 0xf0c75e, metalness: 0.75, roughness: 0.28, emissive: 0x6b4a00, emissiveIntensity: 0.35 })),
    goldFlat: keep(new THREE.MeshBasicMaterial({ color: 0xf0c75e, transparent: true, opacity: 0.75 })),
    white: keep(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })),
    lane: keep(new THREE.MeshBasicMaterial({ color: 0xf3e3c0, transparent: true, opacity: 0.35 })),
    metal: keep(new THREE.MeshStandardMaterial({ color: 0x2b2b30, metalness: 0.6, roughness: 0.4 })),
    lamp: keep(new THREE.MeshBasicMaterial({ color: 0xffd98a })),
    glow: keep(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })),
    shadow: keep(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })),
    dust: keep(new THREE.PointsMaterial({ map: dustTex, size: 0.14, color: 0xffe3b0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })),
    pages: keep(new THREE.MeshStandardMaterial({ color: 0xf6eedb, roughness: 0.9 })),
    ribbon: keep(new THREE.MeshStandardMaterial({ color: 0xf0c75e, side: THREE.DoubleSide, roughness: 0.5 })),
    checker: keep(new THREE.MeshBasicMaterial({ map: checkerTex })),
    paper: keep(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
  };

  const trail = new THREE.PlaneGeometry(1, 1);
  trail.rotateX(-Math.PI / 2);
  trail.translate(0, 0, -0.5);  // rośnie od startu (z = 0) do przodu (−z)
  const ribbon = new THREE.PlaneGeometry(0.1, 1.1);
  ribbon.translate(0, -0.55, 0);
  const shadow = new THREE.PlaneGeometry(1.6, 1.9);
  shadow.rotateX(-Math.PI / 2);
  r3.geo = {
    spine: keep(new THREE.CylinderGeometry(0.09, 0.09, 1.42, 12)),
    cover: keep(new THREE.BoxGeometry(0.94, 0.05, 1.42)),
    pages: keep(new THREE.BoxGeometry(0.86, 0.1, 1.3)),
    ribbon: keep(ribbon),
    trail: keep(trail),
    shadow: keep(shadow),
    box: keep(new THREE.BoxGeometry(1, 1, 1)),
    post: keep(new THREE.CylinderGeometry(0.05, 0.07, 1, 8)),
    bulb: keep(new THREE.SphereGeometry(0.2, 14, 10)),
  };
}

function buildHud() {
  const btn = (name, label) => el('button', { type: 'button', class: 'r3d-btn', 'aria-label': label, title: label }, [icon(name)]);
  r3.playBtn = btn('play', 'Odtwórz');
  r3.scrub = el('input', { type: 'range', min: '0', max: '1000', value: '1000', step: '1', class: 'r3d-scrub', 'aria-label': 'Dzień roku' });
  r3.speedBtn = el('button', { type: 'button', class: 'r3d-btn r3d-btn-text', title: 'Prędkość', text: '1×' });
  r3.camLabel = el('span', { text: CAM_LABELS[view.mode] });
  r3.camBtn = el('button', { type: 'button', class: 'r3d-btn r3d-btn-text', title: 'Zmień kamerę' }, [icon('video'), r3.camLabel]);
  r3.fullBtn = btn('maximize', 'Pełny ekran');

  r3.dateDay = el('strong', { text: '' });
  r3.labels = el('div', { class: 'r3d-labels', 'aria-hidden': 'true' });
  r3.board = el('ol', { class: 'r3d-board', 'aria-label': 'Kolejność' });
  r3.bannerKicker = el('span', { class: 'r3d-banner-kicker' });
  r3.bannerMain = el('strong', { class: 'r3d-banner-main' });
  r3.banner = el('div', { class: 'r3d-banner', hidden: '', role: 'status' }, [r3.bannerKicker, r3.bannerMain]);
  r3.feed = el('div', { class: 'r3d-feed', 'aria-hidden': 'true' });
  r3.status = el('div', { class: 'r3d-status', hidden: '' });

  r3.host.replaceChildren(
    r3.canvas,
    r3.labels,
    el('div', { class: 'r3d-date' }, [r3.dateDay, el('span', { text: String(currentYear()) })]),
    r3.board,
    r3.banner,
    r3.feed,
    el('div', { class: 'r3d-controls' }, [r3.playBtn, r3.scrub, r3.speedBtn, r3.camBtn, r3.fullBtn]),
    r3.status,
  );
  refreshIcons();

  r3.playBtn.addEventListener('click', () => {
    if (!world) return;
    if (view.p >= 1) replay();
    else {
      view.playing = !view.playing;
      view.showcase = false;
    }
    setPlayIcon();
  });
  r3.scrub.addEventListener('input', () => {
    view.p = Number(r3.scrub.value) / 1000;
    view.playing = false;
    view.showcase = false;
    setPlayIcon();
  });
  r3.speedBtn.addEventListener('click', () => {
    view.speed = SPEEDS[(SPEEDS.indexOf(view.speed) + 1) % SPEEDS.length];
    r3.speedBtn.textContent = `${view.speed}×`;
  });
  r3.camBtn.addEventListener('click', () => setCamMode(CAM_MODES[(CAM_MODES.indexOf(view.mode) + 1) % CAM_MODES.length]));
  r3.fullBtn.addEventListener('click', toggleFull);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && view.full) toggleFull();
  });
}

function setPlayIcon() {
  const playing = view.playing;
  const name = playing ? 'pause' : view.p >= 1 ? 'rotate-ccw' : 'play';
  if (r3.playIcon === name) return;
  r3.playIcon = name;
  r3.playBtn.replaceChildren(icon(name));
  r3.playBtn.setAttribute('aria-label', playing ? 'Pauza' : view.p >= 1 ? 'Od nowa' : 'Odtwórz');
  refreshIcons();
}

function toggleFull() {
  view.full = !view.full;
  r3.host.classList.toggle('r3d-full', view.full);
  document.body.classList.toggle('r3d-lock', view.full);
  r3.fullBtn.replaceChildren(icon(view.full ? 'minimize' : 'maximize'));
  r3.fullBtn.setAttribute('aria-label', view.full ? 'Zamknij pełny ekran' : 'Pełny ekran');
  refreshIcons();
  resize();
}

// Przeciąganie obraca kamerę, dwa palce / kółko (na pełnym ekranie) przybliżają
function bindPointer() {
  const pointers = new Map();
  const { canvas } = r3;
  const pinchDist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener('pointerdown', e => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    view.showcase = false;
  });
  canvas.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const g = r3.camGoal;
    if (pointers.size === 1) {
      g.yaw -= (e.clientX - prev.x) * 0.006;
      g.pitch = clamp(g.pitch + (e.clientY - prev.y) * 0.005, 0.05, 1.4);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    } else if (pointers.size === 2) {
      const before = pinchDist();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = pinchDist();
      if (after > 0) g.dist = clamp(g.dist * (before / after), 4, 90);
    }
  });
  const release = e => pointers.delete(e.pointerId);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', e => {
    if (!view.full) return;  // w karcie kółko przewija stronę
    e.preventDefault();
    r3.camGoal.dist = clamp(r3.camGoal.dist * Math.exp(e.deltaY * 0.001), 4, 90);
  }, { passive: false });
  canvas.addEventListener('dblclick', toggleFull);
}

function applyTheme() {
  if (!r3) return;
  const t = THEMES[document.documentElement.classList.contains('dark-mode') ? 'dark' : 'light'];
  const { scene, mats, hemi, sun } = r3;
  scene.background.set(t.bg);
  scene.fog.color.set(t.bg);
  scene.fog.near = t.fogNear;
  scene.fog.far = t.fogFar;
  hemi.color.set(t.sky);
  hemi.groundColor.set(t.ground);
  hemi.intensity = t.hemi;
  sun.color.set(t.sun);
  sun.intensity = t.sunI;
  mats.floor.color.set(t.floor);
  mats.carpet.color.set(t.carpet);
  mats.wood.color.set(t.wood);
  mats.books.color.setScalar(t.books);
  mats.lamp.color.set(t.lamp);
  mats.glow.opacity = t.glow;
  mats.dust.opacity = t.dust;
  r3.trailOpacity = t.trail;
  // Kolory serii z CSS różnią się między motywami
  world?.racers.forEach(r => {
    r.css = resolveColor(r.s.color);
    r.coverMat.color.set(r.css);
    r.coverMat.emissive.set(r.css);
    r.trailMat.color.set(r.css);
    r.trailMat.opacity = t.trail;
    r.tag.style.setProperty('--c', r.css);
    r.boardRow.style.setProperty('--c', r.css);
  });
}

/* ----------------- Tekstury z canvasa ----------------- */
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function radial(g, size, stops) {
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach((color, i) => grad.addColorStop(i / (stops.length - 1), color));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
}

// Parkiet: rzędy desek różnej długości, rysowane z zawinięciem, żeby kafel się powtarzał bez szwu
function parquet(g, w, h) {
  const rowH = 32;
  for (let y = 0; y < h; y += rowH) {
    let x = -rand(0, 120);
    while (x < w) {
      const len = rand(70, 150);
      g.fillStyle = `hsl(${rand(24, 34)}, ${rand(32, 44)}%, ${rand(36, 47)}%)`;
      for (const shift of [-w, 0, w]) g.fillRect(x + shift, y, len, rowH);
      g.fillStyle = 'rgba(0,0,0,0.28)';
      for (const shift of [-w, 0, w]) g.fillRect(x + shift, y, 2, rowH);
      x += len;
    }
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(0, y, w, 2);
  }
}

function textTexture(text, { w = 512, h = 128, font = 800, size = 72, fg = '#f3d27a', bg = '#24160d', border = '#f3d27a' } = {}) {
  return canvasTexture(w, h, g => {
    if (bg) {
      g.fillStyle = bg;
      g.beginPath();
      if (g.roundRect) g.roundRect(4, 4, w - 8, h - 8, 18);
      else g.rect(4, 4, w - 8, h - 8);
      g.fill();
      if (border) {
        g.lineWidth = 6;
        g.strokeStyle = border;
        g.stroke();
      }
    }
    g.font = `${font} ${size}px Inter, system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + size * 0.04, w - 32);
  });
}

/* ----------------- Świat (tor, regały, zawodnicy) ----------------- */
function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry && !o.geometry.userData.keep) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) {
      if (m.userData.keep) continue;
      m.map?.dispose();
      m.dispose();
    }
    if (o.isInstancedMesh) o.dispose();
  });
}

function clearWorld() {
  if (!world) return;
  r3.scene.remove(world.group);
  disposeTree(world.group);
  world.racers.forEach(r => r.tag.remove());
  r3.pops.forEach(p => p.node.remove());
  r3.pops = [];
  r3.board.replaceChildren();
  r3.feed.replaceChildren();
  world = null;
}

function flat(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

function boxAt(mat, sx, sy, sz, x, y, z) {
  const m = new THREE.Mesh(r3.geo.box, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  return m;
}

function sign(text, w, h, opts) {
  const ratio = h / w;
  const mat = new THREE.MeshBasicMaterial({ map: textTexture(text, { w: 512, h: Math.round(512 * ratio), size: Math.round(512 * ratio * 0.56), ...opts }), transparent: true });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}

// Brama z napisem, z przodu i z tyłu (kamera bywa po obu stronach)
function arch(halfW, z, text, checkered) {
  const g = new THREE.Group();
  const span = halfW + 0.5;
  for (const side of [-1, 1]) g.add(boxAt(r3.mats.wood, 0.4, 5.4, 0.4, side * span, 2.7, z));
  g.add(boxAt(checkered ? r3.mats.checker : r3.mats.wood, span * 2 + 0.4, 1.05, 0.3, 0, 5.5, z));
  for (const side of [-1, 1]) g.add(boxAt(r3.mats.gold, 0.55, 0.25, 0.55, side * span, 5.5 + 0.65, z));
  const w = Math.min(6, span * 1.4);
  for (const back of [false, true]) {
    const s = sign(text, w, 0.9);
    s.position.set(0, 5.5, z + (back ? -0.17 : 0.17));
    if (back) s.rotation.y = Math.PI;
    g.add(s);
  }
  return g;
}

// Regały wzdłuż toru: deski i książki jako dwa InstancedMesh (dwa wywołania rysowania na tysiące brył)
function buildShelves(group, halfW, zNear, zFar) {
  const unit = 4;
  const levels = 5;
  const levelH = 1.3;
  const depth = 0.9;
  const inner = halfW + 3.4;
  const boards = [];
  const books = [];
  for (const side of [-1, 1]) {
    const xMid = side * (inner + depth / 2);
    for (let z = zNear; z > zFar; z -= unit) {
      const zMid = z - unit / 2;
      for (let l = 0; l <= levels; l++) boards.push([depth, 0.08, unit, xMid, l * levelH + 0.04, zMid]);
      boards.push([depth, levels * levelH, 0.1, xMid, (levels * levelH) / 2, z]);
      boards.push([0.06, levels * levelH, unit, side * (inner + depth), (levels * levelH) / 2, zMid]);
      boards.push([depth + 0.2, 0.25, unit, xMid, levels * levelH + 0.12, zMid]);
      for (let l = 0; l < levels; l++) {
        let zz = z - 0.08;
        while (zz > z - unit + 0.35) {
          const thick = rand(0.12, 0.3);
          if (Math.random() < 0.04) { zz -= rand(0.3, 0.7); continue; }  // luka na półce
          const hgt = rand(0.62, 1.0) * levelH * 0.88;
          books.push({
            s: [depth * rand(0.72, 0.9), hgt, thick * 0.93, xMid + side * rand(0, 0.06), l * levelH + 0.08 + hgt / 2, zz - thick / 2],
            c: SPINE_COLORS[Math.floor(Math.random() * SPINE_COLORS.length)],
          });
          zz -= thick;
        }
      }
    }
  }
  const d = r3.dummy;
  const place = (mesh, i, [sx, sy, sz, x, y, z]) => {
    d.position.set(x, y, z);
    d.rotation.set(0, 0, 0);
    d.scale.set(sx, sy, sz);
    d.updateMatrix();
    mesh.setMatrixAt(i, d.matrix);
  };
  const boardMesh = new THREE.InstancedMesh(r3.geo.box, r3.mats.wood, boards.length);
  boards.forEach((b, i) => place(boardMesh, i, b));
  const bookMesh = new THREE.InstancedMesh(r3.geo.box, r3.mats.books, books.length);
  const color = r3.tmpColor;
  books.forEach((b, i) => {
    place(bookMesh, i, b.s);
    bookMesh.setColorAt(i, color.set(b.c).multiplyScalar(rand(0.8, 1.1)));
  });
  for (const m of [boardMesh, bookMesh]) {
    m.frustumCulled = false;
    group.add(m);
  }
}

function buildLamps(group, halfW, zNear, zFar) {
  for (let z = zNear - 6; z > zFar; z -= 16) {
    for (const side of [-1, 1]) {
      const x = side * (halfW + 2.1);
      const post = new THREE.Mesh(r3.geo.post, r3.mats.metal);
      post.scale.y = 3.6;
      post.position.set(x, 1.8, z);
      const bulb = new THREE.Mesh(r3.geo.bulb, r3.mats.lamp);
      bulb.position.set(x, 3.75, z);
      const glow = new THREE.Sprite(r3.mats.glow);
      glow.scale.setScalar(2.6);
      glow.position.copy(bulb.position);
      group.add(post, bulb, glow);
    }
  }
}

function buildDust(group, halfW, zNear, zFar) {
  const count = 520;
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rand(-halfW - 3, halfW + 3);
    pos[i * 3 + 1] = rand(0.3, 6.5);
    pos[i * 3 + 2] = rand(zFar, zNear);
    vel[i * 3] = rand(-0.15, 0.15);
    vel[i * 3 + 1] = rand(-0.08, 0.12);
    vel[i * 3 + 2] = rand(-0.15, 0.15);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, r3.mats.dust);
  points.frustumCulled = false;
  group.add(points);
  return { geo, pos, vel, count, halfW };
}

function crownMesh() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.27, 0.2, 18, 1, true), r3.mats.gold));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 6), r3.mats.gold);
    spike.position.set(Math.cos(a) * 0.29, 0.2, Math.sin(a) * 0.29);
    const gem = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), r3.mats.lamp);
    gem.position.set(Math.cos(a) * 0.29, 0.33, Math.sin(a) * 0.29);
    g.add(spike, gem);
  }
  return g;
}

function makeRacer(s, i, n, group) {
  const css = resolveColor(s.color);
  const { geo, mats } = r3;
  const coverMat = new THREE.MeshStandardMaterial({ color: css, emissive: css, emissiveIntensity: 0.22, roughness: 0.42, metalness: 0.05 });
  const x = (i - (n - 1) / 2) * LANE_W;

  const root = new THREE.Group();
  root.position.x = x;
  const body = new THREE.Group();
  body.position.y = HOVER;
  body.scale.setScalar(1.35);
  root.add(body);

  // Książka grzbietem do przodu, okładki jak skrzydła (strona −1 i +1), kartki do środka
  const spine = new THREE.Mesh(geo.spine, coverMat);
  spine.rotation.x = Math.PI / 2;
  body.add(spine);
  const wings = [-1, 1].map(side => {
    const pivot = new THREE.Group();
    const cover = new THREE.Mesh(geo.cover, coverMat);
    cover.position.x = side * 0.48;
    const pages = new THREE.Mesh(geo.pages, mats.pages);
    pages.position.set(side * 0.46, 0.075, 0);
    pivot.add(cover, pages);
    body.add(pivot);
    return pivot;
  });
  const ribbon = new THREE.Mesh(geo.ribbon, mats.ribbon);
  ribbon.position.set(0, 0.04, 0.7);
  body.add(ribbon);

  const shadow = new THREE.Mesh(geo.shadow, mats.shadow);
  shadow.position.y = 0.035;
  root.add(shadow);
  group.add(root);

  const trailMat = new THREE.MeshBasicMaterial({ color: css, transparent: true, opacity: r3.trailOpacity, depthWrite: false });
  const trail = new THREE.Mesh(geo.trail, trailMat);
  trail.position.set(x, 0.022, 0);
  trail.scale.set(LANE_W * 0.42, 1, 0.001);
  group.add(trail);

  // Imię namalowane na dywanie przed linią startu
  const first = firstName(s.name);
  const nameTag = flat(new THREE.PlaneGeometry(LANE_W * 0.9, LANE_W * 0.9 * 0.25),
    new THREE.MeshBasicMaterial({ map: textTexture(first.toUpperCase(), { w: 512, h: 128, size: 64, fg: '#ffffff', bg: null }), transparent: true, opacity: 0.85, depthWrite: false }),
    x, 0.03, 2.2);
  group.add(nameTag);

  const tagRank = el('b');
  const tagPts = el('em');
  const tag = el('div', { class: 'r3d-tag' }, [tagRank, el('span', { text: first }), tagPts]);
  tag.style.setProperty('--c', css);
  r3.labels.appendChild(tag);

  const boardPts = el('b');
  const boardRow = el('li', { class: 'r3d-board-row' }, [el('i', { class: 'r3d-dot' }), el('span', { class: 'r3d-board-name', text: first }), boardPts]);
  boardRow.style.setProperty('--c', css);
  boardRow.style.transform = `translateY(${i * BOARD_ROW}px)`;  // od razu na miejscu, bez wjazdu z góry
  r3.board.appendChild(boardRow);

  return {
    s, first, css, root, body, wings, ribbon, shadow, trail, trailMat, coverMat,
    tag, tagRank, tagPts, boardRow, boardPts,
    z: 0, v: 0, speed: 0, phase: rand(0, 6), seed: rand(0, 100),
    rank: i, newRank: i, shownV: -1, shownRank: -1,
  };
}

function buildWorld(series, rows, sig) {
  clearWorld();
  const ordered = [...series].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const n = ordered.length;
  const halfW = (n * LANE_W) / 2 + 0.5;
  const finalMax = Math.max(...ordered.map(s => s.total));
  const t0 = new Date(currentYear(), 0, 1).getTime();
  const t1 = Math.max(Date.now(), t0 + DAY_MS);
  const { mats, geo } = r3;
  const group = new THREE.Group();
  const zNear = 24;
  const zFar = -(TRACK_LEN + 70);
  const len = zNear - zFar;
  const zMid = (zNear + zFar) / 2;

  // Podłoga, dywan, złote krawędzie i linie torów
  const floorW = halfW * 2 + 26;
  mats.floor.map.repeat.set(floorW / 4, len / 4);
  group.add(flat(new THREE.PlaneGeometry(floorW, len), mats.floor, 0, 0, zMid));
  group.add(flat(new THREE.PlaneGeometry(halfW * 2, len - 8), mats.carpet, 0, 0.01, zMid - 4));
  for (const side of [-1, 1]) group.add(boxAt(mats.gold, 0.16, 0.05, len - 8, side * halfW, 0.03, zMid - 4));
  for (let i = 1; i < n; i++) group.add(flat(new THREE.PlaneGeometry(0.05, len - 8), mats.lane, (i - n / 2) * LANE_W, 0.018, zMid - 4));

  // Start, znaczniki punktów co „ładny” krok i meta (= dzisiejszy wynik lidera)
  group.add(flat(new THREE.PlaneGeometry(halfW * 2, 0.22), mats.white, 0, 0.026, 0));
  group.add(arch(halfW, -3, 'START', false));  // przed linią: kamera z góry nie patrzy na książki przez belkę
  const step = niceMax(finalMax / 5);
  for (let v = step; v < finalMax * 0.96; v += step) {
    const z = -(v / finalMax) * TRACK_LEN;
    group.add(flat(new THREE.PlaneGeometry(halfW * 2, 0.12), mats.goldFlat, 0, 0.028, z));
    for (const side of [-1, 1]) {
      const x = side * (halfW + 0.95);
      const post = new THREE.Mesh(geo.post, mats.metal);
      post.scale.y = 1.1;
      post.position.set(x, 0.55, z);
      const s = sign(`${compactNumber(v)} pkt`, 1.7, 0.6);
      s.position.set(x, 1.35, z);
      group.add(post, s);
    }
  }
  const finishZ = -TRACK_LEN;
  const finishFloor = flat(new THREE.PlaneGeometry(halfW * 2, 1.2), mats.checker, 0, 0.028, finishZ);
  group.add(finishFloor);
  group.add(arch(halfW, finishZ, 'META · DZIŚ', true));

  buildShelves(group, halfW, zNear, zFar);
  buildLamps(group, halfW, zNear, zFar);
  const dust = buildDust(group, halfW, zNear, zFar);

  r3.board.style.height = `${n * BOARD_ROW}px`;
  const racers = ordered.map((s, i) => makeRacer(s, i, n, group));
  const byKey = new Map(racers.map(r => [r.s.key, r]));
  const crown = crownMesh();
  group.add(crown);

  const events = rows
    .filter(row => byKey.has(row.user_id))
    .map(row => ({ t: new Date(row.created_at).getTime(), key: row.user_id, title: row.title || 'bez tytułu', pts: bookPoints(row) }))
    .sort((a, b) => a.t - b.t);

  r3.scene.add(group);
  world = {
    sig, group, racers, byKey, events, evIdx: 0, dust, crown,
    t0, t1, t: t1, finalMax, halfW, leader: racers[0],
    baseDist: 9 + halfW * 1.5,
  };

  // Ustaw zawodników od razu tam, gdzie wskazuje bieżący dzień (bez dojeżdżania)
  world.t = t0 + view.p * (t1 - t0);
  racers.forEach(r => {
    r.v = exactValue(r.s, world.t);
    r.z = -(r.v / finalMax) * TRACK_LEN;
  });
  updateRanking(false);
  world.evIdx = events.filter(e => e.t <= world.t).length;
  crown.position.set(world.leader.root.position.x, HOVER + 0.9, world.leader.z);
  setCamMode(view.mode, true);
  Object.assign(r3.cam, { tz: null, tx: null, offZ: 0, offX: 0 });
  applyTheme();
  setPlayIcon();
  r3.scrub.value = String(Math.round(view.p * 1000));
}

/* ----------------- Odtwarzanie ----------------- */
function replay() {
  if (!world) return;
  view.p = 0;
  view.playing = true;
  view.showcase = false;
  world.t = world.t0;
  world.evIdx = 0;
  world.racers.forEach((r, i) => {
    r.z = 0;
    r.v = 0;
    r.speed = 0;
    r.rank = i;
  });
  r3.feed.replaceChildren();
  r3.banner.hidden = true;
  r3.bannerUntil = 0;
  r3.particles.life.fill(0);
  r3.particles.activeUntil = performance.now() + 100;
  r3.finalStretch = false;
  setCamMode(view.mode, true);
  Object.assign(r3.cam, { tz: null, tx: null, offZ: 0, offX: 0, spread: 0 });
  setPlayIcon();
}

function frame(now) {
  if (!world) {  // dane zniknęły między klatkami
    r3.raf = null;
    return;
  }
  r3.raf = requestAnimationFrame(frame);
  const dt = Math.min(50, now - r3.last);
  r3.last = now;
  if (view.playing) {
    // Ostatnia prosta w zwolnionym tempie, żeby dojazd na metę nie urywał się nagle
    const slow = 1 - 0.7 * smoothstep(0.88, 1, view.p);
    view.p = Math.min(1, view.p + (dt * view.speed * slow) / PLAY_MS);
    r3.scrub.value = String(Math.round(view.p * 1000));
    if (!r3.finalStretch && view.p > 0.9) {
      r3.finalStretch = true;
      showBanner('Ostatnia prosta', 'Finisz!', 1, 1800, world.leader.css);
    }
    if (view.p >= 1) {
      view.playing = false;
      setPlayIcon();
      finale();
    }
  }
  updateRacers(dt, now);
  updateParticles(dt);
  updateDust(dt);
  updateCamera(dt);
  r3.renderer.render(r3.scene, r3.camera);
  updateOverlay(now);
}

function updateRacers(dt, now) {
  const { racers, t0, t1, finalMax } = world;
  world.t = t0 + view.p * (t1 - t0);
  for (const r of racers) {
    r.v = exactValue(r.s, world.t);
    const target = -(r.v / finalMax) * TRACK_LEN;
    const prevZ = r.z;
    r.z += (target - r.z) * ease(dt, 140);  // schodek (książka bez daty startu) = krótki zryw
    const speed = Math.abs(r.z - prevZ) / Math.max(1, dt);
    r.speed += (speed - r.speed) * ease(dt, 180);

    r.root.position.z = r.z;
    // Machanie okładkami: szybciej, gdy książka przyspiesza
    r.phase += dt * (0.007 + Math.min(r.speed, 0.03) * 0.9);
    const open = 0.5 + 0.4 * Math.sin(r.phase);
    r.wings[0].rotation.z = -open;
    r.wings[1].rotation.z = open;
    r.body.position.y = HOVER + Math.sin(now * 0.0021 + r.seed) * 0.12 + Math.sin(r.phase) * 0.05;
    r.body.rotation.x = -clamp(r.speed * 22, 0, 0.4);
    r.body.rotation.z = Math.sin(now * 0.0013 + r.seed) * 0.07;
    r.ribbon.rotation.x = -(1.2 + Math.sin(r.phase * 0.7) * 0.15 + clamp(r.speed * 18, 0, 0.3));
    r.trail.scale.z = Math.max(0.001, -r.z);
    const lift = r.body.position.y - HOVER;
    r.shadow.scale.setScalar(1 - lift * 0.6);
  }
  updateRanking(view.playing);
  updateEvents();

  // Korona leci za liderem
  const leader = world.leader;
  const crown = world.crown;
  crown.visible = leader.v > 0.5;
  const k = ease(dt, 160);
  crown.position.x += (leader.root.position.x - crown.position.x) * k;
  crown.position.y += (leader.body.position.y + 1.05 - crown.position.y) * k;
  crown.position.z += (leader.z - crown.position.z) * k;
  crown.rotation.y += dt * 0.0024;
}

function updateRanking(announce) {
  const sorted = [...world.racers].sort((a, b) => b.v - a.v || a.rank - b.rank);
  sorted.forEach((r, i) => { r.newRank = i; });
  if (announce) {
    for (const r of sorted) {
      if (r.newRank >= r.rank) continue;
      const passed = world.racers.filter(o => o.rank < r.rank && o.newRank > r.newRank && o.v > 0.5);
      if (!passed.length) continue;
      if (r.newRank === 0) showBanner('Nowy lider', r.first, 2, 2000, r.css);
      else showBanner('Wyprzedzanie', `${r.first}  ›  ${passed.map(o => o.first).join(', ')}`, 1, 1600, r.css);
      r3.shake = Math.max(r3.shake, r.newRank === 0 ? 0.35 : 0.18);
    }
  }
  world.racers.forEach(r => { r.rank = r.newRank; });
  world.leader = sorted[0];
}

function updateEvents() {
  const evs = world.events;
  if (!view.playing) {
    // Przewijanie suwakiem: bez fajerwerków, tylko wskaźnik na właściwe miejsce
    world.evIdx = evs.filter(e => e.t <= world.t).length;
    return;
  }
  while (world.evIdx < evs.length && evs[world.evIdx].t <= world.t) {
    const ev = evs[world.evIdx++];
    const r = world.byKey.get(ev.key);
    if (!r) continue;
    r3.tmpV.set(r.root.position.x, r.body.position.y, r.z);
    emit(r3.tmpV, 26, ['#f6eedb', '#ffffff', r.css], { speed: 2.6, up: 4.5 });
    pop(r, `+${ev.pts}`);
    addFeed(r, ev);
  }
}

function finale() {
  const leader = [...world.racers].sort((a, b) => b.s.total - a.s.total)[0];
  showBanner('Na dziś prowadzi', `${leader.first} · ${leader.s.total} pkt`, 3, 4200, leader.css);
  const colors = [...world.racers.map(r => r.css), '#f0c75e', '#ffffff'];
  for (let i = 0; i < 4; i++) {
    r3.tmpV.set(rand(-world.halfW, world.halfW), 6.2, -TRACK_LEN + rand(-0.5, 0.5));
    emit(r3.tmpV, 55, colors, { speed: 4, up: 3, spread: 2 });
  }
  r3.shake = 0.3;
  if (reduced()) return;
  // Kamera nie przeskakuje: zostaje nad czołówką, tylko lekko podjeżdża i powoli krąży
  view.showcase = true;
  r3.camGoal.dist *= 0.85;
}

/* ----------------- Kamera ----------------- */
// Ujęcia: kąt wokół celu (0 = zza pleców), wysokość i odległość (× bazowa)
const SHOTS = {
  top: { yaw: 0, pitch: 1.05, dist: 1.15 },
  chase: { yaw: 0.3, pitch: 0.34, dist: 0.85 },
  side: { yaw: 1.05, pitch: 0.22, dist: 0.95 },
};
const PACK_GAP = 20;  // kto jest dalej za liderem, wypada z kadru czołówki

function setCamMode(mode, snap = false) {
  view.mode = mode;
  view.showcase = false;
  const s = SHOTS[mode];
  const { cam, camGoal: g } = r3;
  // Najkrótsza droga do nowego kąta zamiast kręcenia się o pełne obroty
  g.yaw = s.yaw + Math.round((cam.yaw - s.yaw) / (2 * Math.PI)) * 2 * Math.PI;
  g.pitch = s.pitch;
  g.dist = s.dist * (world ? world.baseDist : 14);
  if (snap) Object.assign(cam, { yaw: g.yaw, pitch: g.pitch, dist: g.dist });
  r3.camLabel.textContent = CAM_LABELS[mode];
}

// Cel kamery: czołówka (wszyscy w zasięgu PACK_GAP od lidera).
// key zmienia się, gdy ktoś wypada z czołówki albo do niej dołącza (wtedy płynny przejazd).
function packTarget() {
  let lead = 0;
  for (const r of world.racers) lead = Math.min(lead, r.z);
  const pack = world.racers.filter(r => r.z - lead <= PACK_GAP);
  let back = lead;
  let x = 0;
  for (const r of pack) {
    back = Math.max(back, r.z);
    x += r.root.position.x;
  }
  return { key: `pack:${pack.map(r => r.s.key).join()}`, x: (x / pack.length) * 0.4, z: (lead + back) / 2, spread: back - lead };
}

function updateCamera(dt) {
  const { cam, camGoal: g, camera } = r3;
  if (view.showcase) g.yaw += dt * 0.00008;
  // Finał przejeżdża wolno (bez szarpnięcia na mecie), ręczna zmiana kamery szybciej
  const k = ease(dt, view.showcase ? 1500 : 380);
  cam.yaw += (g.yaw - cam.yaw) * k;
  cam.pitch += (g.pitch - cam.pitch) * k;
  cam.dist += (g.dist - cam.dist) * k;

  // Cel idzie za zawodnikami bez opóźnienia (także przy zrywach); tylko zmiana składu
  // czołówki zamienia przeskok celu na offset, który płynnie wygasa
  const target = packTarget();
  if (cam.tz !== null && cam.key !== target.key) {
    cam.offZ += cam.tz - target.z;
    cam.offX += cam.tx - target.x;
  }
  cam.key = target.key;
  cam.tz = target.z;
  cam.tx = target.x;
  cam.offZ *= Math.exp(-dt / 700);
  cam.offX *= Math.exp(-dt / 700);
  cam.focus = target.z + cam.offZ;
  cam.focusX = target.x + cam.offX;
  cam.spread += (target.spread - cam.spread) * ease(dt, 700);
  const dist = cam.dist + Math.min(r3.portrait ? 14 : 20, cam.spread * 0.5);

  r3.shake *= Math.exp(-dt / 260);
  const jitter = () => (Math.random() - 0.5) * r3.shake;
  // W pionie górę kadru zajmuje HUD, więc celujemy wyżej i stawka ląduje niżej na ekranie.
  const look = r3.tmpV.set(cam.focusX, r3.portrait ? 2.4 : 1.3, cam.focus - 1);
  camera.position.set(
    look.x + Math.sin(cam.yaw) * Math.cos(cam.pitch) * dist + jitter(),
    look.y + Math.sin(cam.pitch) * dist + jitter(),
    look.z + Math.cos(cam.yaw) * Math.cos(cam.pitch) * dist + jitter(),
  );
  // Kamera zostaje nad korytarzem między regałami, zamiast filmować tył półek
  const wall = world.halfW + 2.7;
  camera.position.x = clamp(camera.position.x, -wall, wall);
  // Nie przelatujemy przez książki: blisko którejś kamera płynnie unosi się nad nią
  let lift = 0;
  for (const r of world.racers) {
    const d = Math.hypot(camera.position.x - r.root.position.x, camera.position.z - r.z);
    const need = (r.body.position.y + 2) * smoothstep(3.6, 1.8, d);
    lift = Math.max(lift, need - camera.position.y);
  }
  cam.lift = (cam.lift || 0) + (lift - (cam.lift || 0)) * ease(dt, 160);
  camera.position.y = Math.max(0.4, camera.position.y + cam.lift);
  camera.lookAt(look);
}

/* ----------------- Kartki i konfetti ----------------- */
function buildParticles() {
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.17, 0.23), r3.mats.paper, PARTICLES);
  mesh.frustumCulled = false;
  const d = r3.dummy;
  d.position.set(0, -10, 0);
  d.scale.setScalar(0);
  d.updateMatrix();
  for (let i = 0; i < PARTICLES; i++) {
    mesh.setMatrixAt(i, d.matrix);
    mesh.setColorAt(i, r3.tmpColor.set('#ffffff'));
  }
  r3.scene.add(mesh);
  r3.particles = {
    mesh, next: 0, activeUntil: 0,
    life: new Float32Array(PARTICLES).fill(-1),
    pos: new Float32Array(PARTICLES * 3),
    vel: new Float32Array(PARTICLES * 3),
    rot: new Float32Array(PARTICLES * 3),
    spin: new Float32Array(PARTICLES * 3),
  };
}

function emit(at, count, colors, { speed = 3, up = 4, spread = 1 } = {}) {
  if (reduced()) return;
  const P = r3.particles;
  for (let n = 0; n < count; n++) {
    const i = P.next;
    P.next = (P.next + 1) % PARTICLES;
    P.life[i] = rand(1.4, 2.6);
    P.pos.set([at.x + rand(-0.4, 0.4) * spread, at.y + rand(-0.2, 0.2), at.z + rand(-0.4, 0.4) * spread], i * 3);
    P.vel.set([rand(-speed, speed), rand(up * 0.45, up), rand(-speed, speed)], i * 3);
    P.rot.set([rand(0, 6), rand(0, 6), rand(0, 6)], i * 3);
    P.spin.set([rand(-9, 9), rand(-9, 9), rand(-9, 9)], i * 3);
    P.mesh.setColorAt(i, r3.tmpColor.set(colors[Math.floor(Math.random() * colors.length)]));
  }
  P.mesh.instanceColor.needsUpdate = true;
  P.activeUntil = performance.now() + 3000;
}

function updateParticles(dt) {
  const P = r3.particles;
  if (performance.now() > P.activeUntil) return;
  const s = dt / 1000;
  const drag = Math.exp(-1.4 * s);
  const d = r3.dummy;
  for (let i = 0; i < PARTICLES; i++) {
    if (P.life[i] < 0) continue;
    const j = i * 3;
    P.life[i] -= s;
    if (P.life[i] <= 0) {
      P.life[i] = -1;
      d.scale.setScalar(0);
    } else {
      P.vel[j + 1] -= 7 * s;
      for (let a = 0; a < 3; a++) {
        P.vel[j + a] *= drag;
        P.pos[j + a] += P.vel[j + a] * s;
        P.rot[j + a] += P.spin[j + a] * s;
      }
      if (P.pos[j + 1] < 0.06) {  // kartka ląduje na dywanie i leży
        P.pos[j + 1] = 0.06;
        P.vel.fill(0, j, j + 3);
        P.spin.fill(0, j, j + 3);
      }
      d.position.set(P.pos[j], P.pos[j + 1], P.pos[j + 2]);
      d.rotation.set(P.rot[j], P.rot[j + 1], P.rot[j + 2]);
      d.scale.setScalar(Math.min(1, P.life[i] * 2));
    }
    d.updateMatrix();
    P.mesh.setMatrixAt(i, d.matrix);
  }
  P.mesh.instanceMatrix.needsUpdate = true;
}

function updateDust(dt) {
  const D = world.dust;
  const s = dt / 1000;
  const { pos, vel } = D;
  for (let i = 0; i < D.count * 3; i += 3) {
    pos[i] += vel[i] * s;
    pos[i + 1] += vel[i + 1] * s;
    pos[i + 2] += vel[i + 2] * s;
    if (pos[i + 1] > 6.8) pos[i + 1] = 0.3;
    else if (pos[i + 1] < 0.3) pos[i + 1] = 6.8;
    if (Math.abs(pos[i]) > D.halfW + 3) vel[i] = -vel[i];
  }
  D.geo.attributes.position.needsUpdate = true;
}

/* ----------------- HUD ----------------- */
function showBanner(kicker, main, priority, ms, color) {
  const now = performance.now();
  if (r3.bannerUntil > now && priority < r3.bannerPriority) return;
  r3.bannerPriority = priority;
  r3.bannerUntil = now + ms;
  r3.bannerKicker.textContent = kicker;
  r3.bannerMain.textContent = main;
  r3.banner.style.setProperty('--c', color);
  r3.banner.hidden = false;
  r3.banner.classList.remove('r3d-in');
  void r3.banner.offsetWidth;  // restart animacji wejścia
  r3.banner.classList.add('r3d-in');
  clearTimeout(r3.bannerTimer);
  r3.bannerTimer = setTimeout(() => { r3.banner.hidden = true; }, ms);
}

function pop(racer, text) {
  const node = el('div', { class: 'r3d-pop', text });
  node.style.setProperty('--c', racer.css);
  r3.labels.appendChild(node);
  r3.pops.push({ node, racer, born: performance.now() });
}

function addFeed(racer, ev) {
  const item = el('div', { class: 'r3d-feed-item' }, [
    el('i', { class: 'r3d-dot' }),
    el('b', { text: racer.first }),
    el('span', { text: ev.title }),
    el('em', { text: `+${ev.pts}` }),
  ]);
  item.style.setProperty('--c', racer.css);
  r3.feed.prepend(item);
  while (r3.feed.children.length > 3) r3.feed.lastChild.remove();
}

// Punkt sceny → piksele nad canvasem; null, gdy za kamerą albo daleko poza kadrem
function toScreen(x, y, z) {
  const v = r3.tmpV.set(x, y, z).project(r3.camera);
  if (v.z > 1 || Math.abs(v.x) > 1.3 || Math.abs(v.y) > 1.3) return null;
  return { x: ((v.x + 1) / 2) * r3.size.w, y: ((1 - v.y) / 2) * r3.size.h };
}

function updateOverlay(now) {
  for (const r of world.racers) {
    const pt = toScreen(r.root.position.x, r.body.position.y + 0.95, r.z);
    r.tag.style.visibility = pt ? 'visible' : 'hidden';
    if (pt) r.tag.style.transform = `translate(${pt.x}px, ${pt.y}px) translate(-50%, -100%)`;
    const v = Math.round(r.v);
    if (r.shownV !== v) {
      r.shownV = v;
      r.tagPts.textContent = String(v);
      r.boardPts.textContent = compactNumber(v);
    }
    if (r.shownRank !== r.rank) {
      r.shownRank = r.rank;
      r.tagRank.textContent = String(r.rank + 1);
      r.tag.classList.toggle('lead', r.rank === 0);
      r.boardRow.style.transform = `translateY(${r.rank * BOARD_ROW}px)`;
      r.boardRow.classList.toggle('lead', r.rank === 0);
    }
  }

  r3.pops = r3.pops.filter(p => {
    const age = now - p.born;
    if (age > 1500) {
      p.node.remove();
      return false;
    }
    const r = p.racer;
    const pt = toScreen(r.root.position.x, r.body.position.y + 1.8 + age * 0.0011, r.z);
    p.node.style.visibility = pt ? 'visible' : 'hidden';
    if (pt) p.node.style.transform = `translate(${pt.x}px, ${pt.y}px) translate(-50%, -100%) scale(${1 + Math.max(0, 0.3 - age / 600)})`;
    p.node.style.opacity = String(1 - (age / 1500) ** 2);
    return true;
  });

  const day = view.p >= 1 ? 'dziś' : formatDay(new Date(world.t));
  if (r3.dateDay.textContent !== day) r3.dateDay.textContent = day;
}
