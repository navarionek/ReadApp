import { cropImage } from './cropper.js';
import { viewerId } from './admin.js';
import { handleDropReading, renderReadingNow } from './data.js';
import { daysSince, formatMultiplier, startFinishing } from './form.js';
import { bookPoints, normalizeTitle, titleMatches } from '../supabase/functions/_shared/logic.js';
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

// Okładki książek „Teraz czytam”: szukane w locie i trzymane w pamięci sesji (tytuł -> info albo null)
export const readingCovers = new Map();
export const readingCoversPending = new Set();

export function readingCoverOf(item, onFound) {
  if (item.info_checked_at) return item;  // okładka wybrana albo zapisana w bazie
  const key = normalizeTitle(item.title);
  if (readingCovers.has(key)) return readingCovers.get(key);
  if (!readingCoversPending.has(key)) {
    readingCoversPending.add(key);
    lookupBook(item.title, 3).then(({ results, failed }) => {
      const best = results.find(r => r.cover && titleMatches(item.title, r.title));
      // Nieudane wyszukiwanie nie zostaje zapamiętane jako „brak okładki”
      if (!failed) readingCovers.set(key, best ? { cover_url: best.cover, author: best.author } : null);
      readingCoversPending.delete(key);
      if (best) onFound();
    });
  }
  return null;
}

export function openReadingModal(item) {
  const info = readingCoverOf(item, () => openReadingModal(item));
  const book = { title: item.title, cover_url: info?.cover_url, author: info?.author };
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
    body.push(pickBtn, picker, done, drop);
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

let shelfSeq = 0;  // numer ostatniego żądania półki: starsze odpowiedzi są ignorowane
let shelfSignature = null;  // odcisk ostatnio pobranych danych: bez zmian = nie rysujemy półki od nowa

// Odcisk tego, co widać na półce (wpisy z bazy + „Czyta teraz”), liczony z danych sprzed lokalnych uzupełnień
function shelfSig(userId, rows) {
  const current = state.readingNow.filter(item => item.user_id === userId);
  return JSON.stringify([
    userId,
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

  const { data, error } = await supabaseClient
    .from('reads')
    .select('id, user_id, title, pages, multiplier, unfinished, created_at, started_at, cover_url, author, published_year, info_url, description, info_checked_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  if (seq !== shelfSeq) return;  // w międzyczasie ktoś przełączył półkę albo odświeżył ją ponownie
  if (error) {
    shelf.replaceChildren(el('div', { class: 'status-box', text: 'Nie udało się wczytać półki. ' + friendlyError(error) }));
    return;
  }
  const signature = shelfSig(userId, data || []);
  // Nic się nie zmieniło od ostatniej wizyty: zostawiamy półkę w spokoju, żeby okładki nie mrugały
  if (signature === shelfSignature && state.shelfRows[0]?.user_id === userId) return;
  shelfSignature = signature;
  state.shelfRows = data || [];
  renderShelf();
  fillMissingBookInfo(userId);
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
        const info = readingCoverOf(item, renderShelf);
        const book = { title: item.title, cover_url: info?.cover_url, author: info?.author };
        return bookTile(book, () => openReadingModal(item), true);
      })),
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

  if (!sections.length) {
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

// Uzupełnianie okładek: po 2 naraz. Własne wpisy zapisujemy w bazie (raz na zawsze),
// cudze tylko pokazujemy (baza i tak nie pozwala ich zmieniać).
export async function fillMissingBookInfo(userId) {
  const missing = state.shelfRows.filter(r => !r.info_checked_at);
  const own = userId === state.currentUser?.id;
  let rerender = false;
  const worker = async () => {
    while (missing.length) {
      if ((state.shelfUserId || viewerId()) !== userId) return;  // ktoś przełączył półkę
      const row = missing.shift();
      const { results, google, failed } = await lookupBook(row.title || '', 3);
      const best = results.find(r => titleMatches(row.title, r.title) && r.cover)
        || results.find(r => titleMatches(row.title, r.title));
      // Bez Google Books „nie znaleziono” nie jest pewne: nie zapisujemy, spróbujemy przy następnym otwarciu
      if (failed || (!best && !google)) continue;
      const info = {
        cover_url: own ? await ownCover(best?.cover) : (best?.cover || null),
        author: best?.author?.slice(0, 200) || null,
        published_year: best?.year || null,
        info_url: best?.infoUrl || null,
        description: best?.description || null,
        info_checked_at: new Date().toISOString(),
      };
      Object.assign(row, info);
      if (own) {
        const { error } = await supabaseClient.from('reads').update(info).eq('id', row.id);
        if (error) console.error('Saving book info failed:', error);
      }
      rerender = true;
      requestAnimationFrame(() => {
        if (rerender && currentScreen() === 'polka') {
          rerender = false;
          renderShelf();
        }
      });
    }
  };
  await Promise.all([worker(), worker()]);
}

/* ----------------- Szczegóły książki ----------------- */
// Okno ma własny wpis w historii, więc „Wstecz” zamyka tylko okno i zostaje na tej samej stronie.
// Zwraca obietnicę, która kończy się po zamknięciu (cofnięcie historii jest asynchroniczne),
// żeby kolejna nawigacja nie została przez nie cofnięta.
export function closeBookModal() {
  const modal = document.getElementById('book-modal');
  if (modal.hidden) return Promise.resolve();
  modal.hidden = true;
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
    body.push(pickBtn, picker);
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
  readingCovers.clear();
  readingCoversPending.clear();
  shelfSeq++;
}
