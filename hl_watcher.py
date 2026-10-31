#!/usr/bin/env python3
"""
Hyperliquid Trader Takip + Sanal Portföy Botu
---------------------------------------------
GitHub Actions'ta 30 dakikada bir çalışır. Hiç işlem açmaz, hiçbir cüzdana bağlanmaz.

- Seçtiğin trader'ların Hyperliquid pozisyonlarını okur (herkese açık API).
- Yeni pozisyon / büyütme / küçültme / yön değiştirme / kapanışları Telegram'a bildirir.
- "Bu trader'ları Hyperdash Copytrade ile kopyalasaydın" sorusunu sanal bir portföyle hesaplar:
  her kopya trader'ı sermayenin eşit bir payını alır, pozisyonlar hesap oranında açılır,
  işlem ücreti + Hyperdash ücreti + kayma düşülür, 10$ altı emirler atlanır,
  toplam kaldıraç max_leverage ile sınırlanır.
- Her pazartesi 09:00'dan (İstanbul) sonraki ilk çalışmada haftalık rapor gönderir.
- Telegram komutları (bir sonraki çalışmada, en geç ~30 dk içinde yanıtlanır):
    /durum   anlık sanal portföy özeti
    /rapor   haftalık raporu hemen gönder

Bu bir simülasyondur; gerçek sonuçlar fiyat farkı, fonlama ücretleri ve Hyperdash'in
kendi büyüklük hesabı nedeniyle farklı olabilir. Yatırım tavsiyesi değildir.

Ortam değişkenleri: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
Dosyalar: hl_traders.json (ayarlar), hl_state.json (bot tarafından tutulur)
"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "hl_traders.json"
STATE_PATH = HERE / "hl_state.json"
API = "https://api.hyperliquid.xyz/info"
IST = dt.timezone(dt.timedelta(hours=3))
SIZE_TOL = 0.001          # %0,1'den küçük boyut değişimlerini yok say
DISCLAIMER = "<i>Simülasyondur, yatırım tavsiyesi değildir.</i>"

session = requests.Session()


# --------------------------------------------------------------------------- #
# Yardımcılar
# --------------------------------------------------------------------------- #

def e(x) -> str:
    return html.escape(str(x), quote=False)


def usd(x: float, sign: bool = False) -> str:
    s = "+" if sign and x > 0 else ("−" if x < 0 else "")
    a = abs(x)
    if a >= 1e6:
        return f"{s}{a / 1e6:,.2f}M$"
    if a >= 1e4:
        return f"{s}{a / 1e3:,.1f}K$"
    return f"{s}{a:,.2f}$"


def pct(x: float) -> str:
    return f"{'+' if x > 0 else ('−' if x < 0 else '')}%{abs(x) * 100:.1f}"


def px(x: float | None) -> str:
    if not x:
        return "-"
    return f"{x:,.2f}" if x >= 100 else f"{x:,.4f}" if x >= 1 else f"{x:.6g}"


def qty(x: float) -> str:
    a = abs(x)
    return f"{a:,.0f}" if a >= 1000 else f"{a:,.2f}" if a >= 1 else f"{a:.4g}"


def side(s: float) -> str:
    return "LONG" if s > 0 else "SHORT"


def now_ist() -> dt.datetime:
    return dt.datetime.now(IST)


# --------------------------------------------------------------------------- #
# Hyperliquid (herkese açık /info)
# --------------------------------------------------------------------------- #

def post(body: dict):
    last = None
    for attempt in range(3):
        try:
            r = session.post(API, json=body, timeout=20)
            if r.status_code == 200:
                data = r.json()
                if data is not None:
                    return data
            last = f"HTTP {r.status_code}"
        except requests.RequestException as ex:
            last = str(ex)
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Hyperliquid API yanıt vermedi: {last}")


def fetch_account(address: str, dexes: list[str]) -> dict:
    """Hesap değeri (perp hesapları + spot'taki serbest USDC) ve açık pozisyonlar."""
    equity, positions = 0.0, {}
    for dex in dexes:
        st = post({"type": "clearinghouseState", "user": address, "dex": dex})
        equity += float(st["marginSummary"]["accountValue"])
        for ap in st.get("assetPositions", []):
            p = ap["position"]
            szi = float(p["szi"])
            if szi == 0:
                continue
            positions[p["coin"]] = {
                "szi": szi,
                "entry": float(p.get("entryPx") or 0),
                "lev": float((p.get("leverage") or {}).get("value") or 1),
                "liq": float(p["liquidationPx"]) if p.get("liquidationPx") else None,
                "value": abs(float(p.get("positionValue") or 0)),
            }
    try:
        spot = post({"type": "spotClearinghouseState", "user": address})
        for b in spot.get("balances", []):
            if b.get("coin") == "USDC":
                equity += max(0.0, float(b["total"]) - float(b.get("hold", 0)))
    except Exception:
        pass
    return {"equity": equity, "positions": positions}


def fetch_mids(dexes: list[str]) -> dict[str, float]:
    out = {}
    for dex in dexes:
        for k, v in post({"type": "allMids", "dex": dex}).items():
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                pass
    return out


# --------------------------------------------------------------------------- #
# Telegram
# --------------------------------------------------------------------------- #

class Telegram:
    def __init__(self, token: str, chat_id: str):
        self.url = f"https://api.telegram.org/bot{token}"
        self.chat_id = str(chat_id)

    def send(self, text: str) -> None:
        for chunk in [text[i:i + 3900] for i in range(0, len(text), 3900)]:
            try:
                session.post(self.url + "/sendMessage", json={
                    "chat_id": self.chat_id, "text": chunk, "parse_mode": "HTML",
                    "disable_web_page_preview": True}, timeout=20)
            except requests.RequestException as ex:
                print(f"[uyarı] Telegram gönderilemedi: {ex}", file=sys.stderr)
            time.sleep(0.5)

    def commands(self, offset: int) -> tuple[list[str], int]:
        try:
            r = session.get(self.url + "/getUpdates", params={"offset": offset, "timeout": 0},
                            timeout=20).json()
        except Exception:
            return [], offset
        cmds = []
        for u in r.get("result", []):
            offset = max(offset, u["update_id"] + 1)
            msg = u.get("message") or {}
            if str((msg.get("chat") or {}).get("id")) == self.chat_id:
                t = (msg.get("text") or "").strip().split("@")[0].lower()
                if t.startswith("/"):
                    cmds.append(t)
        return cmds, offset


# --------------------------------------------------------------------------- #
# Olay tespiti
# --------------------------------------------------------------------------- #

def classify(prev: float, now: float) -> str | None:
    if prev == 0 and now == 0:
        return None
    if prev == 0:
        return "OPEN"
    if now == 0:
        return "CLOSE"
    if (prev > 0) != (now > 0):
        return "FLIP"
    if abs(abs(now) - abs(prev)) <= abs(prev) * SIZE_TOL:
        return None
    return "INCREASE" if abs(now) > abs(prev) else "DECREASE"


EV_TEXT = {"OPEN": "yeni pozisyon açtı", "CLOSE": "pozisyonu kapattı", "FLIP": "yön değiştirdi",
           "INCREASE": "pozisyonu büyüttü", "DECREASE": "pozisyonu küçülttü"}
EV_ICON = {"OPEN": "🆕", "CLOSE": "✅", "FLIP": "🔄", "INCREASE": "➕", "DECREASE": "➖"}


# --------------------------------------------------------------------------- #
# Sanal alt portföy (her kopya trader'ı için ayrı)
# --------------------------------------------------------------------------- #

def sub_equity(sub: dict, mids: dict) -> float:
    upnl = sum(p["sz"] * (mids.get(c, p["entry"]) - p["entry"]) for c, p in sub["positions"].items())
    return sub["capital"] + sub["realized"] - sub["fees"] + upnl


def sub_gross(sub: dict, mids: dict, exclude: str | None = None) -> float:
    return sum(abs(p["sz"]) * mids.get(c, p["entry"]) for c, p in sub["positions"].items() if c != exclude)


def paper_trade(sub: dict, coin: str, target_sz: float, mid: float, cfg: dict) -> tuple[str, dict]:
    """Alt portföyde coin pozisyonunu target_sz'ye getirir. ('ok'|'skip', bilgi) döndürür."""
    pos = sub["positions"].get(coin)
    cur = pos["sz"] if pos else 0.0
    delta = target_sz - cur
    if abs(delta) * mid < 1e-9:
        return "skip", {"reason": "pozisyon zaten hedefte"}
    if target_sz != 0 and abs(delta) * mid < cfg["min_order_usd"]:
        return "skip", {"reason": f"emir {usd(abs(delta) * mid)}; Hyperliquid asgarisi {cfg['min_order_usd']:g}$"}

    slip = cfg["slippage_pct"] / 100
    price = mid * (1 + slip) if delta > 0 else mid * (1 - slip)
    fee = abs(delta) * price * cfg["fee_pct"] / 100
    realized = 0.0

    if cur == 0:
        sub["positions"][coin] = {"sz": target_sz, "entry": price}
    elif target_sz == 0:
        realized = (price - pos["entry"]) * cur
        del sub["positions"][coin]
    elif (cur > 0) != (target_sz > 0):                      # yön değiştirme
        realized = (price - pos["entry"]) * cur
        sub["positions"][coin] = {"sz": target_sz, "entry": price}
    elif abs(target_sz) > abs(cur):                          # büyütme
        pos["entry"] = (cur * pos["entry"] + delta * price) / target_sz
        pos["sz"] = target_sz
    else:                                                    # küçültme
        realized = (price - pos["entry"]) * (cur - target_sz)
        pos["sz"] = target_sz

    sub["realized"] += realized
    sub["fees"] += fee
    sub["trades"] += 1
    return "ok", {"price": price, "fee": fee, "realized": realized, "delta": delta}


def plan_target(sub: dict, coin: str, trader_snap: dict, mid: float, cfg: dict, mids: dict) -> tuple[float, str | None]:
    """Trader'ın pozisyon/hesap oranını alt portföye uygular, kaldıraç sınırını uygular."""
    eq_sub = sub_equity(sub, mids)
    p = trader_snap["positions"].get(coin)
    if not p or trader_snap["equity"] <= 0 or eq_sub <= 0:
        return 0.0, None
    target_usd = (p["szi"] * mid / trader_snap["equity"]) * eq_sub
    note = None
    room = max(0.0, cfg["max_leverage"] * eq_sub - sub_gross(sub, mids, exclude=coin))
    if abs(target_usd) > room:
        note = f"{cfg['max_leverage']:g}x toplam kaldıraç sınırı: {usd(abs(target_usd))} → {usd(room)}"
        target_usd = room if target_usd > 0 else -room
    return target_usd / mid, note


# --------------------------------------------------------------------------- #
# Durum
# --------------------------------------------------------------------------- #

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def init_state(cfg: dict) -> dict:
    copiers = [t for t in cfg["traders"] if t.get("copy", True)]
    per = cfg["paper_capital_usd"] / max(1, len(copiers))
    return {
        "started": now_ist().isoformat(timespec="minutes"),
        "snapshots": {},
        "subs": {t["address"].lower(): {"capital": per, "realized": 0.0, "fees": 0.0, "trades": 0,
                                         "skipped": 0, "positions": {}, "followed": []}
                 for t in copiers},
        "watch_events": {},
        "history": [],
        "last_report": {"week": None, "equity": cfg["paper_capital_usd"]},
        "tg_offset": 0,
        "fail_count": 0,
    }


def total_equity(state: dict, mids: dict) -> float:
    return sum(sub_equity(s, mids) for s in state["subs"].values())


def max_drawdown(history: list, current: float) -> float:
    peak, mdd = 0.0, 0.0
    for _, v in history + [[None, current]]:
        peak = max(peak, v)
        if peak > 0:
            mdd = max(mdd, 1 - v / peak)
    return mdd


# --------------------------------------------------------------------------- #
# Mesajlar
# --------------------------------------------------------------------------- #

def trader_line(label: str, ev: str, prev: dict | None, now: dict | None, equity: float, coin: str) -> str:
    head = f"{EV_ICON[ev]} <b>{e(label)}</b> {EV_TEXT[ev]}: <b>{e(coin)}</b>"
    if ev == "CLOSE":
        return f"{head} {side(prev['szi'])} (giriş {px(prev['entry'])})"
    ratio = now["value"] / equity if equity > 0 else 0
    extra = f" · önce {qty(prev['szi'])}" if prev and ev in {"INCREASE", "DECREASE"} else ""
    r = f"{ratio:.2f}" if ratio >= 0.1 else f"{ratio:.3f}"
    return (f"{head} {side(now['szi'])}\n"
            f"   {qty(now['szi'])} ({usd(now['value'])}, hesabının {r} katı){extra}\n"
            f"   giriş {px(now['entry'])} · {now['lev']:g}x · likidasyon {px(now['liq'])}")


def summary_text(state: dict, cfg: dict, mids: dict, title: str) -> str:
    eq = total_equity(state, mids)
    cap = cfg["paper_capital_usd"]
    realized = sum(s["realized"] for s in state["subs"].values())
    fees = sum(s["fees"] for s in state["subs"].values())
    upnl = eq - cap - realized + fees
    mdd = max_drawdown(state["history"], eq)
    labels = {t["address"].lower(): t["label"] for t in cfg["traders"]}
    lines = [f"📊 <b>{title}</b>",
             f"Başlangıç {e(state['started'][:10])} · sermaye {usd(cap)}",
             f"<b>Sanal portföy: {usd(eq)} ({pct(eq / cap - 1)})</b>",
             f"Gerçekleşen {usd(realized, True)} · açık {usd(upnl, True)} · ücret {usd(-fees)}",
             f"En büyük düşüş: {pct(-mdd)}", "", "<b>Trader bazında</b>"]
    rows = []
    for addr, s in state["subs"].items():
        se = sub_equity(s, mids)
        poss = ", ".join(f"{c} {side(p['sz'])}" for c, p in s["positions"].items()) or "pozisyon yok"
        rows.append((se / s["capital"] - 1,
                     f"• {e(labels.get(addr, addr[:8]))}: {usd(se)} ({pct(se / s['capital'] - 1)}) · "
                     f"{s['trades']} işlem, {s['skipped']} atlanan · {e(poss)}"))
    lines += [r for _, r in sorted(rows, reverse=True)]
    return "\n".join(lines)


def weekly_report(state: dict, cfg: dict, mids: dict) -> str:
    eq = total_equity(state, mids)
    last = state["last_report"].get("equity") or cfg["paper_capital_usd"]
    text = summary_text(state, cfg, mids, "Haftalık rapor")
    text = text.replace("\n", f"\nBu hafta: {pct(eq / last - 1)}\n", 1) if last else text
    w = state.get("watch_events", {})
    if w:
        labels = {t["address"].lower(): t["label"] for t in cfg["traders"]}
        rows = [f"• {e(labels.get(a, a[:8]))}: {n} hareket" for a, n in sorted(w.items(), key=lambda x: -x[1])]
        text += "\n\n<b>İzleme listesi (bu hafta)</b>\n" + "\n".join(rows)
    return text + "\n\n" + DISCLAIMER


# --------------------------------------------------------------------------- #
# Ana akış
# --------------------------------------------------------------------------- #

def run(cfg: dict, state: dict, tg: Telegram) -> None:
    dexes = cfg.get("dexes", [""])
    traders = cfg["traders"]
    first_run = not state["snapshots"]

    # Yeni eklenen kopya trader'lar için alt portföy aç (mevcut sermayeye dokunmadan)
    for t in traders:
        a = t["address"].lower()
        if t.get("copy", True) and a not in state["subs"]:
            per = cfg["paper_capital_usd"] / max(1, sum(1 for x in traders if x.get("copy", True)))
            state["subs"][a] = {"capital": per, "realized": 0.0, "fees": 0.0, "trades": 0,
                                "skipped": 0, "positions": {}, "followed": []}

    snaps = {t["address"].lower(): fetch_account(t["address"].lower(), dexes) for t in traders}
    mids = fetch_mids(dexes)

    if first_run:
        lines = ["🤖 <b>Hyperliquid takip botu başladı</b>",
                 f"Sanal sermaye {usd(cfg['paper_capital_usd'])} · {len(state['subs'])} kopya trader "
                 f"(her birine {usd(cfg['paper_capital_usd'] / max(1, len(state['subs'])))}) · "
                 f"kaldıraç sınırı {cfg['max_leverage']:g}x",
                 "Mevcut pozisyonlar kopyalanmaz; yalnızca bundan sonraki hareketler izlenir "
                 "(Hyperdash'teki \"yalnızca yeni pozisyonlar\" ayarı gibi).", ""]
        for t in traders:
            s = snaps[t["address"].lower()]
            poss = ", ".join(f"{c} {side(p['szi'])} {usd(p['value'])}" for c, p in s["positions"].items()) or "pozisyon yok"
            tag = "kopya" if t.get("copy", True) else "izleme"
            lines.append(f"<b>{e(t['label'])}</b> ({tag}) · {usd(s['equity'])}\n   {e(poss)}")
        lines.append("\nKomutlar: /durum · /rapor (en geç ~30 dk içinde yanıtlanır)")
        tg.send("\n".join(lines))
        state["snapshots"] = snaps
        state["history"].append([now_ist().isoformat(timespec="minutes"), round(total_equity(state, mids), 2)])
        return

    for t in traders:
        a = t["address"].lower()
        old, new = state["snapshots"].get(a), snaps[a]
        if old is None:                       # listeye sonradan eklenen trader: sadece başlangıç kaydı
            state["snapshots"][a] = new
            continue
        is_copy = t.get("copy", True)
        for coin in sorted(set(old["positions"]) | set(new["positions"])):
            prev, now = old["positions"].get(coin), new["positions"].get(coin)
            ev = classify(prev["szi"] if prev else 0.0, now["szi"] if now else 0.0)
            if not ev:
                continue
            if not is_copy:
                state["watch_events"][a] = state["watch_events"].get(a, 0) + 1
                if t.get("instant", False):
                    tg.send(trader_line(t["label"], ev, prev, now, new["equity"], coin) + "\n   👁 izleme listesi")
                continue

            sub = state["subs"][a]
            mid = mids.get(coin)
            lines = [trader_line(t["label"], ev, prev, now, new["equity"], coin)]
            if ev in {"OPEN", "FLIP"} and coin not in sub["followed"]:
                sub["followed"].append(coin)
            if coin not in sub["followed"]:
                lines.append("   📒 Sanal: bu pozisyon takip başlamadan önce açılmıştı; kopyalanmıyor")
            elif not mid:
                lines.append("   📒 Sanal: fiyat alınamadı, atlandı")
            else:
                target, note = plan_target(sub, coin, new, mid, cfg, mids)
                status, info = paper_trade(sub, coin, target, mid, cfg)
                if note:
                    lines.append(f"   ⚠ {e(note)}")
                if status == "skip":
                    sub["skipped"] += 1
                    lines.append(f"   📒 Sanal: atlandı ({e(info['reason'])})")
                else:
                    if target == 0:
                        act = f"kapatıldı @ {px(info['price'])}"
                    else:
                        act = f"{side(target)} {qty(target)} {e(coin)} (~{usd(abs(target) * mid)}) @ {px(info['price'])}"
                    r = f" · gerçekleşen {usd(info['realized'], True)}" if info["realized"] else ""
                    se = sub_equity(sub, mids)
                    lines.append(f"   📒 Sanal: {act}{r}\n   alt portföy {usd(se)} ({pct(se / sub['capital'] - 1)})")
            if ev == "CLOSE" and coin in sub["followed"]:
                sub["followed"].remove(coin)
            tg.send("\n".join(lines))
        state["snapshots"][a] = new

    # Saatlik değer kaydı
    eq = total_equity(state, mids)
    last_t = dt.datetime.fromisoformat(state["history"][-1][0]) if state["history"] else None
    if not last_t or (now_ist() - last_t) >= dt.timedelta(minutes=55):
        state["history"].append([now_ist().isoformat(timespec="minutes"), round(eq, 2)])
        state["history"] = state["history"][-3000:]

    # Komutlar
    cmds, state["tg_offset"] = tg.commands(state["tg_offset"])
    for c in cmds:
        if c == "/durum":
            tg.send(summary_text(state, cfg, mids, "Anlık durum") + "\n\n" + DISCLAIMER)
        elif c == "/rapor":
            tg.send(weekly_report(state, cfg, mids))
        elif c in {"/start", "/yardim", "/help"}:
            tg.send("Komutlar: /durum · /rapor\nBot 30 dakikada bir çalışır; yanıt en geç o kadar sürer.")

    # Haftalık rapor: pazartesi 09:00 İstanbul sonrası ilk çalışma
    n = now_ist()
    week = f"{n.isocalendar()[0]}-W{n.isocalendar()[1]:02d}"
    if n.weekday() == 0 and n.hour >= 9 and state["last_report"]["week"] != week:
        tg.send(weekly_report(state, cfg, mids))
        state["last_report"] = {"week": week, "equity": round(eq, 2)}
        state["watch_events"] = {}


def main() -> int:
    cfg = load_json(CONFIG_PATH, None)
    if not cfg:
        print("hl_traders.json bulunamadı veya bozuk.", file=sys.stderr)
        return 1
    cfg.setdefault("paper_capital_usd", 2100)
    cfg.setdefault("max_leverage", 5)
    cfg.setdefault("fee_pct", 0.095)
    cfg.setdefault("slippage_pct", 0.05)
    cfg.setdefault("min_order_usd", 10)
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print("TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID gerekli.", file=sys.stderr)
        return 1

    tg = Telegram(token, chat)
    state = load_json(STATE_PATH, None) or init_state(cfg)
    before = json.dumps(state, sort_keys=True)
    try:
        run(cfg, state, tg)
        if state["fail_count"] >= 4:
            tg.send("✅ Hyperliquid bağlantısı yeniden kuruldu, takip sürüyor.")
        state["fail_count"] = 0
    except Exception as ex:
        state["fail_count"] = state.get("fail_count", 0) + 1
        print(f"[hata] {ex}", file=sys.stderr)
        if state["fail_count"] == 4:
            tg.send(f"⚠️ Son 4 çalışma (~2 saat) başarısız oldu: {e(str(ex)[:200])}\nBot denemeye devam ediyor.")
    finally:
        after = json.dumps(state, sort_keys=True)
        if after != before:
            STATE_PATH.write_text(json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
