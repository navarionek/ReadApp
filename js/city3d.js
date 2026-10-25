import { state } from './state.js';
import { compactNumber, formatDay, MONTHS_PL, seriesColors } from './stats.js';
import { currentYear, DAY_MS, el } from './ui.js';

/* ----------------- Miasto czytania (eksperyment, Three.js) ----------------- */
// Nocne miasto z tego roku: każde z Was ma swoją dzielnicę ułożoną jak kalendarz (kolumny to
// dni tygodnia, rzędy to kolejne tygodnie, w głąb płynie czas), a każdy dzień to budynek tym
// wyższy, im więcej stron tego dnia przeczytano. Dzień bez czytania = pusta działka.
// Strony książki rozkładamy równo na dni czytania: od daty rozpoczęcia, a bez niej od końca
// poprzedniej książki tej osoby (najwyżej 3 tygodnie wstecz). Nad budynkiem dnia, w którym
// książka się skończyła, unosi się jej okładka; rekordowy dzień każdej osoby ma snop światła.
// Kamera sama przelatuje nad miastem; palcem można ją obracać, dwoma palcami przesuwać i
// przybliżać, a po chwili bez dotyku wraca do przelotu. Stuknięcie w budynek = dzień i strony.
// Budynki to jedna siatka (InstancedMesh), okna, drony i światła rysują shadery: tani rysunek.

const CELL = 1.25;        // odstęp budynków (dzień)
const LOT = 0.92;         // szerokość budynku
const STREET = 2.6;       // aleja między dzielnicami
const MAX_H = 9;          // najwyższy budynek
const EMPTY_H = 0.12;     // pusta działka
const BACKFILL_DAYS = 21; // bez daty rozpoczęcia: najwyżej tyle dni czytania wstecz
const FLY_MS = 46000;     // przelot tam i z powrotem
const IDLE_MS = 8000;     // tyle bez dotyku i kamera wraca do przelotu
const DRONES = 70;
const ADDON_PATHS = [
  'three/addons/postprocessing/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js',
  'three/addons/postprocessing/UnrealBloomPass.js',
  'three/addons/postprocessing/OutputPass.js',
  'three/addons/controls/OrbitControls.js',
];
const BG = 0x04050c;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (dt, ms) => 1 - Math.exp(-dt / ms);
const firstName = name => (name || '?').split(' ')[0];
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const WEEKDAYS = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'];
const MONTHS_FULL = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];

let THREE = null;
let ADDONS = null;
let threeLoad = null;
let c3 = null;     // renderer, kamera, stała część sceny, HUD (raz)
let world = null;  // miasto dla bieżących danych
const coverTextures = new Map();

const view = { active: false, visible: false, full: false, t: 0, raf: null, last: 0 };

async function loadThree() {
  THREE = await import('three');
  try {
    ADDONS = Object.assign({}, ...(await Promise.all(ADDON_PATHS.map(path => import(path)))));
  } catch (err) {
    console.warn('three addons unavailable, city without bloom and touch controls:', err);
  }
}

/* ----------------- Wejście i wyjście z ekranu ----------------- */
export function showCity3d() {
  view.active = true;
  if (!state.hasData) return;
  ensureMounted().then(ok => {
    if (!ok || !view.active) return;
    syncData();
    updateLoop();
  });
}

export function hideCity3d() {
  view.active = false;
  if (view.full) toggleFull();
  hideTip();
  updateLoop();
}

function updateLoop() {
  if (!c3) return;
  const run = !!world && view.active && view.visible && document.visibilityState === 'visible';
  if (run && view.raf === null) {
    view.last = performance.now();
    view.raf = requestAnimationFrame(frame);
  } else if (!run && view.raf !== null) {
    cancelAnimationFrame(view.raf);
    view.raf = null;
  }
}

/* ----------------- Silnik, kamera, HUD (raz) ----------------- */
async function ensureMounted() {
  if (c3) return true;
  const host = document.getElementById('city3d');
  if (!host) return false;
  if (!threeLoad) {
    host.replaceChildren(el('div', { class: 'r3d-status', text: 'Ładowanie miasta…' }));
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
  if (c3) return true;  // drugie równoległe wywołanie

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.error('WebGL unavailable:', err);
    host.replaceChildren(el('div', { class: 'r3d-status', text: 'Ta przeglądarka nie obsługuje grafiki 3D (WebGL).' }));
    return false;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 20, 70);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 400);

  // Poświata okien (bloom); bez dodatków miasto też działa, tylko bez blasku
  let composer = null;
  if (ADDONS?.EffectComposer) {
    try {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2 });
      composer = new ADDONS.EffectComposer(renderer, target);
      composer.addPass(new ADDONS.RenderPass(scene, camera));
      composer.addPass(new ADDONS.UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.45, 0.7));
      composer.addPass(new ADDONS.OutputPass());
    } catch (err) {
      console.warn('bloom setup failed, city without it:', err);
      composer = null;
    }
  }
  const pixelRatio = Math.min(window.devicePixelRatio || 1, composer ? 1.25 : 1.5);
  renderer.setPixelRatio(pixelRatio);
  composer?.setPixelRatio(pixelRatio);

  const canvas = renderer.domElement;
  const legend = el('div', { class: 'city-legend' });
  const month = el('div', { class: 'city-month' });
  const tip = el('div', { class: 'city-tip', hidden: '' });
  const hint = el('div', { class: 'city-hint', text: 'Przeciągnij, żeby obrócić · dwa palce: przesuń i przybliż' });
  host.replaceChildren(canvas, legend, month, tip, hint);

  c3 = {
    renderer, composer, scene, camera, canvas, host, legend, month, tip, hint,
    uniforms: {
      uTime: { value: 0 },
      uFogColor: { value: new THREE.Color(BG) },
      uFogNear: { value: 20 },
      uFogFar: { value: 70 },
      uPixel: { value: 1 },
    },
    ray: new THREE.Raycaster(), pointer: new THREE.Vector2(),
    look: new THREE.Vector3(), autoPos: new THREE.Vector3(), autoLook: new THREE.Vector3(),
    quality: { sum: 0, n: 0, skip: 90, ratio: pixelRatio },
    size: { w: 1, h: 1 },
    manual: false, dragging: false, lastInput: 0, blend: 1,
  };
  buildShared();
  setupControls();

  new ResizeObserver(resize).observe(host);
  resize();
  new IntersectionObserver(entries => {
    view.visible = entries.some(e => e.isIntersecting);
    updateLoop();
  }, { threshold: 0.15 }).observe(host);
  document.addEventListener('visibilitychange', updateLoop);
  bindPointer();
  return true;
}

function resize() {
  const { host, renderer, composer, camera } = c3;
  const w = Math.max(1, host.clientWidth);
  const h = Math.max(1, host.clientHeight);
  c3.size = { w, h };
  renderer.setSize(w, h, false);
  composer?.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 64 : 50;  // pionowy telefon: szerszy kadr
  camera.updateProjectionMatrix();
  c3.uniforms.uPixel.value = renderer.getPixelRatio() * (h / 500);
}

// Jeden palec obraca, dwa przesuwają po ziemi i przybliżają (szczypanie). W karcie pionowe
// przeciągnięcie jednym palcem przewija stronę; na pełnym ekranie całym dotykiem steruje miasto.
function setupControls() {
  if (!ADDONS?.OrbitControls) return;
  const controls = new ADDONS.OrbitControls(c3.camera, c3.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI * 0.47;  // nie pod ziemię
  controls.minDistance = 3;
  controls.maxDistance = 140;
  controls.rotateSpeed = 0.7;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.addEventListener('start', () => {
    c3.manual = true;
    c3.dragging = true;
    c3.hint.classList.add('gone');
  });
  controls.addEventListener('end', () => {
    c3.dragging = false;
    c3.lastInput = performance.now();
  });
  c3.canvas.style.touchAction = 'pan-y';  // OrbitControls ustawia „none”, co blokuje przewijanie strony
  // Kółko myszy w karcie przewija stronę; przybliżanie kółkiem tylko na pełnym ekranie
  c3.host.addEventListener('wheel', e => {
    if (!view.full) e.stopPropagation();
  }, { capture: true });
  c3.controls = controls;
}

/* ----------------- Shadery ----------------- */
// Budynki: ciemna bryła, okna w kolorze osoby (część się pali, część mruga), świecąca
// krawędź dachu; mgła w kolorze nieba
const BUILDING_VERT = `
  varying vec3 vLocal;
  varying vec3 vNormalL;
  varying vec3 vColor;
  varying vec3 vWorld;
  varying float vH;
  varying float vSeed;
  void main() {
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vLocal = position;
    vNormalL = normal;
    vColor = instanceColor;
    vH = length(instanceMatrix[1].xyz);
    vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const BUILDING_FRAG = `
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vLocal;
  varying vec3 vNormalL;
  varying vec3 vColor;
  varying vec3 vWorld;
  varying float vH;
  varying float vSeed;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float tall = step(0.3, vH);  // pusta działka: bez okien
    vec3 col;
    if (vNormalL.y > 0.5) {
      vec2 r = abs(vLocal.xz) * 2.0;
      float edge = smoothstep(0.78, 0.98, max(r.x, r.y));
      col = vec3(0.025, 0.028, 0.05) + vColor * edge * mix(0.18, 1.2, tall);
    } else {
      float side = abs(vNormalL.x) > 0.5 ? 0.75 : 1.0;
      // Dół budynku ciemniejszy, góra łapie poświatę nieba
      col = mix(vec3(0.015, 0.017, 0.03), vec3(0.04, 0.045, 0.08), clamp(vLocal.y, 0.0, 1.0)) * side;
      float across = (abs(vNormalL.x) > 0.5 ? vLocal.z : vLocal.x) + 0.5;
      vec2 g = vec2(across * 2.0, vLocal.y * vH / 0.36);
      vec2 cell = floor(g);
      vec2 f = fract(g);
      float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
      float faceId = vNormalL.x * 3.0 + vNormalL.z * 7.0;
      float h = hash(cell + vec2(vSeed * 91.0, faceId));
      // Okna gasną i zapalają się powoli, każde w swoim rytmie
      float lit = step(0.55, fract(h + floor(uTime * 0.05 + h * 7.0) * 0.37));
      float flicker = 0.8 + 0.2 * sin(uTime * (1.0 + h * 2.0) + h * 40.0);
      vec3 warm = mix(vec3(1.0, 0.82, 0.55), vColor, 0.75 + 0.2 * hash(cell + 3.7));
      col += warm * win * lit * flicker * 1.15 * tall;
      col += vColor * smoothstep(0.93, 1.0, vLocal.y) * 0.6 * tall;
      // Neonowe pionowe krawędzie
      float corner = smoothstep(0.44, 0.5, abs(vLocal.x)) * smoothstep(0.44, 0.5, abs(vLocal.z));
      col += vColor * corner * 0.5 * tall;
    }
    float fog = smoothstep(uFogNear, uFogFar, distance(vWorld, cameraPosition));
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Aleje: asfalt, światła jadących aut w obie strony, przerywana linia
const ROAD_VERT = `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const ROAD_FRAG = `
  uniform float uTime;
  uniform float uLen;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vec3 col = vec3(0.02, 0.022, 0.04);
    float y = vUv.y * uLen;
    float laneA = smoothstep(0.08, 0.0, abs(vUv.x - 0.3));
    float laneB = smoothstep(0.08, 0.0, abs(vUv.x - 0.7));
    float carA = step(0.86, fract(y * 0.18 - uTime * 0.9));
    float carB = step(0.88, fract(y * 0.15 + uTime * 0.7 + 0.4));
    col += vec3(1.0, 0.85, 0.6) * laneA * carA * 1.6;
    col += vec3(1.0, 0.25, 0.2) * laneB * carB * 1.3;
    col += vec3(0.25, 0.3, 0.5) * smoothstep(0.03, 0.0, abs(vUv.x - 0.5)) * step(0.5, fract(y * 0.5)) * 0.4;
    float fog = smoothstep(uFogNear, uFogFar, distance(vWorld, cameraPosition));
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Kolorowa łuna na ziemi pod dzielnicą (miasto „świeci” na asfalt)
const GLOW_FRAG = `
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 d = abs(vUv - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.55, 1.0, d.x)) * (1.0 - smoothstep(0.85, 1.0, d.y));
    gl_FragColor = vec4(uColor * a * 0.16, 1.0);
  }
`;
const UV_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Snop światła z rekordowego dnia: gaśnie ku górze i pulsuje
const BEAM_FRAG = `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    // Jaśniejszy środek snopa, miękkie brzegi (vUv.x biegnie dookoła walca)
    float core = pow(abs(sin(vUv.x * 3.14159 * 2.0)), 3.0);
    float a = pow(1.0 - vUv.y, 2.2) * (0.22 + 0.1 * sin(uTime * 2.0)) * (0.35 + 0.65 * core);
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

// Punkty świetlne: drony nad alejami i migające światła na dachach. Pozycje liczy shader,
// więc animacja nic nie kosztuje procesora.
const DRONE_VERT = `
  uniform float uTime;
  uniform float uPixel;
  uniform float uLen;
  uniform float uZ0;
  uniform float uFogNear;
  uniform float uFogFar;
  attribute vec4 aDrone;   // x, wysokość, prędkość, faza
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    float z = uZ0 - mod(aDrone.w + uTime * aDrone.z, uLen);
    float y = aDrone.y + 0.3 * sin(uTime * 1.3 + aDrone.w);
    vec4 mv = modelViewMatrix * vec4(aDrone.x, y, z, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = 9.0 * uPixel * (12.0 / max(1.0, -mv.z));
    vColor = aColor;
    vFade = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
  }
`;
const BEACON_VERT = `
  uniform float uTime;
  uniform float uPixel;
  uniform float uFogNear;
  uniform float uFogFar;
  attribute float aPhase;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float blink = step(0.82, fract(uTime * 0.45 + aPhase));
    gl_PointSize = (5.0 + 9.0 * blink) * uPixel * (12.0 / max(1.0, -mv.z));
    vColor = vec3(1.0, 0.15, 0.1) * (0.35 + 1.6 * blink);
    vFade = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
  }
`;
const POINT_FRAG = `
  varying vec3 vColor;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - d), 2.2);
    gl_FragColor = vec4(vColor * a * vFade, 1.0);
  }
`;

function additive(uniforms, vertexShader, fragmentShader) {
  return new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

function buildShared() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);  // podstawa na ziemi, skala y = wysokość
  c3.box = box;
  c3.buildingMat = new THREE.ShaderMaterial({ uniforms: c3.uniforms, vertexShader: BUILDING_VERT, fragmentShader: BUILDING_FRAG });

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshBasicMaterial({ color: 0x06070f }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  c3.scene.add(ground);

  // Niebo jedzie razem z kamerą: gwiazdy i księżyc z poświatą
  const sky = new THREE.Group();
  const n = 600;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const up = 0.12 + Math.random() * 0.88;
    const r = 200;
    const flat = Math.sqrt(1 - up * up);
    pos[i * 3] = Math.cos(a) * r * flat;
    pos[i * 3 + 1] = up * r * 0.6;
    pos[i * 3 + 2] = Math.sin(a) * r * flat;
  }
  const stars = new THREE.BufferGeometry();
  stars.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sky.add(new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xaab8ff, size: 1.4, sizeAttenuation: false, fog: false })));
  const moonCv = document.createElement('canvas');
  moonCv.width = moonCv.height = 256;
  const g = moonCv.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255, 250, 235, 1)');
  grad.addColorStop(0.16, 'rgba(240, 236, 220, 1)');
  grad.addColorStop(0.2, 'rgba(170, 190, 255, 0.35)');
  grad.addColorStop(1, 'rgba(120, 140, 255, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const moonTex = new THREE.CanvasTexture(moonCv);
  moonTex.colorSpace = THREE.SRGBColorSpace;
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, fog: false, depthWrite: false, transparent: true }));
  moon.scale.set(55, 55, 1);
  moon.position.set(-60, 85, -150);
  sky.add(moon);
  c3.scene.add(sky);
  c3.sky = sky;
}

/* ----------------- Dane: strony dzień po dniu ----------------- */
function neonColor(color) {
  const match = /^var\((--[\w-]+)\)$/.exec(color || '');
  const value = (match ? getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() : color) || '#5b8cff';
  const c = new THREE.Color();
  try {
    c.setStyle(value);
  } catch {
    c.set(0x5b8cff);
  }
  const hsl = {};
  c.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, 0.9, 0.6);
}

function dailyPages(readers, rows, t0, days) {
  const perReader = new Map(readers.map(r => [r.key, new Float32Array(days)]));
  const dayOf = t => Math.floor((t - t0) / DAY_MS);
  const byReader = new Map();
  rows.forEach(row => {
    if (!byReader.has(row.user_id)) byReader.set(row.user_id, []);
    byReader.get(row.user_id).push(row);
  });
  byReader.forEach((list, key) => {
    const arr = perReader.get(key);
    if (!arr) return;
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    let prevEnd = -1;
    list.forEach(row => {
      const end = clamp(dayOf(new Date(row.created_at).getTime()), 0, days - 1);
      let start = row.started_at
        ? dayOf(Math.max(t0, new Date(row.started_at).getTime()))
        : Math.max(prevEnd + 1, end - BACKFILL_DAYS + 1);
      start = clamp(Math.min(start, end), 0, end);
      const pages = Number(row.pages) || 0;
      const each = pages / (end - start + 1);
      for (let d = start; d <= end; d++) arr[d] += each;
      prevEnd = Math.max(prevEnd, end);
    });
  });
  return perReader;
}

function syncData() {
  const readers = [...state.statsReaders].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const rows = state.statsRows;
  const sig = [currentYear(), new Date().toDateString(), ...rows.map(r => `${r.id}:${r.pages}:${r.created_at}:${r.started_at}:${r.cover_url || ''}`), ...readers.map(r => `${r.key}:${r.color}`)].join('|');
  if (world?.sig === sig) return;
  buildWorld(readers, rows, sig);
}

function disposeWorld() {
  world.group.removeFromParent();
  world.group.traverse(obj => {
    if (obj.isInstancedMesh) obj.dispose();
    // Sprite'y dzielą jedną geometrię w three.js (też księżyc), więc jej nie zwalniamy
    if (obj.geometry && obj.geometry !== c3.box && !obj.isSprite) obj.geometry.dispose();
    const mats = obj.material ? [].concat(obj.material) : [];
    mats.forEach(mat => {
      if (mat === c3.buildingMat) return;
      if (mat.map && !mat.map.userData.cover) mat.map.dispose();  // okładki zostają w pamięci podręcznej
      mat.dispose();
    });
  });
}

function buildWorld(readers, rows, sig) {
  if (world) disposeWorld();
  const t0 = new Date(currentYear(), 0, 1).getTime();
  const days = Math.max(1, Math.floor((Date.now() - t0) / DAY_MS) + 1);
  const pages = dailyPages(readers, rows, t0, days);
  const colors = seriesColors(readers);
  const jan1 = (new Date(t0).getDay() + 6) % 7;  // poniedziałek = 0
  const weeks = Math.floor((days - 1 + jan1) / 7) + 1;
  const districtW = 7 * CELL;
  const totalW = readers.length * districtW + Math.max(0, readers.length - 1) * STREET;
  const depth = weeks * CELL;
  let maxPages = 1;
  pages.forEach(arr => arr.forEach(v => { maxPages = Math.max(maxPages, v); }));
  const cellPos = d => {
    const idx = d + jan1;
    return { dx: (idx % 7) * CELL + CELL / 2, z: -Math.floor(idx / 7) * CELL - CELL / 2 };
  };
  const heightOf = v => (v > 0.5 ? 0.45 + (MAX_H - 0.45) * Math.sqrt(v / maxPages) : EMPTY_H);

  const group = new THREE.Group();
  const mesh = new THREE.InstancedMesh(c3.box, c3.buildingMat, Math.max(1, readers.length * days));
  const info = [];
  const m = new THREE.Matrix4();
  const people = readers.map((r, i) => ({ key: r.key, name: firstName(r.name), color: neonColor(colors.get(r.key)), x0: -totalW / 2 + i * (districtW + STREET), total: 0, best: -1, bestV: 0 }));
  const beacons = [];
  let k = 0;
  people.forEach(p => {
    const arr = pages.get(p.key);
    for (let d = 0; d < days; d++) {
      const v = arr[d];
      p.total += v;
      if (v > p.bestV) {
        p.bestV = v;
        p.best = d;
      }
      const { dx, z } = cellPos(d);
      // Pierwiastek: kilka bardzo długich dni nie spłaszcza całej reszty miasta
      const h = heightOf(v);
      m.makeScale(LOT, h, LOT).setPosition(p.x0 + dx, 0, z);
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, p.color);
      info.push({ person: p, day: d, pages: v });
      if (h > MAX_H * 0.5) beacons.push(p.x0 + dx, h + 0.12, z);
      k++;
    }
  });
  if (!k) {
    // Nikt jeszcze nic nie przeczytał: jedna niewidoczna instancja (shader potrzebuje koloru)
    mesh.setMatrixAt(0, m.makeScale(0, 0, 0));
    mesh.setColorAt(0, new THREE.Color());
    k = 1;
  }
  mesh.count = k;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);

  // Łuna pod każdą dzielnicą
  people.forEach(p => {
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(districtW + 2.5, depth + 4), additive({ uColor: { value: p.color } }, UV_VERT, GLOW_FRAG));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(p.x0 + districtW / 2, 0.002, -depth / 2);
    group.add(glow);
  });

  // Aleje między dzielnicami i po bokach miasta
  const roadLen = depth + 40;
  const lanes = [];
  for (let i = 0; i <= readers.length; i++) {
    const w = i === 0 || i === readers.length ? STREET * 0.8 : STREET;
    const x = i === 0 ? -totalW / 2 - w / 2 : i === readers.length ? totalW / 2 + w / 2 : -totalW / 2 + i * districtW + (i - 0.5) * STREET;
    lanes.push(x);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...c3.uniforms, uLen: { value: roadLen } },
      vertexShader: ROAD_VERT,
      fragmentShader: ROAD_FRAG,
    });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, roadLen), mat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(x, 0.005, -depth / 2 + 10);
    group.add(road);
  }

  // Drony: świecące punkty sunące nad alejami (i trochę nad dachami) w obie strony
  const droneData = new Float32Array(DRONES * 4);
  const droneColor = new Float32Array(DRONES * 3);
  const white = new THREE.Color(1, 0.9, 0.75);
  for (let i = 0; i < DRONES; i++) {
    const overRoad = Math.random() < 0.7 || !people.length;
    const x = overRoad ? lanes[i % lanes.length] + (Math.random() - 0.5) * 1.2 : people[i % people.length].x0 + Math.random() * districtW;
    const dir = Math.random() < 0.5 ? -1 : 1;
    droneData.set([x, 2.5 + Math.random() * (MAX_H + 2), dir * (1.5 + Math.random() * 3.5), Math.random() * roadLen], i * 4);
    const c = !overRoad || Math.random() < 0.35 ? people[i % Math.max(1, people.length)]?.color || white : white;
    droneColor.set([c.r * 1.6, c.g * 1.6, c.b * 1.6], i * 3);
  }
  const droneGeo = new THREE.BufferGeometry();
  droneGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DRONES * 3), 3));
  droneGeo.setAttribute('aDrone', new THREE.BufferAttribute(droneData, 4));
  droneGeo.setAttribute('aColor', new THREE.BufferAttribute(droneColor, 3));
  const drones = new THREE.Points(droneGeo, additive({ ...c3.uniforms, uLen: { value: roadLen }, uZ0: { value: 15 } }, DRONE_VERT, POINT_FRAG));
  drones.frustumCulled = false;
  group.add(drones);

  // Migające czerwone światła na najwyższych dachach
  if (beacons.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(beacons), 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(Float32Array.from({ length: beacons.length / 3 }, () => Math.random()), 1));
    const lights = new THREE.Points(geo, additive(c3.uniforms, BEACON_VERT, POINT_FRAG));
    lights.frustumCulled = false;
    group.add(lights);
  }

  // Snop światła nad rekordowym dniem każdej osoby
  people.forEach(p => {
    if (p.best < 0) return;
    const { dx, z } = cellPos(p.best);
    const h = heightOf(p.bestV);
    const beamGeo = new THREE.CylinderGeometry(0.22, 0.6, 45, 20, 1, true);
    beamGeo.translate(0, 22.5, 0);
    const beam = new THREE.Mesh(beamGeo, additive({ uColor: { value: p.color }, uTime: c3.uniforms.uTime }, UV_VERT, BEAM_FRAG));
    beam.material.side = THREE.DoubleSide;
    beam.position.set(p.x0 + dx, h, z);
    group.add(beam);
  });

  // Okładki skończonych książek unoszą się nad budynkiem dnia, w którym je skończono,
  // przyczepione cienką nitką światła do dachu
  const byKey = new Map(people.map(p => [p.key, p]));
  const covers = [];
  const threads = [];
  rows.forEach(row => {
    const p = byKey.get(row.user_id);
    if (!p || !row.cover_url) return;
    const d = clamp(Math.floor((new Date(row.created_at).getTime() - t0) / DAY_MS), 0, days - 1);
    const { dx, z } = cellPos(d);
    const roof = heightOf(pages.get(p.key)[d]);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xdddddd, transparent: true, opacity: 0 }));
    sprite.scale.set(0.95, 1.42, 1);
    const y = roof + 1.5 + (covers.length % 3) * 0.25;
    sprite.position.set(p.x0 + dx, y, z);
    sprite.userData.baseY = y;
    sprite.userData.phase = Math.random() * 6;
    group.add(sprite);
    covers.push(sprite);
    threads.push(p.x0 + dx, roof, z, p.x0 + dx, y - 0.6, z);
    loadCover(row.cover_url).then(tex => {
      if (!tex || !sprite.parent) return;
      sprite.material.map = tex;
      sprite.material.needsUpdate = true;
      sprite.userData.ready = true;
    });
  });
  if (threads.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(threads), 3));
    group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x8899ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
  }

  // Dzisiejszy rząd: świecąca linia przez całe miasto i napis
  const today = cellPos(days - 1).z;
  const line = new THREE.Mesh(new THREE.PlaneGeometry(totalW + 2 * STREET, 0.18), new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  line.rotation.x = -Math.PI / 2;
  line.position.set(0, 0.03, today - CELL / 2 - 0.1);
  group.add(line);
  const todayLabel = textSprite('DZIŚ', 'rgba(200, 215, 255, 0.95)');
  todayLabel.position.set(totalW / 2 + STREET * 0.8 + 1.6, 1, today);
  group.add(todayLabel);

  // Nazwy miesięcy przy lewej krawędzi, na wysokości pierwszego tygodnia miesiąca
  for (let mo = 0; mo <= new Date().getMonth(); mo++) {
    const d = Math.floor((new Date(currentYear(), mo, 1).getTime() - t0) / DAY_MS);
    const sprite = textSprite(MONTHS_PL[mo].toUpperCase());
    sprite.position.set(-totalW / 2 - STREET * 0.8 - 1.6, 0.9, cellPos(d).z);
    group.add(sprite);
  }

  c3.scene.add(group);
  world = { sig, group, mesh, info, people, covers, depth, totalW, t0, jan1 };
  renderLegend();
}

function loadCover(url) {
  if (!coverTextures.has(url)) {
    coverTextures.set(url, new Promise(resolve => {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      loader.load(url, tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.userData.cover = true;
        resolve(tex);
      }, undefined, () => resolve(null));
    }));
  }
  return coverTextures.get(url);
}

function textSprite(text, color = 'rgba(190, 205, 255, 0.85)') {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 96;
  const g = cv.getContext('2d');
  g.font = '700 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 128, 50);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2.6, 0.98, 1);
  return sprite;
}

function renderLegend() {
  c3.legend.replaceChildren(...world.people.map(p => {
    const row = el('span', { class: 'city-person' }, [el('i'), el('b', { text: p.name }), el('span', { text: `${compactNumber(Math.round(p.total))} str.` })]);
    row.style.setProperty('--c', `#${p.color.getHexString()}`);
    return row;
  }));
}

/* ----------------- Klatka ----------------- */
// Przelot: tam i z powrotem po kosinusie, płynne zawracanie na końcach
function autopilot() {
  const p = reduced() ? 0.5 : (1 - Math.cos((view.t / FLY_MS) * Math.PI * 2)) / 2;
  const s = view.t / 1000;
  const wide = clamp(world.totalW / 22, 1, 2.2) * (c3.size.w / c3.size.h < 1 ? 1.35 : 1);
  const focusZ = -p * Math.max(0, world.depth - 4) - 2;
  c3.autoPos.set(Math.sin(s * 0.11) * world.totalW * 0.28, (10 + 2.5 * Math.sin(s * 0.17)) * wide, focusZ + 13 * wide);
  c3.autoLook.set(Math.sin(s * 0.11 + 0.6) * world.totalW * 0.12, 1.5, focusZ - 7);
}

function frame(now) {
  view.raf = requestAnimationFrame(frame);
  const dt = Math.min(50, now - view.last);
  adaptQuality(now - view.last);
  view.last = now;
  const time = (c3.uniforms.uTime.value += dt / 1000);
  const cam = c3.camera;
  const controls = c3.controls;

  // Po chwili bez dotyku kamera płynnie wraca do przelotu
  if (c3.manual && !c3.dragging && now - c3.lastInput > IDLE_MS) {
    c3.manual = false;
    c3.blend = 0;
  }
  if (!c3.manual) {
    view.t += dt;
    autopilot();
    if (c3.blend < 1) {
      c3.blend = Math.min(1, c3.blend + dt / 2500);
      const k = ease(dt, 500);
      cam.position.lerp(c3.autoPos, k);
      c3.look.lerp(c3.autoLook, k);
    } else {
      cam.position.copy(c3.autoPos);
      c3.look.copy(c3.autoLook);
    }
    cam.lookAt(c3.look);
    controls?.target.copy(c3.look);
  } else if (controls) {
    // Przesuwanie nie wyjedzie poza miasto
    const t = controls.target;
    t.x = clamp(t.x, -world.totalW / 2 - 6, world.totalW / 2 + 6);
    t.z = clamp(t.z, -world.depth - 6, 8);
    t.y = clamp(t.y, 0, 6);
    controls.update();
    c3.look.copy(t);
  }
  c3.sky.position.copy(cam.position);

  // Mgła rośnie z odległością od tego, na co patrzymy
  const dist = cam.position.distanceTo(c3.look);
  const near = Math.max(18, dist * 0.9);
  const far = near + Math.max(45, dist * 2.2);
  c3.uniforms.uFogNear.value = near;
  c3.uniforms.uFogFar.value = far;
  c3.scene.fog.near = near;
  c3.scene.fog.far = far;

  // Okładki: kołyszą się i pojawiają, gdy tekstura już jest
  world.covers.forEach(sp => {
    sp.position.y = sp.userData.baseY + Math.sin(time * 0.9 + sp.userData.phase) * 0.12;
    if (sp.userData.ready && sp.material.opacity < 1) sp.material.opacity = Math.min(1, sp.material.opacity + dt / 600);
  });

  // Miesiąc pod kamerą
  const week = Math.max(0, Math.floor(-c3.look.z / CELL));
  const mo = new Date(world.t0 + clamp(week * 7 - world.jan1, 0, 365) * DAY_MS).getMonth();
  if (c3.monthIdx !== mo) {
    c3.monthIdx = mo;
    c3.month.textContent = MONTHS_FULL[mo];
  }

  if (c3.composer) c3.composer.render();
  else c3.renderer.render(c3.scene, cam);
}

// Gdy klatki przez dłuższą chwilę są wolne, zmniejszamy rozdzielczość
function adaptQuality(dt) {
  const q = c3.quality;
  if (q.skip > 0) {
    q.skip--;
    return;
  }
  if (dt > 250) return;
  q.sum += dt;
  q.n++;
  if (q.sum < 2000) return;
  const avg = q.sum / q.n;
  q.sum = 0;
  q.n = 0;
  if (avg > 24 && q.ratio > 0.75) {
    q.ratio = Math.max(0.75, q.ratio - 0.25);
    c3.renderer.setPixelRatio(q.ratio);
    c3.composer?.setPixelRatio(q.ratio);
    resize();
    q.skip = 60;
  }
}

/* ----------------- Dotyk: dzień i strony, pełny ekran ----------------- */
function bindPointer() {
  let down = null;
  c3.canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  c3.canvas.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
    pick(e);
  });
  c3.canvas.addEventListener('dblclick', toggleFull);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && view.full) toggleFull();
  });
}

function pick(e) {
  if (!world) return;
  const rect = c3.canvas.getBoundingClientRect();
  c3.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  c3.ray.setFromCamera(c3.pointer, c3.camera);
  const hit = c3.ray.intersectObject(world.mesh, false)[0];
  if (!hit || hit.instanceId == null) {
    hideTip();
    return;
  }
  const { person, day, pages } = world.info[hit.instanceId];
  const date = new Date(world.t0 + day * DAY_MS);
  const what = pages > 0.5 ? `${Math.round(pages)} str.` : 'bez czytania';
  c3.tip.replaceChildren(el('b', { text: person.name }), el('span', { text: `${WEEKDAYS[date.getDay()]}, ${formatDay(date)} · ${what}` }));
  c3.tip.style.setProperty('--c', `#${person.color.getHexString()}`);
  c3.tip.style.left = `${clamp(e.clientX - rect.left, 70, rect.width - 70)}px`;
  c3.tip.style.top = `${Math.max(40, e.clientY - rect.top - 14)}px`;
  c3.tip.hidden = false;
  clearTimeout(c3.tipTimer);
  c3.tipTimer = setTimeout(hideTip, 3500);
}

function hideTip() {
  if (c3) c3.tip.hidden = true;
}

function toggleFull() {
  view.full = !view.full;
  c3.host.classList.toggle('city-full', view.full);
  document.body.classList.toggle('r3d-lock', view.full);
  // Na pełnym ekranie cały dotyk steruje miastem (w karcie pion przewija stronę)
  c3.canvas.style.touchAction = view.full ? 'none' : 'pan-y';
}
