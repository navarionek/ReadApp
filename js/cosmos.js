import { el, icon, refreshIcons } from './ui.js';

/* ----------------- Kosmos: układ z karty Półki w 3D (easter egg) ----------------- */
// Po wybuchu orbity na karcie osoby (8 s trzymania palca, js/aura.js) ekran otwiera się kołem z miejsca
// słońca na karcie, kamera wlatuje w układ jak w nadprzestrzeni, a okręgi wracają jako planety: każda
// książka to planeta (od najstarszej przy słońcu do najnowszej na zewnątrz). Wielkość to liczba stron,
// pierścienie to mnożnik, złota poświata to ulubiona, szara to słaba albo niedokończona. Potem układ
// można obracać, przybliżać, a stuknięta planeta podlatuje bliżej i pokazuje swoją książkę.
// Three.js (import mapa w index.html) dociągamy dopiero tu; po zamknięciu wszystko jest zwalniane.
const ADDON_PATHS = [
  'three/addons/postprocessing/EffectComposer.js',
  'three/addons/postprocessing/RenderPass.js',
  'three/addons/postprocessing/UnrealBloomPass.js',
  'three/addons/postprocessing/OutputPass.js',
  'three/addons/controls/OrbitControls.js',
];
const SUN_R = 2.2;
const FIRST_ORBIT = 5.2;   // promień pierwszej orbity (jednostki sceny)
const ORBIT_GAP = 0.55;    // odstęp między planetami sąsiednich orbit, ponad ich promienie
const STARS = 4200;
const STREAKS = 360;       // smugi gwiazd przy wlocie
const REVEAL_MS = 950;     // koło otwierające ekran
const INTRO_MS = 3800;     // wlot kamery i powrót planet
const SPIN_FROM = 30;      // planety na starcie krążą tyle razy szybciej (jak rozkręcona karta) i hamują
const BASE_PERIOD = 22;    // obieg pierwszej orbity (s); dalsze wolniej
const IDLE_SPIN_MS = 7000; // tyle po ostatnim dotknięciu kamera znowu sama powoli krąży

const rand01 = seedText => {
  let a = 2166136261;
  for (let i = 0; i < seedText.length; i++) a = Math.imul(a ^ seedText.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const follow = (dt, ms) => 1 - Math.exp(-dt / ms);  // wygładzanie niezależne od liczby klatek
const backOut = t => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;  // lekkie przestrzelenie na końcu
const plural = (n, one, few, many) => {
  if (n === 1) return one;
  const d = n % 10;
  const dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
};
const numberPl = n => n.toLocaleString('pl-PL');

let THREE = null;
let ADDONS = null;
let threeLoad = null;
let cosmos = null;  // otwarty kosmos (jeden naraz)

function loadThree() {
  threeLoad ||= (async () => {
    THREE = await import('three');
    try {
      ADDONS = Object.assign({}, ...(await Promise.all(ADDON_PATHS.map(path => import(path)))));
    } catch (err) {
      console.warn('three addons unavailable, cosmos without bloom:', err);
      ADDONS = null;
    }
  })().catch(err => {
    threeLoad = null;
    throw err;
  });
  return threeLoad;
}

// Karta zaczyna się mocno rozkręcać: silnik ściągamy już w tle, żeby po wybuchu nie czekać
export function preloadCosmos() {
  loadThree().catch(() => {});
}

// books: od najnowszej (jak na półce), najwyżej tyle, ile okręgów na karcie; h, s: kolor osoby;
// origin: środek słońca na karcie (px w oknie), stamtąd otwiera się ekran
export function openCosmos({ books, seed, h, s, name, kicker, origin }) {
  if (cosmos || document.documentElement.classList.contains('eink')) return;
  const view = buildOverlay({ books, h, name, kicker, origin });
  cosmos = view;
  history.pushState({ cosmos: true }, '');
  loadThree()
    .then(() => {
      if (cosmos !== view || view.closing) return;
      if (!startScene(view, { books, seed, h, s })) requestClose();
    })
    .catch(err => {
      console.error('three.js load failed:', err);
      if (cosmos === view) requestClose();
    });
}

// Zamknięcie przyciskiem albo klawiszem idzie przez „Wstecz”, żeby nie zostawał wpis w historii
function requestClose() {
  if (!cosmos || cosmos.closing) return;
  if (history.state?.cosmos) history.back();
  else close();
}

window.addEventListener('popstate', () => {
  if (cosmos && !cosmos.closing) close();
});

/* ----------------- Ekran (HTML nad sceną) ----------------- */
function buildOverlay({ books, h, name, kicker, origin }) {
  const pages = books.reduce((sum, b) => sum + (b.pages || 0), 0);
  const closeBtn = el('button', { type: 'button', class: 'cosmos-btn cosmos-close', 'aria-label': 'Zamknij' }, [icon('x')]);
  const hint = el('p', { class: 'cosmos-hint', text: books.length ? 'Stuknij planetę, żeby podlecieć' : 'Pierwsza przeczytana książka stanie się tu planetą' });
  const info = el('div', { class: 'cosmos-info', hidden: '' });
  const root = el('div', { class: 'cosmos', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Układ słoneczny: ${name}` }, [
    el('div', { class: 'cosmos-stage' }),
    el('span', { class: 'cosmos-flash' }),
    el('header', { class: 'cosmos-hud' }, [
      el('div', { class: 'cosmos-title' }, [
        el('span', { class: 'cosmos-kicker', text: kicker ? `${kicker} · układ słoneczny` : 'Układ słoneczny' }),
        el('h2', { text: name || 'Półka' }),
        el('span', { class: 'cosmos-sub', text: books.length ? `${books.length} ${plural(books.length, 'planeta', 'planety', 'planet')} · ${numberPl(pages)} stron` : 'Na razie samo słońce' }),
      ]),
      closeBtn,
    ]),
    hint,
    info,
  ]);
  root.style.setProperty('--cosmos-h', String(Math.round(h)));
  root.style.setProperty('--ox', `${origin.x}px`);
  root.style.setProperty('--oy', `${origin.y}px`);
  document.body.appendChild(root);
  document.body.classList.add('cosmos-open');
  refreshIcons();

  // Koło otwierające ekran ze słońca karty (dalej, za kołem, scena może się jeszcze wczytywać)
  const reach = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y)) + 20;
  root.animate(
    [{ clipPath: `circle(0px at ${origin.x}px ${origin.y}px)` }, { clipPath: `circle(${reach}px at ${origin.x}px ${origin.y}px)` }],
    { duration: REVEAL_MS, easing: 'cubic-bezier(0.65, 0, 0.25, 1)' },
  );

  const view = { root, info, hint, origin, closing: false, scene: null };
  closeBtn.addEventListener('click', requestClose);
  view.onKey = e => {
    if (e.key !== 'Escape') return;
    if (view.scene?.focus) view.scene.unfocus();
    else requestClose();
  };
  document.addEventListener('keydown', view.onKey);
  return view;
}

function close() {
  const view = cosmos;
  if (!view || view.closing) return;
  view.closing = true;
  document.removeEventListener('keydown', view.onKey);
  const { x, y } = view.origin;
  const reach = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 20;
  const anim = view.root.animate(
    [{ clipPath: `circle(${reach}px at ${x}px ${y}px)`, opacity: 1 }, { clipPath: `circle(0px at ${x}px ${y}px)`, opacity: 0.6 }],
    { duration: 650, easing: 'cubic-bezier(0.55, 0, 0.75, 0.2)', fill: 'forwards' },
  );
  anim.finished.catch(() => {}).then(() => {
    view.scene?.dispose();
    view.root.remove();
    document.body.classList.remove('cosmos-open');
    if (cosmos === view) cosmos = null;
  });
}

/* ----------------- Scena ----------------- */
function startScene(view, { books, seed, h, s }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.error('WebGL unavailable:', err);
    return false;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const stage = view.root.querySelector('.cosmos-stage');
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010208);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 3000);
  scene.add(camera);  // smugi gwiazd są dziećmi kamery

  let composer = null;
  if (ADDONS) {
    try {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2 });
      composer = new ADDONS.EffectComposer(renderer, target);
      composer.addPass(new ADDONS.RenderPass(scene, camera));
      composer.addPass(new ADDONS.UnrealBloomPass(new THREE.Vector2(1, 1), 1.05, 0.55, 0.78));
      composer.addPass(new ADDONS.OutputPass());
    } catch (err) {
      console.warn('bloom setup failed, cosmos without it:', err);
      composer = null;
    }
  }
  const pixelRatio = Math.min(window.devicePixelRatio || 1, composer ? 1.5 : 2);
  renderer.setPixelRatio(pixelRatio);
  composer?.setPixelRatio(pixelRatio);

  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = clamp(s / 100, 0.08, 0.95);
  const sky = buildSky(hue, sat, pixelRatio);
  scene.add(sky.group);
  const sun = buildSun(hue, sat);
  scene.add(sun.group);
  scene.add(new THREE.AmbientLight(0xffffff, 0.05));
  scene.add(new THREE.HemisphereLight(new THREE.Color().setHSL(hue, 0.6, 0.6), 0x000000, 0.18));

  const planets = buildPlanets(books, seed, hue, sat);
  planets.forEach(p => scene.add(p.orbit));
  const emptyOrbits = books.length ? [] : buildEmptyOrbits();
  emptyOrbits.forEach(o => scene.add(o));
  const systemR = planets.length ? planets.at(-1).R + planets.at(-1).r : 13;
  const streaks = buildStreaks();
  camera.add(streaks.lines);

  const controls = ADDONS?.OrbitControls ? new ADDONS.OrbitControls(camera, renderer.domElement) : null;
  if (controls) {
    Object.assign(controls, {
      enabled: false, enableDamping: true, dampingFactor: 0.07, enablePan: false,
      rotateSpeed: 0.55, zoomSpeed: 0.9, autoRotateSpeed: 0.35,
      minDistance: 1.2, maxDistance: systemR * 6, minPolarAngle: 0.08, maxPolarAngle: Math.PI - 0.08,
    });
  }

  const sc = {
    renderer, scene, camera, composer, controls, sky, sun, planets, emptyOrbits, streaks, systemR,
    raf: 0, t0: 0, last: 0, time: 0, introDone: false, focus: null, focusLast: new THREE.Vector3(),
    goalDist: null, lastTouch: 0, size: { w: 1, h: 1 }, yaw: 0.6,
    tmp: new THREE.Vector3(), tmp2: new THREE.Vector3(), raycaster: new THREE.Raycaster(),
  };
  view.scene = sc;

  const resize = () => {
    const w = Math.max(1, stage.clientWidth);
    const hgt = Math.max(1, stage.clientHeight);
    sc.size = { w, h: hgt };
    renderer.setSize(w, hgt, false);
    composer?.setSize(w, hgt);
    camera.aspect = w / hgt;
    camera.fov = w / hgt < 1 ? 62 : 50;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  // Odległość, z której cały układ mieści się w kadrze (na pionowym telefonie decyduje szerokość)
  sc.overviewDist = () => {
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    return (systemR * 1.08) / Math.tan(Math.min(vfov, hfov * 1.15) / 2);
  };

  /* ----- Dotyk: stuknięcie planety, przeciąganie obraca (OrbitControls) ----- */
  const canvas = renderer.domElement;
  let down = null;
  canvas.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    sc.lastTouch = performance.now();
    if (controls) controls.autoRotate = false;
  });
  canvas.addEventListener('pointerup', e => {
    sc.lastTouch = performance.now();
    if (!down || !sc.introDone) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 450;
    down = null;
    if (moved < 8 && quick) pick(e);
  });
  controls?.addEventListener('start', () => {
    sc.goalDist = null;  // palec przejmuje kamerę
    sc.lastTouch = performance.now();
  });

  const pick = e => {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    sc.raycaster.setFromCamera(ndc, camera);
    const hit = sc.raycaster.intersectObjects([...planets.map(p => p.hit), sun.hit], false)[0];
    const planet = hit && planets.find(p => p.hit === hit.object);
    if (planet) sc.focusOn(planet);
    else sc.unfocus();
  };

  sc.focusOn = planet => {
    if (sc.focus === planet) return;
    sc.focus = planet;
    planet.body.getWorldPosition(sc.focusLast);
    sc.goalDist = Math.max(planet.r * 6 + 0.9, 2.4);
    if (controls) controls.autoRotate = false;
    view.hint.classList.add('gone');
    showInfo(view, sc, planet);
  };
  sc.unfocus = () => {
    if (!sc.focus && view.info.hidden) return;
    sc.focus = null;
    sc.goalDist = sc.overviewDist();
    hideInfo(view);
  };

  /* ----- Pętla ----- */
  const frame = now => {
    sc.raf = requestAnimationFrame(frame);
    const dt = Math.min(64, now - sc.last);
    sc.last = now;
    if (!sc.t0) sc.t0 = now;
    const t = clamp((now - sc.t0) / INTRO_MS, 0, 1);
    // Planety krążą najpierw szybko (jak rozkręcona karta tuż przed wybuchem) i hamują do zwykłego tempa
    const spin = 1 + (SPIN_FROM - 1) * (1 - t) ** 3;
    sc.time += (dt / 1000) * spin;
    const sec = now / 1000;

    sun.update(sec, t);
    planets.forEach((p, i) => updatePlanet(p, i, planets.length, sc.time, dt, t));
    emptyOrbits.forEach(o => { o.material.opacity = 0.35 * smooth(0.3, 0.8, t); });

    if (!sc.introDone) introCamera(sc, t);
    else steerCamera(sc, dt, now);
    sky.update(sec, camera);
    streaks.update(dt, sc.warp || 0);

    if (composer) composer.render();
    else renderer.render(scene, camera);
  };

  // Apka w tle: pętla stoi
  sc.onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      cancelAnimationFrame(sc.raf);
      sc.raf = 0;
    } else if (!sc.raf) {
      sc.last = performance.now();
      sc.raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', sc.onVisibility);

  sc.dispose = () => {
    cancelAnimationFrame(sc.raf);
    document.removeEventListener('visibilitychange', sc.onVisibility);
    ro.disconnect();
    controls?.dispose();
    scene.traverse(obj => {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      mats.forEach(m => {
        Object.values(m).forEach(v => v?.isTexture && v.dispose());
        Object.values(m.uniforms || {}).forEach(u => u.value?.isTexture && u.value.dispose());
        m.dispose();
      });
    });
    composer?.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss();
  };

  view.root.classList.add('ready');
  sc.last = performance.now();
  sc.raf = requestAnimationFrame(frame);
  return true;
}

/* ----- Kamera ----- */
// Wlot: z daleka, prawie z góry (jak orbita na karcie), w dół do widoku z ukosa; słońce startuje w miejscu,
// gdzie było na karcie, i płynie na środek ekranu. Szybkość wlotu zasila smugi gwiazd.
const INTRO_FAR = 3.4;
function introCamera(sc, t) {
  const { camera, controls } = sc;
  const end = sc.overviewDist();
  const e = 1 - (1 - t) ** 3.2;
  const dist = lerp(end * INTRO_FAR, end, e);
  const pitch = lerp(1.5, 0.42, smooth(0, 0.85, t));  // kąt nad płaszczyzną orbit (rad)
  const yaw = sc.yaw - 1.3 * (1 - e);
  camera.position.set(Math.cos(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.sin(yaw) * Math.cos(pitch) * dist);
  camera.lookAt(0, 0, 0);
  sc.warp = clamp(3.2 * (1 - t) ** 2.2 * (INTRO_FAR - 1) * 0.42, 0, 1) * smooth(0, 0.06, t);

  const { w, h } = sc.size;
  const shift = 1 - smooth(0.05, 0.6, t);
  if (shift > 0.001) {
    const o = originOf();
    camera.setViewOffset(w, h, (w / 2 - o.x) * shift, (h / 2 - o.y) * shift, w, h);
  } else if (camera.view?.enabled) {
    camera.clearViewOffset();
  }

  if (t >= 1) {
    sc.introDone = true;
    sc.warp = 0;
    camera.clearViewOffset();
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.enabled = true;
      controls.autoRotate = true;
      controls.update();
    }
  }
}

function steerCamera(sc, dt, now) {
  const { camera, controls } = sc;
  if (!controls) {
    camera.lookAt(0, 0, 0);
    return;
  }
  const want = sc.tmp.set(0, 0, 0);
  if (sc.focus) {
    // Kamera leci razem z planetą (przesunięcie planety dodajemy do kamery i punktu, wokół którego krąży)
    sc.focus.body.getWorldPosition(want);
    const delta = sc.tmp2.subVectors(want, sc.focusLast);
    camera.position.add(delta);
    controls.target.add(delta);
    sc.focusLast.copy(want);
  }
  const k = follow(dt, 280);
  controls.target.lerp(want, k);
  if (sc.goalDist !== null) {
    const offset = sc.tmp2.subVectors(camera.position, controls.target);
    const len = offset.length() || 1;
    const next = lerp(len, sc.goalDist, k);
    camera.position.copy(controls.target).addScaledVector(offset, next / len);
    if (Math.abs(next - sc.goalDist) < sc.goalDist * 0.004) sc.goalDist = null;
  }
  if (!sc.focus && !controls.autoRotate && now - sc.lastTouch > IDLE_SPIN_MS) controls.autoRotate = true;
  controls.update();
}

/* ----- Niebo: gwiazdy, pasmo Drogi Mlecznej i mgławica w barwach osoby ----- */
function buildSky(hue, sat, pixelRatio) {
  const rand = rand01('czytanko-kosmos');
  const group = new THREE.Group();

  // Mgławica: kula od środka z rozmytymi plamami w pokrewnych odcieniach (rysowana raz na canvasie).
  // Tło canvasu musi być nieprzezroczyste: z prawie przezroczystych pikseli WebGL odtwarzał kolor
  // z dzielenia przez alfę, wychodził szum i każdy teksel świecił jak kropka w siatce.
  const W = 512;
  const H = 256;
  const neb = document.createElement('canvas');
  neb.width = W;
  neb.height = H;
  const g = neb.getContext('2d');
  const blob = (x, y, r, color) => {
    for (const dx of [-W, 0, W]) {  // zawinięte przez szew kuli
      const grad = g.createRadialGradient(x + dx, y, 0, x + dx, y, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x + dx - r, y - r, r * 2, r * 2);
    }
  };
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  const H0 = hue * 360;
  for (let i = 0; i < 22; i++) {
    const x = rand() * W;
    const y = H * (0.5 + Math.sin((x / W) * Math.PI * 2) * 0.12 + (rand() - 0.5) * 0.22);
    const hh = H0 + (rand() - 0.5) * 70;
    blob(x, y, (60 + rand() * 210) / 2, `hsla(${hh}, ${Math.round(35 + sat * 45)}%, ${Math.round(22 + rand() * 16)}%, ${(0.04 + rand() * 0.06).toFixed(3)})`);
  }
  for (let i = 0; i < 40; i++) {  // jasne pasmo
    const x = rand() * W;
    const y = H * (0.5 + Math.sin((x / W) * Math.PI * 2) * 0.12 + (rand() - 0.5) * 0.06);
    blob(x, y, (30 + rand() * 70) / 2, `rgba(220,225,255,${(0.012 + rand() * 0.022).toFixed(3)})`);
  }
  const nebTex = new THREE.CanvasTexture(neb);
  nebTex.colorSpace = THREE.SRGBColorSpace;
  const nebula = new THREE.Mesh(
    new THREE.SphereGeometry(1400, 48, 24),
    new THREE.MeshBasicMaterial({ map: nebTex, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  nebula.rotation.set(0.5, 0.3, 0.35);
  group.add(nebula);

  // Gwiazdy: punkty na wielkiej kuli, gęściej wzdłuż pasma; każda migocze w swoim rytmie
  const pos = new Float32Array(STARS * 3);
  const tint = new Float32Array(STARS * 3);
  const size = new Float32Array(STARS);
  const phase = new Float32Array(STARS);
  const tints = [[1, 1, 1], [1, 1, 1], [0.78, 0.86, 1], [0.82, 0.9, 1], [1, 0.9, 0.78], [1, 0.82, 0.7]];
  const v = new THREE.Vector3();
  const bandTilt = new THREE.Euler(0.5, 0.3, 0.35);
  for (let i = 0; i < STARS; i++) {
    if (i < STARS * 0.42) {
      // W paśmie: losowy kąt na wielkim kole i niewielkie odchylenie (rozkład zbliżony do normalnego)
      const a = rand() * Math.PI * 2;
      const lat = (rand() + rand() + rand() - 1.5) * 0.16;
      v.set(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat)).applyEuler(bandTilt);
    } else {
      const u = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      v.set(Math.sqrt(1 - u * u) * Math.cos(a), u, Math.sqrt(1 - u * u) * Math.sin(a));
    }
    v.multiplyScalar(1100);
    pos.set([v.x, v.y, v.z], i * 3);
    const [r, gg, b] = tints[Math.floor(rand() * tints.length)];
    const bright = 0.35 + rand() * 0.65;
    tint.set([r * bright, gg * bright, b * bright], i * 3);
    size[i] = 1.1 + rand() ** 7 * 4.2;
    phase[i] = rand();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, pr: { value: pixelRatio } },
    vertexShader: `
      attribute vec3 tint; attribute float size; attribute float phase;
      uniform float time; uniform float pr;
      varying vec3 vC;
      void main() {
        float tw = 0.72 + 0.28 * sin(time * (0.7 + phase * 2.1) + phase * 40.0);
        vC = tint * tw;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * pr;
      }`,
    fragmentShader: `
      varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vC * a * a, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(geo, starMat);
  stars.frustumCulled = false;
  group.add(stars);

  return {
    group,
    update(sec, camera) {
      group.position.copy(camera.position);  // niebo jest „nieskończenie” daleko: nie przesuwa się z kamerą
      starMat.uniforms.time.value = sec;
    },
  };
}

// Smugi gwiazd przy wlocie: kreski wokół osi kamery, lecące na nią; długość i jasność rosną z prędkością
function buildStreaks() {
  const rand = rand01('czytanko-warp');
  const pos = new Float32Array(STREAKS * 6);
  const col = new Float32Array(STREAKS * 6);
  const items = Array.from({ length: STREAKS }, () => {
    const a = rand() * Math.PI * 2;
    const r = 2 + rand() ** 0.7 * 40;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, z: -5 - rand() * 300, b: 0.4 + rand() * 0.6 };
  });
  items.forEach((it, i) => {
    col.set([it.b, it.b, it.b * 1.05, 0, 0, 0], i * 6);  // głowa jasna, ogon czarny (przy dodawaniu = niewidoczny)
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 10;
  return {
    lines,
    update(dt, warp) {
      lines.visible = warp > 0.01;
      if (!lines.visible) return;
      mat.opacity = warp;
      const len = 3 + 70 * warp;
      items.forEach((it, i) => {
        it.z += dt * 0.9 * warp;
        if (it.z > -1) it.z -= 300;
        pos.set([it.x, it.y, it.z, it.x, it.y, it.z - len], i * 6);
      });
      geo.attributes.position.needsUpdate = true;
    },
  };
}

/* ----- Słońce: płonąca powierzchnia w kolorze osoby, korona i światło ----- */
function glowTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([at, color]) => grad.addColorStop(at, color));
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildSun(hue, sat) {
  const group = new THREE.Group();
  const hot = new THREE.Color().setHSL((hue + 15 / 360) % 1, 1, 0.82);
  const base = new THREE.Color().setHSL(hue, Math.max(0.55, sat), 0.5);
  const mat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, cHot: { value: hot }, cBase: { value: base } },
    vertexShader: `
      varying vec3 vPos; varying vec3 vN; varying vec3 vV;
      void main() {
        vPos = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float time; uniform vec3 cHot; uniform vec3 cBase;
      varying vec3 vPos; varying vec3 vN; varying vec3 vV;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; } return v; }
      void main() {
        vec3 p = normalize(vPos) * 2.4;
        float n = fbm(p + vec3(0.0, time * 0.09, time * 0.05));
        float m = fbm(p * 3.1 - vec3(time * 0.14, 0.0, time * 0.07));
        float t = clamp(n * 0.8 + m * 0.5, 0.0, 1.0);
        vec3 col = mix(cBase * 1.5, cHot * 1.7, smoothstep(0.3, 0.85, t));
        float rim = 1.0 - max(dot(vN, vV), 0.0);
        col += cBase * pow(rim, 2.5) * 1.2;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 64, 32), mat);
  group.add(core);

  const corona = (scale, opacity, stops) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(stops), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity }));
    sprite.scale.setScalar(scale);
    group.add(sprite);
    return sprite;
  };
  const css = c => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const hotS = hot.clone().convertLinearToSRGB();
  const baseS = base.clone().convertLinearToSRGB();
  const inner = corona(SUN_R * 5, 0.85, [[0, `${css(hotS)},0.7)`], [0.22, `${css(baseS)},0.45)`], [0.5, `${css(baseS)},0.12)`], [1, `${css(baseS)},0)`]]);
  const outer = corona(SUN_R * 16, 0.55, [[0, `${css(baseS)},0.35)`], [0.3, `${css(baseS)},0.08)`], [1, `${css(baseS)},0)`]]);

  const light = new THREE.PointLight(hot.clone().lerp(new THREE.Color(1, 1, 1), 0.55), 3.2, 0, 0);
  group.add(light);

  // Niewidoczna kula do stukania (stuknięcie słońca wraca do widoku całego układu)
  const hit = new THREE.Mesh(new THREE.SphereGeometry(SUN_R * 1.15, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
  group.add(hit);

  return {
    group, hit,
    update(sec, t) {
      mat.uniforms.time.value = sec;
      const pop = 0.55 + 0.45 * backOut(smooth(0, 0.35, t));
      core.scale.setScalar(pop);
      const breathe = 1 + Math.sin(sec * 1.3) * 0.03;
      inner.scale.setScalar(SUN_R * 5 * pop * breathe);
      outer.material.opacity = 0.55 * (0.85 + Math.sin(sec * 0.7) * 0.15);
      core.rotation.y = sec * 0.04;
    },
  };
}

/* ----- Planety ----- */
// Rodzaj jak łuk na karcie: ulubiona (hot), słaba albo niedokończona (dim), zwykła (mid)
const kindOf = book => (book.unfinished || book.rating === -1 ? 'dim' : book.rating === 1 ? 'hot' : 'mid');

function planetTexture(rand, hueDeg, satPct, light, kind) {
  const W = 256;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const col = (dl, ds = 0, dh = 0) => `hsl(${hueDeg + dh} ${clamp(satPct + ds, 0, 100)}% ${clamp(light + dl, 4, 96)}%)`;
  g.fillStyle = col(0);
  g.fillRect(0, 0, W, H);
  const gas = kind !== 'dim' && rand() < 0.6;
  if (gas) {
    // Gazowy olbrzym: poziome pasy z falującymi brzegami, potem rozmycie
    let y = 0;
    while (y < H) {
      const bh = 3 + rand() * 16;
      g.fillStyle = col((rand() - 0.5) * 30, (rand() - 0.5) * 20, (rand() - 0.5) * 24);
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= W; x += 16) g.lineTo(x, y + Math.sin(x * 0.05 + rand() * 0.6) * 2.5);
      for (let x = W; x >= 0; x -= 16) g.lineTo(x, y + bh + Math.sin(x * 0.04 + 1.3) * 2.5);
      g.closePath();
      g.fill();
      y += bh;
    }
    if (rand() < 0.5) {  // wielka plama burzy
      const sx = rand() * W;
      const sy = H * (0.3 + rand() * 0.4);
      g.fillStyle = col(-14, 10, -12);
      g.beginPath();
      g.ellipse(sx, sy, 14 + rand() * 10, 5 + rand() * 4, 0, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    // Skalista: plamy jaśniejsze i ciemniejsze, kratery, czasem czapy polarne
    for (let i = 0; i < 260; i++) {
      const x = rand() * W;
      const y = rand() * H;
      const r = 2 + rand() ** 2 * 18;
      g.fillStyle = col((rand() - 0.55) * 34, (rand() - 0.5) * 20);
      g.globalAlpha = 0.18 + rand() * 0.3;
      for (const dx of [-W, 0, W]) {
        g.beginPath();
        g.arc(x + dx, y, r, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
    if (kind !== 'dim' && rand() < 0.45) {
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.fillRect(0, 0, W, 6 + rand() * 6);
      g.fillRect(0, H - 5 - rand() * 6, W, 12);
    }
  }
  if ('filter' in g) {  // rozmycie (Safari bez filter: zostaje ostrzej, też ładnie)
    const copy = document.createElement('canvas');
    copy.width = W;
    copy.height = H;
    const cg = copy.getContext('2d');
    cg.filter = 'blur(1.4px)';
    cg.drawImage(c, 0, 0);
    g.clearRect(0, 0, W, H);
    g.drawImage(copy, 0, 0);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function ringTexture(rand, hueDeg) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 4;
  const g = c.getContext('2d');
  for (let x = 0; x < 256; x++) {
    const edge = Math.min(x, 255 - x) / 30;
    const a = clamp(edge, 0, 1) * (0.5 + 0.5 * rand()) * (Math.sin(x * 0.21) * 0.2 + 0.8);
    g.fillStyle = `hsla(${hueDeg + (rand() - 0.5) * 20}, 30%, ${70 + rand() * 22}%, ${a.toFixed(3)})`;
    g.fillRect(x, 0, 1, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Poświata atmosfery: kula odrobinę większa od planety, świeci przy brzegu
function atmosphere(r, color, strength) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: color }, strength: { value: strength } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 color; uniform float strength;
      varying vec3 vN; varying vec3 vV;
      void main() {
        // Od zewnętrznego brzegu kuli (0) do brzegu planety (ok. 0.45 przy kuli 1.12 raza większej)
        float d = clamp(-dot(vN, vV), 0.0, 1.0);
        float a = pow(smoothstep(0.0, 0.45, d), 2.6) * strength;
        gl_FragColor = vec4(color * a, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r * 1.12, 32, 16), mat);
  return mesh;
}

// Ogon komety za planetą: płaska wstęga w płaszczyźnie orbity, zwęża się i gaśnie (kolory przy dodawaniu)
function cometTail(R, width, sweep, color) {
  const N = 72;
  const pos = new Float32Array((N + 1) * 6);
  const col = new Float32Array((N + 1) * 6);
  const idx = [];
  for (let k = 0; k <= N; k++) {
    const f = k / N;                 // 0 = przy planecie, 1 = koniec ogona
    const a = f * sweep;
    const half = (width / 2) * (1 - f) ** 0.8;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    pos.set([(R - half) * c, 0, (R - half) * sn, (R + half) * c, 0, (R + half) * sn], k * 6);
    const b = (1 - f) ** 1.7;
    col.set([color.r * b, color.g * b, color.b * b, color.r * b, color.g * b, color.b * b], k * 6);
    if (k < N) {
      const i = k * 2;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
}

function orbitLine(R, opacity, dashed = false) {
  const pts = [];
  for (let k = 0; k < 256; k++) {
    const a = (k / 256) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0, dashSize: 0.25, gapSize: 0.55, depthWrite: false })
    : new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const line = new THREE.LineLoop(geo, mat);
  if (dashed) line.computeLineDistances();
  line.userData.opacity = opacity;
  return line;
}

function buildEmptyOrbits() {
  return [0, 1, 2, 3, 4].map(i => orbitLine(FIRST_ORBIT + i * 2.1, 0.35, true));
}

function buildPlanets(books, seed, hue, sat) {
  const rand = rand01(`kosmos-${seed}`);
  const list = books.slice().reverse();  // od najstarszej (przy słońcu)
  const maxPages = Math.max(1, ...list.map(b => b.pages || 0));
  const H0 = hue * 360;
  let R = FIRST_ORBIT;
  let prevR = 0;
  return list.map((book, i) => {
    const kind = kindOf(book);
    const mult = Number(book.multiplier) || 1;
    const r = 0.3 + 0.7 * Math.sqrt(Math.min(1, (book.pages || 0) / maxPages));
    if (i) R += prevR + r + ORBIT_GAP;
    prevR = r;

    // Barwa: pokrewna kolorowi osoby; ulubiona cieplejsza i jaśniejsza (jak złoty łuk), słaba szara
    const hueDeg = kind === 'hot' ? H0 - 28 + (rand() - 0.5) * 16 : H0 + (rand() - 0.5) * 120;
    const satPct = kind === 'dim' ? 6 + rand() * 8 : kind === 'hot' ? 80 + rand() * 15 : 30 + sat * 45 + rand() * 15;
    const lightPct = kind === 'dim' ? 38 + rand() * 12 : kind === 'hot' ? 62 + rand() * 10 : 42 + rand() * 18;
    const glowColor = new THREE.Color().setHSL((((hueDeg % 360) + 360) % 360) / 360, kind === 'dim' ? 0.1 : 0.9, kind === 'dim' ? 0.55 : 0.68);

    // Orbita lekko nachylona: płaszczyzna (orbit), w niej obrót po orbicie (pivot), na końcu planeta
    const orbit = new THREE.Group();
    const incl = (rand() - 0.5) * 0.22;
    const node = rand() * Math.PI * 2;
    orbit.rotation.set(incl * Math.cos(node), 0, incl * Math.sin(node));
    const line = orbitLine(R, kind === 'hot' ? 0.2 : kind === 'dim' ? 0.06 : 0.11);
    if (kind === 'hot') line.material.color = glowColor.clone();
    orbit.add(line);
    const pivot = new THREE.Group();
    orbit.add(pivot);
    const tail = cometTail(R, r * 1.2, (0.35 + rand() * 0.5) * (kind === 'dim' ? 0.5 : 1), glowColor.clone().multiplyScalar(kind === 'dim' ? 0.18 : kind === 'hot' ? 0.6 : 0.42));
    pivot.add(tail);

    const body = new THREE.Group();  // pozycja na orbicie
    body.position.x = R;
    pivot.add(body);
    const axis = new THREE.Group();  // nachylenie osi obrotu
    axis.rotation.z = (rand() - 0.5) * 0.8;
    body.add(axis);
    const mat = new THREE.MeshStandardMaterial({
      map: planetTexture(rand, hueDeg, satPct, lightPct, kind),
      roughness: 0.9, metalness: 0,
      emissive: kind === 'hot' ? glowColor.clone().multiplyScalar(0.12) : new THREE.Color(0x000000),
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 24), mat);
    axis.add(sphere);
    if (kind !== 'dim') body.add(atmosphere(r, glowColor.clone(), kind === 'hot' ? 0.9 : 0.45));
    if (kind === 'hot') {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture([[0, 'rgba(255,255,255,0.55)'], [0.35, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]),
        color: glowColor.clone(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      halo.scale.setScalar(r * 6);
      body.add(halo);
    }
    // Mnożnik: pierścienie jak u Saturna (szersze przy większym mnożniku)
    if (mult > 1) {
      const outer = r * (mult >= 2.25 ? 2.6 : 2.05);
      const ringGeo = new THREE.RingGeometry(r * 1.35, outer, 96, 1);
      const uv = ringGeo.attributes.uv;
      const p = ringGeo.attributes.position;
      for (let k = 0; k < uv.count; k++) {
        const d = Math.hypot(p.getX(k), p.getY(k));
        uv.setXY(k, (d - r * 1.35) / (outer - r * 1.35), 0.5);
      }
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({
        map: ringTexture(rand, hueDeg), transparent: true, side: THREE.DoubleSide, roughness: 1, metalness: 0, depthWrite: false,
        emissive: 0xffffff, emissiveIntensity: 0.12,  // z boku oświetlony pierścień i tak trochę widać
      }));
      ring.material.emissiveMap = ring.material.map;
      ring.rotation.x = -Math.PI / 2 + (rand() - 0.5) * 0.3;
      axis.add(ring);
    }
    // Do stukania: większa niewidoczna kula, żeby małe planety dało się trafić palcem
    const hit = new THREE.Mesh(new THREE.SphereGeometry(Math.max(r * 1.8, 0.9), 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    body.add(hit);

    const period = BASE_PERIOD * (R / FIRST_ORBIT) ** 0.85;
    return {
      book, kind, mult, r, R, orbit, pivot, body, sphere, tail, line, hit, index: i,
      phase: rand() * Math.PI * 2, omega: (Math.PI * 2) / period, selfSpin: 0.2 + rand() * 0.5,
    };
  });
}

// Powrót planet na orbity (najpierw wewnętrzne, kolejne co chwilę), potem zwykłe krążenie
function updatePlanet(p, i, count, time, dt, t) {
  const delay = 0.12 + (count > 1 ? i / (count - 1) : 0) * 0.38;
  const q = clamp((t - delay) / 0.42, 0, 1);
  const fly = 1 + 3.2 * (1 - backOut(q));
  p.body.position.x = p.R * fly;
  p.body.scale.setScalar(Math.max(0.001, smooth(0, 0.5, q)));
  p.pivot.rotation.y = p.phase + time * p.omega;
  p.sphere.rotation.y += (dt / 1000) * p.selfSpin;
  const settle = smooth(0.55, 1, q);
  p.tail.material.opacity = settle;
  p.line.material.opacity = p.line.userData.opacity * settle;
}

/* ----- Karta książki pod stukniętą planetą ----- */
function showInfo(view, sc, planet) {
  const { book, kind, mult, index } = planet;
  const count = sc.planets.length;
  const facts = [];
  if (book.pages) facts.push(`${numberPl(book.pages)} ${plural(book.pages, 'strona', 'strony', 'stron')}`);
  if (book.created_at) facts.push(new Date(book.created_at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }));
  if (mult > 1) facts.push(`mnożnik ${String(mult).replace('.', ',')}×`);
  const badge = book.unfinished ? 'Niedokończona' : kind === 'hot' ? 'Ulubiona' : book.rating === -1 ? 'Słaba' : '';

  const cover = el('div', { class: 'cosmos-cover' });
  if (book.cover_url) {
    const img = el('img', { src: book.cover_url, alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    cover.appendChild(img);
  }
  const step = dir => () => {
    const next = sc.planets[index + dir];
    if (next) sc.focusOn(next);
  };
  const prev = el('button', { type: 'button', class: 'cosmos-btn', 'aria-label': 'Starsza książka' }, [icon('chevron-left')]);
  const next = el('button', { type: 'button', class: 'cosmos-btn', 'aria-label': 'Nowsza książka' }, [icon('chevron-right')]);
  prev.disabled = index === 0;
  next.disabled = index === count - 1;
  prev.addEventListener('click', step(-1));
  next.addEventListener('click', step(1));

  const card = el('div', { class: `cosmos-card ${kind}` }, [
    cover,
    el('div', { class: 'cosmos-card-text' }, [
      el('span', { class: 'cosmos-card-kicker', text: `Planeta ${index + 1} z ${count}${badge ? ` · ${badge}` : ''}` }),
      el('strong', { text: book.title || 'bez tytułu' }),
      ...(book.author ? [el('span', { class: 'cosmos-card-author', text: book.author })] : []),
      ...(facts.length ? [el('span', { class: 'cosmos-card-facts', text: facts.join(' · ') })] : []),
    ]),
    el('div', { class: 'cosmos-card-nav' }, [prev, next]),
  ]);
  view.info.replaceChildren(card);
  view.info.hidden = false;
  refreshIcons();
}

function hideInfo(view) {
  view.info.hidden = true;
  view.info.replaceChildren();
}

// Środek słońca na karcie (stąd wlatuje kamera); scena pyta o to w każdej klatce wlotu
function originOf() {
  return cosmos?.origin || { x: innerWidth / 2, y: innerHeight / 2 };
}
