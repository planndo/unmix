// Audio converter worker: FFmpeg compiled to WebAssembly (ffmpeg.wasm core 0.12, single-threaded).
// Decodes almost any audio/video container and encodes MP3, WAV, FLAC, OGG Vorbis, M4A (AAC) and AIFF.
// One worker per job: the caller terminates it afterwards so WebAssembly memory is always released.
import createFFmpegCore from './vendor/ffmpeg-core.js';

let wasmBinary = null, lastDuration = 0, logTail = [];

async function fresh() {
  const ff = await createFFmpegCore({ wasmBinary, print: () => {}, printErr: () => {} });
  ff.setLogger(({ message }) => {
    logTail.push(message); if (logTail.length > 12) logTail.shift();
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(message || '');
    if (d) lastDuration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  });
  ff.setProgress(({ progress, time }) => post({ type: 'progress', value: progress > 0 && progress <= 1 ? progress : lastDuration ? time / 1e6 / lastDuration : 0 }));
  return ff;
}
const post = (m, t) => self.postMessage(m, t || []);

const FORMATS = {
  mp3:  (q) => ['-c:a', 'libmp3lame', '-b:a', `${q.bitrate || 320}k`],
  wav:  (q) => ['-c:a', q.bits === 24 ? 'pcm_s24le' : q.bits === 32 ? 'pcm_f32le' : 'pcm_s16le'],
  flac: (q) => ['-c:a', 'flac', '-compression_level', '8', ...(q.bits === 24 ? ['-sample_fmt', 's32'] : ['-sample_fmt', 's16'])],
  ogg:  (q) => ['-c:a', 'libvorbis', '-q:a', String(q.quality ?? 7)],
  m4a:  (q) => ['-c:a', 'aac', '-b:a', `${q.bitrate || 256}k`],
  aiff: (q) => ['-c:a', q.bits === 24 ? 'pcm_s24be' : 'pcm_s16be'],
};

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      wasmBinary = m.wasmBinary; // a fresh FFmpeg instance is created per job: a failed job aborts its instance
      post({ type: 'ready' });
    } else if (m.type === 'convert') {
      const inName = 'in.' + (m.ext || 'bin'), outName = 'out.' + m.format;
      lastDuration = 0; logTail = [];
      const ff = await fresh();
      ff.FS.writeFile(inName, new Uint8Array(m.data));
      const args = ['-i', inName, '-vn', '-map_metadata', '0'];
      if (m.sampleRate) args.push('-ar', String(m.sampleRate));
      if (m.channels) args.push('-ac', String(m.channels));
      args.push(...FORMATS[m.format](m.quality || {}), outName);
      ff.setTimeout(-1);
      ff.exec(...args);
      const ret = ff.ret; ff.reset();
      let out = null;
      try { out = ff.FS.readFile(outName); } catch {}
      try { ff.FS.unlink(inName); } catch {} try { ff.FS.unlink(outName); } catch {}
      if (ret !== 0 || !out || !out.length) { console.warn('[timbila] ffmpeg:', logTail.join('\n')); throw new Error('This file could not be converted. It may be damaged or use an unsupported codec.'); }
      post({ type: 'done', data: out.buffer, duration: lastDuration }, [out.buffer]);
    }
  } catch (err) {
    post({ type: 'error', message: String((err && err.message) || err) });
  }
};
