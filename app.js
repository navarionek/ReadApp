/* ----------------- Configuration ----------------- */
const SUPABASE_URL   = 'https://ipqjdqvfyfgggykaazug.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_lYoZG-uKAFWKMzyu4YV45Q_64jU7CBW';

// Initialize Supabase client
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const READS_ENDPOINT = `${SUPABASE_URL}/rest/v1/reads?apikey=${SUPABASE_ANON_KEY}`;
const FETCH_HEADERS = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

/* ----------------- Helper functions ----------------- */
function fetchJSON(url, opts = {}) {
  return fetch(url, opts)
    .then(async res => {
      const raw = await res.text();
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const data = JSON.parse(raw);
          if (data && data.message) msg += `: ${data.message}`;
          else if (typeof data === 'object') msg += `: ${JSON.stringify(data)}`;
        } catch {}
        throw new Error(msg);
      }
      if (!raw || raw.trim() === "") return null;
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error('Invalid JSON response');
      }
    });
}

function postJSON(url, data) {
  return fetchJSON(url, {
    method: 'POST',
    headers: {
      ...FETCH_HEADERS,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data),
  });
}

function getJSON(url) {
  return fetchJSON(url, { headers: FETCH_HEADERS });
}

/* ----------------- Theme handling ----------------- */
function setTheme(isDark) {
  if (isDark) {
    document.body.classList.add('dark-mode');
    const icon = document.getElementById('theme-icon');
    if (icon) {
      icon.setAttribute('data-lucide', 'sun');
    }
  } else {
    document.body.classList.remove('dark-mode');
    const icon = document.getElementById('theme-icon');
    if (icon) {
      icon.setAttribute('data-lucide', 'moon');
    }
  }
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  // Re-run lucide to update the icon
  if (window.lucide) {
    lucide.createIcons();
  }
}

function toggleTheme() {
  const isDark = document.body.classList.contains('dark-mode');
  setTheme(!isDark);
}

/* ----------------- Auth & User handling ----------------- */
let currentUser = null;

async function handleGoogleLogin() {
  const redirectUrl = window.location.protocol + '//' + window.location.host + window.location.pathname;
  console.log('Próba logowania z przekierowaniem do:', redirectUrl);

  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectUrl,
    },
  });
  if (error) {
    showError('Błąd logowania: ' + error.message);
  }
}

async function handleLogout() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    showError('Błąd wylogowania: ' + error.message);
  }
}

function updateUI(user) {
  const loginModal = document.getElementById('login-modal');
  const userInfo = document.getElementById('user-info');
  const displayName = document.getElementById('display-name');
  const formSection = document.getElementById('form-section');
  const leaderboardSection = document.getElementById('leaderboard-section');
  const userProgressSection = document.getElementById('user-progress-section');

  if (user) {
    currentUser = user;
    loginModal.style.display = 'none';
    userInfo.style.display = 'block';
    if (formSection) formSection.style.display = 'block';
    if (leaderboardSection) leaderboardSection.style.display = 'block';
    if (userProgressSection) userProgressSection.style.display = 'block';
    const statsBar = document.getElementById('stats-bar');
    if (statsBar) statsBar.style.display = 'grid';
    displayName.textContent = user.user_metadata.full_name || user.email;
  } else {
    currentUser = null;
    loginModal.style.display = 'flex';
    userInfo.style.display = 'none';
    if (formSection) formSection.style.display = 'none';
    if (leaderboardSection) leaderboardSection.style.display = 'none';
    if (userProgressSection) userProgressSection.style.display = 'none';
    const statsBar = document.getElementById('stats-bar');
    if (statsBar) statsBar.style.display = 'none';
    displayName.textContent = '';
  }
}

/* ----------------- Submit handler ----------------- */
function showError(msg) {
  const errDiv = document.getElementById('error-message');
  if (errDiv) {
    errDiv.textContent = msg;
    errDiv.style.display = 'block';
  } else {
    alert(msg);
  }
}

document.getElementById('read-form').addEventListener('submit', async e => {
  e.preventDefault();
  const title = document.getElementById('title').value;
  const pages = parseInt(document.getElementById('pages').value, 10);

  let multiplier = 1;
  document.querySelectorAll('.multiplier-checkbox:checked').forEach(cb => {
    multiplier *= parseFloat(cb.value);
  });

  if (!currentUser) {
    showError('Musisz być zalogowany!');
    return;
  }

  const username = currentUser.user_metadata.full_name || currentUser.email;

  try {
    await postJSON(READS_ENDPOINT, { username, pages, multiplier, title });
    await loadLeaderboard();
    await loadUserProgress();
    e.target.reset();
    if (document.getElementById('error-message')) {
      document.getElementById('error-message').style.display = 'none';
    }
  } catch (err) {
    console.error('Error posting read:', err);
    const msg = err.message || 'Wystąpił błąd. Spróbuj ponownie.';
    showError(msg);
  }
});

/* ----------------- Leaderboard loader ----------------- */
async function loadLeaderboard() {
  try {
    const rows = await getJSON(`${READS_ENDPOINT}&select=*,username,pages,multiplier&order=created_at.desc`);
    const totals = {};
    if (rows) {
      rows.forEach(r => {
        const pts = r.pages * r.multiplier;
        totals[r.username] = (totals[r.username] || 0) + pts;
      });
    }

    const tbody = document.querySelector('#leaderboard tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const sortedEntries = Object.entries(totals).sort((a,b)=> b[1]-a[1]);

    sortedEntries.forEach(([name, pts]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="text-left">${name}</td><td class="text-right">${pts.toFixed(1)}</td>`;
      tbody.appendChild(tr);
    });

    if (currentUser) {
      const username = currentUser.user_metadata.full_name || currentUser.email;
      const userTotal = totals[username] || 0;
      const statTotalPages = document.getElementById('stat-total-pages');
      const statRank = document.getElementById('stat-rank');

      if (statTotalPages) statTotalPages.textContent = userTotal.toFixed(0);

      if (statRank) {
        const rankIndex = sortedEntries.findIndex(([name]) => name === username);
        statRank.textContent = rankIndex !== -1 ? `#${rankIndex + 1}` : '#--';
      }
    }
  } catch (err) {
    console.error('Error loading leaderboard:', err);
  }
}

/* ----------------- User Progress loader ----------------- */
async function loadUserProgress() {
  try {
    const rows = await getJSON(`${READS_ENDPOINT}&select=username,title,pages,multiplier&order=created_at.desc`);
    const container = document.getElementById('user-progress-container');
    if (!container) return;
    container.innerHTML = '';

    if (rows) {
      const grouped = {};
      rows.forEach(r => {
        if (!grouped[r.username]) grouped[r.username] = [];
        grouped[r.username].push(r);
      });

      for (const [username, books] of Object.entries(grouped)) {
        const userBlock = document.createElement('div');
        userBlock.className = 'user-progress-block';
        userBlock.style.marginBottom = '2rem';
        userBlock.innerHTML = `<h3 class="user-name" style="margin-bottom:0.75rem; color:var(--primary);">${username}</h3>`;

        const tableContainer = document.createElement('div');
        tableContainer.className = 'table-container';

        const table = document.createElement('table');
        table.innerHTML = `
          <thead>
            <tr>
              <th>Tytuł</th>
              <th class="text-right">Strony</th>
              <th class="text-right">Mnożnik</th>
              <th class="text-right">Wynik</th>
            </tr>
          </thead>
          <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');

        books.forEach(book => {
          const tr = document.createElement('tr');
          const score = (book.pages * book.multiplier).toFixed(1);
          tr.innerHTML = `
            <td>${book.title}</td>
            <td class="text-right">${book.pages}</td>
            <td class="text-right">${book.multiplier}x</td>
            <td class="text-right" style="font-weight:600;">${score}</td>
          `;
          tbody.appendChild(tr);
        });

        tableContainer.appendChild(table);
        userBlock.appendChild(tableContainer);
        container.appendChild(userBlock);
      }
    }
  } catch (err) {
    console.error('Error loading user progress:', err);
  }
}

/* ----------------- Init ----------------- */
window.addEventListener('DOMContentLoaded', async () => {
  // Setup event listeners
  document.getElementById('google-login-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Initialize Theme
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    setTheme(savedTheme === 'dark');
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark);
  }

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('SW registered!', reg))
        .catch(err => console.log('SW registration failed: ', err));
    });
  }

  // Listen for auth changes
  supabaseClient.auth.onAuthStateChange((event, session) => {
    console.log('Auth state changed:', event, session);
    const user = session?.user || null;
    updateUI(user);
    if (user) {
      loadLeaderboard();
      loadUserProgress();
    } else {
      // Clear tables if logging out
      const leaderboardBody = document.querySelector('#leaderboard tbody');
      if (leaderboardBody) leaderboardBody.innerHTML = '';
      const progressContainer = document.getElementById('user-progress-container');
      if (progressContainer) progressContainer.innerHTML = '';
    }
  });

  // Initial load (onAuthStateChange will handle this if session exists)
});
