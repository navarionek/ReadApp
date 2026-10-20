// cover-copy: kopiuje okładkę z zewnętrznego serwisu do naszego bucketa „covers”, żeby ładowała się
// szybko i bez zależności od Google/Open Library. Wywoływana z aplikacji przez zalogowanych
// ({ url } -> { url: nasz adres albo null }), a z kluczem service_role także jako jednorazowe
// uzupełnienie starych wpisów ({ backfill: true, limit }).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { copyCover, OWN_PREFIX } from '../_shared/covers.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Jednorazowe uzupełnienie: okładki już zapisane w bazie jako linki zewnętrzne
async function backfill(limit: number) {
  const result: Record<string, { copied: number; failed: number; remaining: number }> = {};
  for (const table of ['reads', 'reading_now']) {
    const { data, error } = await supabase
      .from(table)
      .select('id, cover_url')
      .not('cover_url', 'is', null)
      .not('cover_url', 'like', `${OWN_PREFIX}%`)
      .order('id')
      .limit(limit);
    if (error) return { error: error.message };
    let copied = 0;
    let failed = 0;
    const queue = [...(data ?? [])];
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const ours = await copyCover(supabase, row.cover_url);
        if (!ours) { failed++; continue; }
        const { error: updError } = await supabase.from(table).update({ cover_url: ours }).eq('id', row.id);
        if (updError) { console.error('update failed', updError.message); failed++; } else copied++;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    result[table] = { copied, failed, remaining: (data?.length ?? 0) - copied };
  }
  return result;
}

function jwtRole(header: string | null): string | null {
  try {
    const payload = (header ?? '').replace(/^Bearer /, '').split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  let body: { url?: string; backfill?: boolean; limit?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  if (body.backfill) {
    // Tylko z kluczem service_role (podpis JWT sprawdziła już brama, tu tylko rola)
    if (jwtRole(req.headers.get('authorization')) !== 'service_role') return json({ error: 'forbidden' }, 403);
    return json(await backfill(Math.min(100, Math.max(1, Number(body.limit) || 50))));
  }

  const url = String(body.url ?? '').slice(0, 2000);
  if (!url) return json({ error: 'bad request' }, 400);
  return json({ url: await copyCover(supabase, url) });
});
