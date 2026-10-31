// Audio helpers: peaks, loudness (ITU-R BS.1770 integrated LUFS), tempo, WAV + ZIP writers.

export function computePeaks(L, R, bins, out = new Float32Array(bins), from = 0, to = L.length) {
  const n = L.length, per = n / bins;
  const b0 = Math.max(0, Math.floor(from / per)), b1 = Math.min(bins, Math.ceil(to / per));
  for (let b = b0; b < b1; b++) {
    const s0 = Math.floor(b * per), s1 = Math.min(n, Math.floor((b + 1) * per));
    let m = 0; const st = Math.max(1, ((s1 - s0) / 256) | 0);
    for (let i = s0; i < s1; i += st) { const v = Math.abs(L[i]) + Math.abs(R[i]); if (v > m) m = v; }
    out[b] = m * 0.5;
  }
  return out;
}

// Biquad coefficients for the BS.1770 K-weighting at any sample rate (pyloudnorm formulation)
function kFilters(fs) {
  const mk = (G, Q, fc, type) => {
    const A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fc / fs, a = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'shelf') {
      b0 = A * ((A + 1) + (A - 1) * c + 2 * Math.sqrt(A) * a); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - 2 * Math.sqrt(A) * a);
      a0 = (A + 1) - (A - 1) * c + 2 * Math.sqrt(A) * a; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - 2 * Math.sqrt(A) * a;
    } else {
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  };
  return [mk(4.0, 1 / Math.SQRT2, 1500, 'shelf'), mk(0, 0.5, 38, 'hp')];
}
function filt(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
  return y;
}
// Mean-square per 400 ms block (75% overlap) of the K-weighted stereo signal.
export function blockPowers(L, R, fs = 44100) {
  const [sh, hp] = kFilters(fs);
  const kl = filt(filt(L, sh), hp), kr = filt(filt(R, sh), hp);
  const win = Math.round(0.4 * fs), hop = Math.round(0.1 * fs), out = [];
  for (let s = 0; s + win <= L.length; s += hop) {
    let a = 0; for (let i = s; i < s + win; i++) a += kl[i] * kl[i] + kr[i] * kr[i];
    out.push(a / win);
  }
  return Float64Array.from(out);
}
export function lufsFromPowers(p) {
  const lk = (z) => -0.691 + 10 * Math.log10(z);
  let g = []; for (const z of p) if (z > 0 && lk(z) > -70) g.push(z);
  if (!g.length) return -Infinity;
  const rel = lk(g.reduce((s, z) => s + z, 0) / g.length) - 10;
  g = g.filter((z) => lk(z) > rel);
  return g.length ? lk(g.reduce((s, z) => s + z, 0) / g.length) : -Infinity;
}

// Tempo from an onset envelope (spectral-energy flux) using autocorrelation.
export function estimateBpm(L, R, fs = 44100) {
  const hop = 512, n = Math.floor(L.length / hop), env = new Float32Array(n);
  let prev = 0;
  for (let f = 0; f < n; f++) {
    let e = 0; for (let i = f * hop; i < (f + 1) * hop; i++) { const v = L[i] + R[i]; e += v * v; }
    e = Math.log1p(1000 * e / hop); env[f] = Math.max(0, e - prev); prev = e;
  }
  const fps = fs / hop; let best = 0, bestBpm = 0;
  let mean = 0; for (const v of env) mean += v; mean /= n || 1;
  for (let bpm = 60; bpm <= 190; bpm += 0.5) {
    const lag = fps * 60 / bpm, l0 = Math.floor(lag), fr = lag - l0; let s = 0;
    for (let i = 0; i + l0 + 1 < n; i++) s += (env[i] - mean) * ((env[i + l0] * (1 - fr) + env[i + l0 + 1] * fr) - mean);
    s /= (n - l0);
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2)); // gentle prior toward common tempos
    if (s * w > best) { best = s * w; bestBpm = bpm; }
  }
  return best > 0 ? Math.round(bestBpm) : null;
}

export function encodeWav(L, R, fs = 44100, gain = 1) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, fs, true); v.setUint32(28, fs * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  const out = new Int16Array(buf, 44);
  for (let i = 0; i < n; i++) {
    const a = Math.max(-1, Math.min(1, L[i] * gain)), b = Math.max(-1, Math.min(1, R[i] * gain));
    out[2 * i] = a < 0 ? a * 32768 : a * 32767; out[2 * i + 1] = b < 0 ? b * 32768 : b * 32767;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// Minimal ZIP (store, no compression) for [{name, blob}]
export async function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer()), name = enc.encode(f.name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}
