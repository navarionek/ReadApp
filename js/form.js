import { renderMultiplierAdmin } from './admin.js';
import { loadReads } from './data.js';
import { goTo } from './shell.js';
import { state } from './state.js';
import { formatDay } from './stats.js';
import { supabaseClient } from './supabase.js';
import { DAY_MS, el, friendlyError, hideError, refreshIcons, showError, showToast } from './ui.js';

/* ----------------- Mnożniki (z tabeli, zarządza admin) ----------------- */

export function formatMultiplier(value) {
  return String(Number(value));
}

export async function loadMultipliers() {
  const { data, error } = await supabaseClient
    .from('multipliers')
    .select('id, label, value')
    .order('id');

  if (error) {
    console.error('Error loading multipliers:', error);
    return;
  }
  state.multipliers = data.map(m => ({ ...m, value: Number(m.value) }));
  renderMultiplierCheckboxes();
  if (state.isAdmin) renderMultiplierAdmin();
  refreshIcons();
}

export function renderMultiplierCheckboxes() {
  const container = document.getElementById('multiplier-container');
  if (!state.multipliers.length) {
    container.replaceChildren(el('span', { class: 'hint', text: 'Brak mnożników.' }));
    return;
  }
  container.replaceChildren(...state.multipliers.map(m => {
    const checkbox = el('input', { type: 'checkbox', class: 'multiplier-checkbox', value: String(m.value), 'data-label': m.label });
    checkbox.addEventListener('change', () => {
      state.multiplierTouched = true;
      document.getElementById('multiplier-note').hidden = true;
    });
    return el('label', { class: 'checkbox-label' }, [
      checkbox,
      el('span', { class: 'check-text', text: `${formatMultiplier(m.value)}x ${m.label}` }),
    ]);
  }));
}

/* ----------------- Form: add & edit ----------------- */
export function multiplierCheckboxes() {
  return [...document.querySelectorAll('.multiplier-checkbox')];
}

export function readMultiplier() {
  // Edycja wpisu z mnożnikiem spoza obecnych opcji: bez ruszania checkboxów zostaje stary
  if (state.editingId && !state.multiplierTouched && state.editingMultiplier !== null) return state.editingMultiplier;
  const product = multiplierCheckboxes()
    .filter(cb => cb.checked)
    .reduce((m, cb) => m * parseFloat(cb.value), 1);
  return Math.round(product * 10000) / 10000;
}

// Odwrotność readMultiplier: znajdź zestaw checkboxów, który daje zapisany mnożnik
// Zaznacza checkboxy według zapisanych nazw; false, gdy nie dają zapisanego mnożnika (np. zmieniono wartości)
export function applyLabels(labels, multiplier) {
  const boxes = multiplierCheckboxes();
  const product = boxes
    .filter(cb => labels.includes(cb.dataset.label))
    .reduce((m, cb) => m * parseFloat(cb.value), 1);
  if (Math.abs(product - multiplier) >= 1e-4) return false;
  boxes.forEach(cb => { cb.checked = labels.includes(cb.dataset.label); });
  return true;
}

// Nazwy zaznaczonych mnożników (do odznak); przy edycji bez ruszania zaznaczenia zostaje stary zapis
export function readMultiplierLabels() {
  if (state.editingId && !state.multiplierTouched) return state.editingLabels;
  return multiplierCheckboxes().filter(cb => cb.checked).map(cb => cb.dataset.label);
}

export function applyMultiplier(multiplier) {
  const boxes = multiplierCheckboxes();
  for (let mask = 0; mask < (1 << boxes.length); mask++) {
    const product = boxes.reduce((m, cb, i) => (mask & (1 << i) ? m * parseFloat(cb.value) : m), 1);
    if (Math.abs(product - multiplier) < 1e-4) {
      boxes.forEach((cb, i) => { cb.checked = !!(mask & (1 << i)); });
      return true;
    }
  }
  boxes.forEach(cb => { cb.checked = false; });
  return false;
}

/* ----------------- Tryb formularza: skończona / zaczęta / kończenie zaczętej ----------------- */

export function todayInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysSince(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS));
}

export function myReadingNow() {
  return state.readingNow.filter(item => item.user_id === state.currentUser?.id);
}

export function selectFinishing(item) {
  state.finishing = item ? { id: item.id, title: item.title, startedAt: item.started_at } : null;
  document.getElementById('title').value = item ? item.title : '';
}

// Lista „Którą książkę kończysz?”: zaczęte książki + „Inna książka”
export function renderFinishPick() {
  const select = document.getElementById('finish-pick');
  const items = myReadingNow();
  select.replaceChildren(
    ...items.map(item => el('option', { value: String(item.id), text: `${item.title} (od ${formatDay(new Date(item.started_at))})` })),
    el('option', { value: 'new', text: 'Inna książka (wpisz tytuł)' }),
  );
  select.value = state.finishing ? String(state.finishing.id) : 'new';
}

// Domyślnie kończymy pierwszą zaczętą książkę, jeśli formularz jest „pusty”
export function applyFinishDefault() {
  if (state.editingId || state.entryMode !== 'finished' || state.finishing || state.finishPickedNew) return;
  const first = myReadingNow()[0];
  if (first) selectFinishing(first);
}

export function updateFormUI() {
  const isEditing = !!state.editingId;
  const started = state.entryMode === 'started' && !isEditing;
  const canPick = !isEditing && !started && myReadingNow().length > 0;

  document.getElementById('form-title').textContent =
    isEditing ? 'Edytuj wpis' : started ? 'Zaczynam czytać' : 'Dodaj postęp';
  document.getElementById('submit-label').textContent =
    isEditing ? 'Zapisz zmiany' : started ? 'Zacznij czytać' : state.finishing ? 'Dodaj skończoną książkę' : 'Dodaj wpis';

  document.getElementById('mode-toggle').hidden = isEditing;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    const active = btn.dataset.mode === state.entryMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  document.getElementById('finish-pick-group').hidden = !canPick;
  if (canPick) renderFinishPick();
  // Tytuł bierze się z wybranej zaczętej książki, więc pole jest wtedy schowane
  document.getElementById('title-group').hidden = !!state.finishing && !started;
  document.getElementById('started-group').hidden = !started;
  document.getElementById('pages-group').hidden = started;
  document.getElementById('multiplier-group').hidden = started;
  document.getElementById('unfinished-group').hidden = started;
  document.getElementById('pages').required = !started;

  const note = document.getElementById('finishing-note');
  note.hidden = !state.finishing || started;
  if (state.finishing) {
    const days = daysSince(state.finishing.startedAt);
    note.textContent = `Zaczęte ${formatDay(new Date(state.finishing.startedAt))} (${days} ${days === 1 ? 'dzień' : 'dni'} temu). Wpisz liczbę stron.`;
  }

  document.getElementById('cancel-edit-btn').hidden = !isEditing;
}

export function setEntryMode(mode) {
  state.entryMode = mode;
  if (mode === 'started') {
    // Nowa zaczęta książka: zaczynamy od pustego tytułu; po powrocie znowu podpowiemy zaczętą
    selectFinishing(null);
    state.finishPickedNew = false;
  } else {
    applyFinishDefault();
  }
  hideError();
  updateFormUI();
}

export function handleFinishPick() {
  const value = document.getElementById('finish-pick').value;
  state.finishPickedNew = value === 'new';
  selectFinishing(myReadingNow().find(item => String(item.id) === value) || null);
  hideError();
  updateFormUI();
  if (state.finishPickedNew) document.getElementById('title').focus({ preventScroll: true });
}

export function startFinishing(item) {
  cancelEdit();
  selectFinishing(item);
  updateFormUI();
  goTo('dodaj');
  document.getElementById('pages').focus({ preventScroll: true });
}

export function startEdit(book) {
  state.finishing = null;
  state.editingId = book.id;
  document.getElementById('title').value = book.title || '';
  document.getElementById('pages').value = book.pages;
  document.getElementById('unfinished').checked = !!book.unfinished;
  state.editingMultiplier = Number(book.multiplier);
  state.multiplierTouched = false;
  const note = document.getElementById('multiplier-note');
  state.editingLabels = book.multiplier_labels ?? null;
  const matched = (state.editingLabels && applyLabels(state.editingLabels, state.editingMultiplier))
    || applyMultiplier(state.editingMultiplier);
  const unknownLabels = matched && state.editingLabels === null && state.editingMultiplier !== 1;
  note.textContent = unknownLabels
    ? 'Nie wiadomo, które mnożniki zaznaczono przy tym wpisie. Wybierz właściwe, żeby liczyły się do odznak.'
    : matched
    ? ''
    : `Ten wpis ma mnożnik ${formatMultiplier(state.editingMultiplier)}x, którego nie da się złożyć z obecnych opcji. Zostanie zachowany, jeśli nie zmienisz zaznaczenia.`;
  note.hidden = matched && !unknownLabels;
  hideError();
  updateFormUI();
  goTo('dodaj');
  document.getElementById('title').focus({ preventScroll: true });
}

export function cancelEdit() {
  state.editingId = null;
  state.editingMultiplier = null;
  state.editingLabels = null;
  state.multiplierTouched = false;
  state.finishing = null;
  state.finishPickedNew = false;
  state.entryMode = 'finished';
  document.getElementById('multiplier-note').hidden = true;
  document.getElementById('read-form').reset();
  document.getElementById('started-date').value = todayInputValue();
  applyFinishDefault();
  hideError();
  updateFormUI();
}

export async function handleDelete(book) {
  if (!confirm(`Usunąć wpis „${book.title || 'bez tytułu'}”?`)) return;

  const { data, error } = await supabaseClient
    .from('reads')
    .delete()
    .eq('id', book.id)
    .select('id');

  if (error || !data?.length) {
    alert('Nie udało się usunąć wpisu: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
    return;
  }
  if (state.editingId === book.id) cancelEdit();
  await loadReads();
}

document.getElementById('read-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideError();

  if (!state.currentUser) {
    showError('Musisz być zalogowany!');
    return;
  }

  const submitBtn = document.getElementById('submit-btn');
  const submitLabel = document.getElementById('submit-label');
  const title = document.getElementById('title').value.trim();
  const pages = parseInt(document.getElementById('pages').value, 10);
  const multiplier = readMultiplier();
  const startingNow = state.entryMode === 'started' && !state.editingId && !state.finishing;

  if (!title) {
    showError('Podaj tytuł książki.');
    return;
  }

  // Data rozpoczęcia: dziś = teraz, wcześniejszy dzień = jego południe (bez kłopotów ze strefą)
  let startedAt = null;
  if (startingNow) {
    const value = document.getElementById('started-date').value || todayInputValue();
    if (value > todayInputValue()) {
      showError('Data rozpoczęcia nie może być w przyszłości.');
      return;
    }
    const [y, m, d] = value.split('-').map(Number);
    startedAt = value === todayInputValue() ? new Date().toISOString() : new Date(y, m - 1, d, 12).toISOString();
  }

  const labelBefore = submitLabel.textContent;
  submitBtn.disabled = true;
  submitLabel.textContent = 'Zapisywanie…';
  try {
    if (startingNow) {
      const { error } = await supabaseClient.from('reading_now').insert({ title, started_at: startedAt });
      if (error) throw error;
      cancelEdit();
      await loadReads();
      showToast('Dodano do „Teraz czytam”.');
      goTo('start');
      return;
    }

    if (state.finishing && !state.editingId) {
      // Wpis, okładka i usunięcie z „Teraz czytam” w jednej transakcji w bazie
      const { error } = await supabaseClient.rpc('finish_reading', {
        p_reading_id: state.finishing.id,
        p_pages: pages,
        p_multiplier: multiplier,
        p_unfinished: document.getElementById('unfinished').checked,
        p_labels: readMultiplierLabels(),
      });
      if (error) throw error;
    } else {
      // user_id i created_at ustawia baza (defaulty)
      const values = { title, pages, multiplier, multiplier_labels: readMultiplierLabels(), unfinished: document.getElementById('unfinished').checked };
      const { data, error } = state.editingId
        ? await supabaseClient.from('reads').update(values).eq('id', state.editingId).select('id')
        : await supabaseClient.from('reads').insert(values).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('Nie udało się zapisać wpisu (brak uprawnień).');
    }

    const wasEditing = !!state.editingId;
    cancelEdit();
    await loadReads();
    showToast(wasEditing ? 'Zapisano zmiany.' : 'Dodano wpis!');
    goTo(wasEditing ? 'postepy' : 'start');
  } catch (err) {
    console.error('Error saving read:', err);
    showError(friendlyError(err));
  } finally {
    submitBtn.disabled = false;
    if (submitLabel.textContent === 'Zapisywanie…') submitLabel.textContent = labelBefore;
  }
});
