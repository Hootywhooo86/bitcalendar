// Bitcalendar's server-side Google sync (handler.js). Deploy with "Verify JWT" off: it checks Clerk's
// session tokens itself. Secrets: CLERK_SECRET_KEY (sk_…) and CLERK_PUBLISHABLE_KEY (pk_…).
// gsync.js, google.js and recur.js are copies of app/js/ (npm run share).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5.9.6';
import { createHandler } from './handler.js';

const pk = Deno.env.get('CLERK_PUBLISHABLE_KEY') ?? '';
// pk_test_<base64("<frontend api host>$")>: that host signs the session tokens.
const issuer = 'https://' + atob(pk.split('_')[2] ?? '').replace(/\$$/, '');
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const check = ({ data, error }: { data: any; error: any }) => { if (error) throw new Error(error.message); return data; };

Deno.serve(createHandler({
  clerkSecret: Deno.env.get('CLERK_SECRET_KEY') ?? '',
  verify: async (token: string) => (await jwtVerify(token, jwks, { issuer })).payload.sub as string,
  // The server sees every row, so everything here is pinned to one person.
  dbFor: (uid: string) => ({
    listCalendars: async () => check(await db.from('bitcal_calendars').select('*').eq('user_id', uid)),
    insertCalendar: async (row: any) => check(await db.from('bitcal_calendars').insert({ ...row, user_id: uid }).select().single()),
    updateCalendar: async (id: string, patch: any) => check(await db.from('bitcal_calendars').update(patch).eq('id', id).eq('user_id', uid).select().single()),
    mirror: async (cal: string, rows: any[]) => check(await db.rpc('bitcal_mirror', { cal, rows })),
    mirrorTasks: async (list: string, rows: any[]) => check(await db.rpc('bitcal_mirror_tasks', { list, rows })),
  }),
  status: {
    async set(uid: string, fields: any) {
      const { changes, ...row } = fields;
      check(await db.from('bitcal_google').upsert({ user_id: uid, ...row }));
      return { ...row, changes };
    },
    async due(before: string, limit: number) {
      const rows = check(await db.from('bitcal_google').select('user_id').or(`synced_at.is.null,synced_at.lt.${before}`).order('synced_at', { nullsFirst: true }).limit(limit));
      return rows.map((r: any) => r.user_id);
    },
  },
}));
