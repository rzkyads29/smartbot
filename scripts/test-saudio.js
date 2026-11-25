const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createStickerWithAudio } = require('../src/sticker-audio');

const dir = os.tmpdir();
const id = crypto.randomBytes(4).toString('hex');
const withAudio = path.join(dir, `saudio-test-${id}-sound.mp4`);
const silent = path.join(dir, `saudio-test-${id}-silent.mp4`);

function makeVideo(target, audio) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x160:rate=10'];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
  args.push('-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-b:a', '64k');
  args.push(target);
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
}

(async () => {
  makeVideo(withAudio, true);
  makeVideo(silent, false);

  const ok = await createStickerWithAudio(fs.readFileSync(withAudio));
  console.log('OK', JSON.stringify({
    stickerBytes: ok.sticker.length,
    stickerName: ok.stickerName,
    audioBytes: ok.audio.length,
    audioMimetype: ok.audioMimetype,
    riff: ok.sticker.subarray(0, 4).toString('ascii'),
  }));

  try {
    await createStickerWithAudio(fs.readFileSync(silent));
    throw new Error('silent video should fail');
  } catch (err) {
    if (!String(err.message).includes('tidak punya suara')) throw err;
    console.log('SILENT OK:', err.message);
  }

  try {
    await createStickerWithAudio(Buffer.alloc(33 * 1024 * 1024));
    throw new Error('oversized video should fail');
  } catch (err) {
    if (!String(err.message).includes('terlalu besar')) throw err;
    console.log('OVERSIZE OK:', err.message);
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  for (const file of [withAudio, silent]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});
