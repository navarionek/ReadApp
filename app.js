/* ----------------- Configuration ----------------- */
const SUPABASE_URL = 'https://ipqjdqvfyfgggykaazug.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_lYoZG-uKAFWKMzyu4YV45Q_64jU7CBW';

// Klient sam dokłada token zalogowanego usera do każdego zapytania
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const AUTH_ONLY_SECTIONS = ['user-panel', 'app-nav', 'app-screens'];
const SCREENS = ['start', 'dodaj', 'ranking', 'postepy', 'polka', 'statystyki', 'admin'];

let currentUser = null;
let editingId = null;   // id wpisu edytowanego w formularzu, null = dodawanie
let hasData = false;    // czy coś już jest pokazane (wtedy błąd odświeżenia nie czyści tabel)
let isAdmin = false;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ----------------- Helpers ----------------- */
// Buduje element bez innerHTML, tekst zawsze idzie przez textContent
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function icon(name) {
  return el('i', { 'data-lucide': name });
}

function refreshIcons() {
  if (window.lucide) lucide.createIcons();
}

function displayNameOf(user) {
  return user.user_metadata?.full_name || user.email;
}

function setHeaderName(name) {
  document.getElementById('display-name').textContent = name;
}

function currentYear() {
  return new Date().getFullYear();
}

// Komunikaty po polsku zamiast surowych błędów z Supabase
function friendlyError(err) {
  const msg = err?.message || '';
  if (!navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return 'Brak połączenia z internetem. Spróbuj ponownie.';
  }
  if (/JWT|expired|not authenticated/i.test(msg)) {
    return 'Sesja wygasła. Wyloguj się i zaloguj ponownie.';
  }
  if (err?.code === '23514') {
    return 'Nieprawidłowe dane: sprawdź liczbę stron (1–5000) i tytuł.';
  }
  if (err?.code === '42501') {
    return 'Brak uprawnień do tej operacji.';
  }
  return msg || 'Wystąpił błąd. Spróbuj ponownie.';
}

function showError(msg) {
  const errDiv = document.getElementById('error-message');
  errDiv.textContent = msg;
  errDiv.hidden = false;
}

function hideError() {
  document.getElementById('error-message').hidden = true;
}

let toastTimer = null;
function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2500);
}

/* ----------------- Ekrany (menu) ----------------- */
// Ekran wynika z #hash w adresie, więc działa przycisk Wstecz.
// Nieznany hash (np. #access_token po powrocie z logowania Google) = Start; nie nadpisujemy go,
// bo supabase-js sam go czyta i czyści.
function currentScreen() {
  const name = window.location.hash.slice(1);
  return SCREENS.includes(name) ? name : 'start';
}

function showScreen(name) {
  if (name === 'admin' && !isAdmin) name = 'start';
  // Wyjście z formularza w trakcie edycji = porzucenie edycji, żeby „Dodaj” było znowu puste
  if (name !== 'dodaj' && (editingId || finishing)) cancelEdit();
  document.querySelectorAll('.screen').forEach(screen => {
    screen.hidden = screen.dataset.screen !== name;
  });
  document.querySelectorAll('.nav-item').forEach(item => {
    const active = item.dataset.screen === name;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);

  if (name === 'polka' && currentUser) loadShelf();
  if (name !== 'polka') closeBookModal();

  // Wyścig odpala się przy każdym wejściu na Statystyki (po wczytaniu danych)
  if (name === 'statystyki') {
    if (hasData) requestAnimationFrame(() => { drawTimeline(); playRace(); });
    else racePending = true;
  } else if (raceFrame !== null) {
    cancelAnimationFrame(raceFrame);
    raceFrame = null;
  }
}

function goTo(name) {
  if (window.location.hash === '#' + name) showScreen(name);
  else window.location.hash = name;
}

/* ----------------- Theme handling ----------------- */
function setTheme(isDark) {
  document.documentElement.classList.toggle('dark-mode', isDark);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) themeIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  document.getElementById('theme-toggle')?.setAttribute('aria-checked', String(isDark));
  document.getElementById('theme-switch')?.classList.toggle('on', isDark);
  try {
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  } catch {}
  refreshIcons();
}

function toggleSettings() {
  const menu = document.getElementById('settings-menu');
  menu.hidden = !menu.hidden;
  document.getElementById('settings-btn').setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) menu.querySelector('.settings-item:not([hidden])')?.focus();
}

function closeSettings() {
  const menu = document.getElementById('settings-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  document.getElementById('settings-btn').setAttribute('aria-expanded', 'false');
}

function toggleTheme() {
  setTheme(!document.documentElement.classList.contains('dark-mode'));
}

/* ----------------- Auth & User handling ----------------- */
async function handleGoogleLogin() {
  const redirectUrl = window.location.origin + window.location.pathname;
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: redirectUrl },
  });
  if (error) {
    alert('Błąd logowania: ' + friendlyError(error));
  }
}

async function handleLogout() {
  closeSettings();
  // Po wylogowaniu to urządzenie nie powinno dostawać powiadomień dla tego konta
  await disablePush({ quiet: true });
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    alert('Błąd wylogowania: ' + friendlyError(error));
  }
}

function updateUI(user) {
  currentUser = user;
  document.getElementById('login-modal').hidden = !!user;
  AUTH_ONLY_SECTIONS.forEach(id => {
    document.getElementById(id).hidden = !user;
  });
  // Nazwa z Google tylko do czasu wczytania profilu (nie nadpisuj jej przy odświeżeniu tokenu)
  const header = document.getElementById('display-name');
  if (!user) setHeaderName('');
  else if (!header.textContent) setHeaderName(displayNameOf(user));

  if (!user) {
    hasData = false;
    isAdmin = false;
    viewAs = null;
    shelfUserId = null;
    shelfRows = [];
    closeBookModal();
    ['settings-admin', 'prize-banner', 'goal-card', 'view-as-banner'].forEach(id => {
      document.getElementById(id).hidden = true;
    });
    cancelEdit();
    document.getElementById('leaderboard-body').replaceChildren();
    document.getElementById('user-progress-container').replaceChildren();
  }
}

/* ----------------- Mnożniki (z tabeli, zarządza admin) ----------------- */
let multipliers = [];          // [{ id, label, value }]
let editingMultiplier = null;  // mnożnik edytowanego wpisu, zachowany, jeśli nie da się go odtworzyć z checkboxów
let multiplierTouched = false;

function formatMultiplier(value) {
  return String(Number(value));
}

async function loadMultipliers() {
  const { data, error } = await supabaseClient
    .from('multipliers')
    .select('id, label, value')
    .order('id');

  if (error) {
    console.error('Error loading multipliers:', error);
    return;
  }
  multipliers = data.map(m => ({ ...m, value: Number(m.value) }));
  renderMultiplierCheckboxes();
  if (isAdmin) renderMultiplierAdmin();
  refreshIcons();
}

function renderMultiplierCheckboxes() {
  const container = document.getElementById('multiplier-container');
  if (!multipliers.length) {
    container.replaceChildren(el('span', { class: 'hint', text: 'Brak mnożników.' }));
    return;
  }
  container.replaceChildren(...multipliers.map(m => {
    const checkbox = el('input', { type: 'checkbox', class: 'multiplier-checkbox', value: String(m.value) });
    checkbox.addEventListener('change', () => {
      multiplierTouched = true;
      document.getElementById('multiplier-note').hidden = true;
    });
    return el('label', { class: 'checkbox-label' }, [
      checkbox,
      el('span', { class: 'check-text', text: `${formatMultiplier(m.value)}x ${m.label}` }),
    ]);
  }));
}

/* ----------------- Form: add & edit ----------------- */
function multiplierCheckboxes() {
  return [...document.querySelectorAll('.multiplier-checkbox')];
}

function readMultiplier() {
  // Edycja wpisu z mnożnikiem spoza obecnych opcji: bez ruszania checkboxów zostaje stary
  if (editingId && !multiplierTouched && editingMultiplier !== null) return editingMultiplier;
  const product = multiplierCheckboxes()
    .filter(cb => cb.checked)
    .reduce((m, cb) => m * parseFloat(cb.value), 1);
  return Math.round(product * 10000) / 10000;
}

// Odwrotność readMultiplier: znajdź zestaw checkboxów, który daje zapisany mnożnik
function applyMultiplier(multiplier) {
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
let entryMode = 'finished';  // 'finished' albo 'started' (dodaj do „Teraz czytam”)
let finishing = null;        // { id, title, startedAt } gdy kończymy książkę z „Teraz czytam”
let finishPickedNew = false; // ktoś świadomie wybrał „Inna książka” zamiast zaczętej

function todayInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysSince(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS));
}

function myReadingNow() {
  return readingNow.filter(item => item.user_id === currentUser?.id);
}

function selectFinishing(item) {
  finishing = item ? { id: item.id, title: item.title, startedAt: item.started_at, item } : null;
  document.getElementById('title').value = item ? item.title : '';
}

// Lista „Którą książkę kończysz?”: zaczęte książki + „Inna książka”
function renderFinishPick() {
  const select = document.getElementById('finish-pick');
  const items = myReadingNow();
  select.replaceChildren(
    ...items.map(item => el('option', { value: String(item.id), text: `${item.title} (od ${formatDay(new Date(item.started_at))})` })),
    el('option', { value: 'new', text: 'Inna książka (wpisz tytuł)' }),
  );
  select.value = finishing ? String(finishing.id) : 'new';
}

// Domyślnie kończymy pierwszą zaczętą książkę, jeśli formularz jest „pusty”
function applyFinishDefault() {
  if (editingId || entryMode !== 'finished' || finishing || finishPickedNew) return;
  const first = myReadingNow()[0];
  if (first) selectFinishing(first);
}

function updateFormUI() {
  const isEditing = !!editingId;
  const started = entryMode === 'started' && !isEditing;
  const canPick = !isEditing && !started && myReadingNow().length > 0;

  document.getElementById('form-title').textContent =
    isEditing ? 'Edytuj wpis' : started ? 'Zaczynam czytać' : 'Dodaj postęp';
  document.getElementById('submit-label').textContent =
    isEditing ? 'Zapisz zmiany' : started ? 'Zacznij czytać' : finishing ? 'Dodaj skończoną książkę' : 'Dodaj wpis';

  document.getElementById('mode-toggle').hidden = isEditing;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    const active = btn.dataset.mode === entryMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  document.getElementById('finish-pick-group').hidden = !canPick;
  if (canPick) renderFinishPick();
  // Tytuł bierze się z wybranej zaczętej książki, więc pole jest wtedy schowane
  document.getElementById('title-group').hidden = !!finishing && !started;
  document.getElementById('started-group').hidden = !started;
  document.getElementById('pages-group').hidden = started;
  document.getElementById('multiplier-group').hidden = started;
  document.getElementById('unfinished-group').hidden = started;
  document.getElementById('pages').required = !started;

  const note = document.getElementById('finishing-note');
  note.hidden = !finishing || started;
  if (finishing) {
    const days = daysSince(finishing.startedAt);
    note.textContent = `Zaczęte ${formatDay(new Date(finishing.startedAt))} (${days} ${days === 1 ? 'dzień' : 'dni'} temu). Wpisz liczbę stron.`;
  }

  document.getElementById('cancel-edit-btn').hidden = !isEditing;
}

function setEntryMode(mode) {
  entryMode = mode;
  if (mode === 'started') {
    // Nowa zaczęta książka: zaczynamy od pustego tytułu; po powrocie znowu podpowiemy zaczętą
    selectFinishing(null);
    finishPickedNew = false;
  } else {
    applyFinishDefault();
  }
  hideError();
  updateFormUI();
}

function handleFinishPick() {
  const value = document.getElementById('finish-pick').value;
  finishPickedNew = value === 'new';
  selectFinishing(myReadingNow().find(item => String(item.id) === value) || null);
  hideError();
  updateFormUI();
  if (finishPickedNew) document.getElementById('title').focus({ preventScroll: true });
}

function startFinishing(item) {
  cancelEdit();
  selectFinishing(item);
  updateFormUI();
  goTo('dodaj');
  document.getElementById('pages').focus({ preventScroll: true });
}

function startEdit(book) {
  finishing = null;
  editingId = book.id;
  document.getElementById('title').value = book.title || '';
  document.getElementById('pages').value = book.pages;
  document.getElementById('unfinished').checked = !!book.unfinished;
  editingMultiplier = Number(book.multiplier);
  multiplierTouched = false;
  const note = document.getElementById('multiplier-note');
  const matched = applyMultiplier(editingMultiplier);
  note.textContent = matched
    ? ''
    : `Ten wpis ma mnożnik ${formatMultiplier(editingMultiplier)}x, którego nie da się złożyć z obecnych opcji. Zostanie zachowany, jeśli nie zmienisz zaznaczenia.`;
  note.hidden = matched;
  hideError();
  updateFormUI();
  goTo('dodaj');
  document.getElementById('title').focus({ preventScroll: true });
}

function cancelEdit() {
  editingId = null;
  editingMultiplier = null;
  multiplierTouched = false;
  finishing = null;
  finishPickedNew = false;
  entryMode = 'finished';
  document.getElementById('multiplier-note').hidden = true;
  document.getElementById('read-form').reset();
  document.getElementById('started-date').value = todayInputValue();
  applyFinishDefault();
  hideError();
  updateFormUI();
}

async function handleDelete(book) {
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
  if (editingId === book.id) cancelEdit();
  await loadReads();
}

document.getElementById('read-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideError();

  if (!currentUser) {
    showError('Musisz być zalogowany!');
    return;
  }

  const submitBtn = document.getElementById('submit-btn');
  const submitLabel = document.getElementById('submit-label');
  const title = document.getElementById('title').value.trim();
  const pages = parseInt(document.getElementById('pages').value, 10);
  const multiplier = readMultiplier();
  const startingNow = entryMode === 'started' && !editingId && !finishing;

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

    // user_id i created_at ustawia baza (defaulty); przy kończeniu zaczętej idzie też started_at
    const values = { title, pages, multiplier, unfinished: document.getElementById('unfinished').checked };
    if (finishing) values.started_at = finishing.startedAt;
    const { data, error } = editingId
      ? await supabaseClient.from('reads').update(values).eq('id', editingId).select('id')
      : await supabaseClient.from('reads').insert(values).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('Nie udało się zapisać wpisu (brak uprawnień).');

    // Okładka wybrana w trakcie czytania przechodzi do wpisu (kolumny okładki da się tylko aktualizować)
    if (finishing?.item.info_checked_at && !editingId) {
      const { item } = finishing;
      const info = {
        cover_url: item.cover_url, author: item.author, published_year: item.published_year,
        info_url: item.info_url, description: item.description, info_checked_at: item.info_checked_at,
      };
      const { error: infoError } = await supabaseClient.from('reads').update(info).eq('id', data[0].id);
      if (infoError) console.error('Copying book info failed:', infoError);
    }

    // Skończona książka znika z „Teraz czytam” (wpis już jest, więc błąd tu nie jest krytyczny)
    if (finishing) {
      const { error: delError } = await supabaseClient.from('reading_now').delete().eq('id', finishing.id);
      if (delError) console.error('Error removing reading_now:', delError);
    }

    const wasEditing = !!editingId;
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

/* ----------------- Profile ----------------- */
async function loadProfile() {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('display_name, is_admin')
    .eq('id', currentUser.id)
    .maybeSingle();

  if (error) {
    console.error('Error loading profile:', error);
    return;
  }
  if (!data) return;

  setHeaderName(data.display_name);
  isAdmin = data.is_admin;
  document.getElementById('settings-admin').hidden = !isAdmin;
  // Wejście prosto na #admin: ekran pokazujemy dopiero, gdy wiadomo, że to admin
  if (currentScreen() === 'admin') showScreen('admin');
  if (isAdmin && !document.getElementById('prize-year').value) {
    document.getElementById('prize-year').value = currentYear();
    loadPrizeIntoForm();
  }
  if (isAdmin) {
    loadMoneyPrizeList();
    loadViewAsOptions();
    renderMultiplierAdmin();
    refreshIcons();
  }
}

/* ----------------- Nagroda pieniężna: uczestnicy ----------------- */
function showMoneyPrizeMessage(text, isError = false) {
  const msg = document.getElementById('money-prize-message');
  msg.textContent = text;
  msg.classList.toggle('error-msg', isError);
  msg.hidden = false;
}

async function loadMoneyPrizeList() {
  const list = document.getElementById('money-prize-list');
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, display_name, in_money_prize')
    .order('display_name');

  if (error) {
    list.replaceChildren(el('div', { class: 'status-box', text: 'Nie udało się wczytać kont. ' + friendlyError(error) }));
    return;
  }

  list.replaceChildren(...data.map(profile => {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = profile.in_money_prize;
    checkbox.addEventListener('change', () => handleMoneyPrizeToggle(profile, checkbox));
    return el('label', { class: 'checkbox-label' }, [checkbox, el('span', { text: profile.display_name })]);
  }));
}

async function handleMoneyPrizeToggle(profile, checkbox) {
  const participates = checkbox.checked;
  checkbox.disabled = true;
  document.getElementById('money-prize-message').hidden = true;

  // Zmiana tylko przez funkcję w bazie, która sprawdza, czy wołający jest adminem
  const { error } = await supabaseClient.rpc('set_money_prize', { target: profile.id, participates });
  checkbox.disabled = false;

  if (error) {
    checkbox.checked = !participates;
    showMoneyPrizeMessage('Nie udało się zapisać: ' + friendlyError(error), true);
    return;
  }
  showMoneyPrizeMessage(`${profile.display_name}: ${participates ? 'bierze udział' : 'nie bierze udziału'} w nagrodzie pieniężnej.`);
  await loadReads();
}

/* ----------------- Admin: mnożniki ----------------- */
function showMultiplierMessage(text, isError = false) {
  const msg = document.getElementById('multiplier-message');
  msg.textContent = text;
  msg.classList.toggle('error-msg', isError);
  msg.hidden = false;
}

// Wspólna walidacja dla dodawania i edycji; zwraca null, jeśli dane są złe
function readMultiplierInputs(labelInput, valueInput) {
  const label = labelInput.value.trim();
  const value = Number(valueInput.value);
  if (!label || label.length > 40) {
    showMultiplierMessage('Nazwa musi mieć od 1 do 40 znaków.', true);
    return null;
  }
  if (!(value > 0 && value <= 10)) {
    showMultiplierMessage('Wartość musi być większa od 0 i najwyżej 10.', true);
    return null;
  }
  return { label, value };
}

function renderMultiplierAdmin() {
  const list = document.getElementById('multiplier-admin-list');
  if (!multipliers.length) {
    list.replaceChildren(el('div', { class: 'status-box', text: 'Brak mnożników. Dodaj pierwszy poniżej.' }));
    return;
  }

  list.replaceChildren(...multipliers.map(m => {
    const labelInput = el('input', { type: 'text', class: 'plain-input', maxlength: '40', 'aria-label': 'Nazwa mnożnika' });
    labelInput.value = m.label;
    const valueInput = el('input', { type: 'number', class: 'plain-input', min: '0.01', max: '10', step: '0.01', 'aria-label': 'Wartość mnożnika' });
    valueInput.value = formatMultiplier(m.value);

    const row = el('form', { class: 'multiplier-row' }, [
      labelInput,
      valueInput,
      el('button', { type: 'submit', class: 'btn btn-outline btn-icon', 'aria-label': 'Zapisz mnożnik', title: 'Zapisz' }, [icon('check')]),
      actionButton('trash-2', 'Usuń mnożnik', () => handleMultiplierDelete(m)),
    ]);
    row.addEventListener('submit', e => {
      e.preventDefault();
      handleMultiplierSave(m, labelInput, valueInput);
    });
    return row;
  }));
}

async function handleMultiplierSave(m, labelInput, valueInput) {
  const values = readMultiplierInputs(labelInput, valueInput);
  if (!values) return;

  const { data, error } = await supabaseClient.from('multipliers').update(values).eq('id', m.id).select('id');
  if (error || !data?.length) {
    showMultiplierMessage('Nie udało się zapisać: ' + (error ? friendlyError(error) : 'brak uprawnień admina.'), true);
    return;
  }
  showMultiplierMessage(`Zapisano: ${formatMultiplier(values.value)}x ${values.label}.`);
  await loadMultipliers();
}

async function handleMultiplierDelete(m) {
  if (!confirm(`Usunąć mnożnik „${m.label}” (${formatMultiplier(m.value)}x)? Stare wpisy zachowają swój wynik.`)) return;

  const { data, error } = await supabaseClient.from('multipliers').delete().eq('id', m.id).select('id');
  if (error || !data?.length) {
    showMultiplierMessage('Nie udało się usunąć: ' + (error ? friendlyError(error) : 'brak uprawnień admina.'), true);
    return;
  }
  showMultiplierMessage(`Usunięto mnożnik „${m.label}”.`);
  await loadMultipliers();
}

async function handleMultiplierAdd(e) {
  e.preventDefault();
  const labelInput = document.getElementById('new-multiplier-label');
  const valueInput = document.getElementById('new-multiplier-value');
  const values = readMultiplierInputs(labelInput, valueInput);
  if (!values) return;

  const { data, error } = await supabaseClient.from('multipliers').insert(values).select('id');
  if (error || !data?.length) {
    showMultiplierMessage('Nie udało się dodać: ' + (error ? friendlyError(error) : 'brak uprawnień admina.'), true);
    return;
  }
  e.target.reset();
  showMultiplierMessage(`Dodano: ${formatMultiplier(values.value)}x ${values.label}.`);
  await loadMultipliers();
}

/* ----------------- Prize (nagroda roku) ----------------- */
async function fetchPrize(year) {
  const { data, error } = await supabaseClient
    .from('prizes')
    .select('description')
    .eq('year', year)
    .maybeSingle();
  if (error) throw error;
  return data?.description || '';
}

async function fetchMoneyPrizeParticipants() {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, display_name')
    .eq('in_money_prize', true)
    .order('display_name');
  if (error) throw error;
  return data;
}

async function loadPrize() {
  try {
    const [description, participants] = await Promise.all([fetchPrize(currentYear()), fetchMoneyPrizeParticipants()]);
    document.getElementById('prize-text').textContent = description;
    // Baner tylko dla uczestników nagrody pieniężnej (w podglądzie: dla podglądanej osoby)
    const takesPart = participants.some(p => p.id === viewerId());
    document.getElementById('prize-banner').hidden = !description || !takesPart;

    const participantsLine = document.getElementById('prize-participants');
    participantsLine.textContent = participants.length
      ? `Nagroda pieniężna: ${participants.map(p => p.display_name).join(', ')}`
      : '';
    participantsLine.hidden = !participants.length;
  } catch (err) {
    // Baner zostaje taki, jaki był; nagroda nie jest krytyczna
    console.error('Error loading prize:', err);
  }
}

function showPrizeMessage(text, isError = false) {
  const msg = document.getElementById('prize-message');
  msg.textContent = text;
  msg.classList.toggle('error-msg', isError);
  msg.hidden = false;
}

async function loadPrizeIntoForm() {
  const year = parseInt(document.getElementById('prize-year').value, 10);
  if (!year) return;
  document.getElementById('prize-message').hidden = true;
  try {
    document.getElementById('prize-description').value = await fetchPrize(year);
  } catch (err) {
    showPrizeMessage('Nie udało się wczytać nagrody: ' + friendlyError(err), true);
  }
}

async function handlePrizeSubmit(e) {
  e.preventDefault();
  if (!isAdmin) return;

  const year = parseInt(document.getElementById('prize-year').value, 10);
  const description = document.getElementById('prize-description').value.trim();
  const btn = document.getElementById('prize-submit-btn');

  btn.disabled = true;
  try {
    // Puste pole = brak nagrody na ten rok
    const { data, error } = description
      ? await supabaseClient.from('prizes').upsert({ year, description }, { onConflict: 'year' }).select('year')
      : await supabaseClient.from('prizes').delete().eq('year', year).select('year');
    if (error) throw error;
    if (description && !data?.length) throw new Error('Brak uprawnień admina.');

    showPrizeMessage(description ? `Zapisano nagrodę na ${year}.` : `Usunięto nagrodę na ${year}.`);
    await loadPrize();
  } catch (err) {
    console.error('Error saving prize:', err);
    showPrizeMessage('Nie udało się zapisać: ' + friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
}

async function handleRename() {
  const current = document.getElementById('display-name').textContent;
  const input = prompt('Twoja nazwa w rankingu:', current);
  if (input === null) return;

  const displayName = input.trim();
  if (!displayName || displayName.length > 50) {
    alert('Nazwa musi mieć od 1 do 50 znaków.');
    return;
  }

  const { error } = await supabaseClient
    .from('profiles')
    .update({ display_name: displayName })
    .eq('id', currentUser.id);

  if (error) {
    alert('Nie udało się zmienić nazwy: ' + friendlyError(error));
    return;
  }
  setHeaderName(displayName);
  await loadReads();
}

/* ----------------- Data loading ----------------- */
// Wynik książki zaokrąglony do całości; sumy liczone z tych samych liczb, żeby wszystko się zgadzało
function bookPoints(book) {
  return Math.round(book.pages * book.multiplier);
}

function groupByReader(rows) {
  const readers = new Map();
  rows.forEach(r => {
    if (!readers.has(r.user_id)) {
      readers.set(r.user_id, {
        key: r.user_id,
        name: r.profiles?.display_name || '?',
        inMoneyPrize: !!r.profiles?.in_money_prize,
        points: 0,
        books: [],
      });
    }
    const reader = readers.get(r.user_id);
    reader.points += bookPoints(r);
    reader.books.push(r);
  });
  return [...readers.values()];
}

// Komunikat zamiast danych: ładowanie, błąd (z przyciskiem ponów) albo pusto
function renderStatus(text, withRetry = false) {
  const retry = () => {
    const btn = el('button', { type: 'button', class: 'btn btn-outline btn-sm', text: 'Spróbuj ponownie' });
    btn.addEventListener('click', loadReads);
    return btn;
  };

  const cell = el('td', { colspan: '2', class: 'status-cell' }, [el('span', { text })]);
  if (withRetry) cell.appendChild(retry());
  document.getElementById('leaderboard-body').replaceChildren(el('tr', {}, [cell]));

  const box = el('div', { class: 'status-box' }, [el('span', { text })]);
  if (withRetry) box.appendChild(retry());
  document.getElementById('user-progress-container').replaceChildren(box);
}

async function loadReads() {
  const year = currentYear();
  document.querySelectorAll('.current-year').forEach(span => { span.textContent = year; });

  if (!hasData) renderStatus('Ładowanie…');
  loadPrize();

  // Rywalizacja resetuje się co roku: tylko wpisy od 1 stycznia (czas lokalny)
  const [readsResult, nowResult] = await Promise.all([
    supabaseClient
      .from('reads')
      .select('id, user_id, title, pages, multiplier, unfinished, created_at, started_at, profiles(display_name, in_money_prize)')
      .gte('created_at', new Date(year, 0, 1).toISOString())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    supabaseClient
      .from('reading_now')
      .select('id, user_id, title, started_at, cover_url, author, published_year, info_url, description, info_checked_at, profiles(display_name)')
      .order('started_at', { ascending: true }),
  ]);
  const { data: rows, error } = readsResult;

  if (error) {
    console.error('Error loading reads:', error);
    // Przy odświeżeniu w tle zostawiamy to, co już widać
    if (!hasData) renderStatus('Nie udało się wczytać wpisów. ' + friendlyError(error), true);
    return;
  }
  if (nowResult.error) console.error('Error loading reading_now:', nowResult.error);
  readingNow = nowResult.data || [];
  // Formularz nie jest w trakcie edycji: odśwież listę zaczętych i domyślny wybór
  if (!editingId) {
    if (finishing && !myReadingNow().some(item => item.id === finishing.id)) selectFinishing(null);
    applyFinishDefault();
    updateFormUI();
  }

  hasData = true;
  const readers = groupByReader(rows || []);
  renderLeaderboard(readers);
  renderGoal(readers);
  renderReadingNow();
  renderUserProgress(readers);
  renderStats(readers, rows || []);
  refreshIcons();
}

/* ----------------- Teraz czytam ----------------- */
let readingNow = [];  // zaczęte książki wszystkich: [{ id, user_id, title, started_at, profiles }]

function readingNowLabel(item) {
  const days = daysSince(item.started_at);
  return `od ${formatDay(new Date(item.started_at))} · ${days} ${days === 1 ? 'dzień' : 'dni'}`;
}

function renderReadingNow() {
  const mine = readingNow.filter(item => item.user_id === viewerId());
  const card = document.getElementById('reading-now-card');
  card.hidden = !mine.length;
  // W podglądzie jako ktoś inny bez przycisków: to nie nasze książki
  const canAct = viewerId() === currentUser?.id;

  document.getElementById('reading-now-list').replaceChildren(...mine.map(item => {
    const actions = canAct
      ? [
          (() => {
            const done = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, [icon('check'), el('span', { text: 'Skończone' })]);
            done.addEventListener('click', () => startFinishing(item));
            return done;
          })(),
          actionButton('x', 'Usuń z „Teraz czytam”', () => handleDropReading(item)),
        ]
      : [];
    const info = readingCoverOf(item, () => { renderReadingNow(); refreshIcons(); });
    return el('div', { class: 'reading-now-item' }, [
      ...(info?.cover_url ? [coverEl({ title: item.title, cover_url: info.cover_url }, 'mini')] : []),
      el('div', { class: 'reading-now-info' }, [
        el('span', { class: 'reading-now-title', text: item.title }),
        el('span', { class: 'reading-now-meta', text: readingNowLabel(item) }),
      ]),
      el('div', { class: 'reading-now-actions' }, actions),
    ]);
  }));
}

async function handleDropReading(item) {
  if (!confirm(`Usunąć „${item.title}” z „Teraz czytam”? Książka nie trafi do rankingu.`)) return;
  const { data, error } = await supabaseClient.from('reading_now').delete().eq('id', item.id).select('id');
  if (error || !data?.length) {
    alert('Nie udało się usunąć: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
    return;
  }
  await loadReads();
}

/* ----------------- Plan na 1. miejsce ----------------- */
// Liczba po polsku: małe z jednym miejscem po przecinku, większe zaokrąglone
function formatRate(n) {
  return n < 10 ? n.toFixed(1).replace('.', ',') : String(Math.round(n));
}

// Tempo każdego = punkty od 1 stycznia / dni od 1 stycznia. Zakładamy, że rywale utrzymają tempo
// do końca roku, i liczymy, ile dziennie trzeba czytać, żeby skończyć rok przed najlepszym z nich.
// Para etykieta + wartość w jednym <div> (dozwolone w <dl>), żeby zajmowała jedną komórkę siatki
function goalFact(label, value) {
  return [el('div', { class: 'goal-fact' }, [el('dt', { text: label }), el('dd', { text: value })])];
}

function renderGoal(readers) {
  const card = document.getElementById('goal-card');
  if (!currentUser) {
    card.hidden = true;
    return;
  }

  const now = new Date();
  const year = now.getFullYear();
  const daysElapsed = Math.max(1, (now - new Date(year, 0, 1)) / DAY_MS);
  const daysLeft = Math.max(1, (new Date(year + 1, 0, 1) - now) / DAY_MS);

  const me = readers.find(r => r.key === viewerId());
  const myPoints = me ? me.points : 0;
  const myPace = myPoints / daysElapsed;
  const others = readers.filter(r => r.key !== viewerId());

  const number = document.getElementById('goal-number');
  const unit = document.getElementById('goal-unit');
  const sub = document.getElementById('goal-sub');
  const facts = document.getElementById('goal-facts');
  card.hidden = false;

  if (!others.length) {
    number.textContent = '';
    unit.textContent = 'Na razie nie masz rywali w tym roku.';
    sub.textContent = '';
    facts.replaceChildren(...goalFact('Twoje tempo', `${formatRate(myPace)} str./dzień`));
    return;
  }

  const pace = r => r.points / daysElapsed;
  const projected = r => r.points + pace(r) * daysLeft;
  const rival = others.reduce((best, r) => (projected(r) > projected(best) ? r : best));
  const rivalFinal = projected(rival);
  const leaderNow = others.reduce((best, r) => (r.points > best.points ? r : best));
  const neededPerDay = (rivalFinal - myPoints + 1) / daysLeft;

  if (neededPerDay <= 0) {
    number.textContent = '';
    unit.textContent = 'Wygrywasz, nawet jeśli już nic nie przeczytasz';
    sub.textContent = 'przy obecnym tempie rywali';
  } else {
    const perDay = Math.ceil(neededPerDay);
    number.textContent = String(perDay);
    unit.textContent = 'stron dziennie';
    sub.textContent = `czyli ok. ${perDay * 7} tygodniowo do końca roku`;
  }

  const gapNow = leaderNow.points - myPoints;
  facts.replaceChildren(
    ...(gapNow >= 0
      ? goalFact('Do 1. miejsca', `${gapNow + 1} pkt`)
      : goalFact('Prowadzisz o', `${-gapNow} pkt`)),
    ...goalFact('Twoje tempo', `${formatRate(myPace)} str./dzień`),
    ...goalFact(`Rywal: ${rival.name.split(' ')[0]}`, `${formatRate(pace(rival))} str./dzień`),
    ...goalFact('Prognoza rywala', `${Math.round(rivalFinal)} pkt`),
  );
}

/* ----------------- Statystyki i wyścig ----------------- */
const MONTHS_PL = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const SERIES_SLOTS = 8;
const RACE_DURATION_MS = 6000;
const RACE_LOOKAHEAD_DAYS = 45;     // skala „widzi” wpisy z najbliższych ~6 tygodni
const RACE_SCALE_SMOOTH_MS = 400;   // jak szybko skala dojeżdża do celu (stała czasowa)

let statsReaders = [];
let statsRows = [];
let race = null;          // narysowany wykres: skale, elementy, serie
let raceFrame = null;     // id requestAnimationFrame
let raceProgress = 1;     // 0..1, jak daleko w roku jest animacja
let racePending = false;  // wejście na Statystyki przed wczytaniem danych

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.appendChild(child);
  return node;
}

function formatDay(date) {
  return `${date.getDate()} ${MONTHS_PL[date.getMonth()]}`;
}

// Kolor idzie za osobą (stała kolejność alfabetyczna), nie za miejscem w rankingu,
// więc nie zmienia się, gdy ktoś kogoś wyprzedzi
function seriesColors(readers) {
  const sorted = [...readers].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  return new Map(sorted.map((r, i) => [r.key, i < SERIES_SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)']));
}

function niceMax(value) {
  if (value <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * power >= value) return m * power;
  }
  return 10 * power;
}

function compactNumber(n) {
  if (n < 1000) return String(n);
  return `${String(Math.round(n / 100) / 10).replace('.', ',')}K`;  // 11000 -> 11K, 12150 -> 12,2K
}

// Punkty narastająco. Książka z datą rozpoczęcia „przyrasta” równomiernie od startu do końca
// czytania (rampa), książka bez niej wskakuje w całości w dniu dodania (schodek).
function buildRaceSeries(readers, rows) {
  const colors = seriesColors(readers);
  const t0 = new Date(currentYear(), 0, 1).getTime();
  const byKey = new Map(readers.map(r => [r.key, { key: r.key, name: r.name, color: colors.get(r.key), books: [], total: 0 }]));
  rows.forEach(row => {
    const s = byKey.get(row.user_id);
    if (!s) return;
    const end = new Date(row.created_at).getTime();
    // Zaczęte w zeszłym roku: całe punkty rozkładamy w tym roku
    const start = row.started_at ? Math.min(end, Math.max(t0, new Date(row.started_at).getTime())) : end;
    const pts = bookPoints(row);
    s.total += pts;
    s.books.push({ start, end, pts });
  });

  // Punkty załamania linii: początki i końce książek. Między nimi wartość zmienia się liniowo,
  // a w miejscu schodka są dwa punkty o tym samym czasie (przed i po).
  byKey.forEach(s => {
    const times = [...new Set(s.books.flatMap(b => [b.start, b.end]))].sort((a, b) => a - b);
    s.points = [];
    times.forEach(t => {
      const before = valueAt(s, t, true);
      const after = valueAt(s, t);
      if (before !== after) s.points.push({ t, v: before });
      s.points.push({ t, v: after });
    });
  });
  return [...byKey.values()];
}

// Wartość w chwili t; strictly = granica z lewej (schodek dnia t jeszcze nie wliczony)
function valueAt(series, t, strictly = false) {
  let v = 0;
  for (const b of series.books) {
    if (b.end === b.start) {
      if (strictly ? b.end < t : b.end <= t) v += b.pts;
    } else if (t >= b.end) {
      v += b.pts;
    } else if (t > b.start) {
      v += (b.pts * (t - b.start)) / (b.end - b.start);
    }
  }
  return Math.round(v);
}

function renderStats(readers, rows) {
  statsReaders = readers;
  statsRows = rows;
  renderStatTiles(rows);
  renderBooksChart(readers);
  if (currentScreen() !== 'statystyki') return;
  drawTimeline();
  if (racePending) {
    racePending = false;
    playRace();
  } else if (raceFrame === null) {
    // W tle (np. po powrocie do apki) tylko przerysuj; animacja startuje przy wejściu na ekran
    drawRace();
    setRaceProgress(raceProgress);
  }
}

/* ----------------- Kto co czytał kiedy (oś czasu) ----------------- */
function drawTimeline() {
  const container = document.getElementById('timeline-chart');
  const width = container.clientWidth;
  if (!width) return;  // ekran niewidoczny

  const year = currentYear();
  const t0 = new Date(year, 0, 1).getTime();
  const t1 = Math.max(Date.now(), t0 + DAY_MS);
  const colors = seriesColors(statsReaders);
  const nameOf = new Map(statsReaders.map(r => [r.key, r.name]));
  readingNow.forEach(item => { if (!nameOf.has(item.user_id)) nameOf.set(item.user_id, item.profiles?.display_name || '?'); });

  // Odcinki: skończone książki z datą rozpoczęcia + czytane teraz (do dziś)
  const spans = [
    ...statsRows.filter(r => r.started_at).map(r => ({
      user: r.user_id, title: r.title || 'bez tytułu', open: false,
      start: Math.max(t0, new Date(r.started_at).getTime()), end: new Date(r.created_at).getTime(),
    })),
    ...readingNow.map(item => ({
      user: item.user_id, title: item.title, open: true,
      start: Math.max(t0, new Date(item.started_at).getTime()), end: t1,
    })),
  ].filter(s => s.end >= t0);

  if (!spans.length) {
    container.replaceChildren(el('div', { class: 'status-box', text: 'Pojawi się, gdy zaczniecie dodawać książki przez „Zaczynam czytać”.' }));
    return;
  }

  const people = [...new Set(spans.map(s => s.user))]
    .sort((a, b) => (nameOf.get(a) || '').localeCompare(nameOf.get(b) || '', 'pl'));
  const narrow = width < 480;
  const m = { top: 4, right: 8, bottom: 22, left: narrow ? 64 : 96 };
  const lane = 14;
  const x = t => m.left + ((t - t0) / (t1 - t0)) * (width - m.left - m.right);

  // Tory: książki czytane równolegle przez jedną osobę idą jedna pod drugą
  let yCursor = m.top;
  const rows = people.map(user => {
    const lanes = [];
    const items = spans.filter(s => s.user === user).sort((a, b) => a.start - b.start).map(s => {
      let i = lanes.findIndex(endT => endT < s.start);
      if (i === -1) { i = lanes.length; lanes.push(0); }
      lanes[i] = s.end;
      return { ...s, lane: i };
    });
    const row = { user, items, y: yCursor, h: Math.max(1, lanes.length) * lane + 8 };
    yCursor += row.h;
    return row;
  });
  const height = yCursor + m.bottom;

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'timeline-svg', role: 'img', 'aria-label': 'Kto co czytał kiedy' });

  const lastMonth = new Date(t1).getMonth();
  for (let month = 0; month <= lastMonth; month += narrow ? 2 : 1) {
    const mx = x(new Date(year, month, 1).getTime());
    svg.appendChild(svgEl('line', { x1: mx, x2: mx, y1: m.top, y2: height - m.bottom, class: 'grid-line' }));
    const label = svgEl('text', { x: mx, y: height - 8, class: 'axis-text' });
    label.textContent = MONTHS_PL[month];
    svg.appendChild(label);
  }

  rows.forEach((row, i) => {
    if (i > 0) svg.appendChild(svgEl('line', { x1: 0, x2: width, y1: row.y, y2: row.y, class: 'grid-line' }));
    const name = svgEl('text', { x: 0, y: row.y + 4 + lane / 2 + 4, class: 'timeline-name' });
    name.textContent = (nameOf.get(row.user) || '?').split(' ')[0];
    svg.appendChild(name);

    row.items.forEach(s => {
      const bx = x(s.start);
      const bw = Math.max(6, x(s.end) - bx);
      const bar = svgEl('rect', {
        x: bx, y: row.y + 4 + s.lane * lane + 3, width: bw, height: 8, rx: 4,
        class: s.open ? 'timeline-bar open' : 'timeline-bar',
        style: `fill: ${colors.get(s.user) || 'var(--series-other)'}`,
      });
      const days = Math.max(1, Math.round((s.end - s.start) / DAY_MS));
      const tip = svgEl('title');
      tip.textContent = s.open
        ? `${s.title}: od ${formatDay(new Date(s.start))}, czyta ${days} ${days === 1 ? 'dzień' : 'dni'}`
        : `${s.title}: ${formatDay(new Date(s.start))} – ${formatDay(new Date(s.end))} (${days} ${days === 1 ? 'dzień' : 'dni'})`;
      bar.appendChild(tip);
      svg.appendChild(bar);
    });
  });

  container.replaceChildren(svg);
}

function renderStatTiles(rows) {
  const pages = rows.reduce((sum, r) => sum + r.pages, 0);
  const longest = rows.reduce((best, r) => (!best || r.pages > best.pages ? r : best), null);
  document.getElementById('tile-pages').textContent = compactNumber(pages);
  document.getElementById('tile-books').textContent = String(rows.length);
  document.getElementById('tile-avg').textContent = rows.length ? String(Math.round(pages / rows.length)) : '0';
  document.getElementById('tile-longest').textContent = longest ? `${longest.title || 'bez tytułu'} · ${longest.pages} str.` : '—';
}

function renderBooksChart(readers) {
  const chart = document.getElementById('books-chart');
  if (!readers.length) {
    chart.replaceChildren(el('div', { class: 'status-box', text: 'Brak wpisów w tym roku.' }));
    return;
  }
  const colors = seriesColors(readers);
  const max = Math.max(...readers.map(r => r.books.length));
  const sorted = [...readers].sort((a, b) => b.books.length - a.books.length || a.name.localeCompare(b.name, 'pl'));

  chart.replaceChildren(...sorted.map(r => {
    const count = r.books.length;
    const bar = el('span', { class: 'bar', title: `${r.name}: ${count}` });
    bar.style.width = `${(count / max) * 100}%`;
    bar.style.background = colors.get(r.key);
    return el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label', text: r.name }),
      el('span', { class: 'bar-track' }, [bar, el('span', { class: 'bar-value', text: String(count) })]),
    ]);
  }));
}

function renderRaceLegend(series) {
  document.getElementById('race-legend').replaceChildren(...series.map(s => {
    const key = el('span', { class: 'legend-line' });
    key.style.background = s.color;
    return el('span', { class: 'legend-item' }, [key, el('span', { text: s.name })]);
  }));
}

function drawRace() {
  const container = document.getElementById('race-chart');
  const width = container.clientWidth;
  if (!width) return;  // ekran niewidoczny, nie ma czego mierzyć

  const series = buildRaceSeries(statsReaders, statsRows);
  renderRaceLegend(series);
  if (!series.length) {
    race = null;
    container.replaceChildren(el('div', { class: 'status-box', text: 'Brak wpisów w tym roku.' }));
    return;
  }

  const narrow = width < 480;
  const height = narrow ? 240 : 300;
  const m = { top: 12, right: narrow ? 92 : 120, bottom: 26, left: 40 };
  const year = currentYear();
  const t0 = new Date(year, 0, 1).getTime();
  const t1 = Math.max(Date.now(), t0 + DAY_MS);
  const plotRight = width - m.right;
  const x = t => m.left + ((t - t0) / (t1 - t0)) * (plotRight - m.left);

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'race-svg', role: 'img', 'aria-label': 'Punkty narastająco w ciągu roku dla każdej osoby' });

  // Siatka i oś Y przerysowywane w każdej klatce, bo skala rośnie razem z wynikami
  const grid = svgEl('g');
  svg.appendChild(grid);

  // Oś X: miesiące (na wąskim ekranie co drugi)
  const lastMonth = new Date(t1).getMonth();
  for (let month = 0; month <= lastMonth; month += narrow ? 2 : 1) {
    const label = svgEl('text', { x: x(new Date(year, month, 1).getTime()), y: height - 8, 'text-anchor': 'start', class: 'axis-text' });
    label.textContent = MONTHS_PL[month];
    svg.appendChild(label);
  }

  const lines = svgEl('g');
  series.forEach(s => {
    s.path = svgEl('path', { class: 'race-line', style: `stroke: ${s.color}` });
    lines.appendChild(s.path);
  });
  svg.appendChild(lines);

  const crosshair = svgEl('line', { y1: m.top, y2: height - m.bottom, class: 'crosshair', visibility: 'hidden' });
  svg.appendChild(crosshair);

  const leaders = svgEl('g');
  const dots = svgEl('g');
  const labels = svgEl('g');
  svg.append(leaders, dots, labels);

  series.forEach(s => {
    s.dot = svgEl('circle', { r: 4.5, class: 'race-dot', style: `fill: ${s.color}` });
    s.leader = svgEl('line', { class: 'leader-line' });
    s.label = svgEl('text', { class: 'race-label' });
    s.labelName = svgEl('tspan', { class: 'race-label-name' });
    s.labelValue = svgEl('tspan', { class: 'race-label-value', dx: 4 });
    s.label.append(s.labelName, s.labelValue);
    dots.appendChild(s.dot);
    leaders.appendChild(s.leader);
    labels.appendChild(s.label);
  });

  // Warstwa do najechania: krzyżyk szuka daty, dymek pokazuje wszystkich
  const overlay = svgEl('rect', { x: m.left, y: m.top, width: plotRight - m.left, height: height - m.top - m.bottom, class: 'race-overlay', tabindex: 0, 'aria-label': 'Przesuń, aby zobaczyć punkty w danym dniu' });
  svg.appendChild(overlay);

  const tooltip = el('div', { class: 'chart-tooltip', hidden: '' });
  container.replaceChildren(svg, tooltip);

  race = { series, x, t0, t1, m, width, height, plotRight, grid, crosshair, tooltip, focusT: t1, vMax: 100 };

  const onPointer = e => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    showRaceTooltip(t0 + ((px - m.left) / (plotRight - m.left)) * (t1 - t0));
  };
  overlay.addEventListener('pointermove', onPointer);
  overlay.addEventListener('pointerdown', onPointer);  // stuknięcie na telefonie
  overlay.addEventListener('pointerleave', hideRaceTooltip);
  overlay.addEventListener('focus', () => showRaceTooltip(race.focusT));
  overlay.addEventListener('blur', hideRaceTooltip);
  overlay.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    race.focusT += (e.key === 'ArrowRight' ? 7 : -7) * DAY_MS;
    showRaceTooltip(race.focusT);
  });
}

function drawRaceGrid(y, vMax) {
  const { grid, m, plotRight } = race;
  const step = niceMax(vMax / 4);  // „ładny” krok osi: 1, 2, 2.5, 5 × 10^n
  const items = [];
  for (let v = 0; v <= vMax; v += step) {
    items.push(svgEl('line', { x1: m.left, x2: plotRight, y1: y(v), y2: y(v), class: v === 0 ? 'axis-line' : 'grid-line' }));
    const label = svgEl('text', { x: m.left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    label.textContent = compactNumber(Math.round(v));
    items.push(label);
  }
  grid.replaceChildren(...items);
}

// dt = czas od poprzedniej klatki animacji; null = narysuj od razu (bez wygładzania skali)
function setRaceProgress(p, dt = null) {
  raceProgress = p;
  if (!race) return;
  const { series, x, t0, t1, m, plotRight, height } = race;
  const tCur = t0 + p * (t1 - t0);
  const xCur = x(tCur);
  document.getElementById('race-date').textContent = p < 1 ? formatDay(new Date(tCur)) : '';

  // Oś Y rośnie razem z liderem, ale płynnie: cel liczymy z wyprzedzeniem (wpis za kilka
  // tygodni już jest w skali), a pokazana skala dojeżdża do celu z wygładzaniem zamiast skakać
  const values = series.map(s => valueAt(s, tCur));
  const tAhead = Math.min(t1, tCur + RACE_LOOKAHEAD_DAYS * DAY_MS);
  // Minimum 20% wyniku końcowego: na początku roku nie robimy zbliżenia na prawie pusty wykres
  const floor = Math.max(100, Math.max(...series.map(s => s.total)) * 0.2);
  const target = Math.max(floor, Math.max(...series.map(s => valueAt(s, tAhead))) * 1.1);
  if (dt === null || !race.vMax) {
    race.vMax = target;
  } else {
    race.vMax += (target - race.vMax) * (1 - Math.exp(-dt / RACE_SCALE_SMOOTH_MS));
  }
  // Nigdy mniej niż bieżący lider, żeby linia nie wyszła ponad wykres
  race.vMax = Math.max(race.vMax, Math.max(...values) * 1.02);
  race.vMaxTarget = Math.max(target, race.vMax);
  const vMax = race.vMax;
  const y = v => height - m.bottom - (v / vMax) * (height - m.top - m.bottom);
  race.y = y;
  drawRaceGrid(y, vMax);

  // Linie do bieżącego dnia: proste odcinki między punktami załamania (rampy i schodki)
  series.forEach(s => {
    let d = `M${x(t0)},${y(0)}`;
    for (const pt of s.points) {
      if (pt.t > tCur) break;
      d += ` L${x(pt.t)},${y(pt.v)}`;
    }
    s.path.setAttribute('d', `${d} L${xCur},${y(valueAt(s, tCur))}`);
  });

  // Etykiety przy końcach linii; gdy się nakładają, rozsuwamy je i łączymy linią z kropką
  const items = series.map((s, i) => ({ s, v: values[i], dotY: y(values[i]), labelY: y(values[i]) }))
    .sort((a, b) => a.dotY - b.dotY);

  const gap = 16;
  for (let i = 1; i < items.length; i++) {
    items[i].labelY = Math.max(items[i].labelY, items[i - 1].labelY + gap);
  }
  const overflow = items.length ? items[items.length - 1].labelY - (height - m.bottom) : 0;
  if (overflow > 0) items.forEach(it => { it.labelY -= overflow; });
  for (let i = items.length - 2; i >= 0; i--) {
    items[i].labelY = Math.min(items[i].labelY, items[i + 1].labelY - gap);
  }

  const labelX = Math.min(xCur, plotRight) + 10;
  items.forEach(({ s, v, dotY, labelY }) => {
    s.dot.setAttribute('cx', xCur);
    s.dot.setAttribute('cy', dotY);
    s.label.setAttribute('x', labelX);
    s.label.setAttribute('y', labelY + 4);
    s.labelName.textContent = s.name.split(' ')[0];
    s.labelValue.textContent = String(v);
    const moved = Math.abs(labelY - dotY) > 3;
    s.leader.setAttribute('visibility', moved ? 'visible' : 'hidden');
    if (moved) {
      s.leader.setAttribute('x1', xCur + 5);
      s.leader.setAttribute('y1', dotY);
      s.leader.setAttribute('x2', labelX - 3);
      s.leader.setAttribute('y2', labelY);
    }
  });
}

function playRace() {
  cancelAnimationFrame(raceFrame);
  raceFrame = null;
  drawRace();
  hideRaceTooltip();
  if (!race) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setRaceProgress(1);
    return;
  }

  const start = performance.now();
  let last = start;
  const step = now => {
    const p = Math.min(1, (now - start) / RACE_DURATION_MS);
    setRaceProgress(p, now - last);
    last = now;
    // Po dojściu do dziś skala jeszcze chwilę dojeżdża do celu, zamiast przeskoczyć na koniec
    const settled = Math.abs(race.vMaxTarget - race.vMax) < race.vMaxTarget * 0.002;
    raceFrame = p < 1 || !settled ? requestAnimationFrame(step) : null;
  };
  setRaceProgress(0);
  raceFrame = requestAnimationFrame(step);
}

function showRaceTooltip(t) {
  if (!race || raceFrame !== null) return;  // w trakcie animacji bez dymka
  const { series, x, t0, t1, crosshair, tooltip, plotRight, m } = race;
  t = Math.min(t1, Math.max(t0, t));
  race.focusT = t;
  const px = x(t);
  crosshair.setAttribute('x1', px);
  crosshair.setAttribute('x2', px);
  crosshair.setAttribute('visibility', 'visible');

  const rows = series
    .map(s => ({ s, v: valueAt(s, t) }))
    .sort((a, b) => b.v - a.v)
    .map(({ s, v }) => {
      const key = el('span', { class: 'legend-line' });
      key.style.background = s.color;
      return el('div', { class: 'tooltip-row' }, [key, el('strong', { text: String(v) }), el('span', { text: s.name })]);
    });
  tooltip.replaceChildren(el('div', { class: 'tooltip-date', text: formatDay(new Date(t)) }), ...rows);
  tooltip.hidden = false;

  // Dymek po tej stronie krzyżyka, gdzie jest więcej miejsca
  const tipWidth = tooltip.offsetWidth;
  const left = px + 12 + tipWidth > race.width ? px - 12 - tipWidth : px + 12;
  tooltip.style.left = `${Math.max(m.left, Math.min(left, plotRight))}px`;
  tooltip.style.top = `${m.top}px`;
}

function hideRaceTooltip() {
  if (!race) return;
  race.crosshair.setAttribute('visibility', 'hidden');
  race.tooltip.hidden = true;
}

let raceResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(raceResizeTimer);
  raceResizeTimer = setTimeout(() => {
    if (currentScreen() !== 'statystyki') return;
    drawTimeline();
    if (raceFrame !== null) return;
    drawRace();
    setRaceProgress(raceProgress);
  }, 150);
});

function renderLeaderboard(readers) {
  const ranked = [...readers].sort((a, b) => b.points - a.points);
  const tbody = document.getElementById('leaderboard-body');

  if (!ranked.length) {
    tbody.replaceChildren(el('tr', {}, [
      el('td', { colspan: '2', class: 'status-cell', text: `Brak wpisów w ${currentYear()} roku. Dodaj pierwszy!` }),
    ]));
  } else {
    tbody.replaceChildren(...ranked.map((r, i) => {
      const earned = earnedBadges(r, i + 1);
      return el('tr', {}, [
        el('td', {}, [
          document.createTextNode(r.name),
          ...(r.inMoneyPrize
            ? [el('span', { class: 'money-badge', title: 'Bierze udział w nagrodzie pieniężnej', 'aria-label': 'Nagroda pieniężna' }, [icon('coins')])]
            : []),
          ...(earned.length
            ? [el('span', { class: 'badge-row', 'aria-label': `Odznaki: ${earned.map(b => b.name).join(', ')}` },
                earned.map(b => el('span', { class: 'badge-mini', title: `${b.name}: ${b.desc}` }, [icon(b.icon)])))]
            : []),
        ]),
        el('td', { class: 'text-right', text: String(r.points) }),
      ]);
    }));
  }
  renderBadgesCard(ranked);

  if (currentUser) {
    const rankIndex = ranked.findIndex(r => r.key === viewerId());
    const me = ranked[rankIndex];
    document.getElementById('stat-total-points').textContent = me ? String(me.points) : '0';
    document.getElementById('stat-rank').textContent = rankIndex !== -1 ? `#${rankIndex + 1}` : '#--';
  }
}

function actionButton(iconName, label, onClick) {
  const btn = el('button', { type: 'button', class: 'btn btn-outline btn-icon', 'aria-label': label, title: label }, [icon(iconName)]);
  btn.addEventListener('click', onClick);
  return btn;
}

function renderUserProgress(readers) {
  const container = document.getElementById('user-progress-container');
  if (!readers.length) {
    container.replaceChildren(el('div', { class: 'status-box', text: 'Nikt jeszcze nic nie dodał w tym roku.' }));
    return;
  }

  // Najpierw moje postępy, potem pozostałe osoby w dotychczasowej kolejności
  const mineFirst = [...readers].sort((a, b) =>
    (b.key === viewerId()) - (a.key === viewerId()));

  const blocks = mineFirst.map(reader => {
    const isMine = currentUser && reader.key === currentUser.id;

    const rows = reader.books.map(book => {
      const cells = [
        el('td', {}, [
          document.createTextNode(book.title || '—'),
          ...(book.unfinished ? [el('span', { class: 'unfinished-tag', text: 'niedokończona' })] : []),
        ]),
        // Na telefonie kolumna mnożnika jest schowana, a mnożnik pokazuje się przed stronami,
        // żeby liczby stron były wyrównane do prawej w jednej linii
        el('td', { class: 'text-right pages-cell' }, [
          ...(Number(book.multiplier) !== 1 ? [el('span', { class: 'mult-inline', text: `${formatMultiplier(book.multiplier)}x` })] : []),
          document.createTextNode(String(book.pages)),
        ]),
        el('td', { class: 'text-right col-mult', text: `${book.multiplier}x` }),
        el('td', { class: 'text-right score', text: String(bookPoints(book)) }),
      ];
      if (isMine) {
        cells.push(el('td', { class: 'actions-cell' }, [
          actionButton('pencil', 'Edytuj wpis', () => startEdit(book)),
          actionButton('trash-2', 'Usuń wpis', () => handleDelete(book)),
        ]));
      }
      return el('tr', {}, cells);
    });

    const headers = [
      el('th', { text: 'Tytuł' }),
      el('th', { class: 'text-right', text: 'Strony' }),
      el('th', { class: 'text-right col-mult', text: 'Mnożnik' }),
      el('th', { class: 'text-right', text: 'Wynik' }),
    ];
    if (isMine) headers.push(el('th', { class: 'actions-cell', 'aria-label': 'Akcje' }));

    const table = el('table', {}, [
      el('thead', {}, [el('tr', {}, headers)]),
      el('tbody', {}, rows),
    ]);

    const current = readingNow.filter(item => item.user_id === reader.key);
    return el('div', { class: 'user-progress-block' }, [
      el('h3', { class: 'user-name', text: reader.name }),
      ...current.map(item => el('p', { class: 'reading-now-line' }, [
        icon('book-open'),
        el('span', { text: `Czyta teraz: ${item.title}` }),
        el('span', { class: 'reading-now-meta', text: ` (${readingNowLabel(item)})` }),
      ])),
      el('div', { class: 'table-container' }, [table]),
    ]);
  });

  container.replaceChildren(...blocks);
}

/* ----------------- Podgląd jako inna osoba (admin) ----------------- */
// Tylko widok: wszystko „moje” na ekranach liczy się dla wybranej osoby. Zapisy (dodawanie,
// edycja, usuwanie) dalej idą jako zalogowany user i baza i tak nie pozwala ruszać cudzych wpisów.
let viewAs = null;  // { id, name } albo null

function viewerId() {
  return viewAs?.id || currentUser?.id || null;
}

function setViewAs(profile) {
  viewAs = profile && profile.id !== currentUser?.id ? profile : null;
  shelfUserId = null;
  const banner = document.getElementById('view-as-banner');
  banner.hidden = !viewAs;
  document.getElementById('view-as-name').textContent = viewAs ? viewAs.name : '';
  loadReads();
  if (viewAs) goTo('start');
}

async function loadViewAsOptions() {
  const select = document.getElementById('view-as-select');
  const { data, error } = await supabaseClient.from('profiles').select('id, display_name').order('display_name');
  if (error) {
    console.error('Error loading profiles:', error);
    return;
  }
  select.replaceChildren(...data.map(p => {
    const option = el('option', { value: p.id, text: p.id === currentUser.id ? `${p.display_name} (ja)` : p.display_name });
    option.selected = p.id === viewerId();
    return option;
  }));
}

function handleViewAs() {
  const select = document.getElementById('view-as-select');
  const option = select.selectedOptions[0];
  if (!option) return;
  setViewAs({ id: option.value, name: option.textContent.replace(/ \(ja\)$/, '') });
}

/* ----------------- Odznaki ----------------- */
// Liczone z wpisów bieżącego roku, więc resetują się razem z rywalizacją
const BADGES = [
  { id: 'first', icon: 'book-open', name: 'Pierwsza książka', desc: 'Pierwszy wpis w tym roku', test: s => s.books >= 1 },
  { id: 'five', icon: 'library', name: 'Piątka', desc: '5 książek', test: s => s.books >= 5 },
  { id: 'ten', icon: 'library-big', name: 'Dycha', desc: '10 książek', test: s => s.books >= 10 },
  { id: 'twenty', icon: 'landmark', name: 'Dwudziestka', desc: '20 książek', test: s => s.books >= 20 },
  { id: 'brick', icon: 'brick-wall', name: 'Cegła', desc: 'Książka mająca co najmniej 500 stron', test: s => s.longest >= 500 },
  { id: 'pages1k', icon: 'flame', name: 'Tysiąc stron', desc: '1000 przeczytanych stron', test: s => s.pages >= 1000 },
  { id: 'pages5k', icon: 'rocket', name: 'Pięć tysięcy stron', desc: '5000 przeczytanych stron', test: s => s.pages >= 5000 },
  { id: 'bonus', icon: 'sparkles', name: 'Z bonusem', desc: '3 książki z mnożnikiem powyżej 1x', test: s => s.bonus >= 3 },
  { id: 'streak', icon: 'calendar-check', name: 'Regularność', desc: 'Wpisy w 3 kolejnych miesiącach', test: s => s.monthStreak >= 3 },
  { id: 'leader', icon: 'crown', name: 'Korona', desc: 'Aktualnie 1. miejsce w rankingu', test: s => s.rank === 1 },
];

function badgeStats(reader, rank) {
  const months = new Set(reader.books.map(b => new Date(b.created_at).getMonth()));
  let monthStreak = 0;
  let run = 0;
  for (let m = 0; m < 12; m++) {
    run = months.has(m) ? run + 1 : 0;
    monthStreak = Math.max(monthStreak, run);
  }
  return {
    books: reader.books.length,
    pages: reader.books.reduce((sum, b) => sum + b.pages, 0),
    longest: reader.books.reduce((max, b) => Math.max(max, b.pages), 0),
    bonus: reader.books.filter(b => Number(b.multiplier) > 1).length,
    monthStreak,
    rank,
  };
}

function earnedBadges(reader, rank) {
  const stats = badgeStats(reader, rank);
  return BADGES.filter(b => b.test(stats));
}

function renderBadgesCard(ranked) {
  const grid = document.getElementById('badges-grid');
  const index = ranked.findIndex(r => r.key === viewerId());
  const me = ranked[index] || { books: [] };
  const earned = new Set(earnedBadges(me, index + 1).map(b => b.id));

  document.getElementById('badges-count').textContent = `${earned.size}/${BADGES.length}`;
  grid.replaceChildren(...BADGES.map(b => el('div', { class: `badge-item${earned.has(b.id) ? ' earned' : ''}` }, [
    el('span', { class: 'badge-icon' }, [icon(b.icon)]),
    el('span', { class: 'badge-text' }, [
      el('span', { class: 'badge-name', text: b.name }),
      el('span', { class: 'badge-desc', text: b.desc }),
    ]),
  ])));
}

/* ----------------- Powiadomienia push ----------------- */
const VAPID_PUBLIC_KEY = 'BC2BNMw365Oow8fd946d5rJ9UlfCIpq0LeMSC8PdS4RuMGWeFh_GoZE4sM54H3haR6VGu58zO_h7ziZ-t7xRXoE';

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function base64UrlToUint8Array(base64Url) {
  const base64 = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function savePushSubscription(sub) {
  const { endpoint, keys } = sub.toJSON();
  const { error } = await supabaseClient.rpc('save_push_subscription', { p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth });
  if (error) throw error;
}

// Pozycja „Powiadomienia” w menu ustawień: przełącznik albo podpowiedź, czemu się nie da
async function refreshNotifyCard() {
  const item = document.getElementById('notify-toggle');
  const hint = document.getElementById('notify-hint');
  const toggle = document.getElementById('notify-switch');

  const unavailable = reason => {
    item.dataset.state = 'unavailable';
    item.setAttribute('aria-disabled', 'true');
    item.setAttribute('aria-checked', 'false');
    toggle.hidden = true;
    hint.textContent = reason;
  };

  if (!pushSupported()) {
    unavailable(isIos() && !isStandalone()
      ? 'Na iPhonie: Udostępnij → Do ekranu początkowego, potem otwórz z ikony'
      : 'Ta przeglądarka nie obsługuje powiadomień');
    return;
  }
  if (Notification.permission === 'denied') {
    unavailable('Zablokowane w ustawieniach przeglądarki lub telefonu');
    return;
  }

  const sub = await currentPushSubscription();
  item.dataset.state = sub ? 'on' : 'off';
  item.removeAttribute('aria-disabled');
  item.setAttribute('aria-checked', String(!!sub));
  toggle.hidden = false;
  toggle.classList.toggle('on', !!sub);
  hint.textContent = 'Nowe książki i wyprzedzenia';
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    await refreshNotifyCard();
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(VAPID_PUBLIC_KEY) });
  await savePushSubscription(sub);
  showToast('Powiadomienia włączone.');
}

async function disablePush({ quiet = false } = {}) {
  try {
    const sub = await currentPushSubscription();
    if (!sub) return;
    await supabaseClient.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
    if (!quiet) showToast('Powiadomienia wyłączone.');
  } catch (err) {
    console.error('Error disabling push:', err);
  }
}

async function handleNotifyToggle() {
  const btn = document.getElementById('notify-toggle');
  if (btn.dataset.state === 'unavailable' || btn.disabled) return;
  btn.disabled = true;
  try {
    if (btn.dataset.state === 'on') await disablePush();
    else await enablePush();
  } catch (err) {
    console.error('Error toggling push:', err);
    showToast('Nie udało się zmienić powiadomień: ' + friendlyError(err));
  } finally {
    btn.disabled = false;
    await refreshNotifyCard();
  }
}

// Po zalogowaniu: jeśli to urządzenie ma już subskrypcję, przypisz ją do aktualnego konta
async function syncPushSubscription() {
  try {
    const sub = await currentPushSubscription();
    if (sub) await savePushSubscription(sub);
  } catch (err) {
    console.error('Error syncing push subscription:', err);
  }
  await refreshNotifyCard();
}

/* ----------------- Półka (okładki i informacje z publicznych baz) ----------------- */
let shelfUserId = null;   // czyja półka; null = moja (albo podglądanej osoby)
let shelfRows = [];
const lookupCache = new Map();  // zapytanie -> Promise<wyniki>, żeby nie pytać dwa razy w sesji
let lastLookupUsedGoogle = false;  // czy funkcja ma klucz Google Books (bez niego polskich książek prawie nie znajdzie)

function lookupBook(q, limit = 6) {
  const key = `${q.toLowerCase()}|${limit}`;
  if (!lookupCache.has(key)) {
    lookupCache.set(key, supabaseClient.functions.invoke('book-lookup', { body: { q, limit } })
      .then(({ data, error }) => {
        if (error) throw error;
        lastLookupUsedGoogle = !!data?.google;
        return data?.results || [];
      })
      .catch(err => {
        lookupCache.delete(key);
        console.error('Book lookup failed:', err);
        return [];
      }));
  }
  return lookupCache.get(key);
}

// Okładki książek „Teraz czytam”: szukane w locie i trzymane w pamięci sesji (tytuł -> info albo null)
const readingCovers = new Map();
const readingCoversPending = new Set();

function readingCoverOf(item, onFound) {
  if (item.info_checked_at) return item;  // okładka wybrana albo zapisana w bazie
  const key = normalizeTitle(item.title);
  if (readingCovers.has(key)) return readingCovers.get(key);
  if (!readingCoversPending.has(key)) {
    readingCoversPending.add(key);
    lookupBook(item.title, 3).then(results => {
      const best = results.find(r => r.cover && titleMatches(item.title, r.title));
      readingCovers.set(key, best ? { cover_url: best.cover, author: best.author } : null);
      readingCoversPending.delete(key);
      if (best) onFound();
    });
  }
  return null;
}

function openReadingModal(item) {
  const info = readingCoverOf(item, () => openReadingModal(item));
  const book = { title: item.title, cover_url: info?.cover_url, author: info?.author };
  const own = item.user_id === currentUser?.id && viewerId() === currentUser?.id;
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
    done.addEventListener('click', () => {
      closeBookModal();
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
  document.getElementById('book-modal').hidden = false;
  refreshIcons();
}

function normalizeTitle(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Czy wynik z bazy to ta sama książka: tytuł zawiera się w drugim albo większość słów się zgadza.
// Lepiej zastępcza okładka niż cudza.
function titleMatches(query, found) {
  const a = normalizeTitle(query);
  const b = normalizeTitle(found);
  if (!a || !b) return false;
  // Całymi słowami: „hail mary” pasuje do „project hail mary”, ale „kontakt” nie do „kontakte”
  if (` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `)) return true;
  const wa = new Set(a.split(' ').filter(w => w.length > 2));
  const wb = new Set(b.split(' ').filter(w => w.length > 2));
  if (!wa.size) return false;
  const common = [...wa].filter(w => wb.has(w)).length;
  return common / wa.size >= 0.6;
}

function titleHue(title) {
  let h = 0;
  for (const c of title || '') h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

// Okładka albo zastępcza „okładka” z tytułem (kolor z tytułu, więc zawsze ten sam)
function coverEl(book, extraClass = '') {
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

async function loadShelfPeople() {
  const { data, error } = await supabaseClient.from('profiles').select('id, display_name').order('display_name');
  if (error) return;
  const select = document.getElementById('shelf-person');
  const current = shelfUserId || viewerId();
  select.replaceChildren(...data.map(p => {
    const option = el('option', { value: p.id, text: p.id === viewerId() ? `${p.display_name} (ty)` : p.display_name });
    option.selected = p.id === current;
    return option;
  }));
}

async function loadShelf() {
  const userId = shelfUserId || viewerId();
  if (!userId) return;
  const shelf = document.getElementById('shelf');
  if (!shelfRows.length || shelfRows[0]?.user_id !== userId) {
    shelf.replaceChildren(el('div', { class: 'status-box', text: 'Ładowanie półki…' }));
  }
  loadShelfPeople();

  const { data, error } = await supabaseClient
    .from('reads')
    .select('id, user_id, title, pages, multiplier, unfinished, created_at, started_at, cover_url, author, published_year, info_url, description, info_checked_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) {
    shelf.replaceChildren(el('div', { class: 'status-box', text: 'Nie udało się wczytać półki. ' + friendlyError(error) }));
    return;
  }
  shelfRows = data || [];
  renderShelf();
  fillMissingBookInfo(userId);
}

function renderShelf() {
  const userId = shelfUserId || viewerId();
  const isOwn = userId === viewerId();
  const personName = document.querySelector(`#shelf-person option[value="${userId}"]`)?.textContent.replace(/ \(ty\)$/, '');
  document.getElementById('shelf-title').textContent = isOwn ? 'Twoja półka' : `Półka: ${personName || ''}`;

  const pages = shelfRows.reduce((sum, r) => sum + r.pages, 0);
  const n = shelfRows.length;
  document.getElementById('shelf-summary').textContent = n
    ? `${n} ${n === 1 ? 'książka' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'książki' : 'książek'} · ${pages} stron`
    : '';

  const sections = [];
  const current = readingNow.filter(item => item.user_id === userId);
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
  shelfRows.forEach(r => {
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
function bookTile(book, onOpen, reading = false) {
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
async function fillMissingBookInfo(userId) {
  const missing = shelfRows.filter(r => !r.info_checked_at);
  const own = userId === currentUser?.id;
  let rerender = false;
  const worker = async () => {
    while (missing.length) {
      if ((shelfUserId || viewerId()) !== userId) return;  // ktoś przełączył półkę
      const row = missing.shift();
      const results = await lookupBook(row.title || '', 3);
      const best = results.find(r => titleMatches(row.title, r.title) && r.cover)
        || results.find(r => titleMatches(row.title, r.title));
      // Bez Google Books „nie znaleziono” nie jest pewne: nie zapisujemy, spróbujemy przy następnym otwarciu
      if (!best && !lastLookupUsedGoogle) continue;
      const info = {
        cover_url: best?.cover || null,
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
function closeBookModal() {
  document.getElementById('book-modal').hidden = true;
}

function openBookModal(row) {
  const own = row.user_id === currentUser?.id && viewerId() === currentUser?.id;
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
  document.getElementById('book-modal').hidden = false;
  refreshIcons();
}

// save(row, info) zapisuje wybór: saveBookInfo dla przeczytanych, saveReadingInfo dla „Teraz czytam”
function renderCoverPicker(container, row, query, save) {
  const input = el('input', { type: 'search', class: 'plain-input', 'aria-label': 'Szukaj książki', placeholder: 'Tytuł, autor…' });
  input.value = query;
  const searchBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, [el('span', { text: 'Szukaj' })]);
  const form = el('form', { class: 'cover-search' }, [input, searchBtn]);
  const results = el('div', { class: 'cover-results' }, [el('div', { class: 'status-box', text: 'Szukam…' })]);
  container.replaceChildren(form, results);

  const run = async q => {
    results.replaceChildren(el('div', { class: 'status-box', text: 'Szukam…' }));
    const found = await lookupBook(q, 8);
    const options = found.map(r => {
      const btn = el('button', { type: 'button', class: 'cover-option' }, [
        coverEl({ title: r.title, author: r.author, cover_url: r.cover }),
        el('span', { class: 'book-tile-title', text: r.title }),
        el('span', { class: 'book-tile-author', text: [r.author, r.year].filter(Boolean).join(' · ') }),
      ]);
      btn.addEventListener('click', () => save(row, {
        cover_url: r.cover, author: r.author?.slice(0, 200) || null, published_year: r.year,
        info_url: r.infoUrl, description: r.description,
      }));
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

async function updateBookInfo(table, row, info) {
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

async function saveBookInfo(row, info) {
  if (!await updateBookInfo('reads', row, info)) return;
  renderShelf();
  openBookModal(row);
}

async function saveReadingInfo(item, info) {
  if (!await updateBookInfo('reading_now', item, info)) return;
  renderReadingNow();
  if (currentScreen() === 'polka') renderShelf();
  openReadingModal(item);
  refreshIcons();
}

/* ----------------- Init ----------------- */
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('google-login-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);  // menu zostaje otwarte, widać przełącznik
  document.getElementById('rename-btn').addEventListener('click', () => {
    closeSettings();
    handleRename();
  });
  document.getElementById('settings-admin').addEventListener('click', () => {
    closeSettings();
    goTo('admin');
  });
  document.getElementById('settings-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleSettings();
  });
  // Kliknięcie poza menu je zamyka
  document.addEventListener('click', e => {
    if (!e.target.closest('.settings-wrap')) closeSettings();
  });
  document.getElementById('cancel-edit-btn').addEventListener('click', () => {
    cancelEdit();
    goTo('postepy');
  });
  document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => setEntryMode(btn.dataset.mode)));
  document.getElementById('finish-pick').addEventListener('change', handleFinishPick);
  document.getElementById('shelf-person').addEventListener('change', e => {
    shelfUserId = e.target.value === viewerId() ? null : e.target.value;
    loadShelf();
  });
  document.getElementById('book-modal-close').addEventListener('click', closeBookModal);
  document.getElementById('book-modal').addEventListener('click', e => {
    if (e.target.id === 'book-modal') closeBookModal();  // kliknięcie w tło
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeBookModal();
    closeSettings();
  });
  document.getElementById('started-date').value = todayInputValue();
  document.getElementById('started-date').max = todayInputValue();
  window.addEventListener('hashchange', () => showScreen(currentScreen()));
  // Kliknięcie „Dodaj” w menu zawsze otwiera pusty formularz, także w trakcie edycji
  document.querySelector('.nav-item[data-screen="dodaj"]').addEventListener('click', () => {
    if (editingId || finishing) cancelEdit();
  });
  showScreen(currentScreen());
  document.getElementById('prize-form').addEventListener('submit', handlePrizeSubmit);
  document.getElementById('prize-year').addEventListener('change', loadPrizeIntoForm);
  document.getElementById('multiplier-add-form').addEventListener('submit', handleMultiplierAdd);
  document.getElementById('race-play').addEventListener('click', playRace);
  document.getElementById('notify-toggle').addEventListener('click', handleNotifyToggle);  // menu zostaje otwarte, widać przełącznik
  document.getElementById('view-as-btn').addEventListener('click', handleViewAs);
  document.getElementById('view-as-exit').addEventListener('click', () => setViewAs(null));

  document.querySelectorAll('.current-year').forEach(span => { span.textContent = currentYear(); });

  // Klasę motywu ustawia już skrypt w <head>, tu tylko ikona
  setTheme(document.documentElement.classList.contains('dark-mode'));

  if ('serviceWorker' in navigator) {
    // Nowa wersja SW przejęła stronę: przeładuj, żeby wczytać nowy kod.
    // Przy pierwszej instalacji (brak poprzedniego SW) nie ma czego przeładowywać.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .catch(err => console.warn('SW registration failed:', err));
    });
  }

  // PWA wznowione z tła nie przeładowuje strony: sprawdź nową wersję i odśwież wpisy
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    navigator.serviceWorker?.getRegistration().then(reg => reg?.update());
    if (currentUser) loadReads();
  });

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    const user = session?.user || null;
    // Odświeżenie tokenu co godzinę też tu trafia, dane przeładowujemy tylko przy zmianie usera
    const userChanged = (user?.id || null) !== (currentUser?.id || null);
    updateUI(user);
    // setTimeout: nie wołamy Supabase wewnątrz callbacka auth (zalecenie supabase-js, unika deadlocka)
    if (user && userChanged) {
      setTimeout(() => {
        loadMultipliers();
        loadProfile();
        loadReads();
        syncPushSubscription();
        if (currentScreen() === 'polka') loadShelf();
      }, 0);
    }
  });
});
