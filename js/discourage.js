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

// Numer otwarcia aplikacji liczymy raz, przy starcie (a nie przy każdym odświeżeniu danych)
function countOpen() {
  try {
    const opens = Number(localStorage.getItem('opens') || 0) + 1;
    localStorage.setItem('opens', String(opens));
    return opens;
  } catch {
    return Math.floor(Math.random() * 60) + 1;  // bez localStorage: losowo, mniej więcej raz na 6 i raz na 10
  }
}

const openNumber = countOpen();
const showThisOpen = openNumber % 10 === 0;

// Co 6. otwarcie karta „Plan na 1. miejsce” mówi Krystianowi, że nic nie musi czytać
export const goalJokeThisOpen = openNumber % 6 === 0;

export function isKrystian(name) {
  return (name || '').trim().split(/\s+/)[0].toLowerCase() === 'krystian';
}

let shown = false;

export function maybeShowDiscouragement(displayName, force = false) {
  if (shown || !(showThisOpen || force)) return;
  if (!isKrystian(displayName)) return;
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
