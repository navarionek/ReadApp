import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { state } from './state.js';
import { compactNumber, formatDay, seriesColors } from './stats.js';
import { currentYear, DAY_MS, el, icon, refreshIcons } from './ui.js';

/* ----------------- Wieże z książek (3D) ----------------- */
// Każda książka przeczytana w tym roku to płyta na stosie właściciela: grubość = punkty
// (najwyższa wieża = lider rankingu), na grzbiecie tytuł, na wierzchu okładka.
// Animacja przechodzi przez rok i zrzuca książki na stosy w dniu skończenia.
// Three.js z import mapy (index.html), jak w wyścigu 3D; moduł ładuje się raz dla obu kart.

const PLAY_MS = 12000;   // cały rok
const TOWER_H = 10;      // wysokość najwyższej wieży (jednostki sceny)
const BOOK_L = 2.4;      // długość książki (wzdłuż grzbietu, oś x)
const BOOK_W = 1.7;      // szerokość okładki (oś z)
const GAP = 3.6;         // odstęp między wieżami
const FALL_S = 0.7;      // czas spadania (z przyspieszeniem, jak przy grawitacji)
const SETTLE_S = 0.45;   // klapnięcie na płasko po dotknięciu stosu
const DROP_FROM = 4.5;   // z jakiej wysokości nad stosem spada książka
const DUST = 220;        // pula drobinek kurzu przy lądowaniu
const COVER_UPRIGHT = -Math.PI / 2;  // obrót w płaszczyźnie, przy którym okładka w locie stoi tytułem do góry
const OUT = 1.1;         // o ile wysuwa się stuknięta książka
const PITCH = 0.32;
const YAW = 0.3;

const THEMES = {
  dark: { bg: 0x0b0d18, hemi: 0.7, key: 2.4, fill: 0.5, table: 0x5a3824, felt: 0x1d4a35, env: 0.35, exposure: 1.05, bokeh: 0.5 },
  light: { bg: 0xf1e6d2, hemi: 1.1, key: 2.4, fill: 0.4, table: 0x8a5a3a, felt: 0x2f6b4a, env: 0.45, exposure: 1, bokeh: 0.2 },
};

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (dt, ms) => 1 - Math.exp(-dt / ms);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const rand = (min, max) => min + Math.random() * (max - min);
const firstName = name => (name || '?').split(' ')[0];
const pl = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

let THREE = null;
let RoomEnvironment = null;
let threeLoad = null;
let t3 = null;     // renderer, scena, HUD (raz)
let world = null;  // stół, wieże i książki dla bieżących danych

const view = {
  active: false,
  visible: false,
  autoplay: false,
  playing: false,
  p: 1,
};

async function loadThree() {
  THREE = await import('three');
  try {
    ({ RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js'));
  } catch (err) {
    console.warn('RoomEnvironment unavailable:', err);
  }
}

/* ----------------- Wejście i wyjście z ekranu ----------------- */
export function showTowers3d(replay = false) {
  view.active = true;
  if (replay) view.autoplay = true;
  if (!state.hasData) return;
  ensureMounted().then(ok => {
    if (!ok || !view.active) return;
    syncData();
    kick();
  });
}

export function hideTowers3d() {
  view.active = false;
  view.playing = false;
  if (t3) setReplayVisible();
  kick();
}

// Pętla rysuje tylko, gdy coś się rusza; potem staje (oszczędza baterię). kick() ją budzi.
function kick() {
  if (!t3) return;
  const run = !!world && view.active && view.visible && document.visibilityState === 'visible';
  if (run && view.autoplay) {
    view.autoplay = false;
    if (reduced()) view.p = 1;
    else replay();
  }
  if (run) {
    t3.idle = 0;
    if (t3.raf === null) {
      t3.last = performance.now();
      t3.raf = requestAnimationFrame(frame);
    }
  } else if (t3.raf !== null) {
    cancelAnimationFrame(t3.raf);
    t3.raf = null;
  }
}

function resolveColor(color) {
  const match = /^var\((--[\w-]+)\)$/.exec(color || '');
  const value = match ? getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() : color;
  return value || '#898781';
}

function syncData() {
  const readers = state.statsReaders;
  const rows = state.statsRows;
  const sig = [
    currentYear(), rows.length, rows.at(-1)?.created_at,
    ...rows.map(r => `${r.id}:${r.pages}:${r.multiplier}:${r.cover_url || ''}:${r.title}`),
    ...readers.map(r => `${r.key}:${r.name}:${r.color}`),
  ].join('|');
  if (world?.sig === sig) return;
  if (!rows.length) {
    clearWorld();
    t3.status.textContent = 'Brak książek w tym roku.';
    t3.status.hidden = false;
    return;
  }
  t3.status.hidden = true;
  buildWorld(readers, rows, sig);
}

/* ----------------- Silnik i HUD (raz) ----------------- */
async function ensureMounted() {
  if (t3) return true;
  const host = document.getElementById('towers3d');
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
  if (t3) return true;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.error('WebGL unavailable:', err);
    host.replaceChildren(el('div', { class: 'r3d-status', text: 'Ta przeglądarka nie obsługuje grafiki 3D (WebGL).' }));
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.classList.add('r3d-canvas');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 200);
  const hemi = new THREE.HemisphereLight(0xfff1dc, 0x2a1a10, 1);
  const key = new THREE.DirectionalLight(0xffe2b8, 2);
  key.position.set(7, 18, 11);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.5);
  fill.position.set(-10, 6, -6);
  scene.add(hemi, key, key.target, fill);
  if (RoomEnvironment) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  t3 = {
    renderer, scene, camera, hemi, key, fill, canvas, host,
    raf: null, last: 0, idle: 0, size: { w: 1, h: 1 },
    cam: { yaw: YAW, pitch: PITCH, dist: 30, y: 3 },
    goal: { yaw: YAW, pitch: PITCH },
    selected: null, dragging: false,
    raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), tmpV: new THREE.Vector3(),
    coverCache: new Map(),
  };
  buildShared();
  buildHud();
  buildDust();
  applyTheme();

  new ResizeObserver(() => { resize(); kick(); }).observe(host);
  resize();
  new IntersectionObserver(entries => {
    view.visible = entries.some(e => e.isIntersecting);
    kick();
  }, { threshold: 0.2 }).observe(host);
  document.addEventListener('visibilitychange', kick);
  new MutationObserver(() => { applyTheme(); kick(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  bindPointer();
  return true;
}

function resize() {
  const { host, renderer, camera } = t3;
  const w = Math.max(1, host.clientWidth);
  const h = Math.max(1, host.clientHeight);
  t3.size = { w, h };
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function buildShared() {
  // Brzegi kartek: kremowe z delikatnymi poziomymi liniami
  const pagesTex = canvasTexture(64, 64, (g, w, h) => {
    g.fillStyle = '#efe4cc';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 2) {
      g.fillStyle = `rgba(120,90,60,${0.05 + Math.random() * 0.08})`;
      g.fillRect(0, y, w, 1);
    }
  });
  pagesTex.wrapS = pagesTex.wrapT = THREE.RepeatWrapping;
  pagesTex.repeat.set(1, 4);
  const glowTex = canvasTexture(64, 64, g => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,220,160,1)');
    grad.addColorStop(0.4, 'rgba(255,200,120,0.35)');
    grad.addColorStop(1, 'rgba(255,190,110,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  t3.mats = {
    pages: new THREE.MeshStandardMaterial({ map: pagesTex, roughness: 0.9 }),
    bottom: new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.8 }),
    table: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 }),
    felt: new THREE.MeshStandardMaterial({ roughness: 1 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xf0c75e, metalness: 0.8, roughness: 0.25, emissive: 0x6b4a00, emissiveIntensity: 0.4 }),
    bokeh: new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  };
  t3.box = new THREE.BoxGeometry(1, 1, 1);
}

function buildHud() {
  t3.replayBtn = el('button', { type: 'button', class: 'r3d-replay', hidden: '' }, [icon('rotate-ccw'), el('span', { text: 'Powtórz' })]);
  t3.dateDay = el('strong', { text: '' });
  t3.labels = el('div', { class: 'r3d-labels', 'aria-hidden': 'true' });
  t3.popup = el('div', { class: 't3d-pop', hidden: '', role: 'status' });
  t3.status = el('div', { class: 'r3d-status', hidden: '' });
  t3.host.replaceChildren(
    t3.canvas,
    t3.labels,
    el('div', { class: 'r3d-date' }, [t3.dateDay, el('span', { text: String(currentYear()) })]),
    t3.popup,
    t3.replayBtn,
    t3.status,
  );
  refreshIcons();
  t3.replayBtn.addEventListener('click', () => {
    if (!world) return;
    replay();
    kick();
  });
}

function setReplayVisible() {
  t3.replayBtn.hidden = !world || view.playing || view.p < 1;
}

function applyTheme() {
  if (!t3) return;
  const dark = document.documentElement.classList.contains('dark-mode');
  const t = THEMES[dark ? 'dark' : 'light'];
  t3.scene.background.set(t.bg);
  t3.renderer.toneMappingExposure = t.exposure;
  t3.scene.environmentIntensity = t.env;
  t3.hemi.intensity = t.hemi;
  t3.key.intensity = t.key;
  t3.fill.intensity = t.fill;
  t3.mats.table.color.set(t.table);
  t3.mats.felt.color.set(t.felt);
  t3.mats.bokeh.opacity = t.bokeh;
  world?.towers.forEach(tw => {
    tw.css = resolveColor(tw.color);
    tw.label.style.setProperty('--c', tw.css);
  });
}

// Przeciąganie obraca widok; krótkie stuknięcie wybiera książkę
function bindPointer() {
  const { canvas } = t3;
  let down = null;
  canvas.addEventListener('pointerdown', e => {
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, t: performance.now(), moved: false };
    canvas.setPointerCapture(e.pointerId);
    t3.dragging = true;
    kick();
  });
  canvas.addEventListener('pointermove', e => {
    if (!down || down.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
    t3.goal.yaw = clamp(t3.goal.yaw - (e.clientX - down.lastX) * 0.006, -1.3, 1.3);
    t3.goal.pitch = clamp(t3.goal.pitch + (e.clientY - down.lastY) * 0.004, 0.08, 1.1);
    down.lastX = e.clientX;
    down.lastY = e.clientY;
    kick();
  });
  const release = e => {
    if (down && !down.moved && performance.now() - down.t < 450 && e.type === 'pointerup') pick(e);
    down = null;
    t3.dragging = false;
    kick();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

function pick(e) {
  if (!world) return;
  const rect = t3.canvas.getBoundingClientRect();
  t3.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  t3.raycaster.setFromCamera(t3.pointer, t3.camera);
  const hit = t3.raycaster.intersectObjects(world.books.filter(b => b.mesh.visible).map(b => b.mesh), false)[0];
  const book = hit ? world.books.find(b => b.mesh === hit.object) : null;
  select(book && book !== t3.selected ? book : null);
}

function select(book) {
  t3.selected = book;
  if (!book) {
    t3.popup.hidden = true;
    return;
  }
  const r = book.row;
  const pts = bookPoints(r);
  const finished = new Date(r.created_at);
  t3.popup.replaceChildren(
    el('strong', { class: 't3d-pop-title', text: r.title || 'bez tytułu' }),
    ...(r.author || r.published_year ? [el('span', { text: [r.author, r.published_year].filter(Boolean).join(' · ') })] : []),
    el('span', { text: `${book.tower.first} · ${r.pages} ${pl(r.pages, 'strona', 'strony', 'stron')} · ${pts} pkt${Number(r.multiplier) !== 1 ? ` (×${String(Number(r.multiplier)).replace('.', ',')})` : ''}` }),
    el('span', { class: 't3d-pop-date', text: `skończona ${formatDay(finished)}` }),
  );
  t3.popup.style.setProperty('--c', book.tower.css);
  t3.popup.hidden = false;
}

/* ----------------- Tekstury książek ----------------- */
function titleHue(title) {
  let h = 0;
  for (const c of title || '') h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

// Zastępcza okładka (jak na półce): gradient z koloru tytułu, tytuł i autor
function placeholderCover(row) {
  const h = titleHue(row.title);
  return canvasTexture(256, 360, (g, w, hh) => {
    const grad = g.createLinearGradient(0, 0, w, hh);
    grad.addColorStop(0, `hsl(${h} 45% 42%)`);
    grad.addColorStop(1, `hsl(${(h + 40) % 360} 50% 24%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, hh);
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.font = '700 30px Inter, system-ui, sans-serif';
    wrapText(g, row.title || 'bez tytułu', 20, 52, w - 40, 36, 5);
    if (row.author) {
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.font = '500 20px Inter, system-ui, sans-serif';
      wrapText(g, row.author, 20, hh - 40, w - 40, 24, 1);
    }
  });
}

function wrapText(g, text, x, y, maxW, lineH, maxLines) {
  const words = text.split(/\s+/);
  let line = '';
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, y + lines * lineH);
      if (++lines >= maxLines) return;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) g.fillText(line, x, y + lines * lineH, maxW);
}

// Grzbiet: kolor osoby (każda książka w trochę innym odcieniu), tytuł, złote linie;
// książka z mnożnikiem dostaje złotą opaskę z wartością
function spineTexture(row, base, th) {
  const h = clamp(Math.round((512 * th) / BOOK_L), 14, 200);
  return canvasTexture(512, h, (g, w, hh) => {
    const c = new THREE.Color(base);
    c.offsetHSL((Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.18);
    g.fillStyle = `#${c.getHexString()}`;
    g.fillRect(0, 0, w, hh);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(0, hh - Math.max(1, hh * 0.08), w, hh);
    g.fillStyle = 'rgba(240,199,94,0.85)';
    g.fillRect(14, 0, 3, hh);
    g.fillRect(w - 17, 0, 3, hh);
    const mult = Number(row.multiplier);
    let right = w - 30;
    if (mult !== 1) {
      g.fillStyle = '#e8c15a';
      g.fillRect(w - 110, 0, 70, hh);
      g.fillStyle = '#3a2a10';
      g.font = `800 ${Math.min(hh * 0.62, 34)}px Inter, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(`×${String(mult).replace('.', ',')}`, w - 75, hh / 2 + 1, 64);
      right = w - 120;
    }
    if (hh >= 16) {
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.font = `700 ${Math.min(hh * 0.6, 36)}px Inter, system-ui, sans-serif`;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(row.title || 'bez tytułu', 30, hh / 2 + 1, right - 30);
    }
  });
}

// Prawdziwa okładka z bazy; gdy serwer nie pozwala jej użyć w WebGL (CORS), zostaje zastępcza
function coverTexture(row, onReady) {
  const url = row.cover_url;
  if (!url) return;
  const cached = t3.coverCache.get(url);
  if (cached) {
    cached.then(tex => tex && onReady(tex));
    return;
  }
  const promise = new Promise(resolve => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(url, tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      resolve(tex);
    }, undefined, () => resolve(null));
  });
  t3.coverCache.set(url, promise);
  promise.then(tex => tex && onReady(tex));
}

/* ----------------- Świat ----------------- */
function disposeWorld() {
  world.group.traverse(o => {
    // Sprite'y mają jedną wspólną geometrię w three.js, jej nie zwalniamy
    if (o.geometry && o.geometry !== t3.box && !o.isSprite) o.geometry.dispose();
  });
  world.books.forEach(b => {
    b.spineMat.map?.dispose();
    b.spineMat.dispose();
    if (b.coverMat.map && !b.sharedCover) b.coverMat.map.dispose();
    b.coverMat.dispose();
  });
  world.towers.forEach(tw => tw.label.remove());
}

function clearWorld() {
  if (!world) return;
  t3.scene.remove(world.group);
  disposeWorld();
  select(null);
  world = null;
}

function crownMesh() {
  const g = new THREE.Group();
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.38, 0.28, 20, 1, true), t3.mats.gold);
  band.castShadow = true;
  g.add(band);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.32, 6), t3.mats.gold);
    spike.position.set(Math.cos(a) * 0.4, 0.28, Math.sin(a) * 0.4);
    spike.castShadow = true;
    g.add(spike);
  }
  return g;
}

function buildWorld(readers, rows, sig) {
  clearWorld();
  const colors = seriesColors(readers);
  const byUser = new Map();
  rows.forEach(r => {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  });
  const people = readers
    .filter(r => byUser.has(r.key))
    .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const totals = people.map(p => byUser.get(p.key).reduce((s, r) => s + bookPoints(r), 0));
  const k = TOWER_H / Math.max(1, ...totals);
  const n = people.length;
  const group = new THREE.Group();
  const width = (n - 1) * GAP + BOOK_L;

  // Okrągły stół do czytania z suknem; dookoła ciemno, w tle rozmyte światła lamp
  const radius = width / 2 + 3.2;
  const table = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.97, 0.5, 64), t3.mats.table);
  table.position.y = -0.25;
  table.receiveShadow = true;
  const felt = new THREE.Mesh(new THREE.CylinderGeometry(radius - 0.55, radius - 0.55, 0.04, 64), t3.mats.felt);
  felt.position.y = 0.01;
  felt.receiveShadow = true;
  group.add(table, felt);
  for (let i = 0; i < 16; i++) {
    const s = new THREE.Sprite(t3.mats.bokeh);
    const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
    const r = radius + 14 + Math.random() * 12;
    s.position.set(Math.cos(a) * r, 2 + Math.random() * 10, Math.sin(a) * r);
    s.scale.setScalar(3 + Math.random() * 4);
    group.add(s);
  }

  const t0 = new Date(currentYear(), 0, 1).getTime();
  const t1 = Math.max(Date.now(), t0 + DAY_MS);
  const towers = people.map((p, i) => {
    const css = resolveColor(colors.get(p.key));
    const x = (i - (n - 1) / 2) * GAP;
    const label = el('div', { class: 't3d-name' }, [el('b', { text: firstName(p.name) }), el('span')]);
    label.style.setProperty('--c', css);
    t3.labels.appendChild(label);
    return { key: p.key, first: firstName(p.name), color: colors.get(p.key), css, x, label, height: 0, pts: 0, shownPts: -1 };
  });

  // Książki w kolejności skończenia; każda zna swoje miejsce na stosie
  const books = [];
  towers.forEach((tw, i) => {
    let base = 0;
    byUser.get(people[i].key)
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
      .forEach(row => {
        const pts = bookPoints(row);
        const th = Math.max(0.05, pts * k);
        const spineMat = new THREE.MeshStandardMaterial({ map: spineTexture(row, tw.css, th), roughness: 0.55 });
        const coverMat = new THREE.MeshStandardMaterial({ map: placeholderCover(row), roughness: 0.6 });
        coverMat.map.center.set(0.5, 0.5);
        coverMat.map.rotation = Math.PI / 2;  // okładka w poprzek, bo grzbietem książki leżą do kamery
        // Kolejność ścian w BoxGeometry: +x, −x, +y (okładka), −y, +z (grzbiet), −z
        const mesh = new THREE.Mesh(t3.box, [t3.mats.pages, t3.mats.pages, coverMat, t3.mats.bottom, spineMat, t3.mats.pages]);
        const jitter = 0.94 + Math.random() * 0.1;
        mesh.scale.set(BOOK_L * jitter, th, BOOK_W * (0.94 + Math.random() * 0.1));
        const ry = (Math.random() - 0.5) * 0.14;  // stos nie jest idealnie równy
        mesh.rotation.y = ry;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const book = {
          row, tower: tw, pts, th, mesh, spineMat, coverMat,
          t: new Date(row.created_at).getTime(),
          y: base + th / 2, x: tw.x + (Math.random() - 0.5) * 0.18, z: (Math.random() - 0.5) * 0.15,
          ry, drop: null, out: 0,
        };
        coverTexture(row, tex => {
          if (book.coverMat.map) book.coverMat.map.dispose();
          tex.center.set(0.5, 0.5);
          tex.rotation = Math.PI / 2;
          book.coverMat.map = tex;
          book.sharedCover = true;
          book.coverMat.needsUpdate = true;
          kick();
        });
        mesh.position.set(book.x, book.y, book.z);
        group.add(mesh);
        books.push(book);
        base += th;
      });
  });

  const crown = crownMesh();
  group.add(crown);

  // Cień tylko w obrębie stołu: mniejszy obszar = ostrzejszy cień z tej samej mapy
  const sc = t3.key.shadow.camera;
  sc.left = -radius;
  sc.right = radius;
  sc.top = radius;
  sc.bottom = -radius;
  sc.near = 1;
  sc.far = 60;
  sc.updateProjectionMatrix();

  t3.scene.add(group);
  world = { sig, group, towers, books, crown, t0, t1, t: t1, width, radius, maxH: TOWER_H };
  placeAll(view.p >= 1 ? t1 : t0 + view.p * (t1 - t0));
  applyTheme();
  setReplayVisible();
}

// Ustaw wszystko od razu na dany dzień (bez spadania)
function placeAll(t) {
  world.t = t;
  world.books.forEach(b => {
    b.drop = null;
    b.mesh.visible = b.t <= t;
    b.mesh.position.set(b.x, b.y, b.z);
    b.mesh.rotation.set(0, b.ry, 0);
  });
  world.towers.forEach(tw => { tw.squash = null; });
  updateTowers();
}

function updateTowers() {
  world.towers.forEach(tw => {
    tw.height = 0;
    tw.pts = 0;
  });
  world.books.forEach(b => {
    if (!b.mesh.visible || (b.drop && !b.drop.landed)) return;  // w locie jeszcze się nie liczy
    b.tower.height = Math.max(b.tower.height, b.y + b.th / 2);
    b.tower.pts += b.pts;
  });
}

/* ----------------- Spadanie i lądowanie ----------------- */
// Lot: okładką do kamery (obrót o 90° wokół osi x), tuż przed stosem przekręca się na płasko,
// ale ląduje lekko przechylona i dotyka stosu jednym brzegiem
function startDrop(b, now) {
  const side = Math.random() < 0.5 ? -1 : 1;
  // Początek: okładka do kamery, stoi pionowo tytułem do góry. Koniec lotu: prawie płasko,
  // lekko przechylona. Obrót między nimi po najkrótszej drodze (slerp), bez skręcania się.
  const rx1 = side * rand(0.08, 0.16);
  const rz1 = rand(-0.07, 0.07);
  const start = new THREE.Euler(Math.PI / 2 - rand(0.05, 0.2), b.ry + COVER_UPRIGHT + rand(-0.12, 0.12), rand(-0.1, 0.1));
  b.drop = {
    start: now, landed: false, rx1, rz1,
    q0: new THREE.Quaternion().setFromEuler(start),
    q1: new THREE.Quaternion().setFromEuler(new THREE.Euler(rx1, b.ry, rz1)),
  };
}

// O ile podnieść środek przechylonej książki, żeby niższy brzeg leżał na stosie
const edgeLift = (rx, rz) => (BOOK_W / 2) * Math.abs(Math.sin(rx)) + (BOOK_L / 2) * Math.abs(Math.sin(rz));

// Zwraca wysokość książki w tej klatce i ustawia jej obrót
function dropStep(b, now) {
  const d = b.drop;
  const t = (now - d.start) / 1000;
  let rx;
  let rz;
  let y;
  if (t < FALL_S) {
    const k = t / FALL_S;
    const turn = smoothstep(0.45, 1, k);  // najpierw widać okładkę, obrót na płasko pod koniec lotu
    b.mesh.quaternion.slerpQuaternions(d.q0, d.q1, turn);
    // Pod koniec lotu przechył jest już mały; do podniesienia brzegu wystarczy przybliżenie
    y = b.y + DROP_FROM * (1 - k * k) + edgeLift(d.rx1, d.rz1) + (BOOK_L / 2) * (1 - turn);  // droga ~ t²
    return y;
  } else {
    if (!d.landed) {
      d.landed = true;
      land(b);
    }
    // Klapnięcie: przechył szybko gaśnie, z jednym małym wychyleniem w drugą stronę
    const s = t - FALL_S;
    const swing = Math.exp(-s / 0.075) * Math.cos(s * 26);
    rx = d.rx1 * swing;
    rz = d.rz1 * swing;
    y = b.y + edgeLift(rx, rz);
    if (s >= SETTLE_S) {
      rx = 0;
      rz = 0;
      y = b.y;
      b.drop = null;
    }
  }
  b.mesh.rotation.set(rx, b.ry, rz);
  return y;
}

// Uderzenie: stos się ugina (grubsza książka = mocniej), spod okładki wylatuje kurz
function land(b) {
  b.tower.squash = { start: performance.now(), amp: 0.04 + Math.min(0.08, b.th * 0.12) };
  if (reduced()) return;
  const D = t3.dust;
  const n = 10 + Math.round(Math.min(10, b.th * 12));
  for (let i = 0; i < n; i++) {
    const j = D.next;
    D.next = (D.next + 1) % DUST;
    // Start na obwodzie książki, lot na zewnątrz i lekko w górę
    const a = rand(0, Math.PI * 2);
    const ex = Math.cos(a) * (BOOK_L / 2);
    const ez = Math.sin(a) * (BOOK_W / 2);
    D.pos.set([b.x + ex, b.y - b.th / 2 + 0.02, b.z + ez], j * 3);
    D.vel.set([Math.cos(a) * rand(0.6, 1.6), rand(0.15, 0.6), Math.sin(a) * rand(0.6, 1.6)], j * 3);
    D.life[j] = D.max[j] = rand(0.45, 0.8);
  }
  D.active = true;
}

function buildDust() {
  const pos = new Float32Array(DUST * 3).fill(-1000);
  const col = new Float32Array(DUST * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const tex = canvasTexture(32, 32, g => {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  });
  const mat = new THREE.PointsMaterial({ map: tex, size: 0.35, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  t3.scene.add(points);
  t3.dust = { geo, pos, col, vel: new Float32Array(DUST * 3), life: new Float32Array(DUST), max: new Float32Array(DUST), next: 0, active: false };
}

// Kurz: rozlatuje się, zwalnia (opór powietrza), lekko opada i gaśnie. Zwraca true, póki coś leci.
function updateDust(dt) {
  const D = t3.dust;
  if (!D.active) return false;
  const s = dt / 1000;
  const drag = Math.exp(-4 * s);
  let alive = false;
  for (let i = 0; i < DUST; i++) {
    if (D.life[i] <= 0) continue;
    const j = i * 3;
    D.life[i] -= s;
    if (D.life[i] <= 0) {
      D.col[j] = D.col[j + 1] = D.col[j + 2] = 0;
      D.pos[j + 1] = -1000;
      continue;
    }
    alive = true;
    D.vel[j + 1] -= 0.6 * s;
    for (let a = 0; a < 3; a++) {
      D.vel[j + a] *= drag;
      D.pos[j + a] += D.vel[j + a] * s;
    }
    const f = (D.life[i] / D.max[i]) * 0.55;
    D.col[j] = 0.95 * f;
    D.col[j + 1] = 0.85 * f;
    D.col[j + 2] = 0.7 * f;
  }
  D.geo.attributes.position.needsUpdate = true;
  D.geo.attributes.color.needsUpdate = true;
  D.active = alive;
  return alive;
}

/* ----------------- Odtwarzanie ----------------- */
function replay() {
  view.p = 0;
  view.playing = true;
  select(null);
  placeAll(world.t0);
  setReplayVisible();
}

function frame(now) {
  if (!world) {
    t3.raf = null;
    return;
  }
  t3.raf = requestAnimationFrame(frame);
  const dt = Math.min(50, now - t3.last);
  t3.last = now;
  let busy = view.playing || t3.dragging;

  if (view.playing) {
    const slow = 1 - 0.6 * smoothstep(0.9, 1, view.p);
    view.p = Math.min(1, view.p + (dt * slow) / PLAY_MS);
    world.t = world.t0 + view.p * (world.t1 - world.t0);
    if (view.p >= 1) {
      view.playing = false;
      setReplayVisible();
    }
  }

  // Ugięcie stosu po uderzeniu książki: krótka, mocno wytłumiona sprężyna
  for (const tw of world.towers) {
    tw.dip = 0;
    if (!tw.squash) continue;
    const s = (now - tw.squash.start) / 1000;
    if (s > 0.5) {
      tw.squash = null;
      continue;
    }
    tw.dip = tw.squash.amp * Math.exp(-s / 0.07) * Math.cos(s * 32);
    busy = true;
  }

  // Książki, których dzień właśnie minął, zaczynają spadać na swój stos
  for (const b of world.books) {
    if (!b.mesh.visible && b.t <= world.t) {
      b.mesh.visible = true;
      startDrop(b, now);
    }
    let y = b.y;
    if (b.drop) {
      y = dropStep(b, now);
      busy = true;
    } else if (b.tower.dip && b.mesh.visible) {
      // Niższe książki uginają się mniej niż górne
      y -= b.tower.dip * ((b.y + b.th / 2) / Math.max(0.1, b.tower.height));
    }
    b.mesh.position.y = y;
    // Wybrana książka wysuwa się ze stosu w stronę kamery
    const outGoal = t3.selected === b ? OUT : 0;
    if (Math.abs(b.out - outGoal) > 0.002) {
      b.out += (outGoal - b.out) * ease(dt, 120);
      busy = true;
    }
    b.mesh.position.z = b.z + b.out;
  }
  if (updateDust(dt)) busy = true;
  updateTowers();

  // Korona na najwyższej wieży
  const top = world.towers.reduce((a, b) => (b.height > a.height ? b : a));
  world.crown.visible = top.height > 0;
  world.crown.position.set(top.x, top.height + 0.55 + Math.sin(now * 0.002) * 0.08, 0);
  world.crown.rotation.y += dt * 0.0012;  // kręci się, póki pętla działa; potem stoi

  if (updateCamera(dt)) busy = true;
  t3.renderer.render(t3.scene, t3.camera);
  updateOverlay();

  // Nic się nie rusza od pół sekundy: przestajemy rysować do następnego kick()
  t3.idle = busy ? 0 : t3.idle + dt;
  if (t3.idle > 500) {
    cancelAnimationFrame(t3.raf);
    t3.raf = null;
  }
}

// Kamera obejmuje wszystkie wieże i rośnie razem z najwyższą; zwraca true, póki jeszcze jedzie
function updateCamera(dt) {
  const { cam, goal, camera } = t3;
  // Minimum, żeby na początku roku było widać książkę spadającą z góry
  const tallest = Math.max(4.5, ...world.towers.map(tw => tw.height));
  const vfov = (camera.fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const halfW = world.width / 2 + 1.6;
  // Zapas u góry na koronę i datę/„Powtórz”, u dołu na etykiety z imionami
  const halfH = tallest / 2 + 2.2;
  const distGoal = Math.max(halfW / Math.tan(hfov / 2), halfH / Math.tan(vfov / 2)) + BOOK_W + 2;
  const yGoal = tallest * 0.5;
  const k = ease(dt, 260);
  const before = cam.dist + cam.y + cam.yaw + cam.pitch;
  cam.dist += (distGoal - cam.dist) * k;
  cam.y += (yGoal - cam.y) * k;
  cam.yaw += (goal.yaw - cam.yaw) * k;
  cam.pitch += (goal.pitch - cam.pitch) * k;
  const look = t3.tmpV.set(0, cam.y, 0);
  camera.position.set(
    Math.sin(cam.yaw) * Math.cos(cam.pitch) * cam.dist,
    cam.y + Math.sin(cam.pitch) * cam.dist,
    Math.cos(cam.yaw) * Math.cos(cam.pitch) * cam.dist,
  );
  camera.lookAt(look);
  return Math.abs(cam.dist + cam.y + cam.yaw + cam.pitch - before) > 0.0005;
}

function updateOverlay() {
  const { camera, size } = t3;
  camera.updateMatrixWorld();
  for (const tw of world.towers) {
    const v = t3.tmpV.set(tw.x, -0.1, BOOK_W * 0.9).project(camera);
    tw.label.style.transform = `translate(${((v.x + 1) / 2) * size.w}px, ${((1 - v.y) / 2) * size.h}px) translate(-50%, 0)`;
    const pts = Math.round(tw.pts);
    if (tw.shownPts !== pts) {
      tw.shownPts = pts;
      tw.label.lastChild.textContent = `${compactNumber(pts)} pkt`;
    }
  }
  const day = view.p >= 1 ? 'dziś' : formatDay(new Date(world.t));
  if (t3.dateDay.textContent !== day) t3.dateDay.textContent = day;
}
