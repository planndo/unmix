// Convert: any audio or video file to WAV, MP3, FLAC, M4A, OGG or AIFF with FFmpeg (WebAssembly).
import { FORMATS, convertBytes, saveFiles, extOf, fmtBytes, baseName } from './io.js';
import * as plans from './plans.js';
import { $, toast, gate, icon, esc } from './ui.js';

const QUALITY = {
  mp3: [['320 kbps (best)', { bitrate: 320 }], ['256 kbps', { bitrate: 256 }], ['192 kbps', { bitrate: 192 }], ['128 kbps (smallest)', { bitrate: 128 }]],
  wav: [['16-bit (CD)', { bits: 16 }], ['24-bit (studio)', { bits: 24 }], ['32-bit float', { bits: 32 }]],
  flac: [['16-bit (CD)', { bits: 16 }], ['24-bit (studio)', { bits: 24 }]],
  m4a: [['256 kbps (best)', { bitrate: 256 }], ['192 kbps', { bitrate: 192 }], ['128 kbps (smallest)', { bitrate: 128 }]],
  ogg: [['Very high (q9)', { quality: 9 }], ['High (q7)', { quality: 7 }], ['Medium (q5)', { quality: 5 }], ['Small (q3)', { quality: 3 }]],
  aiff: [['16-bit (CD)', { bits: 16 }], ['24-bit (studio)', { bits: 24 }]],
};
const V = { files: [], format: 'mp3', running: false };
let ffLoaded = false;

export function init() {}
export function start(files) { V.files = []; add(files); }
export function add(files) {
  for (const f of files) V.files.push({ file: f, id: Math.random().toString(36).slice(2), status: 'Ready', cls: '', prog: 0 });
  renderList(); renderFormats(); syncRun();
}
export function stop() { V.files = []; }

function renderList() {
  const box = $('vList');
  if (!V.files.length) { box.innerHTML = '<p class="hint">No files yet. Use “Add files” or drop them anywhere on the page.</p>'; return; }
  box.innerHTML = V.files.map((x) => `
    <div class="file" data-id="${x.id}">
      <span class="ext">${esc(extOf(x.file.name).slice(0, 4))}</span>
      <div style="min-width:0"><div class="nm" title="${esc(x.file.name)}">${esc(x.file.name)}</div><div class="sub">${fmtBytes(x.file.size)}</div><div class="mini"><i style="width:${x.prog * 100}%"></i></div></div>
      <div style="display:flex;align-items:center;gap:6px"><span class="st ${x.cls}">${esc(x.status)}</span>${V.running ? '' : `<button class="x" type="button" aria-label="Remove ${esc(x.file.name)}">${icon('x').replace('<svg', '<svg style="width:14px;height:14px"')}</button>`}</div>
    </div>`).join('');
  $('vMeta').innerHTML = `<span class="pill mono">${V.files.length} file${V.files.length > 1 ? 's' : ''}</span><span class="pill mono">${fmtBytes(V.files.reduce((s, x) => s + x.file.size, 0))}</span>`;
  $('vTitle').textContent = V.files.length === 1 ? baseName(V.files[0].file.name) : 'Convert audio';
}
$('vList').onclick = (e) => { const b = e.target.closest('.x'); if (!b) return; const id = b.closest('.file').dataset.id; V.files = V.files.filter((x) => x.id !== id); renderList(); syncRun(); };
function setRow(x) {
  const el = document.querySelector(`.file[data-id="${x.id}"]`); if (!el) return;
  el.querySelector('.st').textContent = x.status; el.querySelector('.st').className = `st ${x.cls}`; el.querySelector('.mini i').style.width = `${x.prog * 100}%`;
}

function renderFormats() {
  $('vFormats').innerHTML = Object.entries(FORMATS).map(([k, f]) => `
    <button type="button" class="fcard" data-f="${k}" aria-pressed="${k === V.format}"><b>${f.label}</b><small>${f.note}</small>${f.tier !== 'free' && !plans.has('formats') ? `<span class="tag plus">${icon('lock')}Plus</span>` : ''}</button>`).join('');
  const q = $('vQuality'); const cur = q.value;
  q.innerHTML = QUALITY[V.format].map(([l], i) => `<option value="${i}">${l}</option>`).join('');
  if (cur && +cur < QUALITY[V.format].length) q.value = cur;
  $('vBatchTag').hidden = plans.has('batch');
}
$('vFormats').onclick = (e) => {
  const b = e.target.closest('[data-f]'); if (!b) return; const k = b.dataset.f;
  const pick = () => { V.format = k; renderFormats(); syncRun(); };
  FORMATS[k].tier !== 'free' ? gate('formats', pick) : pick();
};
function syncRun() {
  const n = V.files.length;
  $('vRun').disabled = !n || V.running;
  $('vRunLbl').textContent = V.running ? 'Converting…' : n > 1 ? `Convert ${n} files to ${FORMATS[V.format].label}` : `Convert to ${FORMATS[V.format].label}`;
}
plans.onChange(() => { renderFormats(); syncRun(); });

$('vRun').onclick = () => {
  if (!V.files.length) return;
  const go = () => (FORMATS[V.format].tier !== 'free' ? gate('formats', run) : run());
  V.files.length > 1 ? gate('batch', go) : go();
};
async function run() {
  if (V.running) return; V.running = true; syncRun(); renderList();
  const fmt = V.format, opts = QUALITY[fmt][+$('vQuality').value || 0][1];
  const sampleRate = +$('vRate').value || undefined, channels = +$('vCh').value || undefined;
  const out = []; let failed = 0;
  try {
    for (const x of V.files) {
      x.status = ffLoaded ? 'Converting' : 'Loading converter'; x.cls = ''; x.prog = 0; setRow(x);
      let got = 0;
      try {
        const blob = await convertBytes(await x.file.arrayBuffer(), extOf(x.file.name), fmt, {
          quality: opts, sampleRate, channels,
          onBytes: (n) => { got += n; x.status = `Loading converter ${Math.round(got / 1e6)} MB`; setRow(x); },
          onProgress: (p) => { ffLoaded = true; x.prog = p; x.status = `${Math.round(p * 100)}%`; setRow(x); },
        });
        ffLoaded = true;
        x.prog = 1; x.status = `Done · ${fmtBytes(blob.size)}`; x.cls = 'ok'; setRow(x);
        out.push([`${baseName(x.file.name)}.${FORMATS[fmt].ext}`, blob]);
      } catch (e) { failed++; x.status = 'Could not convert'; x.cls = 'err'; x.prog = 0; setRow(x); console.warn('[timbila] convert', x.file.name, e); }
    }
    if (out.length) {
      // avoid duplicate names inside a zip
      const seen = {}; for (const f of out) { const n = f[0]; if (seen[n]) { seen[n]++; f[0] = n.replace(/(\.[^.]+)$/, ` (${seen[n]})$1`); } else seen[n] = 1; }
      await saveFiles(out, `Timbila ${FORMATS[fmt].label}`);
      toast(failed ? `${out.length} converted, ${failed} could not be read` : out.length > 1 ? `${out.length} files converted` : 'Converted. Download ready');
    } else toast('These files could not be converted. They may be damaged or use an unusual codec.');
  } catch (e) { if (e?.code === 'declined') toast('Download cancelled'); else toast(`Could not save: ${e?.message || e}`); }
  finally { V.running = false; syncRun(); renderList(); V.files.forEach(setRow); }
}
