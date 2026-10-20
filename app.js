/* ----------------- Configuration ----------------- */
const SUPABASE_URL = 'https://ipqjdqvfyfgggykaazug.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_lYoZG-uKAFWKMzyu4YV45Q_64jU7CBW';

// Klient sam dokłada token zalogowanego usera do każdego zapytania
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const AUTH_ONLY_SECTIONS = ['user-panel', 'stats-bar', 'form-section', 'leaderboard-section', 'user-progress-section'];

let currentUser = null;

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

function displayNameOf(user) {
  return user.user_metadata?.full_name || user.email;
}

function showError(msg) {
  const errDiv = document.getElementById('error-message');
  errDiv.textContent = msg;
  errDiv.hidden = false;
}

function hideError() {
  document.getElementById('error-message').hidden = true;
}

/* ----------------- Theme handling ----------------- */
function setTheme(isDark) {
  document.documentElement.classList.toggle('dark-mode', isDark);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  try {
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  } catch {}
  if (window.lucide) lucide.createIcons();
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
    alert('Błąd logowania: ' + error.message);
  }
}

async function handleLogout() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    alert('Błąd wylogowania: ' + error.message);
  }
}

function updateUI(user) {
  currentUser = user;
  document.getElementById('login-modal').hidden = !!user;
  AUTH_ONLY_SECTIONS.forEach(id => {
    document.getElementById(id).hidden = !user;
  });
  document.getElementById('display-name').textContent = user ? displayNameOf(user) : '';

  if (!user) {
    document.getElementById('leaderboard-body').replaceChildren();
    document.getElementById('user-progress-container').replaceChildren();
  }
}

/* ----------------- Submit handler ----------------- */
document.getElementById('read-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideError();

  if (!currentUser) {
    showError('Musisz być zalogowany!');
    return;
  }

  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const title = document.getElementById('title').value.trim();
  const pages = parseInt(document.getElementById('pages').value, 10);

  let multiplier = 1;
  document.querySelectorAll('.multiplier-checkbox:checked').forEach(cb => {
    multiplier *= parseFloat(cb.value);
  });

  if (!title) {
    showError('Podaj tytuł książki.');
    return;
  }

  submitBtn.disabled = true;
  try {
    // user_id, username i created_at i tak ustawia serwer (trigger reads_set_owner)
    const { error } = await supabaseClient.from('reads').insert({
      username: displayNameOf(currentUser),
      title,
      pages,
      multiplier,
    });
    if (error) throw error;

    form.reset();
    await loadReads();
  } catch (err) {
    console.error('Error posting read:', err);
    showError(err.message || 'Wystąpił błąd. Spróbuj ponownie.');
  } finally {
    submitBtn.disabled = false;
  }
});

/* ----------------- Data loading ----------------- */
// Wpisy sprzed migracji bez przypisanego konta grupujemy po nazwie
function readerKey(row) {
  return row.user_id || `name:${row.username}`;
}

function groupByReader(rows) {
  const readers = new Map();
  rows.forEach(r => {
    const key = readerKey(r);
    if (!readers.has(key)) {
      // Wiersze są od najnowszego, więc pierwsza nazwa jest aktualna
      readers.set(key, { key, name: r.username, points: 0, books: [] });
    }
    const reader = readers.get(key);
    reader.points += r.pages * r.multiplier;
    reader.books.push(r);
  });
  return [...readers.values()];
}

async function loadReads() {
  const { data: rows, error } = await supabaseClient
    .from('reads')
    .select('user_id, username, title, pages, multiplier')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error loading reads:', error);
    return;
  }

  const readers = groupByReader(rows || []);
  renderLeaderboard(readers);
  renderUserProgress(readers);
}

function renderLeaderboard(readers) {
  const ranked = [...readers].sort((a, b) => b.points - a.points);

  document.getElementById('leaderboard-body').replaceChildren(
    ...ranked.map(r => el('tr', {}, [
      el('td', { text: r.name }),
      el('td', { class: 'text-right', text: r.points.toFixed(1) }),
    ]))
  );

  if (currentUser) {
    const rankIndex = ranked.findIndex(r => r.key === currentUser.id);
    const me = ranked[rankIndex];
    document.getElementById('stat-total-points').textContent = me ? me.points.toFixed(0) : '0';
    document.getElementById('stat-rank').textContent = rankIndex !== -1 ? `#${rankIndex + 1}` : '#--';
  }
}

function renderUserProgress(readers) {
  const blocks = readers.map(reader => {
    const rows = reader.books.map(book => el('tr', {}, [
      el('td', { text: book.title || '—' }),
      el('td', { class: 'text-right', text: String(book.pages) }),
      el('td', { class: 'text-right', text: `${book.multiplier}x` }),
      el('td', { class: 'text-right score', text: (book.pages * book.multiplier).toFixed(1) }),
    ]));

    const table = el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Tytuł' }),
          el('th', { class: 'text-right', text: 'Strony' }),
          el('th', { class: 'text-right', text: 'Mnożnik' }),
          el('th', { class: 'text-right', text: 'Wynik' }),
        ]),
      ]),
      el('tbody', {}, rows),
    ]);

    return el('div', { class: 'user-progress-block' }, [
      el('h3', { class: 'user-name', text: reader.name }),
      el('div', { class: 'table-container' }, [table]),
    ]);
  });

  document.getElementById('user-progress-container').replaceChildren(...blocks);
}

/* ----------------- Init ----------------- */
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('google-login-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Klasę motywu ustawia już skrypt w <head>, tu tylko ikona
  setTheme(document.documentElement.classList.contains('dark-mode'));

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .catch(err => console.warn('SW registration failed:', err));
    });
  }

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    const user = session?.user || null;
    // Odświeżenie tokenu co godzinę też tu trafia, dane przeładowujemy tylko przy zmianie usera
    const userChanged = (user?.id || null) !== (currentUser?.id || null);
    updateUI(user);
    // setTimeout: nie wołamy Supabase wewnątrz callbacka auth (zalecenie supabase-js, unika deadlocka)
    if (user && userChanged) {
      setTimeout(loadReads, 0);
    }
  });
});
