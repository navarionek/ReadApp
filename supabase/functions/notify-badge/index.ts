// notify-badge: wywoływana przez trigger user_badges_notify po zapisaniu zdobytej odznaki.
// Dostaje samo { id }; wszystko inne czyta z bazy, więc wywołanie z zewnątrz nic nie da:
// odznaka musi być świeża (< 5 min) i jeszcze bez powiadomienia (notified_at jest zajmowane atomowo).
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { BADGE_INFO } from '../_shared/badges.js';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'https://czytanko.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

type Badge = { id: number; user_id: string; badge_id: string };

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

  // Zajęcie odznaki: tylko świeża i jeszcze niewysłana (jedno UPDATE, więc bez podwójnych wysyłek)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('user_badges')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', id)
    .is('notified_at', null)
    .gte('earned_at', fiveMinAgo)
    .select('id, user_id, badge_id');
  if (claimError) return json({ error: claimError.message }, 500);
  const badge = (claimed as Badge[] | null)?.[0];
  if (!badge) return json({ skipped: true });

  const info = BADGE_INFO.find(b => b.id === badge.badge_id);
  if (!info) return json({ skipped: true });

  const { data: profile } = await supabase.from('profiles').select('display_name').eq('id', badge.user_id).maybeSingle();
  const who = firstName(profile?.display_name ?? 'Ktoś');

  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .neq('user_id', badge.user_id);

  const payload = JSON.stringify({
    title: `${who} zdobywa odznakę!`,
    body: `${info.name}: ${info.desc}`,
    url: './#ranking',
    tag: `badge-${badge.id}`,
  });

  let sent = 0;
  await Promise.all((subs ?? []).map(async sub => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 60 * 60 * 24 });
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
