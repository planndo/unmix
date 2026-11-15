// Audio cleanup worker. Three real processors, applied in this order when enabled:
//  1. Hum removal: detects 50 or 60 Hz mains hum and notches it out with its harmonics.
//  2. Hiss / steady noise: spectral noise reduction from a noise profile learnt from the
//     quietest parts of the file (works on any material, including music).
//  3. Voice AI denoise: RNNoise recurrent network (Xiph), for speech recordings.
// Input/output: Float32 channels at 48 kHz.
import { Rnnoise } from './vendor/rnnoise.js';

const SR = 48000;
const post = (m, t) => self.postMessage(m, t || []);

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type !== 'clean') return;
    const chans = m.channels; const o = m.options; const report = {};
    const steps = [o.hum && 'hum', o.hiss > 0 && 'hiss', o.voice > 0 && 'voice'].filter(Boolean);
    let step = 0; const prog = (p) => post({ type: 'progress', value: (step + p) / Math.max(1, steps.length) });
    let out = chans.map((c) => c.slice());
    if (o.hum) { const r = removeHum(out); out = r.out; report.hum = r.freq; step++; prog(0); }
    if (o.hiss > 0) { out = out.map((c, i) => spectralDenoise(c, o.hiss, (p) => prog((i + p) / out.length))); step++; }
    if (o.voice > 0) { out = await rnnoiseAll(out, o.voice, (p) => prog(p)); step++; }
    post({ type: 'done', channels: out, report }, out.map((c) => c.buffer));
  } catch (err) {
    post({ type: 'error', message: String((err && err.message) || err) });
  }
};

/* ---------- 1. hum ---------- */
function biquadNotch(x, f0, Q) {
  const w = 2 * Math.PI * f0 / SR, a = Math.sin(w) / (2 * Q), c = Math.cos(w);
  const b0 = 1 / (1 + a), b1 = -2 * c / (1 + a), b2 = 1 / (1 + a), a1 = -2 * c / (1 + a), a2 = (1 - a) / (1 + a);
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; const r = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = r; y[i] = r; }
  // run backwards too (zero phase, steeper notch)
  const z = new Float32Array(x.length); x1 = x2 = y1 = y2 = 0;
  for (let i = x.length - 1; i >= 0; i--) { const v = y[i]; const r = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = r; z[i] = r; }
  return z;
}
function toneEnergy(x, f) { // Goertzel over up to 20 s
  const n = Math.min(x.length, SR * 20), k = 2 * Math.cos(2 * Math.PI * f / SR); let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s = x[i] + k * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / n;
}
function removeHum(chans) {
  const mono = chans[0];
  const score = (f0) => { let s = 0; for (let h = 1; h <= 3; h++) { const on = toneEnergy(mono, f0 * h), off = (toneEnergy(mono, f0 * h - 7) + toneEnergy(mono, f0 * h + 7)) / 2 + 1e-12; s += Math.log10(on / off); } return s; };
  const s50 = score(50), s60 = score(60);
  const f0 = s50 >= s60 ? 50 : 60;
  if (Math.max(s50, s60) < 0.6) return { out: chans, freq: null }; // no clear hum: leave untouched
  const out = chans.map((c) => { let y = c; for (let h = 1; h <= 8; h++) y = biquadNotch(y, f0 * h, 35); return y; });
  return { out, freq: f0 };
}

/* ---------- 2. spectral noise reduction ---------- */
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let j = 0; j < h; j++) { const a = i + j, b = a + h, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
// strength 0..1 -> up to ~24 dB of noise reduction
function spectralDenoise(x, strength, onProg) {
  const N = 2048, H = 512, B = N / 2 + 1, n = x.length;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const frames = Math.max(1, Math.ceil((n + N) / H));
  // pass 1: magnitudes per frame (kept compactly) and frame energies
  const mags = new Float32Array(frames * B), energy = new Float32Array(frames);
  const re = new Float64Array(N), im = new Float64Array(N);
  const get = (i) => (i >= 0 && i < n ? x[i] : 0);
  for (let f = 0; f < frames; f++) {
    const s = f * H - N; let e = 0;
    for (let i = 0; i < N; i++) { re[i] = get(s + i) * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let k = 0; k < B; k++) { const m = Math.hypot(re[k], im[k]); mags[f * B + k] = m; e += m * m; }
    energy[f] = e;
  }
  // noise profile: per-bin mean magnitude over the quietest 10% of frames that are not digital silence
  const idx = Array.from({ length: frames }, (_, i) => i).filter((i) => energy[i] > 1e-10).sort((a, b) => energy[a] - energy[b]);
  const take = idx.slice(0, Math.max(4, Math.floor(idx.length * 0.1)));
  const noise = new Float64Array(B);
  for (const f of take) for (let k = 0; k < B; k++) noise[k] += mags[f * B + k] / take.length;
  // pass 2: smoothed gain (decision-directed style), overlap-add resynthesis
  const floor = Math.pow(10, -(6 + 18 * strength) / 20), over = 1 + 1.5 * strength;
  const out = new Float32Array(n), prevG = new Float32Array(B).fill(1), g = new Float32Array(B);
  for (let f = 0; f < frames; f++) {
    const s = f * H - N;
    for (let i = 0; i < N; i++) { re[i] = get(s + i) * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let k = 0; k < B; k++) {
      const m = mags[f * B + k] + 1e-12, snr = Math.max(0, (m * m) / (over * noise[k] * noise[k] + 1e-20) - 1);
      let gk = snr / (1 + snr); gk = Math.max(floor, gk);
      gk = 0.6 * gk + 0.4 * prevG[k]; // temporal smoothing against "musical noise"
      g[k] = gk;
    }
    for (let k = 1; k < B - 1; k++) prevG[k] = (g[k - 1] + 2 * g[k] + g[k + 1]) / 4; // light frequency smoothing
    prevG[0] = g[0]; prevG[B - 1] = g[B - 1];
    for (let k = 0; k < B; k++) { const gg = prevG[k]; re[k] *= gg; im[k] *= gg; if (k > 0 && k < B - 1) { re[N - k] *= gg; im[N - k] *= gg; } }
    for (let i = 0; i < N; i++) im[i] = -im[i];
    fftInPlace(re, im); // inverse via conjugation
    for (let i = 0; i < N; i++) { const j = s + i; if (j >= 0 && j < n) out[j] += (re[i] / N) * win[i]; }
    if (onProg && f % 200 === 0) onProg(f / frames);
  }
  // sqrt-Hann analysis+synthesis at 75% overlap sums to 2: normalise
  for (let i = 0; i < n; i++) out[i] *= H * 2 / N;
  return out;
}

/* ---------- 3. RNNoise ---------- */
let rn = null;
async function rnnoiseAll(chans, strength, onProg) {
  if (!rn) rn = await Rnnoise.load();
  const F = rn.frameSize, out = [];
  for (let c = 0; c < chans.length; c++) {
    const x = chans[c], n = x.length, st = rn.createDenoiseState(), y = new Float32Array(n), fr = new Float32Array(F);
    // RNNoise output lags its input by two frames (960 samples, measured): read ahead and shift back
    const LAG = 2 * F;
    for (let s = 0; s < n + LAG; s += F) {
      for (let i = 0; i < F; i++) { const j = s + i; fr[i] = j < n ? x[j] * 32768 : 0; }
      st.processFrame(fr);
      for (let i = 0; i < F; i++) { const j = s + i - LAG; if (j >= 0 && j < n) y[j] = fr[i] / 32768; }
      if (s % (F * 2000) === 0) onProg((c + s / n) / chans.length);
    }
    st.destroy();
    if (strength < 1) for (let i = 0; i < n; i++) y[i] = strength * y[i] + (1 - strength) * x[i];
    out.push(y);
  }
  return out;
}
