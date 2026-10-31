// DSP for MDX-Net: arbitrary-length FFT (Bluestein over radix-2) and the STFT/iSTFT
// layout the UVR MDX ONNX models expect: [1, 4(Lre,Lim,Rre,Rim), dimF, dimT].

class FFT2 { // in-place iterative radix-2 complex FFT
  constructor(n) {
    this.n = n; this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } this.rev[i] = r; }
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
  }
  run(re, im, inverse) {
    const n = this.n, rev = this.rev, C = this.cos, S = this.sin, sg = inverse ? -1 : 1;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = C[k], wi = sg * S[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

export class Bluestein { // complex DFT of any length n
  constructor(n) {
    this.n = n; let m = 1; while (m < 2 * n - 1) m <<= 1; this.m = m; this.f = new FFT2(m);
    this.wr = new Float64Array(n); this.wi = new Float64Array(n);
    for (let k = 0; k < n; k++) { const a = Math.PI * ((k * k) % (2 * n)) / n; this.wr[k] = Math.cos(a); this.wi[k] = -Math.sin(a); }
    this.br = new Float64Array(m); this.bi = new Float64Array(m);
    this.br[0] = this.wr[0]; this.bi[0] = -this.wi[0];
    for (let k = 1; k < n; k++) { this.br[k] = this.br[m - k] = this.wr[k]; this.bi[k] = this.bi[m - k] = -this.wi[k]; }
    this.f.run(this.br, this.bi, false);
    this.ar = new Float64Array(m); this.ai = new Float64Array(m);
  }
  // forward (inverse=false): X[k] = sum x[n] e^{-2πikn/N}; inverse: unnormalised e^{+}
  run(xr, xi, outR, outI, inverse) {
    const n = this.n, m = this.m, ar = this.ar, ai = this.ai, wr = this.wr, s = inverse ? -1 : 1;
    for (let k = 0; k < n; k++) { const ww = s * this.wi[k]; ar[k] = xr[k] * wr[k] - xi[k] * ww; ai[k] = xr[k] * ww + xi[k] * wr[k]; }
    ar.fill(0, n); ai.fill(0, n);
    this.f.run(ar, ai, false);
    const br = this.br, bi = this.bi;
    for (let k = 0; k < m; k++) { const bI = s * bi[k]; const r = ar[k] * br[k] - ai[k] * bI; ai[k] = ar[k] * bI + ai[k] * br[k]; ar[k] = r; }
    this.f.run(ar, ai, true);
    for (let k = 0; k < n; k++) { const r = ar[k] / m, i = ai[k] / m, ww = s * this.wi[k]; outR[k] = r * wr[k] - i * ww; outI[k] = r * ww + i * wr[k]; }
  }
}

export class MdxSpec {
  constructor({ nFft = 7680, hop = 1024, dimF = 3072, dimT = 256 } = {}) {
    Object.assign(this, { nFft, hop, dimF, dimT });
    this.chunk = hop * (dimT - 1); this.trim = nFft >> 1; this.gen = this.chunk - 2 * this.trim;
    this.win = new Float64Array(nFft);
    for (let i = 0; i < nFft; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / nFft);
    this.dft = new Bluestein(nFft);
    const N = nFft; this.zr = new Float64Array(N); this.zi = new Float64Array(N); this.Zr = new Float64Array(N); this.Zi = new Float64Array(N);
    // window-sum normaliser for overlap-add (centre region of the padded signal)
    const L = nFft + hop * (dimT - 1); const w2 = new Float64Array(L);
    for (let t = 0; t < dimT; t++) for (let i = 0; i < N; i++) w2[t * hop + i] += this.win[i] * this.win[i];
    this.norm = new Float64Array(this.chunk); for (let i = 0; i < this.chunk; i++) this.norm[i] = 1 / Math.max(w2[i + (N >> 1)], 1e-8);
    this.olaL = new Float64Array(L); this.olaR = new Float64Array(L);
  }
  // L, R: Float32Array of length chunk. Writes into spec (Float32Array 4*dimF*dimT).
  stft(L, R, spec) {
    const { nFft: N, hop, dimF: F, dimT: T, win, zr, zi, Zr, Zi } = this, p = N >> 1, n = L.length;
    const refl = (j) => { if (j < 0) j = -j; if (j >= n) j = 2 * n - 2 - j; return j; };
    const FT = F * T;
    for (let t = 0; t < T; t++) {
      const s0 = t * hop - p;
      for (let i = 0; i < N; i++) { const j = refl(s0 + i); zr[i] = L[j] * win[i]; zi[i] = R[j] * win[i]; }
      this.dft.run(zr, zi, Zr, Zi, false);
      for (let k = 0; k < F; k++) {
        const kk = k === 0 ? 0 : N - k;
        const ar = Zr[k], ai = Zi[k], br = Zr[kk], bi = -Zi[kk]; // b = conj(Z[N-k])
        const o = k * T + t;
        spec[o] = 0.5 * (ar + br); spec[FT + o] = 0.5 * (ai + bi);        // L = (Z + conj Z')/2
        spec[2 * FT + o] = 0.5 * (ai - bi); spec[3 * FT + o] = -0.5 * (ar - br); // R = (Z - conj Z')/(2i)
      }
    }
  }
  // spec -> L,R (Float32Array chunk)
  istft(spec, outL, outR) {
    const { nFft: N, hop, dimF: F, dimT: T, win, zr, zi, Zr, Zi, olaL, olaR } = this, FT = F * T, p = N >> 1;
    olaL.fill(0); olaR.fill(0);
    for (let t = 0; t < T; t++) {
      zr.fill(0); zi.fill(0);
      for (let k = 0; k < F; k++) {
        const o = k * T + t, lr = spec[o], li = spec[FT + o], rr = spec[2 * FT + o], ri = spec[3 * FT + o];
        // Z = Lfull + i Rfull, using Hermitian symmetry
        zr[k] = lr - ri; zi[k] = li + rr;
        if (k > 0) { zr[N - k] = lr + ri; zi[N - k] = -li + rr; }
      }
      // DC/Nyquist bins must be real for a real signal: drop imaginary parts at k=0
      zr[0] = spec[0 * FT + t] - 0; zi[0] = spec[2 * FT + t];
      this.dft.run(zr, zi, Zr, Zi, true);
      const b = t * hop;
      for (let i = 0; i < N; i++) { olaL[b + i] += Zr[i] / N * win[i]; olaR[b + i] += Zi[i] / N * win[i]; }
    }
    const nm = this.norm;
    for (let i = 0; i < this.chunk; i++) { outL[i] = olaL[i + p] * nm[i]; outR[i] = olaR[i + p] * nm[i]; }
  }
}
