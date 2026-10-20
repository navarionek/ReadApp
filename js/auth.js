import { cancelEdit } from './form.js';
import { disablePush } from './push.js';
import { invalidateReads } from './data.js';
import { closeBookModal, resetShelfCaches } from './shelf.js';
import { AUTH_ONLY_SECTIONS, closeSettings } from './shell.js';
import { state } from './state.js';
import { supabaseClient } from './supabase.js';
import { displayNameOf, friendlyError, setHeaderName } from './ui.js';

/* ----------------- Auth & User handling ----------------- */
export async function handleGoogleLogin() {
  const redirectUrl = window.location.origin + window.location.pathname;
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: redirectUrl },
  });
  if (error) {
    alert('Błąd logowania: ' + friendlyError(error));
  }
}

export async function handleLogout() {
  closeSettings();
  // Po wylogowaniu to urządzenie nie powinno dostawać powiadomień dla tego konta
  await disablePush({ quiet: true });
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    alert('Błąd wylogowania: ' + friendlyError(error));
  }
}

export function updateUI(user) {
  state.currentUser = user;
  document.getElementById('login-modal').hidden = !!user;
  AUTH_ONLY_SECTIONS.forEach(id => {
    document.getElementById(id).hidden = !user;
  });
  // Nazwa z Google tylko do czasu wczytania profilu (nie nadpisuj jej przy odświeżeniu tokenu)
  const header = document.getElementById('display-name');
  if (!user) setHeaderName('');
  else if (!header.textContent) setHeaderName(displayNameOf(user));

  if (!user) {
    state.hasData = false;
    state.isAdmin = false;
    state.viewAs = null;
    state.shelfUserId = null;
    state.shelfRows = [];
    state.shelfQueue = [];
    state.readingNow = [];
    state.multipliers = [];
    invalidateReads();
    resetShelfCaches();
    closeBookModal();
    ['settings-admin', 'prize-banner', 'goal-card', 'view-as-banner'].forEach(id => {
      document.getElementById(id).hidden = true;
    });
    cancelEdit();
    document.getElementById('ranking-viz').replaceChildren();
    document.getElementById('user-progress-container').replaceChildren();
  }
}
