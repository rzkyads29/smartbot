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
const wire = utils.encodeWAMessage(message);
const raw = utils.unpadRandomMax16(wire);
if (!Buffer.from(raw).includes(Buffer.from([0xb2, 0x08]))) {
  throw new Error('field134 missing');
}
console.log(JSON.stringify({ bytes: wire.length, field134: true, markerRemoved: !message.stickerMessage.soundStickerAudio }));
