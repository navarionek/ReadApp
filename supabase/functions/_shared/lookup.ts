// Wyszukiwanie książki po tytule w publicznych bazach (wspólne dla book-lookup i fill-book-info).
// Google Books (lepiej zna polskie wydania; wymaga sekretu GOOGLE_BOOKS_API_KEY, bez niego
// wspólny limit Google jest zwykle wyczerpany) + Open Library jako uzupełnienie.
import { normalizeTitle, titleMatches } from './logic.js';

export type Result = {
  title: string;
  author: string | null;
  year: number | null;
  cover: string | null;
  description: string | null;
  infoUrl: string | null;
  pages: number | null;
  source: 'google' | 'openlibrary';
};

function yearOf(date: unknown): number | null {
  const y = parseInt(String(date ?? '').slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 && y <= 2100 ? y : null;
}

function googleInfoUrl(link: unknown, id: unknown): string | null {
  const url = link ? String(link).replace(/^http:/, 'https:') : '';
  if (/^https:\/\/books\.google\.[a-z.]+\//.test(url)) return url;
  return id ? `https://books.google.com/books?id=${encodeURIComponent(String(id))}` : null;
}

// q to gotowe zapytanie Google (np. intitle:"…" albo zwykły tekst).
// null = Google nie odpowiedział (brak klucza, 503…), [] = odpowiedział, że nic nie ma.
// Ostatni problem z Google (do diagnozy: brak klucza, kod HTTP); trafia do odpowiedzi jako googleStatus
let googleProblem: string | null = null;

async function google(q: string, limit: number): Promise<Result[] | null> {
  const key = Deno.env.get('GOOGLE_BOOKS_API_KEY');
  if (!key) {
    googleProblem = 'no key';
    return null;
  }
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${limit}&printType=books&key=${key}`;
  // Google Books czasem odpowiada chwilowym 503/500: ponawiamy z rosnącą przerwą. 429 to wyczerpany limit,
  // ponawianie niczego nie da, a zjada kolejne zapytania z limitu, więc przy 429 odpuszczamy od razu
  let res: Response | null = null;
  for (const wait of [0, 400, 1200]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    res = await fetch(url);
    if (res.ok || (res.status !== 503 && res.status !== 500)) break;
  }
  if (!res || !res.ok) {
    console.error('google books', res?.status);
    googleProblem = `http ${res?.status}`;
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
      // infoLink bywa linkiem do Google Play, którego baza nie przyjmuje: wtedy zwykła strona w Google Books
      infoUrl: googleInfoUrl(v.infoLink, item.id),
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

// google = true tylko gdy Google naprawdę odpowiedział, inaczej „nie znaleziono” nie jest pewne
export async function searchBooks(q: string, limit: number): Promise<{ results: Result[]; google: boolean; googleProblem: string | null }> {
  // Google ma niewielki dzienny limit zapytań, więc oszczędzamy: najpierw dokładny tytuł, a zwykłe wyszukiwanie
  // (łapie inne wydania) tylko gdy dokładne nic pasującego nie dało i Google nie jest wyczerpany (429).
  // Open Library idzie równolegle jako uzupełnienie.
  const openLibraryResults = openLibrary(q, limit);
  const gExact = await google(`intitle:"${q.replace(/"/g, '')}"`, limit);
  const exactMatched = !!gExact?.some(r => titleMatches(q, r.title));
  const quotaOut = gExact === null && googleProblem === 'http 429';
  const gPlain = exactMatched || quotaOut ? null : await google(q, limit);
  const o = await openLibraryResults;

  // Bez duplikatów (ten sam tytuł + okładka), najpierw pasujące tytułem, potem z okładką
  const seen = new Set<string>();
  const results = [...(gExact ?? []), ...(gPlain ?? []), ...o]
    .filter(r => {
      const key = `${normalizeTitle(r.title)}|${r.cover ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r, i) => ({
      r,
      i,
      // identyczny tytuł > pasujący tytuł > reszta; przy remisie wygrywa okładka
      score: (normalizeTitle(r.title) === normalizeTitle(q) ? 4 : 0) + (titleMatches(q, r.title) ? 2 : 0) + (r.cover ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.r)
    .slice(0, limit);
  const answered = gExact !== null || gPlain !== null;
  return { results, google: answered, googleProblem: answered ? null : googleProblem };
}
