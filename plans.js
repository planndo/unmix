// Limits and prices shown in the browser. The server enforces the same monthly number:
// keep FREE_SONGS_PER_MONTH in step with free_song_limit() in supabase/migrations.
// The prices themselves are set in Stripe; change them there too.
export const FREE_SONGS_PER_MONTH = 5;
export const GUEST_SONGS = 1;
export const PRICE = {
  month: { amount: '$5', suffix: '/ month', note: 'Billed monthly' },
  year: { amount: '$39', suffix: '/ year', note: 'Billed yearly, about $3.25 a month' },
};
