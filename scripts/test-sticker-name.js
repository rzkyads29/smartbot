const { createStickerWithAudio } = require('../src/sticker-audio');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const video = path.join(os.tmpdir(), `sound-audio-${crypto.randomBytes(3).toString('hex')}.mp4`);
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=160x160:rate=10',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '64k', video,
]);
const webp = execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
  '-vf', 'scale=128:128', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '50', '-loop', '0', '-an',
  '-f', 'webp', '-',
], { maxBuffer: 8 * 1024 * 1024 });

const { Image } = require('node-webpmux');
const { Exif } = require('wa-sticker-formatter');
(async () => {
  const img = new Image();
  await img.load(webp);
  const withExif = await new Exif({ pack: 'Nama Stiker', author: 'Nama Stiker' }).add(img);
  console.log(JSON.stringify({ webp: webp.length, withExif: withExif.length, exifMagic: withExif.includes(Buffer.from([0x49, 0x49, 0x2a, 0x00])) }));
  try { require('fs').unlinkSync(video); } catch (_) {}
})().catch((err) => { console.error(err); process.exit(1); });
