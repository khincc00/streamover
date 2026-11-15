# Streamover

Overlay untuk OBS yang menampilkan chat, alert gift/follow/share, dan lagu Spotify dari live TikTok.

Semua berjalan di komputer kamu. Server hanya mendengarkan di `127.0.0.1`, dan tidak ada data yang dikirim ke server lain selain koneksi ke TikTok.

## Persiapan

- Node.js 20 atau lebih baru
- Akun TikTok yang sedang live (atau gunakan tombol "Tes" di panel tanpa live)

```bash
npm install
cp .env.example .env   # opsional, bisa juga isi username lewat panel
npm start
```

Buka panel kontrol di http://127.0.0.1:3000

## Spotify (opsional)

Menampilkan lagu yang sedang diputar di Spotify sebagai overlay.

1. Buat aplikasi di https://developer.spotify.com/dashboard dan pilih API **Web API**. Di bagian Redirect URI, isi persis:
   `http://127.0.0.1:3000/api/spotify/callback` (jangan pakai `localhost`).
2. Salin **Client ID** dari dashboard, tempel di kartu **Spotify** pada panel kontrol, lalu klik **Simpan**.
3. Klik **Hubungkan Spotify** dan setujui izin.

Catatan: mode development Spotify membatasi 5 pengguna per Client ID, dan pemilik aplikasi harus punya akun Spotify Premium. Tambahkan akun yang akan dipakai di bagian User Management pada dashboard. Client ID dan token disimpan di `.spotify.json` dan tidak ikut ter-commit.

Overlay: `http://127.0.0.1:3000/overlay/nowplaying.html` (sama dengan `?source=spotify`)

Permintaan lagu dari chat (`!req judul lagu`) masuk ke daftar, maksimal 5 permintaan dengan satu permintaan per penonton. Lagu dihapus dari daftar saat mulai diputar. Permintaan hanya masuk ke daftar kecuali opsi **Masukkan otomatis ke antrean Spotify** dinyalakan. Opsi itu butuh:
- Akun Spotify yang Premium, dan Spotify sedang aktif di salah satu perangkat.
- Izin antrean. Akun yang sudah terhubung sebelum fitur ini harus klik **Hubungkan Spotify** sekali lagi.

## YT Music (opsional)

YT Music punya halaman sendiri, **YT Music Studio**, terpisah dari Spotify. Ada dua cara memutar lagu, dan bisa dipilih di kartu **YT Music**:

- **Player YouTube** (bawaan). Lagu diputar di dock bawah panel dengan player YouTube. Audionya keluar dari browser yang membuka panel. Tiap lagu di playlist perlu link YouTube. Kalau mau disiarkan, tangkap audio browser di OBS.
- **Tab YT Music (extension)**. Lagu dicari dan diputar di tab `music.youtube.com` yang terbuka di Chrome. Cukup isi judul dan artis. Pasang extension dari folder `extension/` lewat `chrome://extensions` (Mode developer, Load unpacked). Buka panel di `http://127.0.0.1:3000` sekali agar kunci tersimpan, lalu biarkan tab YT Music terbuka. Kontrolnya bergantung pada struktur halaman YT Music, jadi bisa berhenti kalau YouTube mengubah halamannya. Extension ini mengirim ke `127.0.0.1:3000`, jadi mode ini hanya untuk server yang jalan di komputer sendiri. Di server publik seperti streamover.khincreator.com, pakai **Player YouTube**.

Request dari chat (`!req judul lagu`) dicari di YouTube, dan import playlist juga memakai YouTube API. Hubungkan key di halaman **Settings** panel, atau isi `YOUTUBE_API_KEY` di `.env`. Video yang dibatasi umur atau diblokir di wilayah siaran tidak dipilih; wilayahnya Indonesia, atau isi `YOUTUBE_REGION` (kode negara) di `.env`. Tanpa key, request tetap masuk ke daftar, tapi tidak bisa diputar otomatis. Lagu dari playlist tidak memerlukan key.

## Pakai di OBS

1. Di panel kontrol, isi username TikTok (tanpa @) lalu klik **Hubungkan**.
2. Di OBS, tambahkan **Browser Source** untuk tiap overlay:
   - Chat: `http://127.0.0.1:3000/overlay/chat.html?size=22&max=15&template=classic&anim=up&dur=250` (template: `classic`, `glass`, `modern`, `vision`, `pill`, `light`; animasi: `up`, `fade`, `left`, `zoom`, `bounce`, `none`; semua bisa diatur di panel kontrol)
   - Warna sendiri (opsional, tambahkan `custom=1` lalu `accent`, `text`, `bg` berisi 6 digit heks tanpa `#`, misalnya `accent=6ee7ff`)
   - Alert: `http://127.0.0.1:3000/overlay/alerts.html?duration=4000` (follow, share, dan gift; memakai template, animasi, dan warna yang sama dengan chat)
   - Spotify dan YT Music: link `nowplaying.html` dengan `?source=spotify` atau `?source=youtube`, masing-masing dari kartu di YT Music Studio atau Spotify Studio
3. Ukuran yang disarankan: chat 500×700, alert 1280×720 (sesuaikan dengan kanvas).
4. Background overlay sudah transparan. Tidak perlu Chroma Key.

Link juga bisa disalin langsung dari panel kontrol.

## Pasang di VPS (Linux) untuk https://streamover.khincreator.com

Cara ini untuk server sendiri, bukan komputer lokal. Asumsi: Ubuntu/Debian dengan akses sudo, dan DNS `streamover.khincreator.com` sudah mengarah ke IP server.

1. Pasang Node.js 20 atau lebih baru, dan Caddy (ikuti dokumentasi resmi masing-masing untuk distro Anda).
2. Buat user dan folder aplikasi:
   ```
   sudo useradd --system --create-home --shell /usr/sbin/nologin streamover
   sudo git clone https://github.com/khincc00/streamover.git /opt/streamover
   sudo chown -R streamover:streamover /opt/streamover
   ```
3. Pasang dependency sebagai user itu: `cd /opt/streamover && sudo -u streamover npm ci --omit=dev`.
4. Buat `/opt/streamover/.env` dengan isi berikut, lalu batasi aksesnya (`sudo chmod 600 /opt/streamover/.env`):
   ```
   PORT=3000
   HOST=127.0.0.1
   PUBLIC_URL=https://streamover.khincreator.com
   ```
5. Pasang service: salin `deploy/streamover.service` ke `/etc/systemd/system/`, sesuaikan lokasi `node` (cek dengan `which node`), lalu jalankan `sudo systemctl daemon-reload && sudo systemctl enable --now streamover`.
6. Pasang Caddy dengan config `deploy/Caddyfile`: salin ke `/etc/caddy/Caddyfile`, lalu `sudo systemctl reload caddy`. Caddy mengambil sertifikat HTTPS sendiri.
7. Cek: `systemctl status streamover` dan `journalctl -u streamover -f`. Lalu buka https://streamover.khincreator.com/login.
8. Di dashboard Spotify, tambahkan redirect `https://streamover.khincreator.com/api/spotify/callback`.

Catatan:
- Data akun, pengaturan, dan token Spotify ada di `/opt/streamover/data/`. Kalau sebelumnya dijalankan di komputer lain dan ingin dibawa, salin folder `data/` itu ke server, lalu jaga agar akun yang sama tidak aktif di dua tempat sekaligus.
- Update aplikasi: `cd /opt/streamover && sudo -u streamover git pull && sudo -u streamover npm ci --omit=dev && sudo systemctl restart streamover`.
- Pendaftaran akun terbuka untuk siapa pun. Daftarkan akun Anda segera setelah server jalan, lalu pertimbangkan membatasi pendaftaran.

## Menjalankan di server (Botkeep atau host lain)

Secara bawaan server hanya bisa diakses dari komputer itu sendiri. Untuk dijalankan di server dan dibuka dari luar:

1. Isi environment berikut di server:
   - `HOST=0.0.0.0`
   - `PORT` sesuai port yang diberikan platform
   - `PUBLIC_URL=https://alamat-anda` (alamat https yang dibuka browser)
2. Di dashboard Spotify, tambahkan redirect `https://alamat-anda/api/spotify/callback` untuk setiap aplikasi Spotify yang dipakai.
3. Buka `https://alamat-anda/login`, lalu daftar akun. Setiap orang membuat akunnya sendiri.
4. Masuk, isi Client ID Spotify (kalau dipakai), dan hubungkan akun TikTok masing-masing.
5. Di OBS, pakai link overlay dari panel. Link itu sudah membawa kunci overlay milik akun itu, jadi tidak perlu login.

Catatan:
- Setiap akun punya koneksi TikTok, pengaturan, Spotify, dan kunci overlay sendiri. Perubahan di satu akun tidak mengubah akun lain.
- Pendaftaran terbuka untuk siapa pun. Setiap orang hanya boleh menyambungkan akun TikTok yang ia kelola atau yang sudah memberi izin.
- Tombol **Keluar** mencabut sesi di server, jadi sesi itu tidak bisa dipakai lagi dari perangkat mana pun.
- Pengaturan dan token setiap akun disimpan di folder `data/`. Folder itu tidak ikut di-commit.
- Satu akun TikTok hanya boleh terhubung di satu server pada satu waktu. Jangan jalankan di komputer dan di server bersamaan untuk akun yang sama.

### Contoh: https://streamover.khincreator.com

Cara ini memakai Caddy, yang mengurus HTTPS dan sertifikatnya sendiri. Streamover tetap jalan di komputer atau server yang sama, dan hanya bisa diakses lewat Caddy.

1. Arahkan DNS `streamover.khincreator.com` (record A atau AAAA) ke IP komputer atau server ini. Pastikan port 80 dan 443 terbuka.
2. Isi `.env` (lihat contoh di `.env.example`): `HOST=127.0.0.1`, `PORT=3000`, `PUBLIC_URL=https://streamover.khincreator.com`.
3. Jalankan Streamover: `npm start`.
4. Di terminal lain, jalankan Caddy: `caddy run --config deploy/Caddyfile`. Caddy mengambil sertifikat otomatis saat pertama kali dijalankan.
5. Di dashboard Spotify, tambahkan redirect `https://streamover.khincreator.com/api/spotify/callback`.
6. Buka https://streamover.khincreator.com/login, lalu daftar akun.

Catatan untuk domain publik:
- Karena pendaftaran terbuka, siapa pun bisa membuat akun di server ini. Kalau hanya Anda yang memakainya, pertimbangkan membatasi pendaftaran sebelum dibuka ke internet.
- Jalankan Streamover dengan proses yang tetap hidup setelah terminal ditutup, misalnya dengan pm2 atau layanan sistem.
- Backup folder `data/` secara berkala. Di sana tersimpan akun, pengaturan, dan token Spotify.

## Struktur

```
server.js              server Express + WebSocket, rute API
src/liveSession.js     koneksi ke live TikTok dan status koneksi
src/normalize.js       mengubah event mentah TikTok jadi bentuk sederhana
src/hub.js             WebSocket yang meneruskan event ke panel dan overlay
src/samples.js         event tes
public/index.html      panel kontrol
public/overlay/*.html  halaman overlay untuk OBS
```

## Catatan penting

- **Library tidak resmi.** `tiktok-live-connector` memakai API TikTok yang tidak didokumentasikan. Fitur bisa berhenti bekerja kalau TikTok mengubah sesuatu. Kalau koneksi gagal, cek dulu versi library dengan `npm update tiktok-live-connector`.
- **Lisensi.** `tiktok-live-connector` berlisensi AGPL-3.0. Jika kamu menjalankan modifikasi ini sebagai layanan jaringan atau mendistribusikannya, kamu harus memenuhi syarat AGPL, termasuk menyediakan source code. Untuk pemakaian pribadi di komputer sendiri, syarat ini tidak berlaku.
- **Gift.** Alert gift hanya muncul saat satu rangkaian gift selesai (`repeatEnd`), supaya combo tidak memunculkan puluhan alert. Perilaku ini belum diuji dengan live sungguhan. Jika ada gift yang tidak muncul, catat namanya dan kabari untuk diperbaiki.
- **Chat lama.** Riwayat chat yang dikirim TikTok saat kamu join tidak ditampilkan (`processInitialData: false`).
- **Ketentuan TikTok.** Pastikan pemakaian sesuai ketentuan layanan TikTok dan hanya untuk akun yang kamu kelola atau yang sudah memberi izin.
