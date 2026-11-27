const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'absensi_data.json');

function defaultData() {
    return { minggu_ke: 1, semester: 1, jadwal: {}, daftar_jadwal: {}, daftar_tugas: [] };
}

// Fungsi untuk memuat database absensi
function loadData() {
    if (!fs.existsSync(DB_PATH)) {
        return defaultData();
    }
    let data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!data || typeof data !== 'object') data = defaultData();

    // Jaga struktur minimal. Tanpa ini, file lama yang tidak punya "jadwal"
    // membuat catatAbsen / .allabsensi error "cannot read properties".
    if (!data.jadwal || typeof data.jadwal !== 'object') data.jadwal = {};
    if (!data.daftar_jadwal || typeof data.daftar_jadwal !== 'object') data.daftar_jadwal = {};
    if (!Array.isArray(data.daftar_tugas)) data.daftar_tugas = [];
    if (!data.koin || typeof data.koin !== 'object') data.koin = {};

    const minggu = Number(data.minggu_ke);
    if (!Number.isFinite(minggu) || minggu < 1) data.minggu_ke = 1;

    const semester = Number(data.semester);
    if (!Number.isFinite(semester) || semester < 1) data.semester = 1;

    return data;
}

// Fungsi untuk menyimpan database absensi.
// Tulis ke file sementara lalu rename, supaya kalau proses mati di tengah
// penulisan, absensi_data.json lama tidak ikut rusak.
function saveData(data) {
    const tmpPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, DB_PATH);
}

// Fungsi mencatat absen baru
function catatAbsen(matkul, tanggal) {
    let data = loadData();
    let mingguIni = `minggu_${data.minggu_ke}`;

    if (!data.jadwal[mingguIni]) {
        data.jadwal[mingguIni] = [];
    }

    let sudahAda = data.jadwal[mingguIni].find(a => a.matkul === matkul);
    if (!sudahAda) {
        data.jadwal[mingguIni].push({ matkul, tanggal });
        saveData(data);
        return true; 
    }
    return false;
}

function hapusAbsen(matkul) {
    let data = loadData();
    let mingguIni = "minggu_" + data.minggu_ke;
    if (!data.jadwal[mingguIni]) return false;
    let index = data.jadwal[mingguIni].findIndex(
        (a) => String(a.matkul || '').toLowerCase().includes(String(matkul || '').toLowerCase()),
    );
    if (index !== -1) {
        data.jadwal[mingguIni].splice(index, 1);
        saveData(data);
        return true;
    }
    return false;
}

module.exports = { loadData, saveData, catatAbsen, hapusAbsen, defaultData, DB_PATH };