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

Overlay: `http://127.0.0.1:3000/overlay/nowplaying.html`

Permintaan lagu dari chat (`!req judul lagu`) masuk ke daftar, maksimal 5 permintaan dengan satu permintaan per penonton. Lagu dihapus dari daftar saat mulai diputar. Permintaan hanya masuk ke daftar kecuali opsi **Masukkan otomatis ke antrean Spotify** dinyalakan. Opsi itu butuh:
- Akun Spotify yang Premium, dan Spotify sedang aktif di salah satu perangkat.
- Izin antrean. Akun yang sudah terhubung sebelum fitur ini harus klik **Hubungkan Spotify** sekali lagi.

## YouTube Music (opsional)

YouTube Music tidak punya API resmi untuk lagu yang sedang diputar, jadi dibaca lewat extension Chrome di folder `extension/`.

1. Buka `chrome://extensions`, aktifkan **Mode developer**, lalu pilih **Load unpacked** dan pilih folder `extension`.
2. Buka music.youtube.com dan putar lagu.
3. Di panel, kartu **Musik** > **Sumber musik**, pilih **YouTube Music**.

Extension mengirim ke `http://127.0.0.1:3000`. Kalau `PORT` diubah, ubah juga `SERVER` di `extension/background.js` dan `host_permissions` di `extension/manifest.json`.

## Pakai di OBS

1. Di panel kontrol, isi username TikTok (tanpa @) lalu klik **Hubungkan**.
2. Di OBS, tambahkan **Browser Source** untuk tiap overlay:
   - Chat: `http://127.0.0.1:3000/overlay/chat.html?size=22&max=15&template=classic&anim=up&dur=250` (template: `classic`, `glass`, `modern`, `vision`, `pill`, `light`; animasi: `up`, `fade`, `left`, `zoom`, `bounce`, `none`; semua bisa diatur di panel kontrol)
   - Warna sendiri (opsional, tambahkan `custom=1` lalu `accent`, `text`, `bg` berisi 6 digit heks tanpa `#`, misalnya `accent=6ee7ff`)
   - Alert: `http://127.0.0.1:3000/overlay/alerts.html?duration=4000` (follow, share, dan gift; memakai template, animasi, dan warna yang sama dengan chat)
3. Ukuran yang disarankan: chat 500×700, alert 1280×720 (sesuaikan dengan kanvas).
4. Background overlay sudah transparan. Tidak perlu Chroma Key.

Link juga bisa disalin langsung dari panel kontrol.

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
- Extension YouTube Music mengirim ke `127.0.0.1` dan tidak membawa kunci overlay, jadi sumber YouTube Music hanya bekerja kalau server dijalankan di komputer Anda.
- Satu akun TikTok hanya boleh terhubung di satu server pada satu waktu. Jangan jalankan di komputer dan di server bersamaan untuk akun yang sama.

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
