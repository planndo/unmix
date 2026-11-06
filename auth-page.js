// Behaviour for signup.html, login.html, forgot.html and reset.html, chosen by <body data-auth-page>.
import { accountsEnabled, googleEnabled, client, currentUser, safeNext, pageUrl, authMessage } from './auth.js';
import { LOGO, setBusy, $ } from './site.js';

const page = document.body.dataset.authPage;
const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
const MIN_PASSWORD = 8;

$('authBrand').innerHTML = `${LOGO}unmix`;

const showError = (text) => { const n = $('formError'); n.textContent = text; n.hidden = !text; };
const fieldError = (input, text) => {
  const e = $(`${input.id}Err`);
  input.setAttribute('aria-invalid', String(Boolean(text)));
  if (e) { e.textContent = text; e.hidden = !text; }
  return !text;
};
const validEmail = (input) => fieldError(input, /^\S+@\S+\.\S+$/.test(input.value.trim()) ? '' : 'Enter a valid email address.');
const validPassword = (input) => fieldError(input, input.value.length >= MIN_PASSWORD ? '' : `Use at least ${MIN_PASSWORD} characters.`);

document.querySelectorAll('.pw-toggle').forEach((b) => {
  const input = b.previousElementSibling;
  b.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
    b.setAttribute('aria-pressed', String(show));
  };
});

// Carry the destination across the sign-up and log-in pages.
document.querySelectorAll('[data-keep-next]').forEach((a) => {
  if (params.get('next')) a.href = `${a.getAttribute('href')}?next=${encodeURIComponent(next)}`;
});

function showSent(title, body) {
  $('formView').hidden = true;
  $('sentView').hidden = false;
  $('sentTitle').textContent = title;
  $('sentBody').textContent = body;
}

if (!accountsEnabled) {
  $('formView').hidden = true;
  $('offView').hidden = false;
} else {
  init().catch((e) => showError(authMessage(e)));
}

async function init() {
  const sb = await client();

  const google = $('googleBtn');
  if (google) {
    $('googleBlock').hidden = !googleEnabled;
    google.onclick = async () => {
      if (page === 'signup' && !$('terms').checked) { fieldError($('terms'), 'Please agree to the Terms and Privacy Policy to continue.'); return; }
      setBusy(google, true, 'Opening Google…');
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: pageUrl(next) } });
      if (error) { setBusy(google, false); showError(authMessage(error)); }
    };
  }

  if (page === 'signup' || page === 'login') {
    if (await currentUser()) { location.replace(next); return; }
  }

  const form = $('authForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    showError('');
    const submit = form.querySelector('button[type=submit]');
    if (page === 'signup') await signUp(sb, submit);
    if (page === 'login') await logIn(sb, submit);
    if (page === 'forgot') await forgot(sb, submit);
    if (page === 'reset') await reset(sb, submit);
  };

  if (page === 'reset') {
    // Supabase signs the visitor in from the link in the email before this page can change the password.
    await new Promise((r) => setTimeout(r, 150));
    if (!(await currentUser())) {
      $('formView').hidden = true;
      showSent('This link has expired', 'Password reset links only work once and for a limited time. Please request a new one.');
      $('sentAction').hidden = false;
    }
  }
}

async function signUp(sb, submit) {
  const name = $('name'), email = $('email'), password = $('password'), terms = $('terms');
  const nameOk = fieldError(name, name.value.trim() ? '' : 'Tell us what to call you.');
  const emailOk = validEmail(email), passOk = validPassword(password);
  const termsOk = fieldError(terms, terms.checked ? '' : 'Please agree to the Terms and Privacy Policy to continue.');
  if (!nameOk || !emailOk || !passOk || !termsOk) return;
  setBusy(submit, true, 'Creating your account…');
  const { data, error } = await sb.auth.signUp({
    email: email.value.trim(),
    password: password.value,
    options: {
      data: { full_name: name.value.trim(), terms_accepted_at: new Date().toISOString() },
      emailRedirectTo: pageUrl(next),
    },
  });
  setBusy(submit, false);
  if (error) { showError(authMessage(error)); return; }
  if (data.session) { location.replace(next); return; }
  showSent('Check your email', `We sent a confirmation link to ${email.value.trim()}. Open it to finish creating your account.`);
}

async function logIn(sb, submit) {
  const email = $('email'), password = $('password');
  const emailOk = validEmail(email);
  const passOk = fieldError(password, password.value ? '' : 'Enter your password.');
  if (!emailOk || !passOk) return;
  setBusy(submit, true, 'Logging in…');
  const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
  if (error) { setBusy(submit, false); showError(authMessage(error)); return; }
  location.replace(next);
}

async function forgot(sb, submit) {
  const email = $('email');
  if (!validEmail(email)) return;
  setBusy(submit, true, 'Sending…');
  const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: pageUrl('reset.html') });
  setBusy(submit, false);
  if (error && /rate limit/i.test(error.message)) { showError(authMessage(error)); return; }
  // The same answer either way, so this form can't reveal who has an account.
  showSent('Check your email', `If ${email.value.trim()} has an Unmix account, a password reset link is on its way.`);
}

async function reset(sb, submit) {
  const password = $('password');
  if (!validPassword(password)) return;
  setBusy(submit, true, 'Saving…');
  const { error } = await sb.auth.updateUser({ password: password.value });
  setBusy(submit, false);
  if (error) { showError(authMessage(error)); return; }
  location.replace('account.html?password=updated');
}
