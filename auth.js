// Accounts and plan checks shared by every page. The Supabase library loads only when configured.
import { CONFIG } from './config.js';
import { GUEST_SONGS } from './plans.js';

export const accountsEnabled = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
export const googleEnabled = accountsEnabled && CONFIG.googleSignIn;

let clientPromise;
export function client() {
  clientPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/supabase.js', import.meta.url).href;
    s.onload = () => resolve(window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey));
    s.onerror = () => reject(new Error('Could not load the sign-in library.'));
    document.head.append(s);
  });
  return clientPromise;
}

export async function currentUser() {
  if (!accountsEnabled) return null;
  const { data } = await (await client()).auth.getSession();
  return data.session?.user ?? null;
}

const GUEST_KEY = 'unmix.guestSongs';
function guestUsed() { try { return Number(localStorage.getItem(GUEST_KEY)) || 0; } catch { return 0; } }

// tier: 'open' (accounts not configured), 'guest', 'free' or 'pro'
export async function getPlan() {
  if (!accountsEnabled) return { tier: 'open' };
  if (!(await currentUser())) return { tier: 'guest', used: guestUsed(), limit: GUEST_SONGS };
  const { data, error } = await (await client()).rpc('get_entitlements');
  if (error) throw error;
  return { tier: data.plan, used: data.used, limit: data.limit, resetsOn: data.resets_on };
}

// Takes one song from the allowance. The signed-in check runs on the server.
export async function claimSong(plan) {
  if (plan.tier === 'open') return { allowed: true };
  if (plan.tier === 'guest') {
    const used = guestUsed();
    if (used >= GUEST_SONGS) return { allowed: false };
    try { localStorage.setItem(GUEST_KEY, String(used + 1)); } catch { /* private mode */ }
    return { allowed: true, used: used + 1, limit: GUEST_SONGS };
  }
  const { data, error } = await (await client()).rpc('claim_song');
  if (error) throw error;
  return data;
}

// Calls a signed-in edge function and returns its JSON, or throws with its readable message.
export async function callFunction(name, body = {}) {
  const { data, error } = await (await client()).functions.invoke(name, { body });
  if (!error) return data;
  let message = 'Something went wrong. Please try again.';
  try { message = (await error.context.json()).error || message; } catch { /* keep the default */ }
  throw new Error(message);
}

// Only ever redirect to one of our own flat pages, so a crafted link can't send people elsewhere.
export function safeNext(next, fallback = 'studio.html') {
  return /^[a-z0-9-]+\.html(\?[\w=&%.-]*)?$/i.test(next || '') ? next : fallback;
}

export const pageUrl = (path) => new URL(path, location.href).href;

export function authMessage(error) {
  const code = error?.code || '';
  const text = String(error?.message || error || '');
  if (code === 'invalid_credentials' || /invalid login/i.test(text)) return 'That email and password don\'t match. Check them and try again.';
  if (code === 'email_not_confirmed' || /not confirmed/i.test(text)) return 'Please confirm your email first. Check your inbox for the link.';
  if (code === 'weak_password' || /password should/i.test(text)) return 'Please choose a stronger password with at least 8 characters.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || /rate limit/i.test(text)) return 'Too many attempts. Please wait a few minutes and try again.';
  if (code === 'same_password') return 'Your new password must be different from the current one.';
  if (/failed to fetch|network/i.test(text)) return 'We could not reach the server. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
}
