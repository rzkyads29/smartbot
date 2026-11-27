// Notifikasi ke owner lewat WhatsApp. Dipakai untuk memberi tahu kalau ada
// masalah (WA putus, sinkronisasi gagal, RAM kritis, database rusak).
// Semua pengiriman dibatasi cooldown supaya owner tidak dibanjiri pesan.

const alertLastSent = new Map();
const queuedAlerts = new Map();

function getOwnerJid() {
    const digits = String(process.env.OWNER_NUMBER || '6285704682918').replace(/[^\d]/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

function nowLabel() {
    return new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

async function sendOwnerAlert(client, message, { key = 'general', cooldownMs = 30 * 60 * 1000 } = {}) {
    if (!client || !message) return false;
    const jid = getOwnerJid();
    if (!jid) return false;

    const now = Date.now();
    const last = alertLastSent.get(key) || 0;
    if (now - last < cooldownMs) return false;

    try {
        await client.sendMessage(jid, {
            text: `🩺 *SMARTBOT ALERT*\n\n${message}\n\n_${nowLabel()} WIB_`,
        });
        alertLastSent.set(key, now);
        console.log(`[ALERT] Notifikasi owner terkirim (${key}).`);
        return true;
    } catch (err) {
        console.error(`[ALERT] Gagal kirim alert owner (${key}):`, err?.message || err);
        return false;
    }
}

// Simpan alert yang muncul saat client belum siap (mis. di dalam scraper).
// Nanti dikirim oleh flushOwnerAlerts saat koneksi tersedia.
function queueOwnerAlert(message, { key = 'general' } = {}) {
    if (!message) return;
    queuedAlerts.set(key, message);
}

async function flushOwnerAlerts(client, { cooldownMs = 6 * 60 * 60 * 1000 } = {}) {
    if (queuedAlerts.size === 0) return 0;
    let sent = 0;
    for (const [key, message] of queuedAlerts) {
        const ok = await sendOwnerAlert(client, message, { key, cooldownMs });
        // Kalau belum waktunya kirim (cooldown) biarkan tetap antre; kalau
        // terkirim, hapus dari antrean.
        if (ok) {
            queuedAlerts.delete(key);
            sent++;
        }
    }
    return sent;
}

module.exports = { sendOwnerAlert, queueOwnerAlert, flushOwnerAlerts, getOwnerJid };