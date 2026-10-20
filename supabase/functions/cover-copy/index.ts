// cover-copy: kopiuje okładkę z zewnętrznego serwisu do naszego bucketa „covers”, żeby ładowała się
// szybko i bez zależności od Google/Open Library. Wywoływana z aplikacji przez zalogowanych
// ({ url } -> { url: nasz adres albo null }), a z kluczem service_role także jako jednorazowe
// uzupełnienie starych wpisów ({ backfill: true, limit }).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const OWN_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/covers/`;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Pobieramy tylko z tych serwisów (pierwszy adres); Open Library przekierowuje na archive.org
const START_HOSTS = ['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org'];
const isFinalHostOk = (host: string) => START_HOSTS.includes(host) || host === 'archive.org' || host.endsWith('.archive.org');

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Zwraca adres u nas albo null, gdy się nie da (zły serwis, nie obrazek, za duży, błąd sieci)
async function copyCover(url: string): Promise<string | null> {
  if (url.startsWith(OWN_PREFIX)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !START_HOSTS.includes(parsed.hostname)) return null;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Czytanko (https://czytanko.com)' }, redirect: 'follow' });
    if (!res.ok || !isFinalHostOk(new URL(res.url).hostname)) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : null;
    if (!ext) return null;  // m.in. szary „brak okładki” od Google (gif)
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 1_000_000) return null;

    // Ten sam adres źródłowy = ten sam plik, więc książki z tą samą okładką dzielą kopię
    const path = `ext/${await sha256Hex(url)}.${ext}`;
    const { error } = await supabase.storage.from('covers').upload(path, bytes, {
      contentType: type, upsert: true, cacheControl: '31536000',
    });
    if (error) {
      console.error('upload failed', error.message);
      return null;
    }
    return supabase.storage.from('covers').getPublicUrl(path).data.publicUrl;
  } catch (err) {
    console.error('copy failed', (err as Error).message);
    return null;
  }
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
        const ours = await copyCover(row.cover_url);
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
  return json({ url: await copyCover(url) });
});
