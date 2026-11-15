// Timbila: page wiring. Home (hero, tool deck, pricing, FAQ) and the three work views.
import * as plans from './plans.js';
import * as studio from './studio.js';
import * as clean from './clean.js';
import * as convert from './convert.js';
import { $, strike, toast, openSheet, initSheet, gate, reduced } from './ui.js';

document.documentElement.classList.add('js');

/* ---------- theme ---------- */
const THEME = 'timbila.theme';
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('themeBtn').innerHTML = `<svg><use href="#i-${dark ? 'sun' : 'moon'}"/></svg>`;
  $('themeBtn').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  requestAnimationFrame(() => { studio.redraw(); clean.draw(); });
}
let theme = null; try { theme = localStorage.getItem(THEME); } catch {}
applyTheme(theme);
$('themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  theme = dark ? 'light' : 'dark'; try { localStorage.setItem(THEME, theme); } catch {} applyTheme(theme);
};
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!document.documentElement.dataset.theme) applyTheme(null); });
addEventListener('scroll', () => $('top').classList.toggle('scrolled', scrollY > 8), { passive: true });

/* ---------- plan badge + pricing state ---------- */
function syncPlan() {
  const t = plans.tier();
  $('planBtn').dataset.tier = t; $('planLbl').textContent = plans.PLAN[t].name;
  $('planSub').textContent = t === 'pro' ? 'Active' : 'Upgrade';
  document.querySelectorAll('.plan').forEach((card) => {
    const p = card.dataset.plan, owned = plans.rank(p) <= plans.rank(t) && p !== 'free';
    card.toggleAttribute('data-owned', owned);
    const b = card.querySelector('.btn'); if (owned) b.textContent = p === t ? 'Your plan' : 'Included in your plan';
  });
  syncTool();
}
plans.onChange(syncPlan);
$('planBtn').onclick = () => openSheet('any');
$('haveKey').onclick = () => { openSheet('any'); setTimeout(() => $('licKey').focus(), 50); };
initSheet();
plans.revalidate();

/* ---------- the timbila (hero) ---------- */
const NOTES = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99];
const NAMES = ['C', 'D', 'E', 'G', 'A', 'C', 'D', 'E', 'G'];
const COLORS = ['--voice', '--drums', '--bass', '--other'];
(function buildTimbila() {
  const box = $('timbila');
  box.innerHTML = '<svg class="cords" aria-hidden="true"><polyline/><polyline/></svg>' + NOTES.map((f, i) => {
    const h = 100 - i * 4.6;
    return `<button class="key" type="button" style="--i:${i};--h:${h}%;--c:var(${COLORS[i % 4]})" data-i="${i}" aria-label="Play ${NAMES[i]}"><span class="slat"><span class="inlay"></span></span><span class="gourd" style="width:${74 - i * 3}%"></span><span class="ring"></span></button>`;
  }).join('');
  const keys = [...box.querySelectorAll('.key')];
  // the two cords that hold the keys run through each key's holes (14% and 58% down the slat)
  const cords = () => {
    const r0 = box.getBoundingClientRect(), lines = [[], []];
    keys.forEach((k) => { const r = k.querySelector('.slat').getBoundingClientRect(); const x = r.left + r.width / 2 - r0.left; lines[0].push([x, r.top - r0.top + r.height * 0.14 + 3.5]); lines[1].push([x, r.top - r0.top + r.height * 0.58 + 3.5]); });
    box.querySelectorAll('svg.cords polyline').forEach((pl, j) => { const L = lines[j]; const a = L[0], b = L[L.length - 1]; pl.setAttribute('points', [[a[0] - 18, a[1] - 2], ...L, [b[0] + 18, b[1] - 2]].map((p) => p.join(',')).join(' ')); });
  };
  cords(); addEventListener('resize', cords); document.fonts?.ready.then(cords);
  const hit = (i, sound = true) => { const k = keys[i]; k.classList.remove('hit'); void k.offsetWidth; k.classList.add('hit'); if (sound) strike(NOTES[i]); setTimeout(() => k.classList.remove('hit'), 500); };
  box.addEventListener('pointerdown', (e) => { const k = e.target.closest('.key'); if (k) { e.preventDefault(); hit(+k.dataset.i); idle = Date.now(); } });
  box.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.key')) { e.preventDefault(); hit(+e.target.closest('.key').dataset.i); } });
  // keys are also playable from the keyboard row A S D F G H J K L while the hero is visible
  const row = 'asdfghjkl';
  addEventListener('keydown', (e) => { if (document.body.dataset.view !== 'home' || e.repeat || e.metaKey || e.ctrlKey || e.target.closest('input, select, textarea, dialog')) return; const i = row.indexOf(e.key.toLowerCase()); if (i >= 0 && box.getBoundingClientRect().bottom > 0) hit(i); });
  // a silent light-show pattern when nobody is playing (a timbila pattern in 12/8 feel)
  let idle = 0; const pattern = [0, 2, 4, 2, 5, 4, 2, 4, 7, 5, 4, 2];
  let step = 0;
  if (!reduced) setInterval(() => {
    if (Date.now() - idle < 6000 || document.hidden || document.body.dataset.view !== 'home') return;
    const k = keys[pattern[step++ % pattern.length]]; k.classList.add('glow'); setTimeout(() => k.classList.remove('glow'), 380);
  }, 420);
})();

/* ---------- tool deck ---------- */
const TOOLS = {
  vocals: { icon: 'voice', c: '--voice', title: 'Drop a song to remove the vocals', text: 'Get a clean instrumental for karaoke and a separate vocal track, then mix them your way.', pick: 'Choose a song', quality: true, accept: 'audio/*,video/*' },
  stems: { icon: 'stems', c: '--drums', title: 'Drop a song to split it into stems', text: 'Vocals, drums, bass and everything else on their own tracks, with each instrument recognised.', pick: 'Choose a song', quality: true, accept: 'audio/*,video/*' },
  clean: { icon: 'clean', c: '--other', title: 'Drop a noisy recording', text: 'Take hum, hiss and background noise out of voice notes, podcasts, interviews and old recordings.', pick: 'Choose a recording', accept: 'audio/*,video/*' },
  convert: { icon: 'convert', c: '--bass', title: 'Drop files to convert', text: 'Turn any audio or video file into WAV, MP3, FLAC, M4A, OGG or AIFF, or pull the sound out of a video.', pick: 'Choose files', accept: 'audio/*,video/*', multiple: true },
};
let tool = 'vocals', quality = 'fast';
function fine() {
  const m = plans.maxMinutes();
  return {
    vocals: `MP3, WAV, FLAC, M4A, OGG, AAC and more · up to ${m} minutes`,
    stems: plans.has('stems') ? `Up to ${m} minutes · first run downloads about 90 MB of AI models` : 'Listen to all four stems free · downloading drums, bass and other is part of Plus',
    clean: plans.has('clean') ? `Audio or video · up to ${m} minutes` : 'Clean and compare for free · download the result with Pro',
    convert: plans.has('batch') ? 'Audio or video · as many files as you like' : 'One file at a time free · many at once with Pro',
  }[tool];
}
function selectTool(t, focus) {
  tool = t; const T = TOOLS[t];
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tool === t));
  moveInd();
  $('dzIco').style.setProperty('--c', `var(${T.c})`); $('dzIco').innerHTML = `<svg><use href="#i-${T.icon}"/></svg>`;
  $('dzTitle').textContent = T.title; $('dzText').textContent = T.text; $('pickLbl').textContent = T.pick;
  $('qualSeg').hidden = !T.quality;
  $('file').accept = T.accept; $('file').multiple = !!T.multiple;
  syncTool();
  if (focus) $('drop').focus({ preventScroll: true });
}
function syncTool() {
  $('dzFine').textContent = fine();
  $('qualSeg').querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', b.dataset.q === quality); const tg = b.querySelector('.tag'); if (tg) tg.hidden = plans.has('studio'); });
}
function moveInd() {
  const sel = document.querySelector('.tab[aria-selected="true"]'), ind = $('tabInd'); if (!sel) return;
  ind.style.width = `${sel.offsetWidth}px`; ind.style.transform = `translateX(${sel.offsetLeft - 4}px)`;
}
addEventListener('resize', moveInd);
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => selectTool(b.dataset.tool)));
$('qualSeg').onclick = (e) => {
  e.stopPropagation(); const b = e.target.closest('[data-q]'); if (!b) return;
  const set = () => { quality = b.dataset.q; syncTool(); };
  b.dataset.q === 'studio' ? gate('studio', set) : set();
};
$('pick').onclick = (e) => { e.stopPropagation(); $('file').click(); };
$('drop').onclick = (e) => { if (!e.target.closest('.seg')) $('file').click(); };
$('drop').onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === $('drop')) { e.preventDefault(); $('file').click(); } };
$('file').onchange = () => { const fs = [...$('file').files]; $('file').value = ''; if (fs.length) open(fs); };
$('vAdd').onclick = () => { $('file').accept = TOOLS.convert.accept; $('file').multiple = true; tool = 'convert'; $('file').click(); };
document.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', () => selectTool(a.dataset.goto)));
$('heroCta').addEventListener('click', () => selectTool('vocals'));

let dragDepth = 0;
addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); dragDepth++; $('drop').classList.add('over'); });
addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('over'); } });
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop').classList.remove('over');
  const fs = [...(e.dataTransfer?.files || [])]; if (!fs.length || $('sheet').open) return;
  if (document.body.dataset.view === 'convert') convert.add(fs); else open(fs);
});

/* ---------- views ---------- */
function show(view) {
  document.body.dataset.view = view;
  $('home').hidden = view !== 'home';
  ['studio', 'clean', 'convert'].forEach((v) => ($(v).hidden = v !== view));
  scrollTo({ top: 0, behavior: 'auto' });
}
function open(files) {
  if (tool === 'convert') { const already = document.body.dataset.view === 'convert'; show('convert'); already ? convert.add(files) : convert.start(files); return; }
  const f = files[0];
  if (files.length > 1) toast('One file at a time here: using the first one');
  clean.stop(); studio.stop();
  if (tool === 'clean') { show('clean'); clean.start(f); }
  else { show('studio'); studio.start(f, { stems: tool === 'stems', quality }); }
}
function home() {
  studio.stop(); clean.stop(); convert.stop();
  show('home'); selectTool(tool); requestAnimationFrame(() => { moveInd(); $('tools').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }); });
}
studio.init({ exit: home }); clean.init({ exit: home }); convert.init({ exit: home });
$('cNew').onclick = () => { tool = 'clean'; $('file').accept = TOOLS.clean.accept; $('file').multiple = false; $('file').click(); };
$('newSong').onclick = () => { $('file').accept = TOOLS[tool].accept; $('file').multiple = false; $('file').click(); };
$('backBtn').onclick = home;
$('brand').onclick = (e) => { e.preventDefault(); if (document.body.dataset.view !== 'home') home(); else scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); };
addEventListener('beforeunload', (e) => { if (studio.busy()) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- reveal on scroll ---------- */
try {
  const io = new IntersectionObserver((es) => es.forEach((x) => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } }), { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.rv').forEach((el, i) => { el.style.transitionDelay = `${(i % 3) * 80}ms`; io.observe(el); });
} catch { document.querySelectorAll('.rv').forEach((el) => el.classList.add('in')); }

show('home'); selectTool('vocals'); syncPlan();
requestAnimationFrame(moveInd);
document.fonts?.ready.then(moveInd);
