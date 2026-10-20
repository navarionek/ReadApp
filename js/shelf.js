import { cropImage } from './cropper.js';
import { viewerId } from './admin.js';
import { handleDropReading, loadReads, renderReadingNow } from './data.js';
import { daysSince, formatMultiplier, startFinishing } from './form.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { currentScreen } from './shell.js';
import { state } from './state.js';
import { formatDay } from './stats.js';
import { supabaseClient } from './supabase.js';
import { el, friendlyError, icon, refreshIcons, showToast } from './ui.js';

/* ----------------- Półka (okładki i informacje z publicznych baz) ----------------- */
export const lookupCache = new Map();  // zapytanie -> Promise<{ results, google, failed }>, żeby nie pytać dwa razy w sesji

// google: czy funkcja miała dostęp do Google Books (bez niego „nie znaleziono” nie jest pewne);
// failed: samo wywołanie się nie udało. Obie informacje idą razem z wynikiem, bez wspólnej zmiennej.
export function lookupBook(q, limit = 6) {
  const key = `${q.toLowerCase()}|${limit}`;
  if (!lookupCache.has(key)) {
    lookupCache.set(key, supabaseClient.functions.invoke('book-lookup', { body: { q, limit } })
      .then(({ data, error }) => {
        if (error) throw error;
        return { results: data?.results || [], google: !!data?.google, failed: false };
      })
      .catch(err => {
        lookupCache.delete(key);
        console.error('Book lookup failed:', err);
        return { results: [], google: false, failed: true };
      }));
  }
  return lookupCache.get(key);
}

// Uzupełnianie okładek robi serwer (funkcja fill-book-info): znajduje je, kopiuje do naszego bucketa
// i zapisuje w bazie dla wszystkich, więc cudza półka też ładuje się szybko, a wyszukiwanie dzieje się raz.
// Tu tylko o to prosimy i podstawiamy wynik. onBatch dostaje każdą gotową paczkę (po 5 książek).
const enrichInFlight = new Set();  // `${table}:${id}`: nie pytamy dwa razy o to samo naraz

async function enrichBooks(table, items, onBatch) {
  const todo = items.filter(i => !i.info_checked_at && !enrichInFlight.has(`${table}:${i.id}`));
  todo.forEach(i => enrichInFlight.add(`${table}:${i.id}`));
  try {
    for (let i = 0; i < todo.length; i += 5) {
      const ids = todo.slice(i, i + 5).map(r => r.id);
      try {
        const { data, error } = await supabaseClient.functions.invoke('fill-book-info', { body: { table, ids } });
        if (error) throw error;
        const done = (data?.items || []).filter(it => !it.pending && it.info_checked_at);
        if (done.length) onBatch(done);
      } catch (err) {
        console.error('fill-book-info failed:', err);
      }
    }
  } finally {
    todo.forEach(i => enrichInFlight.delete(`${table}:${i.id}`));  // niepowodzenia spróbujemy przy następnej wizycie
  }
}

const INFO_FIELDS = ['cover_url', 'author', 'published_year', 'info_url', 'description', 'info_checked_at'];

function applyInfo(list, it) {
  const row = list.find(r => r.id === it.id);
  if (row) INFO_FIELDS.forEach(f => { row[f] = it[f]; });
}

// Okładka książki „Teraz czytam”: z bazy; jeśli jej jeszcze nie ma, prosimy serwer i po odpowiedzi
// odrysowujemy wszystkie miejsca, w których może być widoczna (Start, półka, okno).
let openReadingId = null;  // id książki z „Teraz czytam” otwartej w oknie (null = okno pokazuje coś innego)

function redrawReadingCovers() {
  renderReadingNow();
  if (currentScreen() === 'polka') renderShelf();
  const item = state.readingNow.find(i => i.id === openReadingId);
  const picker = document.querySelector('#book-modal-body .cover-picker');
  // Nie ruszamy okna, gdy ktoś właśnie wybiera okładkę
  if (item && !document.getElementById('book-modal').hidden && (!picker || picker.hidden)) openReadingModal(item);
  refreshIcons();
}

export function readingCoverOf(item) {
  if (item.info_checked_at) return item;  // okładka wybrana albo zapisana w bazie
  enrichBooks('reading_now', [item], items => {
    items.forEach(it => applyInfo(state.readingNow, it));
    redrawReadingCovers();
  });
  return null;
}

// „Zmień autora” w oknie książki: przycisk, który odsłania pole z zapisem (reads albo reading_now)
function authorEditor(table, row, afterSave) {
  const input = el('input', { type: 'text', class: 'plain-input', maxlength: '200', 'aria-label': 'Autor', placeholder: 'np. Andrzej Sapkowski', autocomplete: 'off' });
  input.value = row.author || '';
  const save = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Zapisz' });
  const form = el('form', { class: 'author-form', hidden: '' }, [input, save]);
  const toggle = el('button', { type: 'button', class: 'btn btn-outline btn-block' }, [icon('user-round'), el('span', { text: 'Zmień autora' })]);

  toggle.addEventListener('click', () => {
    toggle.hidden = true;
    form.hidden = false;
    input.focus();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const author = input.value.trim().slice(0, 200) || null;
    save.disabled = true;
    const { error } = await supabaseClient.from(table).update({ author }).eq('id', row.id);
    save.disabled = false;
    if (error) {
      showToast('Nie udało się zapisać: ' + friendlyError(error));
      return;
    }
    row.author = author;
    showToast('Zapisano autora.');
    afterSave();
  });
  return el('div', { class: 'author-edit' }, [toggle, form]);
}

export function openReadingModal(item) {
  const info = readingCoverOf(item);
  openReadingId = item.id;
  const book = { title: item.title, cover_url: info?.cover_url, author: item.author || info?.author };
  const own = item.user_id === state.currentUser?.id && viewerId() === state.currentUser?.id;
  const days = daysSince(item.started_at);

  const body = [
    el('div', { class: 'book-modal-top' }, [
      coverEl(book, 'large'),
      el('div', { class: 'book-modal-info' }, [
        el('h2', { id: 'book-modal-title', class: 'book-modal-title', text: item.title }),
        ...(book.author ? [el('p', { class: 'book-modal-author', text: book.author })] : []),
        el('p', { class: 'book-modal-author', text: `Czytane od ${formatDay(new Date(item.started_at))} · ${days} ${days === 1 ? 'dzień' : 'dni'}` }),
      ]),
    ]),
  ];

  if (own) {
    const done = el('button', { type: 'button', class: 'btn btn-primary btn-block' }, [icon('check'), el('span', { text: 'Skończone' })]);
    done.addEventListener('click', async () => {
      await closeBookModal();
      startFinishing(item);
    });
    const drop = el('button', { type: 'button', class: 'btn btn-outline btn-block cancel-btn' }, [icon('x'), el('span', { text: 'Usuń z „Teraz czytam”' })]);
    drop.addEventListener('click', async () => {
      closeBookModal();
      await handleDropReading(item);
      if (currentScreen() === 'polka') renderShelf();
    });
    const pickBtn = el('button', { type: 'button', class: 'btn btn-outline btn-block' }, [icon('image'), el('span', { text: 'Zmień okładkę / dopasowanie' })]);
    const picker = el('div', { class: 'cover-picker', hidden: '' });
    pickBtn.addEventListener('click', () => {
      pickBtn.hidden = true;
      picker.hidden = false;
      renderCoverPicker(picker, item, item.title, saveReadingInfo);
    });
    const authorEdit = authorEditor('reading_now', item, () => {
      renderReadingNow();
      if (currentScreen() === 'polka') renderShelf();
      openReadingModal(item);
      refreshIcons();
    });
    body.push(authorEdit, pickBtn, picker, done, drop);
  }

  document.getElementById('book-modal-body').replaceChildren(...body);
  showBookModal();
  refreshIcons();
}

export function titleHue(title) {
  let h = 0;
  for (const c of title || '') h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

// Okładka albo zastępcza „okładka” z tytułem (kolor z tytułu, więc zawsze ten sam)
export function coverEl(book, extraClass = '') {
  const placeholder = () => {
    const h = titleHue(book.title);
    const ph = el('div', { class: `book-cover placeholder ${extraClass}`, 'aria-hidden': 'true' }, [
      el('span', { class: 'ph-title', text: book.title || 'bez tytułu' }),
      ...(book.author ? [el('span', { class: 'ph-author', text: book.author })] : []),
    ]);
    ph.style.background = `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 50% 24%))`;
    return ph;
  };
  if (!book.cover_url) return placeholder();
  const img = el('img', { class: `book-cover ${extraClass}`, src: book.cover_url, alt: `Okładka: ${book.title}`, loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(placeholder()));
  return img;
}

export async function loadShelfPeople() {
  const { data, error } = await supabaseClient.from('profiles').select('id, display_name').order('display_name');
  if (error) return;
  const select = document.getElementById('shelf-person');
  const current = state.shelfUserId || viewerId();
  select.replaceChildren(...data.map(p => {
    const option = el('option', { value: p.id, text: p.id === viewerId() ? `${p.display_name} (ty)` : p.display_name });
    option.selected = p.id === current;
    return option;
  }));
}

/* ----------------- Do przeczytania (kolejka) ----------------- */
// Uzupełnianie okładek książek w kolejce (patrz enrichBooks)
async function fillMissingQueueInfo(userId) {
  await enrichBooks('reading_queue', state.shelfQueue, items => {
    if ((state.shelfUserId || viewerId()) !== userId) return;  // ktoś przełączył półkę
    items.forEach(it => applyInfo(state.shelfQueue, it));
    if (currentScreen() === 'polka') renderShelf();
  });
}

async function saveQueueInfo(item, info) {
  if (!await updateBookInfo('reading_queue', item, info)) return;
  renderShelf();
  openQueueModal(item);
}

export function openQueueModal(item) {
  openReadingId = null;
  const own = item.user_id === state.currentUser?.id && viewerId() === state.currentUser?.id;

  const body = [
    el('div', { class: 'book-modal-top' }, [
      coverEl({ title: item.title, cover_url: item.cover_url, author: item.author }, 'large'),
      el('div', { class: 'book-modal-info' }, [
        el('h2', { id: 'book-modal-title', class: 'book-modal-title', text: item.title }),
        ...(item.author || item.published_year
          ? [el('p', { class: 'book-modal-author', text: [item.author, item.published_year].filter(Boolean).join(' · ') })]
          : []),
        el('p', { class: 'book-modal-author', text: `W kolejce od ${formatDay(new Date(item.created_at))}` }),
        ...(item.info_url
          ? [el('a', { class: 'book-modal-link', href: item.info_url, target: '_blank', rel: 'noopener noreferrer', text: item.info_url.includes('google') ? 'Więcej w Google Books' : 'Więcej w Open Library' })]
          : []),
      ]),
    ]),
    ...(item.description ? [el('p', { class: 'book-modal-desc', text: item.description })] : []),
  ];

  if (own) {
    const start = el('button', { type: 'button', class: 'btn btn-primary btn-block' }, [icon('book-open'), el('span', { text: 'Zaczynam czytać' })]);
    start.addEventListener('click', async () => {
      start.disabled = true;
      const { error } = await supabaseClient.rpc('start_from_queue', { p_id: item.id });
      if (error) {
        start.disabled = false;
        showToast('Nie udało się: ' + friendlyError(error));
        return;
      }
      await closeBookModal();
      showToast('Zaczęte! Książka jest teraz w „Czyta teraz”.');
      shelfSignature = null;
      await loadReads();
      await loadShelf();
    });

    const drop = el('button', { type: 'button', class: 'btn btn-outline btn-block cancel-btn' }, [icon('x'), el('span', { text: 'Usuń z kolejki' })]);
    drop.addEventListener('click', async () => {
      if (!confirm(`Usunąć „${item.title}” z kolejki?`)) return;
      const { data, error } = await supabaseClient.from('reading_queue').delete().eq('id', item.id).select('id');
      if (error || !data?.length) {
        showToast('Nie udało się usunąć: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
        return;
      }
      await closeBookModal();
      shelfSignature = null;
      await loadShelf();
    });

    const authorEdit = authorEditor('reading_queue', item, () => {
      renderShelf();
      openQueueModal(item);
    });
    const pickBtn = el('button', { type: 'button', class: 'btn btn-outline btn-block' }, [icon('image'), el('span', { text: 'Zmień okładkę / dopasowanie' })]);
    const picker = el('div', { class: 'cover-picker', hidden: '' });
    pickBtn.addEventListener('click', () => {
      pickBtn.hidden = true;
      picker.hidden = false;
      renderCoverPicker(picker, item, item.title, saveQueueInfo);
    });
    body.push(start, authorEdit, pickBtn, picker, drop);
  }

  document.getElementById('book-modal-body').replaceChildren(...body);
  showBookModal();
  refreshIcons();
}

const QUEUE_FIELDS = 'id, user_id, title, author, cover_url, published_year, info_url, description, info_checked_at, created_at';

let shelfSeq = 0;  // numer ostatniego żądania półki: starsze odpowiedzi są ignorowane
let shelfSignature = null;  // odcisk ostatnio pobranych danych: bez zmian = nie rysujemy półki od nowa

// Odcisk tego, co widać na półce (wpisy z bazy + „Czyta teraz”), liczony z danych sprzed lokalnych uzupełnień
function shelfSig(userId, rows, queue = []) {
  const current = state.readingNow.filter(item => item.user_id === userId);
  return JSON.stringify([
    userId,
    queue.map(q => [q.id, q.title, q.author, q.cover_url, q.info_checked_at]),
    rows.map(r => [r.id, r.title, r.pages, r.multiplier, r.unfinished, r.cover_url, r.author, r.info_checked_at]),
    current.map(i => [i.id, i.title, i.cover_url, i.info_checked_at]),
  ]);
}

export async function loadShelf() {
  const userId = state.shelfUserId || viewerId();
  if (!userId) return;
  const seq = ++shelfSeq;
  const shelf = document.getElementById('shelf');
  if (!state.shelfRows.length || state.shelfRows[0]?.user_id !== userId) {
    shelf.replaceChildren(el('div', { class: 'status-box', text: 'Ładowanie półki…' }));
  }
  loadShelfPeople();

  const [readsResult, queueResult] = await Promise.all([
    supabaseClient
      .from('reads')
      .select('id, user_id, title, pages, multiplier, unfinished, created_at, started_at, cover_url, author, published_year, info_url, description, info_checked_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }),
    supabaseClient
      .from('reading_queue')
      .select(QUEUE_FIELDS)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ]);
  const { data, error } = readsResult;
  if (queueResult.error) console.error('Error loading reading queue:', queueResult.error);
  const queueRows = queueResult.data || [];

  if (seq !== shelfSeq) return;  // w międzyczasie ktoś przełączył półkę albo odświeżył ją ponownie
  if (error) {
    shelf.replaceChildren(el('div', { class: 'status-box', text: 'Nie udało się wczytać półki. ' + friendlyError(error) }));
    return;
  }
  const signature = shelfSig(userId, data || [], queueRows);
  // Nic się nie zmieniło od ostatniej wizyty: zostawiamy półkę w spokoju, żeby okładki nie mrugały
  if (signature === shelfSignature && state.shelfRows[0]?.user_id === userId) return;
  shelfSignature = signature;
  state.shelfRows = data || [];
  state.shelfQueue = queueRows;
  renderShelf();
  fillMissingBookInfo(userId);
  fillMissingQueueInfo(userId);
}

export function renderShelf() {
  const userId = state.shelfUserId || viewerId();
  const isOwn = userId === viewerId();
  const personName = document.querySelector(`#shelf-person option[value="${userId}"]`)?.textContent.replace(/ \(ty\)$/, '');
  document.getElementById('shelf-title').textContent = isOwn ? 'Twoja półka' : `Półka: ${personName || ''}`;

  const pages = state.shelfRows.reduce((sum, r) => sum + r.pages, 0);
  const n = state.shelfRows.length;
  document.getElementById('shelf-summary').textContent = n
    ? `${n} ${n === 1 ? 'książka' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'książki' : 'książek'} · ${pages} stron`
    : '';

  const sections = [];
  const current = state.readingNow.filter(item => item.user_id === userId);
  if (current.length) {
    sections.push(el('section', { class: 'shelf-section' }, [
      el('h3', { class: 'shelf-year', text: 'Czyta teraz' }),
      el('div', { class: 'shelf-grid' }, current.map(item => {
        const info = readingCoverOf(item);
        const book = { title: item.title, cover_url: info?.cover_url, author: item.author || info?.author };
        return bookTile(book, () => openReadingModal(item), true);
      })),
    ]));
  }

  // „Do przeczytania”: własna kolejka z formularzem dodawania, cudzą można tylko podejrzeć
  if (isOwn || state.shelfQueue.length) {
    const nq = state.shelfQueue.length;
    sections.push(el('section', { class: 'shelf-section queue-section' }, [
      el('h3', { class: 'shelf-year' }, [document.createTextNode('Do przeczytania'), ...(nq ? [el('span', { class: 'shelf-year-count', text: ` · ${nq}` })] : [])]),
      ...(nq
        ? [el('div', { class: 'shelf-grid' }, state.shelfQueue.map(item => bookTile(
            { title: item.title, author: item.author, cover_url: item.cover_url },
            () => openQueueModal(item),
          )))]
        : [el('p', { class: 'hint', text: 'Dodasz je na ekranie „Dodaj” (zakładka „Do przeczytania”). Znajomi będą mogli je podejrzeć.' })]),
    ]));
  }

  const byYear = new Map();
  state.shelfRows.forEach(r => {
    const y = new Date(r.created_at).getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  });
  byYear.forEach((rows, year) => {
    sections.push(el('section', { class: 'shelf-section' }, [
      el('h3', { class: 'shelf-year' }, [document.createTextNode(String(year)), el('span', { class: 'shelf-year-count', text: ` · ${rows.length}` })]),
      el('div', { class: 'shelf-grid' }, rows.map(r => bookTile(r, r))),
    ]));
  });

  if (!current.length && !byYear.size) {
    sections.push(el('div', { class: 'status-box', text: isOwn ? 'Pusto na półce. Dodaj pierwszą przeczytaną książkę!' : 'Ta osoba nie ma jeszcze książek na półce.' }));
  }
  document.getElementById('shelf').replaceChildren(...sections);
}

// onOpen: wpis z reads (otwiera szczegóły) albo własna funkcja (np. dla „Czyta teraz”)
export function bookTile(book, onOpen, reading = false) {
  const tile = el('button', { type: 'button', class: `book-tile${reading ? ' reading' : ''}`, title: book.title || '' }, [
    coverEl(book),
    el('span', { class: 'book-tile-title', text: book.title || 'bez tytułu' }),
    ...(book.unfinished ? [el('span', { class: 'unfinished-tag', text: 'niedokończona' })] : []),
    ...(book.author ? [el('span', { class: 'book-tile-author', text: book.author })] : []),
  ]);
  if (typeof onOpen === 'function') tile.addEventListener('click', onOpen);
  else if (onOpen) tile.addEventListener('click', () => openBookModal(onOpen));
  else tile.disabled = true;
  return tile;
}

// Okładki wpisów na półce, których jeszcze nie ma w bazie (patrz enrichBooks)
export async function fillMissingBookInfo(userId) {
  await enrichBooks('reads', state.shelfRows, items => {
    if ((state.shelfUserId || viewerId()) !== userId) return;  // ktoś przełączył półkę
    items.forEach(it => applyInfo(state.shelfRows, it));
    if (currentScreen() === 'polka') renderShelf();
  });
}

/* ----------------- Szczegóły książki ----------------- */
// Okno ma własny wpis w historii, więc „Wstecz” zamyka tylko okno i zostaje na tej samej stronie.
// Zwraca obietnicę, która kończy się po zamknięciu (cofnięcie historii jest asynchroniczne),
// żeby kolejna nawigacja nie została przez nie cofnięta.
export function closeBookModal() {
  const modal = document.getElementById('book-modal');
  if (modal.hidden) return Promise.resolve();
  modal.hidden = true;
  openReadingId = null;
  if (!history.state?.bookModal) return Promise.resolve();
  return new Promise(resolve => {
    window.addEventListener('popstate', resolve, { once: true });
    history.back();
  });
}

function showBookModal() {
  const modal = document.getElementById('book-modal');
  if (modal.hidden) history.pushState({ bookModal: true }, '');
  modal.hidden = false;
}

window.addEventListener('popstate', () => {
  document.getElementById('book-modal').hidden = true;
});

export function openBookModal(row) {
  openReadingId = null;
  const own = row.user_id === state.currentUser?.id && viewerId() === state.currentUser?.id;
  const finished = new Date(row.created_at);
  const dates = row.started_at
    ? `${formatDay(new Date(row.started_at))} – ${formatDay(finished)} ${finished.getFullYear()}`
    : `dodane ${formatDay(finished)} ${finished.getFullYear()}`;

  const facts = el('dl', { class: 'book-facts' }, [
    el('div', {}, [el('dt', { text: 'Strony' }), el('dd', { text: row.unfinished ? `${row.pages} (niedokończona)` : String(row.pages) })]),
    el('div', {}, [el('dt', { text: 'Mnożnik' }), el('dd', { text: `${formatMultiplier(row.multiplier)}x` })]),
    el('div', {}, [el('dt', { text: 'Punkty' }), el('dd', { text: String(bookPoints(row)) })]),
    el('div', {}, [el('dt', { text: 'Przeczytane' }), el('dd', { text: dates })]),
  ]);

  const body = [
    el('div', { class: 'book-modal-top' }, [
      coverEl(row, 'large'),
      el('div', { class: 'book-modal-info' }, [
        el('h2', { id: 'book-modal-title', class: 'book-modal-title', text: row.title || 'bez tytułu' }),
        ...(row.author || row.published_year
          ? [el('p', { class: 'book-modal-author', text: [row.author, row.published_year].filter(Boolean).join(' · ') })]
          : []),
        ...(row.info_url
          ? [el('a', { class: 'book-modal-link', href: row.info_url, target: '_blank', rel: 'noopener noreferrer', text: row.info_url.includes('google') ? 'Więcej w Google Books' : 'Więcej w Open Library' })]
          : []),
      ]),
    ]),
    facts,
    ...(row.description ? [el('p', { class: 'book-modal-desc', text: row.description })] : []),
  ];

  if (own) {
    const pickBtn = el('button', { type: 'button', class: 'btn btn-outline btn-block' }, [icon('image'), el('span', { text: 'Zmień okładkę / dopasowanie' })]);
    const picker = el('div', { class: 'cover-picker', hidden: '' });
    pickBtn.addEventListener('click', () => {
      pickBtn.hidden = true;
      picker.hidden = false;
      renderCoverPicker(picker, row, row.title || '', saveBookInfo);
    });
    const authorEdit = authorEditor('reads', row, () => {
      renderShelf();
      openBookModal(row);
    });
    body.push(authorEdit, pickBtn, picker);
  }

  document.getElementById('book-modal-body').replaceChildren(...body);
  showBookModal();
  refreshIcons();
}

// Okładkę z Google/Open Library kopiujemy do naszego bucketa (funkcja cover-copy), żeby ładowała się
// szybko i nie znikała razem ze źródłem. Gdy kopiowanie się nie uda, zostaje link zewnętrzny.
async function ownCover(url) {
  if (!url) return null;
  try {
    const { data, error } = await supabaseClient.functions.invoke('cover-copy', { body: { url } });
    if (error) throw error;
    return data?.url || url;
  } catch (err) {
    console.error('Cover copy failed:', err);
    return url;
  }
}

// Wysyła skadrowane zdjęcie do własnego folderu w buckecie „covers” i zwraca jego publiczny adres
async function uploadCoverPhoto(blob) {
  const path = `${state.currentUser.id}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabaseClient.storage.from('covers').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
  if (error) throw error;
  return supabaseClient.storage.from('covers').getPublicUrl(path).data.publicUrl;
}

// save(row, info) zapisuje wybór: saveBookInfo dla przeczytanych, saveReadingInfo dla „Teraz czytam”
export function renderCoverPicker(container, row, query, save) {
  const input = el('input', { type: 'search', class: 'plain-input', 'aria-label': 'Szukaj książki', placeholder: 'Tytuł, autor…' });
  input.value = query;
  const searchBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, [el('span', { text: 'Szukaj' })]);
  const form = el('form', { class: 'cover-search' }, [input, searchBtn]);
  const results = el('div', { class: 'cover-results' }, [el('div', { class: 'status-box', text: 'Szukam…' })]);

  // Własne zdjęcie okładki: z aparatu (capture) albo z galerii. Oba kończą się kadrowaniem.
  const makePhotoSource = (iconName, label, capture) => {
    const attrs = { type: 'file', accept: 'image/*', hidden: '' };
    if (capture) attrs.capture = 'environment';
    const fileInput = el('input', attrs);
    const btn = el('button', { type: 'button', class: 'btn btn-outline cover-photo-btn' }, [icon(iconName), el('span', { text: label })]);
    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (file) await handlePhoto(file);
    });
    return [btn, fileInput];
  };

  const photoButtons = [];
  const handlePhoto = async file => {
    photoButtons.forEach(b => { b.disabled = true; });
    try {
      const blob = await cropImage(file);
      if (!blob) return;  // anulowano kadrowanie
      results.replaceChildren(el('div', { class: 'status-box', text: 'Wysyłam zdjęcie…' }));
      const url = await uploadCoverPhoto(blob);
      // Tekstowe informacje (autor, rok, opis) zostają, zmienia się tylko okładka
      await save(row, {
        cover_url: url, author: row.author ?? null, published_year: row.published_year ?? null,
        info_url: row.info_url ?? null, description: row.description ?? null,
      });
    } catch (err) {
      console.error('Cover upload failed:', err);
      showToast('Nie udało się dodać zdjęcia: ' + friendlyError(err));
      run(input.value.trim() || row.title || '');
    } finally {
      photoButtons.forEach(b => { b.disabled = false; });
    }
  };

  const [cameraBtn, cameraInput] = makePhotoSource('camera', 'Zrób zdjęcie', true);
  const [galleryBtn, galleryInput] = makePhotoSource('image', 'Wybierz z galerii', false);
  photoButtons.push(cameraBtn, galleryBtn);
  const photoRow = el('div', { class: 'cover-photo-row' }, [cameraBtn, galleryBtn, cameraInput, galleryInput]);

  container.replaceChildren(form, photoRow, results);
  refreshIcons();

  const run = async q => {
    results.replaceChildren(el('div', { class: 'status-box', text: 'Szukam…' }));
    const { results: found } = await lookupBook(q, 8);
    const options = found.map(r => {
      const btn = el('button', { type: 'button', class: 'cover-option' }, [
        coverEl({ title: r.title, author: r.author, cover_url: r.cover }),
        el('span', { class: 'book-tile-title', text: r.title }),
        el('span', { class: 'book-tile-author', text: [r.author, r.year].filter(Boolean).join(' · ') }),
      ]);
      btn.addEventListener('click', async () => {
        results.replaceChildren(el('div', { class: 'status-box', text: 'Zapisuję okładkę…' }));
        save(row, {
          cover_url: await ownCover(r.cover), author: r.author?.slice(0, 200) || null, published_year: r.year,
          info_url: r.infoUrl, description: r.description,
        });
      });
      return btn;
    });
    const none = el('button', { type: 'button', class: 'cover-option' }, [
      coverEl({ title: row.title }),
      el('span', { class: 'book-tile-title', text: 'Bez okładki' }),
    ]);
    none.addEventListener('click', () => save(row, { cover_url: null, author: null, published_year: null, info_url: null, description: null }));
    results.replaceChildren(...(options.length ? options : [el('div', { class: 'status-box', text: 'Nic nie znaleziono. Spróbuj inaczej, np. z autorem.' })]), none);
  };

  form.addEventListener('submit', e => {
    e.preventDefault();
    run(input.value.trim() || row.title || '');
  });
  run(query);
}

export async function updateBookInfo(table, row, info) {
  const values = { ...info, info_checked_at: new Date().toISOString() };
  const { error } = await supabaseClient.from(table).update(values).eq('id', row.id);
  if (error) {
    showToast('Nie udało się zapisać: ' + friendlyError(error));
    return false;
  }
  Object.assign(row, values);
  showToast('Zapisano.');
  return true;
}

export async function saveBookInfo(row, info) {
  if (!await updateBookInfo('reads', row, info)) return;
  renderShelf();
  openBookModal(row);
}

export async function saveReadingInfo(item, info) {
  if (!await updateBookInfo('reading_now', item, info)) return;
  renderReadingNow();
  if (currentScreen() === 'polka') renderShelf();
  openReadingModal(item);
  refreshIcons();
}

// Po wylogowaniu: następne konto na tym urządzeniu nie dostaje cudzych okładek ani wyników
export function resetShelfCaches() {
  shelfSignature = null;
  lookupCache.clear();
  enrichInFlight.clear();
  shelfSeq++;
}
