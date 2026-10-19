// Bitcalendar config. None of these are secrets: Supabase row-level security and Google's
// authorized origins do the protecting.
window.BITCAL_CONFIG = {
  // The 128bit account (shared Supabase project "128bit play"). Tables: supabase/bitcalendar.sql.
  supabaseUrl: 'https://wvflpwtaszpstmjpkrhu.supabase.co',
  supabaseKey: 'sb_publishable_dO8uP74cTV1tbuqESgxysw_323C7lWh',
  // Google OAuth client ID, for importing + syncing from Google (README → "Connect Google").
  // Left empty, the app asks for one the first time someone taps CONNECT GOOGLE.
  googleClientId: '',
};
