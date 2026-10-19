/* ----------------- Configuration ----------------- */
const SUPABASE_URL   = 'https://ipqjdqvfyfgggykaazug.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_lYoZG-uKAFWKMzyu4YV45Q_64jU7CBW';  // <-- publishable key

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
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error('Invalid JSON response');
      }
    });

function postJSON(url, data) {
  return fetchJSON(url, {
    method: 'POST',
    headers: FETCH_HEADERS,
    body: JSON.stringify(data),
  });
}

function getJSON(url) {
  return fetchJSON(url, { headers: FETCH_HEADERS });
}

/* ----------------- User handling ----------------- */
const usernameKey = 'readTrackerUsername';
function getUsername() { return localStorage.getItem(usernameKey); }
function setUsername(name) { localStorage.setItem(usernameKey, name); document.getElementById('login-modal').style.display = 'none'; }
function showLoginModal() { document.getElementById('login-modal').style.display = 'flex'; }

document.getElementById('save-username').addEventListener('click', () => {
  const name = document.getElementById('username').value.trim();
  if (name) setUsername(name);
});

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

// ... existing code ...

document.getElementById('read-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pages = parseInt(document.getElementById('pages').value, 10);
  const multiplier = parseFloat(document.getElementById('multiplier').value);
  const username = getUsername();

  if (!username) { showLoginModal(); return; }

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
  const rows = await getJSON(`${READS_ENDPOINT}&select=*,username,pages,multiplier&order=created_at.desc`);
  const totals = {};
  rows.forEach(r => {
    const pts = r.pages * r.multiplier;
    totals[r.username] = (totals[r.username] || 0) + pts;
  });

  const tbody = document.querySelector('#leaderboard tbody');
  tbody.innerHTML = '';
  Object.entries(totals)
    .sort((a,b)=> b[1]-a[1])          // descending
    .forEach(([name, pts]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${name}</td><td>${pts.toFixed(1)}</td>`;
      tbody.appendChild(tr);
    });
}

/* ----------------- Init ----------------- */
window.addEventListener('DOMContentLoaded', () => {
  if (!getUsername()) showLoginModal();
  loadLeaderboard();
});