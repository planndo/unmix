// Instrument recognition + Focus EQ planning for the "Other" (or "Instrumental") stem.
// Recognition: EfficientAT mn10 trained on AudioSet (mAP 0.47), run on 10 s windows across the song.
// Focus EQ: for each recognised instrument, find where its energy sits in this song's spectrum
// (inside the instrument's typical range, weighted toward the windows where it was heard most).

// AudioSet class indices grouped into instruments people recognise. range = typical energy band in Hz.
export const GROUPS = [
  { id: 'piano', name: 'Piano & keys', classes: { 153: 'Piano', 154: 'Electric piano', 152: 'Keyboard', 160: 'Harpsichord' }, range: [180, 3500] },
  { id: 'organ', name: 'Organ', classes: { 155: 'Organ', 156: 'Electronic organ', 157: 'Hammond organ' }, range: [120, 3000] },
  { id: 'synth', name: 'Synth', classes: { 158: 'Synthesizer', 159: 'Sampler' }, range: [250, 6000] },
  { id: 'guitar', name: 'Guitar', classes: { 140: 'Guitar', 141: 'Electric guitar', 143: 'Acoustic guitar', 144: 'Slide guitar', 146: 'Strummed guitar' }, range: [200, 5000] },
  { id: 'mallets', name: 'Marimba & mallets', classes: { 180: 'Marimba / xylophone', 182: 'Vibraphone', 181: 'Glockenspiel', 179: 'Mallet percussion', 183: 'Steelpan' }, range: [350, 4500] },
  { id: 'sax', name: 'Saxophone', classes: { 197: 'Saxophone' }, range: [250, 3500] },
  { id: 'brass', name: 'Brass', classes: { 185: 'Brass', 187: 'Trumpet', 188: 'Trombone', 186: 'French horn' }, range: [250, 4000] },
  { id: 'strings', name: 'Strings', classes: { 189: 'Bowed strings', 190: 'String section', 191: 'Violin', 193: 'Cello', 184: 'Orchestra', 192: 'Pizzicato' }, range: [250, 5000] },
  { id: 'winds', name: 'Flute & woodwinds', classes: { 196: 'Flute', 198: 'Clarinet', 195: 'Woodwinds' }, range: [400, 6000] },
  { id: 'accordion', name: 'Accordion', classes: { 209: 'Accordion' }, range: [250, 4000] },
  { id: 'harmonica', name: 'Harmonica', classes: { 208: 'Harmonica' }, range: [400, 4000] },
  { id: 'plucked', name: 'Plucked strings', classes: { 147: 'Banjo', 149: 'Mandolin', 151: 'Ukulele', 148: 'Sitar', 150: 'Zither', 199: 'Harp', 139: 'Plucked strings' }, range: [300, 5000] },
  { id: 'bells', name: 'Bells', classes: { 200: 'Bell', 178: 'Tubular bells' }, range: [800, 8000] },
];
const SHOW_AT = 0.12; // group score needed to list an instrument

function rms(x, a, b) { let s = 0; for (let i = a; i < b; i += 7) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, (b - a) / 7)); }

async function to32kMono(L, R, sr) {
  const n = L.length, ctx = new OfflineAudioContext(1, Math.ceil(n * 32000 / sr), 32000);
  const b = ctx.createBuffer(1, n, sr); const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = 0.5 * (L[i] + R[i]);
  b.copyToChannel(m, 0); const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

// Average magnitude spectrum (4096-pt) of a window of the 44.1 kHz stem, in 1/12-octave bins 60 Hz - 12 kHz.
const BANDS = (() => { const f = []; for (let x = 60; x < 12000; x *= Math.pow(2, 1 / 12)) f.push(x); return f; })();
function bandSpectrum(L, R, a, b, sr, fft) {
  const N = 4096, out = new Float64Array(BANDS.length); const re = new Float64Array(N), im = new Float64Array(N);
  let frames = 0;
  for (let s = a; s + N <= b; s += N * 4) {
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = 0.5 * (L[s + i] + R[s + i]) * w; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < BANDS.length; k++) {
      const lo = Math.floor(BANDS[k] * Math.pow(2, -1 / 24) * N / sr), hi = Math.max(lo + 1, Math.ceil(BANDS[k] * Math.pow(2, 1 / 24) * N / sr));
      let e = 0; for (let j = lo; j < hi; j++) e += re[j] * re[j] + im[j] * im[j];
      out[k] += e / (hi - lo);
    }
    frames++;
  }
  for (let k = 0; k < out.length; k++) out[k] = 10 * Math.log10(out[k] / Math.max(1, frames) + 1e-12);
  return out;
}
function radix2(re, im) { // in-place FFT, length power of two
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) { const a = i + j, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}

/**
 * runTagger(waves) -> Promise<Float32Array[]> is supplied by the caller (separator.js owns the worker).
 * Returns [{ id, name, detail, score, center, q, windows }] sorted by score.
 */
export async function detectInstruments(stem, sr, runTagger) {
  const n = stem.L.length, W = 10 * sr;
  const mono32 = await to32kMono(stem.L, stem.R, sr);
  const count = Math.max(1, Math.min(14, Math.ceil(n / W)));
  const starts = [];
  for (let k = 0; k < count; k++) starts.push(count === 1 ? 0 : Math.round((n - Math.min(n, W)) * k / (count - 1)));
  const wins = starts.map((s) => ({ s, e: Math.min(n, s + W) })).filter((w) => rms(stem.L, w.s, w.e) > 2e-3);
  if (!wins.length) return [];
  const waves = wins.map((w) => { const a = Math.floor(w.s * 32000 / sr), x = new Float32Array(320000); x.set(mono32.subarray(a, Math.min(mono32.length, a + 320000))); return x; });
  const probs = await runTagger(waves);

  const res = [];
  for (const g of GROUPS) {
    const per = probs.map((p) => Math.max(...Object.keys(g.classes).map((c) => p[c])));
    const sorted = [...per].sort((a, b) => b - a); const top = sorted.slice(0, Math.min(3, sorted.length));
    const score = top.reduce((s, v) => s + v, 0) / top.length;
    if (score < SHOW_AT) continue;
    // best sub-label for display (e.g. "Electric guitar")
    let best = null, bestV = 0;
    for (const c of Object.keys(g.classes)) { const v = Math.max(...probs.map((p) => p[c])); if (v > bestV) { bestV = v; best = g.classes[c]; } }
    res.push({ ...g, score, detail: best, per });
  }
  res.sort((a, b) => b.score - a.score);
  const found = res.slice(0, 5);

  // locate each instrument's band in this song: spectrum of windows where it is loudest vs. the rest
  const specs = wins.map((w) => bandSpectrum(stem.L, stem.R, w.s, w.e, sr, radix2));
  for (const g of found) {
    const wsum = g.per.reduce((s, v) => s + v, 0) || 1;
    const weighted = BANDS.map((_, k) => specs.reduce((s, sp, i) => s + sp[k] * g.per[i], 0) / wsum);
    const plain = BANDS.map((_, k) => specs.reduce((s, sp) => s + sp[k], 0) / specs.length);
    let bestK = -1, bestScore = -Infinity;
    for (let k = 0; k < BANDS.length; k++) {
      const f = BANDS[k]; if (f < g.range[0] || f > g.range[1]) continue;
      // smooth over a third of an octave; compensate the natural ~4.5 dB/octave tilt of music,
      // and favour bands that rise where the instrument is present
      let s = 0, c = 0; for (let d = -2; d <= 2; d++) { const j = k + d; if (j >= 0 && j < BANDS.length) { s += weighted[j] + 4.5 * Math.log2(BANDS[j] / 1000) + 1.5 * (weighted[j] - plain[j]); c++; } }
      if (s / c > bestScore) { bestScore = s / c; bestK = k; }
    }
    const geo = Math.sqrt(g.range[0] * g.range[1]);
    g.center = bestK >= 0 ? Math.round(BANDS[bestK]) : Math.round(geo);
    g.q = 0.9; // about 1.5 octaves wide: catches fundamentals and the first harmonics
    delete g.per;
  }
  return found;
}
