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
| `hl_scanner.py` | Aday veritabanı (100 bin $ üstü bütün hesapları haftada bir tarar) |
| `hl_traders.json` | Ayarlar ve trader listesi |
| `hl_state.json` | Botun hafızası (kendisi tutar, elle düzenleme) |
| `hl_db.json` | Aday veritabanı; depoda görünmez, GitHub Actions önbelleğinde saklanır |
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

**Aday veritabanı:** Bot arka planda, her çalışmanın kalan birkaç dakikasında Hyperliquid
sıralama listesindeki hesap değeri 100 bin $ üstü bütün hesapları (~15.000) tarar:
1. Her hesabın aylık geçmişi okunur (kârlı ay oranı, en kötü ay, en iyi ayın payı, 12 aylık getiri, düşüşler).
2. Bu ölçümlere göre en iyi 200 hesabın işlem kayıtları ve açık pozisyonları ayrıntılı incelenir.
3. Aşağıdaki kriterleri geçenler puana göre sıralanır (`/adaylar` ile görebilirsin).

İlk tam tarama yaklaşık 10 saat sürer (Hyperliquid'in hız sınırı: dakikada ~50 hesap), sonra her hafta
kendini yeniler; yenileme sırasında önceki sıralama kullanılmaya devam eder. Tarama bitince Telegram'a
"📚 Aday veritabanı güncellendi" mesajı gelir. Veritabanı depoya yazılmaz (depoyu şişirmesin diye);
GitHub Actions önbelleğinde tutulur. Önbellek silinirse bot taramayı baştan yapar.

**Yeni aday:** Boş yer kalır ve gözlemde hazır kimse yoksa bot önce aday veritabanındaki sıralamaya bakar
ve en iyi adayı güncel veriyle yeniden kontrol edip alır. Veritabanı henüz hazır değilse bot Hyperliquid sıralama
listesinden ön eleme yapar (100 bin $–20 milyon $ hesap, toplamda ve son ayda kârda,
son ay aktif işlem yapmış, piyasa yapıcı/bot değil, aşırı getirili değil) ve en fazla
80 hesabı ayrıntılı inceler:
- en az 12 ay geçmiş, ayların en az %60'ı kârlı, en kötü ay −%40'tan iyi (geniş grup sınırı; aşağıya bak)
- son 12 ayın Sharpe oranı en az 2 (kalite eşiği; `"min_sharpe"`), son 30 günde işlem yapmış ya da açık pozisyonu var
- kârın yarısından fazlası tek bir aydan gelmemiş
- pozisyonları ortalama en az 4 saat tutuyor, sık işlem yapmıyor, kaldıraç en fazla 3x
- kazanç son aylara yığılmamış: son 3 ayın toplam getirideki payı en fazla %50; en az 18 aylık
  geçmişi olanlarda son 6 ayın payı en fazla %70. Dolar değil yüzde getiri üzerinden ölçülür,
  böylece hesabı zamanla büyüyen trader'lar haksız yere elenmez. (Hyperliquid verisi en fazla
  ~30 ay, 2024 ortasına kadar geriye gidiyor.)
- tek bir pozisyon hesabın 2 katından büyük değil
- likidasyona %20'den yakın çapraz teminatlı pozisyon yok; likidasyona yakın izole pozisyonların
  teminatı toplamda hesabın %10'unu aşmıyor (izole pozisyon likide olursa yalnızca kendi teminatı gider)

**Risk grupları ve sıralama:** Kadro bir "trader fonu" gibi iki risk grubundan oluşur:

| Grup | Kural | Ana kopyada |
|---|---|---|
| Çekirdek | En kötü ay ≥ −%15 ve ayların en az %70'i kârlı | Sınırsız |
| Geniş (yüksek risk) | En kötü ay ≥ −%40 ve ayların en az %60'ı kârlı | Çekirdek dışından toplam en fazla 4 trader (`"max_wide"`) |

Kurallardan geçen adaylar **son 12 ayın Sharpe oranına** göre sıralanır (getiri ÷ oynaklık, yıllık).
Geniş grup doluysa yeni geniş adaylar gözleme alınır, boş yerlere çekirdek adaylar girer. Panelde her
trader'ın grubu etiket olarak görünür (12 aydan kısa geçmişi olanlar "dışında" sayılır).

**Kendini besleme:**
- **Kalite eşiği:** Ana kopyaya (ve gözlemden geri dönüşe) yalnızca Sharpe ≥ 2 olan trader girer. Eşiği geçen
  aday yoksa yer nakit bekler; kadro kendiliğinden küçülür, yeni aday çıktıkça yeniden dolar.
- **Kalite yenilemesi:** Her ayın ilk günlük kontrolünde, ana kopyada en az 56 gündür olan ve Sharpe'ı 1'in
  altına düşen trader'lar, aday listesinde Sharpe ≥ 2 olan daha iyileri varsa gözleme alınır (aylık en fazla
  3 değişiklik sınırı performans çıkarmalarıyla ortak).
- **Aylık sistem testi:** Her ayın 1'inde "Aylık sistem testi" iş akışı güncel veriyi baştan toplar (~5 saat),
  botun bugünkü kurallarını geçmişte 7 tarihte uygular ve Telegram'a rapor gönderir: kaç trader en iyisi,
  Sharpe eşiği hâlâ ayrıştırıyor mu, botun seçimi rastgele seçimden iyi mi. Kurallar otomatik değişmez;
  rapor öneri verir. Rapor ve veri `bt-data` dalına kaydedilir.

Kasım 2026 testi (2.508 hesap, 7 başlangıç tarihi, sonraki 6 ay): kurallardan geçen adaylardan Sharpe'a
göre seçilen 10'luk portföyler hiçbir dönemde zararda bitmedi (ortalama +%18, eski puanla +%10); Sharpe'a
göre sıralandığında en kötü ay sınırını −%15'ten −%40'a gevşetmek sonucu bozmadı (+%19) ve aday havuzunu
yaklaşık 3 katına çıkardı. En kötü ay kuralı ise büyük kayıpları elemede hâlâ en güçlü ölçüm, bu yüzden
sınır olarak kalıyor. Riske göre pay vermek (oynaklığın tersiyle) tutarlı bir iyileşme göstermediği için
her trader'a eşit pay verilmeye devam ediyor. Sharpe dilimlerine göre sonraki 6 ay (medyan): 1'in altı +%0,1,
1–2 arası +%0,9, 2–3 arası +%8,1, 3 üstü +%19,3; kalite eşiği buna dayanır. Kadro büyüklüğü testinde en iyi
sonuç, tüm piyasa ölçeğinde yaklaşık 18–22 trader'la alındı (daha fazlasında sıralamada geride kalan zayıf
adaylar ortalamayı düşürüyor).

Bu eşikler 3.741 hesaplık geçmiş veri testine dayanır: kriterler iki ayrı tarihte (Kasım 2025, Mayıs 2026)
yalnızca o güne kadarki veriyle uygulanıp sonraki 6 ay ölçüldü. En güçlü kural "en kötü ay" çıktı
(sonraki 6 ayda %20'den fazla kaybedenlerin oranını %38'den %21'e indiriyor); "son 12 ay kârda" ve
"son ay / son hafta kârda" şartları etkisiz bulunduğu için kaldırıldı.

Son iki pozisyon kuralı gözlemden ana listeye geri dönüşte de uygulanır. Ana listedeki trader'lar bu
kurallar yüzünden çıkarılmaz; onlar için risk ve performans kontrolleri geçerlidir.

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
4. **Komutlar:** `/durum` (anlık özet), `/rapor` (haftalık rapor), `/gozlem` (gözlem listesi),
   `/adaylar` (aday veritabanının en iyi 15'i ve tarama durumu).

## Panel (tarayıcıdan)

Cloudflare Worker, botun bütün verilerini gösteren bir sayfa sunar: `https://<worker-adresi>/panel`.
Portföy değeri ve getirisi, getiri grafiği (sermaye değişiklikleri ayıklanmış), trader'lar ve
açık sanal pozisyonları, gözlem listesi, kadro değişiklikleri ve aday veritabanı. Her dakika kendini
yeniler; telefonda da çalışır. Açmak için Worker'a `PANEL_KEY` değişkeni (kendi belirlediğin bir
anahtar) eklenmeli; sayfa ilk açılışta bu anahtarı sorar ve tarayıcıda saklar.

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
| Kaldıraç sınırı | 10x | Her alt portföyün toplam pozisyonu, değerinin 10 katını geçemez (günlük risk kuralındaki 10x sınırıyla aynı) |
| Yalnızca yeni pozisyonlar | Açık | Takip başladığında açık olan pozisyonlar kopyalanmaz |
| Asgari emir | Yok | Her hamle, ne kadar küçük olursa olsun kopyalanır (`min_order_usd: 0`). Gerçek Hyperdash kopyasında 10 $ altı emirler gerçekleşmez; gerçekçi sonuç için 10 yapılabilir |
| Ücret | %0,095 | Hyperliquid işlem ücreti (%0,045) + Hyperdash ücreti (%0,05) |
| Kayma | %0,05 | Her emirde aleyhe fiyat farkı |
| Fonlama | Anlık oran | Açık sanal pozisyonlara her çalışmada Hyperliquid'in o anki saatlik fonlama oranı işlenir (long öder, short alır). Kapatmak için `"simulate_funding": false` |

**Karşılaştırmalar:** Haftalık raporda ve panelde portföy getirisi aynı dönemde BTC'yi elde tutmakla
karşılaştırılır. "Kopyalama farkı", ana listedeki trader'ların listeye girdiklerinden beri kendi
hesaplarının getirisi ile kopya alt portföylerinin getirisi arasındaki farktır; gecikme, ücret, kayma,
fonlama ve kaldıraç sınırının toplam etkisini gösterir.

**Gecikme etkisi:** Ana kopyada her sanal işlemden sonra bot, trader'ın o aralıktaki gerçek işlemlerini
(`userFillsByTime`) okur ve kopyanın girdiği fiyatı (kayma hariç) trader'ın aynı yöndeki ortalama işlem
fiyatıyla karşılaştırır. Fark Telegram mesajında, panelde (özet ve trader ayrıntısı) ve haftalık raporda
dolar ve baz puan (bps) olarak gösterilir. Sanal portföyün sonucunu değiştirmez; yalnızca ölçer.
Kapatmak için `"measure_delay": false`.

**Portföy uyarıları:** Bot hiçbir pozisyonu kendiliğinden kapatmaz, yalnızca Telegram'a haber verir:

| Uyarı | Varsayılan | Ne zaman |
|---|---|---|
| Zirveden düşüş | %5, %10, %15 | Ana portföy zirvesinden bu seviyelerin altına indiğinde, her seviye için bir kez (yeni zirvede sıfırlanır) |
| Günlük kayıp | %3 | Son 24 saatte bu kadar düştüğünde (en fazla 12 saatte bir) |
| Yoğunlaşma | %10 | Bir varlıktaki net pozisyon portföyün bu kadarını aştığında, bir kez (eşiğin %80'inin altına inince sıfırlanır) |

Getiri, trader ekleme/çıkarmadan kaynaklanan sermaye değişimlerinden arındırılarak ölçülür. Eşikleri
`hl_traders.json` içinde `"alerts": {"dd_levels": [0.05, 0.1, 0.15], "day_loss": 0.03, "coin_share": 0.1}`
ile değiştirebilir, `"alerts": {"enabled": false}` ile kapatabilirsin.

**Karşılaştırma:** Paneldeki portföy getirisi grafiğinde BTC, Nasdaq-100 (Hyperliquid'deki `xyz:XYZ100`
kontratı) ve altın (`xyz:GOLD`) aynı aralıkta %0'dan başlayan kesikli çizgilerle gösterilir; lejanttan
açılıp kapatılabilir. Bot bunları saatlik değer kaydına yazar; daha önceki saatler Hyperliquid mum verisinden
doldurulur. Nasdaq-100 ve altın kontratları 7/24 işlem görür; borsa kapalıyken fiyatları gerçek endeksten
biraz sapabilir.

**Panel:** "Risk ölçümleri" kartı portföyün günlük getirilerinden yıllık oynaklık, Sharpe, Sortino, en
kötü/en iyi gün ve BTC ile korelasyon/betayı gösterir (en az 8 günlük veri gerekir; 2–3 aydan kısa
veriyle bu oranlar güvenilir değildir). "Açık pozisyonlar" sekmesindeki "Yoğunlaşma" kartı varlık bazında
net pozisyonu ve zıt yönde açılıp birbirini götüren pozisyonları gösterir.

## Sınırlamalar

- İki kontrol arasında açılıp kapanan işlemler görülmez.
- Likidasyon simüle edilmez; fonlama o anki oranla yaklaşık hesaplanır.
- Hyperdash'in kendi büyüklük hesabı farklı olabilir (bot her trader için ayrı alt portföy tutar).
- Trader ölçümleri Hyperliquid'in herkese açık verisinden hesaplanır; Hyperdash'in
  "copy score" değeri dışarıdan alınamadığı için kullanılmaz.
