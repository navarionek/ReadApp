// book-lookup: wyszukiwanie książki po tytule (logika w _shared/lookup.ts).
// Wywoływana z aplikacji przez zalogowanych (domyślna weryfikacja JWT).
import { searchBooks } from '../_shared/lookup.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
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

  return json(await searchBooks(q, limit));
});
