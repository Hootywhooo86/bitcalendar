// Bitcalendar push reminders. pg_cron calls this every minute (supabase/bitcalendar-reminders.sql).
// It finds reminders that are due, sends each one once to every browser that signed up for them,
// and forgets browsers that unsubscribed. Safe to call more often: bitcal_sent stops repeats.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { importPrivate, newVapidKeys, sendPush } from './push.js';
import { CATCH_UP, due, message } from './reminders.js';

const SUBJECT = 'https://hootywhooo86.github.io/bitcalendar/';
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The push signing key is made on the first run and kept in bitcal_vapid (server-only table).
async function vapid(tries = 2): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const { data } = await db.from('bitcal_vapid').select('public_key, private_jwk').eq('id', 1).maybeSingle();
  if (data) return { publicKey: data.public_key, privateKey: await importPrivate(data.private_jwk) };
  const k = await newVapidKeys();
  const { error } = await db.from('bitcal_vapid').insert({ id: 1, public_key: k.publicKey, private_jwk: k.privateJwk });
  if (error && tries > 0) return vapid(tries - 1); // another run made it first
  if (error) throw error;
  return k;
}

async function all<T>(build: () => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

Deno.serve(async () => {
  try {
    const keys = await vapid();
    const now = Date.now();
    const subs = await all<any>(() => db.from('bitcal_push').select('endpoint, user_id, p256dh, auth, tz, h24'));
    if (!subs.length) return json({ due: 0, sent: 0 });
    const byUser = new Map<string, any[]>();
    for (const s of subs) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s]);

    // Single events about to start (reminders reach up to 4 weeks ahead), and series still running.
    const soon = new Date(now - CATCH_UP).toISOString(), horizon = new Date(now + 29 * 86400000).toISOString();
    const events = await all<any>(() => db.from('bitcal_events')
      .select('id, user_id, title, starts_at, ends_at, all_day, tz, rrule, exdates, reminder, location')
      .in('user_id', [...byUser.keys()]).is('deleted_at', null).not('reminder', 'is', null).lt('starts_at', horizon)
      .or(`and(rrule.is.null,starts_at.gte."${soon}"),and(rrule.not.is.null,or(until_at.is.null,until_at.gte."${new Date(now - 2 * 86400000).toISOString()}"))`));

    const found = due(events, now, (u: string) => byUser.get(u)?.[0]?.tz);
    if (!found.length) return json({ checked: events.length, due: 0, sent: 0 });

    // Claim each reminder once; only rows inserted by this run come back.
    const { data: claimed, error } = await db.from('bitcal_sent')
      .upsert(found.map(f => ({ event_id: f.ev.id, occurs_at: f.at.toISOString() })), { onConflict: 'event_id,occurs_at', ignoreDuplicates: true })
      .select('event_id, occurs_at');
    if (error) throw error;
    const mine = new Set((claimed || []).map((c: any) => `${c.event_id}@${Date.parse(c.occurs_at)}`));

    let sent = 0;
    const gone: string[] = [];
    await Promise.all(found.filter(f => mine.has(`${f.ev.id}@${+f.at}`)).flatMap(f => (byUser.get(f.ev.user_id) || []).map(async s => {
      const status = await sendPush(s, message(f.ev, f.at, now, s.tz, s.h24), keys, SUBJECT).catch(() => 0);
      if (status === 404 || status === 410) gone.push(s.endpoint);
      else if (status >= 200 && status < 300) sent++;
      else console.error('push failed', status, new URL(s.endpoint).host);
    })));
    if (gone.length) await db.from('bitcal_push').delete().in('endpoint', gone);
    if (new Date(now).getUTCMinutes() === 0) await db.from('bitcal_sent').delete().lt('sent_at', new Date(now - 3 * 86400000).toISOString());
    return json({ checked: events.length, due: found.length, sent, removed: gone.length });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
