#!/usr/bin/env python3
"""
Finviz Günlük Sinyal Botu
-------------------------
İzleme listesindeki hisseleri Finviz'den çeker, temel + teknik + analist + haber
verilerine göre kural tabanlı puanlar ve gerekçeleriyle AL / TUT / SAT sinyalini
Telegram'a gönderir.

Bu çıktı kural tabanlı bir tarama sonucudur, yatırım tavsiyesi değildir.

Kullanım:
    python bot.py               # verileri çek, Telegram'a gönder
    python bot.py --dry-run     # Telegram'a göndermeden konsola yaz

Ortam değişkenleri:
    TELEGRAM_BOT_TOKEN   (zorunlu, dry-run hariç)
    TELEGRAM_CHAT_ID     (zorunlu, dry-run hariç)
    WATCHLIST            (isteğe bağlı) virgülle ayrılmış semboller, örn. "NVDA,TSM,LLY"
    ANTHROPIC_API_KEY    (isteğe bağlı) varsa Claude kısa bir piyasa yorumu ekler
    STATE_FILE           (isteğe bağlı) önceki sinyallerin tutulduğu dosya, varsayılan state.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field

import requests
from bs4 import BeautifulSoup

# --------------------------------------------------------------------------- #
# Ayarlar
# --------------------------------------------------------------------------- #

DEFAULT_WATCHLIST = [
    "NVDA", "TSM", "MU", "LLY", "ABBV", "XOM", "MPC", "PSX",
    "INTC", "QCOM", "STX", "SNDK", "DELL", "GOOGL", "SCCO",
]

BASE = "https://finviz.com"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
REQUEST_DELAY_SEC = 2.0      # Finviz'i yormamak için istekler arası bekleme
BUY_THRESHOLD = 4            # skor >= 4  -> AL sinyali
SELL_THRESHOLD = -3          # skor <= -3 -> SAT sinyali
TELEGRAM_LIMIT = 4000        # Telegram tek mesaj sınırı 4096 karakter

CLAUDE_MODEL = "claude-sonnet-5-5"

SIGNAL_LABEL = {"BUY": "🟢 AL sinyali", "HOLD": "🟡 TUT / İZLE", "SELL": "🔴 SAT sinyali"}
SIGNAL_SHORT = {"BUY": "AL", "HOLD": "TUT", "SELL": "SAT"}

DISCLAIMER = (
    "<i>Bu mesaj Finviz verileri üzerinde çalışan kural tabanlı bir taramadır, "
    "yatırım tavsiyesi değildir. Fiyatlar gecikmelidir.</i>"
)

# --------------------------------------------------------------------------- #
# Yardımcılar: Finviz değerlerini sayıya çevirme
# --------------------------------------------------------------------------- #

_NUM = re.compile(r"-?\d+(?:\.\d+)?")
_PCT = re.compile(r"(-?\d+(?:\.\d+)?)%")


def num(value: str | None) -> float | None:
    """'25.87' -> 25.87, '243.37 -15.91%' -> 243.37, '-' -> None"""
    if not value or value.strip() in {"-", ""}:
        return None
    m = _NUM.search(value.replace(",", ""))
    return float(m.group()) if m else None


def pct(value: str | None) -> float | None:
    """'70.15%' -> 70.15, '243.37 -15.91%' -> -15.91, '-' -> None"""
    if not value or value.strip() in {"-", ""}:
        return None
    m = _PCT.search(value.replace(",", ""))
    return float(m.group(1)) if m else None


def sp(v: float, d: int = 1) -> str:
    """İşaretli yüzde: 5.2 -> '+%5.2', -5.2 -> '−%5.2'"""
    return f"{'−' if v < 0 else '+'}%{abs(v):.{d}f}"


def days_until_earnings(value: str | None, today: dt.date) -> int | None:
    """'Nov 17 AMC' -> bugüne göre gün farkı (geçmişse negatif)."""
    if not value or value.strip() == "-":
        return None
    m = re.match(r"([A-Z][a-z]{2})\s+(\d{1,2})", value.strip())
    if not m:
        return None
    try:
        d = dt.datetime.strptime(f"{m.group(1)} {m.group(2)} {today.year}", "%b %d %Y").date()
    except ValueError:
        return None
    diff = (d - today).days
    # Yıl dönümü düzeltmesi (ör. Aralık'tayken 'Jan 25')
    if diff < -200:
        diff = (d.replace(year=today.year + 1) - today).days
    elif diff > 200:
        diff = (d.replace(year=today.year - 1) - today).days
    return diff


# --------------------------------------------------------------------------- #
# Finviz'den veri çekme
# --------------------------------------------------------------------------- #

session = requests.Session()
session.headers.update(HEADERS)


def fetch(path: str, retries: int = 3) -> str:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            r = session.get(BASE + path, timeout=30)
            if r.status_code == 200:
                return r.text
            last_err = RuntimeError(f"HTTP {r.status_code}")
        except requests.RequestException as e:
            last_err = e
        time.sleep(REQUEST_DELAY_SEC * (attempt + 2))
    raise RuntimeError(f"{path} alınamadı: {last_err}")


def parse_quote(page_html: str) -> dict:
    """Hisse sayfasından snapshot tablosunu, şirket adını ve haber başlıklarını çıkarır."""
    soup = BeautifulSoup(page_html, "html.parser")
    cells = [td.get_text(" ", strip=True) for td in soup.select(".snapshot-table2 td")]
    data = {cells[i]: cells[i + 1] for i in range(0, len(cells) - 1, 2)}

    news = []
    for tr in soup.select("#news-table tr"):
        a = tr.find("a")
        if a and a.get_text(strip=True):
            news.append(a.get_text(strip=True))
        if len(news) >= 3:
            break

    name = None
    title = soup.title.get_text(strip=True) if soup.title else ""
    m = re.match(r"^[A-Z.\-]+\s*-\s*(.+?)(?:\s+Stock|\s*\||$)", title)
    if m:
        name = m.group(1).strip()

    return {"data": data, "news": news, "name": name}


def parse_sectors(page_html: str) -> list[dict]:
    """Sektör performans sayfası (groups, v=140) -> [{name, week, month, quarter, ytd}]"""
    soup = BeautifulSoup(page_html, "html.parser")
    out = []
    for tr in soup.select("table tr"):
        tds = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
        if len(tds) >= 8 and tds[0].isdigit():
            out.append({
                "name": tds[1],
                "week": pct(tds[2]),
                "month": pct(tds[3]),
                "quarter": pct(tds[4]),
                "ytd": pct(tds[7]),
            })
    return out


# --------------------------------------------------------------------------- #
# Puanlama
# --------------------------------------------------------------------------- #

@dataclass
class Result:
    ticker: str
    name: str | None
    price: float | None
    score: float = 0.0
    signal: str = "HOLD"
    pros: list[str] = field(default_factory=list)
    cons: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    news: list[str] = field(default_factory=list)
    error: str | None = None


def score_stock(ticker: str, parsed: dict, today: dt.date) -> Result:
    d = parsed["data"]
    res = Result(ticker=ticker, name=parsed.get("name"), price=num(d.get("Price")),
                 news=parsed.get("news", []))

    def add(points: float, text: str):
        res.score += points
        (res.pros if points > 0 else res.cons).append(text)

    fpe = num(d.get("Forward P/E"))
    peg = num(d.get("PEG"))
    eps_ny = pct(d.get("EPS next Y"))
    sales_yy = pct(d.get("Sales Y/Y TTM"))
    roe = pct(d.get("ROE"))
    margin = pct(d.get("Profit Margin"))
    de = num(d.get("Debt/Eq"))
    sma50 = pct(d.get("SMA50"))
    sma200 = pct(d.get("SMA200"))
    rsi = num(d.get("RSI (14)"))
    recom = num(d.get("Recom"))
    target = num(d.get("Target Price"))
    insider = pct(d.get("Insider Trans"))
    short_float = pct(d.get("Short Float"))
    perf_month = pct(d.get("Perf Month"))
    high52 = pct(d.get("52W High"))
    earn_days = days_until_earnings(d.get("Earnings"), today)

    # --- Değerleme ---
    if fpe is not None:
        if 0 < fpe < 15:
            add(1, f"ucuz değerleme (ileri F/K {fpe:.1f})")
        elif fpe > 40:
            add(-1, f"pahalı değerleme (ileri F/K {fpe:.1f})")
    if peg is not None:
        if 0 < peg < 1:
            add(1, f"büyümeye göre ucuz (PEG {peg:.2f})")
        elif peg > 3:
            add(-1, f"büyümeye göre pahalı (PEG {peg:.2f})")

    # --- Büyüme ---
    if eps_ny is not None:
        if eps_ny > 15:
            add(1, f"gelecek yıl kâr büyümesi güçlü (+%{eps_ny:.1f})")
        elif eps_ny < 0:
            add(-1, f"gelecek yıl kâr düşüşü bekleniyor ({sp(eps_ny)})")
    if sales_yy is not None:
        if sales_yy > 15:
            add(1, f"satışlar hızlı büyüyor (yıllık +%{sales_yy:.1f})")
        elif sales_yy < 0:
            add(-1, f"satışlar daralıyor (yıllık {sp(sales_yy)})")

    # --- Kalite / bilanço ---
    if roe is not None and roe > 20:
        add(1, f"yüksek özkaynak kârlılığı (ROE %{roe:.0f})")
    if margin is not None and margin < 0:
        add(-1, f"zarar ediyor (net marj {sp(margin)})")
    if de is not None and de > 1.5:
        add(-1, f"yüksek borçluluk (borç/özkaynak {de:.2f})")

    # --- Trend ---
    if sma200 is not None:
        if sma200 > 0:
            add(1, f"uzun vadeli trend yukarı (200 günlük ort. +%{sma200:.1f} üstünde)")
        else:
            add(-1, f"uzun vadeli trend aşağı (200 günlük ort. %{abs(sma200):.1f} altında)")
            if sma200 < -20:
                add(-1, "güçlü düşüş trendi (fiyat ortalamanın %20'den fazla altında)")
    if sma50 is not None:
        if sma50 > 0:
            add(1, "orta vadeli trend yukarı (50 günlük ort. üstünde)")
        else:
            add(-1, "orta vadeli trend aşağı (50 günlük ort. altında)")

    # --- Zamanlama (RSI) ---
    if rsi is not None:
        if rsi < 30:
            if sma200 is not None and sma200 > 0:
                add(0.5, f"yükselen trendde aşırı satım (RSI {rsi:.0f}), tepki potansiyeli")
            else:
                res.notes.append(f"aşırı satım (RSI {rsi:.0f}): short için sert tepki riski")
        elif rsi > 75:
            add(-0.5, f"aşırı alım (RSI {rsi:.0f}), geri çekilme riski")

    # --- Analistler ---
    if recom is not None:
        if recom <= 1.8:
            add(1, f"analist konsensüsü güçlü al (öneri {recom:.2f})")
        elif recom >= 3:
            add(-1, f"analist konsensüsü zayıf (öneri {recom:.2f})")
    if target and res.price:
        upside = (target / res.price - 1) * 100
        if upside > 20:
            add(1, f"analist hedefine %{upside:.0f} potansiyel ({target:.2f})")
        elif upside < 0:
            add(-1, f"fiyat analist hedefinin üstünde ({target:.2f}, {sp(upside, 0)})")

    # --- Diğer riskler / notlar ---
    if insider is not None and insider < -20:
        add(-0.5, f"yoğun içeriden satış ({sp(insider, 0)})")
    if short_float is not None and short_float > 15:
        res.notes.append(f"açığa satış oranı yüksek (%{short_float:.1f}): sert sıkışma riski")
    if perf_month is not None and abs(perf_month) > 25:
        res.notes.append(f"son 1 ayda çok sert hareket ({sp(perf_month)})")
    if high52 is not None and high52 < -40:
        res.notes.append(f"52 haftalık zirvenin %{abs(high52):.0f} altında")
    if earn_days is not None and 0 <= earn_days <= 7:
        res.notes.append(f"bilanço {earn_days} gün içinde ({d.get('Earnings')}): olay riski")
    elif earn_days is not None and -3 <= earn_days < 0:
        res.notes.append(f"bilanço yeni açıklandı ({d.get('Earnings')})")

    if res.score >= BUY_THRESHOLD:
        res.signal = "BUY"
    elif res.score <= SELL_THRESHOLD:
        res.signal = "SELL"
    else:
        res.signal = "HOLD"
    return res


# --------------------------------------------------------------------------- #
# İsteğe bağlı Claude yorumu
# --------------------------------------------------------------------------- #

def claude_commentary(results: list[Result], sectors: list[dict]) -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    lines = []
    for r in results:
        if r.error:
            continue
        lines.append(
            f"{r.ticker} [{SIGNAL_SHORT[r.signal]}, skor {r.score:+.1f}] "
            f"artılar: {'; '.join(r.pros[:4])} | eksiler: {'; '.join(r.cons[:4])} | "
            f"notlar: {'; '.join(r.notes)} | haberler: {' / '.join(r.news[:2])}"
        )
    sec = ", ".join(f"{s['name']} 1A %{s['month']}" for s in sectors if s.get("month") is not None)
    prompt = (
        "Aşağıda Finviz verilerinden kural tabanlı üretilmiş günlük hisse sinyalleri ve sektör "
        "performansları var. Türkçe, en fazla 5 cümlelik kısa bir piyasa yorumu yaz: günün ana "
        "temasını, öne çıkan sinyal değişikliklerini ve dikkat edilmesi gereken riskleri belirt. "
        "Kesin al/sat talimatı verme; verileri yorumla. Düz metin yaz, başlık veya madde kullanma.\n\n"
        f"Sektörler: {sec}\n\n" + "\n".join(lines)
    )
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": CLAUDE_MODEL,
                "max_tokens": 600,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=60,
        )
        r.raise_for_status()
        parts = r.json().get("content", [])
        text = "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
        return text or None
    except Exception as e:  # yorum isteğe bağlı; hata botu durdurmasın
        print(f"[uyarı] Claude yorumu alınamadı: {e}", file=sys.stderr)
        return None


# --------------------------------------------------------------------------- #
# Mesaj oluşturma
# --------------------------------------------------------------------------- #

def e(text: str) -> str:
    return html.escape(text, quote=False)


def build_messages(results: list[Result], sectors: list[dict], previous: dict,
                   commentary: str | None, today: dt.date) -> list[str]:
    blocks: list[str] = []

    header = [f"📊 <b>Günlük Finviz Sinyal Raporu</b> · {today.strftime('%d.%m.%Y')}"]
    secs = [s for s in sectors if s.get("month") is not None]
    if secs:
        secs.sort(key=lambda s: s["month"], reverse=True)
        top = ", ".join(f"{e(s['name'])} {s['month']:+.1f}%" for s in secs[:3])
        bottom = ", ".join(f"{e(s['name'])} {s['month']:+.1f}%" for s in secs[-3:])
        header.append(f"\n<b>Sektörler (1 ay)</b>\n▲ {top}\n▼ {bottom}")

    changes = []
    for r in results:
        old = previous.get(r.ticker)
        if not r.error and old and old != r.signal:
            changes.append(f"• <b>{r.ticker}</b>: {SIGNAL_SHORT[old]} → {SIGNAL_SHORT[r.signal]}")
    if changes:
        header.append("\n<b>🔔 Sinyal değişiklikleri</b>\n" + "\n".join(changes))
    if commentary:
        header.append(f"\n<b>🧠 Günün yorumu</b>\n{e(commentary)}")
    header.append("\n<i>✓ sinyali destekleyen · ✗ karşı gerekçe · ⚠ risk notu</i>")
    blocks.append("\n".join(header))

    for sig in ("BUY", "HOLD", "SELL"):
        group = sorted([r for r in results if not r.error and r.signal == sig],
                       key=lambda r: r.score, reverse=(sig != "SELL"))
        if not group:
            continue
        blocks.append(f"\n<b>{SIGNAL_LABEL[sig]}</b>")
        for r in group:
            price = f"{r.price:.2f}$" if r.price else "-"
            title = f"<b>{r.ticker}</b>" + (f" · {e(r.name)}" if r.name else "")
            lines = [f"{title}\n{price} · skor {r.score:+.1f}"]
            # Sinyale göre önce destekleyen gerekçeler, sonra karşı gerekçeler
            main, counter = (r.pros, r.cons) if sig != "SELL" else (r.cons, r.pros)
            for t in main[:4]:
                lines.append(f"  ✓ {e(t)}")
            for t in counter[:2]:
                lines.append(f"  ✗ {e(t)}")
            for t in r.notes[:3]:
                lines.append(f"  ⚠ {e(t)}")
            if r.news:
                lines.append(f"  📰 {e(r.news[0][:110])}")
            blocks.append("\n".join(lines))

    errors = [r for r in results if r.error]
    if errors:
        blocks.append("\n<i>Alınamayanlar: " + ", ".join(r.ticker for r in errors) + "</i>")
    blocks.append("\n" + DISCLAIMER)

    # Telegram sınırına göre parçalara böl
    messages, current = [], ""
    for b in blocks:
        if len(current) + len(b) + 2 > TELEGRAM_LIMIT and current:
            messages.append(current)
            current = ""
        current += ("\n" if current else "") + b
    if current:
        messages.append(current)
    return messages


def send_telegram(messages: list[str]) -> None:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["TELEGRAM_CHAT_ID"]
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    for m in messages:
        r = requests.post(url, json={
            "chat_id": chat_id,
            "text": m,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"Telegram hatası {r.status_code}: {r.text[:300]}")
        time.sleep(1)


# --------------------------------------------------------------------------- #
# Ana akış
# --------------------------------------------------------------------------- #

def load_state(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("signals", {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(path: str, results: list[Result], today: dt.date) -> None:
    signals = {r.ticker: r.signal for r in results if not r.error}
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"date": today.isoformat(), "signals": signals}, f, indent=2, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser(description="Finviz günlük sinyal botu")
    ap.add_argument("--dry-run", action="store_true", help="Telegram'a göndermeden yazdır")
    args = ap.parse_args()

    watchlist = [t.strip().upper() for t in os.environ.get("WATCHLIST", "").split(",") if t.strip()]
    watchlist = watchlist or DEFAULT_WATCHLIST
    state_file = os.environ.get("STATE_FILE", "state.json")
    today = dt.date.today()

    try:
        sectors = parse_sectors(fetch("/groups.ashx?g=sector&v=140&o=name"))
    except Exception as ex:
        print(f"[uyarı] sektör verisi alınamadı: {ex}", file=sys.stderr)
        sectors = []

    results: list[Result] = []
    for t in watchlist:
        time.sleep(REQUEST_DELAY_SEC)
        try:
            parsed = parse_quote(fetch(f"/quote.ashx?t={t}"))
            if not parsed["data"]:
                raise RuntimeError("sayfada veri tablosu bulunamadı")
            results.append(score_stock(t, parsed, today))
        except Exception as ex:
            print(f"[hata] {t}: {ex}", file=sys.stderr)
            results.append(Result(ticker=t, name=None, price=None, error=str(ex)))

    if all(r.error for r in results):
        print("Hiçbir hisse için veri alınamadı; mesaj gönderilmedi.", file=sys.stderr)
        return 1

    previous = load_state(state_file)
    commentary = claude_commentary(results, sectors)
    messages = build_messages(results, sectors, previous, commentary, today)

    if args.dry_run:
        print("\n\n----- [mesaj sınırı] -----\n\n".join(messages))
        return 0
    send_telegram(messages)
    save_state(state_file, results, today)
    print(f"{len(messages)} mesaj gönderildi.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
