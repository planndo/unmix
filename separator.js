// Unmix separation orchestrator (main thread). Fetches + caches the runtime and models,
// runs a pool of inference workers (1 on GPU, several on CPU) and stitches chunks.
import { MdxSpec } from './dsp.js';

const BASE = new URL('./', import.meta.url);
const CACHE = 'unmix-assets-v1';
export const MODELS = {
  vocals: { label: 'Voice model', parts: 5, file: 'kim-vocal-2', bytes: 66759214, nFft: 7680, hop: 1024, dimF: 3072, dimT: 256 },
  drums:  { label: 'Drums model', parts: 3, file: 'kuielab-drums', bytes: 29703204, nFft: 4096, hop: 1024, dimF: 2048, dimT: 512 },
  bass:   { label: 'Bass model',  parts: 3, file: 'kuielab-bass',  bytes: 29703204, nFft: 16384, hop: 1024, dimF: 2048, dimT: 512 },
  tagger: { label: 'Instrument recogniser', parts: 2, file: 'efficientat-mn10', bytes: 23976736 },
};
const RUNTIME_BYTES = 5091678;

async function openCache() { try { return await caches.open(CACHE); } catch { return null; } }

async function isCached(path) {
  const c = await openCache(); if (!c) return false;
  try { return !!(await c.match(new URL(path, BASE).href)); } catch { return false; }
}

async function getBytes(path, onBytes) {
  const url = new URL(path, BASE).href; const cache = await openCache();
  if (cache) { try { const hit = await cache.match(url); if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); onBytes(b.length); return b; } } catch {} }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed for ${path} (HTTP ${res.status})`);
  const reader = res.body.getReader(); const parts = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onBytes(value.length); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  if (cache) { try { await cache.put(url, new Response(out.slice())); } catch {} }
  return out;
}

let runtime = null;
async function getRuntime(onBytes) {
  if (runtime) return runtime;
  const gz = await getBytes('ort/ort-wasm-jsep.gz.wasm', onBytes);
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  runtime = await new Response(stream).arrayBuffer();
  return runtime;
}

const modelBytes = {};
export async function downloadSize(keys) {
  let n = (await isCached('ort/ort-wasm-jsep.gz.wasm')) ? 0 : RUNTIME_BYTES;
  for (const k of keys) if (!modelBytes[k] && !(await isCached(`model/${MODELS[k].file}.part0.wasm`))) n += MODELS[k].bytes;
  return n;
}

// Download runtime + the given models. onProgress(loaded, total)
export async function prepare(keys, onProgress) {
  const total = RUNTIME_BYTES + keys.reduce((s, k) => s + MODELS[k].bytes, 0); let loaded = 0;
  const tick = (n) => { loaded += n; onProgress(Math.min(loaded, total), total); };
  await getRuntime(tick);
  for (const k of keys) {
    if (modelBytes[k]) { tick(MODELS[k].bytes); continue; }
    const M = MODELS[k]; const buf = new Uint8Array(M.bytes); let o = 0;
    for (let i = 0; i < M.parts; i++) { const b = await getBytes(`model/${M.file}.part${i}.wasm`, tick); buf.set(b, o); o += b.length; }
    modelBytes[k] = buf;
  }
}

function spawn(key, ep, allowSoftware, threads = 1) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
    const M = MODELS[key];
    w.onmessage = (e) => { if (e.data.type === 'ready') { w.onmessage = null; w.onerror = null; resolve(w); } else if (e.data.type === 'error') { w.terminate(); reject(new Error(e.data.message)); } };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Worker failed to start')); };
    w.postMessage({ type: 'init', ep, allowSoftware, model: modelBytes[key].slice().buffer, wasmBinary: runtime.slice(0),
      mjsUrl: new URL('ort/ort-wasm-simd-threaded.jsep.mjs', BASE).href, cfg: M, threads });
  });
}

export let lastBackend = null;
export let lastThreads = 1;
let gpuBroken = false;

export async function makePool(key, { preferGpu = true, allowSoftware = false } = {}) {
  if (preferGpu && !gpuBroken && 'gpu' in navigator) {
    try { const w = await spawn(key, 'webgpu', allowSoftware); lastBackend = 'gpu'; return [w]; } catch (e) { gpuBroken = true; console.info('[unmix] GPU path unavailable:', e.message); }
  }
  const cores = navigator.hardwareConcurrency || 4; const mem = navigator.deviceMemory || 4;
  const memCap = mem >= 8 ? 4 : mem >= 4 ? 2 : 1;
  // Cross-origin isolated pages (self-hosted with coi-serviceworker) can use multi-threaded WASM.
  const iso = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const want = iso ? Math.max(1, Math.min(2, memCap)) : Math.max(1, Math.min(4, Math.floor(cores / 2), memCap));
  const threads = iso ? Math.max(1, Math.min(8, Math.floor(cores / want))) : 1;
  const first = await spawn(key, 'wasm', false, threads);
  const rest = await Promise.allSettled(Array.from({ length: want - 1 }, () => spawn(key, 'wasm', false, threads)));
  lastBackend = 'cpu'; lastThreads = threads;
  return [first, ...rest.filter((r) => r.status === 'fulfilled').map((r) => r.value)];
}

export function closePool(pool) { for (const w of pool) { try { w.postMessage({ type: 'dispose' }); } catch {} setTimeout(() => w.terminate(), 2000); } }

// Separate one stem. Returns {L, R} for the model's primary stem.
export async function runStem(key, L, R, { onChunk, signal, preferGpu = true } = {}) {
  const spec = new MdxSpec(MODELS[key]); const { chunk, trim, gen } = spec; const n = L.length;
  const pad = gen - (n % gen), total = (n + pad) / gen;
  const pL = new Float32Array(n + pad + 2 * trim), pR = new Float32Array(n + pad + 2 * trim);
  pL.set(L, trim); pR.set(R, trim);
  const oL = new Float32Array(n), oR = new Float32Array(n);
  const pool = await makePool(key, { preferGpu });
  let next = 0, done = 0; const t0 = performance.now();
  try {
    await new Promise((resolve, reject) => {
      const feed = (w) => {
        if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
        if (next >= total) return;
        const id = next++, i = id * gen;
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'error') return reject(new Error(m.message));
          const len = Math.min(gen, n - i);
          if (len > 0) { oL.set(m.L.subarray(0, len), i); oR.set(m.R.subarray(0, len), i); }
          done++;
          onChunk?.({ done, total, start: i, end: Math.min(n, i + gen), elapsed: performance.now() - t0, workers: pool.length });
          if (done === total) resolve(); else feed(w);
        };
        w.onerror = (e) => reject(new Error(e.message || 'Worker crashed'));
        w.postMessage({ type: 'run', id, L: pL.slice(i, i + chunk), R: pR.slice(i, i + chunk) });
      };
      pool.forEach(feed);
    });
  } finally { closePool(pool); }
  return { L: oL, R: oR };
}

// Instrument recognition on 10 s, 32 kHz mono windows. Returns one Float32Array(527) per window.
export async function runTagger(waves) {
  const w = new Worker(new URL('./tag-worker.js', import.meta.url), { type: 'module' });
  try {
    await new Promise((resolve, reject) => {
      w.onmessage = (e) => (e.data.type === 'ready' ? resolve() : reject(new Error(e.data.message)));
      w.onerror = (e) => reject(new Error(e.message || 'Instrument recogniser failed to start'));
      w.postMessage({ type: 'init', model: modelBytes.tagger.slice().buffer, wasmBinary: runtime.slice(0),
        mjsUrl: new URL('ort/ort-wasm-simd-threaded.jsep.mjs', BASE).href,
        threads: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1 });
    });
    const out = [];
    for (let i = 0; i < waves.length; i++) {
      out.push(await new Promise((resolve, reject) => {
        w.onmessage = (e) => (e.data.type === 'out' ? resolve(e.data.probs) : reject(new Error(e.data.message)));
        w.postMessage({ type: 'run', id: i, wave: waves[i] });
      }));
    }
    return out;
  } finally { w.terminate(); }
}
