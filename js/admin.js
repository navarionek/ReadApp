import { maybeShowDiscouragement } from './discourage.js';
import { actionButton, loadReads } from './data.js';
import { formatMultiplier, loadMultipliers } from './form.js';
import { currentScreen, goTo, showScreen } from './shell.js';
import { state } from './state.js';
import { supabaseClient } from './supabase.js';
import { currentYear, el, friendlyError, icon, refreshIcons, setHeaderName } from './ui.js';

/* ----------------- Profile ----------------- */
// Awatar z konta Google trafia do profilu (widać go w rankingu); odświeżamy go, gdy ktoś zmienił zdjęcie.
// Baza przyjmuje tylko adresy googleusercontent.com, a błąd tu nie jest krytyczny.
async function syncAvatar(saved) {
  const meta = state.currentUser.user_metadata || {};
  const fresh = meta.avatar_url || meta.picture || null;
  if (!fresh || fresh === saved) return;
  const { error } = await supabaseClient.from('profiles').update({ avatar_url: fresh }).eq('id', state.currentUser.id);
  if (error) console.error('Error syncing avatar:', error);
}

/* ----------------- Własny kolor ----------------- */
function showMyColor(color) {
  const swatch = document.getElementById('color-swatch');
  swatch.style.background = color || '';
  swatch.dataset.color = color || '';  // od tego koloru startuje wybierak
}

// color = null wraca do koloru automatycznego z palety
export async function saveMyColor(color) {
  const { error } = await supabaseClient.from('profiles').update({ color }).eq('id', state.currentUser.id);
  if (error) {
    alert('Nie udało się zapisać koloru: ' + friendlyError(error));
    return;
  }
  showMyColor(color);
  await loadReads();
}

export async function loadProfile() {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('display_name, is_admin, avatar_url, color')
    .eq('id', state.currentUser.id)
    .maybeSingle();

  if (error) {
    console.error('Error loading profile:', error);
    return;
  }
  if (!data) return;

  setHeaderName(data.display_name);
  maybeShowDiscouragement(data.display_name);
  syncAvatar(data.avatar_url);
  showMyColor(data.color);
  state.isAdmin = data.is_admin;
  document.getElementById('settings-admin').hidden = !state.isAdmin;
  // Wejście prosto na #admin: ekran pokazujemy dopiero, gdy wiadomo, że to admin
  if (currentScreen() === 'admin') showScreen('admin');
  if (state.isAdmin && !document.getElementById('prize-year').value) {
    document.getElementById('prize-year').value = currentYear();
    loadPrizeIntoForm();
  }
  if (state.isAdmin) {
    loadMoneyPrizeList();
    loadViewAsOptions();
    renderMultiplierAdmin();
    refreshIcons();
  }
}

/* ----------------- Nagroda pieniężna: uczestnicy ----------------- */
export function showMoneyPrizeMessage(text, isError = false) {
  const msg = document.getElementById('money-prize-message');
  msg.textContent = text;
  msg.classList.toggle('error-msg', isError);
  msg.hidden = false;
}

export async function loadMoneyPrizeList() {
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

export async function handleMoneyPrizeToggle(profile, checkbox) {
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
export function showMultiplierMessage(text, isError = false) {
  const msg = document.getElementById('multiplier-message');
  msg.textContent = text;
  msg.classList.toggle('error-msg', isError);
  msg.hidden = false;
}

// Wspólna walidacja dla dodawania i edycji; zwraca null, jeśli dane są złe
export function readMultiplierInputs(labelInput, valueInput) {
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

export function renderMultiplierAdmin() {
  const list = document.getElementById('multiplier-admin-list');
  if (!state.multipliers.length) {
    list.replaceChildren(el('div', { class: 'status-box', text: 'Brak mnożników. Dodaj pierwszy poniżej.' }));
    return;
  }

  list.replaceChildren(...state.multipliers.map(m => {
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

export async function handleMultiplierSave(m, labelInput, valueInput) {
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

export async function handleMultiplierDelete(m) {
  if (!confirm(`Usunąć mnożnik „${m.label}” (${formatMultiplier(m.value)}x)? Stare wpisy zachowają swój wynik.`)) return;

  const { data, error } = await supabaseClient.from('multipliers').delete().eq('id', m.id).select('id');
  if (error || !data?.length) {
    showMultiplierMessage('Nie udało się usunąć: ' + (error ? friendlyError(error) : 'brak uprawnień admina.'), true);
    return;
  }
  showMultiplierMessage(`Usunięto mnożnik „${m.label}”.`);
  await loadMultipliers();
}

export async function handleMultiplierAdd(e) {
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
export async function fetchPrize(year) {
  const { data, error } = await supabaseClient
    .from('prizes')
    .select('description')
    .eq('year', year)
    .maybeSingle();
  if (error) throw error;
  return data?.description || '';
}

export async function fetchMoneyPrizeParticipants() {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, display_name')
    .eq('in_money_prize', true)
    .order('display_name');
  if (error) throw error;
  return data;
}

export async function loadPrize() {
  try {
    const [description, participants] = await Promise.all([fetchPrize(currentYear()), fetchMoneyPrizeParticipants()]);
    document.getElementById('prize-text').textContent = description;
    // Baner tylko dla uczestników nagrody pieniężnej (w podglądzie: dla podglądanej osoby)
    const takesPart = participants.some(p => p.id === viewerId());
    document.getElementById('prize-banner').hidden = !description || !takesPart;
  } catch (err) {
    // Baner zostaje taki, jaki był; nagroda nie jest krytyczna
    console.error('Error loading prize:', err);
  }
}

export function showPrizeMessage(text, isError = false) {
  const msg = document.getElementById('prize-message');
  msg.textContent = text;
  msg.classList.toggle('error-msg', isError);
  msg.hidden = false;
}

export async function loadPrizeIntoForm() {
  const year = parseInt(document.getElementById('prize-year').value, 10);
  if (!year) return;
  document.getElementById('prize-message').hidden = true;
  try {
    document.getElementById('prize-description').value = await fetchPrize(year);
  } catch (err) {
    showPrizeMessage('Nie udało się wczytać nagrody: ' + friendlyError(err), true);
  }
}

export async function handlePrizeSubmit(e) {
  e.preventDefault();
  if (!state.isAdmin) return;

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

export async function handleRename() {
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
    .eq('id', state.currentUser.id);

  if (error) {
    alert('Nie udało się zmienić nazwy: ' + friendlyError(error));
    return;
  }
  setHeaderName(displayName);
  await loadReads();
}

/* ----------------- Podgląd jako inna osoba (admin) ----------------- */
// Tylko widok: wszystko „moje” na ekranach liczy się dla wybranej osoby. Zapisy (dodawanie,
// edycja, usuwanie) dalej idą jako zalogowany user i baza i tak nie pozwala ruszać cudzych wpisów.

export function viewerId() {
  return state.viewAs?.id || state.currentUser?.id || null;
}

export function setViewAs(profile) {
  state.viewAs = profile && profile.id !== state.currentUser?.id ? profile : null;
  state.shelfUserId = null;
  const banner = document.getElementById('view-as-banner');
  banner.hidden = !state.viewAs;
  document.getElementById('view-as-name').textContent = state.viewAs ? state.viewAs.name : '';
  loadReads();
  if (state.viewAs) goTo('start');
}

export async function loadViewAsOptions() {
  const select = document.getElementById('view-as-select');
  const { data, error } = await supabaseClient.from('profiles').select('id, display_name').order('display_name');
  if (error) {
    console.error('Error loading profiles:', error);
    return;
  }
  select.replaceChildren(...data.map(p => {
    const option = el('option', { value: p.id, text: p.id === state.currentUser.id ? `${p.display_name} (ja)` : p.display_name });
    option.selected = p.id === viewerId();
    return option;
  }));
}

export function handleViewAs() {
  const select = document.getElementById('view-as-select');
  const option = select.selectedOptions[0];
  if (!option) return;
  setViewAs({ id: option.value, name: option.textContent.replace(/ \(ja\)$/, '') });
}
