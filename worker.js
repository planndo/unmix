// Unmix inference worker: one ONNX session, converts audio chunks -> separated chunk.
import * as ort from './ort/ort.webgpu.min.mjs';
import { MdxSpec } from './dsp.js';

let session, spec, specBuf, oL, oR, dims;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ort.env.wasm.wasmBinary = new Uint8Array(m.wasmBinary);
      ort.env.wasm.wasmPaths = { mjs: m.mjsUrl };
      ort.env.wasm.numThreads = m.threads || 1;
      ort.env.logLevel = 'error';
      if (m.ep === 'webgpu') {
        if (!self.navigator.gpu) throw new Error('WebGPU not available in worker');
        const ad = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!ad) throw new Error('No WebGPU adapter');
        if (ad.info && /swiftshader|llvmpipe|software/i.test(`${ad.info.vendor} ${ad.info.architecture} ${ad.info.description}`) && !m.allowSoftware)
          throw new Error('Software GPU only');
      }
      session = await ort.InferenceSession.create(new Uint8Array(m.model), {
        executionProviders: [m.ep], graphOptimizationLevel: 'all',
      });
      spec = new MdxSpec(m.cfg);
      specBuf = new Float32Array(4 * spec.dimF * spec.dimT);
      oL = new Float32Array(spec.chunk); oR = new Float32Array(spec.chunk);
      dims = [1, 4, spec.dimF, spec.dimT];
      // warm-up run so shader compilation is not counted against the first chunk
      if (m.ep === 'webgpu') {
        const t = (await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', specBuf, dims) }))[session.outputNames[0]];
        if (t.dispose) t.dispose();
      }
      self.postMessage({ type: 'ready', ep: m.ep });
    } else if (m.type === 'run') {
      const t0 = performance.now();
      spec.stft(m.L, m.R, specBuf);
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', specBuf, dims) });
      const t = out[session.outputNames[0]];
      const data = t.location === 'cpu' || !t.getData ? t.data : await t.getData();
      spec.istft(data, oL, oR);
      if (t.dispose) t.dispose();
      const L = oL.slice(spec.trim, spec.trim + spec.gen), R = oR.slice(spec.trim, spec.trim + spec.gen);
      self.postMessage({ type: 'out', id: m.id, L, R, ms: performance.now() - t0 }, [L.buffer, R.buffer]);
    } else if (m.type === 'dispose') {
      try { await session?.release(); } catch {}
      self.close();
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
