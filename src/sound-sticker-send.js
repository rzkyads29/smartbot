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

const AUDIO_MIMETYPE = "audio/ogg; codecs=opus";
const MAX_AUDIO_BYTES = Number(process.env.SOUND_STICKER_MAX_AUDIO_BYTES || 900 * 1024);

function isSoundStickerEnabled() {
  return String(process.env.SOUND_STICKER_EXPERIMENTAL || "").trim().toLowerCase() === "true";
}

async function prepareSoundSticker(client, sticker, audio) {
  if (!isSoundStickerEnabled()) return null;
  if (!audio || audio.length > MAX_AUDIO_BYTES) return null;

  const media = await prepareWAMessageMedia(
    { audio, mimetype: AUDIO_MIMETYPE, ptt: false },
    { upload: client.waUploadToServer }
  );

  if (!media?.audioMessage) return null;

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
