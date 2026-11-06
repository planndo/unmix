# Unmix

AI vocal remover and stem splitter that runs entirely in the browser, sold as a monthly subscription. Drop in a song,
get vocals, drums, bass and everything else as separate stems, mix them with faders or Auto-mix, and export lossless WAV.
Nothing is uploaded: the AI models run on the visitor's own GPU (WebGPU) or CPU (WebAssembly).

## Plans
| | Guest | Free account | Pro ($5/month or $39/year) |
|---|---|---|---|
| Songs | 1 per device | 5 a month | Unlimited |
| Voice + instrumental, manual mixer, presets, stem WAVs | Yes | Yes | Yes |
| 4 stems, Auto-mix, instrument recognition + Focus EQ | No | No | Yes |
| Export your mix, download everything as a zip | No | No | Yes |

Because separation happens in the browser, these limits can be bypassed by someone who edits the page's code.
Only the Free plan's monthly count and the Pro status are checked on the server.

## Pages
`index.html` landing, `pricing.html`, `signup.html`, `login.html`, `forgot.html`, `reset.html`, `account.html`,
`studio.html` (the app), `terms.html`, `privacy.html`, `404.html`.

## Before you launch
Until `config.js` is filled in, the site runs with accounts off and the studio fully open, so it is safe to deploy early.

### 1. Supabase (accounts and database)
1. Create a project at [supabase.com](https://supabase.com) and install the [Supabase CLI](https://supabase.com/docs/guides/cli).
2. `supabase link --project-ref <your-project-ref>`, then `supabase db push` to create the tables.
3. In **Authentication → URL Configuration**, set the Site URL to your site and add `<your-site>/**` to the redirect URLs.
4. In **Authentication → Emails**, set up custom SMTP. Supabase's built-in sender is heavily rate limited and not meant for production.
5. Optional: enable the Google provider, then set `googleSignIn: true` in `config.js`.
6. Put the project URL and anon key in `config.js`, plus your `supportEmail`. Never put the service role key there.

### 2. Stripe (payments)
Do all of this in test mode first.
1. Create a product called Unmix Pro with two recurring prices: $5 per month and $39 per year.
2. In **Settings → Billing → Customer portal**, enable it and allow cancelling, updating the card and switching between the two prices. The site promises all three.
3. Add a webhook endpoint pointing at `https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook` for these events:
   `customer.subscription.created`, `.updated`, `.deleted`, `.paused` and `.resumed`.
4. Decide how you will handle sales tax and VAT. If you use Stripe Tax, set `STRIPE_AUTOMATIC_TAX=true`.

### 3. Connect them
    cp supabase/.env.example supabase/.env     # fill in your keys
    supabase secrets set --env-file supabase/.env
    supabase functions deploy

Then run a test purchase with card `4242 4242 4242 4242`, cancel it in the portal, and check that the account page follows along.

### 4. Legal and content
- Replace every highlighted item in `terms.html` and `privacy.html`, have them reviewed, and remove the draft notices.
- **Confirm you may use the AI models commercially.** See Credits. The licence for Kim Vocal 2 in particular is unclear.
- If you use a custom domain, update the URLs in `robots.txt`, `sitemap.xml` and the page metadata.

## Run locally
It is a static site:

    python3 -m http.server 8000     # open http://localhost:8000

To test sign-in locally, set `EXTRA_ALLOWED_ORIGINS=http://localhost:8000` in the function secrets and add the address to Supabase's redirect URLs.

## Deploy on GitHub Pages
Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)**.
The site appears at `https://<user>.github.io/unmix/`. `coi-serviceworker.min.js` makes the studio cross-origin
isolated on Pages, which lets the CPU engine use multiple threads (about twice as fast as single-threaded).

## Editing
`page.html` is the source of the studio. After editing it, run `./build.sh` to regenerate `studio.html`.
(`page.html` is also what gets published as the Claude artifact version, whose host adds the HTML skeleton itself.)
The other pages are plain HTML sharing `site.css`, `site.js` and `auth.js`. The design system is in `.stitch/DESIGN.md`.
To change the free allowance, update `plans.js`, `free_song_limit()` in a new migration, and the copy on the pages.

## How it works
- `separator.js` downloads the runtime and models once (cached with the Cache API) and runs them in Web Workers:
  one WebGPU worker when a real GPU is available, otherwise a pool of WASM workers.
- `worker.js` + `dsp.js` implement MDX-Net inference: STFT (Bluestein FFT for the 7680-point frame) → ONNX model →
  iSTFT, processed in chunks with overlap trimming.
- Pipeline: Kim Vocal 2 extracts vocals; instrumental = mix − vocals; KUIELab drums and bass models run on the
  instrumental; other = instrumental − drums − bass. The stems always sum back to the original.
- `tools/reference_mdx.py` is a NumPy/onnxruntime reference implementation used to verify the browser engine
  (browser output matches it to >120 dB SNR).
- Billing: `create-checkout` opens Stripe Checkout; `stripe-webhook` verifies Stripe's signature and stores the current
  subscription state; `claim_song()` in Postgres atomically counts a free song. Row level security stops users changing
  any of this themselves.

## Studio features
- **Two modes:** Voice + instrumental, or 4 stems (vocals, drums, bass, other).
- **Studio mixer:** a lane per stem with volume (0-200%), solo, mute, click-to-seek and drag-to-loop.
- **Manual presets:** Karaoke, A cappella, No drums, No bass, Rhythm section.
- **Auto-mix:** measures each stem's integrated loudness (ITU-R BS.1770, LUFS) and balances the faders for a goal
  (Balanced, Vocal forward, Band focus, Karaoke, Drum practice, Bass practice) while keeping the song's overall loudness.
- **Exports:** vocals, instrumental, each stem, your current mix, or everything as a zip. 44.1 kHz 16-bit WAV.
- **Instrument recognition + Focus EQ:** an AudioSet-trained model (EfficientAT mn10) listens to the "Other" stem
  (or the instrumental) and lists what it hears (marimba, saxophone, guitar, keys, strings, brass, accordion...).
  Each one gets a Focus EQ slider: a peaking band placed where that instrument sits in this particular song.
- Tempo estimate, keyboard shortcuts, light and dark themes, works at phone width.

## Credits
- Models: [UVR MDX-Net ONNX releases](https://github.com/TRvlvr/model_repo) (Kim Vocal 2, KUIELab drums/bass).
  Model files are split into parts under 15 MB with a `.wasm` extension so strict static hosts accept them.
- Instrument recognition: [EfficientAT](https://github.com/fschmid56/EfficientAT) `mn10_as` (MIT), re-implemented
  in `tools/export_tagger.py` and exported to ONNX with its mel front end built in.
- Runtime: [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) 1.22.0 (MIT).
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT).
- [supabase-js](https://github.com/supabase/supabase-js) 2.119.0 (MIT).

Only process music you have the rights to use.
