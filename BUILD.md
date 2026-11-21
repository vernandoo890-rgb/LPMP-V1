# Cara membuat APK
**Android Studio:** File > Open folder ini > Build > Build APK(s). Hasil: app/build/outputs/apk/debug/app-debug.apk
**Terminal:** `gradle assembleDebug` (Gradle 8.7+, JDK 17, Android SDK 34)
**GitHub:** unggah folder ini ke repo, tab Actions > Build APK > unduh artifact.
Aplikasi berjalan offline; data tersimpan di penyimpanan aplikasi (gunakan menu cadangan untuk backup).

## Pembaruan V2.1 (tampilan, animasi & ikon adaptif)
Menu bawah berikon di semua halaman, layar Input Order baru (ringkasan profit, kartu bernomor, chip marketplace geser, animasi tambah produk/simpan), animasi angka, mode gelap. Berkas baru: `mobile.css`, `mobile.js`. Pastikan folder tersembunyi `.github` ikut terunggah ke GitHub (atau buat manual `.github/workflows/build.yml`).
