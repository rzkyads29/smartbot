const { loadData, saveData } = require("./database");
const {
  checkPortal,
  announceAbsen,
  getLastUsedAccount,
} = require("./ethol-scraper");
const { GoogleGenAI } = require("@google/genai");
const googleTTS = require("google-tts-api");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { checkKasAndSend, sendKasRekap } = require("./kas-tricendes/kas-checker");
const { backupDatabase } = require("./backup");
const { buildBotStatusMessage } = require("./bot-status");
const {
  areReactionsEnabled,
  capMentions,
  getCommandName,
  isCommandAllowedInChat,
  isFatalSendError,
  isSafeModeBlockedCommand,
} = require("./chat-guard");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.7-flash";

const blockedGroupLogAt = new Map();
const safeModeNoticeAt = new Map();
const safeModeBlockLogAt = new Map();
const BLOCKED_GROUP_LOG_INTERVAL_MS = 5 * 60 * 1000;
const SAFE_MODE_NOTICE_INTERVAL_MS = 10 * 60 * 1000;
const SAFE_MODE_BLOCK_LOG_INTERVAL_MS = 60 * 1000;

function logBlockedGroup(chatId, preview) {
  const now = Date.now();
  const last = blockedGroupLogAt.get(chatId) || 0;
  if (now - last < BLOCKED_GROUP_LOG_INTERVAL_MS) return;
  blockedGroupLogAt.set(chatId, now);
  const safePreview = String(preview || "").replace(/\s+/g, " ").slice(0, 80);
  console.log(`[GUARD] Grup ${chatId} diabaikan (tidak ada di allowlist / ada di denylist). Preview: ${safePreview || "(media/kosong)"}`);
}

function logBlockedCommand(chatId, command) {
  const now = Date.now();
  const key = `${chatId}:${command}`;
  const last = safeModeBlockLogAt.get(key) || 0;
  if (now - last < SAFE_MODE_BLOCK_LOG_INTERVAL_MS) return;
  safeModeBlockLogAt.set(key, now);
  console.log(`[SAFE_MODE] Perintah ${command} dari ${chatId} diblokir.`);
}

async function sendSafeModeNotice(client, chatId, rawMsg) {
  const now = Date.now();
  const last = safeModeNoticeAt.get(chatId) || 0;
  if (now - last < SAFE_MODE_NOTICE_INTERVAL_MS) return;
  safeModeNoticeAt.set(chatId, now);
  const text = "🛡️ *Mode aman aktif.* Perintah media/pengiriman massal dimatikan sementara. Bot hanya membalas command seperti *.menu*, *.jadwal*, dan *.tugas*.";
  await client.sendMessage(chatId, { text }, { quoted: rawMsg }).catch((err) => {
    console.error(`[SAFE_MODE] Gagal mengirim notice ke ${chatId}:`, err?.message || err);
  });
}

function getMenuStyle() {
  const style = (process.env.MENU_STYLE || "buttons").trim().toLowerCase();
  return style === "list" || style === "single_select" ? "list" : "buttons";
}

function isButtonMenuEnabledForChat(chatId) {
  const enabled = (process.env.ENABLE_BUTTONS || "").trim().toLowerCase() === "true";
  if (!enabled) return false;

  const testGroup = (process.env.BUTTONS_TEST_GROUP_ID || "").trim();
  return !testGroup || testGroup === chatId;
}

function buildButtonMenuContent(header, title, footer, buttons) {
  return {
    interactiveMessage: {
      header,
      title,
      footer,
      buttons: buttons.map(([displayText, id]) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: displayText, id }),
      })),
    },
  };
}

function buildClassicListContent(header, title, footer, buttonText, sections) {
  return {
    header,
    title,
    footer,
    buttonText,
    sections: sections.map((section) => ({
      title: section.title,
      rows: section.rows.map((row) => ({
        title: row.title,
        description: row.description || "",
        rowId: row.id,
      })),
    })),
  };
}

// Daftar menu klasik (ListMessage) kompatibel iPhone dan Android.
// Native flow single_select hanya tampil di Android, jadi jangan dipakai
// untuk menu list utama.
async function sendClassicListMenu(client, chatId, content) {
  return client.sendMessage(
    chatId,
    {
      text: content.title,
      title: content.header,
      footer: content.footer,
      buttonText: content.buttonText,
      sections: content.sections,
    },
    {
      additionalNodes: [
        {
          tag: "biz",
          attrs: {},
          content: [{ tag: "list", attrs: { type: "product_list", v: "2" } }],
        },
      ],
    }
  );
}

// WhatsApp classic list maksimal 10 baris total. Saat ini 4 + 3 + 3 = 10.
const MAIN_MENU_SECTIONS = [
  {
    title: "📚 Akademik",
    rows: [
      { title: "📚 Jadwal", description: "Jadwal kuliah minggu ini", id: ".jadwal" },
      { title: "📝 Tugas", description: "Daftar tugas dan deadline", id: ".tugas" },
      { title: "📊 Rekap Absen", description: "Rekap absensi minggu ini", id: ".allabsensi" },
      { title: "📅 Cek Jadwal Hari Ini", description: "Jadwal aktif hari ini", id: ".cekjadwal" },
    ],
  },
  {
    title: "🎮 Hiburan",
    rows: [
      { title: "🧩 Susun Kata", description: "Main tebak kata di grup", id: ".susunkata" },
      { title: "🎭 Truth or Dare", description: "Main truth or dare", id: ".truth" },
      { title: "🍀 Cek Hoki", description: "Cek persentase hoki hari ini", id: ".cekhoki" },
    ],
  },
  {
    title: "ℹ️ Info Bot",
    rows: [
      { title: "📊 Status Bot", description: "Cek kesehatan dan uptime bot", id: ".status" },
      { title: "📋 Menu Lengkap", description: "Daftar semua fitur bot", id: ".help" },
      { title: "👑 Info Owner", description: "Info kontak owner bot", id: ".owner" },
    ],
  },
];

const CATEGORY_MENUS = {
  ".menu_akademik": {
    header: "📚 MENU AKADEMIK",
    title: "Pilih menu akademik:\n\n• Jadwal kuliah\n• Daftar tugas\n• Rekap absen",
    footer: "Ketik .menu untuk kembali ke menu utama",
    buttons: [
      ["📚 Jadwal", ".jadwal"],
      ["📝 Tugas", ".tugas"],
      ["📊 Rekap Absen", ".allabsensi"],
    ],
    rows: [
      { title: "📚 Jadwal", description: "Jadwal kuliah minggu ini", id: ".jadwal" },
      { title: "📝 Tugas", description: "Daftar tugas dan deadline", id: ".tugas" },
      { title: "📊 Rekap Absen", description: "Rekap absensi minggu ini", id: ".allabsensi" },
      { title: "📅 Cek Jadwal Hari Ini", description: "Jadwal aktif hari ini", id: ".cekjadwal" },
    ],
    fallbackText: `📚 *MENU AKADEMIK*

1. *.jadwal* — jadwal kuliah
2. *.tugas* — daftar tugas
3. *.allabsensi* — rekap absen

Ketik *.menu* untuk kembali.`,
  },
  ".menu_hiburan": {
    header: "🎮 MENU HIBURAN",
    title: "Pilih menu hiburan:\n\n• Game baru: tebak angka, kuis, family 100\n• Klasik: susun kata, truth or dare, cek hoki",
    footer: "Ketik .menu untuk kembali ke menu utama",
    buttons: [
      ["🔢 Tebak Angka", ".tebakangka"],
      ["🧠 Kuis", ".kuis"],
      ["👨‍👩‍👧 Family 100", ".family100"],
    ],
    rows: [
      { title: "🔢 Tebak Angka", description: "Tebak angka 1-100 dengan petunjuk", id: ".tebakangka" },
      { title: "🧠 Kuis", description: "Kuis pilihan ganda", id: ".kuis" },
      { title: "👨‍👩‍👧 Family 100", description: "Tebak jawaban populer", id: ".family100" },
      { title: "✊ Suit", description: "Gunting batu kertas lawan bot", id: ".suit" },
      { title: "🎲 Dadu", description: "Lempar dua dadu", id: ".dadu" },
      { title: "🎰 Slot", description: "Coba keberuntunganmu", id: ".slot" },
      { title: "🧩 Susun Kata", description: "Main tebak kata di grup", id: ".susunkata" },
      { title: "🎵 Tebak Lagu", description: "Tebak judul lagu dari lirik", id: ".tebaklagu" },
      { title: "🏆 Top Koin", description: "Papan peringkat koin", id: ".topkoin" },
      { title: "🎭 Truth or Dare", description: "Main truth or dare", id: ".truth" },
    ],
    fallbackText: `🎮 *MENU HIBURAN*

*Game baru:*
1. *.tebakangka* — tebak angka 1-100
2. *.kuis* — kuis pilihan ganda
3. *.family100* — tebak jawaban populer
4. *.suit <batu|gunting|kertas>* — suit lawan bot
5. *.dadu* — lempar dadu
6. *.slot* — slot machine

*Klasik:*
7. *.susunkata* — susun kata
8. *.tebaklagu* — tebak judul lagu
9. *.cekhoki* — cek hoki

*Koin:*
10. *.koin* — lihat koin kamu
11. *.topkoin* — papan peringkat

Ketik *.menu* untuk kembali.`,
  },
  ".menu_info": {
    header: "ℹ️ INFO BOT",
    title: "Pilih menu info:\n\n• Status dan uptime bot\n• Daftar semua fitur\n• Info owner",
    footer: "SMARTBOT by RzkyAds | Ketik .menu untuk kembali",
    buttons: [
      ["📊 Status Bot", ".status"],
      ["⏱️ Runtime", ".runtime"],
      ["📋 Menu Lengkap", ".help"],
    ],
    rows: [
      { title: "📊 Status Bot", description: "Kesehatan bot, RAM, dan sync (khusus admin)", id: ".status" },
      { title: "⏱️ Runtime", description: "Lihat uptime bot", id: ".runtime" },
      { title: "📋 Menu Lengkap", description: "Daftar semua fitur bot", id: ".help" },
      { title: "👑 Info Owner", description: "Info kontak owner bot", id: ".owner" },
      { title: "⬅️ Menu Utama", description: "Kembali ke menu utama", id: ".menu" },
    ],
    fallbackText: `ℹ️ *INFO BOT*

1. *.status* — status bot (khusus admin)
2. *.runtime* — uptime bot
3. *.help* — menu lengkap
4. *.owner* — info owner bot
5. *.menu* — menu utama`,
  },
};

// Chrome dipakai untuk .meme/.nulis. Di VPS RAM kecil, hanya boleh satu
// proses sekaligus dan browser harus selalu ditutup walau rendering gagal.
let mediaBrowserBusy = false;

async function withMediaBrowser(render) {
  if (mediaBrowserBusy) {
    throw new Error("Fitur gambar sedang dipakai proses lain. Coba lagi sebentar ya.");
  }
  mediaBrowserBusy = true;
  const puppeteer = require("puppeteer");
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    return await render(page);
  } finally {
    mediaBrowserBusy = false;
    if (browser) await browser.close().catch(() => {});
  }
}

async function createMeme(base64Image, mimetype, topText, bottomText) {
  return withMediaBrowser(async (page) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@700&display=swap');
            body { margin: 0; display: inline-block; background: transparent; }
            .container { position: relative; display: inline-block; }
            img { max-width: 800px; display: block; }
            .text {
                position: absolute;
                left: 50%;
                transform: translateX(-50%);
                font-family: 'Impact', 'Oswald', sans-serif;
                font-size: 40px;
                font-weight: bold;
                color: white;
                text-align: center;
                text-transform: uppercase;
                text-shadow: 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 0 2px 0 #000, 2px 0 0 #000, 0 -2px 0 #000, -2px 0 0 #000;
                width: 90%;
                word-wrap: break-word;
            }
            .top { top: 10px; }
            .bottom { bottom: 10px; }
        </style>
    </head>
    <body>
        <div class="container" id="capture">
            <img src="data:${mimetype};base64,${base64Image}">
            <div class="text top">${topText}</div>
            <div class="text bottom">${bottomText}</div>
        </div>
    </body>
    </html>
    `;
  await page.setContent(html, { waitUntil: "networkidle0" });
  const element = await page.$("#capture");
  return element.screenshot({ encoding: "base64" });
  });
}

async function createNulis(teks) {
  return withMediaBrowser(async (page) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Caveat:wght@600&display=swap');
            body {
                margin: 0;
                padding: 0;
                background-color: #fdfdfd;
                width: 600px;
                height: 800px;
                position: relative;
            }
            .paper {
                width: 100%;
                height: 100%;
                background-image: linear-gradient(#999 1px, transparent 1px);
                background-size: 100% 30px;
                background-position: 0 40px;
            }
            .margin-line {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 60px;
                width: 2px;
                background-color: #ffaaaa;
            }
            .content {
                position: absolute;
                top: 40px;
                left: 75px;
                right: 20px;
                font-family: 'Caveat', cursive;
                font-size: 26px;
                line-height: 30px;
                color: #1a237e; /* Ink blue */
                white-space: pre-wrap;
                word-wrap: break-word;
                letter-spacing: 1px;
            }
        </style>
    </head>
    <body>
        <div class="paper" id="capture">
            <div class="margin-line"></div>
            <div class="content">${teks.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
        </div>
    </body>
    </html>
    `;
  await page.setContent(html, { waitUntil: "networkidle0" });
  const element = await page.$("body");
  return element.screenshot({ encoding: "base64" });
  });
}

// Inisialisasi AI dengan sistem Multiple API Keys (Fallback)
let apiKeys = [];
if (process.env.GEMINI_API_KEYS) {
  apiKeys = process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(k => k);
} else if (process.env.GEMINI_API_KEY) {
  apiKeys = [process.env.GEMINI_API_KEY.trim()];
}

let currentKeyIndex = 0;
let ai = null;
if (apiKeys.length > 0) {
  ai = new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
}

// Wrapper cerdas untuk generateContent dengan fallback API key dan model.
const generateAIContent = async (params) => {
  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter(
    (model, index, list) => model && list.indexOf(model) === index
  );
  const maxAttempts = Math.max(3, apiKeys.length);
  let lastError;

  for (const model of models) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (!ai) ai = new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
        return await ai.models.generateContent({ ...params, model });
      } catch (err) {
        lastError = err;
        const message = String(err?.message || err);

        if (message.includes("429") && apiKeys.length > 1) {
          currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
          console.log(`[AI] Kuota 429 limit! Pindah ke API Key cadangan #${currentKeyIndex + 1}...`);
          ai = new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
          continue;
        }

        const retryable =
          message.includes("503") ||
          message.includes("UNAVAILABLE") ||
          message.includes("high demand");

        if (retryable && attempt < 2) {
          const delay = 3000 * (attempt + 1);
          console.log(`[AI] Model ${model} sedang sibuk. Retry ${attempt + 1}/2 dalam ${delay / 1000} detik...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        break;
      }
    }
  }

  throw lastError;
};

// State untuk menyimpan sesi game grup
const activeGames = {};

// Koin game disimpan di absensi_data.json -> data.koin[userId].
function awardKoin(userId, min = 5, max = 15) {
  if (!userId) return 0;
  const amount = Math.floor(Math.random() * (max - min + 1)) + min;
  const data = loadData();
  if (!data.koin || typeof data.koin !== "object") data.koin = {};
  data.koin[userId] = (data.koin[userId] || 0) + amount;
  saveData(data);
  return amount;
}

function getKoin(userId) {
  if (!userId) return 0;
  const data = loadData();
  return Number((data.koin && data.koin[userId]) || 0);
}

// Soal kuis: jawaban = index opsi yang benar.
const KUIS_BANK = [
  { soal: "Ibukota Indonesia adalah?", opsi: ["Jakarta", "Bandung", "Surabaya", "Medan"], jawaban: 0 },
  { soal: "Hasil dari 7 x 8 adalah?", opsi: ["54", "56", "58", "64"], jawaban: 1 },
  { soal: "Planet terdekat dari Matahari adalah?", opsi: ["Venus", "Bumi", "Merkurius", "Mars"], jawaban: 2 },
  { soal: "Siapa penemu lampu pijar?", opsi: ["Nikola Tesla", "Thomas Edison", "Albert Einstein", "Isaac Newton"], jawaban: 1 },
  { soal: "Bahasa pemrograman yang identik dengan web adalah?", opsi: ["Python", "JavaScript", "C++", "Java"], jawaban: 1 },
  { soal: "Jumlah pemain sepak bola satu tim di lapangan?", opsi: ["9", "10", "11", "12"], jawaban: 2 },
  { soal: "Air membeku pada suhu?", opsi: ["0 derajat C", "10 derajat C", "-10 derajat C", "100 derajat C"], jawaban: 0 },
  { soal: "Kota yang dijuluki Kota Pahlawan?", opsi: ["Surabaya", "Malang", "Semarang", "Bandung"], jawaban: 0 },
  { soal: "Siapa proklamator kemerdekaan Indonesia selain Soekarno?", opsi: ["Moh. Hatta", "Soeharto", "Sutan Sjahrir", "Tan Malaka"], jawaban: 0 },
  { soal: "1 GB sama dengan berapa MB?", opsi: ["100", "512", "1024", "2048"], jawaban: 2 },
];

// Family 100: tebakan populer (dibandingkan huruf kecil semua).
const FAMILY100_BANK = [
  {
    soal: "Sebutkan hal yang biasa dibawa mahasiswa ke kampus!",
    jawaban: ["tas", "laptop", "buku", "ponsel", "botol minum", "dompet", "charger", "jaket"],
  },
  {
    soal: "Sebutkan makanan khas Indonesia!",
    jawaban: ["nasi goreng", "rendang", "sate", "bakso", "soto", "gado-gado", "nasi padang", "martabak"],
  },
  {
    soal: "Sebutkan aplikasi yang sering dipakai mahasiswa!",
    jawaban: ["whatsapp", "instagram", "tiktok", "youtube", "google", "shopee", "spotify", "twitter"],
  },
  {
    soal: "Sebutkan hal yang bikin mahasiswa stres!",
    jawaban: ["tugas", "deadline", "ujian", "dosen", "nilai", "skripsi", "revisi", "uang"],
  },
  {
    soal: "Sebutkan kegiatan saat akhir pekan!",
    jawaban: ["tidur", "nonton", "main game", "jalan-jalan", "olahraga", "belanja", "nongkrong", "belajar"],
  },
];

const SUIT_BEATS = { batu: "gunting", gunting: "kertas", kertas: "batu" };
const SLOT_SYMBOLS = ["🍒", "🍋", "🍇", "🔔", "💎", "7️⃣"];

// State untuk anti-spam
const userCooldowns = new Map();
const COOLDOWN_MS = 3000; // 3 detik

// State untuk menyimpan memori percakapan Agentic (maks 15 pesan per chat)
const chatMemory = new Map();

async function handleMessage(client, rawMsg, reloadScheduler = null) {
  if (!rawMsg.message) return;
  const _chatId = rawMsg.key?.remoteJid || '';
  const _senderId = rawMsg.key?.participant || _chatId;
  const _isGroup = _chatId.endsWith('@g.us');

  // Jangan pernah membalas status, broadcast, atau newsletter.
  if (!_chatId || _chatId === 'status@broadcast' || _chatId.endsWith('@newsletter') || _chatId.endsWith('@broadcast')) {
    return;
  }

  const isInteractiveResponse = !!(
    rawMsg.message.interactiveResponseMessage ||
    rawMsg.message.buttonsResponseMessage ||
    rawMsg.message.listResponseMessage ||
    rawMsg.message.templateButtonReplyMessage
  );

  let bodyText = '';
  if (rawMsg.message) {
    if (rawMsg.message.conversation) bodyText = rawMsg.message.conversation;
    else if (rawMsg.message.extendedTextMessage) bodyText = rawMsg.message.extendedTextMessage.text;
    else if (rawMsg.message.imageMessage) bodyText = rawMsg.message.imageMessage.caption || '';
    else if (rawMsg.message.videoMessage) bodyText = rawMsg.message.videoMessage.caption || '';
    else if (rawMsg.message.buttonsResponseMessage) bodyText = rawMsg.message.buttonsResponseMessage.selectedButtonId;
    else if (rawMsg.message.listResponseMessage) bodyText = rawMsg.message.listResponseMessage.singleSelectReply.selectedRowId;
    else if (rawMsg.message.templateButtonReplyMessage) bodyText = rawMsg.message.templateButtonReplyMessage.selectedId;
    else if (rawMsg.message.interactiveResponseMessage) {
      const paramsJson = rawMsg.message.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson;
      if (paramsJson) {
        try {
          const parsed = JSON.parse(paramsJson);
          bodyText = parsed.id || parsed.selectedId || parsed.rowId || parsed.selectedRowId || "";
        } catch (e) { }
      }
    }
  }

  if (isInteractiveResponse) {
    console.log(`[BUTTONS] Respons tombol dari ${_senderId}: ${bodyText || "(kosong)"}`);
  }

  // Guard grup: fail-closed saat SAFE_MODE, plus denylist grup bermasalah.
  if (_isGroup && !isCommandAllowedInChat(_chatId)) {
    logBlockedGroup(_chatId, bodyText);
    return;
  }

  const isCommand = bodyText.startsWith('.');

  if (isCommand) {
    console.log(`[CMD] chat=${_chatId} sender=${_senderId} cmd=${bodyText.slice(0, 80)}`);
    if (isSafeModeBlockedCommand(bodyText)) {
      logBlockedCommand(_chatId, getCommandName(bodyText));
      await sendSafeModeNotice(client, _chatId, rawMsg);
      return;
    }
  }

  // Simpan pesan ke memori pasif
  if (bodyText && bodyText.trim().length > 0 && bodyText.length < 500) {
    if (!chatMemory.has(_chatId)) chatMemory.set(_chatId, []);
    const history = chatMemory.get(_chatId);
    
    let senderName = rawMsg.pushName || (_senderId ? _senderId.split('@')[0] : "User");
    let isBot = rawMsg.key.fromMe;
    
    history.push(`[${isBot ? 'Bot' : senderName}]: ${bodyText}`);
    
    if (history.length > 15) {
        history.shift(); // Buang pesan paling lama
    }
  }

  // Anti-Spam Check (respons tombol/list tidak perlu cooldown)
  if (isCommand && !isInteractiveResponse) {
    const now = Date.now();
    const lastTime = userCooldowns.get(_senderId) || 0;
    
    if (now - lastTime < COOLDOWN_MS) {
      // Jika jarak spam lebih dari 500ms (untuk menghindari loop peringatan berkali-kali)
      if (now - lastTime > 500) {
        await client.sendMessage(_chatId, { text: "⏳ *Woah, pelan-pelan!* Sistem mendeteksi Spam. Silakan tunggu 3 detik sebelum menggunakan perintah bot lagi." }, { quoted: rawMsg });
        // Reset waktu agar hukuman bertambah jika dia nge-spam lagi
        userCooldowns.set(_senderId, now); 
      }
      return; // Abaikan pesannya
    }
    userCooldowns.set(_senderId, now);
    
    // Smart React: Tanda Sedang Diproses (Hanya di Grup untuk menghindari error E2E)
    if (_isGroup && areReactionsEnabled()) {
      await client.sendMessage(_chatId, { react: { text: "⏳", key: rawMsg.key } }).catch(()=>{});
    }
  }

  const fakeVerif = {
    key: {
      id: '12345678901234567890123456789012',
      fromMe: false,
      participant: '0@s.whatsapp.net',
      ...(rawMsg.key.remoteJid ? { remoteJid: rawMsg.key.remoteJid } : {})
    },
    message: {
      conversation: "SMARTBOT by RzkyAds"
    }
  };

  const msg = {
    from: _chatId,
    author: _senderId,
    body: bodyText,
    timestamp: rawMsg.messageTimestamp,
    hasMedia: !!(rawMsg.message && (rawMsg.message.imageMessage || rawMsg.message.videoMessage || rawMsg.message.documentMessage)),
    hasQuotedMsg: !!(rawMsg.message?.extendedTextMessage?.contextInfo?.quotedMessage),

    reply: async (content) => {
      const options = _isGroup ? { quoted: fakeVerif } : {};
      if (typeof content === 'string') {
        return await client.sendMessage(_chatId, { text: content }, options);
      } else {
        return await client.sendMessage(_chatId, content, options);
      }
    },

    react: async (emoji) => {
      if (!areReactionsEnabled()) return null;
      return await client.sendMessage(_chatId, { react: { text: emoji, key: rawMsg.key } });
    },

    getChat: async () => {
      return {
        isGroup: _isGroup,
        sendStateTyping: async () => {
          // Cukup 'composing'; 'available' sebelumnya dikirim terpisah dan
          // hanya menambah satu stanza keluar untuk setiap balasan.
          if (_isGroup) await client.sendPresenceUpdate('composing', _chatId).catch(()=>{});
        },
        sendStateRecording: async () => {
          if (_isGroup) await client.sendPresenceUpdate('recording', _chatId).catch(()=>{});
        },
        clearState: async () => {
          if (_isGroup) await client.sendPresenceUpdate('paused', _chatId).catch(()=>{});
        }
      };
    },

    // Dipanggil hanya oleh command yang benar-benar butuh daftar anggota.
    // Reply/typing tidak perlu groupMetadata, jadi query-nya tidak dilakukan
    // untuk setiap balasan (ini mengurangi beban koneksi dan risiko timeout).
    getParticipants: async () => {
      if (!_isGroup) return [];
      return (await client.groupMetadata(_chatId)).participants;
    },

    downloadMedia: async () => {
      const buffer = await downloadMediaMessage(rawMsg, 'buffer', {}, { logger: require('pino')({ level: 'silent' }) });
      let mimetype = rawMsg.message?.imageMessage?.mimetype || rawMsg.message?.videoMessage?.mimetype || rawMsg.message?.documentMessage?.mimetype;
      return { data: buffer.toString('base64'), mimetype: mimetype };
    },

    getQuotedMessage: async () => {
      if (!msg.hasQuotedMsg) return null;
      const contextInfo = rawMsg.message.extendedTextMessage.contextInfo;
      const quoted = contextInfo.quotedMessage;
      let botJid = client.user.id.split(':')[0] + '@s.whatsapp.net';
      let isQuotedFromMe = contextInfo.participant === botJid;
      
      return {
        body: quoted.conversation || quoted.extendedTextMessage?.text || quoted.imageMessage?.caption || '',
        hasMedia: !!(quoted.imageMessage || quoted.videoMessage || quoted.documentMessage),
        fromMe: isQuotedFromMe,
        downloadMedia: async () => {
          const fakeMsg = { message: quoted };
          const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: require('pino')({ level: 'silent' }) });
          let mimetype = quoted.imageMessage?.mimetype || quoted.videoMessage?.mimetype || quoted.documentMessage?.mimetype;
          return { data: buffer.toString('base64'), mimetype: mimetype };
        }
      };
    }
  };

  const originalReply = msg.reply.bind(msg);
  msg.reply = async (content, chatId, options) => {
    try {
      const chat = await msg.getChat();
      await chat.sendStateTyping();
      const delay = Math.floor(Math.random() * 2000) + 1500;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await chat.clearState();
    } catch (err) {
      console.error(`[REPLY] Gagal menyiapkan status mengetik untuk ${_chatId}:`, err?.message || err);
    }

    if (_isGroup && areReactionsEnabled()) {
      await msg.react('✅').catch(()=>{});
    }

    try {
      return await originalReply(content, chatId, options);
    } catch (err) {
      // Jangan retry pengiriman di sini. Retry pada saat writer macet hanya
      // menambah antrean dan memperparah timeout. Biarkan error tercatat sekali.
      console.error(`[REPLY] Gagal mengirim balasan ke ${_chatId}:`, err?.message || err);
      return null;
    }
  };

  const chatId = msg.from;

  if (activeGames[chatId]) {
    const game = activeGames[chatId];
    const pJawaban = msg.body.toLowerCase().trim();

    if (pJawaban === "nyerah") {
      if (game.type === "caklontong") {
        msg.reply(
          `Wooo dasar lemah!\n\nJawaban: *${game.jawaban.toUpperCase()}*\nAlasan: ${game.alasan}`,
        );
        delete activeGames[chatId];
        return;
      } else if (game.type === "tebaklagu") {
        msg.reply(
          `Wooo nyerah!\n\nJudul lagunya adalah: *${game.jawaban.toUpperCase()}*`,
        );
        delete activeGames[chatId];
        return;
      } else if (game.type === "tebakangka") {
        msg.reply(`Wooo nyerah!\n\nAngkanya adalah *${game.jawaban}*.`);
        delete activeGames[chatId];
        return;
      } else if (game.type === "kuis") {
        msg.reply(`Wooo nyerah!\n\nJawabannya: *${game.opsi[game.jawabanIndex].toUpperCase()}*`);
        delete activeGames[chatId];
        return;
      } else if (game.type === "family100") {
        msg.reply(`Wooo nyerah!\n\nSemua jawaban populer:\n- ${game.jawaban.map((j) => j.toUpperCase()).join("\n- ")}`);
        delete activeGames[chatId];
        return;
      }
    }

    // Tebak angka 1-100: balas "lebih besar / lebih kecil".
    if (game.type === "tebakangka") {
      const tebakan = Number(pJawaban);
      if (Number.isInteger(tebakan) && tebakan >= 1 && tebakan <= 100) {
        if (tebakan === game.jawaban) {
          const reward = awardKoin(_senderId);
          msg.reply(`🎉 BENAR! Angkanya *${game.jawaban}*.\n\n💰 +${reward} koin (total: ${getKoin(_senderId)})\n(Game Selesai)`);
          delete activeGames[chatId];
          return;
        }
        game.percobaan = (game.percobaan || 0) + 1;
        const hint = tebakan < game.jawaban ? "⬆️ Angka lebih *BESAR*" : "⬇️ Angka lebih *KECIL*";
        msg.reply(`${hint} dari ${tebakan}. (percobaan ke-${game.percobaan})`);
        return;
      }
    }

    // Kuis pilihan ganda: jawab A/B/C/D atau 1/2/3/4.
    if (game.type === "kuis") {
      const map = { a: 0, b: 1, c: 2, d: 3, "1": 0, "2": 1, "3": 2, "4": 3 };
      if (Object.prototype.hasOwnProperty.call(map, pJawaban)) {
        const idx = map[pJawaban];
        if (idx === game.jawabanIndex) {
          const reward = awardKoin(_senderId);
          msg.reply(`🎉 BENAR! Jawabannya *${game.opsi[game.jawabanIndex]}*.\n\n💰 +${reward} koin (total: ${getKoin(_senderId)})\n(Game Selesai)`);
        } else {
          msg.reply(`❌ Salah! Jawaban yang benar: *${game.opsi[game.jawabanIndex]}*.\n(Game Selesai)`);
        }
        delete activeGames[chatId];
        return;
      }
    }

    // Family 100: cocokkan dengan daftar jawaban populer.
    if (game.type === "family100") {
      const found = game.jawaban.find((j) => j.toLowerCase() === pJawaban);
      if (found && !game.terjawab.includes(found)) {
        game.terjawab.push(found);
        if (game.terjawab.length >= game.jawaban.length) {
          const reward = awardKoin(_senderId, 15, 30);
          msg.reply(`🎉 SEMUA JAWABAN KETEMU!\n\n- ${game.terjawab.map((j) => j.toUpperCase()).join("\n- ")}\n\n💰 +${reward} koin (total: ${getKoin(_senderId)})\n(Game Selesai)`);
          delete activeGames[chatId];
        } else {
          msg.reply(`✅ *${found.toUpperCase()}* BENAR! (${game.terjawab.length}/${game.jawaban.length})\n\nSudah ketemu: ${game.terjawab.map((j) => j.toUpperCase()).join(", ")}`);
        }
        return;
      }
    }

    if (pJawaban === game.jawaban) {
      const reward = awardKoin(_senderId);
      if (game.type === "caklontong") {
        msg.reply(
          `🎉 BENAR SEKALI!\n\nJawaban: *${game.jawaban.toUpperCase()}*\nAlasan: ${game.alasan}\n\n💰 +${reward} koin (total: ${getKoin(_senderId)})`,
        );
      } else if (game.type === "tebaklagu") {
        msg.reply(
          `🎵 YUHUUU BENAR SEKALI!\n\nJudul lagunya adalah: *${game.jawaban.toUpperCase()}* 🎤\n\n💰 +${reward} koin (total: ${getKoin(_senderId)})`,
        );
      } else {
        msg.reply(
          `🎉 BENAR SEKALI!\n\nSelamat, tebakan kata *${game.jawaban.toUpperCase()}* sangat tepat!\n\n💰 +${reward} koin (total: ${getKoin(_senderId)})\n(Game Selesai)`,
        );
      }
      delete activeGames[chatId];
      return;
    }
  }

  if (msg.body.toLowerCase() === "bot") {
    const sapaan = `🤖 *SMARTBOT HADIR* 🤖

Halo! Aku SmartBot. Ketik *.menu* untuk membuka menu fitur bot.`;

    if (isButtonMenuEnabledForChat(msg.from)) {
      try {
        console.log(`[BUTTONS] Mengirim sapaan tombol ke ${msg.from}`);
        await msg.reply({
          interactiveMessage: {
            header: "🤖 SMARTBOT HADIR",
            title: "Halo! Aku SmartBot. Klik tombol di bawah untuk membuka menu.",
            footer: "SMARTBOT by RzkyAds",
            buttons: [
              {
                name: "quick_reply",
                buttonParamsJson: JSON.stringify({ display_text: "📋 Buka Menu", id: ".menu" }),
              },
            ],
          },
        });
      } catch (err) {
        console.error(`[BUTTONS] Gagal mengirim sapaan tombol: ${err.message}. Fallback ke teks.`);
        await msg.reply(sapaan);
      }
    } else {
      await msg.reply(sapaan);
    }
    return;
  }
  if (msg.body.toLowerCase() === ".kas" || msg.body.toLowerCase() === ".rekapkas") {
    msg.reply("⏳ Mengambil rekap kas dari Google Sheets... Silakan tunggu.");
    try {
      const summary = await sendKasRekap(client, _chatId);
      console.log(`[KAS] Rekap dikirim: ${summary.debtors.length}/${summary.totalStudents} mahasiswa belum lunas.`);
    } catch (err) {
      console.error("[KAS] Gagal rekap:", err?.message || err);
      msg.reply(`❌ Gagal mengambil rekap kas: ${err.message}`);
    }
    return;
  }

  if (
    msg.body.toLowerCase() === "assalamualaikum" ||
    msg.body.toLowerCase() === "assalamu'alaikum"
  ) {
    msg.reply("Waalaikumsalam");
  }

  const isMenuCommand = msg.body.toLowerCase() === ".menu";
  if (isMenuCommand || msg.body.toLowerCase() === ".help") {
    const menuPesan = `🤖 *MENU SMARTBOT ABSENSI* 🤖

*📚 PRODUKTIVITAS & HIBURAN*
1. *.jadwal* : Menampilkan jadwal kuliah.
2. *.tugas* : Menampilkan daftar tugas.
3. *.tanya <teks>* : Bertanya ke AI Pintar / AI Vision.
4. *.cuaca <kota>* : Mengecek kondisi cuaca.
5. *.suara <teks>* : Teks jadi Voice Note.
6. *.ringkas* : (Reply pesan) Ringkas teks panjang.
7. *.tl <id/en>* : (Reply pesan) Translate teks.

*🎮 GAME BARU*
8. *.tebakangka* : Tebak angka 1-100 dengan petunjuk.
9. *.kuis* : Kuis pilihan ganda A/B/C/D.
10. *.family100* : Tebak jawaban paling populer.
11. *.suit <batu|gunting|kertas>* : Suit lawan bot.
12. *.dadu* : Lempar dua dadu.
13. *.slot* : Slot machine, coba hoki.
14. *.koin* : Lihat koin kamu.
15. *.topkoin* : Papan peringkat koin.

*🎲 GAME KLASIK*
16. *.susunkata* : Main tebak kata acak di grup.
17. *.tebaklagu* : Main tebak judul lagu.
18. *.caklontong* : Tebak-tebakan logika ala WIB.
19. *.khodam <nama>* : Cek khodam pendamping.
20. *.truth* / *.dare* : Main Truth or Dare.
21. *.jodoh @tag1 @tag2* : Ramal kecocokan jodoh.
22. *.roasting @tag* : Roasting temanmu.
23. *.gombal @tag* : Kirim gombalan maut.
24. *.cekhoki* : Cek persentase hoki harian.
25. *.meme <atas>|<bawah>* : Bikin meme dari gambar.
26. *.nulis <teks>* : Nulis otomatis di buku.

*🔧 FITUR UTAMA*
27. *Otomatisasi Absen*: Bot otomatis tag all jika ada absen.
28. *.allabsensi* : Rekap absen minggu ini.
29. *.cekjadwal* : Cek jadwal aktif hari ini.
30. *.kas* : Rekap kas kelas dari Google Sheets.
31. *.stiker* : Mengubah foto menjadi stiker.
32. *.saudio* / *.stikeraudio* : (Caption/reply video) Sticker + audio dari video bersuara.
33. *!ping* : Mengecek kecepatan respon bot.
34. *.runtime* : Melihat uptime bot.
35. *.status* : Dashboard kondisi bot (khusus admin).
36. *.owner* : Menampilkan info owner bot.

*👑 KHUSUS ADMIN GRUP*
37. *.tambah_tugas <Matkul> | <Deskripsi> | <YYYY-MM-DD>*
38. *.hapus_tugas <Nomor>*
39. *.jadwaledit <Hari> | <Matkul> | <Jam> | <Ruang>*
40. *.hapusjadwal <Hari> | <Matkul>*
41. *.hidetag <Pesan>*
42. *.setminggu <Angka>*
43. *.hapusrekap <Tanggal>*
44. *.reminderkas* : Kirim pengingat kas ke grup.
45. *.backup* : Backup database absensi sekarang.

*👑 KHUSUS OWNER*
46. *.resetbot <Semester>*

_Catatan: Bot otomatis ganti minggu setiap Senin, punya auto-reminder tugas setiap pagi (07:00 WIB), reminder kas tiap Minggu 19:00 & Senin 06:00 WIB, dan backup database harian._`;

    if (isMenuCommand && isButtonMenuEnabledForChat(msg.from)) {
      try {
        const menuStyle = getMenuStyle();
        console.log(`[BUTTONS] Mengirim menu utama (${menuStyle}) ke ${msg.from}`);
        if (menuStyle === "list") {
          await sendClassicListMenu(
            client,
            msg.from,
            buildClassicListContent(
              "🤖 SMARTBOT ABSENSI",
              "Pilih menu yang ingin dibuka:",
              "SMARTBOT by RzkyAds",
              "📋 Buka Menu",
              MAIN_MENU_SECTIONS
            )
          );
        } else {
          await msg.reply(
            buildButtonMenuContent(
              "🤖 SMARTBOT ABSENSI",
              "Pilih kategori menu:\n\n📚 Akademik — jadwal, tugas, rekap absen\n🎮 Hiburan — game dan tebak-tebakan\nℹ️ Info Bot — runtime dan menu lengkap",
              "SMARTBOT by RzkyAds",
              [
                ["📚 Akademik", ".menu_akademik"],
                ["🎮 Hiburan", ".menu_hiburan"],
                ["ℹ️ Info Bot", ".menu_info"],
              ]
            )
          );
        }
      } catch (err) {
        console.error(`[BUTTONS] Gagal mengirim menu utama: ${err.message}. Fallback ke teks.`);
        if (isFatalSendError(err)) {
          console.error("[BUTTONS] Writer/koneksi bermasalah; fallback teks dibatalkan.");
          return;
        }
        await msg.reply(menuPesan);
      }
    } else {
      await msg.reply(menuPesan);
    }
  }

  const categoryMenu = CATEGORY_MENUS[msg.body.toLowerCase()];
  if (categoryMenu) {
    if (isButtonMenuEnabledForChat(msg.from)) {
      try {
        const menuStyle = getMenuStyle();
        console.log(`[BUTTONS] Mengirim ${msg.body.toLowerCase()} (${menuStyle}) ke ${msg.from}`);
        if (menuStyle === "list") {
          await sendClassicListMenu(
            client,
            msg.from,
            buildClassicListContent(
              categoryMenu.header,
              categoryMenu.title,
              categoryMenu.footer,
              "📋 Pilih Menu",
              [{ title: categoryMenu.header, rows: categoryMenu.rows }]
            )
          );
        } else {
          await msg.reply(
            buildButtonMenuContent(
              categoryMenu.header,
              categoryMenu.title,
              categoryMenu.footer,
              categoryMenu.buttons
            )
          );
        }
      } catch (err) {
        console.error(`[BUTTONS] Gagal mengirim ${msg.body.toLowerCase()}: ${err.message}. Fallback ke teks.`);
        if (isFatalSendError(err)) {
          console.error("[BUTTONS] Writer/koneksi bermasalah; fallback teks dibatalkan.");
          return;
        }
        await msg.reply(categoryMenu.fallbackText);
      }
    } else {
      await msg.reply(categoryMenu.fallbackText);
    }
    return;
  }

  if (msg.body.toLowerCase().startsWith(".tanya")) {
    let pertanyaan = msg.body.substring(".tanya".length).trim();
    if (!pertanyaan && !msg.hasMedia && !msg.hasQuotedMsg) {
      msg.reply(
        "Tanyakan apa saja ke AI! Contoh: *.tanya tolong jelaskan apa itu javascript secara singkat*\nAtau kirim/reply gambar dengan caption *.tanya <pertanyaan>*.",
      );
      return;
    }
    if (!ai) {
      msg.reply(
        "Mohon maaf, fitur AI belum diaktifkan karena API Key belum dimasukkan.",
      );
      return;
    }

    let media = null;
    try {
      if (msg.hasMedia) {
        media = await msg.downloadMedia();
      } else if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg && quotedMsg.hasMedia) {
          media = await quotedMsg.downloadMedia();
        }
      }
    } catch (err) {
      console.error("Gagal mengambil media/quote:", err);
      msg.reply(
        "Maaf, terjadi kesalahan sistem pada WhatsApp saat mengambil gambar. Sistem WhatsApp versi terbaru membatasi fitur ini.",
      );
      return;
    }

    msg.reply("⏳ AI sedang memikirkan jawaban, mohon tunggu sebentar...");
    try {
      let contents = [];
      if (pertanyaan) contents.push(pertanyaan);
      else if (media)
        contents.push(
          "Tolong jelaskan apa yang ada di gambar ini secara singkat.",
        );

      if (media && media.mimetype.includes("image")) {
        contents.push({
          inlineData: {
            data: media.data,
            mimeType: media.mimetype,
          },
        });
      }

      const response = await generateAIContent({
        model: GEMINI_MODEL,
        contents: contents,
      });
      msg.reply(`*🤖 Jawaban AI:*\n\n${response.text}`);
    } catch (err) {
      console.error("Gagal menanyakan AI:", err);
      msg.reply(
        "Maaf, otak AI sedang kelebihan beban atau terjadi gangguan jaringan. Coba lagi nanti.",
      );
    }
  }

  if (
    msg.body.toLowerCase() === "!ping" ||
    msg.body.toLowerCase() === ".ping"
  ) {
    let ping = Date.now() - msg.timestamp * 1000;
    // Fallback jika jam server VPS tidak sinkron persis dengan jam server WhatsApp
    if (ping < 0) ping = Math.floor(Math.random() * 50) + 10;
    msg.reply(`Pong! 🏓\nKecepatan respon jaringan: *${ping} ms*`);
  }

  if (msg.body.toLowerCase() === ".runtime") {
    const uptime = process.uptime();
    const hari = Math.floor(uptime / 86400);
    const jam = Math.floor((uptime % 86400) / 3600);
    const menit = Math.floor((uptime % 3600) / 60);
    const detik = Math.floor(uptime % 60);

    let teksRuntime = `Bot telah aktif tanpa henti selama:\n*`;
    if (hari > 0) teksRuntime += `${hari} Hari `;
    teksRuntime += `${jam} Jam ${menit} Menit ${detik} Detik*`;

    msg.reply(teksRuntime);
  }

  if (msg.body === "!info") {
    console.log("ID Chat ini adalah:", msg.from);
    msg.reply(`ID Chat ini adalah: ${msg.from}`);
  }

  if (msg.body.toLowerCase().startsWith(".allabsensi")) {
    let args = msg.body.trim().split(/\s+/);
    let data = loadData();
    let targetMinggu = data.minggu_ke;
    
    if (args.length > 1) {
        let parsed = parseInt(args[1]);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 16) {
            targetMinggu = parsed;
        } else {
            msg.reply("Format salah. Contoh penggunaan: .allabsensi 2");
            return;
        }
    }

    let mingguIni = `minggu_${targetMinggu}`;
    let jadwalMingguIni = data.jadwal[mingguIni] || [];

    if (jadwalMingguIni.length === 0) {
      msg.reply(`Belum ada data absensi untuk Minggu ke-${targetMinggu}.`);
      return;
    }

    let pesan = `REKAP ABSENSI MINGGU KE-${targetMinggu}\n\n`;
    jadwalMingguIni.forEach((item, index) => {
      pesan += `${index + 1}. Matkul: ${item.matkul}\n   Tanggal: ${item.tanggal}\n\n`;
    });

    const fs = require("fs");
    const path = require("path");
    const fileName = `Rekap_Absensi_Minggu_${targetMinggu}.txt`;
    const filePath = path.join(__dirname, "..", fileName);

    fs.writeFileSync(filePath, pesan);

    try {
      const media = { 
        document: require("fs").readFileSync(filePath), 
        mimetype: "text/plain", 
        fileName: fileName,
        caption: `📄 Berikut adalah file rekap absensi untuk *Minggu ke-${targetMinggu}*.`
      };
      const options = _isGroup ? { quoted: fakeVerif } : {};
      await client.sendMessage(msg.from, media, options);
    } catch (err) {
      console.error("Gagal mengirim file, mencoba fallback teks biasa:", err?.message || err);
      if (isFatalSendError(err)) {
        console.error("[ALLABSENSI] Writer/koneksi bermasalah; fallback teks dibatalkan agar tidak menambah antrean.");
        return;
      }
      // Fallback: Jika WhatsApp memblokir pengiriman file (error 429), kirim sebagai teks
      msg.reply(`⚠️ Gagal mengirim file dokumen (sedang terkena limit dari WhatsApp). Berikut adalah rekapnya:\n\n${pesan}`);
    } finally {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }

  if (
    msg.body.toLowerCase().startsWith(".jadwal") &&
    !msg.body.toLowerCase().startsWith(".jadwaledit")
  ) {
    let args = msg.body.split(" ");
    let hariIni = new Date()
      .toLocaleDateString("id-ID", { weekday: "long" })
      .toLowerCase();
    let targetHari = args.length > 1 ? args[1].toLowerCase() : hariIni;

    let data = loadData();
    let jadwalHari =
      data.daftar_jadwal && data.daftar_jadwal[targetHari]
        ? data.daftar_jadwal[targetHari]
        : [];

    if (jadwalHari.length === 0) {
      msg.reply(
        `Tidak ada jadwal perkuliahan untuk hari *${targetHari.charAt(0).toUpperCase() + targetHari.slice(1)}*.`,
      );
      return;
    }

    let pesan = `*Jadwal Kuliah Hari ${targetHari.charAt(0).toUpperCase() + targetHari.slice(1)}*\n\n`;
    jadwalHari.forEach((j, i) => {
      let jamStr = j.jam_selesai ? `${j.jam} - ${j.jam_selesai}` : j.jam;
      let dosenStr = j.dosen ? j.dosen : 'Dosen tidak diketahui';
      let ruangStr = (j.ruangan && j.ruangan !== 'undefined') ? j.ruangan : 'Online/Belum ditentukan';
      pesan += `${i + 1}. *${j.matkul}*\n   👨‍🏫 ${dosenStr}\n   ⏰ ${jamStr}\n   📍 ${ruangStr}\n\n`;
    });
    msg.reply(pesan);
  }

  if (msg.body.toLowerCase() === ".cekjadwal") {
    const namaHari = [
      "minggu",
      "senin",
      "selasa",
      "rabu",
      "kamis",
      "jumat",
      "sabtu",
    ];
    let todayStr = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Jakarta",
    });
    let todayName = namaHari[new Date(todayStr).getDay()];

    let data = loadData();
    let jadwalHariIni =
      data.daftar_jadwal && data.daftar_jadwal[todayName]
        ? data.daftar_jadwal[todayName]
        : [];

    if (jadwalHariIni.length === 0) {
      msg.reply(
        `Sistem aktif ✅\n\nNamun, tidak ada jadwal kelas untuk hari ini (*${todayName}*). Pengecekan absen intensif sedang beristirahat.`,
      );
    } else {
      let pesan = `Sistem aktif ✅\n\nBot telah menyiapkan *${jadwalHariIni.length} alarm pengecekan intensif* untuk jadwal kelas hari ini (*${todayName}*):\n\n`;
      jadwalHariIni.forEach((j, i) => {
        pesan += `${i + 1}. *${j.matkul}*\n   ⏰ Alarm diset pada: ${j.jam} WIB\n\n`;
      });
      pesan += `_Bot akan otomatis mengecek portal tanpa henti selama 10 menit saat alarm berbunyi!_`;
      msg.reply(pesan);
    }
  }

  if (msg.body.toLowerCase().startsWith(".cuaca")) {
    let kota = msg.body.substring(".cuaca".length).trim() || "Surabaya";
    msg.reply(`☁️ Mengecek cuaca untuk *${kota}*...`);
    try {
      // Menggunakan API wttr.in gratis tanpa key
      const fetch = require("node-fetch");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let data;
      try {
        const response = await fetch(
          `https://wttr.in/${encodeURIComponent(kota)}?format=%l:+%c+%C,+Suhu:+%t,+Angin:+%w`,
          { signal: controller.signal },
        );
        data = await response.text();
      } finally {
        clearTimeout(timer);
      }
      if (data.includes("Unknown location")) {
        msg.reply(`Maaf, kota *${kota}* tidak ditemukan.`);
      } else {
        msg.reply(`*Info Cuaca:*\n${data}`);
      }
    } catch (err) {
      msg.reply("Terjadi kesalahan saat mengambil data cuaca.");
    }
  }

  if (msg.body.toLowerCase() === ".tugas") {
    let data = loadData();
    let tugas = data.daftar_tugas || [];

    if (tugas.length === 0) {
      msg.reply(
        "🎉 Yeay! Tidak ada tugas kelas yang perlu dikerjakan saat ini.",
      );
      return;
    }

    let pesan = `*📚 DAFTAR TUGAS KELAS*\n\n`;
    // Urutkan berdasarkan deadline terdekat
    tugas.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

    let nowWIB = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }),
    );
    nowWIB.setHours(0, 0, 0, 0);

    tugas.forEach((t, i) => {
      const matkul = String(t.matkul || t.mata_kuliah || "").trim() || "Tanpa Mata Kuliah";
      const deskripsi = String(t.deskripsi || t.judul || t.nama_tugas || "").trim() || "Tanpa deskripsi";
      const deadline = String(t.deadline || "").trim();

      let sisaTeks = "*(tanpa deadline)*";
      if (deadline) {
        const targetDate = new Date(deadline);
        if (!isNaN(targetDate.getTime())) {
          targetDate.setHours(0, 0, 0, 0);
          const sisaHari = Math.round((targetDate - nowWIB) / (1000 * 60 * 60 * 24));
          sisaTeks =
            sisaHari < 0
              ? "*(TERLEWAT)*"
              : sisaHari === 0
                ? "*(HARI INI)*"
                : sisaHari === 1
                  ? "*(H-1/BESOK)*"
                  : sisaHari === 2
                    ? "*(H-2)*"
                    : `(${sisaHari} hari lagi)`;
        }
      }

      pesan += `${i + 1}. *${matkul}*\n   📝 ${deskripsi}\n   📅 Deadline: ${deadline || "-"} ${sisaTeks}\n\n`;
    });
    msg.reply(pesan);
  }

  const senderId = msg.author || msg.from || "";
  const isOwner =
    senderId.includes("85704682918") ||
    senderId.includes("194720949112994") ||
    senderId.includes("85233724944") ||
    senderId.includes("70523564343409");

  const adminCommands = [
    ".status",
    ".setminggu",
    ".testabsen",
    ".jadwaledit",
    ".hapusjadwal",
    ".tambah_tugas",
    ".hapus_tugas",
    ".hidetag",
    ".hapusrekap",
    ".clearabsen", ".hapusabsen",
    ".syncjadwal",
    ".testkas",
    ".reminderkas",
    ".backup"
  ];
  const isCmdAdmin = adminCommands.some((cmd) =>
    msg.body.toLowerCase().startsWith(cmd),
  );
  const isCmdOwner =
    msg.body.toLowerCase().startsWith(".resetbot") ||
    msg.body.toLowerCase() === ".cekportal" ||
    msg.body.toLowerCase() === ".testnotif";

  if (isCmdAdmin || isCmdOwner) {
    let isGroupAdmin = false;
    try {
      if (_isGroup) {
        const participants = await msg.getParticipants();
        const normalizeJid = (jid) => String(jid || "").split("@")[0].split(":")[0];
        const senderNumber = normalizeJid(senderId);
        const participant = participants.find(
          (p) => normalizeJid(p.id?._serialized || p.id) === senderNumber,
        );
        if (participant && (participant.admin === "admin" || participant.admin === "superadmin" || participant.isAdmin || participant.isSuperAdmin)) {
          isGroupAdmin = true;
        }
      }
    } catch (e) { }

    const hasAdminAccess = isOwner || isGroupAdmin;

    if (isCmdOwner && !isOwner) {
      msg.reply("Mohon Maaf, fitur ini khusus untuk *Owner* bot!");
      return;
    }

    if (isCmdAdmin && !hasAdminAccess) {
      msg.reply(
        "Mohon Maaf, fitur ini khusus untuk *Admin Grup* atau *Owner* bot!",
      );
      return;
    }

    if (msg.body.toLowerCase() === ".status") {
      try {
        await msg.reply(buildBotStatusMessage(client));
      } catch (err) {
        console.error("[STATUS] Gagal membuat status:", err?.message || err);
        await msg.reply("❌ Gagal mengambil status bot.");
      }
      return;
    }

    if (msg.body.toLowerCase() === ".testkas" || msg.body.toLowerCase() === ".reminderkas") {
      msg.reply("⏳ Mengirim pengingat kas ke grup... Silakan tunggu.");
      try {
        const result = await checkKasAndSend(client, process.env.TARGET_GROUP_ID, true);
        if (result) msg.reply(result);
      } catch (err) {
        console.error("[KAS] Gagal reminder:", err?.message || err);
        msg.reply(`❌ Gagal memproses kas: ${err.message}`);
      }
      return;
    }

    if (msg.body.toLowerCase() === ".backup") {
      const result = backupDatabase();
      if (result.ok) {
        const name = String(result.path).split(/[\\/]/).pop();
        msg.reply(`✅ Backup database tersimpan.\n\n📄 ${name}\n📦 ${Math.round(result.size / 1024)} KB\n🗂️ Total backup disimpan: ${result.kept}`);
      } else {
        msg.reply(`❌ Backup gagal: ${result.reason}`);
      }
      return;
    }

    if (msg.body.toLowerCase() === ".cekportal") {
      const fs = require("fs");
      const path = require("path");
      const portalPath = path.join(__dirname, "..", "debug_portal.png");
      const targetGroup = (process.env.BUTTONS_TEST_GROUP_ID || "120363424800769453@g.us").trim();

      if (fs.existsSync(portalPath)) {
        const akun = getLastUsedAccount() || "Belum diketahui";
        const media = { 
          image: require("fs").readFileSync(portalPath),
          caption: `📸 *Layar Portal ETHOL Saat Ini*\n\nAkun yang aktif terakhir: *${akun}*`
        };
        const options = targetGroup.endsWith('@g.us') ? { quoted: fakeVerif } : {};
        try {
          await client.sendMessage(targetGroup, media, options);
          if (msg.from !== targetGroup) {
            msg.reply("✅ Screenshot portal telah dikirim ke grup testing.");
          }
        } catch (err) {
          console.error("[CEKPORTAL] Gagal mengirim screenshot:", err?.message || err);
          if (!isFatalSendError(err)) {
            msg.reply("❌ Gagal mengirim screenshot portal ke grup testing.");
          }
        }
      } else {
        msg.reply(
          "Belum ada screenshot portal. Tunggu bot mengecek portal terlebih dahulu.",
        );
      }
    }

    if (msg.body.toLowerCase() === ".syncjadwal") {
      msg.reply("🔄 Sedang menyinkronkan data dari ETHOL. Proses ini membutuhkan waktu sekitar 1-2 menit. Mohon tunggu...");
      const { syncJadwalTugas } = require('./ethol-scraper');
      try {
        await syncJadwalTugas();
        if (reloadScheduler) reloadScheduler();
        msg.reply("✅ Sinkronisasi berhasil! Jadwal dan Tugas terbaru telah disimpan ke database dan alarm kelas hari ini telah diperbarui.");
      } catch (err) {
        msg.reply(`❌ Sinkronisasi gagal: ${err.message}`);
      }
      return;
    }

    if (msg.body.toLowerCase().startsWith(".hapusabsen")) {
      const parts = msg.body.trim().split(" ");
      if (parts.length < 2) {
        msg.reply("Format salah. Contoh penggunaan: .hapusabsen Workshop Embedded");
        return;
      }
      const targetMatkul = parts.slice(1).join(" ");
      const { hapusAbsen } = require("./database");
      const sukses = hapusAbsen(targetMatkul);
      if (sukses) {
        msg.reply(`✅ Berhasil menghapus rekaman absensi untuk matkul yang mengandung kata "${targetMatkul}" dari minggu ini.`);
      } else {
        msg.reply(`❌ Gagal menghapus. Matkul "${targetMatkul}" tidak ditemukan pada rekaman minggu ini.`);
      }
      return;
    }

    if (msg.body.toLowerCase().startsWith(".clearabsen")) {
      let args = msg.body.trim().split(/\s+/);
      if (args.length < 2) {
        msg.reply("Format salah. Contoh penggunaan: .clearabsen 2");
        return;
      }
      let targetMinggu = parseInt(args[1]);
      if (!isNaN(targetMinggu) && targetMinggu > 0 && targetMinggu <= 16) {
        let data = loadData();
        let mingguIni = `minggu_${targetMinggu}`;
        data.jadwal[mingguIni] = [];
        const { saveData } = require('./database');
        saveData(data);
        msg.reply(`✅ Data absensi untuk Minggu ke-${targetMinggu} telah dikosongkan secara paksa.`);
      } else {
        msg.reply("Format salah. Harap masukkan angka minggu yang valid (1-16).");
      }
      return;
    }

    if (msg.body.toLowerCase() === ".testnotif") {
      const tanggalHariIni = new Date().toLocaleDateString("id-ID");
      const targetGroup = (process.env.BUTTONS_TEST_GROUP_ID || "120363424800769453@g.us").trim();
      const ok = await announceAbsen(
        client,
        targetGroup,
        "MATKUL TESTING (INI CUMA TEST YAA)",
        tanggalHariIni,
      );
      if (msg.from !== targetGroup) {
        msg.reply(
          ok
            ? "✅ Notifikasi test absen berhasil dikirim ke grup testing."
            : "❌ Gagal mengirim notifikasi test. Cek log atau pastikan bot masih ada di grup testing.",
        );
      }
    }

    if (msg.body.toLowerCase().startsWith(".setminggu")) {
      const mingguBaru = parseInt(msg.body.split(" ")[1]);
      if (!isNaN(mingguBaru) && mingguBaru > 0 && mingguBaru <= 16) {
        let data = loadData();
        data.minggu_ke = mingguBaru;
        saveData(data);
        msg.reply(
          `Minggu semester berhasil diubah menjadi minggu ke-${mingguBaru}.`,
        );
      } else {
        msg.reply(
          "Format salah. Contoh penggunaan: .setminggu 2 (Maksimal 16)",
        );
      }
    }

    if (msg.body.toLowerCase().startsWith(".hapusrekap")) {
      const tanggalHapus = msg.body.substring(".hapusrekap".length).trim();
      if (!tanggalHapus) {
        msg.reply("Format salah! Contoh penggunaan: *.hapusrekap 25/8/2026*");
        return;
      }

      let data = loadData();
      let mingguIni = `minggu_${data.minggu_ke}`;

      if (!data.jadwal[mingguIni] || data.jadwal[mingguIni].length === 0) {
        msg.reply(
          `Belum ada data rekapan absen di minggu ke-${data.minggu_ke}.`,
        );
        return;
      }

      const jumlahAwal = data.jadwal[mingguIni].length;
      data.jadwal[mingguIni] = data.jadwal[mingguIni].filter(
        (a) => a.tanggal !== tanggalHapus,
      );
      const jumlahAkhir = data.jadwal[mingguIni].length;
      const terhapus = jumlahAwal - jumlahAkhir;

      if (terhapus > 0) {
        saveData(data);
        msg.reply(
          `✅ Berhasil menghapus *${terhapus}* rekapan absensi yang tercatat pada tanggal *${tanggalHapus}*.`,
        );
      } else {
        msg.reply(
          `❌ Tidak ditemukan rekapan absensi pada tanggal *${tanggalHapus}*. Pastikan format tanggal sama persis seperti di .allabsensi`,
        );
      }
    }

    if (msg.body.toLowerCase().startsWith(".resetbot")) {
      const parts = msg.body.split(" ");
      let semesterBaru = 1;
      if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
        semesterBaru = parseInt(parts[1]);
      }

      let data = loadData();
      // Simpan backup dulu sebelum menghapus histori absensi.
      const backup = backupDatabase();
      if (!backup.ok) {
        console.error(`[RESETBOT] Backup sebelum reset gagal: ${backup.reason}`);
      }
      // Pertahankan jadwal, tugas, dan konfigurasi kas; yang direset hanya
      // histori absensi + minggu.
      data.minggu_ke = 1;
      data.semester = semesterBaru;
      data.jadwal = {};
      saveData(data);
      msg.reply(
        `Database berhasil direset!\n\nSelamat datang di *Semester ${semesterBaru}*. Sistem telah dikembalikan ke *Minggu ke-1* dan seluruh histori absensi semester lama telah dihapus.${backup.ok ? "\n\n💾 Backup otomatis dibuat sebelum reset." : ""}`,
      );
    }

    if (msg.body.toLowerCase() === ".testabsen") {
      msg.reply(
        "Memulai proses pengecekan portal Ethol secara manual... Silakan tunggu beberapa saat.",
      );
      try {
        await checkPortal(client);
        msg.reply("Proses pengecekan manual selesai!");
      } catch (err) {
        console.error(err);
        msg.reply("Terjadi kesalahan saat mengecek portal.");
      }
    }

    if (msg.body.toLowerCase().startsWith(".jadwaledit")) {
      let teks = msg.body.substring(".jadwaledit".length).trim();
      let parts = teks.split("|").map((s) => s.trim());

      if (parts.length === 2 && parts[1].toLowerCase() === "reset") {
        let hari = parts[0].toLowerCase();
        let data = loadData();
        data.daftar_jadwal[hari] = [];
        saveData(data);
        msg.reply(`Jadwal hari *${hari}* berhasil direset/dikosongkan.`);
        return;
      }

      if (parts.length < 4) {
        msg.reply(
          `Format salah!\n\n*Cara Tambah Jadwal:*\n.jadwaledit senin | Algoritma | 08:00 | Lab 1\n\n*Cara Hapus Jadwal Sehari:*\n.jadwaledit senin | reset`,
        );
        return;
      }

      let hari = parts[0].toLowerCase();
      let matkul = parts[1];
      let jam = parts[2];
      let ruang = parts[3];

      let data = loadData();
      if (!data.daftar_jadwal) data.daftar_jadwal = {};
      if (!data.daftar_jadwal[hari]) data.daftar_jadwal[hari] = [];

      data.daftar_jadwal[hari].push({ matkul, jam, ruang });
      saveData(data);

      msg.reply(
        `Berhasil menambahkan mata kuliah *${matkul}* ke jadwal hari *${hari}*.`,
      );
    }

    if (msg.body.toLowerCase().startsWith(".hapusjadwal")) {
      let teks = msg.body.substring(".hapusjadwal".length).trim();
      let parts = teks.split("|").map((s) => s.trim());

      if (parts.length < 2) {
        msg.reply(
          `Format salah!\nCara penggunaan:\n.hapusjadwal <Hari> | <Matkul>\n\nContoh:\n.hapusjadwal senin | Algoritma`,
        );
        return;
      }

      let hari = parts[0].toLowerCase();
      let matkul = parts[1].toLowerCase();

      let data = loadData();
      if (!data.daftar_jadwal || !data.daftar_jadwal[hari]) {
        msg.reply(`Tidak ada jadwal untuk hari *${hari}*.`);
        return;
      }

      let jadwalHari = data.daftar_jadwal[hari];
      let index = jadwalHari.findIndex(
        (j) => j.matkul.toLowerCase() === matkul,
      );

      if (index !== -1) {
        let deletedMatkul = jadwalHari[index].matkul;
        jadwalHari.splice(index, 1);
        saveData(data);
        msg.reply(
          `Berhasil menghapus mata kuliah *${deletedMatkul}* dari jadwal hari *${hari}*.`,
        );
      } else {
        msg.reply(
          `Mata kuliah *${parts[1]}* tidak ditemukan pada jadwal hari *${hari}*.`,
        );
      }
    }

    if (msg.body.toLowerCase().startsWith(".tambah_tugas")) {
      let teks = msg.body.substring(".tambah_tugas".length).trim();
      let parts = teks.split("|").map((s) => s.trim());

      if (parts.length < 3) {
        msg.reply(
          `Format salah!\nCara penggunaan:\n.tambah_tugas <Matkul> | <Deskripsi> | <YYYY-MM-DD>\n\nContoh:\n.tambah_tugas PWEB | Membuat makalah bab 1 | 2026-06-25`,
        );
        return;
      }

      let data = loadData();
      if (!data.daftar_tugas) data.daftar_tugas = [];

      data.daftar_tugas.push({
        matkul: parts[0],
        deskripsi: parts[1],
        deadline: parts[2],
      });
      saveData(data);

      msg.reply(
        `✅ Tugas *${parts[0]}* berhasil dicatat dengan deadline ${parts[2]}.`,
      );
    }

    if (msg.body.toLowerCase().startsWith(".hapus_tugas")) {
      let nomor = parseInt(msg.body.split(" ")[1]);
      let data = loadData();
      if (!data.daftar_tugas || data.daftar_tugas.length === 0) {
        msg.reply("Daftar tugas sedang kosong.");
        return;
      }
      if (isNaN(nomor) || nomor < 1 || nomor > data.daftar_tugas.length) {
        msg.reply(
          `Format salah atau nomor tugas tidak ditemukan. Gunakan: .hapus_tugas <nomor>`,
        );
        return;
      }

      // Hapus tugas berdasarkan urutan deadline
      data.daftar_tugas.sort(
        (a, b) => new Date(a.deadline) - new Date(b.deadline),
      );
      let tugasDihapus = data.daftar_tugas.splice(nomor - 1, 1)[0];
      saveData(data);

      msg.reply(
        `✅ Tugas *${tugasDihapus.matkul}* telah berhasil dihapus dari daftar.`,
      );
    }

    if (msg.body.toLowerCase().startsWith(".hidetag")) {
      let pesanTeks = msg.body.substring(".hidetag".length).trim();
      if (!pesanTeks) pesanTeks = "Perhatian seluruh anggota grup!";

      if (!_isGroup) {
        msg.reply("Perintah ini hanya bisa digunakan di dalam grup!");
        return;
      }

      const participants = capMentions(
        (await msg.getParticipants()).map((p) => p.id?._serialized || p.id),
      );
      await client.sendMessage(msg.from, {
        text: `🔊 *PENGUMUMAN*\n\n${pesanTeks}`,
        mentions: participants,
      }, { quoted: fakeVerif });
    }
  }

  if (msg.body.toLowerCase().startsWith(".suara")) {
    let teks = msg.body.substring(".suara".length).trim();
    let lang = "id";
    if (
      teks.startsWith("id ") ||
      teks.startsWith("en ") ||
      teks.startsWith("ja ") ||
      teks.startsWith("ko ")
    ) {
      lang = teks.substring(0, 2);
      teks = teks.substring(3).trim();
    }
    if (!teks) {
      msg.reply(
        "Kirim perintah dengan format *.suara <teks>* atau *.suara en <teks>*",
      );
      return;
    }
    if (teks.length > 200) {
      msg.reply("Teks terlalu panjang! Maksimal 200 karakter.");
      return;
    }
    try {
      const chat = await msg.getChat();
      await chat.sendStateRecording();
      
      const delay = Math.floor(Math.random() * 2000) + 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      const url = googleTTS.getAudioUrl(teks, {
        lang: lang,
        slow: false,
        host: "https://translate.google.com",
      });

      const axios = require('axios');
      const { data } = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(data, "binary").toString("base64");
      
      const fs = require('fs');
      const { execSync } = require('child_process');
      const path = require('path');
      
      const userId = (msg.author || msg.from).replace(/[^0-9]/g, '');
      const tempMp3 = path.join(__dirname, '..', `temp_${userId}.mp3`);
      const tempMp4 = path.join(__dirname, '..', `temp_${userId}.m4a`);
      
      fs.writeFileSync(tempMp3, Buffer.from(base64, "base64"));
      
      try {
        execSync(`ffmpeg -i "${tempMp3}" -c:a aac -b:a 64k -vn "${tempMp4}" -y`, { stdio: 'ignore' });
        const mp4Buffer = fs.readFileSync(tempMp4);
        
        const media = { 
          audio: mp4Buffer, 
          mimetype: "audio/mp4", 
          ptt: true 
        };
        const options = _isGroup ? { quoted: fakeVerif } : {};
        await client.sendMessage(msg.from, media, options);
        await msg.react('✅').catch(()=>{});
      } catch (e) {
         // Kalau kegagalannya dari pengiriman (writer timeout / koneksi), jangan
         // mencoba kirim audio kedua. Itu justru menggandakan beban writer.
         if (isFatalSendError(e) || String(e?.message || e).includes('[GUARD]')) throw e;
         console.error("FFMPEG conversion failed, falling back to MP3:", e?.message || e);
         const media = { 
            audio: Buffer.from(base64, "base64"), 
            mimetype: "audio/mpeg", 
            ptt: false 
         };
         const options = _isGroup ? { quoted: fakeVerif } : {};
         await client.sendMessage(msg.from, media, options);
         await msg.react('✅').catch(()=>{});
      } finally {
         if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
         if (fs.existsSync(tempMp4)) fs.unlinkSync(tempMp4);
         await chat.clearState();
      }
    } catch (err) {
      console.error("[SUARA]", err?.message || err);
      if (isFatalSendError(err)) {
        console.error("[SUARA] Writer/koneksi bermasalah; balasan teks dibatalkan agar tidak menambah antrean.");
        return;
      }
      msg.reply("Maaf, terjadi kesalahan saat memproses teks ke suara.");
      await msg.react('❌').catch(()=>{});
    }
  }

  if (msg.body.toLowerCase() === ".ringkas" && msg.hasQuotedMsg) {
    if (!ai) {
      msg.reply("Fitur AI belum aktif.");
      return;
    }
    const quotedMsg = await msg.getQuotedMessage();
    msg.reply("⏳ AI sedang meringkas pesan ini, mohon tunggu...");
    try {
      const response = await generateAIContent({
        model: GEMINI_MODEL,
        contents: `Buatkan ringkasan singkat dalam bentuk poin-poin dari teks ini:\n\n${quotedMsg.body}`,
      });
      msg.reply(`*🤖 Ringkasan AI:*\n\n${response.text}`);
    } catch (err) {
      msg.reply("Maaf, AI gagal meringkas teks tersebut.");
    }
  }

  if (msg.body.toLowerCase().startsWith(".tl ") && msg.hasQuotedMsg) {
    if (!ai) {
      msg.reply("Fitur AI belum aktif.");
      return;
    }
    let lang = msg.body.substring(".tl ".length).trim() || "indonesia";
    const quotedMsg = await msg.getQuotedMessage();
    msg.reply(`⏳ AI sedang menerjemahkan pesan ini ke bahasa *${lang}*...`);
    try {
      const response = await generateAIContent({
        model: GEMINI_MODEL,
        contents: `Terjemahkan teks berikut secara natural ke bahasa ${lang}:\n\n${quotedMsg.body}`,
      });
      msg.reply(`*🤖 Terjemahan AI:*\n\n${response.text}`);
    } catch (err) {
      msg.reply("Maaf, AI gagal menerjemahkan teks tersebut.");
    }
  }

  // ===== GAME BARU =====
  if (msg.body.toLowerCase().startsWith(".suit")) {
    const raw = msg.body.substring(".suit".length).trim().toLowerCase();
    const map = { b: "batu", g: "gunting", k: "kertas", batu: "batu", gunting: "gunting", kertas: "kertas", rock: "batu", paper: "kertas", scissors: "gunting" };
    const pilihan = map[raw];
    if (!pilihan) {
      msg.reply("Format: *.suit batu|gunting|kertas*\nContoh: .suit batu");
      return;
    }
    const pilihanBot = ["batu", "gunting", "kertas"][Math.floor(Math.random() * 3)];
    let hasil;
    if (pilihan === pilihanBot) {
      hasil = "🤝 *SERI!*";
    } else if (SUIT_BEATS[pilihan] === pilihanBot) {
      const reward = awardKoin(_senderId, 3, 8);
      hasil = `🎉 *KAMU MENANG!* +${reward} koin (total: ${getKoin(_senderId)})`;
    } else {
      hasil = "😈 *BOT MENANG!* Coba lagi!";
    }
    msg.reply(`✊✋✌️ *SUIT*\n\nKamu: *${pilihan}*\nBot: *${pilihanBot}*\n\n${hasil}`);
    return;
  }

  if (msg.body.toLowerCase() === ".dadu") {
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const total = d1 + d2;
    let bonus = "";
    if (d1 === 6 && d2 === 6) bonus = "\n🎉 *DOUBLE SIX!* Hoki banget!";
    else if (d1 === d2) bonus = "\n✨ Dapat angka kembar!";
    msg.reply(`🎲 *LEMPAR DADU*\n\nDadu 1: *${d1}*\nDadu 2: *${d2}*\nTotal: *${total}*${bonus}`);
    return;
  }

  if (msg.body.toLowerCase() === ".slot") {
    const spin = () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    const r = [spin(), spin(), spin()];
    const line = r.join(" | ");
    if (r[0] === r[1] && r[1] === r[2]) {
      const reward = awardKoin(_senderId, 15, 40);
      msg.reply(`🎰 *SLOT MACHINE* 🎰\n\n[ ${line} ]\n\n🎉 *JACKPOT!* +${reward} koin (total: ${getKoin(_senderId)})`);
    } else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) {
      const reward = awardKoin(_senderId, 3, 8);
      msg.reply(`🎰 *SLOT MACHINE* 🎰\n\n[ ${line} ]\n\n✨ Dua simbol sama! +${reward} koin (total: ${getKoin(_senderId)})`);
    } else {
      msg.reply(`🎰 *SLOT MACHINE* 🎰\n\n[ ${line} ]\n\n😅 Belum hoki, coba lagi!`);
    }
    return;
  }

  if (msg.body.toLowerCase() === ".tebakangka") {
    const chatId = msg.from;
    if (activeGames[chatId]) {
      msg.reply("Masih ada game yang belum selesai di obrolan ini! Selesaikan dulu ya (atau ketik *nyerah*).");
      return;
    }
    const angka = Math.floor(Math.random() * 100) + 1;
    activeGames[chatId] = { type: "tebakangka", jawaban: angka, percobaan: 0 };
    msg.reply("🔢 *TEBAK ANGKA* 🔢\n\nAku sudah pilih angka antara *1 sampai 100*.\nTebak angkanya! Aku kasih petunjuk lebih besar/kecil.\n\nKetik *nyerah* kalau menyerah.");
    return;
  }

  if (msg.body.toLowerCase() === ".kuis") {
    const chatId = msg.from;
    if (activeGames[chatId]) {
      msg.reply("Masih ada game yang belum selesai di obrolan ini! Selesaikan dulu ya (atau ketik *nyerah*).");
      return;
    }
    const q = KUIS_BANK[Math.floor(Math.random() * KUIS_BANK.length)];
    activeGames[chatId] = { type: "kuis", jawaban: q.opsi[q.jawaban], jawabanIndex: q.jawaban, opsi: q.opsi };
    const opsiText = q.opsi.map((o, i) => `${"ABCD"[i]}. ${o}`).join("\n");
    msg.reply(`🧠 *KUIS PILIHAN GANDA* 🧠\n\n${q.soal}\n\n${opsiText}\n\nJawab dengan *A/B/C/D* (atau 1/2/3/4).`);
    return;
  }

  if (msg.body.toLowerCase() === ".family100") {
    const chatId = msg.from;
    if (activeGames[chatId]) {
      msg.reply("Masih ada game yang belum selesai di obrolan ini! Selesaikan dulu ya (atau ketik *nyerah*).");
      return;
    }
    const q = FAMILY100_BANK[Math.floor(Math.random() * FAMILY100_BANK.length)];
    activeGames[chatId] = { type: "family100", jawaban: q.jawaban.slice(), terjawab: [] };
    msg.reply(`👨‍👩‍👧 *FAMILY 100* 👨‍👩‍👧\n\n${q.soal}\n\nAda *${q.jawaban.length} jawaban populer*. Sebutkan satu per satu!\nKetik *nyerah* untuk melihat semua jawaban.`);
    return;
  }

  if (msg.body.toLowerCase() === ".koin") {
    msg.reply(`💰 *KOIN KAMU*\n\nTotal koin: *${getKoin(_senderId)}*\n\nMain game (.kuis, .tebakangka, .family100, .susunkata, .caklontong, .tebaklagu, .suit, .slot) untuk menambah koin!`);
    return;
  }

  if (msg.body.toLowerCase() === ".topkoin" || msg.body.toLowerCase() === ".top") {
    const data = loadData();
    const koin = data.koin || {};
    const rows = Object.entries(koin)
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 10);
    if (rows.length === 0) {
      msg.reply("Belum ada yang punya koin. Jadilah yang pertama dengan main game!");
      return;
    }
    const medal = ["🥇", "🥈", "🥉"];
    const list = rows.map(([id, v], i) => `${medal[i] || `${i + 1}.`} ${String(id).split("@")[0]} — *${v}* koin`).join("\n");
    msg.reply(`🏆 *TOP 10 KOIN* 🏆\n\n${list}`);
    return;
  }

  if (msg.body.toLowerCase() === ".susunkata") {
    const chatId = msg.from;
    if (activeGames[chatId]) {
      msg.reply(
        "Masih ada permainan yang belum diselesaikan di obrolan ini!\nSusun huruf ini: *" +
        activeGames[chatId].acak +
        "*",
      );
      return;
    }
    const words = [
      "javascript",
      "database",
      "pemrograman",
      "komputer",
      "internet",
      "algoritma",
      "jaringan",
      "server",
      "aplikasi",
      "framework",
      "skripsi",
      "mahasiswa",
      "dosen",
      "kampus",
    ];
    let word = words[Math.floor(Math.random() * words.length)];
    let acak = word
      .split("")
      .sort(() => 0.5 - Math.random())
      .join(" ")
      .toUpperCase();

    activeGames[chatId] = { jawaban: word, acak: acak };
    msg.reply(
      `🎮 *MINI GAME SUSUN KATA* 🎮\n\nSusunlah huruf-huruf acak berikut menjadi sebuah kata terkait dunia kampus/IT:\n\n👉 *${acak}* 👈\n\nSiapa cepat dia dapat! Silakan langsung ketik jawabannya di sini.`,
    );
  }

  if (msg.body.toLowerCase().startsWith(".khodam")) {
    let nama = msg.body.substring(".khodam".length).trim();
    if (!nama) {
      msg.reply("Ketik namanya! Contoh: *.khodam Budi*");
      return;
    }
    const khodamList = [
      "Kipas Angin Cosmos",
      "Naga Sakti",
      "Tutup Termos",
      "Maung Bandung",
      "Kucing Oren",
      "Seblak Ceker",
      "Sapu Lidi",
      "Ksatria Bergitar",
      "Panci Gosong",
      "Biawak Sungai",
      "Knalpot Racing",
      "Nyamuk Kebon",
      "Jin Penglaris",
      "Sendok Nasi",
      "Cacing Tanah",
    ];
    let khodam = khodamList[Math.floor(Math.random() * khodamList.length)];
    msg.reply(
      `🔮 Setelah diterawang oleh bot...\n\nKhodam pendamping *${nama}* adalah: **${khodam}**`,
    );
  }

  if (msg.body.toLowerCase() === ".truth") {
    const truthList = [
      "Sebutkan inisial orang yang pernah kamu stalking minggu ini!",
      "Apa kebohongan terbesar yang pernah kamu buat ke dosen?",
      "Siapa orang di kelas ini yang menurutmu paling menarik?",
      "Apa rahasia memalukanmu waktu ospek?",
      "Pernah naksir pacar teman gak?",
    ];
    let truth = truthList[Math.floor(Math.random() * truthList.length)];
    msg.reply(`🤫 *TRUTH*\n\n${truth}\n\n(Ayo jawab jujur di grup ini!)`);
  }

  if (msg.body.toLowerCase() === ".dare") {
    const dareList = [
      "Kirim VN nyanyi lagu Balonku Ada Lima ke grup ini sekarang!",
      "Ganti foto profil WA pakai foto aib teman sebelahmu selama 1 jam.",
      'Chat kating random bilang "Halo kak, boleh kenalan?" lalu screenshot ke sini.',
      'Ketik "Aku sayang kalian semua" di grup keluarga lalu screenshot.',
      "Kirim selfie paling jelek kamu ke grup ini!",
    ];
    let dare = dareList[Math.floor(Math.random() * dareList.length)];
    msg.reply(
      `🔥 *DARE*\n\n${dare}\n\n(Lakukan sekarang atau traktir es teh satu kelas!)`,
    );
  }

  if (msg.body.toLowerCase().startsWith(".jodoh")) {
    if (!ai) {
      msg.reply("Fitur AI belum aktif.");
      return;
    }
    let target = msg.body.substring(".jodoh".length).trim();
    if (!target) {
      msg.reply(
        "Sebutkan dua nama yang mau diramal! Contoh: *.jodoh @udin dan @siti*",
      );
      return;
    }
    msg.reply("🔮 AI sedang menghitung kecocokan jodoh mereka...");
    try {
      const response = await generateAIContent({
        model: GEMINI_MODEL,
        contents: `Buatkan ramalan lucu dan absurd ala anak kuliahan tentang kecocokan jodoh untuk dua orang ini: ${target}. Maksimal 3 kalimat pendek yang bikin ngakak.`,
      });
      msg.reply(`*💘 RAMALAN JODOH AI 💘*\n\n${response.text}`);
    } catch (err) {
      msg.reply("Maaf, dukun AI sedang kehabisan menyan.");
    }
  }

  if (msg.body.toLowerCase().startsWith(".roasting")) {
    if (!ai) return msg.reply("Fitur AI belum aktif.");
    let target = msg.body.substring(".roasting".length).trim();
    if (msg.hasQuotedMsg) {
      const quotedMsg = await msg.getQuotedMessage();
      target += ` (Dia bilang: "${quotedMsg.body}")`;
    }
    if (!target.trim())
      return msg.reply(
        "Sebutkan nama atau tag orang yang mau di-roasting! Atau reply pesannya.",
      );

    msg.reply("🔥 Mempersiapkan bahan roasting...");
    try {
      const response = await generateAIContent({
        model: GEMINI_MODEL,
        contents: `Buatkan roasting-an pedas, lucu, dan menohok ala stand-up comedy bahasa indonesia untuk target berikut: ${target}. Jangan terlalu kasar sampai bawa SARA, tapi cukup bikin malu. Maksimal 3 kalimat.`,
      });
      msg.reply(`*🔥 ROASTING TIME 🔥*\n\n${response.text}`);
    } catch (err) {
      msg.reply("Maaf, AI lagi mager ngeroasting.");
    }
  }

  if (msg.body.toLowerCase().startsWith(".gombal")) {
    if (!ai) return msg.reply("Fitur AI belum aktif.");
    let target = msg.body.substring(".gombal".length).trim() || "kamu";
    msg.reply("😘 Sedang merangkai kata-kata manis...");
    try {
      const response = await generateAIContent({
        model: GEMINI_MODEL,
        contents: `Buatkan satu kalimat gombalan maut yang sangat lucu, receh, dan agak cringe bahasa indonesia untuk: ${target}.`,
      });
      msg.reply(`*💖 GOMBALAN AI 💖*\n\n${response.text}`);
    } catch (err) {
      msg.reply("Maaf, AI lagi nggak mood gombal.");
    }
  }

  if (msg.body.toLowerCase() === ".cekhoki") {
    const persen = Math.floor(Math.random() * 101);
    const saranList = [
      "Mending tidur aja seharian.",
      "Coba minta traktir temen sebelahmu.",
      "Jangan lupa napas hari ini.",
      "Hati-hati kalau jalan, awas kesandung semut.",
      "Aman, hari ini kamu bisa ngerjain tugas tanpa ketahuan copas.",
      "Siap-siap dapet kejutan (entah baik atau buruk).",
      "Coba dengerin lagu galau, siapa tau makin galau.",
    ];
    const saran = saranList[Math.floor(Math.random() * saranList.length)];
    let emot = persen > 70 ? "🌟" : persen > 30 ? "👍" : "💀";
    msg.reply(
      `*📊 CEK HOKI HARI INI 📊*\n\nTingkat Hoki kamu: *${persen}%* ${emot}\n\n💡 *Saran AI:* ${saran}`,
    );
  }

  if (msg.body.toLowerCase() === ".caklontong") {
    const chatId = msg.from;
    if (activeGames[chatId] && activeGames[chatId].type === "caklontong") {
      msg.reply(
        `Masih ada soal Cak Lontong yang belum dijawab!\n\nSoal: *${activeGames[chatId].soal}*\n\n(Ketik *nyerah* kalau udah pusing)`,
      );
      return;
    }

    const soalLontong = [
      {
        soal: "Matahari terbenam di sebelah...",
        jawaban: "bawah",
        alasan: "Masa di sebelah warung, kan matahari turun ke bawah.",
      },
      {
        soal: "Yang sering mendapat nilai 100 saat ujian...",
        jawaban: "kertas",
        alasan: "Kan kertasnya yang ditulisin nilai 100, bukan muridnya.",
      },
      {
        soal: "Sebelum terbang, burung biasanya...",
        jawaban: "merem",
        alasan: "Coba aja kamu kepakkan tangan, pasti sambil merem.",
      },
      {
        soal: "Kendaraan yang punya roda 3...",
        jawaban: "sepeda",
        alasan: "Sepeda anak kecil kan rodanya 3.",
      },
      {
        soal: "Bisa ditarik tapi tidak bisa dilihat...",
        jawaban: "napas",
        alasan: "Napas ditarik setiap saat tapi wujudnya ga ada.",
      },
    ];

    let randomSoal =
      soalLontong[Math.floor(Math.random() * soalLontong.length)];
    activeGames[chatId] = {
      type: "caklontong",
      jawaban: randomSoal.jawaban,
      soal: randomSoal.soal,
      alasan: randomSoal.alasan,
    };

    msg.reply(
      `🧠 *KUIS CAK LONTONG* 🧠\n\nSoal: *${randomSoal.soal}*\n\nSilakan jawab langsung di grup ini. Hati-hati, jawabannya di luar nalar!`,
    );
  }

  if (msg.body.toLowerCase().startsWith(".meme")) {
    let teks = msg.body.substring(".meme".length).trim();
    let parts = teks.split("|").map((s) => s.trim());
    let topText = parts[0] || "";
    let bottomText = parts[1] || "";

    let media = null;
    if (msg.hasMedia) {
      media = await msg.downloadMedia();
    } else if (msg.hasQuotedMsg) {
      const quotedMsg = await msg.getQuotedMessage();
      if (quotedMsg.hasMedia) {
        media = await quotedMsg.downloadMedia();
      }
    }

    if (!media || !media.mimetype.includes("image")) {
      msg.reply(
        "Kirim/reply gambar dengan format: *.meme teks atas | teks bawah*",
      );
      return;
    }

    msg.reply("⏳ Sedang meracik meme...");
    try {
      const memeBase64 = await createMeme(
        media.data,
        media.mimetype,
        topText,
        bottomText,
      );
      const memeMedia = { image: Buffer.from(memeBase64, "base64") };
      await client.sendMessage(msg.from, memeMedia);
    } catch (err) {
      console.error("Gagal membuat meme:", err?.message || err);
      if (isFatalSendError(err)) {
        console.error("[MEME] Writer/koneksi bermasalah; balasan teks dibatalkan.");
        return;
      }
      msg.reply(
        String(err?.message || "").includes("sedang dipakai")
          ? err.message
          : "Terjadi kesalahan saat membuat meme.",
      );
    }
  }

  if (msg.body.toLowerCase().startsWith(".nulis")) {
    let teks = msg.body.substring(".nulis".length).trim();
    if (!teks)
      return msg.reply("Teksnya mana? Contoh: *.nulis aku rajin banget nugas*");

    msg.reply("✍️ Sedang menulis di buku...");
    try {
      const nulisBase64 = await createNulis(teks);
      const nulisMedia = { image: Buffer.from(nulisBase64, "base64") };
      await client.sendMessage(msg.from, nulisMedia);
    } catch (err) {
      console.error("Gagal nulis:", err?.message || err);
      if (isFatalSendError(err)) {
        console.error("[NULIS] Writer/koneksi bermasalah; balasan teks dibatalkan.");
        return;
      }
      msg.reply(
        String(err?.message || "").includes("sedang dipakai")
          ? err.message
          : "Maaf, tintanya habis (terjadi kesalahan sistem).",
      );
    }
  }

  if (msg.body.toLowerCase() === ".tebaklagu") {
    const chatId = msg.from;
    if (activeGames[chatId] && activeGames[chatId].type === "tebaklagu") {
      msg.reply(
        `Masih ada lagu yang belum ditebak!\n\n(Ketik *nyerah* kalau nyerah)`,
      );
      return;
    }

    const laguList = [
      {
        lirik:
          "Dan bila esok, datang kembali. Seperti sedia kala dimana kau bisa bercanda",
        jawaban: "dan",
      },
      {
        lirik: "Separuh nafasku terbang, bersama dirimu",
        jawaban: "separuh nafas",
      },
      { lirik: "Cinta ini membunuhku", jawaban: "cinta ini membunuhku" },
      {
        lirik:
          "Mungkin suatu saat nanti, kau temukan bahagia meski tak bersamaku",
        jawaban: "monokrom",
      },
      {
        lirik: "Ku menangis membayangkan betapa kejamnya dirimu atas diriku",
        jawaban: "hati yang kau sakiti",
      },
      { lirik: "Cobalah mengerti keadaan ini", jawaban: "cobalah mengerti" },
      {
        lirik: "Kini sendiri di sini mencarimu tak tahu di mana",
        jawaban: "bintang di surga",
      },
    ];

    let randomLagu = laguList[Math.floor(Math.random() * laguList.length)];
    activeGames[chatId] = {
      type: "tebaklagu",
      jawaban: randomLagu.jawaban,
      lirik: randomLagu.lirik,
    };

    msg.reply(
      `🎵 *TEBAK LAGU* 🎵\n\nDengarkan voice note berikut dan tebak *judul lagunya*!`,
    );
    try {
      const base64 = await googleTTS.getAudioBase64(randomLagu.lirik, {
        lang: "id",
        slow: false,
        host: "https://translate.google.com",
      });
      const media = { audio: Buffer.from(base64, "base64"), ptt: true };
      await client.sendMessage(msg.from, media);
    } catch (err) {
      console.error("[TEBAKLAGU]", err?.message || err);
      delete activeGames[chatId];
      if (isFatalSendError(err)) {
        console.error("[TEBAKLAGU] Writer/koneksi bermasalah; balasan teks dibatalkan agar tidak menambah antrean.");
        return;
      }
      msg.reply("Yah, speakernya rusak (gagal memutar lirik).");
    }
  }

  if (msg.body.toLowerCase() === ".owner") {
    const vcard =
      "BEGIN:VCARD\n" +
      "VERSION:3.0\n" +
      "FN:RzkyAds (Owner SmartBot)\n" +
      "TEL;type=CELL;type=VOICE;waid=6285704682918:+62 857-0468-2918\n" +
      "END:VCARD";
    const displayName = "RzkyAds (Owner SmartBot)";
    const options = _isGroup ? { quoted: fakeVerif } : {};

    await client.sendMessage(_chatId, { text: "👑 *INFO OWNER BOT*\n\nciee kepo sama ownerkuu yang ganteng imut lucu ini yakk?? xixixi" }, options);
    await client.sendMessage(_chatId, { contacts: { displayName, contacts: [{ vcard }] } }, options);
  }

  if (
    msg.body.toLowerCase() === ".stiker" ||
    msg.body.toLowerCase() === ".sticker"
  ) {
    let media = null;

    try {
      if (msg.hasMedia) {
        media = await msg.downloadMedia();
      } else if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg && quotedMsg.hasMedia) {
          media = await quotedMsg.downloadMedia();
        }
      }
    } catch (err) {
      console.error("Gagal mengambil media stiker:", err);
      msg.reply(
        "Maaf, terjadi kesalahan sistem pada WhatsApp saat mengunduh gambar Anda. Ini adalah bug dari sistem WhatsApp Web terbaru. Kami akan segera memperbaruinya!",
      );
      return;
    }

    if (media) {
      try {
        const { Sticker, StickerTypes } = require('wa-sticker-formatter');
        const sticker = new Sticker(Buffer.from(media.data, 'base64'), {
            pack: 'SmartBot',
            author: 'by RzkyAds',
            type: StickerTypes.FULL,
            quality: 50
        });
        const webpBuffer = await sticker.toBuffer();
        const options = _isGroup ? { quoted: fakeVerif } : {};
        await client.sendMessage(msg.from, { sticker: webpBuffer }, options);
      } catch (err) {
        console.error("Gagal mengirim stiker:", err?.message || err);
        if (isFatalSendError(err)) {
          console.error("[STIKER] Writer/koneksi bermasalah; balasan teks dibatalkan.");
          return;
        }
        msg.reply("Maaf, terjadi kesalahan saat membuat stiker.");
      }
    } else {
      msg.reply(
        'Mohon kirim foto dengan caption ".stiker" atau reply foto dengan ".stiker"',
      );
    }
    return;
  }

  if (
    msg.body.toLowerCase().startsWith(".saudio") ||
    msg.body.toLowerCase().startsWith(".stikeraudio")
  ) {
    let media = null;
    let mediaSource = "";

    try {
      if (msg.hasMedia) {
        media = await msg.downloadMedia();
        mediaSource = "video langsung";
      } else if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg && quotedMsg.hasMedia) {
          media = await quotedMsg.downloadMedia();
          mediaSource = "video yang direply";
        }
      }
    } catch (err) {
      console.error("[SAUDIO] Gagal mengambil video:", err?.message || err);
      msg.reply("Gagal mengunduh video dari WhatsApp. Coba kirim ulang videonya ya.");
      return;
    }

    if (!media || !String(media.mimetype || "").toLowerCase().startsWith("video")) {
      msg.reply(
        'Kirim video bersuara dengan caption *.saudio* atau *.stikeraudio*, atau reply video kamu dengan perintah itu.',
      );
      return;
    }

    msg.reply("⏳ Sedang membuat sticker + audionya, tunggu bentar ya...");
    try {
      const { createStickerWithAudio } = require("./sticker-audio");
      const { prepareSoundSticker, isSoundStickerEnabled } = require("./sound-sticker-send");
      const result = await createStickerWithAudio(Buffer.from(media.data, "base64"));
      const options = _isGroup ? { quoted: fakeVerif } : {};
      console.log(
        `[SAUDIO] Media ${mediaSource || "tidak diketahui"}:Video ${media.mimetype || "?"}, ` +
          `sticker ${result.stickerBytes} bytes, audio ${result.audioBytes || 0} bytes, ` +
          `audioSeconds ${result.audioSeconds || 0}.`,
      );

      let soundStickerSent = false;
      if (isSoundStickerEnabled() && result.audioMimetype === "audio/ogg; codecs=opus") {
        try {
          const sound = await prepareSoundSticker(client, result.sticker, result.audio, result.audioSeconds);
          if (sound) {
            await client.sendMessage(msg.from, sound.content, { ...options, ...sound.options });
            soundStickerSent = true;
            console.log(`[SAUDIO] Sound sticker terkirim (sticker ${result.stickerBytes} bytes).`);
          }
        } catch (err) {
          if (isFatalSendError(err)) throw err;
          console.error("[SAUDIO] Sound sticker gagal, pakai fallback:", err?.message || err);
        }
      }

      if (!soundStickerSent) {
        await client.sendMessage(msg.from, { sticker: result.sticker }, options);
        await client.sendMessage(
          msg.from,
          { audio: result.audio, mimetype: result.audioMimetype, ptt: true },
          options,
        );
      }
      await msg.react('✅').catch(()=>{});
    } catch (err) {
      console.error("[SAUDIO]", err?.message || err);
      if (isFatalSendError(err)) {
        console.error("[SAUDIO] Writer/koneksi bermasalah; sisa pengiriman dibatalkan.");
        return;
      }
      msg.reply(`❌ Gagal membuat sticker audio: ${err?.message || "kesalahan tidak diketahui"}`);
      await msg.react('❌').catch(()=>{});
    }
    return;
  }

  // --- AGENTIC SYSTEM HANDLER ---
  if (!isCommand && bodyText && ai) {
    const isMentioned = bodyText.toLowerCase().includes("@bot") || 
                        bodyText.toLowerCase().includes("smartbot") || 
                        bodyText.toLowerCase().includes("bot,") ||
                        bodyText.toLowerCase().startsWith("bot ") ||
                        bodyText.toLowerCase() === "bot";
    
    let isReplyToBot = false;
    if (msg.hasQuotedMsg) {
       const quoted = await msg.getQuotedMessage();
       if (quoted && quoted.fromMe) isReplyToBot = true;
    }

    if (isMentioned || isReplyToBot || !_isGroup) {
      const chat = await msg.getChat();
      await chat.sendStateTyping();
      
      const db = loadData();
      const nowStr = new Date().toLocaleString("id-ID", {timeZone: "Asia/Jakarta", dateStyle: 'full', timeStyle: 'short'});
      
      const systemPrompt = `Kamu adalah SmartBot, asisten virtual buatan RzkyAds yang cerdas, asik, ala mahasiswa Gen Z. Jangan kaku. Jawab dengan singkat, padat, dan ramah. Gunakan emoji secukupnya.
Waktu saat ini: ${nowStr}
Data Kelas Saat Ini:
- Semester: ${db.semester || 1}
- Minggu Ke: ${db.minggu_ke || 1}
- Jadwal Kuliah: ${JSON.stringify(db.daftar_jadwal || {})}
- Daftar Tugas: ${JSON.stringify(db.daftar_tugas || [])}
- Kas Kelas: ${JSON.stringify(db.kas_kelas || {})}

Berikut adalah memori 15 chat terakhir di grup ini agar kamu paham konteks pembicaraan:
${chatMemory.get(_chatId) ? chatMemory.get(_chatId).join("\n") : "Belum ada chat."}

Instruksi: Jawablah pertanyaan user terbaru berdasarkan data di atas (jika relevan) atau tanggapi obrolan mereka.`;

      try {
        const response = await generateAIContent({
          model: GEMINI_MODEL,
          contents: systemPrompt + `\n\nPertanyaan/Pesan User Terbaru:\n${bodyText}`,
        });
        await chat.clearState();
        msg.reply(response.text);
      } catch (err) {
        await chat.clearState();
        console.error("Agentic System Error:", err);
        if (err.message && err.message.includes("429")) {
            msg.reply("Maaf, kuota AI harian/menit bot sudah habis! 😭 Silakan tunggu beberapa saat atau coba lagi besok.");
        } else {
            msg.reply("Duh, otak AI-ku lagi error nih. Coba lagi nanti ya!");
        }
      }
    }
  }
}

module.exports = { handleMessage };

