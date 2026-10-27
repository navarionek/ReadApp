import { el, icon, refreshIcons } from './ui.js';

/* ----------------- Wybór własnego koloru ----------------- */
// Własny wybierak zamiast <input type="color">: na iPhonie systemowy nie dawał się otworzyć
// z menu, a na Androidzie zaczynał od gotowych kolorów. Tu od razu dowolny kolor: kwadrat
// (nasycenie w poziomie, jasność w pionie), pasek barwy i podgląd. Zwraca #rrggbb albo null.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hsvToHex(h, s, v) {
  const f = n => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

function hexToHsv(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return { h: 230, s: 0.65, v: 0.9 };
  const [r, g, b] = [m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function openColorPicker(initial) {
  return new Promise(resolve => {
    let { h, s, v } = hexToHsv(initial);

    const knob = el('span', { class: 'cp-knob' });
    const area = el('div', { class: 'cp-area', role: 'slider', 'aria-label': 'Nasycenie i jasność', tabindex: '0' }, [knob]);
    const hue = el('input', { type: 'range', class: 'cp-hue', min: '0', max: '359', step: '1', 'aria-label': 'Barwa' });
    const swatch = el('span', { class: 'cp-swatch' });
    const hexText = el('strong', { class: 'cp-hex' });
    const bar = el('span', { class: 'cp-sample-bar' });
    const ok = el('button', { type: 'button', class: 'btn btn-primary' }, [icon('check'), el('span', { text: 'Zapisz' })]);
    const cancel = el('button', { type: 'button', class: 'btn btn-outline', text: 'Anuluj' });

    const draw = () => {
      const hex = hsvToHex(h, s, v);
      area.style.setProperty('--hue', `hsl(${h} 100% 50%)`);
      hue.value = String(Math.round(h));
      knob.style.left = `${s * 100}%`;
      knob.style.top = `${(1 - v) * 100}%`;
      knob.style.background = hex;
      swatch.style.background = hex;
      bar.style.background = hex;
      hexText.textContent = hex.toUpperCase();
    };

    // Przeciąganie po kwadracie (palcem i myszą)
    const pick = e => {
      const r = area.getBoundingClientRect();
      s = clamp((e.clientX - r.left) / r.width, 0, 1);
      v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      draw();
    };
    area.addEventListener('pointerdown', e => {
      area.setPointerCapture(e.pointerId);
      pick(e);
    });
    area.addEventListener('pointermove', e => {
      if (area.hasPointerCapture(e.pointerId)) pick(e);
    });
    area.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') s = clamp(s - step, 0, 1);
      else if (e.key === 'ArrowRight') s = clamp(s + step, 0, 1);
      else if (e.key === 'ArrowUp') v = clamp(v + step, 0, 1);
      else if (e.key === 'ArrowDown') v = clamp(v - step, 0, 1);
      else return;
      e.preventDefault();
      draw();
    });
    hue.addEventListener('input', () => {
      h = Number(hue.value);
      draw();
    });

    const overlay = el('div', { class: 'modal color-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cp-title' }, [
      el('div', { class: 'modal-content color-picker' }, [
        el('h2', { id: 'cp-title', class: 'modal-title', text: 'Mój kolor' }),
        area,
        hue,
        el('div', { class: 'cp-preview' }, [
          swatch,
          el('span', { class: 'cp-preview-text' }, [hexText, el('span', { class: 'cp-sample' }, [el('span', { text: 'Twój pasek w rankingu' }), bar])]),
        ]),
        el('div', { class: 'oath-actions' }, [cancel, ok]),
      ]),
    ]);

    const finish = answer => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(answer);
    };
    const onKey = e => { if (e.key === 'Escape') finish(null); };
    ok.addEventListener('click', () => finish(hsvToHex(h, s, v)));
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    draw();
    refreshIcons();
  });
}
