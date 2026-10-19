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
  const readForm = document.getElementById('read-form');

  if (user) {
    currentUser = user;
    loginModal.style.display = 'none';
    userInfo.style.display = 'block';
    readForm.style.display = 'block';
    displayName.textContent = user.user_metadata.full_name || user.email;
  } else {
    currentUser = null;
    loginModal.style.display = 'flex';
    userInfo.style.display = 'none';
    readForm.style.display = 'none';
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
  const pages = parseInt(document.getElementById('pages').value, 10);
  const multiplier = parseFloat(document.getElementById('multiplier').value);

  if (!currentUser) {
    showError('Musisz być zalogowany!');
    return;
  }

  const username = currentUser.user_metadata.full_name || currentUser.email;

  try {
    await postJSON(READS_ENDPOINT, { username, pages, multiplier });
    await loadLeaderboard();      // refresh table
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
    Object.entries(totals)
      .sort((a,b)=> b[1]-a[1])          // descending
      .forEach(([name, pts]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${name}</td><td>${pts.toFixed(1)}</td>`;
        tbody.appendChild(tr);
      });
  } catch (err) {
    console.error('Error loading leaderboard:', err);
  }
}

/* ----------------- Init ----------------- */
window.addEventListener('DOMContentLoaded', async () => {
  // Setup event listeners
  document.getElementById('google-login-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  // Listen for auth changes
  supabaseClient.auth.onAuthStateChange((event, session) => {
    console.log('Auth state changed:', event, session);
    updateUI(session?.user || null);
    loadLeaderboard();
  });

  // Initial load
  loadLeaderboard();
});
