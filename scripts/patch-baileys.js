const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const utilsFile = path.join(
    projectRoot,
    'node_modules',
    '@whiskeysockets',
    'baileys',
    'lib',
    'Utils',
    'generics.js'
);
const file = path.join(
    projectRoot,
    'node_modules',
    '@whiskeysockets',
    'baileys',
    'lib',
    'Socket',
    'newsletter.js'
);
const messagesFile = path.join(
    projectRoot,
    'node_modules',
    '@whiskeysockets',
    'baileys',
    'lib',
    'Utils',
    'messages.js'
);

if (!fs.existsSync(file)) {
    console.log('[PATCH] File Baileys tidak ditemukan, patch dilewati.');
    process.exit(0);
}

let content = fs.readFileSync(file, 'utf8');
let changed = false;

// Fork Baileys ini otomatis follow channel/newsletter setelah connect.
// Fitur itu bikin timeout dan berisiko membuat nomor baru diblokir.
const autoJoinPattern = /\/\/ Panggil setelah koneksi WA benar-benar open\s*setTimeout\(\(\) => \{\s*console\.log\("Starting auto Connect\.\.\."\);\s*autoJoinNewsletters\(5000\);\s*\}, 5000\);/;

if (autoJoinPattern.test(content)) {
    content = content.replace(
        autoJoinPattern,
        '// Auto-join newsletter dinonaktifkan oleh scripts/patch-baileys.js'
    );
    changed = true;
}

// Security patrol melakukan query newsletter setiap 10 detik.
// Tidak diperlukan untuk bot ini dan menambah beban koneksi.
const securityPatrolPattern = /^\s*startSecurityPatrol\(\)\s*$/m;

if (securityPatrolPattern.test(content)) {
    content = content.replace(
        securityPatrolPattern,
        '    // startSecurityPatrol() dinonaktifkan oleh scripts/patch-baileys.js'
    );
    changed = true;
}

if (changed) {
    fs.writeFileSync(file, content);
    console.log('[PATCH] Fitur auto-join newsletter dan security patrol Baileys dinonaktifkan.');
} else {
    console.log('[PATCH] Baileys sudah dipatch atau pola tidak ditemukan.');
}

// Patch kirim sound sticker (eksperimen). Runtime tetap dikontrol
// SOUND_STICKER_EXPERIMENTAL; tanpa flag, encodeWAMessage langsung lewat.
let generics = fs.readFileSync(utilsFile, 'utf8');
let soundStickerChanged = false;

const encodePattern = /const encodeWAMessage = \(message\) => \(\(0, exports\.writeRandomPadMax16\)\(WAProto_1\.proto\.Message\.encode\(message\)\.finish\(\)\)\);/;

const soundWireMarker = 'const nestedSticker = Buffer.concat([';
// Versi lama sempat menghapus marker tepat setelah encode pertama. Akibatnya
// encode kedua (penerima / device sendiri) kehilangan audio sound sticker.
const staleSoundMarker = 'delete sticker.soundStickerAudio;';

if (generics.includes(soundWireMarker) && !generics.includes(staleSoundMarker)) {
    console.log('[PATCH] Sound sticker sudah dipatch (wire terbaru).');
} else {
    // Patch lama menaruh field 24/26 di level Message. Hapus dulu supaya
    // encodePattern cocok lagi saat npm run patch-baileys diulang.
    if (
        generics.includes(soundWireMarker) ||
        generics.includes(staleSoundMarker) ||
        generics.includes('const marker = sticker && sticker.soundStickerAudio;')
    ) {
        const patchedPattern = /const encodeWAMessage = \(message\) => \{[\s\S]*?\n\};\nexports\.encodeWAMessage = encodeWAMessage;/;
        generics = generics.replace(
            patchedPattern,
            'const encodeWAMessage = (message) => ((0, exports.writeRandomPadMax16)(WAProto_1.proto.Message.encode(message).finish()));\nexports.encodeWAMessage = encodeWAMessage;'
        );
        console.log('[PATCH] Patch sound sticker lama dihapus.');
    }
    if (!encodePattern.test(generics)) {
        console.warn('[PATCH] Pola encodeWAMessage tidak ditemukan; sound sticker tidak aktif.');
    } else {
    generics = generics.replace(
        encodePattern,
        `const encodeWAMessage = (message) => {
    const base = (0, exports.writeRandomPadMax16)(WAProto_1.proto.Message.encode(message).finish());
    const sticker = message && message.stickerMessage;
    const marker = sticker && sticker.soundStickerAudio;
    if (!marker || String(process.env.SOUND_STICKER_EXPERIMENTAL).trim().toLowerCase() !== 'true') return base;
    // Jangan hapus marker: objek message yang sama di-encode dua kali
    // (device sendiri + penerima). Proto mengabaikan field tak dikenal, jadi
    // cukup baca tanpa mutasi.
    try {
        const protobuf = require('protobufjs');
        const audio = protobuf.Reader.create(marker).buf;
        const padLength = base[base.length - 1];
        const padded = padLength >= 1 && padLength <= 16 ? base.subarray(0, base.length - padLength) : base;
        const decoded = WAProto_1.proto.Message.decode(padded);
        const stickerBytes = WAProto_1.proto.Message.StickerMessage.encode(decoded.stickerMessage).finish();
        const nestedSticker = Buffer.concat([
            Buffer.from(stickerBytes),
            Buffer.from(protobuf.Writer.create().uint32(192).uint32(0).finish()),
            Buffer.from(protobuf.Writer.create().uint32(210).bytes(audio).finish())
        ]);
        const nestedMessage = protobuf.Writer.create()
            .uint32(/* Message field 26 */ 210).bytes(nestedSticker)
            .finish();
        const wrapped = protobuf.Writer.create()
            .uint32(/* wrapper field 1 */ 10).bytes(nestedMessage)
            .finish();
        const sound = protobuf.Writer.create()
            .uint32(/* Message field 134 */ 1074).bytes(wrapped)
            .finish();
        const plain = WAProto_1.proto.Message.fromObject(decoded);
        delete plain.stickerMessage;
        const known = WAProto_1.proto.Message.encode(plain).finish();
        return (0, exports.writeRandomPadMax16)(Buffer.concat([known, sound]));
    } catch (err) {
        return base;
    }
};`
    );
        soundStickerChanged = true;
        fs.writeFileSync(utilsFile, generics);
        console.log('[PATCH] Sound sticker encoding aktif (field 134).');
    }
}

if (fs.existsSync(messagesFile)) {
    let messages = fs.readFileSync(messagesFile, 'utf8');
    if (messages.includes('const soundStickerAudio = options && options.soundStickerAudio;')) {
        console.log('[PATCH] Sound sticker message builder sudah dipatch.');
    } else {
        const fromObjectPattern = '    message = Types_1.WAProto.Message.fromObject(message);\n    const messageJSON = {';
        const returnPattern = '    return Types_1.WAProto.WebMessageInfo.fromObject(messageJSON);\n};\nexports.generateWAMessageFromContent = generateWAMessageFromContent;';

        if (!messages.includes(fromObjectPattern) || !messages.includes(returnPattern)) {
            console.warn('[PATCH] Pola generateWAMessageFromContent tidak ditemukan; sound sticker tidak aktif.');
        } else {
            messages = messages.replace(
                fromObjectPattern,
                '    const soundStickerAudio = options && options.soundStickerAudio;\n' +
                '    message = Types_1.WAProto.Message.fromObject(message);\n' +
                '    if (soundStickerAudio && message.stickerMessage) {\n' +
                '        message.stickerMessage.soundStickerAudio = soundStickerAudio;\n' +
                '    }\n' +
                '    const messageJSON = {'
            );
            messages = messages.replace(
                returnPattern,
                '    const result = Types_1.WAProto.WebMessageInfo.fromObject(messageJSON);\n' +
                '    if (soundStickerAudio && result.message && result.message.stickerMessage) {\n' +
                '        result.message.stickerMessage.soundStickerAudio = soundStickerAudio;\n' +
                '    }\n' +
                '    return result;\n' +
                '};\n' +
                'exports.generateWAMessageFromContent = generateWAMessageFromContent;'
            );
            fs.writeFileSync(messagesFile, messages);
            console.log('[PATCH] Sound sticker message builder aktif.');
        }
    }
}
