import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { handleDropReading, loadReads } from './data.js';
import { formatMultiplier, handleDelete, todayInputValue } from './form.js';
import { coverEl, renderCoverPicker, settleBookInfo, titleHue } from './shelf.js';
import { state } from './state.js';
import { formatDay } from './stats.js';
import { supabaseClient } from './supabase.js';
import { el, friendlyError, icon, refreshIcons, showToast } from './ui.js';

/* ----------------- Edycja książki (jeden ekran dla wszystkiego) ----------------- */
// Ten sam ekran edytuje przeczytaną książkę (reads), zaczętą („Teraz czytam”, reading_now)
// i czekającą w kolejce (reading_queue): okładka, tytuł, autor, rok, a dla przeczytanych także
// strony, mnożniki, „niedokończona” i data skończenia. Zmiany zapisują się dopiero przyciskiem
// „Zapisz”, a usuwanie też jest tutaj, więc nigdzie indziej nie trzeba tego szukać.
// Ekran ma własny wpis w historii: „Wstecz” na telefonie go zamyka.

const KINDS = {
  reads: { heading: 'Edytuj książkę', remove: 'Usuń z przeczytanych' },
  reading_now: { heading: 'Edytuj czytaną książkę', remove: 'Usuń z „Teraz czytam”' },
  reading_queue: { heading: 'Edytuj książkę z kolejki', remove: 'Usuń z kolejki' },
};
const MAX_PAGES = 5000;

let editor = null;  // { root, close } otwartego edytora

// Data lokalna jako wartość pola <input type="date"> (RRRR-MM-DD)
function dayInputValue(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Dzień z pola daty jako chwila: dziś = teraz, wcześniejszy dzień = jego południe (bez kłopotów ze strefą)
function dayToIso(value) {
  if (value === todayInputValue()) return new Date().toISOString();
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toISOString();
}

const product = values => Math.round(values.reduce((m, v) => m * v, 1) * 10000) / 10000;

// Które mnożniki były zaznaczone: z zapisanych nazw, a dla starszych wpisów (bez nazw) zestaw,
// który daje zapisany mnożnik. null = nie da się go złożyć z obecnych opcji.
function initialLabels(row) {
  const mult = Number(row.multiplier) || 1;
  const byLabel = new Map(state.multipliers.map(m => [m.label, m.value]));
  const saved = row.multiplier_labels;
  if (saved && saved.every(l => byLabel.has(l)) && Math.abs(product(saved.map(l => byLabel.get(l))) - mult) < 1e-4) return new Set(saved);
  const opts = state.multipliers;
  for (let mask = 0; mask < (1 << opts.length); mask++) {
    const picked = opts.filter((_, i) => mask & (1 << i));
    if (Math.abs(product(picked.map(m => m.value)) - mult) < 1e-4) return new Set(picked.map(m => m.label));
  }
  return null;
}

// Kończy się po zamknięciu (cofnięcie historii jest asynchroniczne), żeby kolejne okno,
// otwarte zaraz potem, nie zostało przez nie zamknięte
export function closeBookEditor() {
  if (!editor) return Promise.resolve();
  if (!history.state?.bookEditor) {
    editor.close();
    return Promise.resolve();
  }
  return new Promise(resolve => {
    window.addEventListener('popstate', () => resolve(), { once: true });
    history.back();  // popstate zamknie ekran
  });
}

window.addEventListener('popstate', () => editor?.close());

// kind: 'reads' | 'reading_now' | 'reading_queue'; onSaved / onRemoved: odświeżenie miejsca, z którego otwarto
export function openBookEditor(kind, row, { onSaved, onRemoved } = {}) {
  editor?.close();
  const cfg = KINDS[kind];
  const isRead = kind === 'reads';
  const maxYear = new Date().getFullYear() + 1;

  // Okładka i informacje z baz książek: zmienione w wyszukiwarce, zapisane razem z resztą
  let cover = { cover_url: row.cover_url ?? null, info_url: row.info_url ?? null, description: row.description ?? null };
  let coverChanged = false;

  /* --- Nagłówek: rozmyta okładka w tle, okładka, tytuł, autor, rok --- */
  const backdrop = el('div', { class: 'be-backdrop', 'aria-hidden': 'true' });
  const coverSlot = el('span', { class: 'be-cover-img' });
  const coverBtn = el('button', { type: 'button', class: 'be-cover', 'aria-label': 'Zmień okładkę' }, [
    coverSlot,
    el('span', { class: 'be-cover-badge' }, [icon('image'), el('span', { text: 'Zmień' })]),
  ]);
  const title = el('input', { type: 'text', class: 'be-title', maxlength: '300', 'aria-label': 'Tytuł', placeholder: 'Tytuł książki', autocomplete: 'off' });
  title.value = row.title || '';
  const author = el('input', { type: 'text', class: 'be-author', maxlength: '200', 'aria-label': 'Autor', placeholder: 'Autor', autocomplete: 'off' });
  author.value = row.author || '';
  const year = el('input', { type: 'number', class: 'be-year', inputmode: 'numeric', min: '0', max: String(maxYear), step: '1', 'aria-label': 'Rok wydania', placeholder: 'rok', autocomplete: 'off' });
  year.value = row.published_year ?? '';

  const drawCover = () => {
    const book = { title: title.value.trim() || row.title, author: author.value.trim(), cover_url: cover.cover_url };
    coverSlot.replaceChildren(coverEl(book, 'large'));
    if (cover.cover_url) {
      backdrop.style.backgroundImage = `url("${cover.cover_url.replace(/"/g, '%22')}")`;
      backdrop.classList.remove('flat');
    } else {
      const h = titleHue(book.title);
      backdrop.style.backgroundImage = `linear-gradient(160deg, hsl(${h} 55% 45%), hsl(${(h + 40) % 360} 55% 25%))`;
      backdrop.classList.add('flat');
    }
  };

  /* --- Przeczytana: strony, niedokończona, mnożniki, punkty na żywo --- */
  const sections = [];
  const pointsValue = el('strong', { class: 'be-points-value' });
  const pointsCalc = el('span', { class: 'be-points-calc' });
  let pages = null;
  let unfinished = null;
  let selected = null;     // Set nazw zaznaczonych mnożników
  let keepOld = false;     // mnożnik spoza obecnych opcji zostaje, dopóki nikt nie ruszy zaznaczenia
  const multiplierNow = () => (keepOld ? Number(row.multiplier) : product(state.multipliers.filter(m => selected.has(m.label)).map(m => m.value)));

  const updatePoints = () => {
    if (!isRead) return;
    const p = parseInt(pages.value, 10) || 0;
    const mult = multiplierNow();
    pointsValue.textContent = String(bookPoints({ pages: p, multiplier: mult }));
    pointsCalc.textContent = mult === 1 ? `${p} str.` : `${p} str. × ${formatMultiplier(mult).replace('.', ',')}`;
  };

  if (isRead) {
    pages = el('input', { type: 'number', class: 'be-pages', inputmode: 'numeric', min: '1', max: String(MAX_PAGES), step: '1', 'aria-label': 'Liczba stron' });
    pages.value = row.pages ?? '';
    const stepBtn = (delta, label) => {
      const b = el('button', { type: 'button', class: 'be-step', 'aria-label': `${delta > 0 ? 'Dodaj' : 'Odejmij'} ${Math.abs(delta)} stron`, text: label });
      b.addEventListener('click', () => {
        pages.value = String(Math.min(MAX_PAGES, Math.max(1, (parseInt(pages.value, 10) || 0) + delta)));
        updatePoints();
      });
      return b;
    };
    pages.addEventListener('input', updatePoints);

    unfinished = el('button', { type: 'button', class: 'be-switch-row', role: 'switch', 'aria-checked': String(!!row.unfinished) }, [
      el('span', { class: 'be-switch-text' }, [
        el('span', { text: 'Niedokończona' }),
        el('small', { text: 'Liczą się przeczytane strony' }),
      ]),
      el('span', { class: `switch${row.unfinished ? ' on' : ''}`, 'aria-hidden': 'true' }),
    ]);
    unfinished.addEventListener('click', () => {
      const on = unfinished.getAttribute('aria-checked') !== 'true';
      unfinished.setAttribute('aria-checked', String(on));
      unfinished.querySelector('.switch').classList.toggle('on', on);
    });

    sections.push(el('section', { class: 'be-card' }, [
      el('h3', { class: 'be-card-title' }, [icon('layers'), el('span', { text: 'Strony' })]),
      el('div', { class: 'be-stepper' }, [stepBtn(-10, '−10'), pages, stepBtn(10, '+10')]),
      unfinished,
    ]));

    // Mnożniki jako przełączane „pigułki”
    const initial = initialLabels(row);
    selected = initial || new Set();
    keepOld = !initial;
    const note = el('p', { class: 'be-note', hidden: '' });
    if (keepOld) {
      note.textContent = `Ten wpis ma mnożnik ${formatMultiplier(row.multiplier).replace('.', ',')}×, którego nie da się złożyć z obecnych opcji. Zostanie, jeśli nic tu nie zmienisz.`;
      note.hidden = false;
    }
    const chips = state.multipliers.map(m => {
      const chip = el('button', { type: 'button', class: 'be-chip', 'aria-pressed': String(selected.has(m.label)) }, [
        el('b', { text: `${formatMultiplier(m.value).replace('.', ',')}×` }),
        el('span', { text: m.label }),
      ]);
      chip.addEventListener('click', () => {
        keepOld = false;
        note.hidden = true;
        if (selected.has(m.label)) selected.delete(m.label);
        else selected.add(m.label);
        chip.setAttribute('aria-pressed', String(selected.has(m.label)));
        updatePoints();
      });
      return chip;
    });
    sections.push(el('section', { class: 'be-card' }, [
      el('h3', { class: 'be-card-title' }, [icon('sparkles'), el('span', { text: 'Mnożniki' })]),
      chips.length ? el('div', { class: 'be-chips' }, chips) : el('p', { class: 'be-note', text: 'Brak mnożników.' }),
      note,
    ]));
  }

  /* --- Daty --- */
  let finishedDate = null;
  let startedDate = null;
  if (isRead) {
    finishedDate = el('input', { type: 'date', class: 'plain-input be-date', max: todayInputValue(), 'aria-label': 'Data skończenia' });
    finishedDate.value = dayInputValue(row.created_at);
    if (row.started_at) finishedDate.min = dayInputValue(row.started_at);
    sections.push(el('section', { class: 'be-card' }, [
      el('h3', { class: 'be-card-title' }, [icon('calendar'), el('span', { text: 'Daty' })]),
      el('label', { class: 'be-field' }, [el('span', { text: 'Skończona' }), finishedDate]),
      ...(row.started_at ? [el('p', { class: 'be-note', text: `Zaczęta ${formatDay(new Date(row.started_at))} ${new Date(row.started_at).getFullYear()}` })] : []),
    ]));
  } else if (kind === 'reading_now') {
    startedDate = el('input', { type: 'date', class: 'plain-input be-date', max: todayInputValue(), 'aria-label': 'Data rozpoczęcia' });
    startedDate.value = dayInputValue(row.started_at);
    sections.push(el('section', { class: 'be-card' }, [
      el('h3', { class: 'be-card-title' }, [icon('calendar'), el('span', { text: 'Daty' })]),
      el('label', { class: 'be-field' }, [el('span', { text: 'Zaczęta' }), startedDate]),
    ]));
  }

  // Zaczęta i w kolejce: liczba stron wydania (podpowiedź przy kończeniu książki)
  let pageCount = null;
  if (!isRead) {
    pageCount = el('input', { type: 'number', class: 'plain-input be-date', inputmode: 'numeric', min: '1', max: String(MAX_PAGES), step: '1', placeholder: 'np. 320', 'aria-label': 'Liczba stron wydania' });
    pageCount.value = row.page_count ?? '';
    sections.push(el('section', { class: 'be-card' }, [
      el('h3', { class: 'be-card-title' }, [icon('layers'), el('span', { text: 'Strony' })]),
      el('label', { class: 'be-field' }, [el('span', { text: 'W tym wydaniu' }), pageCount]),
      el('p', { class: 'be-note', text: 'Podpowiemy je, gdy skończysz książkę.' }),
    ]));
  }

  /* --- Usuwanie --- */
  const removeBtn = el('button', { type: 'button', class: 'be-remove' }, [icon('trash-2'), el('span', { text: cfg.remove })]);
  removeBtn.addEventListener('click', async () => {
    let removed = false;
    if (kind === 'reads') removed = await handleDelete(row);
    else if (kind === 'reading_now') removed = await handleDropReading(row);
    else {
      if (!confirm(`Usunąć „${row.title}” z kolejki?`)) return;
      const { data, error } = await supabaseClient.from('reading_queue').delete().eq('id', row.id).select('id');
      if (error || !data?.length) showToast('Nie udało się usunąć: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
      else {
        state.myQueue = state.myQueue.filter(q => q.id !== row.id);
        removed = true;
      }
    }
    if (!removed) return;
    await closeBookEditor();
    onRemoved?.();
  });

  /* --- Zapis --- */
  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary btn-block btn-lg be-save' }, [icon('check'), el('span', { text: 'Zapisz' })]);
  const fail = (text, field) => {
    showToast(text);
    field?.focus();
  };
  saveBtn.addEventListener('click', async () => {
    const titleText = title.value.trim();
    if (!titleText) return fail('Podaj tytuł książki.', title);
    const yearText = year.value.trim();
    const publishedYear = yearText === '' ? null : Number(yearText);
    if (publishedYear !== null && (!Number.isInteger(publishedYear) || publishedYear < 0 || publishedYear > maxYear)) {
      return fail(`Rok wydania: liczba od 0 do ${maxYear}.`, year);
    }
    const values = { title: titleText, author: author.value.trim().slice(0, 200) || null, published_year: publishedYear };

    if (isRead) {
      const p = parseInt(pages.value, 10);
      if (!Number.isInteger(p) || p < 1 || p > MAX_PAGES) return fail(`Liczba stron: od 1 do ${MAX_PAGES}.`, pages);
      values.pages = p;
      values.multiplier = multiplierNow();
      values.multiplier_labels = keepOld ? row.multiplier_labels ?? null : state.multipliers.filter(m => selected.has(m.label)).map(m => m.label);
      values.unfinished = unfinished.getAttribute('aria-checked') === 'true';
      const day = finishedDate.value;
      if (day && day !== dayInputValue(row.created_at)) {
        if (day > todayInputValue()) return fail('Data skończenia nie może być w przyszłości.', finishedDate);
        if (row.started_at && day < dayInputValue(row.started_at)) {
          return fail(`Data skończenia nie może być wcześniejsza niż rozpoczęcie (${formatDay(new Date(row.started_at))}).`, finishedDate);
        }
        let iso = dayToIso(day);
        // Ten sam dzień co rozpoczęcie: nie wcześniej niż moment rozpoczęcia (baza wymaga started_at <= created_at)
        if (row.started_at && iso < row.started_at) iso = row.started_at;
        values.created_at = iso;
      }
    } else {
      const pc = pageCount.value.trim();
      const count = pc === '' ? null : Number(pc);
      if (count !== null && (!Number.isInteger(count) || count < 1 || count > MAX_PAGES)) return fail(`Liczba stron: od 1 do ${MAX_PAGES}.`, pageCount);
      values.page_count = count;
      if (startedDate) {
        const day = startedDate.value;
        if (day && day !== dayInputValue(row.started_at)) {
          if (day > todayInputValue()) return fail('Data rozpoczęcia nie może być w przyszłości.', startedDate);
          values.started_at = dayToIso(day);
        }
      }
    }

    saveBtn.disabled = true;
    if (coverChanged) {
      Object.assign(values, cover, { info_checked_at: new Date().toISOString() });
    } else {
      // Serwer uzupełnia dane tylko nowym wpisom i nadpisałby wtedy autora i rok: niech zrobi to najpierw
      Object.assign(values, await settleBookInfo(kind, row));
    }
    const { data, error } = await supabaseClient.from(kind).update(values).eq('id', row.id).select('id');
    saveBtn.disabled = false;
    if (error || !data?.length) {
      showToast('Nie udało się zapisać: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
      return;
    }
    Object.assign(row, values);
    await closeBookEditor();
    showToast('Zapisano.');
    await loadReads();
    onSaved?.();
  });

  /* --- Wybór okładki: osobny widok w tym samym ekranie --- */
  const pickerBody = el('div', { class: 'cover-picker' });
  const pickerBack = el('button', { type: 'button', class: 'be-icon-btn', 'aria-label': 'Wróć do edycji' }, [icon('arrow-left')]);
  const picker = el('div', { class: 'be-picker', hidden: '' }, [
    el('header', { class: 'be-bar' }, [pickerBack, el('h2', { class: 'be-bar-title', text: 'Okładka' }), el('span')]),
    el('div', { class: 'be-picker-body' }, [pickerBody]),
  ]);
  const closePicker = () => {
    picker.hidden = true;
    main.hidden = false;
  };
  pickerBack.addEventListener('click', closePicker);
  coverBtn.addEventListener('click', () => {
    main.hidden = true;
    picker.hidden = false;
    // Zdjęcie własnej okładki zachowuje to, co już wpisano w polach
    const current = { ...row, title: title.value.trim() || row.title, author: author.value.trim() || null, published_year: year.value ? Number(year.value) : null };
    renderCoverPicker(pickerBody, current, [current.title, current.author].filter(Boolean).join(' '), (_, info) => {
      cover = { cover_url: info.cover_url ?? null, info_url: info.info_url ?? null, description: info.description ?? null };
      coverChanged = true;
      // Dopasowanie z bazy książek uzupełnia autora i rok (można je jeszcze poprawić)
      if (info.author) author.value = info.author;
      if (info.published_year) year.value = info.published_year;
      if (pageCount && info.page_count) pageCount.value = info.page_count;
      drawCover();
      closePicker();
      refreshIcons();
    });
    picker.scrollTop = 0;
  });

  /* --- Złożenie ekranu --- */
  const closeBtn = el('button', { type: 'button', class: 'be-icon-btn', 'aria-label': 'Zamknij bez zapisywania' }, [icon('x')]);
  closeBtn.addEventListener('click', closeBookEditor);
  const main = el('div', { class: 'be-main' }, [
    backdrop,
    el('header', { class: 'be-bar' }, [closeBtn, el('h2', { class: 'be-bar-title', text: cfg.heading }), el('span')]),
    el('div', { class: 'be-hero' }, [
      coverBtn,
      title,
      el('div', { class: 'be-byline' }, [author, el('span', { class: 'be-dot', text: '·' }), year]),
      ...(isRead ? [el('div', { class: 'be-points' }, [pointsValue, el('small', { text: 'pkt' }), pointsCalc])] : []),
    ]),
    el('div', { class: 'be-body' }, [...sections, removeBtn]),
    el('footer', { class: 'be-footer' }, [saveBtn]),
  ]);
  const root = el('div', { class: 'book-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': cfg.heading }, [main, picker]);
  title.addEventListener('change', drawCover);

  const onKey = e => {
    if (e.key !== 'Escape') return;
    if (!picker.hidden) closePicker();
    else closeBookEditor();
  };
  document.addEventListener('keydown', onKey);
  document.body.classList.add('be-lock');
  document.body.appendChild(root);
  history.pushState({ bookEditor: true }, '');
  editor = {
    root,
    close() {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('be-lock');
      root.remove();
      editor = null;
    },
  };
  drawCover();
  updatePoints();
  refreshIcons();
}
