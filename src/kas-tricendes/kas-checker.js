const https = require('https');
const { loadData } = require('../database');

const USER_AGENT = 'Mozilla/5.0 (compatible; SmartBot/1.0)';
// Cache daftar tab (nama + gid) supaya tidak fetch berulang tiap .kas.
const TAB_CACHE_MS = 30 * 60 * 1000;
let tabCache = { id: null, at: 0, tabs: [] };

function getSpreadsheetId(url) {
    const idMatch = String(url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    return idMatch ? idMatch[1] : null;
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        }).on('error', reject);
    });
}

function normalizeSheetName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Ambil daftar seluruh tab spreadsheet + gid dari halaman htmlview publik.
// Contoh nama tab: "sem 1", "sem 2", ... (dipakai memilih tab sesuai semester).
async function getSheetTabs(spreadsheetId) {
    if (!spreadsheetId) return [];
    if (tabCache.id === spreadsheetId && Date.now() - tabCache.at < TAB_CACHE_MS) {
        return tabCache.tabs;
    }
    const { body } = await httpGet(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`);
    const tabs = [];
    const re = /name:\s*"([^"]+)"[^}]*?gid:\s*"(-?\d+)"/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        if (!tabs.some((t) => t.gid === m[2])) tabs.push({ name: m[1], gid: m[2] });
    }
    tabCache = { id: spreadsheetId, at: Date.now(), tabs };
    return tabs;
}

// Cari tab yang cocok dengan semester aktif, mis. semester 3 -> "sem 3".
function findSemesterTab(tabs, semester) {
    if (!Array.isArray(tabs) || !semester) return null;
    const sem = String(semester);
    const candidates = [`sem${sem}`, `semester${sem}`];
    const exact = tabs.find((t) => candidates.includes(normalizeSheetName(t.name)));
    if (exact) return exact;
    return tabs.find((t) => {
        const n = normalizeSheetName(t.name);
        return /^sem/.test(n) && n.endsWith(sem);
    }) || null;
}

function getGvizUrl(inputUrl, gidOverride) {
    const id = getSpreadsheetId(inputUrl);
    if (!id) return inputUrl;
    const gidMatch = String(inputUrl).match(/gid=(-?\d+)/);
    const gid = gidOverride || (gidMatch && gidMatch[1]);
    let gvizUrl = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json`;
    if (gid) {
        gvizUrl += `&gid=${gid}`;
    }
    return gvizUrl;
}

function fetchSheetData(url, gidOverride) {
    return new Promise((resolve, reject) => {
        const gvizUrl = getGvizUrl(url, gidOverride);
        https.get(gvizUrl, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Google Sheets menolak permintaan (HTTP ${res.statusCode}). Cek KAS_SPREADSHEET_URL.`));
                    return;
                }
                try {
                    // Google Sheets mengembalikan string JSON dibungkus fungsi google.visualization.Query.setResponse
                    const match = data.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);/);
                    if (match && match[1]) {
                        resolve(JSON.parse(match[1]));
                    } else if (/<html/i.test(data)) {
                        reject(new Error('Sheet kas tidak bisa diakses (kemungkinan sudah dihapus atau privat). Pastikan link di-share "Anyone with the link can view".'));
                    } else {
                        reject(new Error('Format respons Google Sheets tidak valid.'));
                    }
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

// Baca spreadsheet kas dan kembalikan data terstruktur tanpa mengirim apa pun.
async function getKasSummary() {
    const dbData = loadData();
    const sheetUrl = dbData.kas_url || process.env.KAS_SPREADSHEET_URL;
    const paymentInfo = dbData.kas_payment_info || process.env.KAS_PAYMENT_INFO || 'Belum diatur';
    const mapping = dbData.kas_mapping || {};
    // Lookup mapping tanpa peduli huruf besar/kecil atau spasi di ujung.
    const mappingLower = {};
    for (const [key, value] of Object.entries(mapping)) {
        mappingLower[String(key).toLowerCase().trim()] = value;
    }
    const currentWeek = dbData.minggu_ke || 1;
    const semester = Number(dbData.semester) || 1;

    if (!sheetUrl) {
        throw new Error('URL Google Sheet Kas belum dikonfigurasi!');
    }

    // Pilih tab spreadsheet sesuai semester aktif (mis. "sem 3") supaya
    // otomatis ikut berpindah saat semester berganti.
    const spreadsheetId = getSpreadsheetId(sheetUrl);
    const autoSemester = String(process.env.KAS_AUTO_SEMESTER || 'true') !== 'false';
    let resolvedGid = null;
    let semesterTab = null;
    let semesterFallback = false;
    if (autoSemester && spreadsheetId) {
        try {
            const tabs = await getSheetTabs(spreadsheetId);
            const tab = findSemesterTab(tabs, semester);
            if (tab) {
                resolvedGid = tab.gid;
                semesterTab = tab.name;
            } else if (tabs.length) {
                semesterFallback = true;
                console.warn(`[KAS] Tab untuk semester ${semester} tidak ditemukan. Tab tersedia: ${tabs.map((t) => t.name).join(', ')}`);
            }
        } catch (err) {
            console.warn('[KAS] Gagal membaca daftar tab semester:', err.message);
        }
    }

    const sheetJson = await fetchSheetData(sheetUrl, resolvedGid);
    const rows = sheetJson.table.rows;
    if (!rows || rows.length < 3) {
        throw new Error('Data spreadsheet kosong atau tidak valid.');
    }

    // Cari nominal kas dari sel pertama di baris 0 yang memiliki nilai angka.
    let weeklyDues = 5000;
    if (rows[0] && rows[0].c) {
        for (let c of rows[0].c) {
            if (c && typeof c.v === 'number' && c.v > 0) {
                weeklyDues = c.v;
                break;
            }
        }
    }

    const debtors = [];
    let totalStudents = 0;

    // Parsing baris mahasiswa.
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row.c) continue;

        // Cari indeks kolom nama dan NRP pada baris ini.
        let nameCol = -1;
        let nrpCol = -1;

        for (let cIdx = 0; cIdx < row.c.length; cIdx++) {
            const cell = row.c[cIdx];
            if (!cell || cell.v === null || cell.v === undefined) continue;

            // Cek jika nilai berupa angka NRP (dimulai 24... atau 10 digit).
            if (typeof cell.v === 'number' && String(cell.v).length >= 8 && nrpCol === -1) {
                nrpCol = cIdx;
            } else if (typeof cell.v === 'string' && cell.v.trim().length > 2 && cell.v.trim() !== 'Nama Lengkap' && cell.v.trim() !== 'KETERANGAN' && nameCol === -1 && nrpCol === -1) {
                nameCol = cIdx;
            }
        }

        if (nameCol === -1 || nrpCol === -1) continue;

        totalStudents++;
        const name = row.c[nameCol].v.trim();
        const nrp = row.c[nrpCol].v;

        // Kolom minggu ke-1 dimulai 2 kolom setelah NRP (setelah Kolom Tanggal Lahir).
        let week1Col = nrpCol + 2;

        // Periksa minggu yang belum dibayar s.d. minggu perkuliahan aktif saat ini.
        const unpaidWeeks = [];
        for (let w = 1; w <= currentWeek; w++) {
            const cellIndex = week1Col + (w - 1);
            const cell = row.c[cellIndex];
            const isPaid = cell ? !!cell.v : false;
            if (!isPaid) {
                unpaidWeeks.push(w);
            }
        }

        if (unpaidWeeks.length > 0) {
            const totalOwed = unpaidWeeks.length * weeklyDues;
            debtors.push({
                name,
                nrp,
                unpaidWeeks,
                totalOwed,
                waId: mapping[name] || mappingLower[String(name).toLowerCase().trim()] || null,
            });
        }
    }

    // Urutkan penunggak berdasarkan jumlah tunggakan terbesar.
    debtors.sort((a, b) => b.totalOwed - a.totalOwed);

    // Link detail diarahkan ke tab semester yang sedang aktif.
    const detailUrl = spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit${resolvedGid ? `#gid=${resolvedGid}` : ''}`
        : sheetUrl;

    return {
        sheetUrl: detailUrl,
        paymentInfo,
        mapping,
        currentWeek,
        semester,
        semesterTab,
        semesterFallback,
        weeklyDues,
        debtors,
        totalStudents,
        paidCount: totalStudents - debtors.length,
        totalOwed: debtors.reduce((sum, d) => sum + d.totalOwed, 0),
    };
}

function formatKasReminder(summary) {
    const { currentWeek, weeklyDues, debtors, paymentInfo, sheetUrl, semester = 1, semesterFallback } = summary;
    let text = `📢 *PENGINGAT KAS KELAS TRI C* 📢\n`;
    text += `Perkuliahan: *Semester ${semester} — Minggu ke-${currentWeek}*\n`;
    text += `Tarif Mingguan: *Rp${weeklyDues.toLocaleString('id-ID')}*\n\n`;
    if (semesterFallback) {
        text += `⚠️ _Catatan: tab "Sem ${semester}" belum ada di spreadsheet, sementara memakai tab default._\n\n`;
    }
    text += `Berikut adalah daftar mahasiswa yang belum melunasi kas s.d. Minggu ini:\n\n`;

    const mentions = [];
    debtors.forEach((debtor, idx) => {
        let debtorStr = `${idx + 1}. `;
        // Hidetag: tampilkan nama saja, tapi nomornya tetap dimasukkan ke daftar
        // mentions supaya orangnya dapat notifikasi tanpa terlihat "@nomor".
        debtorStr += `*${debtor.name}*`;
        if (debtor.waId) {
            mentions.push(debtor.waId);
        }
        debtorStr += ` (${debtor.nrp})\n`;
        debtorStr += `   Status: Belum bayar minggu: *${debtor.unpaidWeeks.join(', ')}*\n`;
        debtorStr += `   Total Tunggakan: *Rp${debtor.totalOwed.toLocaleString('id-ID')}*\n\n`;
        text += debtorStr;
    });

    text += `💳 *INFO PEMBAYARAN*:\n`;
    text += `${paymentInfo}\n\n`;
    text += `🔗 *LINK DETAIL SPREADSHEET KAS*:\n`;
    text += `${sheetUrl}\n\n`;
    text += `Mohon segera melunasi kas masing-masing agar rekap keuangan tetap rapi. Terima kasih! 🙏`;

    return { text, mentions };
}

function formatKasRekap(summary) {
    const { currentWeek, weeklyDues, debtors, totalStudents, paidCount, totalOwed, paymentInfo, sheetUrl, semester = 1, semesterFallback } = summary;

    let text = `💰 *REKAP KAS KELAS TRI C* 💰\n`;
    text += `Perkuliahan: *Semester ${semester} — Minggu ke-${currentWeek}*\n`;
    text += `Iuran: *Rp${weeklyDues.toLocaleString('id-ID')} / minggu*\n`;
    if (semesterFallback) {
        text += `⚠️ _Tab "Sem ${semester}" belum ada, memakai tab default._\n`;
    }
    text += `\n`;
    text += `👥 Total mahasiswa: *${totalStudents}*\n`;
    text += `✅ Sudah lunas: *${paidCount}*\n`;
    text += `❌ Belum lunas: *${debtors.length}*\n`;
    text += `💸 Total tunggakan: *Rp${totalOwed.toLocaleString('id-ID')}*\n`;

    if (debtors.length === 0) {
        text += `\n🎉 Semua mahasiswa sudah melunasi kas sampai Minggu ke-${currentWeek}!`;
    } else {
        text += `\n*Daftar belum lunas:*\n`;
        debtors.forEach((debtor, idx) => {
            text += `${idx + 1}. *${debtor.name}* (${debtor.nrp})\n`;
            text += `   Minggu: ${debtor.unpaidWeeks.join(', ')} — *Rp${debtor.totalOwed.toLocaleString('id-ID')}*\n`;
        });
        text += `\n💳 *Info pembayaran:* ${paymentInfo}\n`;
        text += `🔗 ${sheetUrl}`;
    }

    return { text, mentions: [] };
}

async function checkKasAndSend(client, targetGroupId, manualTrigger = false) {
    try {
        const summary = await getKasSummary();

        if (summary.debtors.length === 0) {
            if (manualTrigger) {
                return `Luar biasa! Semua mahasiswa telah melunasi kas sampai Minggu ke-${summary.currentWeek}.`;
            }
            return; // Jangan spam grup jika tidak ada yang menunggak.
        }

        const { text, mentions } = formatKasReminder(summary);
        await client.sendMessage(targetGroupId, { text, mentions });
        return `Berhasil mengirimkan pengingat kas ke grup untuk ${summary.debtors.length} orang.`;
    } catch (err) {
        console.error('Gagal memproses pengingat kas:', err);
        if (manualTrigger) throw err;
    }
}

// Kirim rekap kas ke chat tertentu (tanpa hidetag). Dipakai perintah .kas.
async function sendKasRekap(client, chatId) {
    const summary = await getKasSummary();
    const { text } = formatKasRekap(summary);
    await client.sendMessage(chatId, { text });
    return summary;
}

module.exports = {
    checkKasAndSend,
    getKasSummary,
    sendKasRekap,
    formatKasReminder,
    formatKasRekap,
};