import { el, icon, refreshIcons } from './ui.js';

/* ----------------- Żart: karta zniechęcająca do czytania dla Krystiana ----------------- */
// Co 10. otwarcie aplikacji (licznik w localStorage tego urządzenia; bez localStorage losowo 1 do 10)
// Krystian dostaje na ekranie głównym kartę, która szczerze odradza czytanie.
const MESSAGES = [
  'Po co czytać całą książkę? Streszczenie na Wikipedii ma cztery zdania.',
  'Statystycznie 9 na 10 przeczytanych książek i tak nie zmienia życia. Odpocznij.',
  'Serial ma osiem odcinków, a książka pięćset stron. Policz sam, co się bardziej opłaca.',
  'Angielski i do tego naukowo? Masz pewność, że chcesz się tak męczyć?',
  'Twoja kanapa za Tobą tęskni. Książka czeka od 1450 roku i nie uciekła.',
  'Czytanie zużywa oczy. Oczy są jedne. Pomyśl o oczach.',
  'Znajomi czytają szybciej. Po co się z nimi ścigać? Przegrana też jest formą spokoju.',
  'Ostatnio poznałeś coś nowego. Mózg się przegrzewa, daj mu odetchnąć.',
];

function isDiscouragementOpen() {
  try {
    const opens = Number(localStorage.getItem('opens') || 0) + 1;
    localStorage.setItem('opens', String(opens));
    return opens % 10 === 0;
  } catch {
    return Math.random() < 0.1;
  }
}

// Liczymy otwarcie raz, przy starcie aplikacji (a nie przy każdym odświeżeniu danych)
const showThisOpen = isDiscouragementOpen();
let shown = false;

export function maybeShowDiscouragement(displayName, force = false) {
  if (shown || !(showThisOpen || force)) return;
  const firstName = (displayName || '').trim().split(/\s+/)[0].toLowerCase();
  if (firstName !== 'krystian') return;
  shown = true;

  const message = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
  const dismiss = el('button', { type: 'button', class: 'btn btn-outline btn-sm', text: 'Masz rację, nie czytam' });
  const card = el('div', { class: 'discourage-card', role: 'note' }, [
    el('div', { class: 'discourage-icon' }, [icon('armchair')]),
    el('div', { class: 'discourage-body' }, [
      el('strong', { class: 'discourage-title', text: 'Szczera rada na dziś' }),
      el('p', { class: 'discourage-text', text: message }),
      dismiss,
    ]),
  ]);
  dismiss.addEventListener('click', () => card.remove());

  document.querySelector('.screen[data-screen="start"]').prepend(card);
  refreshIcons();
}
