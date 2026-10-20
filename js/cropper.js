import { el } from './ui.js';

const MIN_SIDE = 48;   // najmniejszy dozwolony bok ramki (px na ekranie)
const OUT_MAX = 900;   // dłuższy bok gotowego zdjęcia (~100 KB jako JPEG)

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(file);
  }
}

// Pokazuje zdjęcie z ramką do przesuwania i zmiany rozmiaru (palcem albo myszą).
// Zwraca skadrowany JPEG (Blob) albo null, gdy ktoś anulował.
export async function cropImage(file) {
  const bitmap = await decode(file);

  return new Promise(resolve => {
    const W0 = Math.min(window.innerWidth - 32, 520);
    const H0 = Math.round(window.innerHeight * 0.6);
    const scale = Math.min(W0 / bitmap.width, H0 / bitmap.height, 1);
    const W = Math.round(bitmap.width * scale);
    const H = Math.round(bitmap.height * scale);

    const canvas = el('canvas', { class: 'crop-canvas' });
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, W, H);

    // Ramka startuje z lekkim marginesem, żeby od razu było widać uchwyty
    const inset = 0.06;
    let rect = { x: W * inset, y: H * inset, w: W * (1 - 2 * inset), h: H * (1 - 2 * inset) };

    const dim = el('div', { class: 'crop-dim' });
    const clip = el('div', { class: 'crop-clip' }, [dim]);
    const box = el('div', { class: 'crop-box' });
    const handles = ['nw', 'ne', 'sw', 'se'].map(mode => el('div', { class: `crop-handle crop-handle-${mode}` }));
    box.append(...handles);
    const stage = el('div', { class: 'crop-stage' }, [canvas, clip, box]);
    stage.style.width = `${W}px`;
    stage.style.height = `${H}px`;

    const update = () => {
      for (const node of [dim, box]) {
        node.style.left = `${rect.x}px`;
        node.style.top = `${rect.y}px`;
        node.style.width = `${rect.w}px`;
        node.style.height = `${rect.h}px`;
      }
    };
    update();

    const startDrag = mode => e => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      try { target.setPointerCapture(e.pointerId); } catch { /* np. zdarzenie bez aktywnego wskaźnika */ }
      const start = { px: e.clientX, py: e.clientY, rect: { ...rect } };
      const move = ev => {
        const dx = ev.clientX - start.px;
        const dy = ev.clientY - start.py;
        const r = start.rect;
        if (mode === 'move') {
          rect = { ...r, x: clamp(r.x + dx, 0, W - r.w), y: clamp(r.y + dy, 0, H - r.h) };
        } else {
          let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
          if (mode.includes('w')) x1 = clamp(x1 + dx, 0, x2 - MIN_SIDE);
          if (mode.includes('e')) x2 = clamp(x2 + dx, x1 + MIN_SIDE, W);
          if (mode.includes('n')) y1 = clamp(y1 + dy, 0, y2 - MIN_SIDE);
          if (mode.includes('s')) y2 = clamp(y2 + dy, y1 + MIN_SIDE, H);
          rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        }
        update();
      };
      const end = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', end);
        target.removeEventListener('pointercancel', end);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    };
    box.addEventListener('pointerdown', startDrag('move'));
    handles.forEach((handle, i) => handle.addEventListener('pointerdown', startDrag(['nw', 'ne', 'sw', 'se'][i])));

    const finish = result => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      bitmap.close?.();
      resolve(result);
    };
    const onKey = e => { if (e.key === 'Escape') finish(null); };

    const cancelBtn = el('button', { type: 'button', class: 'btn btn-outline', text: 'Anuluj' });
    const okBtn = el('button', { type: 'button', class: 'btn btn-primary', text: 'Użyj zdjęcia' });
    cancelBtn.addEventListener('click', () => finish(null));
    okBtn.addEventListener('click', () => {
      const f = bitmap.width / W;
      const sx = Math.round(rect.x * f);
      const sy = Math.round(rect.y * f);
      const sw = Math.min(bitmap.width - sx, Math.round(rect.w * f));
      const sh = Math.min(bitmap.height - sy, Math.round(rect.h * f));
      const outScale = Math.min(1, OUT_MAX / Math.max(sw, sh));
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(sw * outScale));
      out.height = Math.max(1, Math.round(sh * outScale));
      out.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, out.width, out.height);
      out.toBlob(blob => finish(blob), 'image/jpeg', 0.85);
    });

    const overlay = el('div', { class: 'crop-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Kadrowanie okładki' }, [
      el('p', { class: 'crop-hint', text: 'Przesuń ramkę lub jej rogi, żeby objąć samą okładkę.' }),
      stage,
      el('div', { class: 'crop-actions' }, [cancelBtn, okBtn]),
    ]);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}
