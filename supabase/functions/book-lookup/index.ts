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

function yearOf(date: unknown): number | null {
  const y = parseInt(String(date ?? '').slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 && y <= 2100 ? y : null;
}

async function google(q: string, limit: number): Promise<Result[]> {
  const key = Deno.env.get('GOOGLE_BOOKS_API_KEY');
  if (!key) return [];
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:${q}`)}&maxResults=${limit}&printType=books&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error('google books', res.status);
    return [];
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

  const [g, o] = await Promise.all([google(q, limit), openLibrary(q, limit)]);
  // Najpierw wyniki z okładką; Google przed Open Library
  const results = [...g, ...o]
    .sort((a, b) => Number(!!b.cover) - Number(!!a.cover))
    .slice(0, limit);
  return json({ results, google: !!Deno.env.get('GOOGLE_BOOKS_API_KEY') });
});
