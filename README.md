# Timbila

AI vocal remover, stem splitter, noise remover and audio converter that runs entirely in the browser.
Nothing is uploaded: the AI models run on the visitor's own GPU (WebGPU) or CPU (WebAssembly).

The name comes from the *timbila*, the xylophone of the Chopi people of Mozambique: every sound on its own key.

## Tools
- **Remove vocals:** vocals and instrumental, with a mixer (faders, solo, mute, presets, loop). Fast model by default
  (UVR-MDX-NET 1, about 2.8x faster than Kim Vocal 2), studio model (Kim Vocal 2) with Plus.
- **Split stems:** vocals, drums, bass and other (KUIELab MDX-Net), instrument recognition (EfficientAT, AudioSet)
  with a Focus EQ per instrument, and Auto-mix (ITU-R BS.1770 loudness).
- **Clean audio:** mains hum removal (50/60 Hz detection and notches), spectral hiss and steady-noise reduction
  learnt from the quietest parts of the file, and RNNoise for speech. A/B listening while you adjust.
- **Convert:** any audio or video file to WAV, MP3, FLAC, M4A (AAC), OGG Vorbis or AIFF with FFmpeg (WebAssembly).

## Plans (one-time payments, Lemon Squeezy license keys)
| | Free | Plus ($5) | Pro ($9) |
|---|---|---|---|
| Vocal remover, mixer, WAV and MP3 | ✓ | ✓ | ✓ |
| 4 stems, studio model, Focus EQ, Auto-mix | listen only | ✓ | ✓ |
| FLAC, M4A, OGG, AIFF | | ✓ | ✓ |
| Noise removal download, batch convert, stem pack | listen only | | ✓ |
| Longest file | 10 min | 20 min | 60 min |

Set the checkout links in `app/config.js`. Keys are checked from the browser with the Lemon Squeezy License API
(`/v1/licenses/activate`, then `validate`); the plan is read from the product or variant name ("Plus" / "Pro") or from
`CONFIG.products`. While no checkout link is set, `TIMBILA-PLUS-DEMO` and `TIMBILA-PRO-DEMO` unlock the plans for testing.
Plan checks run in the visitor's browser, so they are a convenience lock, not DRM.

## Run locally
It is a static site:

    python3 -m http.server 8000     # open http://localhost:8000

## Deploy on GitHub Pages
Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)**.
The site appears at `https://<user>.github.io/unmix/`. `coi-serviceworker.min.js` makes the page cross-origin
isolated on Pages, which lets the CPU engine use multiple threads.

## Code
- `page.html`: the page (styles and markup). Run `./build.sh` after editing it to regenerate `index.html`.
- `app/`: `main.js` (page wiring), `studio.js`, `clean.js`, `convert.js`, `plans.js` + `config.js` (licenses), `io.js` (decode, encode, save), `ui.js`.
- `separator.js`, `worker.js`, `dsp.js`: MDX-Net separation with ONNX Runtime Web. `instruments.js`, `tag-worker.js`: instrument recognition.
- `clean-worker.js`: noise removal. `ff-worker.js`: FFmpeg converter.
- `vendor/`: RNNoise (Apache-2.0, see `vendor/rnnoise.LICENSE`), lamejs (LGPL), FFmpeg core (ffmpeg.wasm, GPL).
- `tools/`: scripts used to export and check the models.

Developed by [Pygrammer](https://www.linkedin.com/in/joseamandlate/).
