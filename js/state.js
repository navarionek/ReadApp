// Wspólny stan aplikacji. Moduły zmieniają go przez `state.pole = …`, bo zaimportowanych
// zmiennych nie da się przypisywać z innych plików.
export const state = {
  currentUser: null,
  editingId: null,         // id wpisu edytowanego w formularzu, null = dodawanie
  hasData: false,          // czy coś już jest pokazane (wtedy błąd odświeżenia nie czyści tabel)
  isAdmin: false,

  // Formularz
  multipliers: [],         // [{ id, label, value }]
  editingMultiplier: null, // mnożnik edytowanego wpisu, zachowany, jeśli nie da się go odtworzyć z checkboxów
  editingLabels: null,     // nazwy mnożników edytowanego wpisu (null = nie wiadomo, stary wpis)
  editingCreatedAt: null,   // data skończenia edytowanego wpisu (ISO)
  editingStartedAt: null,   // data rozpoczęcia edytowanego wpisu (ISO) albo null
  multiplierTouched: false,
  entryMode: 'finished',   // 'finished' albo 'started' (dodaj do „Teraz czytam”)
  finishing: null,         // { id, title, startedAt } gdy kończymy książkę z „Teraz czytam”
  finishPickedNew: false,  // ktoś świadomie wybrał „Inna książka” zamiast zaczętej

  readingNow: [],          // zaczęte książki wszystkich: [{ id, user_id, title, started_at, profiles }]
  myQueue: [],             // moja lista „Do przeczytania”: [{ id, title, author }]
  startingFromQueue: null, // { id, title, author } gdy zaczynamy książkę z listy „Do przeczytania”
  viewAs: null,            // { id, name } albo null (podgląd jako inna osoba, admin)

  // Półka
  shelfUserId: null,       // czyja półka; null = moja (albo podglądanej osoby)
  shelfRows: [],
  shelfQueue: [],          // „Do przeczytania” osoby, której półkę oglądamy

  // Statystyki i wyścig
  statsReaders: [],
  statsRows: [],
  lastRanked: [],          // ostatni ranking: [{ key, name, points }] (do podsumowania po dodaniu książki)
  race: null,              // narysowany wykres: skale, elementy, serie
  raceFrame: null,         // id requestAnimationFrame
  raceProgress: 1,         // 0..1, jak daleko w roku jest animacja
  racePending: false,      // wejście na Statystyki przed wczytaniem danych
};
