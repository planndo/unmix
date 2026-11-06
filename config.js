// Public settings for the browser. Both Supabase values are safe to publish: the anon key only
// allows what the row level security rules in supabase/migrations permit.
// While supabaseUrl is empty, accounts and limits are off and the studio stays fully open.
export const CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  googleSignIn: false, // set to true after enabling the Google provider in Supabase
  supportEmail: '', // shown on the legal pages and in the footer
};
