// Wspólna logika aplikacji (przeglądarka) i funkcji brzegowych (Deno): jedno źródło prawdy
// dla punktów i dopasowania tytułów. Czysty JS bez zależności, żeby działał w obu miejscach.

// Wynik książki zaokrąglony do całości; sumy liczone z tych samych liczb, żeby wszystko się zgadzało
export function bookPoints(book) {
  return Math.round(book.pages * Number(book.multiplier));
}

export function normalizeTitle(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Dokładnie ten sam tytuł (bez wielkości liter, polskich znaków i interpunkcji); do automatycznych okładek
export function titleEquals(query, found) {
  const a = normalizeTitle(query);
  return !!a && a === normalizeTitle(found);
}

// Czy wynik z bazy to ta sama książka: tytuł zawiera się w drugim albo większość słów się zgadza.
// Lepiej zastępcza okładka niż cudza.
export function titleMatches(query, found) {
  const a = normalizeTitle(query);
  const b = normalizeTitle(found);
  if (!a || !b) return false;
  // Całymi słowami: „hail mary” pasuje do „project hail mary”, ale „kontakt” nie do „kontakte”
  if (` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `)) return true;
  const wa = new Set(a.split(' ').filter(w => w.length > 2));
  const wb = new Set(b.split(' ').filter(w => w.length > 2));
  if (!wa.size) return false;
  const common = [...wa].filter(w => wb.has(w)).length;
  return common / wa.size >= 0.6;
}
