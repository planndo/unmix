// Clean audio: hum removal, spectral hiss/noise reduction and RNNoise voice denoise, with A/B listening.
import { decodeFile, encodeAudio, saveFiles, fmtTime as fmt, baseName, FORMATS } from './io.js';
import * as plans from './plans.js';
import { $, css, toast, keybar, gate, openSheet, formatPicker, icon, sleep, fitCanvas } from './ui.js';

const SR = 48000;
const C = { name: '', orig: null, out: null, dur: 0, running: false, worker: null, dirty: false, mono: false, report: null };
const setBar = keybar($('cKeybar'));
const fmtPick = formatPicker($('cFmt'), { value: 'wav', onChange: () => buildDl() });
let onExit = () => {};
export function init({ exit }) { onExit = exit; }

const PRESETS = [
  ['Auto', 'Hum and steady noise', { hum: true, hiss: 50, voice: 0 }],
  ['Podcast or voice note', 'Speech in front', { hum: true, hiss: 40, voice: 100 }],
  ['Noisy place', 'Traffic, fans, chatter', { hum: true, hiss: 65, voice: 100 }],
  ['Music recording', 'Hiss and hum only', { hum: true, hiss: 45, voice: 0 }],
  ['Gentle', 'Just take the edge off', { hum: true, hiss: 25, voice: 0 }],
];
$('cPresets').innerHTML = PRESETS.map(([n, s], i) => `<button type="button" class="chip" data-i="${i}" aria-pressed="${i === 0}">${n}<small>${s}</small></button>`).join('');
$('cPresets').onclick = (e) => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  const o = PRESETS[+b.dataset.i][2]; $('cHum').checked = o.hum; $('cHiss').value = o.hiss; $('cVoice').value = o.voice;
  document.querySelectorAll('#cPresets .chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
  syncOpts(); markDirty();
};
function syncOpts() {
  const h = +$('cHiss').value, v = +$('cVoice').value;
  $('cHissO').textContent = h ? `${h}%` : 'Off'; $('cVoiceO').textContent = v ? `${v}%` : 'Off';
  $('cHiss').style.setProperty('--p', `${h}%`); $('cVoice').style.setProperty('--p', `${v}%`);
}
const touched = () => { document.querySelectorAll('#cPresets .chip').forEach((x) => x.setAttribute('aria-pressed', 'false')); syncOpts(); markDirty(); };
['cHiss', 'cVoice'].forEach((id) => ($(id).oninput = touched)); $('cHum').onchange = touched;
function markDirty() { C.dirty = true; if (C.orig && !C.running) { $('cRun').disabled = false; $('cRun').querySelector('span').textContent = C.out ? 'Apply changes' : 'Clean it'; } }
syncOpts();

export async function start(file) {
  stop();
  C.name = baseName(file.name); $('cName').textContent = C.name; $('cMeta').innerHTML = '';
  $('cStatus').hidden = false; $('cStatus').classList.remove('error'); $('cPhase').textContent = 'Reading audio'; $('cEta').textContent = ''; setBar(0);
  $('cRun').disabled = true; $('cStats').hidden = true; $('cB').disabled = true; setAB('a'); $('cPlay').disabled = true; buildDl();
  try {
    const dec = await decodeFile(file, SR, { onStatus: (s) => ($('cPhase').textContent = s) });
    const [L, R] = dec.channels; C.dur = L.length / SR;
    if (C.dur < 0.5) throw new Error('This file is shorter than half a second.');
    const limit = Math.max(plans.maxMinutes(), plans.has('clean') ? 0 : plans.PLAN.free.minutes);
    if (C.dur / 60 > limit) {
      const minutes = Math.ceil(C.dur / 60);
      if (C.dur / 60 > plans.PLAN.pro.minutes) throw new Error(`This file is ${minutes} minutes long. Timbila cleans up to ${plans.PLAN.pro.minutes} minutes at a time.`);
      openSheet('length', { tier: 'pro', minutes, then: () => start(file) });
      throw new Error(`This file is ${minutes} minutes long, more than ${plans.PLAN[plans.tier()].name} handles.`);
    }
    C.mono = isMono(L, R); C.orig = [L, R]; C.out = null;
    addMeta(fmt(C.dur)); addMeta(C.mono ? 'Mono' : 'Stereo'); addMeta('48 kHz');
    $('cDur').textContent = fmt(C.dur); player.load(); $('cPlay').disabled = false; draw();
    await run();
  } catch (e) {
    console.error(e);
    $('cStatus').hidden = false; $('cStatus').classList.add('error');
    $('cPhase').textContent = /decode|could not be converted/i.test(String(e?.message || e)) ? 'This file could not be read as audio.' : e.message || String(e);
  }
}
function addMeta(t) { const s = document.createElement('span'); s.className = 'pill mono'; s.textContent = t; $('cMeta').append(s); }
function isMono(L, R) { for (let i = 0; i < L.length; i += 97) if (Math.abs(L[i] - R[i]) > 1e-5) return false; return true; }
$('cRun').onclick = () => run();
$('cNew').onclick = () => onExit();

async function run() {
  if (!C.orig || C.running) return;
  const options = { hum: $('cHum').checked, hiss: +$('cHiss').value / 100, voice: +$('cVoice').value / 100 };
  if (!options.hum && !options.hiss && !options.voice) { toast('Switch on at least one kind of cleaning'); return; }
  C.running = true; C.dirty = false; $('cRun').disabled = true; $('cRun').querySelector('span').textContent = 'Cleaning…';
  $('cStatus').hidden = false; $('cStatus').classList.remove('error'); setBar(0);
  $('cPhase').textContent = options.voice ? 'Loading the voice AI and cleaning' : 'Cleaning'; $('cEta').textContent = '';
  const t0 = performance.now();
  try {
    const src = C.mono ? [C.orig[0].slice()] : C.orig.map((c) => c.slice());
    const r = await new Promise((resolve, reject) => {
      const w = new Worker(new URL('../clean-worker.js', import.meta.url), { type: 'module' }); C.worker = w;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { setBar(m.value); const el = (performance.now() - t0) / 1000; if (m.value > 0.04) $('cEta').textContent = `about ${fmt(el / m.value - el)} left`; }
        else if (m.type === 'done') { w.terminate(); resolve(m); }
        else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The cleaner failed to start')); };
      w.postMessage({ type: 'clean', channels: src, options }, src.map((c) => c.buffer));
    });
    C.worker = null;
    C.out = C.mono ? [r.channels[0], r.channels[0]] : r.channels; C.report = r.report;
    setBar(1); $('cStatus').hidden = true;
    const before = noiseFloor(C.orig[0]), after = noiseFloor(C.out[0]);
    const drop = before - after;
    $('cStats').hidden = false;
    $('cStats').innerHTML = `
      <div><b>${!isFinite(drop) || drop > 40 ? 'Over 40 dB' : drop > 0.3 ? `−${drop.toFixed(1)} dB` : 'Clean'}</b><span>${!isFinite(drop) || drop > 0.3 ? 'Less background noise' : 'Little noise found'}</span></div>
      <div><b>${r.report.hum ? `${r.report.hum} Hz` : options.hum ? 'None' : 'Off'}</b><span>${r.report.hum ? 'Hum removed' : 'Mains hum'}</span></div>
      <div><b>${secs((performance.now() - t0) / 1000)}</b><span>Processing time</span></div>`;
    player.load(); $('cB').disabled = false; setAB('b'); draw(); buildDl();
    $('cRun').querySelector('span').textContent = 'Cleaned with these settings';
    toast(plans.has('clean') ? 'Cleaned. Switch between A and B to compare.' : 'Cleaned. Listen to the difference, then download with Pro.');
  } catch (e) {
    if (e?.name !== 'AbortError') { console.error(e); $('cStatus').classList.add('error'); $('cPhase').textContent = `Cleaning stopped: ${e.message || e}`; }
  } finally { C.running = false; $('cRun').disabled = !C.dirty; if (C.dirty) $('cRun').querySelector('span').textContent = 'Apply changes'; }
}
const secs = (s) => (s < 60 ? `${s.toFixed(1)} s` : fmt(s));
// 10th percentile of 50 ms RMS frames (in dB) that are not digital silence.
function noiseFloor(x) {
  const N = 2400, v = [];
  for (let s = 0; s + N <= x.length; s += N) { let e = 0; for (let i = s; i < s + N; i += 2) e += x[i] * x[i]; e /= N / 2; if (e > 1e-12) v.push(10 * Math.log10(e)); }
  if (!v.length) return -Infinity; v.sort((a, b) => a - b); return v[Math.floor(v.length * 0.1)];
}
export function stop() {
  try { C.worker?.terminate(); } catch {} C.worker = null; C.running = false;
  player.stop(); player.unload(); C.orig = C.out = null;
}

/* ---------- A/B player ---------- */
let side = 'a';
function setAB(s) {
  side = s === 'b' && C.out ? 'b' : 'a';
  $('cA').setAttribute('aria-pressed', side === 'a'); $('cB').setAttribute('aria-pressed', side === 'b');
  player.apply(); draw();
}
$('cA').onclick = () => setAB('a'); $('cB').onclick = () => setAB('b');
const player = {
  ac: null, bufs: {}, gains: {}, srcs: [], playing: false, offset: 0, startedAt: 0,
  load() {
    if (!this.ac) this.ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    const was = this.playing, t = this.pos(); this.stop();
    const mk = (ch) => { const b = this.ac.createBuffer(2, ch[0].length, SR); b.copyToChannel(ch[0], 0); b.copyToChannel(ch[1], 1); return b; };
    this.bufs = { a: mk(C.orig) }; if (C.out) this.bufs.b = mk(C.out);
    this.offset = t; if (was) this.play();
  },
  unload() { this.bufs = {}; this.offset = 0; },
  apply() { for (const k in this.gains) this.gains[k].gain.setTargetAtTime(k === side ? 1 : 0, this.ac.currentTime, 0.015); },
  pos() { return this.playing ? Math.min(C.dur, this.ac.currentTime - this.startedAt) : this.offset; },
  async play() {
    if (!this.bufs.a) return; await this.ac.resume();
    if (this.offset >= C.dur - 0.05) this.offset = 0;
    const when = this.ac.currentTime + 0.03; this.gains = {};
    this.srcs = Object.entries(this.bufs).map(([k, b]) => {
      const s = this.ac.createBufferSource(), g = this.ac.createGain(); s.buffer = b; g.gain.value = k === side ? 1 : 0;
      s.connect(g); g.connect(this.ac.destination); this.gains[k] = g; s.start(when, this.offset); return s;
    });
    this.srcs[0].onended = () => { if (this.playing) { this.playing = false; this.offset = 0; ui(); draw(); } };
    this.startedAt = when - this.offset; this.playing = true; ui(); loop();
  },
  stop() { for (const s of this.srcs) { try { s.onended = null; s.stop(); } catch {} } this.srcs = []; if (this.playing) this.offset = this.pos(); this.playing = false; ui(); },
  seek(t) { const was = this.playing; this.stop(); this.offset = Math.max(0, Math.min(C.dur - 0.01, t)); if (was) this.play(); else draw(); },
};
function ui() { $('cPlay').setAttribute('aria-label', player.playing ? 'Pause' : 'Play'); $('cPlayIco').innerHTML = `<use href="#i-${player.playing ? 'pause' : 'play'}"/>`; }
function loop() { draw(); if (player.playing) requestAnimationFrame(loop); }
$('cPlay').onclick = () => (player.playing ? player.stop() : player.play());
$('cWave').addEventListener('click', (e) => { if (!C.orig) return; const r = e.currentTarget.getBoundingClientRect(); player.seek(((e.clientX - r.left) / r.width) * C.dur); });
addEventListener('keydown', (e) => {
  if ($('clean').hidden || !C.orig || $('sheet').open || e.target.closest('input:not([type=range]), select, textarea')) return;
  if (e.key === 'a' || e.key === 'A') setAB('a');
  else if (e.key === 'b' || e.key === 'B') setAB('b');
  else if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); $('cPlay').click(); }
});

// Envelope view: original as a ghost, cleaned on top in colour; the side you hear is brighter.
const peaksCache = new WeakMap();
function peaks(x, bins) {
  let p = peaksCache.get(x); if (p && p.length === bins) return p;
  p = new Float32Array(bins); const per = x.length / bins;
  for (let b = 0; b < bins; b++) { let m = 0; const s0 = Math.floor(b * per), s1 = Math.min(x.length, Math.floor((b + 1) * per)), st = Math.max(1, ((s1 - s0) / 200) | 0); for (let i = s0; i < s1; i += st) { const v = Math.abs(x[i]); if (v > m) m = v; } p[b] = m; }
  peaksCache.set(x, p); return p;
}
export function draw() {
  const f = fitCanvas($('cCv')); if (!f) return; const { ctx, w, h } = f;
  $('cNow').textContent = fmt(player.pos());
  if (!C.orig) return;
  const bins = Math.floor(w / 3), mid = h / 2, scale = (h - 20) / 2;
  const pa = peaks(C.orig[0], bins), pb = C.out ? peaks(C.out[0], bins) : null;
  const pos = player.pos() / C.dur;
  for (let i = 0; i < bins; i++) {
    const x = i * 3;
    const ha = Math.max(1, Math.min(1, pa[i] * 1.4) * scale);
    ctx.fillStyle = side === 'a' ? css('--muted') : css('--ghost'); ctx.globalAlpha = side === 'a' ? (i / bins <= pos ? 0.9 : 0.45) : 1;
    ctx.fillRect(x, mid - ha, 2, ha * 2);
    if (pb) { const hb = Math.max(1, Math.min(1, pb[i] * 1.4) * scale); ctx.fillStyle = css('--other'); ctx.globalAlpha = side === 'b' ? (i / bins <= pos ? 1 : 0.55) : 0.35; ctx.fillRect(x, mid - hb, 2, hb * 2); }
  }
  ctx.globalAlpha = 1;
  $('cPh').style.left = `${pos * w}px`;
}
addEventListener('resize', () => { if (!$('clean').hidden) draw(); });

/* ---------- download ---------- */
function buildDl() {
  const box = $('cDl'), f = fmtPick.get(), locked = !plans.has('clean');
  box.innerHTML = '';
  const b = document.createElement('button'); b.type = 'button'; b.className = 'wide';
  b.innerHTML = `<span>Download cleaned ${FORMATS[f].label}</span>${locked ? `<span class="tag pro" style="color:var(--bg);border-color:var(--bg)">${icon('lock')}Pro</span>` : ''}`;
  b.disabled = !C.out;
  b.onclick = () => gate('clean', async () => {
    const lbl = b.querySelector('span'), old = lbl.textContent; b.disabled = true; lbl.textContent = 'Preparing…';
    try {
      let peak = 0; for (const c of C.out) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
      const blob = await encodeAudio(C.out[0], C.out[1], SR, f, { gain: peak > 0.999 ? 0.999 / peak : 1 });
      await saveFiles([[`${C.name} (cleaned).${FORMATS[f].ext}`, blob]], `${C.name} (cleaned)`); toast('Download ready');
    } catch (e) { if (e?.code === 'declined') toast('Download cancelled'); else toast(`Could not save the file: ${e?.message || e}`); }
    finally { lbl.textContent = old; b.disabled = false; }
  });
  box.append(b);
  if (locked) { const p = document.createElement('p'); p.className = 'hint'; p.style.gridColumn = '1 / -1'; p.textContent = 'Cleaning and listening are free. Downloading the cleaned file is part of Pro ($9 once).'; box.append(p); }
}
plans.onChange(buildDl);
