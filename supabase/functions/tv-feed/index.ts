// tv-feed: dane do widoku TV (?tv=token) bez logowania Google.
// Dostaje { token, since } i, jeśli token jest w tv_tokens, zwraca to samo, co zalogowany widzi
// na Start i w Statystykach: wpisy od `since` (najwyżej rok wstecz), „Teraz czytam” i nagrodę.
// Tylko odczyt; bez tokenu albo ze złym tokenem nic nie zwraca.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const READ_FIELDS = 'id, user_id, title, pages, multiplier, unfinished, rating, created_at, started_at, author, published_year, cover_url, multiplier_labels, profiles(display_name, in_money_prize, avatar_url, color)';
const NOW_FIELDS = 'id, user_id, title, started_at, cover_url, author, published_year, page_count, info_checked_at, profiles(display_name, avatar_url, color)';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  let body: { token?: unknown; since?: unknown; year?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  const token = typeof body.token === 'string' ? body.token.trim().toLowerCase() : '';
  if (!/^[a-z0-9]{10,64}$/.test(token)) return json({ error: 'forbidden' }, 403);

  const { data: owner, error: tokenError } = await supabase.from('tv_tokens').select('user_id').eq('token', token).maybeSingle();
  if (tokenError) return json({ error: 'server error' }, 500);
  if (!owner) return json({ error: 'forbidden' }, 403);

  // Początek roku liczy klient (czas lokalny); nie dalej niż ~13 miesięcy wstecz
  const floor = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const sinceMs = Date.parse(String(body.since));
  const since = new Date(Number.isFinite(sinceMs) ? Math.max(sinceMs, floor) : floor).toISOString();
  const yearNum = Number(body.year);
  const year = Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100 ? yearNum : new Date().getUTCFullYear();

  const [reads, readingNow, prize] = await Promise.all([
    supabase.from('reads').select(READ_FIELDS).gte('created_at', since)
      .order('created_at', { ascending: true }).order('id', { ascending: true }),
    supabase.from('reading_now').select(NOW_FIELDS).order('started_at', { ascending: true }),
    supabase.from('prizes').select('description').eq('year', year).maybeSingle(),
  ]);
  if (reads.error || readingNow.error) return json({ error: 'server error' }, 500);

  return json({
    reads: reads.data ?? [],
    readingNow: readingNow.data ?? [],
    prize: prize.data?.description ?? '',
  });
});
