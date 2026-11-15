// Plans, limits and license keys (Lemon Squeezy License API, validated from the browser).
import { CONFIG } from './config.js';

export const TIERS = ['free', 'plus', 'pro'];
export const PLAN = {
  free: { name: 'Free', minutes: 10 },
  plus: { name: 'Plus', price: 5, minutes: 20 },
  pro:  { name: 'Pro',  price: 9, minutes: 60 },
};
// Which plan each feature needs.
export const NEEDS = {
  stems: 'plus', studio: 'plus', focusEq: 'plus', autoMix: 'plus', formats: 'plus', stemExport: 'plus',
  clean: 'pro', batch: 'pro', stemPack: 'pro',
};
export const PITCH = {
  stems: ['Split every song into four stems', 'Drums, bass and the rest come with Plus, along with the studio vocal model, Focus EQ and Auto-mix.'],
  stemExport: ['Keep the drums, bass and other stems', 'You can listen to all four stems for free. Downloading them is part of Plus.'],
  studio: ['Cleaner vocals with the studio model', 'The studio model is larger and slower, and keeps more breath and detail in the voice. It comes with Plus.'],
  focusEq: ['Turn each instrument up or down', 'Focus EQ shapes each recognised instrument separately. It comes with Plus.'],
  autoMix: ['Let Auto-mix balance the song', 'Auto-mix measures every stem at broadcast loudness and sets the faders for you. It comes with Plus.'],
  formats: ['Lossless and Apple formats', 'FLAC, M4A, OGG and AIFF come with Plus. WAV and MP3 are always free.'],
  clean: ['Download your cleaned audio', 'You can hear the result for free. Hum, hiss and AI voice denoise downloads are part of Pro.'],
  batch: ['Convert many files at once', 'Batch conversion is part of Pro. You can still convert one file at a time for free.'],
  stemPack: ['Everything in one click', 'The stem pack (every stem, the instrumental and your mix in one zip) is part of Pro.'],
  length: ['Longer files', ''],
  any: ['Unlock more of Timbila', 'One payment, yours to keep. No subscription.'],
};

const KEY = 'timbila.license';
let state = load();
const listeners = new Set();

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && TIERS.includes(s.tier)) return s; } catch {}
  return { tier: 'free' };
}
function save() { try { state.tier === 'free' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
function emit() { listeners.forEach((f) => f(state.tier)); }

export const tier = () => state.tier;
export const rank = (t) => TIERS.indexOf(t);
export const has = (feature) => rank(state.tier) >= rank(NEEDS[feature] || 'free');
export const needs = (feature) => NEEDS[feature] || 'free';
export const maxMinutes = () => PLAN[state.tier].minutes;
export const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const demoMode = () => !CONFIG.checkout.plus && !CONFIG.checkout.pro;
export const checkoutUrl = (t) => CONFIG.checkout[t] || '';

function tierFromMeta(meta = {}) {
  const ids = [meta.variant_id, meta.product_id].filter((x) => x != null).map(String);
  for (const id of ids) if (CONFIG.products[id]) return CONFIG.products[id];
  const name = `${meta.product_name || ''} ${meta.variant_name || ''}`;
  if (/\bpro\b/i.test(name)) return 'pro';
  if (/\bplus\b/i.test(name)) return 'plus';
  return 'plus';
}

async function lsCall(action, params) {
  let res;
  try {
    res = await fetch(`https://api.lemonsqueezy.com/v1/licenses/${action}`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
    });
  } catch { throw new Error('Could not reach the license server. Check your connection and try again.'); }
  let j = null; try { j = await res.json(); } catch {}
  return j || { error: `License server error (HTTP ${res.status})` };
}

// Activate a key on this browser. Returns the tier.
export async function activate(raw) {
  const key = String(raw || '').trim();
  if (!key) throw new Error('Paste the license key from your receipt email.');
  if (demoMode() && CONFIG.demoKeys[key.toUpperCase()]) {
    state = { tier: CONFIG.demoKeys[key.toUpperCase()], key: key.toUpperCase(), demo: true, at: Date.now() }; save(); emit(); return state.tier;
  }
  let j = await lsCall('activate', { license_key: key, instance_name: `Timbila web (${navigator.platform || 'browser'})` });
  if (!j.activated) {
    // already activated on its limit of devices, or activation not allowed: a valid key still counts
    const v = await lsCall('validate', { license_key: key });
    if (!v.valid) throw new Error(friendly(j.error || v.error));
    j = v;
  }
  if (CONFIG.storeId && String(j.meta?.store_id) !== String(CONFIG.storeId)) throw new Error('This key belongs to a different store.');
  const st = j.license_key?.status;
  if (st && !['active', 'inactive'].includes(st)) throw new Error(`This key is ${st}.`);
  state = { tier: tierFromMeta(j.meta), key, instance: j.instance?.id || null, at: Date.now(), email: j.meta?.customer_email || '' };
  save(); emit(); return state.tier;
}
function friendly(msg) {
  if (!msg) return 'This key is not valid.';
  if (/not found|invalid/i.test(msg)) return 'That key was not recognised. Check it against your receipt email.';
  if (/limit/i.test(msg)) return 'This key has reached its device limit.';
  return msg;
}

// Re-check a stored key every few days; keep the plan if the server can't be reached.
export async function revalidate() {
  if (state.tier === 'free' || state.demo || !state.key) return;
  if (Date.now() - (state.at || 0) < 3 * 864e5) return;
  try {
    const v = await lsCall('validate', state.instance ? { license_key: state.key, instance_id: state.instance } : { license_key: state.key });
    if (v.valid === false && /disabled|expired|not found/i.test(`${v.error || ''} ${v.license_key?.status || ''}`)) { state = { tier: 'free' }; save(); emit(); return; }
    if (v.valid) { state.at = Date.now(); save(); }
  } catch {}
}

export function signOut() { state = { tier: 'free' }; save(); emit(); }
export const licenseInfo = () => ({ ...state });
