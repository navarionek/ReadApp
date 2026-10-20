// Kopiowanie okładek z zewnętrznych serwisów do naszego bucketa „covers” (wspólne dla
// cover-copy i fill-book-info).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.2';

export const OWN_PREFIX = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/covers/`;

// Pobieramy tylko z tych serwisów (pierwszy adres); Open Library przekierowuje na archive.org
const START_HOSTS = ['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org'];
const isFinalHostOk = (host: string) => START_HOSTS.includes(host) || host === 'archive.org' || host.endsWith('.archive.org');

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Zwraca adres u nas albo null, gdy się nie da (zły serwis, nie obrazek, za duży, błąd sieci)
export async function copyCover(supabase: SupabaseClient, url: string): Promise<string | null> {
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
