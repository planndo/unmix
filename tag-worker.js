// Instrument recognition worker: EfficientAT mn10 (AudioSet, 527 classes) with built-in mel front end.
import * as ort from './ort/ort.webgpu.min.mjs';
let session;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ort.env.wasm.wasmBinary = new Uint8Array(m.wasmBinary);
      ort.env.wasm.wasmPaths = { mjs: m.mjsUrl };
      ort.env.wasm.numThreads = m.threads || 1;
      ort.env.logLevel = 'error';
      session = await ort.InferenceSession.create(new Uint8Array(m.model), { executionProviders: ['wasm'] });
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'run') {
      const out = await session.run({ wave: new ort.Tensor('float32', m.wave, [1, m.wave.length]) });
      const probs = out.probs.data.slice();
      self.postMessage({ type: 'out', id: m.id, probs }, [probs.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
