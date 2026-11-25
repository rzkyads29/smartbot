const { proto } = require('@whiskeysockets/baileys');
const utils = require('@whiskeysockets/baileys/lib/Utils');

process.env.SOUND_STICKER_EXPERIMENTAL = 'true';

const audioMessage = proto.Message.AudioMessage.encode(proto.Message.AudioMessage.fromObject({
  url: 'audio-url',
  mimetype: 'audio/ogg; codecs=opus',
  fileLength: 123,
})).finish();

const message = proto.Message.fromObject({
  stickerMessage: { mimetype: 'image/webp', url: 'sticker-url' },
  messageContextInfo: { deviceListMetadata: {} },
});
message.stickerMessage.soundStickerAudio = audioMessage;

const wire = utils.encodeWAMessage(message);
const raw = utils.unpadRandomMax16(wire);
const decoded = proto.Message.decode(raw);
console.log(JSON.stringify({
  bytes: wire.length,
  field134: Buffer.from(raw).includes(Buffer.from([0xb2, 0x08])),
  decodedKeys: Object.keys(decoded.toJSON()),
  // Top-level stickerMessage sengaja dibuang dari encode "known"; isi penuh
  // pindah ke field 134 (lihat scripts/test-sound-wire.js).
  stickerKept: Boolean(decoded.stickerMessage),
  markerRemoved: !message.stickerMessage.soundStickerAudio,
}));
