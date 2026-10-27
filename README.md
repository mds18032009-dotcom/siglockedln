# SIGLOCKEDIN


Aplikasi sekolah berbasis Express, HTML, CSS, dan JavaScript. Data akun, sesi, posting, komentar, tugas, pengaturan sekolah, dan kehadiran disimpan di SQLite.

## Menjalankan
1. Jalankan `npm install`.
2. Atur `.env` dari `.env.example` bila ingin menetapkan password admin dan rahasia sesi sendiri.
3. Jalankan `npm start`, lalu buka `http://localhost:3000`.

Pada startup pertama tanpa `.env`, server membuat admin lokal `admin@edusmart.example` dan mencetak password sementara satu kali di terminal. Jika admin sudah ada di database, server tidak membuat ulang password.

Pendaftaran email membutuhkan nama, email, password, peran, nomor induk, dan kelas/bidang. Default `AUTO_ACTIVATE_ACCOUNTS=true`: akun langsung aktif setelah mendaftar dan akun lama berstatus `PENDING` diaktifkan saat server mulai. Akun `NONAKTIF` tidak diubah. Set `AUTO_ACTIVATE_ACCOUNTS=false` bila sekolah ingin admin menyetujui pendaftar satu per satu. Auto-aktivasi pada situs publik berisiko memberi akun kepada pendaftar yang tidak dikenal. Login menggunakan sesi server dengan cookie `httpOnly`.

Jalankan tes integrasi dengan `npm test`.

## Cara Cek Database
File database berada di `data/edusmart.sqlite` pada folder project. Dari terminal PowerShell, jalankan:

```powershell
npm run db:inspect
```

Perintah ini menampilkan daftar tabel, akun, dan jumlah baris tanpa menulis/mengubah data. Untuk melihat isi tabel dengan antarmuka, pasang ekstensi SQLite Viewer di VS Code lalu buka `data/edusmart.sqlite`. Foto kehadiran disimpan di `data/attendance-photos/`, terpisah dari folder publik; jangan bagikan atau commit folder `data`.

## Login Google
Login Google belum aktif sampai sekolah mengisi `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` dari Google Cloud OAuth Web Client. Atur `APP_URL`, authorized origin, dan callback `${APP_URL}/auth/google/callback`. Akun Google baru mengikuti `AUTO_ACTIVATE_ACCOUNTS`. Kamera, geolokasi, dan OAuth di deployment publik memerlukan HTTPS.

## Foto Kehadiran
Pengguna mengaktifkan kamera, menyetujui pengiriman, memeriksa lokasi, lalu mengirim foto ke server. Server memeriksa format dan ukuran foto, akurasi GPS, radius sekolah, jam absen, serta satu pengajuan per akun per hari. Foto disimpan privat dan hanya dapat dibuka pemilik atau admin. Status menunggu keputusan admin; fitur ini belum melakukan face recognition.

## Batas Deployment
Belum siap dipakai publik tanpa konfigurasi dan pemeriksaan tambahan: domain/HTTPS, kredensial Google, secret production, backup dan pemulihan SQLite/foto, kebijakan retensi foto, audit log, serta uji keamanan. SQLite pada satu mesin tidak cocok untuk skala besar atau banyak instance. Sebagian modul seperti laporan, profil, kalender, notifikasi, dan penilaian masih memakai data lokal/demo, jadi jangan masukkan data siswa asli sebelum semua alur dan privasi ditinjau sekolah.
