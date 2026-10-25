import { state } from './state.js';
import { compactNumber, formatDay, MONTHS_PL, seriesColors } from './stats.js';
import { currentYear, DAY_MS, el } from './ui.js';

/* ----------------- Miasto czytania (eksperyment, Three.js) ----------------- */
// Nocne miasto z tego roku: każde z Was ma swoją dzielnicę ułożoną jak kalendarz (kolumny to
// dni tygodnia, rzędy to kolejne tygodnie, w głąb płynie czas), a każdy dzień to budynek tym
// wyższy, im więcej stron tego dnia przeczytano. Dzień bez czytania = pusta działka.
// Strony książki rozkładamy równo na dni czytania: od daty rozpoczęcia, a bez niej od końca
// poprzedniej książki tej osoby (najwyżej 3 tygodnie wstecz). Kamera sama przelatuje nad
// miastem od stycznia do dziś i z powrotem; stuknięcie w budynek pokazuje dzień i strony.
// Wszystkie budynki to jedna siatka (InstancedMesh), okna rysuje shader, więc to tani rysunek.

const CELL = 1.25;        // odstęp budynków (dzień)
const LOT = 0.92;         // szerokość budynku
const STREET = 2.6;       // aleja między dzielnicami
const MAX_H = 9;          // najwyższy budynek
const EMPTY_H = 0.12;     // pusta działka
const BACKFILL_DAYS = 21; // bez daty rozpoczęcia: najwyżej tyle dni czytania wstecz
const FLY_MS = 46000;     // tam i z powrotem
const ADDON_PATHS = [
  'three/addons/postprocessing/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js',
  'three/addons/postprocessing/UnrealBloomPass.js',
  'three/addons/postprocessing/OutputPass.js',
];
const BG = 0x04050c;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const firstName = name => (name || '?').split(' ')[0];
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const WEEKDAYS = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'];
const MONTHS_FULL = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];

let THREE = null;
let ADDONS = null;
let threeLoad = null;
let c3 = null;     // renderer, kamera, stała część sceny, HUD (raz)
let world = null;  // budynki dla bieżących danych

const view = { active: false, visible: false, full: false, t: 0, raf: null, last: 0 };

async function loadThree() {
  THREE = await import('three');
  try {
    ADDONS = Object.assign({}, ...(await Promise.all(ADDON_PATHS.map(path => import(path)))));
  } catch (err) {
    console.warn('three addons unavailable, city without bloom:', err);
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
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 300);

  // Poświata okien (bloom); bez dodatków miasto też działa, tylko bez blasku
  let composer = null;
  if (ADDONS) {
    try {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2 });
      composer = new ADDONS.EffectComposer(renderer, target);
      composer.addPass(new ADDONS.RenderPass(scene, camera));
      composer.addPass(new ADDONS.UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.72));
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
  host.replaceChildren(canvas, legend, month, tip);

  c3 = {
    renderer, composer, scene, camera, canvas, host, legend, month, tip,
    uniforms: { uTime: { value: 0 }, uFogColor: { value: new THREE.Color(BG) }, uFogNear: { value: 20 }, uFogFar: { value: 70 } },
    ray: new THREE.Raycaster(), pointer: new THREE.Vector2(), look: new THREE.Vector3(),
    quality: { sum: 0, n: 0, skip: 90, ratio: pixelRatio },
    size: { w: 1, h: 1 },
  };
  buildShared();

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
}

// Shader budynków: ciemna bryła, okna w kolorze osoby (część się pali, część mruga),
// świecąca krawędź dachu; mgła w kolorze nieba
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
      // Dach: ciemny, z neonową obwódką (na pustej działce słabą)
      vec2 r = abs(vLocal.xz) * 2.0;
      float edge = smoothstep(0.78, 0.98, max(r.x, r.y));
      col = vec3(0.025, 0.028, 0.05) + vColor * edge * mix(0.18, 1.2, tall);
    } else {
      float side = abs(vNormalL.x) > 0.5 ? 0.75 : 1.0;
      col = vec3(0.03, 0.035, 0.06) * side;
      // Okna: piętra co 0,36, dwa na ścianę
      float across = (abs(vNormalL.x) > 0.5 ? vLocal.z : vLocal.x) + 0.5;
      vec2 g = vec2(across * 2.0, vLocal.y * vH / 0.36);
      vec2 cell = floor(g);
      vec2 f = fract(g);
      float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
      float faceId = vNormalL.x * 3.0 + vNormalL.z * 7.0;
      float h = hash(cell + vec2(vSeed * 91.0, faceId));
      float lit = step(0.55, h);
      float flicker = 0.8 + 0.2 * sin(uTime * (1.0 + h * 2.0) + h * 40.0);
      vec3 warm = mix(vec3(1.0, 0.82, 0.55), vColor, 0.75 + 0.2 * hash(cell + 3.7));
      col += warm * win * lit * flicker * 1.15 * tall;
      // Pas światła pod dachem
      col += vColor * smoothstep(0.93, 1.0, vLocal.y) * 0.6 * tall;
    }
    float fog = smoothstep(uFogNear, uFogFar, distance(vWorld, cameraPosition));
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Aleje między dzielnicami: ciemny asfalt, światła jadących aut w obie strony
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

function buildShared() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);  // podstawa na ziemi, skala y = wysokość
  c3.box = box;
  c3.buildingMat = new THREE.ShaderMaterial({ uniforms: c3.uniforms, vertexShader: BUILDING_VERT, fragmentShader: BUILDING_FRAG });

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: 0x06070f }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  c3.scene.add(ground);

  // Gwiazdy nad miastem
  const n = 500;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const up = 0.15 + Math.random() * 0.85;
    const r = 160;
    pos[i * 3] = Math.cos(a) * r * Math.sqrt(1 - up * up);
    pos[i * 3 + 1] = up * r * 0.6;
    pos[i * 3 + 2] = Math.sin(a) * r * Math.sqrt(1 - up * up);
  }
  const stars = new THREE.BufferGeometry();
  stars.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  c3.stars = new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xaab8ff, size: 1.4, sizeAttenuation: false, fog: false }));
  c3.scene.add(c3.stars);
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
  const sig = [currentYear(), new Date().toDateString(), ...rows.map(r => `${r.id}:${r.pages}:${r.created_at}:${r.started_at}`), ...readers.map(r => `${r.key}:${r.color}`)].join('|');
  if (world?.sig === sig) return;
  buildWorld(readers, rows, sig);
}

function buildWorld(readers, rows, sig) {
  if (world) {
    world.group.removeFromParent();
    world.mesh.dispose();
    world.roads.forEach(r => r.material.dispose());
    world.labels.forEach(s => { s.material.map.dispose(); s.material.dispose(); });
  }
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

  const group = new THREE.Group();
  const count = Math.max(1, readers.length * days);
  const mesh = new THREE.InstancedMesh(c3.box, c3.buildingMat, count);
  const info = [];
  const m = new THREE.Matrix4();
  const people = readers.map((r, i) => ({ key: r.key, name: firstName(r.name), color: neonColor(colors.get(r.key)), x0: -totalW / 2 + i * (districtW + STREET), total: 0 }));
  let k = 0;
  people.forEach(p => {
    const arr = pages.get(p.key);
    for (let d = 0; d < days; d++) {
      const v = arr[d];
      p.total += v;
      const cellIdx = d + jan1;
      const x = p.x0 + (cellIdx % 7) * CELL + CELL / 2;
      const z = -Math.floor(cellIdx / 7) * CELL - CELL / 2;
      // Pierwiastek: kilka bardzo długich dni nie spłaszcza całej reszty miasta
      const h = v > 0.5 ? 0.45 + (MAX_H - 0.45) * Math.sqrt(v / maxPages) : EMPTY_H;
      m.makeScale(LOT, h, LOT).setPosition(x, 0, z);
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, p.color);
      info.push({ person: p, day: d, pages: v });
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

  // Aleje między dzielnicami i po bokach miasta
  const roads = [];
  const roadLen = depth + 40;
  for (let i = 0; i <= readers.length; i++) {
    const w = i === 0 || i === readers.length ? STREET * 0.8 : STREET;
    const x = i === 0 ? -totalW / 2 - w / 2 : i === readers.length ? totalW / 2 + w / 2 : -totalW / 2 + i * districtW + (i - 0.5) * STREET;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...c3.uniforms, uLen: { value: roadLen } },
      vertexShader: ROAD_VERT,
      fragmentShader: ROAD_FRAG,
    });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, roadLen), mat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(x, 0.005, -depth / 2 + 10);
    group.add(road);
    roads.push(road);
  }

  // Nazwy miesięcy przy lewej krawędzi, na wysokości pierwszego tygodnia miesiąca
  const labels = [];
  for (let mo = 0; mo <= new Date().getMonth(); mo++) {
    const d = Math.floor((new Date(currentYear(), mo, 1).getTime() - t0) / DAY_MS);
    const z = -Math.floor((d + jan1) / 7) * CELL - CELL / 2;
    const sprite = textSprite(MONTHS_PL[mo].toUpperCase());
    sprite.position.set(-totalW / 2 - STREET * 0.8 - 1.6, 0.9, z);
    group.add(sprite);
    labels.push(sprite);
  }

  c3.scene.add(group);
  world = { sig, group, mesh, roads, labels, info, people, depth, totalW, t0, jan1 };
  renderLegend();
}

function textSprite(text) {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 96;
  const g = cv.getContext('2d');
  g.font = '700 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(190, 205, 255, 0.85)';
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

/* ----------------- Klatka: przelot kamery ----------------- */
function frame(now) {
  view.raf = requestAnimationFrame(frame);
  const dt = Math.min(50, now - view.last);
  adaptQuality(now - view.last);
  view.last = now;
  view.t += dt;
  c3.uniforms.uTime.value = view.t / 1000;

  // Tam i z powrotem po kosinusie: płynne zawracanie na końcach, bez przeskoku
  const p = reduced() ? 0.5 : (1 - Math.cos((view.t / FLY_MS) * Math.PI * 2)) / 2;
  const s = view.t / 1000;
  const wide = clamp(world.totalW / 22, 1, 2.2) * (c3.size.w / c3.size.h < 1 ? 1.35 : 1);
  const focusZ = -p * Math.max(0, world.depth - 4) - 2;
  const cam = c3.camera;
  cam.position.set(Math.sin(s * 0.11) * world.totalW * 0.28, (10 + 2.5 * Math.sin(s * 0.17)) * wide, focusZ + 13 * wide);
  c3.look.set(Math.sin(s * 0.11 + 0.6) * world.totalW * 0.12, 1.5, focusZ - 7);
  cam.lookAt(c3.look);
  c3.uniforms.uFogNear.value = 24 * wide;
  c3.uniforms.uFogFar.value = 75 * wide;
  c3.stars.position.copy(cam.position);

  // Miesiąc pod kamerą
  const week = Math.max(0, Math.floor(-focusZ / CELL - 3));
  const mo = new Date(world.t0 + Math.max(0, week * 7 - world.jan1) * DAY_MS).getMonth();
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
}
