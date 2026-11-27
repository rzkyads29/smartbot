const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'absensi_data.json');
const BACKUP_DIR = process.env.BACKUP_DIR
    ? path.resolve(__dirname, '..', process.env.BACKUP_DIR)
    : path.join(__dirname, '..', 'backups');
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 21));

function isValidDbFile(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return !!data && typeof data === 'object';
    } catch (err) {
        return false;
    }
}

// Salin absensi_data.json ke folder backups dengan nama bertanggal, lalu
// simpan hanya BACKUP_KEEP file terbaru supaya disk tidak penuh.
function backupDatabase() {
    if (!fs.existsSync(DB_PATH)) {
        return { ok: false, reason: 'File absensi_data.json belum ada.' };
    }
    if (!isValidDbFile(DB_PATH)) {
        return { ok: false, reason: 'absensi_data.json tidak valid / rusak.' };
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const stamp = new Date()
        .toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' })
        .replace(/[: ]/g, '-');
    const dest = path.join(BACKUP_DIR, `absensi_data-${stamp}.json`);
    fs.copyFileSync(DB_PATH, dest);

    const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((name) => /^absensi_data-[\d-]+\.json$/.test(name))
        .sort();

    let removed = 0;
    while (files.length > BACKUP_KEEP) {
        const oldest = files.shift();
        try {
            fs.unlinkSync(path.join(BACKUP_DIR, oldest));
            removed++;
        } catch (err) {
            // Backup lama mungkin sudah hilang; abaikan.
        }
    }

    return {
        ok: true,
        path: dest,
        size: fs.statSync(dest).size,
        kept: files.length,
        removed,
    };
}

module.exports = { backupDatabase, isValidDbFile, DB_PATH, BACKUP_DIR, BACKUP_KEEP };