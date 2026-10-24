import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { state } from './state.js';
import { buildRaceSeries, compactNumber, formatDay, niceMax } from './stats.js';
import { currentYear, DAY_MS, el, icon, refreshIcons } from './ui.js';

/* ----------------- Wyścig 3D (eksperyment, Three.js) ----------------- */
// Te same punkty co na wykresie wyścigu, tylko jako lot książek przez bibliotekę:
// odległość od startu = punkty narastająco, meta = dzisiejszy wynik lidera.
// Three.js dociągamy z CDN dopiero przy pierwszym wejściu, reszta apki go nie potrzebuje.
// Adresy 'three' i 'three/addons/' są w import mapie w index.html (dodatki importują 'three').
const ADDON_PATHS = [
  'three/addons/postprocessing/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js',
  'three/addons/postprocessing/UnrealBloomPass.js',
  'three/addons/postprocessing/OutputPass.js',
  'three/addons/environments/RoomEnvironment.js',
];
const PLAY_MS = 18000;       // cały rok przy prędkości 1×
const TRACK_LEN = 160;       // od startu do mety, jednostki sceny
const LANE_W = 2.4;
const HOVER = 1.4;           // wysokość lotu książek
const BOARD_ROW = 22;        // px, wysokość wiersza tabeli wyników
const PARTICLES = 250;       // kartki i konfetti
const SPARKS = 900;          // świecące iskry: pył za książkami, fale, fajerwerki
const RINGS = 8;             // fale światła po skończonej książce
const SPINE_COLORS = ['#8c2f39', '#2f4b7c', '#3d6b45', '#b08d2a', '#5a3d6e', '#a0522d', '#2e6f73', '#c4b49a', '#6b4226', '#7d8c97', '#9c3d54', '#d0c3a5'];

// lampBoost > 1: kolory jaśniejsze niż biel (HDR), to one „świecą” w bloomie
const THEMES = {
  dark: {
    bg: 0x0b0d18, fogNear: 30, fogFar: 125,
    sky: 0x9fb0ff, ground: 0x24170c, hemi: 0.75, sun: 0xffd9a0, sunI: 1.3, env: 0.35, exposure: 1.05,
    floor: 0x9a8576, carpet: 0xb59a9a, wood: 0x6b4630, wall: 0x2e1c13, books: 0.75,
    lamp: 0xffc977, lampBoost: 4, dust: 0.8, trail: 0.85, pool: 0.55, spark: 1,
    bloom: { strength: 0.85, radius: 0.55, threshold: 0.92 },
  },
  light: {
    bg: 0xf1e6d2, fogNear: 38, fogFar: 160,
    sky: 0xfff6e8, ground: 0x8a6a4a, hemi: 1, sun: 0xfff4e0, sunI: 1.6, env: 0.4, exposure: 0.95,
    floor: 0xcfc2b6, carpet: 0xd6c4c4, wood: 0x8a5a3a, wall: 0x5a3a28, books: 0.95,
    lamp: 0xffe0a0, lampBoost: 1.6, dust: 0.35, trail: 0.6, pool: 0.18, spark: 0.7,
    bloom: { strength: 0.3, radius: 0.4, threshold: 0.95 },
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
let GOLD = null;    // THREE.Color, gotowy po załadowaniu silnika
let ADDONS = null;  // bloom i środowisko; bez nich scena też działa, tylko płaściej
let threeLoad = null;

async function loadThree() {
  THREE = await import('three');
  try {
    ADDONS = Object.assign({}, ...(await Promise.all(ADDON_PATHS.map(path => import(path)))));
  } catch (err) {
    console.warn('three addons unavailable, rendering without bloom:', err);
  }
}
let r3 = null;     // renderer, kamera, stała część sceny i HUD (tworzone raz)
let world = null;  // tor i zawodnicy dla bieżących danych (przebudowywane, gdy dane się zmienią)

const view = {
  active: false,     // ekran Statystyki jest otwarty
  visible: false,    // karta jest w kadrze
  autoplay: false,   // przy najbliższym pokazaniu odpal wyścig od startu
  playing: false,
  p: 1,              // 0..1, dzień roku
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
  if (r3) setReplayVisible();
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
    threeLoad = loadThree();
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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
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

  // Bloom (poświata) przez postprocessing; MSAA w buforze, bo composer omija antialias canvasa
  let composer = null;
  let bloom = null;
  if (ADDONS) {
    try {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2 });
      composer = new ADDONS.EffectComposer(renderer, target);
      composer.addPass(new ADDONS.RenderPass(scene, camera));
      bloom = new ADDONS.UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.5, 0.8);
      composer.addPass(bloom);
      composer.addPass(new ADDONS.OutputPass());
      // Odbicia na złocie, drewnie i okładkach z prostego „pokoju” zamiast mapy HDR z sieci
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new ADDONS.RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    } catch (err) {
      console.warn('bloom setup failed, rendering without it:', err);
      composer = null;
      bloom = null;
    }
  }
  // Z bloomem każdy piksel liczony jest kilka razy, więc mniejsza rozdzielczość
  // (dalej zmniejsza ją adaptQuality, gdy klatki są za wolne)
  const pixelRatio = Math.min(window.devicePixelRatio || 1, composer ? 1.25 : 1.5);
  renderer.setPixelRatio(pixelRatio);
  composer?.setPixelRatio(pixelRatio);

  r3 = {
    renderer, scene, camera, hemi, sun, canvas, host, composer, bloom,
    quality: { ratio: pixelRatio, sum: 0, n: 0, skip: 90 },
    raf: null, last: 0, size: { w: 1, h: 1 },
    cam: { yaw: 0.3, pitch: 0.34, dist: 14, focus: 0, focusX: 0, tz: null, tx: null, offZ: 0, offX: 0, fit: 1, fitZ: 0 },
    camGoal: { yaw: 0.3, pitch: 0.34, dist: 14 },
    shake: 0,
    tmpV: new THREE.Vector3(), tmpColor: new THREE.Color(), dummy: new THREE.Object3D(),
  };
  buildShared();
  buildHud();
  buildParticles();
  buildSparks();
  buildRings();
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
  r3.composer?.setSize(w, h);
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
      g.fillStyle = (x + y) % 2 ? '#151515' : '#c9c9c9';  // nie czysta biel, żeby meta nie świeciła w bloomie
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  }));
  const carpetTex = repeat(canvasTexture(256, 256, carpet));
  carpetTex.anisotropy = 4;
  // Ślad na dywanie: jasny przy książce, wygasa w stronę startu (v = 1 to czoło śladu)
  const trailTex = canvasTexture(4, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.15, 'rgba(255,255,255,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0.08)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
  const flameTex = canvasTexture(64, 64, g => {
    const grad = g.createRadialGradient(32, 38, 0, 32, 34, 30);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,220,140,0.9)');
    grad.addColorStop(0.6, 'rgba(255,140,40,0.25)');
    grad.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  const ringTex = canvasTexture(128, 128, g => {
    const grad = g.createRadialGradient(64, 64, 40, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.75, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  });
  // Grzbiety książek na regałach: paski różnej szerokości i wysokości, z ciemnymi etykietami.
  // Trzy warianty losowane per półka, żeby nie było widać powtórzeń.
  const spinesTex = () => canvasTexture(512, 128, (g, w, h) => {
    g.fillStyle = '#2a1a10';
    g.fillRect(0, 0, w, h);
    let x = 0;
    while (x < w) {
      const bw = rand(7, 16);
      const top = rand(0, 26);
      g.fillStyle = SPINE_COLORS[Math.floor(Math.random() * SPINE_COLORS.length)];
      g.fillRect(x, top, bw - 1, h - top);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x, top + rand(14, 40), bw - 1, rand(6, 12));
      g.fillStyle = 'rgba(255,215,140,0.35)';
      g.fillRect(x, top + rand(48, 80), bw - 1, 2);
      x += bw;
    }
  });
  r3.tex = { trail: trailTex, glow: glowTex };

  r3.mats = {
    floor: keep(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.45 })),  // lakierowany parkiet
    carpet: keep(new THREE.MeshStandardMaterial({ map: carpetTex, roughness: 0.95 })),
    wood: keep(new THREE.MeshStandardMaterial({ roughness: 0.7 })),
    wall: keep(new THREE.MeshStandardMaterial({ roughness: 0.8 })),
    books: keep(new THREE.MeshStandardMaterial({ roughness: 0.75 })),
    gold: keep(new THREE.MeshStandardMaterial({ color: 0xf0c75e, metalness: 0.75, roughness: 0.28, emissive: 0x6b4a00, emissiveIntensity: 0.35 })),
    goldFlat: keep(new THREE.MeshBasicMaterial({ color: 0xf0c75e, transparent: true, opacity: 0.75 })),
    white: keep(new THREE.MeshBasicMaterial({ color: 0xcfcfcf, transparent: true, opacity: 0.85 })),
    lane: keep(new THREE.MeshBasicMaterial({ color: 0xf3e3c0, transparent: true, opacity: 0.35 })),
    metal: keep(new THREE.MeshStandardMaterial({ color: 0x2b2b30, metalness: 0.6, roughness: 0.4 })),
    lamp: keep(new THREE.MeshBasicMaterial({ color: 0xffd98a })),
    shadow: keep(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })),
    dust: keep(new THREE.PointsMaterial({ map: dustTex, size: 0.14, color: 0xffe3b0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })),
    pages: keep(new THREE.MeshStandardMaterial({ color: 0xe2d6bc, roughness: 0.9 })),
    ribbon: keep(new THREE.MeshStandardMaterial({ color: 0xf0c75e, side: THREE.DoubleSide, roughness: 0.5 })),
    checker: keep(new THREE.MeshBasicMaterial({ map: checkerTex })),
    paper: keep(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
    // Plamy ciepłego światła na podłodze (pod lampami i świecami)
    pool: keep(new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffb860, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })),
    candle: keep(new THREE.MeshStandardMaterial({ color: 0xf3ead2, roughness: 0.6, emissive: 0xffd9a0, emissiveIntensity: 0.15 })),
    flame: keep(new THREE.PointsMaterial({ map: flameTex, size: 0.55, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })),
    shade: keep(new THREE.MeshStandardMaterial({ color: 0x1f6b45, roughness: 0.35, metalness: 0.1, emissive: 0x2f9a60, emissiveIntensity: 0.35 })),
    plant: keep(new THREE.MeshStandardMaterial({ color: 0x3f7d3a, roughness: 0.8 })),
    globe: keep(new THREE.MeshStandardMaterial({ color: 0x3b6e8f, roughness: 0.4, metalness: 0.1 })),
    pot: keep(new THREE.MeshStandardMaterial({ color: 0x9a5a3a, roughness: 0.8 })),
    spark: keep(new THREE.PointsMaterial({ map: dustTex, size: 0.3, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })),
    ring: keep(new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })),
  };
  r3.spineMats = [0, 1, 2].map(() => keep(new THREE.MeshStandardMaterial({ map: spinesTex(), roughness: 0.8 })));

  const trail = new THREE.PlaneGeometry(1, 1);
  trail.rotateX(-Math.PI / 2);
  trail.translate(0, 0, -0.5);  // rośnie od startu (z = 0) do przodu (−z)
  const ribbon = new THREE.PlaneGeometry(0.1, 1.1);
  ribbon.translate(0, -0.55, 0);
  const shadow = new THREE.PlaneGeometry(1.6, 1.9);
  shadow.rotateX(-Math.PI / 2);
  const decal = new THREE.PlaneGeometry(1, 1);
  decal.rotateX(-Math.PI / 2);
  r3.geo = {
    decal: keep(decal),
    cyl: keep(new THREE.CylinderGeometry(0.5, 0.5, 1, 14)),
    ball: keep(new THREE.SphereGeometry(0.5, 12, 8)),
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

// HUD: data, tabela i jedyny przycisk „Powtórz”, widoczny dopiero po dojechaniu do mety
function buildHud() {
  r3.replayBtn = el('button', { type: 'button', class: 'r3d-replay', hidden: '' }, [icon('rotate-ccw'), el('span', { text: 'Powtórz' })]);
  r3.dateDay = el('strong', { text: '' });
  r3.labels = el('div', { class: 'r3d-labels', 'aria-hidden': 'true' });
  r3.board = el('ol', { class: 'r3d-board', 'aria-label': 'Kolejność' });
  r3.status = el('div', { class: 'r3d-status', hidden: '' });

  r3.host.replaceChildren(
    r3.canvas,
    r3.labels,
    el('div', { class: 'r3d-date' }, [r3.dateDay, el('span', { text: String(currentYear()) })]),
    r3.board,
    r3.replayBtn,
    r3.status,
  );
  refreshIcons();
  r3.replayBtn.addEventListener('click', () => {
    if (world) replay();
  });
}

function setReplayVisible() {
  r3.replayBtn.hidden = !world || view.playing || view.p < 1;
}

// Przeciąganie obraca kamerę (kółko i dwa palce zostają dla przewijania i zoomu strony)
function bindPointer() {
  let last = null;
  const { canvas } = r3;
  canvas.addEventListener('pointerdown', e => {
    last = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    view.showcase = false;
  });
  canvas.addEventListener('pointermove', e => {
    if (!last || last.id !== e.pointerId) return;
    const g = r3.camGoal;
    g.yaw -= (e.clientX - last.x) * 0.006;
    g.pitch = clamp(g.pitch + (e.clientY - last.y) * 0.005, 0.05, 1.4);
    last = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  const release = () => { last = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  // Pełny ekran: dwuklik (dwa stuknięcia) włącza i wyłącza, Esc też wyłącza
  canvas.addEventListener('dblclick', toggleFull);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && view.full) toggleFull();
  });
}

function toggleFull() {
  view.full = !view.full;
  r3.host.classList.toggle('r3d-full', view.full);
  document.body.classList.toggle('r3d-lock', view.full);
  resize();
}

function applyTheme() {
  if (!r3) return;
  const dark = document.documentElement.classList.contains('dark-mode');
  const t = THEMES[dark ? 'dark' : 'light'];
  const { scene, mats, hemi, sun } = r3;
  r3.theme = t;
  r3.renderer.toneMappingExposure = t.exposure;
  scene.environmentIntensity = t.env;
  if (r3.bloom) Object.assign(r3.bloom, t.bloom);
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
  mats.wall.color.set(t.wall);
  mats.books.color.setScalar(t.books);
  r3.spineMats.forEach(m => m.color.setScalar(t.books));
  mats.lamp.color.set(t.lamp).multiplyScalar(t.lampBoost);
  mats.dust.opacity = t.dust;
  mats.dust.color.set(0xffe3b0).multiplyScalar(dark ? 2 : 1);
  mats.pool.opacity = t.pool;
  r3.trailOpacity = t.trail;
  // Kolory serii z CSS różnią się między motywami; po ciemku ślady świecą (addytywnie)
  world?.racers.forEach(r => {
    r.css = resolveColor(r.s.color);
    r.coverMat.color.set(r.css);
    r.coverMat.emissive.set(r.css);
    r.trailMat.color.set(r.css).multiplyScalar(dark ? 1.5 : 1);
    r.trailMat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    r.trailMat.needsUpdate = true;
    r.trailMat.opacity = t.trail;
    r.glowMat.color.set(r.css);
    r.glowMat.opacity = dark ? 0.6 : 0.35;
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

// Dywan: bordowy, delikatna kratka w romby i złote bordiury z ornamentem przy krawędziach
function carpet(g, w, h) {
  g.fillStyle = '#7f1a2a';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 1400; i++) {  // faktura runa
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,200,200'},${rand(0.02, 0.06)})`;
    g.fillRect(rand(0, w), rand(0, h), rand(1, 3), rand(1, 3));
  }
  g.strokeStyle = 'rgba(255,205,150,0.09)';
  g.lineWidth = 2;
  for (let y = -32; y < h + 32; y += 32) {
    for (let x = 48; x < w - 48; x += 32) {
      g.beginPath();
      g.moveTo(x, y - 14);
      g.lineTo(x + 14, y);
      g.lineTo(x, y + 14);
      g.lineTo(x - 14, y);
      g.closePath();
      g.stroke();
    }
  }
  for (const edge of [0, w]) {
    const dir = edge === 0 ? 1 : -1;
    const at = px => edge + dir * px;
    g.fillStyle = '#4a0d18';
    g.fillRect(Math.min(at(0), at(30)), 0, 30, h);
    g.fillStyle = '#e2b65a';
    g.fillRect(Math.min(at(5), at(8)), 0, 3, h);
    g.fillRect(Math.min(at(25), at(27)), 0, 2, h);
    for (let y = 8; y < h; y += 16) {
      const cx = at(16.5);
      g.beginPath();
      g.moveTo(cx, y - 5);
      g.lineTo(cx + 4, y);
      g.lineTo(cx, y + 5);
      g.lineTo(cx - 4, y);
      g.closePath();
      g.fill();
    }
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
  r3.board.replaceChildren();
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

// Wiele powtarzalnych brył (deski, książki, stoły, lampy) jako jeden InstancedMesh
// na parę geometria + materiał: kilkanaście wywołań rysowania zamiast tysięcy
function batcher() {
  const kinds = new Map();
  return {
    add(geo, mat, [sx, sy, sz], [x, y, z], { color = null, rot = null } = {}) {
      const key = `${geo.uuid}:${mat.uuid}`;
      if (!kinds.has(key)) kinds.set(key, { geo, mat, items: [] });
      kinds.get(key).items.push({ s: [sx, sy, sz], p: [x, y, z], color, rot });
    },
    flush(group) {
      const d = r3.dummy;
      for (const { geo, mat, items } of kinds.values()) {
        const mesh = new THREE.InstancedMesh(geo, mat, items.length);
        const colored = items.some(it => it.color);
        items.forEach((it, i) => {
          d.position.set(...it.p);
          d.rotation.set(...(it.rot || [0, 0, 0]));
          d.scale.set(...it.s);
          d.updateMatrix();
          mesh.setMatrixAt(i, d.matrix);
          if (colored) mesh.setColorAt(i, r3.tmpColor.set(it.color || '#ffffff'));
        });
        mesh.frustumCulled = false;
        group.add(mesh);
      }
    },
  };
}

const pickSpineMat = () => r3.spineMats[Math.floor(Math.random() * r3.spineMats.length)];

const pickSpine = () => {
  const c = new THREE.Color(SPINE_COLORS[Math.floor(Math.random() * SPINE_COLORS.length)]);
  return c.multiplyScalar(rand(0.8, 1.1));
};

// Ściany czytelni: boazeria ze złotym gzymsem i listwą, po bokach i na obu końcach
function buildWalls(b, wallX, zNear, zFar) {
  const { geo, mats } = r3;
  const h = 8;
  const len = zNear - zFar;
  const zMid = (zNear + zFar) / 2;
  const t = 0.5;
  for (const side of [-1, 1]) {
    const x = side * (wallX + t / 2);
    b.add(geo.box, mats.wall, [t, h, len + t * 2], [x, h / 2, zMid]);
    b.add(geo.box, mats.gold, [t + 0.3, 0.25, len + t * 2], [x - side * 0.15, h + 0.12, zMid]);
    b.add(geo.box, mats.gold, [t + 0.12, 0.08, len], [x - side * 0.06, 1.1, zMid]);
  }
  for (const z of [zNear + t / 2, zFar - t / 2]) {
    b.add(geo.box, mats.wall, [wallX * 2 + t * 2, h, t], [0, h / 2, z]);
    b.add(geo.box, mats.gold, [wallX * 2 + t * 2, 0.25, t + 0.3], [0, h + 0.12, z]);
  }
}

// Główne regały wzdłuż toru. Książki na półce to jeden blok z teksturą grzbietów
// (z góry wygląda prawie tak samo jak pojedyncze, a brył jest kilkadziesiąt razy mniej)
function buildShelves(b, halfW, zNear, zFar) {
  const { geo, mats } = r3;
  const unit = 4;
  const levels = 5;
  const levelH = 1.3;
  const depth = 0.9;
  const inner = halfW + 3.4;
  const topY = levels * levelH + 0.25;
  for (const side of [-1, 1]) {
    const xMid = side * (inner + depth / 2);
    for (let z = zNear; z > zFar; z -= unit) {
      const zMid = z - unit / 2;
      for (let l = 0; l <= levels; l++) b.add(geo.box, mats.wood, [depth, 0.08, unit], [xMid, l * levelH + 0.04, zMid]);
      b.add(geo.box, mats.wood, [depth, levels * levelH, 0.1], [xMid, (levels * levelH) / 2, z]);
      b.add(geo.box, mats.wood, [0.06, levels * levelH, unit], [side * (inner + depth), (levels * levelH) / 2, zMid]);
      b.add(geo.box, mats.wood, [depth + 0.2, 0.25, unit], [xMid, levels * levelH + 0.12, zMid]);
      for (let l = 0; l < levels; l++) {
        const hgt = levelH * rand(0.7, 0.84);
        b.add(geo.box, pickSpineMat(), [depth * 0.82, hgt, unit - 0.2], [xMid + side * 0.03, l * levelH + 0.08 + hgt / 2, zMid], { rot: [0, Math.random() < 0.5 ? 0 : Math.PI, 0] });
      }
      // Na szczycie regału: globus, roślina albo leżący stos książek (widać je z góry)
      const roll = Math.random();
      const zz = zMid + rand(-1, 1);
      if (roll < 0.22) {
        b.add(geo.cyl, mats.gold, [0.25, 0.12, 0.25], [xMid, topY + 0.06, zz]);
        b.add(geo.ball, mats.globe, [0.62, 0.62, 0.62], [xMid, topY + 0.45, zz]);
      } else if (roll < 0.42) {
        b.add(geo.cyl, mats.pot, [0.38, 0.4, 0.38], [xMid, topY + 0.2, zz]);
        b.add(geo.ball, mats.plant, [0.75, 0.6, 0.75], [xMid, topY + 0.6, zz]);
      } else if (roll < 0.7) {
        let y = topY;
        for (let k = 0; k < 2 + Math.floor(rand(0, 3)); k++) {
          const t = rand(0.12, 0.2);
          b.add(geo.box, mats.books, [rand(0.55, 0.75), t, rand(0.8, 1.1)], [xMid, y + t / 2, zz], { color: pickSpine(), rot: [0, rand(-0.4, 0.4), 0] });
          y += t;
        }
      }
    }
  }
  return topY;
}

// Za głównymi regałami rzędy regałów w poprzek toru, jak w czytelni. Daleko i we mgle,
// więc książki na nich to jeden blok z teksturą grzbietów na półkę
function buildStacks(b, halfW, zNear, zFar) {
  const { geo, mats } = r3;
  const x0 = halfW + 5.4;
  const x1 = halfW + 12;
  const len = x1 - x0;
  const levels = 3;
  const levelH = 1.25;
  const h = levels * levelH;
  for (const side of [-1, 1]) {
    const xMid = side * (x0 + len / 2);
    for (let z = zNear - 2; z > zFar; z -= 4.2) {
      for (let l = 0; l <= levels; l++) b.add(geo.box, mats.wood, [len, 0.07, 0.85], [xMid, l * levelH + 0.035, z]);
      b.add(geo.box, mats.wood, [len, h, 0.06], [xMid, h / 2, z]);
      for (const end of [x0, x1]) b.add(geo.box, mats.wood, [0.1, h + 0.15, 0.9], [side * end, (h + 0.15) / 2, z]);
      for (let l = 0; l < levels; l++) {
        for (const face of [-1, 1]) {
          b.add(geo.box, pickSpineMat(), [len - 0.2, levelH * rand(0.68, 0.82), 0.34], [xMid + rand(-0.1, 0.1), l * levelH + 0.07 + levelH * 0.37, z + face * 0.22], { rot: [0, Math.random() < 0.5 ? 0 : Math.PI, 0] });
        }
      }
    }
  }
}

// Stoły do czytania z zielonymi lampami bankierskimi i plamą ciepłego światła wokół
function buildTables(b, halfW, zNear, zFar) {
  const { geo, mats } = r3;
  let side = 1;
  for (let z = zNear - 10; z > zFar + 10; z -= 13) {
    side = -side;
    const x = side * (halfW + 2.15);
    const y = 0.8;
    b.add(geo.box, mats.wood, [1.3, 0.08, 2.4], [x, y, z]);
    for (const dx of [-0.55, 0.55]) for (const dz of [-1.05, 1.05]) b.add(geo.box, mats.wood, [0.08, y, 0.08], [x + dx, y / 2, z + dz]);
    const lz = z - 0.6;
    b.add(geo.cyl, mats.gold, [0.24, 0.05, 0.24], [x, y + 0.07, lz]);
    b.add(geo.cyl, mats.gold, [0.05, 0.36, 0.05], [x, y + 0.27, lz]);
    b.add(geo.cyl, mats.shade, [0.3, 0.6, 0.3], [x, y + 0.47, lz], { rot: [0, 0, Math.PI / 2] });
    b.add(geo.ball, mats.lamp, [0.16, 0.12, 0.16], [x, y + 0.38, lz]);
    b.add(geo.decal, mats.pool, [5, 1, 5], [x, 0.016, lz]);
    b.add(geo.decal, mats.pool, [1.6, 1, 1.6], [x, y + 0.045, lz]);
    let sy = y + 0.04;
    for (let k = 0; k < 1 + Math.floor(rand(0, 3)); k++) {
      const t = rand(0.08, 0.14);
      b.add(geo.box, mats.books, [rand(0.5, 0.65), t, rand(0.7, 0.9)], [x + rand(-0.15, 0.15), sy + t / 2, z + 0.55], { color: pickSpine(), rot: [0, rand(-0.5, 0.5), 0] });
      sy += t;
    }
  }
}

// Lewitujące świece nad bokami toru i stojące na regałach; płomienie to punkty w HDR (świecą w bloomie)
function buildCandles(group, halfW, zNear, zFar, shelfTop) {
  const items = [];
  for (let z = zNear - 4; z > zFar; z -= rand(3.5, 6)) {
    for (const side of [-1, 1]) {
      if (Math.random() < 0.35) continue;
      items.push({ x: side * rand(halfW + 0.9, halfW + 3), y: rand(4.2, 7), z: z + rand(-1, 1), h: rand(0.35, 0.65), bob: rand(0.12, 0.3), seed: rand(0, 100) });
    }
    if (Math.random() < 0.25) {
      const side = Math.random() < 0.5 ? -1 : 1;
      items.push({ x: side * (halfW + 3.85), y: shelfTop + 0.2, z, h: 0.4, bob: 0, seed: rand(0, 100) });
    }
  }
  const bodies = new THREE.InstancedMesh(r3.geo.cyl, r3.mats.candle, items.length);
  bodies.frustumCulled = false;
  const pos = new Float32Array(items.length * 3);
  const col = new Float32Array(items.length * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const flames = new THREE.Points(geo, r3.mats.flame);
  flames.frustumCulled = false;
  group.add(bodies, flames);
  return { items, bodies, flames, pos, col, geo };
}

function buildDust(group, halfW, zNear, zFar) {
  const count = 160;
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
  const coverMat = new THREE.MeshStandardMaterial({ color: css, emissive: css, emissiveIntensity: 0.3, roughness: 0.35, metalness: 0.1 });
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
  // Kolorowa poświata pod książką (addytywna, w bloomie wygląda jak światło odbite od dywanu)
  const glowMat = new THREE.MeshBasicMaterial({ map: r3.tex.glow, color: css, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 });
  const glow = new THREE.Mesh(geo.decal, glowMat);
  glow.scale.set(3.4, 1, 3.8);
  glow.position.y = 0.04;
  root.add(shadow, glow);
  group.add(root);

  // Ślad na dywanie świeci najmocniej przy książce i wygasa w stronę startu
  const trailMat = new THREE.MeshBasicMaterial({ map: r3.tex.trail, color: css, transparent: true, opacity: r3.trailOpacity, depthWrite: false });
  const trail = new THREE.Mesh(geo.trail, trailMat);
  trail.position.set(x, 0.022, 0);
  trail.scale.set(LANE_W * 0.5, 1, 0.001);
  group.add(trail);

  // Imię namalowane na dywanie przed linią startu
  const first = firstName(s.name);
  const nameTag = flat(new THREE.PlaneGeometry(LANE_W * 0.9, LANE_W * 0.9 * 0.25),
    new THREE.MeshBasicMaterial({ map: textTexture(first.toUpperCase(), { w: 512, h: 128, size: 64, fg: '#ffffff', bg: null }), transparent: true, opacity: 0.85, depthWrite: false }),
    x, 0.03, 2.2);
  group.add(nameTag);

  const tagRank = el('b');
  const tag = el('div', { class: 'r3d-tag' }, [tagRank, el('span', { text: first })]);
  tag.style.setProperty('--c', css);
  r3.labels.appendChild(tag);

  const boardPts = el('b');
  const boardRow = el('li', { class: 'r3d-board-row' }, [el('i', { class: 'r3d-dot' }), el('span', { class: 'r3d-board-name', text: first }), boardPts]);
  boardRow.style.setProperty('--c', css);
  boardRow.style.transform = `translateY(${i * BOARD_ROW}px)`;  // od razu na miejscu, bez wjazdu z góry
  r3.board.appendChild(boardRow);

  return {
    s, first, css, root, body, wings, ribbon, shadow, glow, glowMat, trail, trailMat, coverMat,
    tag, tagRank, boardRow, boardPts,
    z: 0, v: 0, vel: 0, speed: 0, phase: rand(0, 6), seed: rand(0, 100), sparkAcc: 0,
    rank: i, shownV: -1, shownRank: -1,
  };
}

function buildWorld(series, rows, sig) {
  clearWorld();
  const t0 = new Date(currentYear(), 0, 1).getTime();
  const t1 = Math.max(Date.now(), t0 + DAY_MS);
  // Książka bez daty rozpoczęcia na wykresie wskakuje w całości w dniu dodania. Tu rozkładamy ją
  // na kilka–kilkanaście dni przed końcem (więcej punktów = dłużej), żeby książka leciała, a nie skakała.
  // Wynik w dniu skończenia jest ten sam.
  const ordered = [...series]
    .map(s => ({
      ...s,
      books: s.books.map(b => (b.end > b.start ? b : { ...b, start: Math.max(t0, b.end - clamp(b.pts / 35, 4, 21) * DAY_MS) })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const n = ordered.length;
  const halfW = (n * LANE_W) / 2 + 0.5;
  const finalMax = Math.max(...ordered.map(s => s.total));
  const { mats, geo } = r3;
  const group = new THREE.Group();
  const zNear = 24;
  const zFar = -(TRACK_LEN + 70);
  const len = zNear - zFar;
  const zMid = (zNear + zFar) / 2;

  // Podłoga, dywan, złote krawędzie i linie torów
  // Podłoga tylko w obrysie czytelni; dookoła ściany, więc nigdzie nie widać parkietu po horyzont
  const wallX = halfW + 12.6;
  const floorW = wallX * 2;
  mats.floor.map.repeat.set(floorW / 4, len / 4);
  mats.carpet.map.repeat.set(1, (len - 8) / (halfW * 2));
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

  const b = batcher();
  buildWalls(b, wallX, zNear, zFar);
  const shelfTop = buildShelves(b, halfW, zNear, zFar);
  buildStacks(b, halfW, zNear, zFar);
  buildTables(b, halfW, zNear, zFar);
  b.flush(group);
  const candles = buildCandles(group, halfW, zNear, zFar, shelfTop);
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
    sig, group, racers, byKey, events, evIdx: 0, dust, crown, candles,
    t0, t1, t: t1, finalMax, halfW, leader: racers[0],
    baseDist: 9 + halfW * 1.5,
  };

  // Ustaw zawodników od razu tam, gdzie wskazuje bieżący dzień (bez dojeżdżania)
  world.t = t0 + view.p * (t1 - t0);
  racers.forEach(r => {
    r.v = exactValue(r.s, world.t);
    r.z = -(r.v / finalMax) * TRACK_LEN;
  });
  updateRanking();
  world.evIdx = events.filter(e => e.t <= world.t).length;
  crown.position.set(world.leader.root.position.x, HOVER + 0.9, world.leader.z);
  setCamMode(view.mode, true);
  Object.assign(r3.cam, { tz: null, tx: null, offZ: 0, offX: 0, fit: 1, fitZ: 0 });
  applyTheme();
  setReplayVisible();
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
    r.vel = 0;
    r.rank = i;
  });
  r3.particles.life.fill(0);
  r3.particles.activeUntil = performance.now() + 100;
  r3.sparks.life.fill(0);
  r3.sparks.activeUntil = performance.now() + 100;
  r3.rings.forEach(ring => { ring.age = Infinity; ring.mesh.visible = false; });
  r3.rockets = [];
  setCamMode(view.mode, true);
  Object.assign(r3.cam, { tz: null, tx: null, offZ: 0, offX: 0, fit: 1, fitZ: 0 });
  setReplayVisible();
}

function frame(now) {
  if (!world) {  // dane zniknęły między klatkami
    r3.raf = null;
    return;
  }
  r3.raf = requestAnimationFrame(frame);
  const rawDt = now - r3.last;
  const dt = Math.min(50, rawDt);
  r3.last = now;
  adaptQuality(rawDt);
  if (view.playing) {
    // Ostatnia prosta w zwolnionym tempie, żeby dojazd na metę nie urywał się nagle
    const slow = 1 - 0.7 * smoothstep(0.88, 1, view.p);
    view.p = Math.min(1, view.p + (dt * slow) / PLAY_MS);
    if (view.p >= 1) {
      view.playing = false;
      setReplayVisible();
      finale();
    }
  }
  updateRacers(dt, now);
  updateParticles(dt);
  updateRockets(dt);
  updateSparks(dt);
  updateRings(dt);
  updateCandles(now);
  updateDust(dt);
  updateCamera(dt);
  if (r3.composer) r3.composer.render(dt / 1000);
  else r3.renderer.render(r3.scene, r3.camera);
  updateOverlay();
}

// Automatyczna jakość: gdy przez ~1,5 s klatki idą wolniej niż ~45 na sekundę, zmniejszamy
// rozdzielczość, a gdy to nie wystarczy, wyłączamy poświatę. Tylko w dół, żeby obraz nie mrugał.
// Pierwsze klatki pomijamy (kompilacja shaderów).
function adaptQuality(rawDt) {
  const q = r3.quality;
  if (q.skip > 0) {
    q.skip--;
    return;
  }
  if (rawDt > 250) return;  // przerwa (karta w tle, przewijanie), nie wolna klatka
  q.sum += rawDt;
  q.n++;
  if (q.sum < 1500) return;
  const avg = q.sum / q.n;
  q.sum = 0;
  q.n = 0;
  if (avg < 22) return;
  if (q.ratio > 0.75) {
    q.ratio = Math.max(0.75, q.ratio - 0.25);
    r3.renderer.setPixelRatio(q.ratio);
    r3.composer?.setPixelRatio(q.ratio);
    resize();
  } else if (r3.composer) {
    r3.composer = null;  // bez poświaty; tonację robi wtedy sam renderer
  }
  q.skip = 30;
}

function updateRacers(dt, now) {
  const { racers, t0, t1, finalMax } = world;
  world.t = t0 + view.p * (t1 - t0);
  for (const r of racers) {
    r.v = exactValue(r.s, world.t);
    const target = -(r.v / finalMax) * TRACK_LEN;
    // Tłumiona sprężyna (bez odbicia): książka płynnie rusza i hamuje, zamiast zmieniać
    // prędkość skokowo na początku i końcu każdej czytanej książki
    const s = dt / 1000;
    const omega = 2 / 0.35;
    const x = omega * s;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const offset = r.z - target;
    const pull = (r.vel + omega * offset) * s;
    r.vel = (r.vel - omega * pull) * decay;
    r.z = target + (offset + pull) * decay;
    r.speed = Math.abs(r.vel) / 1000;  // jednostki na ms, jak reszta animacji

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

    // Świecący pył za lecącą książką: im szybciej, tym gęściej
    if (view.playing && r.speed > 0.0015) {
      r.sparkAcc += dt * (0.006 + Math.min(r.speed, 0.04) * 1.8);
      const color = r3.tmpColor.set(r.css).lerp(GOLD, 0.25).multiplyScalar(2.2);
      while (r.sparkAcc >= 1) {
        r.sparkAcc -= 1;
        spark(
          r.root.position.x + rand(-0.6, 0.6), r.body.position.y + rand(-0.25, 0.25), r.z + rand(0.6, 1.1),
          rand(-0.4, 0.4), rand(-0.2, 0.5), rand(0.2, 1.2), color, rand(0.6, 1.1), -0.6,
        );
      }
    }
  }
  updateRanking();
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

function updateRanking() {
  // Przy remisie zostaje dotychczasowa kolejność, żeby tabela nie migała
  const sorted = [...world.racers].sort((a, b) => b.v - a.v || a.rank - b.rank);
  sorted.forEach((r, i) => { r.rank = i; });
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
    emit(r3.tmpV, 14, ['#f6eedb', '#ffffff', r.css], { speed: 2.6, up: 4.5 });
    // Skończona książka: fala światła po dywanie i złote iskry
    ring(r.root.position.x, r.z, r.css);
    const gold = r3.tmpColor.copy(GOLD).multiplyScalar(3);
    for (let i = 0; i < 20; i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(1.5, 4);
      spark(r.root.position.x, r.body.position.y, r.z, Math.cos(a) * v, rand(1, 4), Math.sin(a) * v, gold, rand(0.6, 1.2), -5);
    }
  }
}

function finale() {
  const colors = [...world.racers.map(r => r.css), '#f0c75e', '#ffffff'];
  for (let i = 0; i < 3; i++) {
    r3.tmpV.set(rand(-world.halfW, world.halfW), 6.2, -TRACK_LEN + rand(-0.5, 0.5));
    emit(r3.tmpV, 40, colors, { speed: 4, up: 3, spread: 2 });
  }
  // Fajerwerki znad mety, w kolorach wszystkich zawodników
  if (!reduced()) {
    const fwColors = [...world.racers.map(r => r.css), '#f0c75e'];
    for (let i = 0; i < 5; i++) {
      r3.rockets.push({
        x: rand(-world.halfW - 1, world.halfW + 1), y: 0.5, z: -TRACK_LEN + rand(0, 10),
        vy: rand(6.5, 8), delay: i * 0.35 + rand(0, 0.2), fuse: rand(0.65, 0.8),
        color: new THREE.Color(fwColors[i % fwColors.length]),
      });
    }
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
};
// Dalej za liderem: poza kadrem, bo kamera musiałaby odjechać tak daleko, że książek nie widać.
// Pierwsza dwójka jest w kadrze zawsze, niezależnie od odstępu.
const PACK_MAX_GAP = TRACK_LEN * 0.22;
// Obszar kadru (współrzędne ekranu −1..1), w którym mają się mieścić książki z etykietami:
// pod datą i tabelą, z małym marginesem na dole
const FRAME = { top: 0.5, bottom: -0.8, side: 0.82 };

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
}

// Kogo kamera trzyma w kadrze: zawsze dwie pierwsze osoby na torze, a kolejne, jeśli nie są
// dalej niż PACK_MAX_GAP za liderem. key zmienia się przy zmianie składu (wtedy płynny przejazd).
function packTarget() {
  const byPos = [...world.racers].sort((a, b) => a.z - b.z);
  const lead = byPos[0].z;
  const pack = byPos.filter((r, i) => i < 2 || r.z - lead <= PACK_MAX_GAP);
  const back = pack[pack.length - 1].z;
  const x = pack.reduce((sum, r) => sum + r.root.position.x, 0) / pack.length;
  return { key: `pack:${pack.map(r => r.s.key).join()}`, pack, x: x * 0.4, z: (lead + back) / 2 };
}

// Gdzie grupa wypada na ekranie: zakres pionowy i największe wychylenie w poziomie
// (liczone dla książki i dla etykiety nad nią). Za kamerą = daleko poza kadrem.
function packOnScreen(pack) {
  const { camera } = r3;
  camera.updateMatrixWorld();
  const v = r3.tmpV;
  const out = { minY: Infinity, maxY: -Infinity, maxX: 0 };
  for (const r of pack) {
    for (const dy of [0, 1.6]) {
      v.set(r.root.position.x, r.body.position.y + dy, r.z).project(camera);
      const y = v.z > 1 ? -3 : v.y;
      out.minY = Math.min(out.minY, y);
      out.maxY = Math.max(out.maxY, y);
      out.maxX = Math.max(out.maxX, v.z > 1 ? 3 : Math.abs(v.x));
    }
  }
  return out;
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
  cam.focus = target.z + cam.offZ + cam.fitZ;
  cam.focusX = target.x + cam.offX;
  const dist = cam.dist * cam.fit;
  // Przy dużym odstępie (kamera daleko) widok przechodzi w prawie pionowy, jak mapa: z ukosa
  // daleka książka byłaby kropką na horyzoncie. Mgła odsuwa się razem z kamerą.
  const pitch = cam.pitch + (1.42 - cam.pitch) * smoothstep(1.6, 5, cam.fit);
  const t = r3.theme;
  r3.scene.fog.near = Math.max(t.fogNear, dist * 0.9);
  r3.scene.fog.far = Math.max(t.fogFar, dist * 1.8 + 40);

  r3.shake *= Math.exp(-dt / 260);
  const jitter = () => (Math.random() - 0.5) * r3.shake;
  // W pionie górę kadru zajmuje HUD, więc celujemy wyżej i stawka ląduje niżej na ekranie.
  const look = r3.tmpV.set(cam.focusX, r3.portrait ? 2.4 : 1.3, cam.focus - 1);
  camera.position.set(
    look.x + Math.sin(cam.yaw) * Math.cos(pitch) * dist + jitter(),
    look.y + Math.sin(pitch) * dist + jitter(),
    look.z + Math.cos(cam.yaw) * Math.cos(pitch) * dist + jitter(),
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

  // Dopasowanie kadru: patrzymy, gdzie grupa wypadła na ekranie, i na następną klatkę
  // płynnie odsuwamy/przybliżamy kamerę (fit) oraz przesuwamy cel (fitZ), żeby wszyscy
  // mieścili się w FRAME. Nigdy bliżej niż ujęcie bazowe.
  const seen = packOnScreen(target.pack);
  const s = dt / 1000;
  const fill = Math.max((seen.maxY - seen.minY) / (FRAME.top - FRAME.bottom), seen.maxX / FRAME.side);
  const err = fill - 0.85;
  cam.fit = clamp(cam.fit * Math.exp(clamp(err, -0.4, 1.5) * (err > 0.15 ? 5 : 2) * s), 1, 14);
  // Środek grupy na środku obszaru; za wysoko na ekranie = za daleko, więc cel do przodu (−z)
  const centerErr = (seen.minY + seen.maxY) / 2 - (FRAME.top + FRAME.bottom) / 2;
  cam.fitZ = clamp(cam.fitZ - clamp(centerErr, -1, 1) * dist * 0.9 * s, -TRACK_LEN * 0.3, TRACK_LEN * 0.3);
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

/* ----------------- Iskry, fale, fajerwerki, świece ----------------- */
// Iskry to punkty z kolorem w HDR (jaśniej niż biel), więc świecą w bloomie. Martwa iskra
// ma kolor 0: przy mieszaniu addytywnym jest niewidoczna, nie trzeba jej usuwać z bufora.
function buildSparks() {
  const pos = new Float32Array(SPARKS * 3).fill(-1000);
  const col = new Float32Array(SPARKS * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(geo, r3.mats.spark);
  points.frustumCulled = false;
  r3.scene.add(points);
  r3.sparks = {
    geo, pos, col, next: 0, activeUntil: 0,
    vel: new Float32Array(SPARKS * 3),
    base: new Float32Array(SPARKS * 3),
    life: new Float32Array(SPARKS),
    max: new Float32Array(SPARKS),
    grav: new Float32Array(SPARKS),
  };
  r3.rockets = [];
  GOLD = new THREE.Color(0xf0c75e);
}

function spark(x, y, z, vx, vy, vz, color, life, grav = -2) {
  if (reduced()) return;
  const S = r3.sparks;
  const i = S.next;
  S.next = (S.next + 1) % SPARKS;
  const j = i * 3;
  S.pos[j] = x; S.pos[j + 1] = y; S.pos[j + 2] = z;
  S.vel[j] = vx; S.vel[j + 1] = vy; S.vel[j + 2] = vz;
  S.base[j] = color.r; S.base[j + 1] = color.g; S.base[j + 2] = color.b;
  S.life[i] = S.max[i] = life;
  S.grav[i] = grav;
  S.activeUntil = performance.now() + life * 1000 + 100;
}

function updateSparks(dt) {
  const S = r3.sparks;
  if (performance.now() > S.activeUntil) return;
  const s = dt / 1000;
  const drag = Math.exp(-1.8 * s);
  const bright = r3.theme.spark;
  for (let i = 0; i < SPARKS; i++) {
    if (S.life[i] <= 0) continue;
    const j = i * 3;
    S.life[i] -= s;
    if (S.life[i] <= 0) {
      S.col[j] = S.col[j + 1] = S.col[j + 2] = 0;
      S.pos[j + 1] = -1000;
      continue;
    }
    S.vel[j + 1] += S.grav[i] * s;
    for (let a = 0; a < 3; a++) {
      S.vel[j + a] *= drag;
      S.pos[j + a] += S.vel[j + a] * s;
    }
    const fade = (S.life[i] / S.max[i]) ** 1.3 * bright;
    S.col[j] = S.base[j] * fade;
    S.col[j + 1] = S.base[j + 1] * fade;
    S.col[j + 2] = S.base[j + 2] * fade;
  }
  S.geo.attributes.position.needsUpdate = true;
  S.geo.attributes.color.needsUpdate = true;
}

function buildRings() {
  r3.rings = Array.from({ length: RINGS }, () => {
    const mesh = new THREE.Mesh(r3.geo.decal, keep(r3.mats.ring.clone()));
    mesh.visible = false;
    mesh.position.y = 0.05;
    r3.scene.add(mesh);
    return { mesh, age: Infinity };
  });
  r3.nextRing = 0;
}

// Fala światła rozchodząca się po dywanie
function ring(x, z, color) {
  if (reduced()) return;
  const r = r3.rings[r3.nextRing];
  r3.nextRing = (r3.nextRing + 1) % RINGS;
  r.age = 0;
  r.mesh.position.x = x;
  r.mesh.position.z = z;
  r.mesh.material.color.set(color).multiplyScalar(1.6);
  r.mesh.visible = true;
}

function updateRings(dt) {
  for (const r of r3.rings) {
    if (!r.mesh.visible) continue;
    r.age += dt / 1000;
    const t = r.age / 1.1;
    if (t >= 1) {
      r.mesh.visible = false;
      continue;
    }
    const size = 1 + (1 - (1 - t) ** 3) * 7;
    r.mesh.scale.set(size, 1, size);
    r.mesh.material.opacity = (1 - t) ** 1.5;
  }
}

// Rakieta leci w górę zostawiając smugę, po czasie rozpryskuje się kulą iskier
function updateRockets(dt) {
  if (!r3.rockets.length) return;
  const s = dt / 1000;
  const trail = r3.tmpColor.setRGB(2.5, 1.9, 1.2);
  r3.rockets = r3.rockets.filter(rk => {
    if (rk.delay > 0) {
      rk.delay -= s;
      return true;
    }
    rk.vy -= 4 * s;
    rk.y += rk.vy * s;
    rk.fuse -= s;
    if (Math.random() < 0.5) spark(rk.x + rand(-0.05, 0.05), rk.y, rk.z, rand(-0.3, 0.3), -1, rand(-0.3, 0.3), trail, rand(0.3, 0.5), -3);
    if (rk.fuse > 0) return true;
    const color = rk.color.clone().multiplyScalar(4);
    for (let i = 0; i < 100; i++) {
      // Równomiernie po sferze
      const u = rand(-1, 1);
      const a = rand(0, Math.PI * 2);
      const v = rand(4, 6.5);
      const rxy = Math.sqrt(1 - u * u);
      spark(rk.x, rk.y, rk.z, Math.cos(a) * rxy * v, u * v, Math.sin(a) * rxy * v, color, rand(1.1, 1.8), -3.5);
    }
    return false;
  });
}

function updateCandles(now) {
  const C = world.candles;
  const d = r3.dummy;
  const t = now / 1000;
  const bright = r3.theme.lampBoost * 0.85;
  C.items.forEach((c, i) => {
    const y = c.y + Math.sin(t * 0.9 + c.seed) * c.bob;
    d.position.set(c.x, y, c.z);
    d.rotation.set(0, 0, 0);
    d.scale.set(0.11, c.h, 0.11);
    d.updateMatrix();
    C.bodies.setMatrixAt(i, d.matrix);
    const j = i * 3;
    C.pos[j] = c.x;
    C.pos[j + 1] = y + c.h / 2 + 0.16;
    C.pos[j + 2] = c.z;
    // Migotanie: dwie sinusoidy o różnych częstotliwościach udają nierówny płomień
    const flicker = 0.82 + 0.12 * Math.sin(t * 11 + c.seed) + 0.06 * Math.sin(t * 23 + c.seed * 3);
    C.col[j] = 1 * bright * flicker;
    C.col[j + 1] = 0.72 * bright * flicker;
    C.col[j + 2] = 0.38 * bright * flicker;
  });
  C.bodies.instanceMatrix.needsUpdate = true;
  C.geo.attributes.position.needsUpdate = true;
  C.geo.attributes.color.needsUpdate = true;
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
// Punkt sceny → piksele nad canvasem; null, gdy za kamerą albo daleko poza kadrem
function toScreen(x, y, z) {
  const v = r3.tmpV.set(x, y, z).project(r3.camera);
  if (v.z > 1 || Math.abs(v.x) > 1.3 || Math.abs(v.y) > 1.3) return null;
  return { x: ((v.x + 1) / 2) * r3.size.w, y: ((1 - v.y) / 2) * r3.size.h };
}

function updateOverlay() {
  for (const r of world.racers) {
    const pt = toScreen(r.root.position.x, r.body.position.y + 0.95, r.z);
    r.tag.style.visibility = pt ? 'visible' : 'hidden';
    if (pt) r.tag.style.transform = `translate(${pt.x}px, ${pt.y}px) translate(-50%, -100%)`;
    const v = Math.round(r.v);
    if (r.shownV !== v) {
      r.shownV = v;
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

  const day = view.p >= 1 ? 'dziś' : formatDay(new Date(world.t));
  if (r3.dateDay.textContent !== day) r3.dateDay.textContent = day;
}
