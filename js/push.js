import { supabaseClient } from './supabase.js';
import { friendlyError, showToast } from './ui.js';

/* ----------------- Powiadomienia push ----------------- */
export const VAPID_PUBLIC_KEY = 'BC2BNMw365Oow8fd946d5rJ9UlfCIpq0LeMSC8PdS4RuMGWeFh_GoZE4sM54H3haR6VGu58zO_h7ziZ-t7xRXoE';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function base64UrlToUint8Array(base64Url) {
  const base64 = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function savePushSubscription(sub) {
  const { endpoint, keys } = sub.toJSON();
  const { error } = await supabaseClient.rpc('save_push_subscription', { p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth });
  if (error) throw error;
}

// Pozycja „Powiadomienia” w menu ustawień: przełącznik albo podpowiedź, czemu się nie da
export async function refreshNotifyCard() {
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

export async function enablePush() {
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

export async function disablePush({ quiet = false } = {}) {
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

export async function handleNotifyToggle() {
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
export async function syncPushSubscription() {
  try {
    const sub = await currentPushSubscription();
    if (sub) await savePushSubscription(sub);
  } catch (err) {
    console.error('Error syncing push subscription:', err);
  }
  await refreshNotifyCard();
}
