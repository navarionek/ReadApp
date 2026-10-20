// book-lookup: wyszukiwanie książki po tytule w publicznych bazach.
// Google Books (lepiej zna polskie wydania; wymaga sekretu GOOGLE_BOOKS_API_KEY, bez niego
// wspólny limit Google jest zwykle wyczerpany) + Open Library jako uzupełnienie.
// Wywoływana z aplikacji przez zalogowanych (domyślna weryfikacja JWT).

type Result = {
  title: string;
  author: string | null;
  year: number | null;
  cover: string | null;
  description: string | null;
  infoUrl: string | null;
  pages: number | null;
  source: 'google' | 'openlibrary';
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// To samo dopasowanie tytułów co w aplikacji (całe słowa albo większość słów)
function normalize(s: string) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleMatches(query: string, found: string) {
  const a = normalize(query);
  const b = normalize(found);
  if (!a || !b) return false;
  if (` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `)) return true;
  const wa = new Set(a.split(' ').filter(w => w.length > 2));
  const wb = new Set(b.split(' ').filter(w => w.length > 2));
  if (!wa.size) return false;
  return [...wa].filter(w => wb.has(w)).length / wa.size >= 0.6;
}

function yearOf(date: unknown): number | null {
  const y = parseInt(String(date ?? '').slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 && y <= 2100 ? y : null;
}

// q to gotowe zapytanie Google (np. intitle:"…" albo zwykły tekst).
// null = Google nie odpowiedział (brak klucza, 503…), [] = odpowiedział, że nic nie ma.
async function google(q: string, limit: number): Promise<Result[] | null> {
  const key = Deno.env.get('GOOGLE_BOOKS_API_KEY');
  if (!key) return null;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${limit}&printType=books&key=${key}`;
  // Google Books często odpowiada chwilowym 503/429: ponawiamy z rosnącą przerwą
  let res: Response | null = null;
  for (const wait of [0, 400, 1200]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    res = await fetch(url);
    if (res.ok || (res.status !== 503 && res.status !== 429 && res.status !== 500)) break;
  }
  if (!res || !res.ok) {
    console.error('google books', res?.status);
    return null;
  }
  const data = await res.json();
  return (data.items ?? []).map((item: any) => {
    const v = item.volumeInfo ?? {};
    const thumb: string | undefined = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail;
    return {
      title: v.title ?? q,
      author: v.authors?.join(', ') ?? null,
      year: yearOf(v.publishedDate),
      // https + bez „zawijania” rogu strony, które Google dokleja do miniatur
      cover: thumb ? thumb.replace(/^http:/, 'https:').replace('&edge=curl', '') : null,
      description: v.description ? String(v.description).replace(/<[^>]+>/g, '').slice(0, 3000) : null,
      infoUrl: v.infoLink ? String(v.infoLink).replace(/^http:/, 'https:') : null,
      pages: v.pageCount ?? null,
      source: 'google' as const,
    };
  });
}

async function openLibrary(q: string, limit: number): Promise<Result[]> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${limit}&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Czytanko (https://czytanko.com)' } });
  if (!res.ok) {
    console.error('open library', res.status);
    return [];
  }
  const data = await res.json();
  return (data.docs ?? []).map((d: any) => ({
    title: d.title ?? q,
    author: d.author_name?.join(', ') ?? null,
    year: yearOf(d.first_publish_year),
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    description: null,
    infoUrl: d.key ? `https://openlibrary.org${d.key}` : null,
    pages: d.number_of_pages_median ?? null,
    source: 'openlibrary' as const,
  }));
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  let q = '';
  let limit = 6;
  try {
    const body = await req.json();
    q = String(body.q ?? '').trim().slice(0, 200);
    limit = Math.min(10, Math.max(1, Number(body.limit) || 6));
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (!q) return json({ results: [] });

  // Google: dokładny tytuł + zwykłe wyszukiwanie (każde łapie co innego), Open Library jako uzupełnienie
  const [gExact, gPlain, o] = await Promise.all([
    google(`intitle:"${q.replace(/"/g, '')}"`, limit),
    google(q, limit),
    openLibrary(q, limit),
  ]);

  // Bez duplikatów (ten sam tytuł + okładka), najpierw pasujące tytułem, potem z okładką
  const seen = new Set<string>();
  const results = [...(gExact ?? []), ...(gPlain ?? []), ...o]
    .filter(r => {
      const key = `${normalize(r.title)}|${r.cover ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r, i) => ({
      r,
      i,
      // identyczny tytuł > pasujący tytuł > reszta; przy remisie wygrywa okładka
      score: (normalize(r.title) === normalize(q) ? 4 : 0) + (titleMatches(q, r.title) ? 2 : 0) + (r.cover ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.r)
    .slice(0, limit);
  // „google: true” tylko gdy Google naprawdę odpowiedział, inaczej „nie znaleziono” nie jest pewne
  return json({ results, google: gExact !== null || gPlain !== null });
});
