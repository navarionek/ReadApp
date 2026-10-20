// notify-new-read: wywoływana przez trigger reads_notify po dodaniu wpisu.
// Dostaje samo { id }; wszystko inne czyta z bazy, więc wywołanie z zewnątrz nic nie da:
// wpis musi być świeży (< 5 min) i jeszcze bez powiadomienia (notified_at jest zajmowane atomowo).
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { bookPoints } from '../_shared/logic.js';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'https://czytanko.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

type Read = { id: number; user_id: string; title: string | null; pages: number; multiplier: number; created_at: string };

const firstName = (name: string) => name.split(' ')[0];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async req => {
  let id: number;
  try {
    id = Number((await req.json()).id);
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (!Number.isInteger(id)) return json({ error: 'bad id' }, 400);

  // Zajęcie wpisu: tylko świeży i jeszcze niewysłany (jedno UPDATE, więc bez podwójnych wysyłek)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('reads')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', id)
    .is('notified_at', null)
    .gte('created_at', fiveMinAgo)
    .select('id, user_id, title, pages, multiplier, created_at');
  if (claimError) return json({ error: claimError.message }, 500);
  const read = (claimed as Read[] | null)?.[0];
  if (!read) return json({ skipped: true });

  // Punkty w bieżącym roku (rywalizacja resetuje się 1 stycznia, czas polski)
  // Rok liczony w czasie polskim, jak w aplikacji (wpis tuż po północy 1 stycznia to już nowy rok)
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric' }).format(new Date(read.created_at)));
  const { data: rows, error: rowsError } = await supabase
    .from('reads')
    .select('user_id, pages, multiplier')
    .gte('created_at', new Date(`${year}-01-01T00:00:00+01:00`).toISOString());
  if (rowsError) return json({ error: rowsError.message }, 500);

  const { data: profiles } = await supabase.from('profiles').select('id, display_name');
  const nameOf = new Map((profiles ?? []).map(p => [p.id, p.display_name as string]));

  const totals = new Map<string, number>();
  for (const r of rows ?? []) totals.set(r.user_id, (totals.get(r.user_id) ?? 0) + bookPoints(r));

  const gained = bookPoints(read);
  const authorAfter = totals.get(read.user_id) ?? gained;
  const authorBefore = authorAfter - gained;
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const rank = ranked.findIndex(([uid]) => uid === read.user_id) + 1;
  const author = firstName(nameOf.get(read.user_id) ?? 'Ktoś');
  const title = read.title || 'bez tytułu';

  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth')
    .neq('user_id', read.user_id);

  let sent = 0;
  await Promise.all((subs ?? []).map(async sub => {
    const mine = totals.get(sub.user_id) ?? 0;
    // Wyprzedzony = przed tym wpisem miał(a) co najmniej tyle co autor, teraz mniej
    const overtaken = mine >= authorBefore && mine < authorAfter;
    const payload = overtaken
      ? {
          title: `${author} cię wyprzedza!`,
          body: `Po książce „${title}” ${author} ma ${authorAfter} pkt, ty ${mine} pkt. Do odrobienia: ${authorAfter - mine + 1} pkt.`,
          url: './#start',
          tag: `overtake-${read.id}`,
        }
      : {
          title: `${author}: nowa książka`,
          body: `${title} · +${gained} pkt. Razem ${authorAfter} pkt (#${rank}).`,
          url: './#postepy',
          tag: `read-${read.id}`,
        };
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // Subskrypcja wygasła albo ktoś odinstalował apkę: sprzątamy
      if (status === 404 || status === 410) await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      else console.error('push failed', status, (err as Error).message);
    }
  }));

  return json({ sent, subscribers: subs?.length ?? 0 });
});
