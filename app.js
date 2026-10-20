/* ----------------- Configuration ----------------- */
const SUPABASE_URL = 'https://ipqjdqvfyfgggykaazug.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_lYoZG-uKAFWKMzyu4YV45Q_64jU7CBW';

// Klient sam dokłada token zalogowanego usera do każdego zapytania
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const AUTH_ONLY_SECTIONS = ['user-panel', 'app-nav', 'app-screens'];
const SCREENS = ['start', 'dodaj', 'ranking', 'postepy', 'admin'];

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
  try {
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  } catch {}
  refreshIcons();
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
    ['nav-admin', 'prize-banner', 'goal-card'].forEach(id => {
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

function setFormMode(isEditing) {
  document.getElementById('form-title').textContent = isEditing ? 'Edytuj wpis' : 'Dodaj postęp';
  document.getElementById('submit-label').textContent = isEditing ? 'Zapisz zmiany' : 'Dodaj wpis';
  document.getElementById('cancel-edit-btn').hidden = !isEditing;
}

function startEdit(book) {
  editingId = book.id;
  document.getElementById('title').value = book.title || '';
  document.getElementById('pages').value = book.pages;
  editingMultiplier = Number(book.multiplier);
  multiplierTouched = false;
  const note = document.getElementById('multiplier-note');
  const matched = applyMultiplier(editingMultiplier);
  note.textContent = matched
    ? ''
    : `Ten wpis ma mnożnik ×${formatMultiplier(editingMultiplier)}, którego nie da się złożyć z obecnych opcji. Zostanie zachowany, jeśli nie zmienisz zaznaczenia.`;
  note.hidden = matched;
  hideError();
  setFormMode(true);
  goTo('dodaj');
  document.getElementById('title').focus({ preventScroll: true });
}

function cancelEdit() {
  editingId = null;
  editingMultiplier = null;
  multiplierTouched = false;
  document.getElementById('multiplier-note').hidden = true;
  document.getElementById('read-form').reset();
  hideError();
  setFormMode(false);
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

  if (!title) {
    showError('Podaj tytuł książki.');
    return;
  }

  const labelBefore = submitLabel.textContent;
  submitBtn.disabled = true;
  submitLabel.textContent = 'Zapisywanie…';
  try {
    // user_id i created_at ustawia baza (defaulty), klient może podać tylko te trzy pola
    const values = { title, pages, multiplier };
    const { data, error } = editingId
      ? await supabaseClient.from('reads').update(values).eq('id', editingId).select('id')
      : await supabaseClient.from('reads').insert(values).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('Nie udało się zapisać wpisu (brak uprawnień).');

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
  document.getElementById('nav-admin').hidden = !isAdmin;
  // Wejście prosto na #admin: ekran pokazujemy dopiero, gdy wiadomo, że to admin
  if (currentScreen() === 'admin') showScreen('admin');
  if (isAdmin && !document.getElementById('prize-year').value) {
    document.getElementById('prize-year').value = currentYear();
    loadPrizeIntoForm();
  }
  if (isAdmin) {
    loadMoneyPrizeList();
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
    .select('display_name')
    .eq('in_money_prize', true)
    .order('display_name');
  if (error) throw error;
  return data.map(p => p.display_name);
}

async function loadPrize() {
  try {
    const [description, participants] = await Promise.all([fetchPrize(currentYear()), fetchMoneyPrizeParticipants()]);
    document.getElementById('prize-text').textContent = description;
    document.getElementById('prize-banner').hidden = !description;

    const participantsLine = document.getElementById('prize-participants');
    participantsLine.textContent = participants.length ? `Nagroda pieniężna: ${participants.join(', ')}` : '';
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
  const { data: rows, error } = await supabaseClient
    .from('reads')
    .select('id, user_id, title, pages, multiplier, profiles(display_name, in_money_prize)')
    .gte('created_at', new Date(year, 0, 1).toISOString())
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    console.error('Error loading reads:', error);
    // Przy odświeżeniu w tle zostawiamy to, co już widać
    if (!hasData) renderStatus('Nie udało się wczytać wpisów. ' + friendlyError(error), true);
    return;
  }

  hasData = true;
  const readers = groupByReader(rows || []);
  renderLeaderboard(readers);
  renderGoal(readers);
  renderUserProgress(readers);
  refreshIcons();
}

/* ----------------- Plan na 1. miejsce ----------------- */
// Liczba po polsku: małe z jednym miejscem po przecinku, większe zaokrąglone
function formatRate(n) {
  return n < 10 ? n.toFixed(1).replace('.', ',') : String(Math.round(n));
}

// Tempo każdego = punkty od 1 stycznia / dni od 1 stycznia. Zakładamy, że rywale utrzymają tempo
// do końca roku, i liczymy, ile dziennie trzeba czytać, żeby skończyć rok przed najlepszym z nich.
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

  const me = readers.find(r => r.key === currentUser.id);
  const myPoints = me ? me.points : 0;
  const myPace = myPoints / daysElapsed;
  const others = readers.filter(r => r.key !== currentUser.id);

  const headline = document.getElementById('goal-headline');
  const details = document.getElementById('goal-details');
  card.hidden = false;

  if (!others.length) {
    headline.textContent = 'Na razie nie masz rywali w tym roku.';
    details.textContent = `Twoje tempo: ${formatRate(myPace)} str./dzień.`;
    return;
  }

  const pace = r => r.points / daysElapsed;
  const projected = r => r.points + pace(r) * daysLeft;
  const rival = others.reduce((best, r) => (projected(r) > projected(best) ? r : best));
  const rivalFinal = projected(rival);
  const leaderNow = others.reduce((best, r) => (r.points > best.points ? r : best));

  const neededPerDay = (rivalFinal - myPoints + 1) / daysLeft;

  if (neededPerDay <= 0) {
    headline.textContent = 'Przy obecnym tempie rywali wygrywasz, nawet jeśli już nic nie przeczytasz.';
  } else {
    const perDay = Math.ceil(neededPerDay);
    headline.textContent = `Czytaj ok. ${perDay} str. dziennie (${perDay * 7} tygodniowo)`;
  }

  const gapNow = leaderNow.points - myPoints;
  const position = gapNow >= 0
    ? `Do 1. miejsca brakuje Ci teraz ${gapNow + 1} pkt (prowadzi ${leaderNow.name}).`
    : `Prowadzisz o ${-gapNow} pkt.`;
  const paceInfo = `Twoje tempo: ${formatRate(myPace)} str./dzień, ` +
    `${rival.name}: ${formatRate(pace(rival))} str./dzień ` +
    `(prognoza na koniec roku: ${Math.round(rivalFinal)} pkt).`;

  details.textContent = `${position} ${paceInfo} Strony liczone przy mnożniku 1x, książka po angielsku lub naukowa liczy się 1,5x.`;
}

function renderLeaderboard(readers) {
  const ranked = [...readers].sort((a, b) => b.points - a.points);
  const tbody = document.getElementById('leaderboard-body');

  if (!ranked.length) {
    tbody.replaceChildren(el('tr', {}, [
      el('td', { colspan: '2', class: 'status-cell', text: `Brak wpisów w ${currentYear()} roku. Dodaj pierwszy!` }),
    ]));
  } else {
    tbody.replaceChildren(...ranked.map(r => el('tr', {}, [
      el('td', {}, [
        document.createTextNode(r.name),
        ...(r.inMoneyPrize
          ? [el('span', { class: 'money-badge', title: 'Bierze udział w nagrodzie pieniężnej', 'aria-label': 'Nagroda pieniężna' }, [icon('coins')])]
          : []),
      ]),
      el('td', { class: 'text-right', text: String(r.points) }),
    ])));
  }

  if (currentUser) {
    const rankIndex = ranked.findIndex(r => r.key === currentUser.id);
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

  const blocks = readers.map(reader => {
    const isMine = currentUser && reader.key === currentUser.id;

    const rows = reader.books.map(book => {
      const cells = [
        el('td', { text: book.title || '—' }),
        // Na telefonie kolumna mnożnika jest schowana, a mnożnik pokazuje się przed stronami,
        // żeby liczby stron były wyrównane do prawej w jednej linii
        el('td', { class: 'text-right pages-cell' }, [
          ...(Number(book.multiplier) !== 1 ? [el('span', { class: 'mult-inline', text: `×${book.multiplier}` })] : []),
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

    return el('div', { class: 'user-progress-block' }, [
      el('h3', { class: 'user-name', text: reader.name }),
      el('div', { class: 'table-container' }, [table]),
    ]);
  });

  container.replaceChildren(...blocks);
}

/* ----------------- Init ----------------- */
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('google-login-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('rename-btn').addEventListener('click', handleRename);
  document.getElementById('cancel-edit-btn').addEventListener('click', () => {
    cancelEdit();
    goTo('postepy');
  });
  window.addEventListener('hashchange', () => showScreen(currentScreen()));
  showScreen(currentScreen());
  document.getElementById('prize-form').addEventListener('submit', handlePrizeSubmit);
  document.getElementById('prize-year').addEventListener('change', loadPrizeIntoForm);
  document.getElementById('multiplier-add-form').addEventListener('submit', handleMultiplierAdd);

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
      }, 0);
    }
  });
});
