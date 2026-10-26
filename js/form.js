import { renderMultiplierAdmin } from './admin.js';
import { bookPoints, titleMatches } from '../supabase/functions/_shared/logic.js';
import { loadReads } from './data.js';
import { goTo } from './shell.js';
import { showAddSummary, snapshotRanking } from './summary.js';
import { lookupBook } from './shelf.js';
import { state } from './state.js';
import { supabaseClient } from './supabase.js';
import { DAY_MS, el, friendlyError, hideError, icon, refreshIcons, showError, showToast } from './ui.js';

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
    return el('label', { class: 'checkbox-label' }, [
      checkbox,
      el('span', { class: 'check-text', text: `${formatMultiplier(m.value)}x ${m.label}` }),
    ]);
  }));
}

/* ----------------- Formularz dodawania (edycja: js/bookeditor.js) ----------------- */
export function multiplierCheckboxes() {
  return [...document.querySelectorAll('.multiplier-checkbox')];
}

export function readMultiplier() {
  const product = multiplierCheckboxes()
    .filter(cb => cb.checked)
    .reduce((m, cb) => m * parseFloat(cb.value), 1);
  return Math.round(product * 10000) / 10000;
}

// Nazwy zaznaczonych mnożników (do odznak)
export function readMultiplierLabels() {
  return multiplierCheckboxes().filter(cb => cb.checked).map(cb => cb.dataset.label);
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
  state.finishing = item ? { id: item.id, title: item.title, startedAt: item.started_at, pageCount: item.page_count ?? null } : null;
  document.getElementById('title').value = item ? item.title : '';
  document.getElementById('author').value = item?.author || '';
  suggestPages();
}

// Lista „Którą książkę kończysz?”: zaczęte książki + „Inna książka”
export function renderFinishPick() {
  const select = document.getElementById('finish-pick');
  const items = myReadingNow();
  select.replaceChildren(
    ...items.map(item => el('option', { value: String(item.id), text: item.title })),
    el('option', { value: 'new', text: 'Nowa książka (wpisz tytuł)' }),
  );
  select.value = state.finishing ? String(state.finishing.id) : 'new';
}

// Domyślnie kończymy pierwszą zaczętą książkę, jeśli formularz jest „pusty”
export function applyFinishDefault() {
  if (state.entryMode !== 'finished' || state.finishing || state.finishPickedNew) return;
  const first = myReadingNow()[0];
  if (first) selectFinishing(first);
}

export function updateFormUI() {
  const started = state.entryMode === 'started';
  const queueing = state.entryMode === 'queue';
  const slim = started || queueing;  // bez stron, mnożników i „niedokończona”
  const canPick = !slim && myReadingNow().length > 0;

  document.getElementById('form-title').textContent =
    started ? 'Zaczynam czytać' : queueing ? 'Do przeczytania' : 'Dodaj postęp';
  document.getElementById('submit-label').textContent =
    started ? 'Zacznij czytać' : queueing ? 'Dodaj do kolejki' : state.finishing ? 'Dodaj skończoną książkę' : 'Dodaj wpis';

  document.querySelectorAll('.mode-btn').forEach(btn => {
    const active = btn.dataset.mode === state.entryMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  const canPickQueue = started && state.myQueue.length > 0;
  document.getElementById('queue-pick-group').hidden = !canPickQueue;
  if (canPickQueue) renderQueuePick();
  document.getElementById('finish-pick-group').hidden = !canPick;
  if (canPick) renderFinishPick();
  // Tytuł bierze się z wybranej zaczętej książki, więc pole jest wtedy schowane
  document.getElementById('title-group').hidden = (!!state.finishing && !slim) || (started && !!state.startingFromQueue);
  document.getElementById('author-group').hidden = started && !!state.startingFromQueue;
  document.getElementById('started-group').hidden = !started;
  document.getElementById('pages-group').hidden = slim;
  document.getElementById('multiplier-group').hidden = slim;
  document.getElementById('unfinished-group').hidden = slim;
  document.getElementById('pages').required = !slim;
}

/* ----------------- Podpowiedź liczby stron ----------------- */
// Przy kończeniu książki podpowiadamy liczbę stron z baz książek (Google Books / Open Library):
// z zapisanej przy książce z „Teraz czytam”, a gdy jej nie ma albo tytuł wpisano ręcznie, z wyszukiwania.
// To tylko podpowiedź (zależy od wydania): wpisujemy ją dopiero po kliknięciu „Wpisz”.
let pagesHintSeq = 0;

function hidePagesHint() {
  pagesHintSeq++;
  document.getElementById('pages-hint').hidden = true;
}

// Jeden wyraźny przycisk „Wpisz 352 str.”; skąd ta liczba, mówi podpowiedź po przytrzymaniu
function showPagesHint(pages) {
  const hint = document.getElementById('pages-hint');
  const use = el('button', { type: 'button', class: 'pages-hint-btn', title: 'Z baz książek (zależy od wydania)' }, [
    icon('sparkles'),
    el('span', { text: `Wpisz ${pages} str.` }),
  ]);
  use.addEventListener('click', () => {
    const input = document.getElementById('pages');
    input.value = String(pages);
    hint.hidden = true;
    input.focus({ preventScroll: true });
  });
  hint.replaceChildren(use);
  hint.hidden = false;
  refreshIcons();
}

export async function suggestPages() {
  const seq = ++pagesHintSeq;
  document.getElementById('pages-hint').hidden = true;
  if (state.entryMode !== 'finished') return;

  if (state.finishing?.pageCount) {
    showPagesHint(state.finishing.pageCount);
    return;
  }
  const title = state.finishing ? state.finishing.title : document.getElementById('title').value.trim();
  if (title.length < 3) return;

  const { results } = await lookupBook(title, 3);
  if (seq !== pagesHintSeq) return;  // w międzyczasie zmieniono tytuł albo tryb
  const best = results.find(r => r.pages && titleMatches(title, r.title));
  if (best) showPagesHint(best.pages);
}

let pagesHintTimer = null;
document.getElementById('title').addEventListener('input', () => {
  clearTimeout(pagesHintTimer);
  hidePagesHint();
  pagesHintTimer = setTimeout(suggestPages, 700);
});

export function setEntryMode(mode) {
  state.entryMode = mode;
  if (mode !== 'started') state.startingFromQueue = null;
  if (mode === 'started' || mode === 'queue') {
    // Nowa zaczęta książka: zaczynamy od pustego tytułu; po powrocie znowu podpowiemy zaczętą
    selectFinishing(null);
    state.finishPickedNew = false;
  } else {
    applyFinishDefault();
  }
  hideError();
  updateFormUI();
  suggestPages();
}

// „Zaczynam czytać”: lista „Do przeczytania” + „Inna książka”
export function renderQueuePick() {
  const select = document.getElementById('queue-pick');
  select.replaceChildren(
    el('option', { value: 'new', text: 'Nowa książka (wpisz tytuł)' }),
    ...state.myQueue.map(item => el('option', { value: String(item.id), text: item.author ? `${item.title} (${item.author})` : item.title })),
  );
  select.value = state.startingFromQueue ? String(state.startingFromQueue.id) : 'new';
}

export function handleQueuePick() {
  const value = document.getElementById('queue-pick').value;
  const item = state.myQueue.find(q => String(q.id) === value) || null;
  state.startingFromQueue = item;
  document.getElementById('title').value = item ? item.title : '';
  document.getElementById('author').value = item?.author || '';
  hideError();
  updateFormUI();
  if (!item) document.getElementById('title').focus({ preventScroll: true });
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
  resetForm();
  selectFinishing(item);
  updateFormUI();
  goTo('dodaj');
  document.getElementById('pages').focus({ preventScroll: true });
}

// Pusty formularz (po dodaniu, po wylogowaniu, po porzuceniu kończenia książki)
export function resetForm() {
  state.startingFromQueue = null;
  hidePagesHint();
  state.finishing = null;
  state.finishPickedNew = false;
  state.entryMode = 'finished';
  document.getElementById('read-form').reset();
  document.getElementById('started-date').value = todayInputValue();
  applyFinishDefault();
  hideError();
  updateFormUI();
}

// true = usunięto (edytor książki zamyka się wtedy)
export async function handleDelete(book) {
  if (!confirm(`Usunąć wpis „${book.title || 'bez tytułu'}”?`)) return false;

  const { data, error } = await supabaseClient
    .from('reads')
    .delete()
    .eq('id', book.id)
    .select('id');

  if (error || !data?.length) {
    alert('Nie udało się usunąć wpisu: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
    return false;
  }
  await loadReads();
  return true;
}

/* ----------------- Przysięga Krystiana ----------------- */
// Żart: Krystian, który dodaje książkę z obydwoma mnożnikami naraz (Angielski + Naukowa),
// musi najpierw obiecać, że cokolwiek z niej zrozumiał.
function needsOath() {
  const firstName = (document.getElementById('display-name').textContent || '').trim().split(/\s+/)[0].toLowerCase();
  if (firstName !== 'krystian') return false;
  const labels = readMultiplierLabels().map(l => l.toLowerCase());
  return labels.includes('angielski') && labels.includes('naukowa');
}

function askOath() {
  return new Promise(resolve => {
    const check = el('input', { type: 'checkbox' });
    const ok = el('button', { type: 'button', class: 'btn btn-primary', text: 'Dodaj książkę' });
    const cancel = el('button', { type: 'button', class: 'btn btn-outline', text: 'Jednak nie' });
    ok.disabled = true;
    check.addEventListener('change', () => { ok.disabled = !check.checked; });

    const finish = answer => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(answer);
    };
    const onKey = e => { if (e.key === 'Escape') finish(false); };
    ok.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));

    const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'oath-title' }, [
      el('div', { class: 'modal-content' }, [
        el('div', { class: 'modal-icon' }, [icon('scale')]),
        el('h2', { id: 'oath-title', class: 'modal-title', text: 'Chwileczkę, Krystian' }),
        el('p', { text: 'Po angielsku i do tego naukowa? Zanim dostaniesz podwójny bonus, złóż przysięgę.' }),
        el('label', { class: 'checkbox-label' }, [check, el('span', { class: 'check-text', text: 'Obiecuję, że cokolwiek zrozumiałem z tej książki' })]),
        el('div', { class: 'oath-actions' }, [cancel, ok]),
      ]),
    ]);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    refreshIcons();
  });
}

// Wariant drugi tego samego żartu: referat na 1000 znaków o przeczytanej książce.
// Można go pominąć („dla beki”), więc nie blokuje dodania książki.
const ESSAY_MIN = 1000;

function askEssay(bookTitle) {
  return new Promise(resolve => {
    const area = el('textarea', { class: 'essay-text', rows: '8', 'aria-label': 'Referat', placeholder: 'Rozwinięcie, wnioski, ulubiony cytat…' });
    const counter = el('span', { class: 'essay-counter', text: `0 / ${ESSAY_MIN}` });
    const ok = el('button', { type: 'button', class: 'btn btn-primary', text: 'Dodaj książkę' });
    const skip = el('button', { type: 'button', class: 'btn btn-outline', text: 'Dodaj bez referatu (-1000 pkt)' });
    const cancel = el('button', { type: 'button', class: 'btn btn-outline', text: 'Jednak nie' });
    ok.disabled = true;

    area.addEventListener('input', () => {
      const n = area.value.trim().length;
      counter.textContent = `${n} / ${ESSAY_MIN}`;
      counter.classList.toggle('done', n >= ESSAY_MIN);
      ok.disabled = n < ESSAY_MIN;
    });

    const finish = answer => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(answer);
    };
    const onKey = e => { if (e.key === 'Escape') finish(false); };
    ok.addEventListener('click', () => finish(true));
    skip.addEventListener('click', () => finish(true));  // pominięcie też dodaje książkę, to tylko żart
    cancel.addEventListener('click', () => finish(false));

    const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'essay-title' }, [
      el('div', { class: 'modal-content essay-content' }, [
        el('div', { class: 'modal-icon' }, [icon('pen-line')]),
        el('h2', { id: 'essay-title', class: 'modal-title', text: 'Chwileczkę, Krystian!'}),
        el('p', { text: `Angielski i naukowa naraz? Napisz referat o „${bookTitle}” (min. ${ESSAY_MIN} znaków).` }),
        area,
        counter,
        el('div', { class: 'oath-actions essay-actions' }, [cancel, skip, ok]),
      ]),
    ]);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    refreshIcons();
    area.focus();
  });
}

// Losowo: przysięga albo referat
function askKrystian(bookTitle) {
  return Math.random() < 0.5 ? askOath() : askEssay(bookTitle);
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
  const author = document.getElementById('author').value.trim().slice(0, 200);
  const pages = parseInt(document.getElementById('pages').value, 10);
  const multiplier = readMultiplier();
  const startingNow = state.entryMode === 'started' && !state.finishing;
  const queueing = state.entryMode === 'queue';

  if (!title) {
    showError('Podaj tytuł książki.');
    return;
  }

  // Przysięga tylko przy dodawaniu skończonej książki (nie przy „Zaczynam czytać”)
  if (!startingNow && !queueing && needsOath() && !await askKrystian(title)) return;

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
    if (queueing) {
      // „Do przeczytania”: tylko tytuł i autor; zostajemy w formularzu, żeby dało się dodać kolejne
      const { data: added, error } = await supabaseClient.from('reading_queue').insert({ title, author: author || null }).select('id, title, author');
      if (error) throw error;
      if (added?.length) state.myQueue.push(added[0]);
      document.getElementById('title').value = '';
      document.getElementById('author').value = '';
      showToast('Dodano do kolejki.');
      document.getElementById('title').focus({ preventScroll: true });
      return;
    }

    if (startingNow && state.startingFromQueue) {
      // Z listy „Do przeczytania” do „Teraz czytam” w jednej transakcji (autor i okładka jadą razem)
      const { error } = await supabaseClient.rpc('start_from_queue', { p_id: state.startingFromQueue.id, p_started_at: startedAt });
      if (error) throw error;
      resetForm();
      await loadReads();
      showToast('Zaczęte! Książka jest w „Teraz czytam”.');
      goTo('start');
      return;
    }

    if (startingNow) {
      const { error } = await supabaseClient.from('reading_now').insert({ title, started_at: startedAt, author: author || null });
      if (error) throw error;
      resetForm();
      await loadReads();
      showToast('Dodano do „Teraz czytam”.');
      goTo('start');
      return;
    }

    const rankingBefore = snapshotRanking();
    if (state.finishing) {
      // Wpis, okładka i usunięcie z „Teraz czytam” w jednej transakcji w bazie
      const { error } = await supabaseClient.rpc('finish_reading', {
        p_reading_id: state.finishing.id,
        p_pages: pages,
        p_multiplier: multiplier,
        p_unfinished: document.getElementById('unfinished').checked,
        p_labels: readMultiplierLabels(),
        p_author: author,
      });
      if (error) throw error;
    } else {
      // user_id i created_at ustawia baza (defaulty)
      const values = { title, author: author || null, pages, multiplier, multiplier_labels: readMultiplierLabels(), unfinished: document.getElementById('unfinished').checked };
      const { data, error } = await supabaseClient.from('reads').insert(values).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('Nie udało się zapisać wpisu (brak uprawnień).');
    }

    resetForm();
    await loadReads();
    goTo('start');
    // Nowa książka: podsumowanie, co zmieniło się w rankingu (miejsce, wyprzedzone osoby, konfetti)
    showAddSummary(rankingBefore, { title, pts: bookPoints({ pages, multiplier }) });
  } catch (err) {
    console.error('Error saving read:', err);
    showError(friendlyError(err));
  } finally {
    submitBtn.disabled = false;
    if (submitLabel.textContent === 'Zapisywanie…') submitLabel.textContent = labelBefore;
  }
});
