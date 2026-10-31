# Finviz Günlük Sinyal Botu (Telegram)

Her sabah izleme listendeki hisseleri Finviz'den çeker, kural tabanlı puanlar ve
gerekçeleriyle **AL / TUT / SAT** sinyalini Telegram'a gönderir.

> Bu bot kural tabanlı bir tarama aracıdır, yatırım tavsiyesi değildir.
> Finviz fiyatları gecikmelidir.

## Mesajda neler var

- **Sektörler (1 ay):** en güçlü ve en zayıf 3 sektör
- **🔔 Sinyal değişiklikleri:** dünden bugüne AL/TUT/SAT değişen hisseler
- **🧠 Günün yorumu:** (isteğe bağlı) Claude'un kısa piyasa yorumu
- Her hisse için: fiyat, skor, destekleyen gerekçeler (✓), karşı gerekçeler (✗),
  risk notları (⚠) ve son haber başlığı (📰)

## Puanlama kuralları

| Alan | Artı puan | Eksi puan |
| --- | --- | --- |
| Değerleme | İleri F/K < 15, PEG < 1 | İleri F/K > 40, PEG > 3 |
| Büyüme | Gelecek yıl EPS > %15, satış büyümesi > %15 | EPS düşüşü bekleniyor, satış daralıyor |
| Kalite | ROE > %20 | Zarar (net marj < 0), borç/özkaynak > 1,5 |
| Trend | Fiyat 200 ve 50 günlük ortalamanın üstünde | Altında |
| Zamanlama | Yükselen trendde RSI < 30 (+0,5) | RSI > 75 (−0,5) |
| Analist | Öneri ≤ 1,8; hedefe > %20 potansiyel | Öneri ≥ 3; fiyat hedefin üstünde |
| İçeriden işlem | – | İçeriden satış < −%20 (−0,5) |

**Skor ≥ 4 → AL, skor ≤ −3 → SAT, arası → TUT.** Eşikler `bot.py` başındaki
`BUY_THRESHOLD` ve `SELL_THRESHOLD` ile değiştirilebilir. Bilanço tarihi, yüksek
açığa satış oranı ve sert aylık hareketler puanı etkilemez, uyarı olarak eklenir.

## Kurulum (yaklaşık 10 dakika)

### 1. Telegram botunu oluştur
1. Telegram'da **@BotFather**'a yaz, `/newbot` gönder, isim ver.
2. Verdiği **token**'ı sakla (örn. `123456:ABC...`). Kimseyle paylaşma.
3. Yeni botuna Telegram'dan bir mesaj at (örn. "merhaba").
4. Tarayıcıda `https://api.telegram.org/bot<TOKEN>/getUpdates` adresini aç;
   çıkan yanıttaki `"chat":{"id": ...}` değeri senin **chat ID**'n.

### 2. GitHub'da otomatik çalıştır (ücretsiz, önerilen)
1. GitHub'da yeni bir **private** depo oluştur ve bu klasördeki tüm dosyaları
   (gizli `.github` klasörü dahil) yükle.
2. Depoda **Settings → Secrets and variables → Actions → New repository secret**:
   - `TELEGRAM_BOT_TOKEN` = BotFather token'ı
   - `TELEGRAM_CHAT_ID` = chat ID
   - `ANTHROPIC_API_KEY` = (isteğe bağlı) Claude yorumu için API anahtarı
3. Aynı sayfada **Variables** sekmesi → `WATCHLIST` = `NVDA,TSM,LLY,...`
   (boş bırakırsan varsayılan 15 hisse kullanılır).
4. **Actions** sekmesinde "Günlük Finviz sinyali" → **Run workflow** ile hemen
   dene. Sonra her Salı–Cumartesi 09:00 (İstanbul) otomatik çalışır.

### 3. Alternatif: kendi bilgisayarında çalıştır
```bash
pip install -r requirements.txt
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
python bot.py --dry-run   # önce göndermeden dene
python bot.py             # Telegram'a gönder
```
Günlük çalıştırmak için macOS/Linux'ta `crontab -e` ile
`0 9 * * 2-6 cd /yol/finviz-telegram-bot && /usr/bin/python3 bot.py` ekle;
Windows'ta Görev Zamanlayıcı'yı kullan.

## Bilinmesi gerekenler

- **Finviz kullanım koşulları:** Finviz sayfalarının otomatik okunması koşullarına
  takılabilir. Bot günde bir kez, istekler arasında 2 saniye bekleyerek ~16 sayfa
  okur; yine de koşulları kontrol et. Daha sağlam yol Finviz Elite'in export/API
  özelliğidir.
- **Engellenme:** Finviz GitHub sunucularından gelen istekleri reddederse (HTTP 403)
  botu kendi bilgisayarında çalıştır.
- **Sayfa yapısı değişirse** veri tablosu bulunamaz; mesajın sonunda
  "Alınamayanlar" listesi görünür.
