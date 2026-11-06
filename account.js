// Behaviour for account.html: plan and usage, upgrade, profile, billing portal and account deletion.
import { $, setBusy, startUpgrade } from './site.js';
import { accountsEnabled, client, currentUser, getPlan, callFunction, authMessage } from './auth.js';

const params = new URLSearchParams(location.search);
const banner = (text, kind = '') => { const b = $('banner'); b.textContent = text; b.className = `notice ${kind}`; b.hidden = !text; };
const formatDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let interval = 'month';
const setInterval_ = (next) => {
  interval = next;
  $('billMonth').setAttribute('aria-pressed', String(next === 'month'));
  $('billYear').setAttribute('aria-pressed', String(next === 'year'));
};

function renderPlan(plan, sub) {
  const pro = plan.tier === 'pro';
  $('planName').textContent = pro ? 'Pro' : 'Free';
  $('upgradeBox').hidden = pro;
  $('proCard').hidden = pro;
  $('usageBox').hidden = pro;
  $('portal').disabled = !sub;

  if (!pro) {
    $('usageText').textContent = `${plan.used} of ${plan.limit} songs used this month`;
    $('usageBar').innerHTML = Array.from({ length: plan.limit }, (_, i) => `<i class="${i < plan.used ? 'on' : ''}"></i>`).join('');
    $('usageReset').textContent = `Resets on ${formatDate(plan.resetsOn)}`;
  }

  const status = $('subStatus');
  status.hidden = !pro;
  if (pro && sub) {
    const when = sub.current_period_end ? formatDate(sub.current_period_end) : null;
    const every = sub.billing_interval === 'year' ? 'yearly' : 'monthly';
    if (sub.status === 'past_due') status.textContent = 'Your last payment failed. Please update your card in Manage billing to keep Pro.';
    else if (sub.cancel_at_period_end) status.textContent = when ? `Your plan is cancelled. You keep Pro until ${when}.` : 'Your plan is cancelled.';
    else status.textContent = when ? `Unlimited songs. Renews ${every} on ${when}.` : `Unlimited songs. Billed ${every}.`;
    $('billingText').textContent = 'Change your card, switch between monthly and yearly, see invoices or cancel.';
  } else if (sub) {
    $('billingText').textContent = 'See your past invoices and billing details.';
  }
}

async function loadSubscription(sb) {
  const { data, error } = await sb.from('subscriptions').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

async function refresh(sb) {
  const [plan, sub] = await Promise.all([getPlan(), loadSubscription(sb)]);
  renderPlan(plan, sub);
  return plan;
}

// Stripe tells our webhook about a purchase a moment after sending the visitor back here.
async function waitForPro(sb) {
  banner('Payment received. Activating Pro…', 'good');
  for (let i = 0; i < 10; i++) {
    if ((await refresh(sb)).tier === 'pro') { banner('Welcome to Pro! Everything is unlocked.', 'good'); return; }
    await wait(2000);
  }
  banner('Your payment went through, but Pro is taking longer than usual to activate. Reload this page in a minute.');
}

function bindProfile(sb, user) {
  $('fullName').value = user.user_metadata?.full_name || '';
  $('emailShown').value = user.email || '';
  const hasPassword = (user.identities || []).some((i) => i.provider === 'email');
  $('pwForm').hidden = !hasPassword;
  $('emailNote').hidden = hasPassword;

  $('nameForm').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button');
    setBusy(b, true, 'Saving…');
    const { error } = await sb.auth.updateUser({ data: { full_name: $('fullName').value.trim() } });
    setBusy(b, false);
    banner(error ? authMessage(error) : 'Name saved.', error ? 'bad' : 'good');
  };

  $('pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button[type=submit]');
    if ($('newPw').value.length < 8) { banner('Your new password needs at least 8 characters.', 'bad'); return; }
    setBusy(b, true, 'Updating…');
    // Confirm the current password so an unattended, signed-in browser can't change it.
    const { error: wrong } = await sb.auth.signInWithPassword({ email: user.email, password: $('currentPw').value });
    if (wrong) { setBusy(b, false); banner('Your current password is not right.', 'bad'); return; }
    const { error } = await sb.auth.updateUser({ password: $('newPw').value });
    setBusy(b, false);
    if (error) { banner(authMessage(error), 'bad'); return; }
    e.target.reset();
    banner('Password updated.', 'good');
  };
}

function bindActions(sb) {
  $('billMonth').onclick = () => setInterval_('month');
  $('billYear').onclick = () => setInterval_('year');
  $('upgrade').onclick = () => startUpgrade(interval, $('upgrade'), (m) => banner(m, 'bad'));

  $('portal').onclick = async () => {
    setBusy($('portal'), true, 'Opening…');
    try { location.href = (await callFunction('create-portal')).url; }
    catch (e) { setBusy($('portal'), false); banner(e.message, 'bad'); }
  };

  $('signOut').onclick = async () => { await sb.auth.signOut(); location.href = 'index.html'; };

  const dialog = $('deleteDialog');
  $('deleteOpen').onclick = () => { $('deleteWord').value = ''; $('deleteConfirm').disabled = true; $('deleteError').hidden = true; dialog.showModal(); };
  $('deleteCancel').onclick = () => dialog.close();
  $('deleteForm').onsubmit = (e) => e.preventDefault();
  $('deleteWord').oninput = () => { $('deleteConfirm').disabled = $('deleteWord').value !== 'DELETE'; };
  $('deleteConfirm').onclick = async () => {
    setBusy($('deleteConfirm'), true, 'Deleting…');
    try {
      await callFunction('delete-account', { confirm: 'DELETE' });
      await sb.auth.signOut({ scope: 'local' });
      location.href = 'index.html';
    } catch (e) {
      setBusy($('deleteConfirm'), false);
      const err = $('deleteError'); err.textContent = e.message; err.hidden = false;
    }
  };
}

async function main() {
  if (!accountsEnabled) { location.replace('signup.html'); return; }
  const user = await currentUser();
  if (!user) { location.replace(`login.html?next=${encodeURIComponent(`account.html${location.search}`)}`); return; }

  const sb = await client();
  $('whoami').textContent = `Signed in as ${user.email}`;
  bindProfile(sb, user);
  bindActions(sb);
  const plan = await refresh(sb);
  $('content').hidden = false;

  if (params.get('password') === 'updated') banner('Your new password is saved.', 'good');
  if (params.get('checkout') === 'success') waitForPro(sb);
  const wanted = params.get('upgrade');
  if ((wanted === 'month' || wanted === 'year') && plan.tier !== 'pro') {
    setInterval_(wanted);
    $('upgrade').click();
  }
  if (params.size) history.replaceState(null, '', 'account.html');
}

main().catch((e) => {
  console.error(e);
  $('whoami').textContent = 'We could not load your account. Check your connection and reload this page.';
});
