const { proto } = require('@whiskeysockets/baileys');
const utils = require('@whiskeysockets/baileys/lib/Utils');
process.env.SOUND_STICKER_EXPERIMENTAL = 'true';

const audioBytes = proto.Message.AudioMessage.encode(proto.Message.AudioMessage.fromObject({
  url: 'audio-url', mimetype: 'audio/ogg; codecs=opus', fileLength: 123,
})).finish();
const message = proto.Message.fromObject({
  stickerMessage: { mimetype: 'image/webp', url: 'sticker-url' },
  messageContextInfo: { deviceListMetadata: {} },
});
message.stickerMessage.soundStickerAudio = audioBytes;

const hasField134 = (bytes) => {
  const reader = require('protobufjs').Reader.create(bytes);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if ((tag >>> 3) === 134) return true;
    reader.skipType(tag & 7);
  }
  return false;
};

// Baileys encode pesan yang sama dua kali (device sendiri + penerima), jadi
// encoder tidak boleh memotong marker-nya.
const first = utils.encodeWAMessage(message);
const second = utils.encodeWAMessage(message);
if (!hasField134(utils.unpadRandomMax16(first)) || !hasField134(utils.unpadRandomMax16(second))) {
  throw new Error('sound marker lost on repeated encode');
}

console.log(JSON.stringify({
  bytes: first.length,
  field134: true,
  repeatedEncodeHasField134: true,
  markerPreserved: !!message.stickerMessage.soundStickerAudio,
}));
