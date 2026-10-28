import { titleHue } from './shelf.js';

/* ----------------- Tło poza Startem: poświata w kolorze okładki ----------------- */
// Na Starcie w tle jest ściana okładek (js/coverwall.js). Przy wyjściu ze Startu ściana płynnie gaśnie,
// a tło przechodzi w miękką poświatę w kolorze jednej z okładek ze ściany (losowanej przy każdym wyjściu).
// Poświata zostaje delikatnie na pozostałych ekranach, a po powrocie na Start ściana znowu się wyłania.
// Kolory okładek liczymy z małej kopii obrazka (okładki z naszego bucketu mają nagłówki CORS); okładki
// bez obrazka dają kolor swojej zaślepki.
const SAMPLES = 8;
const sampled = new Map();  // adres okładki → kolor albo null (nie da się odczytać)
let candidates = [];
let asleep = null;          // animacje ściany zatrzymane, gdy jej nie widać

async function coverColor(url) {
  if (sampled.has(url)) return sampled.get(url);
  let color = null;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 12;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 12, 12);
    const data = ctx.getImageData(0, 0, 12, 12).data;
    // Średnia ważona „żywością” piksela: liczą się kolory, a nie biel, czerń i szarości
    let r = 0, g = 0, b = 0, sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const max = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
      const min = Math.min(data[i], data[i + 1], data[i + 2]) / 255;
      const light = (max + min) / 2;
      const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
      const weight = sat * sat * Math.max(0, 1 - Math.abs(light - 0.5) * 1.7) + 0.002;
      r += data[i] * weight;
      g += data[i + 1] * weight;
      b += data[i + 2] * weight;
      sum += weight;
    }
    color = toVivid(r / sum, g / sum, b / sum);
  } catch {
    color = null;
  }
  sampled.set(url, color);
  return color;
}

// Średni kolor okładki jako odcień o stałej jasności i żywym nasyceniu (tło ma być kolorem, nie szarością)
function toVivid(r, g, b) {
  const [R, G, B] = [r, g, b].map(v => v / 255);
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  if (d < 0.04) return null;
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return `hsl(${Math.round((h * 60 + 360) % 360)} 70% 50%)`;
}

const randomOf = list => list[Math.floor(Math.random() * list.length)];

// Wołane po zbudowaniu ściany: kolory kilku losowych okładek z niej
export async function updateAmbientColors(books) {
  const withCovers = books.filter(b => b.cover_url);
  const picks = [...withCovers].sort(() => Math.random() - 0.5).slice(0, SAMPLES);
  const colors = (await Promise.all(picks.map(b => coverColor(b.cover_url)))).filter(Boolean);
  // Bez odczytanych okładek: kolory zaślepek (te same odcienie co kafelki bez obrazka)
  candidates = colors.length ? colors : books.slice(0, SAMPLES).map(b => `hsl(${titleHue(b.title)} 60% 48%)`);
  if (!document.documentElement.style.getPropertyValue('--ambient') && candidates.length) {
    document.documentElement.style.setProperty('--ambient', randomOf(candidates));
  }
}

function wallAnimations() {
  return [...document.querySelectorAll('#cover-bg .tv-wall-strip')].flatMap(strip => strip.getAnimations());
}

// Zmiana ekranu: przy wyjściu ze Startu nowy kolor poświaty (zanim się pojawi), a ściana po zgaśnięciu
// przestaje się ruszać; po powrocie rusza dokładnie z tego samego miejsca
export function onScreenShown(name, previous) {
  if (name === 'start') {
    clearTimeout(asleep?.timer);
    asleep?.anims.forEach(anim => anim.play());
    asleep = null;
    return;
  }
  if (previous === 'start' && candidates.length) {
    document.documentElement.style.setProperty('--ambient', randomOf(candidates));
  }
  if (!asleep) {
    asleep = { anims: [], timer: setTimeout(() => {
      if (!asleep) return;
      asleep.anims = wallAnimations().filter(anim => anim.playState === 'running');
      asleep.anims.forEach(anim => anim.pause());
    }, 800) };
  }
}
