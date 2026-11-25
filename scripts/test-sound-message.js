const { proto } = require('@whiskeysockets/baileys');
const utils = require('@whiskeysockets/baileys/lib/Utils');

process.env.SOUND_STICKER_EXPERIMENTAL = 'true';

const audioMessage = proto.Message.AudioMessage.encode(proto.Message.AudioMessage.fromObject({
  url: 'audio-url', mimetype: 'audio/ogg; codecs=opus', fileLength: 123,
})).finish();
const message = proto.Message.fromObject({
  stickerMessage: { mimetype: 'image/webp', url: 'sticker-url' },
  messageContextInfo: { deviceListMetadata: {} },
});
message.stickerMessage.soundStickerAudio = audioMessage;

const wire = utils.encodeWAMessage(message);
const raw = utils.unpadRandomMax16(wire);
const decoded = proto.Message.decode(raw);
if (!Buffer.from(raw).includes(Buffer.from([0xb2, 0x08])) || !decoded.stickerMessage) {
  throw new Error('Sound sticker encoder self-check failed');
}
console.log(JSON.stringify({
  bytes: wire.length,
  field134: true,
  stickerKept: Boolean(decoded.stickerMessage),
  markerRemoved: !message.stickerMessage.soundStickerAudio,
}));
