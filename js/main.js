import { handleMultiplierAdd, handlePrizeSubmit, handleRename, handleViewAs, loadPrizeIntoForm, loadProfile, saveMyColor, setViewAs, viewerId } from './admin.js';
import { handleGoogleLogin, handleLogout, updateUI } from './auth.js';
import { loadReads } from './data.js';
import { cancelEdit, handleFinishPick, handleQueuePick, loadMultipliers, setEntryMode, todayInputValue } from './form.js';
import { handleNotifyToggle, syncPushSubscription } from './push.js';
import { closeBookModal, loadShelf } from './shelf.js';
import { closeSettings, currentScreen, goTo, setTheme, showScreen, toggleSettings, toggleTheme } from './shell.js';
import { state } from './state.js';
import { playRace } from './stats.js';
import { supabaseClient } from './supabase.js';
import { openTvLinkDialog, startTv } from './tv.js';
import { currentYear } from './ui.js';

/* ----------------- Init ----------------- */
window.addEventListener('DOMContentLoaded', () => {
  // Telewizor z prywatnym linkiem: sam widok TV, bez logowania i reszty apki
  const tvToken = new URLSearchParams(window.location.search).get('tv');
  if (tvToken) {
    startTv(tvToken);
    return;
  }

  document.getElementById('google-login-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);  // menu zostaje otwarte, widać przełącznik
  document.getElementById('rename-btn').addEventListener('click', () => {
    closeSettings();
    handleRename();
  });
  const colorInput = document.getElementById('color-input');
  document.getElementById('color-btn').addEventListener('click', e => {
    if (e.target !== colorInput) colorInput.showPicker();
  });
  colorInput.addEventListener('change', () => saveMyColor(colorInput.value));
  document.getElementById('color-reset').addEventListener('click', () => {
    closeSettings();
    saveMyColor(null);
  });
  document.getElementById('tv-link-btn').addEventListener('click', openTvLinkDialog);
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
  document.getElementById('queue-pick').addEventListener('change', handleQueuePick);
  document.getElementById('shelf-person').addEventListener('change', e => {
    state.shelfUserId = e.target.value === viewerId() ? null : e.target.value;
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
    if (state.editingId || state.finishing) cancelEdit();
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
    if (state.currentUser) loadReads();
  });

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    const user = session?.user || null;
    // Odświeżenie tokenu co godzinę też tu trafia, dane przeładowujemy tylko przy zmianie usera
    const userChanged = (user?.id || null) !== (state.currentUser?.id || null);
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
