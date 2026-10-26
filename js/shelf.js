import { openBookEditor } from './bookeditor.js';
import { cropImage } from './cropper.js';
import { viewerId } from './admin.js';
import { loadReads, renderReadingNow } from './data.js';
import { daysSince, formatMultiplier, startFinishing } from './form.js';
import { bookPoints } from '../supabase/functions/_shared/logic.js';
import { ratingControl } from './ratings.js';
import { currentScreen } from './shell.js';
import { state } from './state.js';
import { avatar } from './ranking.js';
import { formatDay, seriesColors } from './stats.js';
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

const INFO_FIELDS = ['cover_url', 'author', 'published_year', 'page_count', 'info_url', 'description', 'info_checked_at'];

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

// Serwer (fill-book-info) uzupełnia dane tylko wpisom bez info_checked_at i wpisuje wtedy rok
// z wyszukiwarki. Zanim zapiszemy rok ręcznie, niech to uzupełnienie się odbędzie, inaczej
// nadpisałoby nasz rok. Gdy serwer nie da rady (np. Google nie odpowiada), sami oznaczamy wpis
// jako sprawdzony: rok zostaje, a okładkę można wtedy wybrać ręcznie.
export async function settleBookInfo(table, row) {
  if (row.info_checked_at) return {};
  try {
    const { data, error } = await supabaseClient.functions.invoke('fill-book-info', { body: { table, ids: [row.id] } });
    if (error) throw error;
    const it = (data?.items || []).find(i => i.id === row.id && !i.pending && i.info_checked_at);
    if (it) {
      INFO_FIELDS.forEach(f => { if (f in it) row[f] = it[f]; });
      return {};
    }
  } catch (err) {
    console.error('fill-book-info failed:', err);
  }
  return { info_checked_at: new Date().toISOString() };
}

// source: element okładki, z którego otwarto okno (okładka przeleci z niego na środek)
export function openReadingModal(item, source = null) {
  const info = readingCoverOf(item);
  openReadingId = item.id;
  const book = { title: item.title, cover_url: info?.cover_url, author: item.author || info?.author };
  const own = item.user_id === state.currentUser?.id && viewerId() === state.currentUser?.id;
  const days = daysSince(item.started_at);
  const started = new Date(item.started_at);
  const actions = [];
  if (own) {
    const done = el('button', { type: 'button', class: 'btn btn-primary btn-block' }, [icon('check'), el('span', { text: 'Skończone' })]);
    done.addEventListener('click', async () => {
      await closeBookModal({ animate: false });
      startFinishing(item);
    });
    actions.push(done, editButton('reading_now', item, {
      onSaved: () => {
        if (currentScreen() === 'polka') renderShelf();
        const fresh = state.readingNow.find(i => i.id === item.id);
        if (fresh) openReadingModal(fresh);
      },
      onRemoved: () => { if (currentScreen() === 'polka') renderShelf(); },
    }));
  }
  showSheet(bookSheet({
    book,
    year: item.published_year,
    kicker: own ? 'Czytam teraz' : 'Czyta teraz',
    facts: [
      [days ? String(days) : 'dziś', days ? plural(days, 'dzień', 'dni', 'dni') : 'zaczęta'],
      ...(item.page_count ? [[String(item.page_count), 'stron']] : []),
    ],
    meta: `Zaczęta ${formatDay(started)} ${started.getFullYear()}`,
    description: item.description,
    link: item.info_url,
    actions,
  }), source);
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

/* ----------------- Do przeczytania (kolejka) ----------------- */
// Uzupełnianie okładek książek w kolejce (patrz enrichBooks)
async function fillMissingQueueInfo(userId) {
  await enrichBooks('reading_queue', state.shelfQueue, items => {
    if ((state.shelfUserId || viewerId()) !== userId) return;  // ktoś przełączył półkę
    items.forEach(it => applyInfo(state.shelfQueue, it));
    if (currentScreen() === 'polka') renderShelf();
  });
}

export function openQueueModal(item, source = null) {
  openReadingId = null;
  const own = item.user_id === state.currentUser?.id && viewerId() === state.currentUser?.id;
  const added = new Date(item.created_at);
  const actions = [];
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
      await closeBookModal({ animate: false });
      showToast('Zaczęte! Książka jest teraz w „Czyta teraz”.');
      shelfSignature = null;
      await loadReads();
      await loadShelf();
    });
    actions.push(start, editButton('reading_queue', item, {
      onSaved: () => {
        renderShelf();
        openQueueModal(item);
      },
      onRemoved: () => {
        shelfSignature = null;
        loadShelf();
      },
    }));
  }
  showSheet(bookSheet({
    book: { title: item.title, cover_url: item.cover_url, author: item.author },
    year: item.published_year,
    kicker: 'Do przeczytania',
    facts: item.page_count ? [[String(item.page_count), 'stron']] : [],
    meta: `W kolejce od ${formatDay(added)} ${added.getFullYear()}`,
    description: item.description,
    link: item.info_url,
    actions,
  }), source);
}

const QUEUE_FIELDS = 'id, user_id, title, author, cover_url, published_year, page_count, info_url, description, info_checked_at, created_at';

let shelfSeq = 0;  // numer ostatniego żądania półki: starsze odpowiedzi są ignorowane
let shelfSignature = null;  // odcisk ostatnio pobranych danych: bez zmian = nie rysujemy półki od nowa

// Odcisk tego, co widać na półce (wpisy z bazy + „Czyta teraz”), liczony z danych sprzed lokalnych uzupełnień
function shelfSig(userId, rows, queue = []) {
  const current = state.readingNow.filter(item => item.user_id === userId);
  return JSON.stringify([
    userId,
    queue.map(q => [q.id, q.title, q.author, q.cover_url, q.info_checked_at]),
    rows.map(r => [r.id, r.title, r.pages, r.multiplier, r.unfinished, r.rating, r.created_at, r.cover_url, r.author, r.published_year, r.info_checked_at]),
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
      .select('id, user_id, title, pages, multiplier, multiplier_labels, unfinished, rating, created_at, started_at, cover_url, author, published_year, info_url, description, info_checked_at')
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

/* ----------------- Półka ----------------- */
// U góry nagłówek osoby (zdjęcie, liczby, w tle rozmyta okładka ostatniej książki) i wybór, czyją
// półkę oglądamy. Niżej „Czytam teraz” jako karty, stos „Do przeczytania” i przeczytane książki
// w siatce okładek, rok po roku. Stuknięcie otwiera okno książki.
const firstName = name => (name || '?').split(' ')[0];
const plural = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

let shelfPeople = [];    // [{ key, name, avatarUrl, color }] z profili

export async function loadShelfPeople() {
  const { data, error } = await supabaseClient.from('profiles').select('id, display_name, avatar_url, color').order('display_name');
  if (error) return;
  shelfPeople = data.map(p => ({ key: p.id, name: p.display_name || '?', avatarUrl: p.avatar_url, color: p.color }));
  renderShelfPeople();
  renderShelfHero();
}

function shelfOwner() {
  const id = state.shelfUserId || viewerId();
  return shelfPeople.find(p => p.key === id) || { key: id, name: '' };
}

// Wybór osoby: okrągłe zdjęcia z imionami, przewijane w bok
function renderShelfPeople() {
  const box = document.getElementById('shelf-people');
  if (shelfPeople.length < 2) {
    box.replaceChildren();
    return;
  }
  const colors = seriesColors(shelfPeople);
  const current = state.shelfUserId || viewerId();
  box.replaceChildren(...shelfPeople.map(p => {
    const active = p.key === current;
    const chip = el('button', { type: 'button', class: `shelf-person${active ? ' active' : ''}`, 'aria-pressed': String(active) }, [
      avatar(p, colors),
      el('span', { text: p.key === viewerId() ? 'Ty' : firstName(p.name) }),
    ]);
    chip.addEventListener('click', () => {
      if (active) return;
      state.shelfUserId = p.key === viewerId() ? null : p.key;
      renderShelfPeople();
      loadShelf();
    });
    return chip;
  }));
}

function renderShelfHero() {
  const hero = document.getElementById('shelf-hero');
  const owner = shelfOwner();
  const isOwn = owner.key === viewerId();
  const rows = state.shelfRows.filter(r => r.user_id === owner.key);
  const pages = rows.reduce((sum, r) => sum + (r.pages || 0), 0);
  const loved = rows.filter(r => r.rating === 1).length;
  const latest = rows.find(r => r.cover_url);
  const backdrop = el('div', { class: 'shelf-hero-bg', 'aria-hidden': 'true' });
  if (latest) backdrop.style.setProperty('--cover', `url("${latest.cover_url.replace(/"/g, '%22')}")`);
  const colors = seriesColors(shelfPeople.length ? shelfPeople : [owner]);
  const stat = (value, label) => el('div', { class: 'shelf-stat' }, [el('strong', { text: value }), el('span', { text: label })]);
  hero.replaceChildren(
    backdrop,
    el('div', { class: 'shelf-hero-body' }, [
      avatar(owner, colors, 'rank-avatar-lg shelf-hero-avatar'),
      el('div', { class: 'shelf-hero-text' }, [
        el('h2', { class: 'shelf-hero-title', text: isOwn ? 'Twoja półka' : `Półka: ${firstName(owner.name)}` }),
        el('p', { class: 'shelf-hero-sub', text: rows.length ? `Od ${new Date(rows.at(-1).created_at).getFullYear()} roku w Czytanku` : 'Czeka na pierwszą książkę' }),
      ]),
    ]),
    el('div', { class: 'shelf-stats' }, [
      stat(String(rows.length), plural(rows.length, 'książka', 'książki', 'książek')),
      stat(pages.toLocaleString('pl-PL'), 'stron'),
      stat(String(loved), plural(loved, 'ulubiona', 'ulubione', 'ulubionych')),
    ]),
  );
}

export function renderShelf() {
  renderShelfPeople();
  renderShelfHero();
  const userId = state.shelfUserId || viewerId();
  const isOwn = userId === viewerId();
  const sections = [];
  const heading = (text, count) => el('h3', { class: 'shelf-heading' }, [
    el('span', { text }),
    ...(count ? [el('span', { class: 'shelf-heading-count', text: String(count) })] : []),
  ]);

  // Czytam teraz: karty z okładką i licznikiem dni
  const current = state.readingNow.filter(item => item.user_id === userId);
  if (current.length) {
    sections.push(el('section', { class: 'shelf-section' }, [
      heading(isOwn ? 'Czytam teraz' : 'Czyta teraz'),
      el('div', { class: 'shelf-now' }, current.map(item => {
        const info = readingCoverOf(item);
        const book = { title: item.title, cover_url: info?.cover_url, author: item.author || info?.author };
        const days = daysSince(item.started_at);
        const card = el('button', { type: 'button', class: 'shelf-now-card' }, [
          coverEl(book),
          el('span', { class: 'shelf-now-text' }, [
            el('strong', { text: item.title }),
            ...(book.author ? [el('span', { class: 'shelf-now-author', text: book.author })] : []),
            el('span', { class: 'shelf-now-days' }, [icon('bookmark'), el('span', { text: days ? `${days}. dzień` : 'od dziś' })]),
          ]),
        ]);
        card.addEventListener('click', () => openReadingModal(item, card.querySelector('.book-cover')));
        return card;
      })),
    ]));
  }

  // Stos do przeczytania: małe okładki przewijane w bok
  if (isOwn || state.shelfQueue.length) {
    const nq = state.shelfQueue.length;
    sections.push(el('section', { class: 'shelf-section' }, [
      heading('Do przeczytania', nq),
      nq
        ? el('div', { class: 'shelf-stack' }, state.shelfQueue.map(item => {
            const book = { title: item.title, author: item.author, cover_url: item.cover_url };
            const tile = el('button', { type: 'button', class: 'shelf-stack-book', title: item.title }, [
              coverEl(book),
              el('span', { class: 'shelf-stack-title', text: item.title }),
            ]);
            tile.addEventListener('click', () => openQueueModal(item, tile.querySelector('.book-cover')));
            return tile;
          }))
        : el('p', { class: 'shelf-empty-line', text: 'Pusto.' }),
    ]));
  }

  // Przeczytane: rok po roku, siatka okładek z tytułami
  const byYear = new Map();
  state.shelfRows.forEach(r => {
    const y = new Date(r.created_at).getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  });
  byYear.forEach((rows, year) => {
    sections.push(el('section', { class: 'shelf-section' }, [
      heading(String(year), rows.length),
      el('div', { class: 'shelf-grid' }, rows.map(bookTile)),
    ]));
  });

  if (!current.length && !byYear.size) {
    sections.push(el('div', { class: 'status-box', text: isOwn ? 'Pusto na półce. Dodaj pierwszą przeczytaną książkę!' : 'Ta osoba nie ma jeszcze książek na półce.' }));
  }

  document.getElementById('shelf').replaceChildren(...sections);
  refreshIcons();
}

// Przeczytana książka w siatce: okładka, tytuł, autor
function bookTile(row) {
  const tile = el('button', { type: 'button', class: 'book-tile', title: row.title || '' }, [
    coverEl(row),
    el('span', { class: 'book-tile-title', text: row.title || 'bez tytułu' }),
    ...(row.unfinished ? [el('span', { class: 'unfinished-tag', text: 'niedokończona' })] : []),
    ...(row.author ? [el('span', { class: 'book-tile-author', text: row.author })] : []),
  ]);
  tile.addEventListener('click', () => openBookModal(row, tile.querySelector('.book-cover')));
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
// Jedno okno dla przeczytanej, czytanej i czekającej książki: rozmyta okładka w tle, duża
// okładka, tytuł i autor szeryfowo, kafelki z liczbami, data, ocena, rozwijany opis, link
// i przyciski. Otwarte z okładki na półce: okładka przelatuje z półki na środek (shared
// element), a przy zamykaniu wraca na swoje miejsce. Na półce w tym czasie jej nie widać.

// „Edytuj książkę” w oknie: zamyka okno i otwiera jeden wspólny ekran edycji (js/bookeditor.js)
function editButton(kind, row, callbacks) {
  const btn = el('button', { type: 'button', class: 'btn btn-outline btn-block' }, [icon('pencil'), el('span', { text: 'Edytuj książkę' })]);
  btn.addEventListener('click', async () => {
    await closeBookModal({ animate: false });
    openBookEditor(kind, row, callbacks);
  });
  return btn;
}

function bookSheet({ book, year, kicker, lead = [], facts = [], meta, extra = [], description, link, actions = [] }) {
  const backdrop = el('div', { class: 'bs-bg', 'aria-hidden': 'true' });
  if (book.cover_url) backdrop.style.setProperty('--cover', `url("${book.cover_url.replace(/"/g, '%22')}")`);
  else {
    const h = titleHue(book.title);
    backdrop.style.setProperty('--cover', `linear-gradient(160deg, hsl(${h} 55% 45%), hsl(${(h + 40) % 360} 55% 25%))`);
  }
  // Długi opis zwinięty do kilku linii, z przyciskiem „Więcej”
  let desc = [];
  if (description) {
    const text = el('p', { class: 'bs-desc', text: description });
    desc = [text];
    if (description.length > 260) {
      text.classList.add('clamped');
      const more = el('button', { type: 'button', class: 'bs-more', text: 'Więcej' });
      more.addEventListener('click', () => {
        const open = text.classList.toggle('clamped');
        more.textContent = open ? 'Więcej' : 'Mniej';
      });
      desc.push(more);
    }
  }
  return [
    backdrop,
    el('div', { class: 'bs-hero' }, [
      el('div', { class: 'bs-cover' }, [coverEl(book, 'large')]),
      el('span', { class: 'bs-kicker', text: kicker }),
      el('h2', { id: 'book-modal-title', class: 'bs-title', text: book.title || 'bez tytułu' }),
      ...(book.author || year ? [el('p', { class: 'bs-author', text: [book.author, year].filter(Boolean).join(' · ') })] : []),
    ]),
    el('div', { class: 'bs-body' }, [
      ...lead,
      ...(facts.length
        ? [el('div', { class: 'bs-facts' }, facts.map(([value, label]) => el('div', { class: 'bs-fact' }, [el('strong', { text: value }), el('span', { text: label })])))]
        : []),
      ...(meta ? [el('p', { class: 'bs-meta' }, [icon('calendar'), el('span', { text: meta })])] : []),
      ...extra,
      ...desc,
      ...(link
        ? [el('a', { class: 'bs-link', href: link, target: '_blank', rel: 'noopener noreferrer' }, [
            el('span', { text: link.includes('google') ? 'Więcej w Google Books' : 'Więcej w Open Library' }),
            icon('arrow-up-right'),
          ])]
        : []),
      ...(actions.length ? [el('div', { class: 'bs-actions' }, actions)] : []),
    ]),
  ];
}

const calmMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let sheetSource = null;   // okładka na półce, z której przyleciała okładka okna
let sheetClosing = null;  // trwające zamykanie (obietnica)

// Kopia okładki leci nad oknem między okładką na półce (small) a tą w oknie (large).
// Kopia ma rozmiar dużej okładki i jest zmniejszana, więc w locie się nie rozmywa.
// way: 'in' = z półki do okna, 'out' = z okna z powrotem na półkę
function flyCover(small, large, cover, way) {
  const ghost = cover.cloneNode(true);
  ghost.classList.add('bs-ghost');
  ghost.style.visibility = 'visible';
  Object.assign(ghost.style, { left: `${large.left}px`, top: `${large.top}px`, width: `${large.width}px`, height: `${large.height}px` });
  document.body.appendChild(ghost);
  const shrunk = { transform: `translate(${small.left - large.left}px, ${small.top - large.top}px) scale(${small.width / large.width}, ${small.height / large.height})` };
  const frames = way === 'in' ? [shrunk, { transform: 'none' }] : [{ transform: 'none' }, shrunk];
  const anim = ghost.animate(frames, { duration: way === 'in' ? 420 : 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
  // Bezpiecznik: gdyby animacja stanęła (np. karta w tle), okładka i tak wraca na miejsce
  const timeout = new Promise(resolve => setTimeout(resolve, way === 'in' ? 700 : 550));
  return Promise.race([anim.finished.catch(() => {}), timeout]).then(() => ghost.remove());
}

function showSheet(children, source) {
  const modal = document.getElementById('book-modal');
  const wasOpen = !modal.hidden;
  const from = !wasOpen && source?.isConnected && !calmMotion() ? source.getBoundingClientRect() : null;
  const flying = !!from?.width;
  // Przy przelocie okno tylko się rozjaśnia (bez przesuwania i skalowania): okładka w oknie stoi
  // od początku w swoim miejscu, więc kopia ląduje dokładnie na niej, bez przeskoku na końcu
  modal.classList.toggle('flying', flying);
  document.getElementById('book-modal-body').replaceChildren(...children);
  const target = modal.querySelector('.bs-cover .book-cover');
  if (flying && target) target.style.visibility = 'hidden';
  showBookModal();
  refreshIcons();
  if (!flying || !target) return;
  sheetSource = source;
  source.style.visibility = 'hidden';
  flyCover(from, target.getBoundingClientRect(), target, 'in').then(() => { target.style.visibility = ''; });
}

// Wyjście: okładka wraca na półkę (jeśli jej miejsce jest widoczne), okno gaśnie
function animateClose(animate) {
  const modal = document.getElementById('book-modal');
  const source = sheetSource;
  sheetSource = null;
  const target = modal.querySelector('.bs-cover .book-cover');
  const back = animate && !calmMotion() && source?.isConnected && target ? source.getBoundingClientRect() : null;
  const finish = () => {
    modal.hidden = true;
    modal.classList.remove('closing');
    if (source) source.style.visibility = '';
  };
  if (!animate || calmMotion()) {
    finish();
    return Promise.resolve();
  }
  modal.classList.add('closing');
  const waits = [new Promise(resolve => setTimeout(resolve, 240))];
  if (back?.width && back.bottom > 0 && back.top < window.innerHeight) {
    const from = target.getBoundingClientRect();
    target.style.visibility = 'hidden';
    waits.push(flyCover(back, from, target, 'out'));
  }
  return Promise.all(waits).then(finish);
}

// Okno ma własny wpis w historii, więc „Wstecz” zamyka tylko okno i zostaje na tej samej stronie.
// Zwraca obietnicę, która kończy się po zamknięciu (cofnięcie historii jest asynchroniczne),
// żeby kolejna nawigacja nie została przez nie cofnięta.
export function closeBookModal({ animate = true } = {}) {
  const modal = document.getElementById('book-modal');
  if (modal.hidden) return sheetClosing || Promise.resolve();
  openReadingId = null;
  const leaving = history.state?.bookModal
    ? new Promise(resolve => {
        window.addEventListener('popstate', resolve, { once: true });
        history.back();
      })
    : Promise.resolve();
  sheetClosing = Promise.all([animateClose(animate), leaving]).then(() => { sheetClosing = null; });
  return sheetClosing;
}

function showBookModal() {
  const modal = document.getElementById('book-modal');
  if (modal.hidden) history.pushState({ bookModal: true }, '');
  modal.classList.remove('closing');
  modal.hidden = false;
}

// „Wstecz” w telefonie: okno zamyka się z animacją (gdy zamykamy sami, okno jest już w trakcie)
window.addEventListener('popstate', () => {
  const modal = document.getElementById('book-modal');
  if (!modal.hidden && !modal.classList.contains('closing')) {
    openReadingId = null;
    animateClose(true);
  }
});

export function openBookModal(row, source = null) {
  openReadingId = null;
  const own = row.user_id === state.currentUser?.id && viewerId() === state.currentUser?.id;
  const finished = new Date(row.created_at);
  const started = row.started_at ? new Date(row.started_at) : null;
  const days = started ? Math.max(1, Math.round((finished - started) / 86400000)) : null;
  const meta = started
    ? `${formatDay(started)} – ${formatDay(finished)} ${finished.getFullYear()}`
    : `Skończona ${formatDay(finished)} ${finished.getFullYear()}`;
  const mult = Number(row.multiplier);

  // Ocena zaraz pod tytułem: własna książka = dwa duże przyciski (zapis od razu), cudza = sama ocena
  const rating = ratingControl(row, own, () => {
    renderShelf();
    openBookModal(row);
  }, { big: true });
  const lead = rating ? [el('div', { class: 'bs-rate' }, [...(own ? [el('span', { class: 'bs-rate-label', text: 'Jak ci się podobała?' })] : []), rating])] : [];

  showSheet(bookSheet({
    book: row,
    year: row.published_year,
    kicker: row.unfinished ? 'Niedokończona' : 'Przeczytana',
    facts: [
      [String(row.pages), 'stron'],
      [String(bookPoints(row)), 'punktów'],
      ...(mult !== 1 ? [[`×${formatMultiplier(mult).replace('.', ',')}`, 'mnożnik']] : []),
      ...(days ? [[String(days), plural(days, 'dzień', 'dni', 'dni')]] : []),
    ].slice(0, 3),
    meta,
    lead,
    description: row.description,
    link: row.info_url,
    actions: own
      ? [editButton('reads', row, {
          onSaved: () => {
            renderShelf();
            openBookModal(row);
          },
          onRemoved: () => {
            shelfSignature = null;
            loadShelf();
          },
        })]
      : [],
  }), source);
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

// save(row, info) dostaje wybór (okładka i informacje z bazy książek); zapisuje go edytor książki
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
        page_count: row.page_count ?? null,
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
          cover_url: await ownCover(r.cover), author: r.author?.slice(0, 200) || null, published_year: r.year, page_count: r.pages ?? null,
          info_url: r.infoUrl, description: r.description,
        });
      });
      return btn;
    });
    const none = el('button', { type: 'button', class: 'cover-option' }, [
      coverEl({ title: row.title }),
      el('span', { class: 'book-tile-title', text: 'Bez okładki' }),
    ]);
    none.addEventListener('click', () => save(row, { cover_url: null, author: null, published_year: null, page_count: null, info_url: null, description: null }));
    results.replaceChildren(...(options.length ? options : [el('div', { class: 'status-box', text: 'Nic nie znaleziono. Spróbuj inaczej, np. z autorem.' })]), none);
  };

  form.addEventListener('submit', e => {
    e.preventDefault();
    run(input.value.trim() || row.title || '');
  });
  run(query);
}

// Po wylogowaniu: następne konto na tym urządzeniu nie dostaje cudzych okładek ani wyników
export function resetShelfCaches() {
  shelfSignature = null;
  lookupCache.clear();
  enrichInFlight.clear();
  shelfSeq++;
}
