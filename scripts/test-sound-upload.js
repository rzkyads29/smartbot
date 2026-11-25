// Local check: does prepareWAMessageMedia keep our Opus bytes intact, and how
// big is the resulting AudioMessage? Uses a fake uploader (no WA connection).
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { proto, prepareWAMessageMedia } = require('@whiskeysockets/baileys');

const dir = os.tmpdir();
const video = path.join(dir, `probe-${crypto.randomBytes(3).toString('hex')}.mp4`);
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=160x160:rate=10',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', video,
]);
const ogg = path.join(dir, `probe-${crypto.randomBytes(3).toString('hex')}.ogg`);
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
  '-t', '10', '-vn', '-ac', '1', '-ar', '48000', '-map', '0:a:0',
  '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip',
  '-map_metadata', '-1', '-f', 'ogg', ogg,
]);
const audio = fs.readFileSync(ogg);

let uploaded = null;
(async () => {
  for (const mimetype of ['audio/ogg; codecs=opus', 'audio/ogg']) {
    const media = await prepareWAMessageMedia(
      { audio, mimetype, ptt: false, seconds: 3 },
      {
        upload: async (stream) => {
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          uploaded = Buffer.concat(chunks);
          return { mediaUrl: 'https://mmg.whatsapp.net/fake', directPath: '/v/fake' };
        },
      }
    );
    const am = media.audioMessage.toJSON();
    console.log(JSON.stringify({
      requestedMimetype: mimetype,
      wireMimetype: am.mimetype,
      sourceBytes: audio.length,
      uploadedEncBytes: uploaded ? uploaded.length : null,
      fileLength: am.fileLength && (am.fileLength.low || am.fileLength),
      hasMediaKey: !!am.mediaKey,
      hasSha: !!am.fileSha256,
      seconds: am.seconds,
    }));
  }
  for (const f of [video, ogg]) { try { fs.unlinkSync(f); } catch (_) {} }
})().catch((err) => { console.error(err); process.exit(1); });
