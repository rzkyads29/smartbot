const protobuf = require('protobufjs');
const { proto } = require('@whiskeysockets/baileys');

const audioBytes = proto.Message.AudioMessage.encode(proto.Message.AudioMessage.fromObject({
  url: 'audio-url', mimetype: 'audio/ogg; codecs=opus', fileLength: 123,
})).finish();
const sticker = proto.Message.StickerMessage.fromObject({ mimetype: 'image/webp', url: 'sticker-url' });
const stickerBytes = proto.Message.StickerMessage.encode(sticker).finish();
const base = proto.Message.encode(proto.Message.fromObject({
  stickerMessage: sticker,
  messageContextInfo: { deviceListMetadata: {} },
})).finish();

const nested = protobuf.Writer.create()
  .uint32(192).uint32(0)
  .uint32(210).bytes(stickerBytes)
  .uint32(210).bytes(audioBytes)
  .finish();
const wrapped = protobuf.Writer.create().uint32(10).bytes(nested).finish();
const sound = protobuf.Writer.create().uint32(1074).bytes(wrapped).finish();
const finalBytes = Buffer.concat([Buffer.from(base), Buffer.from(sound)]);

const decoded = proto.Message.decode(finalBytes);
const reader = protobuf.Reader.create(finalBytes);
let foundField134 = false;
while (reader.pos < reader.len) {
  const tag = reader.uint32();
  if ((tag >>> 3) === 134) foundField134 = true;
  reader.skipType(tag & 7);
}

if (!foundField134 || !decoded.stickerMessage || !decoded.messageContextInfo) {
  throw new Error('Sound sticker wire self-check failed');
}
console.log(JSON.stringify({ field134: foundField134, stickerKept: Boolean(decoded.stickerMessage), contextKept: Boolean(decoded.messageContextInfo) }));
