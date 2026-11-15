// Timbila I/O: decoding any input, encoding outputs, and handing files to the user.
import { getBytes, gunzip } from '../separator.js';
import { encodeWav, makeZip } from '../audio-utils.js';

export const FORMATS = {
  wav:  { label: 'WAV', note: 'Lossless, 16-bit', ext: 'wav', tier: 'free' },
  mp3:  { label: 'MP3', note: '320 kbps', ext: 'mp3', tier: 'free' },
  flac: { label: 'FLAC', note: 'Lossless, smaller', ext: 'flac', tier: 'plus' },
  m4a:  { label: 'M4A', note: 'AAC 256 kbps', ext: 'm4a', tier: 'plus' },
  ogg:  { label: 'OGG', note: 'Vorbis, high quality', ext: 'ogg', tier: 'plus' },
  aiff: { label: 'AIFF', note: 'Lossless, Apple', ext: 'aiff', tier: 'plus' },
};

/* ---------- FFmpeg (loaded on first use, ~10 MB) ---------- */
let ffWasm = null;
async function ffBinary(onBytes) {
  if (!ffWasm) ffWasm = await gunzip(await getBytes('vendor/ffmpeg-core.gz.wasm', onBytes));
  return ffWasm;
}
export function ffmpegJob(msg, { onProgress, onBytes } = {}) {
  return ffBinary(onBytes).then((wasm) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('../ff-worker.js', import.meta.url), { type: 'module' });
    const end = () => setTimeout(() => w.terminate(), 0);
    w.onerror = (e) => { end(); reject(new Error(e.message || 'The converter failed to start')); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') w.postMessage(msg, [msg.data]);
      else if (m.type === 'progress') onProgress?.(Math.max(0, Math.min(1, m.value || 0)));
      else if (m.type === 'done') { end(); resolve(m); }
      else if (m.type === 'error') { end(); reject(new Error(m.message)); }
    };
    w.postMessage({ type: 'init', wasmBinary: wasm.slice(0) });
  }));
}
export async function convertBytes(bytes, inExt, format, opts = {}) {
  const r = await ffmpegJob({ type: 'convert', data: bytes, ext: inExt, format, quality: opts.quality, sampleRate: opts.sampleRate, channels: opts.channels }, opts);
  return new Blob([r.data]);
}

/* ---------- decoding ---------- */
export const extOf = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name || '')?.[1] || 'bin').toLowerCase();

// Returns { channels: Float32Array[], sampleRate } at the requested rate (stereo).
export async function decodeFile(file, sampleRate, { onStatus } = {}) {
  const bytes = await file.arrayBuffer();
  let buf = null;
  const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, sampleRate);
  try { buf = await ac.decodeAudioData(bytes.slice(0)); } catch {}
  if (!buf) { // formats the browser can't read (WMA, AMR, some video files...): let FFmpeg turn it into WAV first
    onStatus?.('Unpacking this format');
    const wav = await convertBytes(bytes.slice(0), extOf(file.name), 'wav', { quality: { bits: 32 }, sampleRate, channels: 2 });
    buf = await ac.decodeAudioData(await wav.arrayBuffer());
  }
  let L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0);
  if (buf.sampleRate !== sampleRate) {
    const off = new OfflineAudioContext(2, Math.ceil(buf.duration * sampleRate), sampleRate);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    const r = await off.startRendering(); L = r.getChannelData(0); R = r.getChannelData(1);
  }
  return { channels: [L.slice(), R.slice()], sampleRate };
}

export async function resample(channels, from, to) {
  if (from === to) return channels;
  const n = channels[0].length, off = new OfflineAudioContext(channels.length, Math.ceil(n * to / from), to);
  const b = off.createBuffer(channels.length, n, from); channels.forEach((c, i) => b.copyToChannel(c, i));
  const s = off.createBufferSource(); s.buffer = b; s.connect(off.destination); s.start();
  const r = await off.startRendering();
  return Array.from({ length: channels.length }, (_, i) => r.getChannelData(i).slice());
}

/* ---------- encoding ---------- */
let lame = null;
export async function encodeMp3(L, R, sr, kbps = 320, onProgress) {
  if (!lame) lame = await import('../vendor/lamejs.js');
  const enc = new lame.Mp3Encoder(2, sr, kbps), block = 1152 * 8, parts = [];
  const l16 = new Int16Array(block), r16 = new Int16Array(block);
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    for (let j = 0; j < n; j++) { const a = Math.max(-1, Math.min(1, L[i + j])), b = Math.max(-1, Math.min(1, R[i + j])); l16[j] = a * 32767; r16[j] = b * 32767; }
    const out = enc.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n)); if (out.length) parts.push(new Uint8Array(out));
    if (onProgress && (i / block) % 40 === 0) { onProgress(i / L.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

// Encode stereo float audio to any supported format.
export async function encodeAudio(L, R, sr, format, { gain = 1, onProgress } = {}) {
  if (gain !== 1) { L = L.map((v) => v * gain); R = R.map((v) => v * gain); }
  if (format === 'wav') return encodeWav(L, R, sr);
  if (format === 'mp3') return encodeMp3(L, R, sr, 320, onProgress);
  const wav = encodeWav(L, R, sr);
  return convertBytes(await wav.arrayBuffer(), 'wav', format, { onProgress });
}

/* ---------- saving ---------- */
let dlApi;
export async function saveFiles(files, zipName) {
  // Inside Claude, a page can only offer files through the downloads capability (zip accepted);
  // everywhere else this is an ordinary browser download.
  if (dlApi === undefined) { try { dlApi = window.claude?.use ? await window.claude.use('downloads') : null; } catch { dlApi = null; } }
  if (dlApi) {
    const zip = await makeZip(files.map(([name, blob]) => ({ name, blob })));
    const base = files.length === 1 ? files[0][0].replace(/\.[a-z0-9]+$/i, '') : zipName;
    await dlApi.save({ filename: `${base}.zip`, data: zip });
    return;
  }
  if (files.length > 1) files = [[`${zipName}.zip`, await makeZip(files.map(([name, blob]) => ({ name, blob })))]];
  const [name, blob] = files[0];
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export const fmtTime = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${m}:${String(x).padStart(2, '0')}`; };
export const fmtBytes = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
export const baseName = (name) => (name || 'audio').replace(/\.[^.]+$/, '');
