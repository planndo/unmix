// Shared UI: helpers, toast, key progress bar, the marimba voice, the upgrade sheet, format picker.
import * as plans from './plans.js';
import { FORMATS } from './io.js';

export const $ = (id) => document.getElementById(id);
export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
export const tagHtml = (t) => (t === 'free' ? '' : `<span class="tag ${t}">${icon('lock')}${plans.PLAN[t].name}</span>`);

export function toast(msg, ms = 2800) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- key progress bar: 32 keys of falling length that light up ---------- */
export function keybar(el) {
  el.innerHTML = Array.from({ length: 32 }, (_, k) => `<i style="--k:${k}"></i>`).join('');
  const keys = [...el.children]; let last = -1;
  return (frac) => {
    const n = Math.max(0, Math.min(32, Math.round(frac * 32)));
    if (n === last) return; last = n;
    keys.forEach((k, i) => { k.className = i < n ? 'on' : i === n && n < 32 ? 'now' : ''; });
  };
}

/* ---------- marimba voice (hero timbila and small UI moments) ---------- */
let ac = null;
export function strike(freq, vel = 0.7) {
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    const t = ac.currentTime, out = ac.createGain(); out.gain.value = 0.32 * vel; out.connect(ac.destination);
    // a struck wooden bar: fundamental, the 4th partial (tuned bars ring near 4x) and a short click
    [[1, 1, 1.6], [3.99, 0.28, 0.35], [9.2, 0.09, 0.08]].forEach(([mul, amp, dec]) => {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = freq * mul;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + dec + 0.05);
    });
  } catch {}
}

/* ---------- upgrade / license sheet ---------- */
let sheetCtx = null;
export function openSheet(feature = 'any', extra = {}) {
  const need = feature === 'length' ? extra.tier || 'plus' : plans.needs(feature) === 'free' ? 'plus' : plans.needs(feature);
  const [title, why] = plans.PITCH[feature] || plans.PITCH.any;
  $('shTitle').textContent = feature === 'length' ? `Files up to ${plans.PLAN[need].minutes} minutes` : title;
  $('shWhy').textContent = feature === 'length'
    ? `This file is ${extra.minutes} minutes long. ${plans.PLAN[plans.tier()].name} handles up to ${plans.maxMinutes()} minutes, and ${plans.PLAN[need].name} up to ${plans.PLAN[need].minutes}.`
    : why;
  const cards = [
    ['plus', ['4 stems and the studio vocal model', 'Instrument Focus EQ and Auto-mix', 'FLAC, M4A, OGG and AIFF', 'Songs up to 20 minutes']],
    ['pro', ['Everything in Plus', 'AI noise, hiss and hum removal', 'Batch conversion and stem pack', 'Files up to 60 minutes']],
  ].filter(([t]) => plans.rank(t) > plans.rank(plans.tier()));
  $('shPlans').style.gridTemplateColumns = cards.length === 1 ? '1fr' : '';
  $('shPlans').innerHTML = cards.map(([t, items]) => `
    <div class="po ${t === need ? 'rec' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:17px">${plans.PLAN[t].name}</b>${t === need && feature !== 'any' ? '<span class="tag plus">Unlocks this</span>' : ''}</div>
      <b class="p">$${plans.PLAN[t].price}<span style="font:500 13px var(--f-body);color:var(--muted)"> once</span></b>
      <ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>
      <button class="btn ${t === need ? 'warm' : 'ghost'} sm" type="button" data-buy="${t}">Get ${plans.PLAN[t].name}</button>
    </div>`).join('') || `<p class="hint">You have every feature. ${plans.licenseInfo().demo ? 'This is a test key.' : ''} <button type="button" class="btn ghost sm" id="signOut" style="margin-left:6px">Remove key from this browser</button></p>`;
  const so = document.getElementById('signOut'); if (so) so.onclick = () => { plans.signOut(); closeSheet(); toast('License removed from this browser'); };
  $('licMsg').className = 'lic-msg';
  $('licMsg').textContent = plans.demoMode() ? 'Checkout is not connected yet. To try the paid features, use TIMBILA-PLUS-DEMO or TIMBILA-PRO-DEMO.' : '';
  sheetCtx = extra.then || null;
  const d = $('sheet'); if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
}
export function closeSheet() { const d = $('sheet'); try { d.close(); } catch { d.removeAttribute('open'); } }
export function buy(t) {
  const url = plans.checkoutUrl(t);
  if (!$('sheet').open) openSheet('any');
  const msg = $('licMsg'); msg.className = 'lic-msg';
  if (!url) { msg.textContent = 'Checkout opens soon. Until then you can try every feature with TIMBILA-PLUS-DEMO or TIMBILA-PRO-DEMO.'; $('licKey').focus(); return; }
  window.open(url, '_blank', 'noopener');
  msg.textContent = 'Checkout opened in a new tab. Paste the key from your receipt here.';
}
export function initSheet() {
  $('shClose').onclick = closeSheet;
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-buy]'); if (b) { e.preventDefault(); buy(b.dataset.buy); } });
  const go = async () => {
    const msg = $('licMsg'); msg.className = 'lic-msg'; msg.textContent = 'Checking your key…'; $('licGo').disabled = true;
    try {
      const t = await plans.activate($('licKey').value);
      msg.className = 'lic-msg ok'; msg.textContent = `${plans.PLAN[t].name} is active on this browser. Thank you!`;
      strike(523.25); setTimeout(() => strike(783.99), 120); setTimeout(() => strike(1046.5), 240);
      $('licKey').value = '';
      setTimeout(() => { closeSheet(); toast(`${plans.PLAN[t].name} unlocked`); const f = sheetCtx; sheetCtx = null; f?.(); }, 900);
    } catch (e) { msg.className = 'lic-msg err'; msg.textContent = e.message || String(e); }
    finally { $('licGo').disabled = false; }
  };
  $('licGo').onclick = go; $('licKey').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}
// Run fn if the plan allows the feature, otherwise show the sheet (and run fn once unlocked).
export function gate(feature, fn) { if (plans.has(feature)) return fn(); openSheet(feature, { then: () => plans.has(feature) && fn() }); }

/* ---------- format picker ---------- */
export function formatPicker(el, { value = 'wav', onChange } = {}) {
  let cur = value;
  const render = () => {
    el.innerHTML = Object.entries(FORMATS).map(([k, f]) => `<button type="button" class="fmt" data-f="${k}" aria-pressed="${k === cur}" title="${f.note}">${f.label}${f.tier !== 'free' && !plans.has('formats') ? icon('lock') : ''}</button>`).join('');
  };
  el.onclick = (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    const k = b.dataset.f;
    const pick = () => { cur = k; render(); onChange?.(k); };
    if (FORMATS[k].tier !== 'free') gate('formats', pick); else pick();
  };
  render(); plans.onChange(render);
  return { get: () => cur };
}

export function fitCanvas(cv) {
  const w = cv.clientWidth, h = cv.clientHeight, d = devicePixelRatio || 1;
  if (!w || !h) return null;
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
  const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
