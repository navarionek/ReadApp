import { confettiBurst, confettiFountain, confettiRain } from './confetti.js';
import { el, icon, refreshIcons } from './ui.js';

/* ----------------- Nowa odznaka na pełnym ekranie ----------------- */
// Jedna odznaka: duża ikona, nazwa i opis. Kilka naraz (np. pierwsze zapisanie obecnych odznak): lista.
let queue = [];
let open = false;

// Odznaki zapisane w bazie, ale jeszcze nie pokazane (np. strona przeładowała się zaraz po zapisie, bo wyszła
// nowa wersja apki): zostają w pamięci przeglądarki, aż ktoś zamknie okno
const PENDING_KEY = 'badge-award-pending';

export function pendingBadgeIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function setPending(ids) {
  try {
    if (ids.length) localStorage.setItem(PENDING_KEY, JSON.stringify(ids));
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* bez pamięci przeglądarki okno po prostu pokaże się raz */ }
}

// Nie przykrywamy podsumowania po dodaniu książki ani nie wchodzimy w ekran powitalny
function whenFree(fn, tries = 0) {
  const busy = document.querySelector('.summary-overlay, .badge-award-overlay, body.wall-intro, body.wall-intro-reveal')
    || document.documentElement.classList.contains('intro-pending');
  if (busy && tries < 240) setTimeout(() => whenFree(fn, tries + 1), 500);
  else fn();
}

export function showBadgeAward(badges) {
  if (!badges.length) return;
  if (queue.some(batch => batch[0].id === badges[0].id) || document.querySelector('.badge-award-overlay')) return;
  setPending([...new Set([...pendingBadgeIds(), ...badges.map(b => b.id)])]);
  queue.push(badges);
  if (!open) setTimeout(() => whenFree(next), 600);
}

function next() {
  const badges = queue.shift();
  if (!badges) return;
  open = true;

  const one = badges.length === 1;
  const closeBtn = el('button', { type: 'button', class: 'btn btn-primary', text: one ? 'Super!' : 'Świetnie!' });

  const body = one
    ? [
        el('div', { class: 'badge-award-icon' }, [icon(badges[0].icon)]),
        el('p', { class: 'badge-award-kicker', text: 'Nowa odznaka!' }),
        el('h2', { id: 'badge-award-title', class: 'badge-award-name', text: badges[0].name }),
        el('p', { class: 'badge-award-desc', text: badges[0].desc }),
      ]
    : [
        el('p', { class: 'badge-award-kicker', text: `Twoje odznaki: ${badges.length}` }),
        el('h2', { id: 'badge-award-title', class: 'badge-award-name', text: 'Zdobyte odznaki' }),
        el('ul', { class: 'badge-award-list' }, badges.map((b, i) => {
          const li = el('li', {}, [
            el('span', { class: 'badge-award-mini' }, [icon(b.icon)]),
            el('span', { class: 'badge-award-text' }, [
              el('span', { class: 'badge-award-item-name', text: b.name }),
              el('span', { class: 'badge-award-item-desc', text: b.desc }),
            ]),
          ]);
          li.style.setProperty('--i', String(Math.min(i, 12)));
          return li;
        })),
      ];

  const card = el('div', { class: `badge-award-card${one ? '' : ' multi'}` }, [...body, el('div', { class: 'summary-actions' }, [closeBtn])]);
  const overlay = el('div', { class: 'modal badge-award-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'badge-award-title' }, [card]);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    open = false;
    const shownIds = new Set(badges.map(b => b.id));
    setPending(pendingBadgeIds().filter(id => !shownIds.has(id)));
    if (queue.length) setTimeout(next, 250);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  refreshIcons();
  closeBtn.focus({ preventScroll: true });

  setTimeout(() => {
    if (!overlay.isConnected) return;
    const r = card.getBoundingClientRect();
    const x = r.left + r.width / 2;
    if (one) {
      confettiBurst(x, r.top + 60, { count: 120, speed: 900, spread: Math.PI });
      confettiFountain(x, r.top + 40, { duration: 1400, rate: 140, speed: 1000 });
    } else {
      confettiBurst(x, r.top + 40, { count: 110, speed: 850, spread: Math.PI });
      confettiRain(2200);
    }
  }, 450);
}
