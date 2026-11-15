// Studio: vocal remover (2 stems) and stem splitter (4 stems), with mixer, Focus EQ, Auto-mix and export.
import * as sep from '../separator.js';
import { detectInstruments } from '../instruments.js';
import { computePeaks, blockPowers, lufsFromPowers, estimateBpm } from '../audio-utils.js';
import { decodeFile, encodeAudio, saveFiles, fmtTime as fmt, baseName, FORMATS } from './io.js';
import * as plans from './plans.js';
import { $, css, reduced, toast, keybar, gate, openSheet, formatPicker, icon, sleep, esc } from './ui.js';

const SR = 44100, BINS = 1600;
const STEMS = {
  voice: { label: 'Vocals', color: '--voice' },
  music: { label: 'Instrumental', color: '--music' },
  drums: { label: 'Drums', color: '--drums' },
  bass:  { label: 'Bass', color: '--bass' },
  other: { label: 'Other', color: '--other' },
};
let mode = '2', onExit = () => {};
const S = { name: '', L: null, R: null, n: 0, dur: 0, order: [], stems: {}, ready: false, mixPeaks: null, bpm: null, abort: null, instruments: [] };
const setBar = keybar($('keybar'));
const fmtPick = formatPicker($('dlFmt'), { value: 'wav', onChange: () => buildDownloads() });

export function init({ exit }) { onExit = exit; }
export const busy = () => !!S.abort && !S.ready && !S.failed;

/* ---------- processing ---------- */
const PHASES = () => mode === '4'
  ? [['load', 'Load AI models'], ['decode', 'Read audio'], ['voice', 'Separate vocals'], ['drums', 'Isolate drums'], ['bass', 'Isolate bass'], ['tag', 'Identify instruments'], ['finish', 'Analyse mix']]
  : [['load', 'Load AI model'], ['decode', 'Read audio'], ['voice', 'Separate vocals'], ['tag', 'Identify instruments'], ['finish', 'Analyse mix']];
function setPhase(key, label) {
  $('phase').textContent = label;
  const idx = PHASES().findIndex((p) => p[0] === key);
  [...$('steps').children].forEach((li, i) => { li.className = i < idx ? 'ok' : i === idx ? 'on' : ''; });
}

export async function start(file, { stems = false, quality = 'fast' } = {}) {
  stop();
  mode = stems ? '4' : '2';
  const vKey = quality === 'studio' && plans.has('studio') ? 'vocals' : 'vocalsFast';
  S.name = baseName(file.name); S.ready = false; S.failed = false; S.stems = {}; S.bpm = null; S.instruments = []; S.inst = null;
  S.order = mode === '4' ? ['voice', 'drums', 'bass', 'other'] : ['voice', 'music'];
  S.eqStem = mode === '4' ? 'other' : 'music';
  $('sKicker').textContent = mode === '4' ? 'Split stems' : 'Remove vocals';
  $('songName').textContent = S.name; $('meta').innerHTML = ''; $('status').classList.remove('error'); $('statusActions').hidden = true; $('status').hidden = false;
  $('steps').innerHTML = PHASES().map((p) => `<li>${p[1]}</li>`).join('');
  $('engine').textContent = ''; $('eta').textContent = ''; setBar(0); setControlsEnabled(false);
  buildLanes(); buildPanels(); renderInstruments();
  const abort = new AbortController(); S.abort = abort; const t0 = performance.now();
  const check = () => { if (abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  try {
    const keys = mode === '4' ? [vKey, 'drums', 'bass', 'tagger'] : [vKey, 'tagger'];
    setPhase('decode', 'Reading audio');
    const dec = await decodeFile(file, SR, { onStatus: (s) => setPhase('decode', s) }); check();
    S.L = dec.channels[0]; S.R = dec.channels[1]; S.n = S.L.length; S.dur = S.n / SR;
    if (S.dur < 1) throw new Error('This file is shorter than one second.');
    const minutes = Math.ceil(S.dur / 60 - 0.05);
    if (S.dur / 60 > plans.maxMinutes()) {
      const need = S.dur / 60 <= plans.PLAN.plus.minutes ? 'plus' : 'pro';
      if (S.dur / 60 > plans.PLAN.pro.minutes) throw new Error(`This file is ${minutes} minutes long. Timbila handles up to ${plans.PLAN.pro.minutes} minutes; try trimming it first.`);
      S.abort = null; openSheet('length', { tier: need, minutes, then: () => start(file, { stems, quality }) });
      fail(`This song is ${minutes} minutes long, which is more than ${plans.PLAN[plans.tier()].name} handles.`, true);
      return;
    }
    S.mixPeaks = computePeaks(S.L, S.R, BINS);
    for (const k of S.order) S.stems[k] = { L: new Float32Array(S.n), R: new Float32Array(S.n), peaks: new Float32Array(BINS), filled: 0, gain: 1, mute: false, solo: false, lufs: null };
    $('tDur').textContent = fmt(S.dur); addMeta(fmt(S.dur)); addMeta(vKey === 'vocals' ? 'Studio model' : 'Fast model'); drawAll();

    const need = await sep.downloadSize(keys);
    setPhase('load', need > 0 ? `Downloading the AI (${(need / 1e6).toFixed(0)} MB, only the first time)` : 'Loading the AI');
    await sep.prepare(keys, (got, total) => { setBar(got / total); if (need > 0) $('eta').textContent = `${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`; });
    check(); $('eta').textContent = 'Starting…'; setBar(0);

    // one bar for all model passes, weighted by the work each one does
    const M = sep.MODELS, chunks = (k) => Math.ceil(S.n / (M[k].hop * (M[k].dimT - 1) - M[k].nFft));
    const cost = { [vKey]: vKey === 'vocals' ? 2.8 : 1, drums: 0.8, bass: 0.8 };
    const work = (k) => chunks(k) * cost[k];
    const totalWork = work(vKey) + (mode === '4' ? work('drums') + work('bass') : 0); let doneWork = 0;
    const onChunk = (stemKey, mk) => (c) => {
      const per = cost[mk];
      setBar((doneWork + c.done * per) / totalWork);
      const msPer = c.elapsed / c.done / per, left = (totalWork - doneWork - c.done * per) * msPer;
      $('eta').textContent = `about ${fmt(left / 1000)} left`;
      $('engine').textContent = sep.lastBackend === 'gpu' ? 'Running on your graphics card' : `Running on your processor · ${c.workers * sep.lastThreads} threads`;
      fill(stemKey, c.start, c.end);
    };

    setPhase('voice', 'Separating the vocals from the music');
    const v = await sep.runStem(vKey, S.L, S.R, { signal: abort.signal, onChunk: onChunk('voice', vKey), preferGpu: true });
    S.stems.voice.L = v.L; S.stems.voice.R = v.R; doneWork += work(vKey);
    const iL = new Float32Array(S.n), iR = new Float32Array(S.n);
    for (let i = 0; i < S.n; i++) { iL[i] = S.L[i] - v.L[i]; iR[i] = S.R[i] - v.R[i]; }
    if (mode === '2') { S.stems.music.L = iL; S.stems.music.R = iR; }
    else {
      S.inst = { L: iL, R: iR };
      setPhase('drums', 'Isolating the drums');
      const d = await sep.runStem('drums', iL, iR, { signal: abort.signal, onChunk: onChunk('drums', 'drums') });
      S.stems.drums.L = d.L; S.stems.drums.R = d.R; doneWork += work('drums');
      setPhase('bass', 'Isolating the bass');
      const b = await sep.runStem('bass', iL, iR, { signal: abort.signal, onChunk: onChunk('bass', 'bass') });
      S.stems.bass.L = b.L; S.stems.bass.R = b.R; doneWork += work('bass');
      const o = S.stems.other; for (let i = 0; i < S.n; i++) { o.L[i] = iL[i] - d.L[i] - b.L[i]; o.R[i] = iR[i] - d.R[i] - b.R[i]; }
    }
    check();
    setPhase('tag', 'Listening for instruments'); $('eta').textContent = '';
    try { S.instruments = await detectInstruments(S.stems[S.eqStem], SR, sep.runTagger); S.instruments.forEach((x) => (x.db = 0)); }
    catch (e) { console.warn('[timbila] instrument recognition failed', e); }
    check();
    setPhase('finish', 'Measuring loudness and tempo');
    await sleep(30);
    for (const k of S.order) { const s = S.stems[k]; computePeaks(s.L, s.R, BINS, s.peaks); s.filled = S.n; s.lufs = lufsFromPowers(blockPowers(s.L, s.R)); }
    S.mixLufs = lufsFromPowers(blockPowers(S.L, S.R));
    const rhythm = mode === '4' ? S.stems.drums : S.stems.music; S.bpm = estimateBpm(rhythm.L, rhythm.R);
    if (S.bpm) addMeta(`≈ ${S.bpm} BPM`);
    addMeta(`${S.order.length} stems`);
    setBar(1);
    await player.load(); check();
    S.ready = true; S.abort = null; renderInstruments(); setControlsEnabled(true); drawAll(); renderMeters(); buildDownloads();
    $('status').hidden = true;
    toast(`Separated in ${fmt((performance.now() - t0) / 1000)} on your ${sep.lastBackend === 'gpu' ? 'graphics card' : 'processor'}. Press play.`);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    fail(/decode|EncodingError|Unable to decode|could not be converted/i.test(String(err?.message || err)) ? 'This file could not be read as audio. Try an MP3, WAV, FLAC or M4A file.' : `Separation stopped: ${err.message || err}`);
  }
}
function fail(msg, soft) {
  S.failed = true; S.abort = null;
  $('status').hidden = false; $('status').classList.toggle('error', !soft);
  $('phase').textContent = msg; $('eta').textContent = '';
  $('statusActions').hidden = false; $('statusActions').innerHTML = '';
  const again = document.createElement('button'); again.className = 'btn ghost sm'; again.textContent = 'Choose another file'; again.onclick = () => onExit(); $('statusActions').append(again);
}
function addMeta(txt) { const s = document.createElement('span'); s.className = 'pill mono'; s.textContent = txt; $('meta').append(s); }
function fill(key, a, b) {
  const s = S.stems[key]; if (!s) return; computePeaks(s.L, s.R, BINS, s.peaks, a, b); s.filled = Math.max(s.filled, b);
  if (key === 'voice' && S.stems.music) { // the instrumental appears alongside the vocal while the model works
    const m = S.stems.music; for (let i = a; i < b; i++) { m.L[i] = S.L[i] - s.L[i]; m.R[i] = S.R[i] - s.R[i]; }
    computePeaks(m.L, m.R, BINS, m.peaks, a, b); m.filled = s.filled;
  }
  drawLane(key); if (key === 'voice' && S.stems.music) drawLane('music');
}
// Stop work and free every buffer (audio for a long song is hundreds of MB).
export function stop() {
  S.abort?.abort(); S.abort = null; stopPlayback(); player.unload();
  S.stems = {}; S.L = S.R = null; S.inst = null; S.mixPeaks = null; S.ready = false; S.n = 0; S.dur = 0;
}
$('newSong').onclick = () => onExit();

/* ---------- lanes ---------- */
function buildLanes() {
  const lanes = $('lanes'); lanes.querySelectorAll('.lane, .loopzone').forEach((n) => n.remove());
  S.order.forEach((k, i) => {
    const st = STEMS[k]; const el = document.createElement('div'); el.className = 'lane'; el.style.setProperty('--c', `var(${st.color})`); el.dataset.k = k;
    el.innerHTML = `
      <div class="ctrl">
        <div class="name"><i></i>${st.label}<span class="lu" id="lu-${k}"></span></div>
        <div class="knobs">
          <button class="sq s" type="button" aria-pressed="false" title="Solo ${st.label} (${i + 1})" id="s-${k}">S</button>
          <button class="sq m" type="button" aria-pressed="false" title="Mute ${st.label}" id="m-${k}">M</button>
          <div class="vol"><input type="range" id="g-${k}" min="0" max="200" value="100" step="1" aria-label="${st.label} volume" disabled><output id="o-${k}">100%</output></div>
        </div>
      </div>
      <div class="wave" id="w-${k}"><canvas id="c-${k}"></canvas></div>`;
    lanes.append(el);
    const g = $(`g-${k}`);
    g.oninput = () => { setGain(k, g.value / 100, false); manualTouched(); if (!$('autoPane').hidden) renderMeters(); };
    $(`s-${k}`).onclick = () => { S.stems[k].solo = !S.stems[k].solo; syncStem(k); player.apply(); };
    $(`m-${k}`).onclick = () => { S.stems[k].mute = !S.stems[k].mute; syncStem(k); player.apply(); };
    $(`w-${k}`).addEventListener('click', (e) => { if (!S.ready) return; const r = e.currentTarget.getBoundingClientRect(); player.seek(((e.clientX - r.left) / r.width) * S.dur); });
  });
  requestAnimationFrame(drawAll);
}
function setGain(k, v, animate) {
  const s = S.stems[k]; if (!s) return;
  if (animate && !reduced) { const from = s.gain, t0 = performance.now(); const step = (now) => { if (S.stems[k] !== s) return; const u = Math.min(1, (now - t0) / 650), e = 1 - Math.pow(1 - u, 3); s.gain = from + (v - from) * e; syncStem(k); player.apply(); if (u < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); }
  else { s.gain = v; syncStem(k); player.apply(); }
}
function syncStem(k) {
  const s = S.stems[k]; const g = $(`g-${k}`); if (!g || !s) return;
  g.value = Math.round(s.gain * 100); g.style.setProperty('--p', `${s.gain * 50}%`);
  $(`o-${k}`).textContent = s.gain === 0 ? 'off' : `${Math.round(s.gain * 100)}%`;
  $(`s-${k}`).setAttribute('aria-pressed', s.solo); $(`m-${k}`).setAttribute('aria-pressed', s.mute);
  const lu = $(`lu-${k}`); if (lu && s.lufs != null) lu.textContent = isFinite(s.lufs) ? `${s.lufs.toFixed(1)} LUFS` : 'silent';
  drawLane(k);
}
function effGain(k) { const s = S.stems[k], anySolo = S.order.some((x) => S.stems[x]?.solo); if (!s || s.mute || (anySolo && !s.solo)) return 0; return s.gain; }
function setControlsEnabled(on) {
  ['play', 'scrub', 'loopBtn'].forEach((id) => { $(id).disabled = !on; });
  S.order.forEach((k) => { const g = $(`g-${k}`); if (g) g.disabled = !on; });
  document.querySelectorAll('#presets button, #goals button, #dl button').forEach((b) => (b.disabled = !on));
  $('playhead').hidden = !on;
}

function drawAll() { for (const k of S.order) drawLane(k); drawRuler(); }
function drawLane(k) {
  const cv = $(`c-${k}`), s = S.stems[k]; if (!cv) return;
  const w = cv.clientWidth, h = cv.clientHeight, d = devicePixelRatio || 1; if (!w || !h) return;
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
  const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, w, h);
  const color = css(STEMS[k].color), ghost = css('--ghost'), mid = h / 2;
  const pos = player.pos() / (S.dur || 1), filledFrac = s ? s.filled / (S.n || 1) : 0;
  const eg = s && S.ready ? effGain(k) : 1;
  const bar = 3, gap = 2, cols = Math.floor(w / (bar + gap));
  for (let c = 0; c < cols; c++) {
    const u = c / cols, b = Math.floor(u * BINS);
    if (u < filledFrac && s) {
      const amp = Math.min(1, s.peaks[b] * 1.6 * Math.min(eg, 1.6));
      const hh = Math.max(1.5, amp * (h - 16) / 2);
      ctx.fillStyle = color; ctx.globalAlpha = eg === 0 ? 0.13 : u <= pos ? 1 : 0.5;
      ctx.fillRect(c * (bar + gap), mid - hh, bar, hh * 2);
    } else if (S.mixPeaks) {
      const hh = Math.max(1, S.mixPeaks[b] * 1.6 * (h - 16) / 2 * 0.6);
      ctx.fillStyle = ghost; ctx.globalAlpha = 1; ctx.fillRect(c * (bar + gap), mid - hh, bar, hh * 2);
    }
  }
  ctx.globalAlpha = 1;
  if (!S.ready && s && filledFrac > 0 && filledFrac < 1) { // glowing work front
    const x = filledFrac * w; const g = ctx.createLinearGradient(x - 40, 0, x + 2, 0); g.addColorStop(0, 'transparent'); g.addColorStop(1, color);
    ctx.fillStyle = g; ctx.globalAlpha = 0.35; ctx.fillRect(x - 40, 0, 42, h); ctx.globalAlpha = 1;
  }
}
function drawRuler() {
  const cv = $('rulerCv'); const w = cv.clientWidth, h = cv.clientHeight, d = devicePixelRatio || 1; if (!w) return;
  if (cv.width !== Math.round(w * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
  const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, w, h);
  if (!S.dur) return;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300]; const step = steps.find((s) => (s / S.dur) * w > 56) || 300;
  ctx.font = `11px ${css('--f-mono')}`; ctx.fillStyle = css('--muted'); ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
  for (let t = 0; t <= S.dur; t += step / 4) {
    const x = Math.round((t / S.dur) * w) + 0.5, major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ctx.beginPath(); ctx.moveTo(x, major ? h - 12 : h - 6); ctx.lineTo(x, h); ctx.stroke();
    if (major && x < w - 30) ctx.fillText(fmt(t), x + 4, h - 16);
  }
  const lp = player.loop; if (lp.on && lp.b > lp.a) { ctx.fillStyle = css('--ghost'); ctx.fillRect(lp.a / S.dur * w, 0, (lp.b - lp.a) / S.dur * w, h); }
}
const relayout = () => { if ($('studio').hidden) return; drawAll(); placeHead(); updateLoopUi(); };
addEventListener('resize', relayout);
try { new ResizeObserver(relayout).observe($('board')); } catch {}
export function redraw() { relayout(); }

/* ---------- playback ---------- */
const player = {
  ac: null, buffers: {}, gains: {}, eq: [], master: null, sources: [], playing: false, offset: 0, startedAt: 0, loop: { on: false, a: 0, b: 0 },
  async load() {
    if (!this.ac) this.ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    const ac = this.ac; this.unload();
    this.master = ac.createGain(); this.master.connect(ac.destination);
    for (const k of S.order) {
      const s = S.stems[k], b = ac.createBuffer(2, S.n, SR); b.copyToChannel(s.L, 0); b.copyToChannel(s.R, 1);
      this.buffers[k] = b; const g = ac.createGain(); g.connect(this.master); this.gains[k] = g;
    }
    // Focus EQ: one peaking band per recognised instrument, in series before the stem's fader
    this.eq = (S.instruments || []).map((ins) => { const f = ac.createBiquadFilter(); f.type = 'peaking'; f.frequency.value = ins.center; f.Q.value = ins.q; f.gain.value = ins.db; return f; });
    this.eq.forEach((f, i) => f.connect(this.eq[i + 1] || this.gains[S.eqStem]));
    this.offset = 0; this.loop = { on: false, a: 0, b: 0 }; updateLoopUi(); this.apply(true);
  },
  unload() {
    this.stopSources(); this.playing = false;
    try { this.master?.disconnect(); } catch {}
    Object.values(this.gains).forEach((g) => { try { g.disconnect(); } catch {} });
    this.eq.forEach((f) => { try { f.disconnect(); } catch {} });
    this.buffers = {}; this.gains = {}; this.eq = []; this.master = null; this.offset = 0;
  },
  apply(instant) {
    if (!this.ac) return;
    for (const k of S.order) { const g = this.gains[k]; if (!g) continue; const v = effGain(k);
      if (instant) g.gain.value = v; else g.gain.setTargetAtTime(v, this.ac.currentTime, 0.03); }
  },
  pos() {
    if (!this.playing || !this.ac) return this.offset;
    let t = this.ac.currentTime - this.startedAt;
    if (this.loop.on && this.loop.b > this.loop.a && t >= this.loop.b) t = this.loop.a + ((t - this.loop.a) % (this.loop.b - this.loop.a));
    return Math.min(t, S.dur);
  },
  async play() {
    if (!this.ac || !this.buffers[S.order[0]]) return; await this.ac.resume();
    if (this.offset >= S.dur - 0.05) this.offset = 0;
    if (this.loop.on && (this.offset < this.loop.a || this.offset >= this.loop.b)) this.offset = this.loop.a;
    const when = this.ac.currentTime + 0.03;
    this.sources = S.order.map((k) => { const src = this.ac.createBufferSource(); src.buffer = this.buffers[k];
      if (this.loop.on && this.loop.b > this.loop.a) { src.loop = true; src.loopStart = this.loop.a; src.loopEnd = this.loop.b; }
      src.connect(k === S.eqStem && this.eq.length ? this.eq[0] : this.gains[k]); src.start(when, this.offset); return src; });
    this.sources[0].onended = () => { if (this.playing && !this.loop.on) { this.playing = false; this.offset = 0; uiPlay(); placeHead(); drawAll(); } };
    this.startedAt = when - this.offset; this.playing = true; uiPlay(); tick();
  },
  pause() { if (!this.playing) return; this.offset = this.pos(); this.stopSources(); this.playing = false; uiPlay(); },
  stopSources() { for (const s of this.sources) { try { s.onended = null; s.stop(); } catch {} } this.sources = []; },
  seek(t) { t = Math.max(0, Math.min(S.dur - 0.01, t)); const was = this.playing; if (was) { this.stopSources(); this.playing = false; } this.offset = t; if (was) this.play(); else { placeHead(); drawAll(); } },
  restartIfPlaying() { if (this.playing) { const t = this.pos(); this.stopSources(); this.playing = false; this.offset = t; this.play(); } },
};
export function stopPlayback() { if (player.playing) player.pause(); }
function uiPlay() {
  $('play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  $('playIco').innerHTML = `<use href="#i-${player.playing ? 'pause' : 'play'}"/>`;
}
let lastDraw = 0;
function tick(now = 0) {
  placeHead();
  if (now - lastDraw > 120) { for (const k of S.order) drawLane(k); lastDraw = now; }
  if (player.playing) requestAnimationFrame(tick);
}
let scrubbing = false;
function placeHead() {
  if (!S.dur) return; const t = player.pos(); const wv = document.querySelector('#lanes .wave'); if (!wv) return;
  $('playhead').style.left = `${wv.offsetLeft + (t / S.dur) * wv.clientWidth}px`; $('tNow').textContent = fmt(t);
  if (!scrubbing) $('scrub').value = Math.round((t / S.dur) * 1000);
}
$('play').onclick = () => (player.playing ? player.pause() : player.play());
$('scrub').addEventListener('pointerdown', () => (scrubbing = true));
$('scrub').addEventListener('change', () => { scrubbing = false; player.seek(($('scrub').value / 1000) * S.dur); });
$('scrub').addEventListener('input', () => { $('tNow').textContent = fmt(($('scrub').value / 1000) * S.dur); });
(function loopOnRuler() {
  const ru = $('ruler'); let a = null, moved = false;
  const tAt = (e) => { const r = ru.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.dur; };
  ru.addEventListener('pointerdown', (e) => { if (!S.ready) return; a = tAt(e); moved = false; ru.setPointerCapture(e.pointerId); });
  ru.addEventListener('pointermove', (e) => { if (a == null) return; const b = tAt(e); if (Math.abs(b - a) > S.dur * 0.005) { moved = true; player.loop = { on: true, a: Math.min(a, b), b: Math.max(a, b) }; drawRuler(); updateLoopUi(); } });
  ru.addEventListener('pointerup', (e) => { if (a == null) return; if (!moved) player.seek(tAt(e)); else { if (player.loop.b - player.loop.a < 0.25) player.loop.on = false; updateLoopUi(); player.seek(player.loop.a); } a = null; });
})();
$('loopBtn').onclick = () => {
  const lp = player.loop;
  if (lp.b <= lp.a) { const t = player.pos(); const span = S.bpm ? (60 / S.bpm) * 8 : 8; player.loop = { on: true, a: t, b: Math.min(S.dur, t + span) }; }
  else lp.on = !lp.on;
  updateLoopUi(); drawRuler(); player.restartIfPlaying();
};
function updateLoopUi() {
  const lp = player.loop, on = lp.on && lp.b > lp.a && S.dur;
  $('loopBtn').setAttribute('aria-pressed', !!on);
  $('loopLbl').textContent = on ? `Loop ${fmt(lp.a)}–${fmt(lp.b)}` : 'Loop';
  let z = document.querySelector('#lanes .loopzone');
  const wv = document.querySelector('#lanes .wave');
  if (on && wv) {
    if (!z) { z = document.createElement('div'); z.className = 'loopzone'; $('lanes').append(z); }
    z.style.left = `${wv.offsetLeft + (lp.a / S.dur) * wv.clientWidth}px`; z.style.width = `${((lp.b - lp.a) / S.dur) * wv.clientWidth}px`;
  } else z?.remove();
}
addEventListener('keydown', (e) => {
  if (!S.ready || $('studio').hidden || $('sheet').open || e.target.closest('input[type=text], input:not([type]), select, textarea')) return;
  if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); $('play').click(); }
  else if (e.key === 'ArrowRight' && e.target.type !== 'range') player.seek(player.pos() + 5);
  else if (e.key === 'ArrowLeft' && e.target.type !== 'range') player.seek(player.pos() - 5);
  else if (/^[1-4]$/.test(e.key)) { const k = S.order[+e.key - 1]; if (k) $(`s-${k}`).click(); }
  else if (e.key === '0') { S.order.forEach((k) => { S.stems[k].solo = false; syncStem(k); }); player.apply(); }
});

/* ---------- mixer: presets and auto-mix ---------- */
const PRESETS = {
  '2': [
    ['Original', 'Everything at 100%', { voice: 1, music: 1 }],
    ['Karaoke', 'No vocals', { voice: 0, music: 1 }],
    ['Guide vocal', 'Quiet voice to sing over', { voice: 0.2, music: 1 }],
    ['A cappella', 'Vocals only', { voice: 1, music: 0 }],
    ['Vocal boost', 'Lyrics up front', { voice: 1.6, music: 0.75 }],
  ],
  '4': [
    ['Original', 'Everything at 100%', { voice: 1, drums: 1, bass: 1, other: 1 }],
    ['Karaoke', 'No vocals', { voice: 0, drums: 1, bass: 1, other: 1 }],
    ['A cappella', 'Vocals only', { voice: 1, drums: 0, bass: 0, other: 0 }],
    ['No drums', 'Play along on drums', { voice: 1, drums: 0, bass: 1, other: 1 }],
    ['No bass', 'Play along on bass', { voice: 1, drums: 1, bass: 0, other: 1 }],
    ['Rhythm section', 'Drums and bass only', { voice: 0, drums: 1, bass: 1, other: 0 }],
  ],
};
// Auto-mix goals: loudness of each stem relative to the vocal, in LU (null = off)
const GOALS = {
  '2': [
    ['Balanced', 'Radio-style vocal level', { voice: 0, music: 2.5 }],
    ['Vocal forward', 'Every word clear', { voice: 0, music: -3 }],
    ['Background vocal', 'Voice tucked into the band', { voice: 0, music: 7 }],
    ['Karaoke', 'Instrumental at full level', { voice: null, music: 0 }],
  ],
  '4': [
    ['Balanced', 'Even pop-style balance', { voice: 0, drums: -2, bass: -4, other: -2.5 }],
    ['Vocal forward', 'Lyrics on top', { voice: 0, drums: -5, bass: -7, other: -6 }],
    ['Band focus', 'Instruments carry it', { voice: 0, drums: 1, bass: -1, other: 1.5 }],
    ['Karaoke', 'Balanced band, no voice', { voice: null, drums: 0, bass: -2, other: 0 }],
    ['Drum practice', 'Groove without drums', { voice: 0, drums: null, bass: 1, other: -1 }],
    ['Bass practice', 'Kick-heavy, no bass', { voice: -2, drums: 0, bass: null, other: -3 }],
  ],
};
function buildPanels() {
  $('presets').innerHTML = ''; $('goals').innerHTML = '';
  PRESETS[mode].forEach(([name, sub, g]) => {
    const b = chip(name, sub); b.onclick = () => { S.order.forEach((k) => { S.stems[k].solo = false; S.stems[k].mute = false; setGain(k, g[k] ?? 1, true); }); pressOnly('#presets', b); };
    $('presets').append(b);
  });
  GOALS[mode].forEach(([name, sub, g]) => { const b = chip(name, sub); b.onclick = () => gate('autoMix', () => { autoMix(g); pressOnly('#goals', b); }); $('goals').append(b); });
  $('mManual').onclick = () => setMixMode('manual');
  $('mAuto').onclick = () => { setMixMode('auto'); renderMeters(); };
  setMixMode('manual'); renderMeters(); buildDownloads(); syncTags();
}
function chip(name, sub) { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.setAttribute('aria-pressed', 'false'); b.innerHTML = `${name}<small>${sub}</small>`; b.disabled = !S.ready; return b; }
function pressOnly(sel, b) { document.querySelectorAll(`${sel} .chip`).forEach((x) => x.setAttribute('aria-pressed', x === b)); }
function manualTouched() { document.querySelectorAll('#presets .chip, #goals .chip').forEach((x) => x.setAttribute('aria-pressed', 'false')); }
function setMixMode(m) { $('mManual').setAttribute('aria-pressed', m === 'manual'); $('mAuto').setAttribute('aria-pressed', m === 'auto'); $('manualPane').hidden = m !== 'manual'; $('autoPane').hidden = m !== 'auto'; }
function syncTags() {
  $('autoTag').hidden = plans.has('autoMix');
  $('instTag').hidden = plans.has('focusEq');
}

function mixLufs(gains) {
  const n = S.n, L = new Float32Array(n), R = new Float32Array(n);
  for (const k of S.order) { const g = gains[k] || 0; if (!g) continue; const s = S.stems[k]; for (let i = 0; i < n; i++) { L[i] += s.L[i] * g; R[i] += s.R[i] * g; } }
  return lufsFromPowers(blockPowers(L, R));
}
function autoMix(goal) {
  if (!S.ready) return;
  const ref = S.stems.voice.lufs; const gains = {};
  for (const k of S.order) {
    const s = S.stems[k], rel = goal[k];
    if (rel === null) { gains[k] = 0; continue; }
    if (!isFinite(s.lufs)) { gains[k] = 1; continue; }
    const base = isFinite(ref) ? ref : S.mixLufs - 6;
    gains[k] = Math.pow(10, ((base + rel) - s.lufs) / 20);
  }
  // keep the overall loudness equal to the original song, within the faders' 0–200% range
  for (let it = 0; it < 3; it++) {
    const cur = mixLufs(gains); if (!isFinite(cur)) break;
    const corr = Math.pow(10, (S.mixLufs - cur) / 20); let maxG = 0;
    for (const k in gains) { gains[k] *= corr; maxG = Math.max(maxG, gains[k]); }
    if (maxG > 2) for (const k in gains) gains[k] *= 2 / maxG;
    if (Math.abs(S.mixLufs - cur) < 0.2) break;
  }
  S.order.forEach((k) => { S.stems[k].solo = false; S.stems[k].mute = false; setGain(k, Math.min(2, gains[k]), true); });
  setTimeout(renderMeters, 700);
  const lu = mixLufs(gains); toast(`Auto-mix set · ${isFinite(lu) ? lu.toFixed(1) : '–'} LUFS (original ${S.mixLufs.toFixed(1)})`);
}
function renderMeters() {
  const box = $('meters'); box.innerHTML = '';
  if (!S.ready) { box.innerHTML = '<p class="hint">Loudness readings appear once separation finishes.</p>'; return; }
  const lo = -45, hi = -5;
  for (const k of S.order) {
    const s = S.stems[k], g = effGain(k);
    const now = isFinite(s.lufs) && g > 0 ? s.lufs + 20 * Math.log10(g) : -Infinity;
    const pct = (v) => `${Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100}%`;
    const row = document.createElement('div'); row.className = 'meter'; row.style.setProperty('--c', `var(${STEMS[k].color})`);
    row.innerHTML = `<span>${STEMS[k].label}</span><div class="trk" title="Bar: level in your mix. Tick: level in the original song."><i style="width:${isFinite(now) ? pct(now) : '0%'}"></i><b style="left:${isFinite(s.lufs) ? pct(s.lufs) : '0%'}"></b></div><output>${isFinite(now) ? now.toFixed(1) : 'off'}</output>`;
    box.append(row);
  }
  const cap = document.createElement('p'); cap.className = 'hint'; cap.style.fontSize = '12px'; cap.textContent = 'Bars show each stem\'s loudness in your mix (LUFS); the tick marks where it sat in the original.'; box.append(cap);
}

/* ---------- instruments + focus EQ ---------- */
function fmtHz(f) { return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`; }
function renderInstruments() {
  const card = $('instCard'), box = $('insts');
  const list = S.instruments || [], open = plans.has('focusEq');
  card.hidden = !S.ready;
  $('instTitle').textContent = `Instruments in “${STEMS[S.eqStem]?.label || 'Other'}”`;
  $('instReset').hidden = !open || !list.length;
  box.innerHTML = ''; box.classList.toggle('locked', !open && list.length > 0);
  if (!list.length) box.innerHTML = '<p class="hint">No other instruments stood out clearly in this stem. Its fader still controls everything in it.</p>';
  list.forEach((ins, i) => {
    const conf = ins.score >= 0.5 ? ['Clear', 'hi'] : ins.score >= 0.25 ? ['Likely', 'hi'] : ['Possible', ''];
    const el = document.createElement('div'); el.className = 'inst'; el.style.animationDelay = `${i * 70}ms`;
    el.innerHTML = `<div class="top"><b>${esc(ins.name)}</b><span class="conf ${conf[1]}" title="Recognition score ${(ins.score * 100).toFixed(0)}%">${conf[0]} · ${(ins.score * 100).toFixed(0)}%</span></div>
      <small>${ins.detail && ins.detail !== ins.name ? esc(ins.detail) + ' · ' : ''}focus around ${fmtHz(ins.center)}</small>
      <div class="vol"><input type="range" min="-24" max="6" step="1" value="${ins.db}" aria-label="${esc(ins.name)} level" ${open ? '' : 'disabled'}><output></output></div>`;
    box.append(el);
    const r = el.querySelector('input'), o = el.querySelector('output');
    const sync = () => { o.textContent = ins.db === 0 ? '0 dB' : `${ins.db > 0 ? '+' : ''}${ins.db} dB`; r.style.setProperty('--p', `${((ins.db + 24) / 30) * 100}%`); };
    r.oninput = () => { ins.db = +r.value; sync(); const f = player.eq[i]; if (f && player.ac) f.gain.setTargetAtTime(ins.db, player.ac.currentTime, 0.03); };
    sync();
  });
  if (!open && list.length) {
    const v = document.createElement('button'); v.type = 'button'; v.className = 'btn warm sm'; v.style.cssText = 'grid-column:1/-1;justify-self:start';
    v.innerHTML = `${icon('lock')}<span>Turn each instrument up or down with Plus</span>`;
    v.onclick = () => gate('focusEq', renderInstruments); box.append(v);
  }
  const lane = document.querySelector(`.lane[data-k="${S.eqStem}"] .ctrl`);
  if (lane) { lane.querySelector('.subl')?.remove(); if (list.length) { const d = document.createElement('div'); d.className = 'subl'; d.textContent = list.map((x) => x.detail || x.name).join(', '); lane.querySelector('.name').after(d); } }
}
$('instReset').onclick = () => { (S.instruments || []).forEach((x, i) => { x.db = 0; const f = player.eq[i]; if (f) f.gain.value = 0; }); renderInstruments(); };
plans.onChange(() => { syncTags(); if (S.ready) { renderInstruments(); buildDownloads(); } });

/* ---------- export ---------- */
function buildDownloads() {
  const box = $('dl'); box.innerHTML = '';
  const f = fmtPick.get(), ext = FORMATS[f].ext;
  $('dlHint').textContent = `${FORMATS[f].label}: ${FORMATS[f].note.toLowerCase()}. "Your mix" uses the faders exactly as they are now.`;
  const add = (label, color, feature, fn, wide) => {
    const b = document.createElement('button'); b.type = 'button'; if (wide) b.className = 'wide'; else b.style.setProperty('--c', `var(${color})`);
    const lock = feature && !plans.has(feature) ? `<span class="tag ${plans.needs(feature)}">${icon('lock')}${plans.PLAN[plans.needs(feature)].name}</span>` : '';
    b.innerHTML = `${wide ? '' : '<i></i>'}<span>${label}</span>${lock}`; b.disabled = !S.ready;
    b.onclick = () => (feature ? gate(feature, () => runDownload(b, fn)) : runDownload(b, fn));
    box.append(b);
  };
  const four = mode === '4', nm = (x) => `${S.name} (${x}).${ext}`;
  add('Vocals only', '--voice', null, async () => [[nm('Vocals'), await enc(S.stems.voice)]]);
  add('Instrumental', '--music', null, async () => [[nm('Instrumental'), await enc(four ? S.inst : S.stems.music)]]);
  if (four) for (const k of ['drums', 'bass', 'other']) add(STEMS[k].label, STEMS[k].color, 'stemExport', async () => [[nm(STEMS[k].label), await enc(S.stems[k])]]);
  add('Your mix', '--fg', four ? 'stemExport' : null, async () => [[nm('My mix'), await mixed()]]);
  if (four) add('All stems (.zip)', null, 'stemExport', async () => { const out = []; for (const k of S.order) out.push([nm(STEMS[k].label), await enc(S.stems[k])]); out.push([nm('Instrumental'), await enc(S.inst)]); return out; }, true);
  else add('Vocals and instrumental (.zip)', null, null, async () => [[nm('Vocals'), await enc(S.stems.voice)], [nm('Instrumental'), await enc(S.stems.music)]], true);
  add('Stem pack: every stem, instrumental and your mix', null, 'stemPack', async () => {
    const out = []; for (const k of S.order) out.push([nm(STEMS[k].label), await enc(S.stems[k])]);
    if (four) out.push([nm('Instrumental'), await enc(S.inst)]);
    out.push([nm('My mix'), await mixed()]); return out;
  }, true);
  box.lastChild.style.cssText = 'background:var(--surface-2);color:var(--fg);border-color:var(--line)';
}
const enc = (s, gain = 1) => encodeAudio(s.L, s.R, SR, fmtPick.get(), { gain });
async function eqStem() { // the Focus EQ rendered offline, exactly as in playback
  const s = S.stems[S.eqStem];
  if (!S.instruments?.some((x) => x.db !== 0)) return s;
  const ctx = new OfflineAudioContext(2, S.n, SR); const b = ctx.createBuffer(2, S.n, SR); b.copyToChannel(s.L, 0); b.copyToChannel(s.R, 1);
  const src = ctx.createBufferSource(); src.buffer = b; let node = src;
  for (const ins of S.instruments) { const f = ctx.createBiquadFilter(); f.type = 'peaking'; f.frequency.value = ins.center; f.Q.value = ins.q; f.gain.value = ins.db; node.connect(f); node = f; }
  node.connect(ctx.destination); src.start(); const r = await ctx.startRendering();
  return { L: r.getChannelData(0), R: r.getChannelData(1) };
}
async function mixed() {
  const n = S.n, L = new Float32Array(n), R = new Float32Array(n); const eqd = await eqStem();
  for (const k of S.order) { const g = effGain(k); if (!g) continue; const s = k === S.eqStem ? eqd : S.stems[k]; for (let i = 0; i < n; i++) { L[i] += s.L[i] * g; R[i] += s.R[i] * g; } }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  return enc({ L, R }, peak > 0.999 ? 0.999 / peak : 1); // clip protection
}
async function runDownload(btn, fn) {
  if (!S.ready || btn.disabled) return; btn.disabled = true; const label = btn.querySelector('span'), old = label.textContent; label.textContent = 'Preparing…';
  try { await sleep(20); await saveFiles(await fn(), `${S.name} (stems)`); toast('Download ready'); }
  catch (e) { if (e?.code === 'declined') toast('Download cancelled'); else { console.error(e); toast(`Could not save the file: ${e?.message || e}`); } }
  finally { label.textContent = old; btn.disabled = false; }
}
