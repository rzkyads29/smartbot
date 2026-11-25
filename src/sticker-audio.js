const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { Exif } = require("wa-sticker-formatter");

const MAX_INPUT_MB = Number(process.env.STICKER_AUDIO_MAX_MB || 32);
const STICKER_SECONDS = Number(process.env.STICKER_AUDIO_SECONDS || 5);
const AUDIO_SECONDS = Number(process.env.STICKER_AUDIO_SOUND_SECONDS || 10);
const STICKER_MAX_BYTES = Number(process.env.STICKER_MAX_BYTES || 500 * 1024);

// VPS cuma 892 MB. Satu encoder jalan, yang lain ditolak supaya ffmpeg
// tidak berebut RAM dengan Chrome scraper.
let encoderBusy = false;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      if (err.code === "ENOENT") {
        return reject(new Error(`${bin} tidak ditemukan di server.`));
      }
      const detail = String(stderr || err.message || "").trim().split("\n").slice(-2).join(" ");
      reject(new Error(`${bin} gagal: ${detail}`));
    });
  });
}

// Pakai ffmpeg saja (tanpa ffprobe) supaya hanya butuh satu binary yang
// memang sudah dipakai perintah .suara.
async function hasAudioStream(filePath) {
  try {
    const { stderr } = await run("ffmpeg", [
      "-hide_banner",
      "-i", filePath,
      "-t", "1",
      "-f", "null", "-",
    ]);
    return /\bStream #\d+:\d+.*\bAudio:/i.test(stderr);
  } catch (err) {
    if (err.code === "ENOENT" || String(err.message).includes("tidak ditemukan")) throw err;
    return false;
  }
}

async function encodeSticker(videoPath, stickerPath, { seconds, fps, quality }) {
  const filter = [
    `fps=${fps}`,
    "scale=512:512:force_original_aspect_ratio=decrease",
    "format=rgba",
    "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0",
  ].join(",");

  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-nostats",
    "-threads", "1",
    "-filter_threads", "1",
    "-y",
    "-i", videoPath,
    "-t", String(seconds),
    "-an",
    "-vf", filter,
    "-c:v", "libwebp",
    "-lossless", "0",
    "-q:v", String(quality),
    "-loop", "0",
    stickerPath,
  ]);
}

async function encodeAudio(videoPath, oggPath, m4aPath) {
  const common = [
    "-hide_banner", "-loglevel", "error", "-nostats",
    "-threads", "1", "-filter_threads", "1",
    "-y", "-i", videoPath, "-t", String(AUDIO_SECONDS), "-vn", "-ac", "1",
  ];

  try {
    await run("ffmpeg", [
      ...common, "-ar", "48000", "-map", "0:a:0",
      "-c:a", "libopus", "-b:a", "48k", "-application", "voip",
      oggPath,
    ]);
    return { path: oggPath, mimetype: "audio/ogg; codecs=opus" };
  } catch (err) {
    if (String(err.message).includes("tidak ditemukan")) throw err;
    await run("ffmpeg", [
      ...common, "-ar", "44100",
      "-c:a", "aac", "-b:a", "64k",
      m4aPath,
    ]);
    return { path: m4aPath, mimetype: "audio/mp4" };
  }
}

// Rebuild animated WebP with EXIF so WhatsApp shows a sticker pack name.
async function addStickerMetadata(stickerPath, outputPath, name) {
  const image = new (require("node-webpmux").Image)();
  await image.load(stickerPath);
  const exif = await new Exif({ pack: name, author: "" }).add(image);
  await fs.promises.writeFile(outputPath, exif);
}

// Baileys computes AudioMessage.seconds with ffprobe; VPS may not have it.
// ffmpeg prints Duration during decode, so reuse its stderr as fallback.
async function probeAudioSeconds(oggPath, m4aPath) {
  const file = fs.existsSync(oggPath) ? oggPath : m4aPath;
  if (!fs.existsSync(file)) return 0;
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-f", "null", "-"]);
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (!match) return 0;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    return Number.isFinite(seconds) ? Math.max(1, Math.round(seconds)) : 0;
  } catch (err) {
    return 0;
  }
}

async function createStickerWithAudio(videoBuffer) {
  if (encoderBusy) {
    throw new Error("Masih ada proses .saudio lain. Tunggu yang ini selesai ya.");
  }

  if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) {
    throw new Error("Video kosong atau gagal diunduh.");
  }

  const sizeMb = videoBuffer.length / 1024 / 1024;
  if (sizeMb > MAX_INPUT_MB) {
    throw new Error(`Video terlalu besar (${sizeMb.toFixed(1)} MB, maks ${MAX_INPUT_MB} MB).`);
  }

  const id = crypto.randomBytes(6).toString("hex");
  const dir = os.tmpdir();
  const videoPath = path.join(dir, `saudio-${id}.mp4`);
  const stickerPath = path.join(dir, `saudio-${id}.webp`);
  const oggPath = path.join(dir, `saudio-${id}.ogg`);
  const m4aPath = path.join(dir, `saudio-${id}.m4a`);
  const namedPath = path.join(dir, `saudio-${id}-named.webp`);

  encoderBusy = true;
  try {
    fs.writeFileSync(videoPath, videoBuffer);

    if (!(await hasAudioStream(videoPath))) {
      throw new Error("Video ini tidak punya suara. Kirim video yang ada audionya ya.");
    }

    await encodeSticker(videoPath, stickerPath, {
      seconds: STICKER_SECONDS,
      fps: 10,
      quality: 45,
    });

    if (fs.statSync(stickerPath).size > STICKER_MAX_BYTES) {
      await encodeSticker(videoPath, stickerPath, {
        seconds: Math.max(2, Math.min(3, STICKER_SECONDS)),
        fps: 8,
        quality: 25,
      });
    }

    const audio = await encodeAudio(videoPath, oggPath, m4aPath);
    // AudioMessage.seconds helps WA decode sound stickers; Baileys ffprobe
    // fallback can fail on VPS without ffprobe, so supply it from ffmpeg.
    const audioSeconds = await probeAudioSeconds(oggPath, m4aPath);

    const stickerName = (process.env.STICKER_NAME || "SmartBot by RzkyAds").trim().slice(0, 24);
    await addStickerMetadata(stickerPath, namedPath, stickerName);

    return {
      sticker: fs.readFileSync(namedPath),
      audio: fs.readFileSync(audio.path),
      audioMimetype: audio.mimetype,
      stickerBytes: fs.statSync(namedPath).size,
      stickerName,
      audioSeconds,
    };
  } finally {
    encoderBusy = false;
    for (const file of [videoPath, stickerPath, oggPath, m4aPath, namedPath]) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        // File sementara mungkin belum dibuat; abaikan.
      }
    }
  }
}

module.exports = { createStickerWithAudio };
