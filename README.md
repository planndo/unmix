# Unmix

Free AI vocal remover and stem splitter that runs entirely in the browser. Drop in a song, get vocals,
drums, bass and everything else as separate stems, mix them with faders or Auto-mix, and export lossless WAV.
Nothing is uploaded: the AI models run on the visitor's own GPU (WebGPU) or CPU (WebAssembly).

## Features
- **Two modes:** Voice + instrumental, or 4 stems (vocals, drums, bass, other).
- **Studio mixer:** a lane per stem with volume (0-200%), solo, mute, click-to-seek and drag-to-loop.
- **Manual presets:** Karaoke, A cappella, No drums, No bass, Rhythm section.
- **Auto-mix:** measures each stem's integrated loudness (ITU-R BS.1770, LUFS) and balances the faders for a goal
  (Balanced, Vocal forward, Band focus, Karaoke, Drum practice, Bass practice) while keeping the song's overall loudness.
- **Exports:** vocals, instrumental, each stem, your current mix, or everything as a zip. 44.1 kHz 16-bit WAV.
- Tempo estimate, keyboard shortcuts, light and dark themes, works at phone width.

## Run locally
It is a static site:

    python3 -m http.server 8000     # open http://localhost:8000

## Deploy on GitHub Pages
Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)**.
The site appears at `https://<user>.github.io/unmix/`. `coi-serviceworker.min.js` makes the page cross-origin
isolated on Pages, which lets the CPU engine use multiple threads (about twice as fast as single-threaded).

## Editing
`page.html` is the source of the page. After editing it, run `./build.sh` to regenerate `index.html`.
(`page.html` is also what gets published as the Claude artifact version, whose host adds the HTML skeleton itself.)

## How it works
- `separator.js` downloads the runtime and models once (cached with the Cache API) and runs them in Web Workers:
  one WebGPU worker when a real GPU is available, otherwise a pool of WASM workers.
- `worker.js` + `dsp.js` implement MDX-Net inference: STFT (Bluestein FFT for the 7680-point frame) → ONNX model →
  iSTFT, processed in chunks with overlap trimming.
- Pipeline: Kim Vocal 2 extracts vocals; instrumental = mix − vocals; KUIELab drums and bass models run on the
  instrumental; other = instrumental − drums − bass. The stems always sum back to the original.
- `tools/reference_mdx.py` is a NumPy/onnxruntime reference implementation used to verify the browser engine
  (browser output matches it to >120 dB SNR).

## Credits
- Models: [UVR MDX-Net ONNX releases](https://github.com/TRvlvr/model_repo) (Kim Vocal 2, KUIELab drums/bass).
  Model files are split into parts under 15 MB with a `.wasm` extension so strict static hosts accept them.
- Runtime: [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) 1.22.0 (MIT).
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT).

Only process music you have the rights to use.
