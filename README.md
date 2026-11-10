# Kitaplığım

Kişisel kitap kataloğu. iPhone'da Safari ile açılıp "Ana Ekrana Ekle" ile uygulama gibi kurulur (PWA).

> **Synology:** Uygulama NAS'ta çalışır; kitaplar ve kapak fotoğrafları NAS'ta saklanır, tüm cihazlar aynı listeyi görür.
> Kurulum (Almanca): [docs/synology.md](docs/synology.md). Adres: `https://bakkoz.synology.me:8444`

## Özellikler
- Kapaklı kitap ızgarası, raflar ve raf sayıları (Tümü, Rafsız, Ödünçte, kendi rafların)
- Barkod okutarak ekleme; ISBN ile bilgi ve kapak getirme (Google Books, Open Library)
- "Arka arkaya tara" modu: kitapları tek tek sormadan hızlıca ekler
- Arama, sıralama, okuma durumu, puan, notlar, ödünç takibi
- Nadir kitaplar için kapak fotoğrafı
- CSV içe/dışa aktarma, fotoğraflarla tam yedek (JSON) ve geri yükleme
- NAS ile eşitleme (iPhone, iPad, bilgisayar); internetsiz de çalışır, bağlantı gelince eşitler

## Dosyalar
- `index.html`, `app.css`, `app.js`: arayüz
- `store.js`: cihaz içi kayıt (IndexedDB)
- `lookup.js`: ISBN ve kapak arama
- `sw.js`: çevrimdışı çalışma
- `server/`: NAS sunucusu (FastAPI, SQLite), `Dockerfile`, `docker-compose.yml`
- `vendor/html5-qrcode.min.js`: barkod okuyucu (Apache-2.0, html5-qrcode 2.3.8)

## Yayın
- NAS: [docs/synology.md](docs/synology.md)
- GitHub Pages (sadece cihazda saklar): https://sindoma-bot.github.io/kitapligim/
