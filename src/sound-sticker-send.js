// Prepare a true WhatsApp sound sticker. Enabled only with
// SOUND_STICKER_EXPERIMENTAL=true; otherwise .saudio uses the normal
// sticker + separate voice note fallback.
//
// The installed WAProto (Baileys 1.2.9 fork) cannot encode StickerMessage
// field 26 / Message field 134 yet. scripts/patch-baileys.js patches
// message building and encodeWAMessage so options.soundStickerAudio can be
// encoded into the documented wire:
// Message.134 { 1: Message { 26: StickerMessage { 24=0, 26: AudioMessage } } }
const { proto, prepareWAMessageMedia } = require("@whiskeysockets/baileys");
const pino = require("pino");

const silentLogger = pino({ level: "silent" });
const AUDIO_MIMETYPE = "audio/ogg; codecs=opus";
const MAX_AUDIO_BYTES = Number(process.env.SOUND_STICKER_MAX_AUDIO_BYTES || 900 * 1024);

function isSoundStickerEnabled() {
  return String(process.env.SOUND_STICKER_EXPERIMENTAL || "").trim().toLowerCase() === "true";
}

async function prepareSoundSticker(client, sticker, audio, audioSeconds = 0) {
  if (!isSoundStickerEnabled()) return null;
  if (!audio || audio.length > MAX_AUDIO_BYTES) return null;

  // Upload sebagai "audio/ogg" polos supaya fork Baileys tidak meng-transcode
  // ulang (konversinya mengubah mono 32k jadi stereo). Sound sticker yang
  // terbukti bunyi memakai mono 32k dari encode dua tahap. Setelah upload,
  // kembalikan mimetype wire ke codecs=opus karena klien WhatsApp butuh
  // penanda itu untuk memutar audionya.
  const media = await prepareWAMessageMedia(
    {
      audio,
      mimetype: "audio/ogg",
      ...(audioSeconds ? { seconds: audioSeconds } : {}),
    },
    { upload: client.waUploadToServer, logger: silentLogger },
  );

  if (!media?.audioMessage) return null;
  media.audioMessage.mimetype = AUDIO_MIMETYPE;

  return {
    content: { sticker },
    options: {
      soundStickerAudio: proto.Message.AudioMessage.encode(media.audioMessage).finish(),
    },
  };
}

module.exports = {
  prepareSoundSticker,
  isSoundStickerEnabled,
  AUDIO_MIMETYPE,
  MAX_AUDIO_BYTES,
};
