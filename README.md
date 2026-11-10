# Kitaplığım

Kişisel kitap kataloğu. iPhone'da Safari ile açılıp "Ana Ekrana Ekle" ile uygulama gibi kurulur (PWA).

## Özellikler
- Kapaklı kitap ızgarası, raflar ve raf sayıları (Tümü, Rafsız, Ödünçte, kendi rafların)
- Barkod okutarak ekleme; ISBN ile bilgi ve kapak getirme (Google Books, Open Library)
- "Arka arkaya tara" modu: kitapları tek tek sormadan hızlıca ekler
- Arama, sıralama, okuma durumu, puan, notlar, ödünç takibi
- Nadir kitaplar için kapak fotoğrafı
- CSV içe/dışa aktarma, fotoğraflarla tam yedek (JSON) ve geri yükleme
- İnternetsiz çalışır; veriler cihazda (IndexedDB) saklanır

## Dosyalar
- `index.html`, `app.css`, `app.js`: arayüz
- `store.js`: cihaz içi kayıt (IndexedDB)
- `lookup.js`: ISBN ve kapak arama
- `sw.js`: çevrimdışı çalışma
- `vendor/html5-qrcode.min.js`: barkod okuyucu (Apache-2.0, html5-qrcode 2.3.8)

## Yayın
GitHub Pages: Settings → Pages → Branch `main`, klasör `/ (root)`.
