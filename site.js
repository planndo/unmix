// Shared header, footer and page behaviour for the marketing, sign-up and account pages.
import { accountsEnabled, currentUser, getPlan, callFunction, pageUrl } from './auth.js';
import { CONFIG } from './config.js';

export const $ = (id) => document.getElementById(id);

export const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="11" width="3.2" height="10" rx="1.6" fill="var(--fg)"/><rect x="9" y="6" width="3.2" height="20" rx="1.6" fill="var(--voice)"/><rect x="15" y="9" width="3.2" height="14" rx="1.6" fill="var(--drums)"/><rect x="21" y="4" width="3.2" height="24" rx="1.6" fill="var(--bass)"/><rect x="27" y="11" width="3.2" height="10" rx="1.6" fill="var(--other)"/></svg>';
const brand = `<a class="brand" href="index.html" aria-label="Unmix home">${LOGO}unmix</a>`;

export const initials = (user) => {
  const source = (user.user_metadata?.full_name || user.email || '?').trim();
  const parts = source.split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)).toUpperCase();
};

function renderHeader(slot) {
  const here = location.pathname.split('/').pop() || 'index.html';
  const links = [['index.html#features', 'Features'], ['pricing.html', 'Pricing'], ['index.html#faq', 'FAQ'], ['studio.html', 'Studio']];
  const nav = links.map(([href, label]) => `<a href="${href}"${href === here ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  slot.innerHTML = `<header class="site-header" id="siteHeader">
    <div class="wrap bar">
      ${brand}
      <nav class="nav-links" aria-label="Main">${nav}</nav>
      <div class="nav-end" id="navEnd">
        <a class="btn btn-primary btn-sm" href="studio.html">Open Studio</a>
      </div>
      <button class="menu-btn" id="menuBtn" type="button" aria-label="Menu" aria-expanded="false" aria-controls="mobileNav">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
    </div>
    <nav class="mobile-nav" id="mobileNav" aria-label="Mobile" hidden>${nav}<span id="mobileAuth" style="display:contents"></span></nav>
  </header>`;
  $('menuBtn').onclick = () => {
    const open = $('mobileNav').hidden;
    $('mobileNav').hidden = !open;
    $('menuBtn').setAttribute('aria-expanded', String(open));
  };
  addEventListener('scroll', () => $('siteHeader').classList.toggle('scrolled', scrollY > 8), { passive: true });
}

function renderFooter(slot) {
  const support = CONFIG.supportEmail ? `<li><a href="mailto:${CONFIG.supportEmail}">Email support</a></li>` : '';
  slot.innerHTML = `<footer class="site-footer"><div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">${brand}<p class="foot-note">AI stem separation that runs on your own device. Your music is never uploaded.</p></div>
      <div><h3>Product</h3><ul><li><a href="studio.html">Studio</a></li><li><a href="index.html#features">Features</a></li><li><a href="pricing.html">Pricing</a></li></ul></div>
      <div><h3>Legal</h3><ul><li><a href="terms.html">Terms</a></li><li><a href="privacy.html">Privacy</a></li></ul></div>
      <div><h3>Support</h3><ul><li><a href="index.html#faq">FAQ</a></li>${support}${accountsEnabled ? '<li><a href="account.html">Your account</a></li>' : ''}</ul></div>
    </div>
    <div class="foot-base"><span>Only process music you have the rights to use.</span><span>Developed by <a href="https://www.linkedin.com/in/joseamandlate/" target="_blank" rel="noopener">Pygrammer</a></span></div>
  </div></footer>`;
}

async function fillAuthState() {
  const end = $('navEnd');
  if (!end || !accountsEnabled) return;
  const signedOut = '<a class="text-link" href="login.html">Log in</a><a class="btn btn-primary btn-sm" href="signup.html">Sign up free</a>';
  end.innerHTML = signedOut;
  $('mobileAuth').innerHTML = '<a href="login.html">Log in</a>';
  const user = await currentUser().catch(() => null);
  if (!user) return;
  end.innerHTML = '<span class="plan-pill" id="navPlan" hidden></span><a class="btn btn-primary btn-sm" href="studio.html">Open Studio</a>';
  const avatar = document.createElement('a');
  avatar.className = 'avatar'; avatar.href = 'account.html'; avatar.textContent = initials(user); avatar.setAttribute('aria-label', 'Your account');
  end.append(avatar);
  $('mobileAuth').innerHTML = '<a href="account.html">Your account</a>';
  getPlan().then((plan) => {
    const pill = $('navPlan'); pill.hidden = false; pill.textContent = plan.tier;
    pill.classList.toggle('pro', plan.tier === 'pro');
    if (plan.tier === 'pro') document.querySelectorAll('[data-hide-for-pro]').forEach((n) => { n.hidden = true; });
  }).catch(() => {});
  document.querySelectorAll('[data-signup-cta]').forEach((a) => { a.href = 'studio.html'; a.textContent = 'Open Studio'; });
}

// Pages work without accounts until Supabase is configured: sign-up buttons become studio links.
function applyAccountsOff() {
  if (accountsEnabled) return;
  document.querySelectorAll('[data-signup-cta]').forEach((a) => { a.href = 'studio.html'; a.textContent = 'Open Studio'; });
  document.querySelectorAll('[data-needs-accounts]').forEach((n) => { n.hidden = true; });
}

// Decorative waveform bars: seeded, so the picture stays the same on every visit.
function waveform(kind, seed, bars = 96) {
  let x = seed; const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const shape = {
    voice: (t) => (Math.sin(t * 19) > -0.35 ? 0.35 + 0.6 * Math.abs(Math.sin(t * 61)) : 0.04),
    drums: (t, i) => (i % 8 === 0 ? 1 : i % 4 === 0 ? 0.72 : i % 2 === 0 ? 0.34 : 0.14),
    bass: (t) => 0.42 + 0.2 * Math.sin(t * 25),
    other: (t) => 0.28 + 0.42 * Math.abs(Math.sin(t * 7 + 1)),
  }[kind];
  let d = '';
  for (let i = 0; i < bars; i++) {
    const h = Math.max(0.03, Math.min(1, shape(i / bars, i) * (0.72 + 0.28 * rnd()))) * 44;
    d += `M${i * 5 + 2} ${30 - h / 1.5}v${h * 1.33}`;
  }
  return `<svg viewBox="0 0 480 60" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>`;
}

export function renderLanes(slot) {
  const rows = [['voice', 'Vocals', 11], ['drums', 'Drums', 29], ['bass', 'Bass', 47], ['other', 'Other', 83]];
  slot.innerHTML = `<div class="lanes-card" role="img" aria-label="Illustration of a song split into four lanes: vocals, drums, bass and other">
    ${rows.map(([k, label, seed]) => `<div class="lane" style="--c:var(--${k})"><div class="who"><i></i>${label}</div>${waveform(k, seed)}</div>`).join('')}
    <div class="playhead" id="heroHead" aria-hidden="true"></div>
    <div class="lanes-foot"><span>your-song.mp3</span><span>On this device</span></div>
  </div>`;
  const card = slot.firstElementChild;
  const measure = () => card.style.setProperty('--sweep', `${card.clientWidth - 110}px`);
  measure(); addEventListener('resize', measure);
}

export function setBusy(button, busy, label) {
  if (busy) { button.dataset.label = button.textContent; button.disabled = true; button.innerHTML = `<span class="spin" aria-hidden="true"></span>${label || 'Working…'}`; }
  else { button.disabled = false; button.textContent = button.dataset.label; }
}

// Sends the signed-in visitor to Stripe Checkout, or to sign-up first if they have no account yet.
export async function startUpgrade(interval, button, showError) {
  const user = await currentUser();
  if (!user) { location.href = `signup.html?next=${encodeURIComponent(`account.html?upgrade=${interval}`)}`; return; }
  setBusy(button, true, 'Opening checkout…');
  try { location.href = (await callFunction('create-checkout', { interval })).url; }
  catch (e) { setBusy(button, false); showError(e.message); }
}

function reveal() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('[data-reveal]').forEach((n) => { n.classList.add('reveal'); io.observe(n); });
}

const header = $('site-header-slot'), footer = $('site-footer-slot');
if (header) renderHeader(header);
if (footer) renderFooter(footer);
applyAccountsOff();
reveal();
fillAuthState();
export { pageUrl };
