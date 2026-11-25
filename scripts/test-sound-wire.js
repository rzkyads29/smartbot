const protobuf = require('protobufjs');
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

const raw = utils.unpadRandomMax16(utils.encodeWAMessage(message));
const reader = protobuf.Reader.create(raw);
let wrapped;
while (reader.pos < reader.len) {
  const tag = reader.uint32();
  const field = tag >>> 3;
  const wire = tag & 7;
  if (field === 134) wrapped = reader.bytes();
  else reader.skipType(wire);
}
if (!wrapped) throw new Error('field134 missing');
const outer = protobuf.Reader.create(wrapped);
if ((outer.uint32() >>> 3) !== 1) throw new Error('wrapper field 1 missing');
const inner = protobuf.Reader.create(outer.bytes());
if ((inner.uint32() >>> 3) !== 26) throw new Error('sticker field 26 missing');
const stickerBytes = inner.bytes();
const sr = protobuf.Reader.create(stickerBytes);
const fields = [];
while (sr.pos < sr.len) {
  const tag = sr.uint32();
  const field = tag >>> 3;
  const wire = tag & 7;
  if (wire === 0) fields.push({ field, wire, value: sr.uint64().toString() });
  else if (wire === 2) { const n = sr.uint32(); sr.pos += n; fields.push({ field, wire, length: n }); }
  else throw new Error(`bad sticker field ${field} wire ${wire}`);
}
const audio = fields.filter((entry) => entry.field === 26);
const flag = fields.find((entry) => entry.field === 24);
if (audio.length !== 1 || !flag || flag.value !== '0') throw new Error(`bad fields ${JSON.stringify(fields)}`);
console.log(JSON.stringify({ field134: true, audioCount: audio.length, flag: flag.value, wireBytes: raw.length }));
