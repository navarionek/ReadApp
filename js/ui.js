export const DAY_MS = 24 * 60 * 60 * 1000;
/* ----------------- Helpers ----------------- */
// Buduje element bez innerHTML, tekst zawsze idzie przez textContent
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

export function icon(name) {
  return el('i', { 'data-lucide': name });
}

export function refreshIcons() {
  if (window.lucide) lucide.createIcons();
}

export function displayNameOf(user) {
  return user.user_metadata?.full_name || user.email;
}

export function setHeaderName(name) {
  document.getElementById('display-name').textContent = name;
}

export function currentYear() {
  return new Date().getFullYear();
}

// Komunikaty po polsku zamiast surowych błędów z Supabase
export function friendlyError(err) {
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

export function showError(msg) {
  const errDiv = document.getElementById('error-message');
  errDiv.textContent = msg;
  errDiv.hidden = false;
}

export function hideError() {
  document.getElementById('error-message').hidden = true;
}

let toastTimer = null;
export function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2500);
}
