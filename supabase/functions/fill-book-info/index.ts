// fill-book-info: uzupełnia okładkę i dane książek (reads / reading_now), które jeszcze ich nie mają.
// Robi to serwer i zapisuje w bazie, więc raz znaleziona okładka jest od razu dla wszystkich
// (także przy oglądaniu cudzej półki) i leży w naszym buckecie. Wywoływana przez zalogowanych
// ({ table, ids }); z kluczem service_role także jako jednorazowe uzupełnienie ({ backfill: true }).
// Zapisuje tylko wpisy bez info_checked_at, a dane pochodzą wyłącznie z publicznych baz książek.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { copyCover } from '../_shared/covers.ts';
import { searchBooks } from '../_shared/lookup.ts';
import { titleEquals } from '../_shared/logic.js';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function jwtRole(header: string | null): string | null {
  try {
    const payload = (header ?? '').replace(/^Bearer /, '').split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role ?? null;
  } catch {
    return null;
  }
}

const TABLES = ['reads', 'reading_now', 'reading_queue'];
const FIELDS = 'id, cover_url, author, published_year, info_url, description, info_checked_at';
// Liczba stron (podpowiedź przy kończeniu książki) jest tylko w reading_now i reading_queue
const fieldsFor = (table: string) => (table === 'reads' ? FIELDS : `${FIELDS}, page_count`);

type Row = { id: number; title: string; author: string | null; info_checked_at: string | null };

// Zwraca aktualne dane wpisu; pending = nie udało się ustalić (Google nie odpowiedział), spróbujemy następnym razem
async function fillOne(table: string, row: Row) {
  const { results, google } = await searchBooks(row.title, 3);
  // Automatycznie tylko dokładny tytuł; inne wydania użytkownik wybierze ręcznie w wyborze okładki
  const best = results.find(r => titleEquals(row.title, r.title) && r.cover) ?? results.find(r => titleEquals(row.title, r.title));
  if (!best && !google) return { id: row.id, pending: true };

  const cover = best?.cover ? (await copyCover(supabase, best.cover)) ?? best.cover : null;
  const info = {
    cover_url: cover,
    author: row.author ?? best?.author?.slice(0, 200) ?? null,  // ręcznie wpisany autor ma pierwszeństwo
    published_year: best?.year ?? null,
    info_url: best?.infoUrl ?? null,
    description: best?.description?.slice(0, 3000) ?? null,
    info_checked_at: new Date().toISOString(),
  };
  if (table !== 'reads') {
    const pages = best?.pages;
    (info as Record<string, unknown>).page_count = Number.isInteger(pages) && pages! >= 1 && pages! <= 20000 ? pages : null;
  }
  // Zajęcie wpisu atomowo: jeśli ktoś był szybszy, oddajemy jego wynik
  const { data, error } = await supabase.from(table).update(info).eq('id', row.id).is('info_checked_at', null).select(fieldsFor(table));
  if (error) {
    console.error('update failed', table, row.id, error.message);
    return { id: row.id, pending: true };
  }
  if (data?.length) return data[0];
  const { data: current } = await supabase.from(table).select(fieldsFor(table)).eq('id', row.id).maybeSingle();
  return current ?? { id: row.id, pending: true };
}

async function fillRows(table: string, rows: Row[]) {
  const out: unknown[] = [];
  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) out.push(await fillOne(table, row));
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  let body: { table?: string; ids?: unknown; backfill?: boolean; limit?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  if (body.backfill) {
    if (jwtRole(req.headers.get('authorization')) !== 'service_role') return json({ error: 'forbidden' }, 403);
    const limit = Math.min(60, Math.max(1, Number(body.limit) || 30));
    const summary: Record<string, unknown> = {};
    for (const table of TABLES) {
      const { data } = await supabase.from(table).select('id, title, author, info_checked_at').is('info_checked_at', null).order('id').limit(limit);
      const done = await fillRows(table, (data ?? []) as Row[]);
      summary[table] = { tried: done.length, pending: done.filter((d: any) => d.pending).length };
    }
    return json(summary);
  }

  if (!TABLES.includes(String(body.table))) return json({ error: 'bad table' }, 400);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger).slice(0, 10) : [];
  if (!ids.length) return json({ items: [] });

  const table = String(body.table);
  const { data, error } = await supabase.from(table).select(`title, ${fieldsFor(table)}`).in('id', ids);
  if (error) return json({ error: error.message }, 500);
  const [unchecked, checked] = [(data ?? []).filter((r: any) => !r.info_checked_at), (data ?? []).filter((r: any) => r.info_checked_at)];
  const filled = await fillRows(table, unchecked as Row[]);
  return json({ items: [...checked.map((r: any) => ({ ...r, title: undefined })), ...filled] });
});
