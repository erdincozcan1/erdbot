# Hyperliquid Trader Takip + Sanal Portföy + Otomatik Kadro Botu

Seçtiğin trader'ları birkaç dakikada bir izler, hareketlerini Telegram'a bildirir,
**"Bunları Hyperdash Copytrade ile kopyalasaydım ne olurdu?"** sorusunu sanal bir
portföyle hesaplar ve **kadroyu kendi kendine yönetir**: bozulan trader'ları gözleme
alır, düzelenleri geri getirir, boş yerlere Hyperliquid'den yeni aday bulur.
**Hiç işlem açmaz, hiçbir cüzdana bağlanmaz, para gerektirmez.**

> Simülasyondur, yatırım tavsiyesi değildir. Gerçek sonuçlar farklı olabilir.

## Dosyalar

| Dosya | Ne işe yarar |
| --- | --- |
| `hl_watcher.py` | Ana bot (takip, sanal portföy, Telegram, kadro kararları) |
| `hl_rotation.py` | Kadro kuralları (ölçümler, risk/performans kontrolü, aday inceleme) |
| `hl_traders.json` | Ayarlar ve trader listesi |
| `hl_state.json` | Botun hafızası (kendisi tutar, elle düzenleme) |
| `.github/workflows/hl_watch.yml` | GitHub Actions zamanlayıcısı |
| `cloudflare_worker.js` | Anlık komut cevabı + 5 dakikalık tetikleyici (isteğe bağlı) |

## Kadro nasıl yönetilir

Üç grup var:

| Grup | Ne olur |
| --- | --- |
| **Ana kopya** (sabit sayıda yer, şu an 20) | Sanal portföyde kopyalanır, her hareketi bildirilir |
| **Gözlem** | Portföye girmez; "gölge portföy" ile kopyalanmaya devam eder (kopyalasaydın ne olurdu) |
| **Aday** | Hyperliquid sıralama listesinden bulunan yeni trader'lar |

**Her gün 09:00'dan (İstanbul) sonra – risk kontrolü (anında gözleme alma):**
- Hesap kaldıracı 10 katı aştı
- Son 30 günde zirveden %25'ten fazla düştü
- Hesap değeri listeye girdiği seviyenin yarısının altına indi (para çekme veya büyük zarar)
- İşlem tarzı değişti: son 30 günde pozisyonlarını ortalama 1 saatten kısa tutuyor
- 30 gündür işlem yok ve açık pozisyonu yok

**Her ayın ilk günü – performans kontrolü** (ana listede en az 8 hafta duranlar için):
- Değerlendirme süresi trader'ın temposuna göre: pozisyonları ortalama 8 saatten kısa
  tutanlar için 8 hafta, 8 saat–3 gün için 90 gün, daha uzun tutanlar için 150 gün.
- Bu dönemin sonucu eksi **ve** trader'ın kendi geçmişindeki en kötü aynı uzunluktaki
  dönemden de kötüyse,
- ya da zirveden düşüşü geçmişteki en büyük düşüşünün 1,5 katını aştıysa,
- ya da kopya alt portföyü %15'ten fazla zarardaysa gözleme alınır.
- Ayda en fazla 3 performans kaynaklı değişiklik yapılır (risk kaynaklılar hariç).
- Dolu listede, gözlemdeki hazır bir trader ana listedeki en zayıftan 5 puan daha iyiyse
  yer değiştirirler.

**Gözlemden geri dönüş:** en az 6 hafta gözlemde, gölge portföyü +%5'in üstünde,
kendi hesabı son dönemde kârda ve hiçbir risk işareti yok. Boş yer açıldığında önce
bunlara bakılır.

**Yeni aday:** Boş yer kalır ve gözlemde hazır kimse yoksa bot Hyperliquid sıralama
listesinden ön eleme yapar (100 bin $–20 milyon $ hesap, toplamda ve son ayda kârda,
son ay aktif işlem yapmış, piyasa yapıcı/bot değil, aşırı getirili değil) ve en fazla
80 hesabı ayrıntılı inceler:
- en az 12 ay geçmiş, ayların en az %60'ı kârlı, en kötü ay −%25'ten iyi
- kârın yarısından fazlası tek bir aydan gelmemiş, son 12 ay kârda
- pozisyonları ortalama en az 4 saat tutuyor, sık işlem yapmıyor, kaldıraç en fazla 3x

Gerçek veride yaklaşık her 30 hesaptan biri bu kriterleri geçiyor; tarama birkaç
çalışmaya yayılır (yaklaşık 1–2 saat). Bulunamazsa 3 gün sonra tekrar denenir; o arada
boş yerin parası nakit olarak bekler.

**Çıkarılan trader'ın sonucu kaybolmaz:** sanal pozisyonları o anki fiyattan ücretler
dahil kapatılır, kâr/zararı portföyün toplamında kalır ("Listeden çıkarılanların sonucu").
Ana listeye yeni giren trader'ın mevcut pozisyonları kopyalanmaz; sonraki hareketleri kopyalanır.

Her değişiklikte Telegram'a nedeniyle birlikte "🔁 Kadro değişikliği" mesajı gelir.
**Bot Hyperdash'teki gerçek kopya ayarlarını değiştiremez**; orada gerçekten kopyalıyorsan
değişikliği kendin yaparsın.

## Telegram'a neler gelir

1. **Ana kopyadaki trader'ların her hareketi** ve sanal portföydeki karşılığı.
2. **Kadro değişiklikleri** (nedenleriyle).
3. **Haftalık rapor** (her pazartesi 09:00'dan sonra): portföy değeri, haftalık ve toplam
   getiri, en büyük düşüş, trader bazında sıralama, haftanın kadro değişiklikleri, gözlem listesi.
4. **Komutlar:** `/durum` (anlık özet), `/rapor` (haftalık rapor), `/gozlem` (gözlem listesi).

## Ayarlar (`hl_traders.json`)

```json
{
  "paper_capital_usd": 6000,
  "max_leverage": 5,
  "rotation": { "slots": 20 },
  "traders": [
    { "address": "0x...", "label": "isim" },
    { "address": "0x...", "label": "yedek", "copy": false },
    { "address": "0x...", "label": "dokunma", "pin": true }
  ]
}
```

- `paper_capital_usd` / `slots` = her ana kopya yerinin sermayesi (6000 / 20 = 300 $).
- `"copy": false` → trader gözlem listesinde başlar.
- `"pin": true` → bot bu trader'ı hiçbir zaman otomatik çıkarmaz.
- Listeden bir trader'ı silersen bot onu tamamen çıkarır (sonucu portföyde kalır) ve
  6 ay boyunca aday olarak tekrar önermez.
- Bot otomatik bulduğu trader'ları ayar dosyasına yazmaz; onlar `hl_state.json`'da tutulur
  ve mesajlarda "(oto)" etiketiyle görünür.
- Kuralların eşikleri `rotation` altında değiştirilebilir (varsayılanlar `hl_rotation.py`
  dosyasının başında). Otomatik kadro yönetimini kapatmak için: `"rotation": {"enabled": false}`.

## Sanal portföy nasıl hesaplanır

| Ayar | Değer | Açıklama |
| --- | --- | --- |
| Büyüklük | Hesap oranında | Trader hesabının 0,5 katı pozisyon açarsa sen de alt portföyünün 0,5 katını açarsın |
| Kaldıraç sınırı | 5x | Her alt portföyün toplam pozisyonu, değerinin 5 katını geçemez |
| Yalnızca yeni pozisyonlar | Açık | Takip başladığında açık olan pozisyonlar kopyalanmaz |
| Asgari emir | 10 $ | Altındaki emirler atlanır ve raporda sayılır |
| Ücret | %0,095 | Hyperliquid işlem ücreti (%0,045) + Hyperdash ücreti (%0,05) |
| Kayma | %0,05 | Her emirde aleyhe fiyat farkı |

## Sınırlamalar

- İki kontrol arasında açılıp kapanan işlemler görülmez.
- Fonlama ücretleri ve likidasyon simüle edilmez.
- Hyperdash'in kendi büyüklük hesabı farklı olabilir (bot her trader için ayrı alt portföy tutar).
- Trader ölçümleri Hyperliquid'in herkese açık verisinden hesaplanır; Hyperdash'in
  "copy score" değeri dışarıdan alınamadığı için kullanılmaz.
