---
title: Kenapa kami tidak pernah menyimpan file yang kamu unggah
slug: file-unggahan-tidak-disimpan
date: 2026-10-08
excerpt: Mutasi rekening, tangkapan layar, dan foto struk diproses di memori lalu dilupakan. Ini artinya "disegel dengan kunci akunmu", dan apa yang terjadi kalau kuncinya hilang.
---

Mutasi rekening adalah salah satu dokumen paling pribadi yang kamu punya. Isinya bukan hanya saldo, tapi juga kebiasaan: di mana kamu makan, siapa yang rutin kamu kirimi uang, kapan gajian masuk. Karena itu kami membuat satu janji yang sederhana: **file yang kamu unggah untuk dibaca tidak pernah kami simpan.**

## Diproses di memori, lalu dilupakan

Saat kamu mengunggah mutasi, tangkapan layar, atau foto struk, file itu hanya hidup di memori server selama dibaca. Tidak ada salinan di disk, di database, di penyimpanan file, atau di catatan log. Setelah selesai dibaca, memorinya dilepas dan file itu hilang.

Yang kami simpan adalah **hasil bacaannya**, dan hasil itu pun dikunci.

## Apa artinya "disegel dengan kunci akunmu"

Bayangkan sebuah kotak surat dengan celah di depannya. Siapa pun bisa memasukkan surat, tapi hanya pemegang kunci yang bisa membukanya.

- Saat kamu mendaftar, perangkatmu membuat sepasang kunci. Bagian "celah" (kunci publik) dikirim ke server; bagian "anak kunci" (kunci pribadi) dibungkus dengan kunci yang diturunkan dari kata sandimu.
- Server memasukkan hasil bacaan ke "kotak surat" itu. Setelah tersegel, server sendiri tidak bisa membukanya lagi.
- Untuk membukanya, perangkatmu membuka bungkus kunci pribadi dengan kata sandimu. Kata sandi itu diproses di perangkatmu, dan kunci yang dihasilkan tidak pernah meninggalkan perangkatmu.

Penyegelan ini memakai metode kriptografi yang sudah teruji dan umum dipakai, bukan buatan sendiri.

Satu catatan jujur: kata sandimu tetap dikirim ke server saat kamu masuk, seperti di hampir semua layanan. Penyegelan ini melindungi hasil bacaan yang tersimpan, bukan menggantikan kata sandi yang kuat.

## Kalau kata sandimu hilang

Kunci pribadimu hanya bisa dibuka dengan kata sandimu. Kalau bungkusnya tidak bisa dibuka lagi, hasil bacaan yang masih tersegel juga tidak bisa dibuka oleh siapa pun, termasuk kami. Itu harga dari janji di atas.

Kabar baiknya, kerugiannya kecil:

- Transaksi yang sudah kamu periksa dan simpan adalah catatan biasa di akunmu dan tidak ikut terkunci.
- File aslinya masih ada padamu. Kamu selalu bisa mengunggahnya lagi untuk dibaca ulang.

Jadi yang hilang hanya draf yang belum sempat kamu simpan, bukan riwayat keuanganmu.

> Ringkasnya: kami membaca file unggahanmu sekali, mengunci hasilnya untukmu, lalu melupakan filenya.
