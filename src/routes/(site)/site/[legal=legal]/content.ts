import { msg } from '#lib/shared/i18n';

/**
 * Draft privacy policy and terms (FN-32). Every sentence states what the product actually does today (FN-01,
 * FN-13, FN-14, FN-21, FN-24, FN-27, FN-29) or marks what is not active yet; written in our own words. Legal
 * review is an owner item (docs/TASKS.md): the page keeps its draft banner until it happens.
 */
export interface LegalSection {
	id: string;
	title: string;
	paragraphs: readonly string[];
	items?: readonly string[];
}

export const PRIVACY: readonly LegalSection[] = [
	{
		id: 'privasi-ringkas',
		title: msg('Ringkasnya'),
		paragraphs: [
			msg(
				'Kami mencatat keuanganmu supaya kamu tidak perlu mengetik. Kami bukan bank: kami tidak menyimpan dana, tidak memindahkan uang, dan tidak pernah meminta login bank, PIN, kata sandi bank atau OTP.'
			)
		],
		items: [
			msg('Tanpa iklan dan tanpa pelacak pihak ketiga.'),
			msg('Datamu tidak pernah dijual.'),
			msg(
				'Data dari kotak masukmu tidak pernah dipakai untuk iklan, penilaian kredit atau pinjaman.'
			),
			msg('File yang kamu unggah untuk dibaca tidak pernah disimpan.')
		]
	},
	{
		id: 'privasi-data',
		title: msg('Data yang kami simpan'),
		paragraphs: [
			msg(
				'Akunmu: nama, alamat e-mail, dan kata sandi dalam bentuk hash (bukan kata sandinya). Sesi masuk disimpan sebagai hash dari tokennya.'
			),
			msg(
				'Catatanmu: dompet, transaksi, anggaran, tabungan, langganan, barang dan aset yang kamu masukkan atau setujui. Setiap catatan milik tepat satu ruang dan ditandai dengan sumbernya (manual, suara, CSV, dan seterusnya).'
			),
			msg(
				'Perangkat yang kamu izinkan menerima notifikasi: alamat langganan notifikasi dari browser-mu, terikat pada sesi masuk.'
			),
			msg(
				'Passkey: hanya kunci publik dan penghitung dari perangkatmu, bukan sidik jari, wajah atau PIN-mu (itu tidak pernah meninggalkan perangkat).'
			)
		]
	},
	{
		id: 'privasi-unggahan',
		title: msg('File yang kamu unggah'),
		paragraphs: [
			msg(
				'Mutasi rekening, tangkapan layar dan foto struk yang diunggah untuk dibaca diproses di memori dan tidak pernah ditulis ke disk, database, penyimpanan file atau log.'
			),
			msg(
				'Hasil bacaannya disegel dengan kunci akunmu: kunci pribadinya dibungkus dengan kunci yang diturunkan dari kata sandimu di perangkatmu, sehingga server tidak bisa membuka hasil yang sudah tersegel. Kalau kunci itu tidak bisa dibuka lagi, hasil yang masih tersegel ikut tidak bisa dibuka; transaksi yang sudah disimpan tidak terpengaruh.'
			)
		]
	},
	{
		id: 'privasi-gmail',
		title: msg('Gmail dan aplikasi terhubung'),
		paragraphs: [
			msg(
				'Gmail hanya dihubungkan kalau kamu memintanya, dengan izin hanya baca, dan bisa diputus kapan saja. Yang diproses hanya email pembayaran; isi email dihapus setelah transaksinya diambil. Untuk email lain kami hanya menyimpan penanda dan tanggalnya. Nomor rekening dan kartu dipotong menjadi empat digit terakhir.'
			),
			msg(
				'Token akses aplikasi terhubung disimpan terenkripsi dan dihapus saat koneksi diputus. Saat ini koneksi Gmail dan aplikasi lain belum aktif.'
			)
		]
	},
	{
		id: 'privasi-suara',
		title: msg('Pencatatan dengan suara'),
		paragraphs: [
			msg(
				'Montra tidak pernah menerima rekaman suaramu. Pengenalan suara dilakukan oleh browser-mu sendiri; sebagian browser (misalnya Chrome dan Edge) mengirim rekaman ke server pembuat browser untuk diubah menjadi teks. Mengetik kalimatnya tidak mengirim apa pun.'
			)
		]
	},
	{
		id: 'privasi-foto',
		title: msg('Foto yang kamu simpan'),
		paragraphs: [
			msg(
				'Foto yang sengaja kamu simpan bersama catatan, misalnya foto barang, disimpan di penyimpanan file kami, hanya bisa dibuka anggota ruang itu, dan dibersihkan dari metadata seperti lokasi sebelum disimpan. Foto dihapus saat catatannya, ruangnya atau akunmu dihapus.'
			)
		]
	},
	{
		id: 'privasi-ai',
		title: msg('Pembacaan dengan AI'),
		paragraphs: [
			msg(
				'Untuk membaca email, struk dan mutasi, isinya dikirim ke penyedia AI kami lewat gerbang yang kami kendalikan. Hasilnya diperiksa terhadap format yang ketat, diberi tingkat keyakinan, dan yang kurang yakin ditandai Perlu ditinjau. Kamu memeriksa hasilnya sebelum disimpan. Saat ini pembacaan dengan AI belum aktif.'
			)
		]
	},
	{
		id: 'privasi-lintas-negara',
		title: msg('Pemrosesan data di luar Indonesia'),
		paragraphs: [
			msg(
				'Datamu disimpan dan diproses oleh Cloudflare (server dan basis data aplikasi), penyedia AI (saat membaca e-mail, struk, mutasi atau menjawab pertanyaan) dan, jika kamu menghubungkan Gmail, mitra koneksi Gmail. Mereka dapat memproses data di luar Indonesia; penyimpanan Cloudflare tidak dapat dipastikan berada di Jakarta. Dengan mendaftar, kamu menyetujui pemrosesan ini.'
			)
		]
	},
	{
		id: 'privasi-statistik',
		title: msg('Statistik pemakaian'),
		paragraphs: [
			msg(
				'Yang dihitung: layar yang dibuka dan tombol yang ditekan (dari daftar tetap), jenis perangkat (iOS, Android atau lainnya), bahasa aplikasi, dan negara. Tidak pernah: akun, e-mail, jumlah uang, teks yang kamu ketik, atau alamat IP. Disimpan di Cloudflare, tidak dibagikan ke siapa pun.'
			),
			msg('Kamu bisa mematikannya kapan saja di Pengaturan › Privasi.')
		]
	},
	{
		id: 'privasi-cookie',
		title: msg('Cookie'),
		paragraphs: [
			msg(
				'Kami hanya memakai cookie yang diperlukan: sesi masuk dan ruang yang sedang kamu buka. Tidak ada cookie iklan atau pelacak. Situs publik ini tidak memasang cookie.'
			)
		]
	},
	{
		id: 'privasi-ruang',
		title: msg('Ruang bersama'),
		paragraphs: [
			msg(
				'Semua anggota ruang bersama dapat melihat catatan di ruang itu. Catatan di ruang pribadimu hanya bisa dilihat olehmu.'
			)
		]
	},
	{
		id: 'privasi-keamanan',
		title: msg('Keamanan'),
		paragraphs: [
			msg(
				'Koneksi selalu terenkripsi (HTTPS). Kata sandi disimpan sebagai hash yang lambat ditebak, sesi sebagai hash, dan setiap permintaan data diperiksa keanggotaan ruangnya di server.'
			),
			msg(
				'Halaman masuk memakai pemeriksaan bot Cloudflare Turnstile (infrastruktur Cloudflare yang sudah melayani Montra); tidak ada pelacak pihak ketiga.'
			)
		]
	},
	{
		id: 'privasi-hapus',
		title: msg('Menghapus akun dan data'),
		paragraphs: [
			msg(
				'Kamu bisa menghapus akun kapan saja dari Pengaturan › Akun. Akun, ruang pribadi beserta catatannya dan semua sesi masuk langsung dihapus, dan foto yang tersimpan ikut dibersihkan. Tidak bisa masuk? Lihat halaman Hapus akun. Agar kredit awal dan voucher tidak bisa diklaim ulang, kami menyimpan sidik satu arah berkunci (HMAC) dari alamat emailmu, bukan alamatnya, untuk kredit awal dan untuk setiap voucher yang pernah kamu tukarkan, selama 2 tahun setelah akun terakhir dihapus. Sidik ini tetap data pribadi yang disamarkan. Catatan pembayaran dan pengembalian dana (jumlah, mata uang, referensi penyedia dan statusnya) tetap disimpan tanpa terhubung ke akunmu, karena dibutuhkan untuk pengembalian dana dan pembukuan.'
			)
		]
	},
	{
		id: 'privasi-hak',
		title: msg('Hakmu'),
		paragraphs: [
			msg(
				'Sesuai Undang-Undang Pelindungan Data Pribadi, kamu berhak mengakses, membetulkan dan menghapus data pribadimu, serta menarik persetujuan. Sebagian besar bisa langsung kamu lakukan di aplikasi; alamat kontak untuk permintaan lain dicantumkan sebelum peluncuran.'
			)
		]
	}
];

export const TERMS: readonly LegalSection[] = [
	{
		id: 'ketentuan-layanan',
		title: msg('Layanan'),
		paragraphs: [
			msg(
				'Layanan ini membantu mencatat dan merangkum keuanganmu. Kami bukan bank, dompet digital, penasihat keuangan, pajak atau hukum. Angka, laporan dan jawaban asisten adalah informasi dari catatanmu sendiri, bukan nasihat.'
			)
		]
	},
	{
		id: 'ketentuan-akun',
		title: msg('Akunmu'),
		paragraphs: [
			msg(
				'Kamu harus berusia 18 tahun atau lebih untuk mendaftar. Satu akun untuk satu orang. Jaga kata sandimu; kami tidak akan pernah meminta PIN, OTP atau kata sandi bankmu.'
			)
		]
	},
	{
		id: 'ketentuan-ruang',
		title: msg('Ruang bersama'),
		paragraphs: [
			msg(
				'Ruang bersama menampung sampai lima orang. Pemilik mengundang dan mengeluarkan anggota; setiap anggota bertanggung jawab atas catatan yang ia buat.'
			)
		]
	},
	{
		id: 'ketentuan-ketepatan',
		title: msg('Ketepatan catatan'),
		paragraphs: [
			msg(
				'Pembacaan otomatis bisa salah. Periksa hasilnya sebelum menyimpan. Kami menghitung saldo dan total hanya dari catatan yang tersimpan dan tidak menjamin catatan itu sama dengan rekening bankmu.'
			)
		]
	},
	{
		id: 'ketentuan-terhubung',
		title: msg('Layanan pihak ketiga'),
		paragraphs: [
			msg(
				'Saat kamu menghubungkan layanan lain seperti Gmail, ketentuan layanan itu juga berlaku. Kamu bisa memutus koneksinya kapan saja.'
			)
		]
	},
	{
		id: 'ketentuan-paket',
		title: msg('Paket dan pembayaran'),
		paragraphs: [
			msg(
				'Harga paket berbayar masih sementara dan pembayaran sungguhan belum tersedia. Tidak ada tagihan sebelum harga final diumumkan dan kamu menyetujuinya. Kredit untuk fitur AI bukan uang dan tidak bisa dicairkan.'
			)
		]
	},
	{
		id: 'ketentuan-larangan',
		title: msg('Yang tidak boleh dilakukan'),
		paragraphs: [
			msg(
				'Jangan memakai layanan untuk melanggar hukum, mengakses akun atau ruang orang lain tanpa izin, mengganggu layanan, atau mengunggah file yang bukan milikmu untuk dibaca.'
			)
		]
	},
	{
		id: 'ketentuan-berakhir',
		title: msg('Berhenti memakai layanan'),
		paragraphs: [
			msg(
				'Kamu bisa menghapus akunmu kapan saja. Kami dapat menangguhkan akun yang menyalahgunakan layanan, dan akan memberi tahu sebelumnya bila memungkinkan.'
			)
		]
	},
	{
		id: 'ketentuan-tanggung-jawab',
		title: msg('Batas tanggung jawab'),
		paragraphs: [
			msg(
				'Layanan disediakan apa adanya. Keputusan keuangan yang kamu ambil tetap tanggung jawabmu. Batas tanggung jawab yang tepat menunggu tinjauan hukum.'
			)
		]
	},
	{
		id: 'ketentuan-hukum',
		title: msg('Hukum yang berlaku'),
		paragraphs: [msg('Ketentuan ini tunduk pada hukum Republik Indonesia.')]
	}
];
