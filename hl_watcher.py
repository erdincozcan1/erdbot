#!/usr/bin/env python3
"""
Hyperliquid Trader Takip + Sanal Portföy + Otomatik Kadro Botu
--------------------------------------------------------------
GitHub Actions'ta birkaç dakikada bir çalışır. Hiç işlem açmaz, hiçbir cüzdana bağlanmaz.

- Trader'ların Hyperliquid pozisyonlarını okur (herkese açık API) ve hareketlerini Telegram'a bildirir.
- "Hyperdash Copytrade ile kopyalasaydın" sorusunu sanal bir portföyle hesaplar: her ana kopya
  trader'ına eşit pay, hesap oranında büyüklük, ücret + kayma, 10$ altı emirler atlanır,
  toplam kaldıraç max_leverage ile sınırlı.
- Kadroyu otomatik yönetir (hl_rotation.py):
    * Ana kopya: sanal portföyde kopyalanan trader'lar (sabit sayıda yer).
    * Gözlem: ana listeden çıkarılanlar ve yedekler; "gölge portföy" ile kopyalanmaya devam eder
      ama sonuçları ana portföye katılmaz. Düzelirlerse otomatik geri alınır.
    * Boş yer kalırsa Hyperliquid sıralama listesinden yeni aday bulunur.
  Çıkarılan trader'ın açık sanal pozisyonları o anki fiyattan kapatılır, sonucu portföyde kalır.
- Haftalık rapor: pazartesi 09:00 (İstanbul) sonrası ilk çalışma.
- Telegram komutları: /durum, /rapor, /gozlem

Simülasyondur; gerçek sonuçlar farklı olabilir. Yatırım tavsiyesi değildir.

Ortam değişkenleri: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
Dosyalar: hl_traders.json (ayarlar), hl_state.json (bot tarafından tutulur), hl_rotation.py (kurallar)
"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

import hl_rotation as rot_mod

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "hl_traders.json"
STATE_PATH = HERE / "hl_state.json"
API = "https://api.hyperliquid.xyz/info"
IST = dt.timezone(dt.timedelta(hours=3))
SIZE_TOL = 0.001          # %0,1'den küçük boyut değişimlerini yok say
DISCLAIMER = "<i>Simülasyondur, yatırım tavsiyesi değildir.</i>"
LIGHT_TYPES = {"clearinghouseState", "spotClearinghouseState", "allMids", "l2Book", "orderStatus"}

session = requests.Session()
WEIGHT = {"used": 0}
_wlock = threading.Lock()


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


def iso(t: dt.datetime | None = None) -> str:
    return (t or now_ist()).isoformat(timespec="minutes")


def days_since(s: str | None) -> float:
    if not s:
        return 0.0
    return (now_ist() - dt.datetime.fromisoformat(s)).total_seconds() / 86400


def link(addr: str, label: str) -> str:
    return f'<a href="https://hyperdash.com/address/{addr}">{e(label)}</a>'


# --------------------------------------------------------------------------- #
# Hyperliquid (herkese açık /info)
# --------------------------------------------------------------------------- #

def post(body: dict):
    last = None
    for attempt in range(3):
        try:
            r = session.post(API, json=body, timeout=30)
            if r.status_code == 200:
                data = r.json()
                if data is not None:
                    w = 2 if body.get("type") in LIGHT_TYPES else 20
                    if body.get("type") in {"userFills", "userFillsByTime"} and isinstance(data, list):
                        w += len(data) // 20
                    with _wlock:
                        WEIGHT["used"] += w
                    return data
            last = f"HTTP {r.status_code}"
            if r.status_code == 429:
                time.sleep(10)
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


def fetch_accounts(addrs: list[str], dexes: list[str]) -> dict:
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(lambda a: fetch_account(a, dexes), addrs))
    return dict(zip(addrs, results))


def fetch_mids(dexes: list[str]) -> dict[str, float]:
    out = {}
    for dex in dexes:
        for k, v in post({"type": "allMids", "dex": dex}).items():
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                pass
    return out


def fetch_portfolio(address: str):
    return post({"type": "portfolio", "user": address})


def fetch_fills(address: str):
    return post({"type": "userFills", "user": address, "aggregateByTime": True})


def fetch_leaderboard() -> list:
    r = session.get(rot_mod.LEADERBOARD_URL, timeout=120)
    r.raise_for_status()
    return r.json().get("leaderboardRows", [])


# --------------------------------------------------------------------------- #
# Telegram
# --------------------------------------------------------------------------- #

class Telegram:
    def __init__(self, token: str, chat_id: str):
        self.url = f"https://api.telegram.org/bot{token}"
        self.chat_id = str(chat_id)
        self.errors: list[str] = []
        self.sent = 0

    def send(self, text: str) -> None:
        for chunk in [text[i:i + 3900] for i in range(0, len(text), 3900)]:
            try:
                r = session.post(self.url + "/sendMessage", json={
                    "chat_id": self.chat_id, "text": chunk, "parse_mode": "HTML",
                    "disable_web_page_preview": True}, timeout=20)
                body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                if r.status_code != 200 or not body.get("ok"):
                    err = f"HTTP {r.status_code}: {body.get('description', r.text[:120])}"
                    self.errors.append(err)
                    print(f"[hata] Telegram mesajı reddedildi: {err}", file=sys.stderr)
                else:
                    self.sent += 1
            except requests.RequestException as ex:
                self.errors.append(str(ex))
                print(f"[hata] Telegram'a ulaşılamadı: {ex}", file=sys.stderr)
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
# Sanal alt portföy
# --------------------------------------------------------------------------- #

def new_sub(capital: float) -> dict:
    return {"capital": capital, "realized": 0.0, "fees": 0.0, "trades": 0,
            "skipped": 0, "positions": {}, "followed": []}


def sub_equity(sub: dict, mids: dict) -> float:
    upnl = sum(p["sz"] * (mids.get(c, p["entry"]) - p["entry"]) for c, p in sub["positions"].items())
    return sub["capital"] + sub["realized"] - sub["fees"] + upnl


def sub_return(sub: dict, mids: dict) -> float:
    return sub_equity(sub, mids) / sub["capital"] - 1 if sub["capital"] else 0.0


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


def close_all(sub: dict, mids: dict, cfg: dict) -> None:
    for coin, p in list(sub["positions"].items()):
        paper_trade(sub, coin, 0.0, mids.get(coin) or p["entry"], cfg)


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
    return {
        "version": 2,
        "started": iso(),
        "snapshots": {},
        "subs": {},          # ana kopya alt portföyleri
        "shadow": {},        # gözlem listesinin gölge portföyleri (toplama katılmaz)
        "roles": {},
        "closed_pnl": 0.0,   # ana listeden çıkarılanların kesinleşmiş kâr/zararı
        "closed": [],
        "metrics": {},
        "rotation": {"slots": None, "last_daily": None, "last_monthly": None, "changes": [],
                     "dropped": {}, "discovery": None, "last_discovery": None, "cap_sig": None},
        "watch_events": {},
        "history": [],
        "last_report": {"week": None, "equity": cfg["paper_capital_usd"]},
        "tg_offset": 0,
        "fail_count": 0,
    }


def migrate(state: dict, cfg: dict) -> None:
    """Eski sürümün durum dosyasını yeni yapıya taşır (mevcut sanal pozisyonlar korunur)."""
    old_version = state.get("version", 1)
    fresh = init_state(cfg)
    for k, v in fresh.items():
        if k != "version":
            state.setdefault(k, v)
    for k, v in fresh["rotation"].items():
        state["rotation"].setdefault(k, v)
    if old_version >= 2:
        return
    state["version"] = 2
    for t in cfg["traders"]:
        a = t["address"].lower()
        copy = t.get("copy", True)
        state["roles"][a] = {"role": "active" if copy else "bench", "label": t.get("label") or a[:8],
                             "source": "config", "since": state["started"], "pin": bool(t.get("pin")),
                             "cfg_copy": copy, "eq0": (state["snapshots"].get(a) or {}).get("equity")}
    for a in list(state["subs"]):
        if state["roles"].get(a, {}).get("role") != "active":
            del state["subs"][a]


def n_slots(cfg: dict, state: dict) -> int:
    return int(cfg["_rot"].get("slots") or state["rotation"]["slots"] or 1)


def per_slot(cfg: dict, state: dict) -> float:
    return cfg["paper_capital_usd"] / n_slots(cfg, state)


def actives(state: dict) -> list[str]:
    return [a for a, r in state["roles"].items() if r["role"] == "active"]


def benches(state: dict) -> list[str]:
    return [a for a, r in state["roles"].items() if r["role"] == "bench"]


def free_slots(cfg: dict, state: dict) -> int:
    return max(0, n_slots(cfg, state) - len(state["subs"]))


def total_capital(state: dict, cfg: dict) -> float:
    return sum(s["capital"] for s in state["subs"].values()) + free_slots(cfg, state) * per_slot(cfg, state)


def total_equity(state: dict, mids: dict, cfg: dict) -> float:
    """Ana portföy = ana kopya alt portföyleri + çıkarılanların sonucu + boş yerlerdeki nakit."""
    return (sum(sub_equity(s, mids) for s in state["subs"].values()) + state.get("closed_pnl", 0.0)
            + free_slots(cfg, state) * per_slot(cfg, state))


def max_drawdown(history: list, current: float) -> float:
    peak, mdd = 0.0, 0.0
    for _, v in history + [[None, current]]:
        peak = max(peak, v)
        if peak > 0:
            mdd = max(mdd, 1 - v / peak)
    return mdd


def label_of(state: dict, a: str) -> str:
    return (state["roles"].get(a) or {}).get("label") or a[:8]


# --------------------------------------------------------------------------- #
# Kadro değişiklikleri
# --------------------------------------------------------------------------- #

def demote(state: dict, a: str, reason: str, kind: str, mids: dict, cfg: dict, snaps: dict) -> str:
    """Ana kopyadan gözleme: sanal pozisyonlar kapatılır, sonuç portföyde kalır."""
    r = state["roles"][a]
    sub = state["subs"].pop(a)
    close_all(sub, mids, cfg)
    final = sub_equity(sub, mids)
    pnl = final - sub["capital"]
    state["closed_pnl"] = round(state.get("closed_pnl", 0.0) + pnl, 6)
    state["closed"] = (state["closed"] + [{"a": a, "label": r["label"], "pnl": round(pnl, 2),
                                           "ret": round(final / sub["capital"] - 1, 4), "from": r["since"],
                                           "to": iso(), "why": reason}])[-50:]
    r.update(role="bench", since=iso(), eq0=(snaps.get(a) or {}).get("equity"))
    state["shadow"][a] = new_sub(per_slot(cfg, state))
    state["rotation"]["changes"].append([iso(), kind, a, r["label"]])
    state["rotation"]["changes"] = state["rotation"]["changes"][-200:]
    return (f"⬇️ {link(a, r['label'])} ana kopyadan <b>gözleme</b> alındı\n"
            f"   Neden: {e(reason)}\n"
            f"   Kopya sonucu: {usd(sub['capital'])} → {usd(final)} ({pct(final / sub['capital'] - 1)}); "
            f"pozisyonlar kapatıldı, sonuç portföyde kaldı")


def promote(state: dict, a: str, reason: str, kind: str, cfg: dict, snaps: dict) -> str:
    r = state["roles"][a]
    state["shadow"].pop(a, None)
    state["subs"][a] = new_sub(per_slot(cfg, state))
    r.update(role="active", since=iso(), eq0=(snaps.get(a) or {}).get("equity") or r.get("eq0"))
    state["rotation"]["changes"].append([iso(), kind, a, r["label"]])
    return (f"⬆️ {link(a, r['label'])} <b>ana kopyaya</b> alındı ({usd(per_slot(cfg, state))})\n"
            f"   Neden: {e(reason)}\n   Mevcut pozisyonları kopyalanmaz; yeni hareketleri kopyalanır")


def remove_trader(state: dict, a: str, reason: str, mids: dict, cfg: dict, snaps: dict) -> str:
    r = state["roles"].get(a) or {}
    line = ""
    if a in state["subs"]:
        line = demote(state, a, reason, "remove", mids, cfg, snaps) + "\n"
    state["roles"].pop(a, None)
    state["shadow"].pop(a, None)
    state["snapshots"].pop(a, None)
    state["metrics"].pop(a, None)
    state["rotation"]["dropped"][a] = iso()
    return line + f"🗑 {e(r.get('label', a[:8]))} listeden tamamen çıkarıldı ({e(reason)})"


def changes_this_month(state: dict, kinds: set) -> int:
    m = now_ist().strftime("%Y-%m")
    return sum(1 for c in state["rotation"]["changes"] if c[0][:7] == m and c[1] in kinds)


def add_role(state: dict, a: str, label: str, role: str, source: str, cfg: dict, snaps: dict,
             pin: bool = False, cfg_copy: bool = True) -> None:
    state["roles"][a] = {"role": role, "label": label, "source": source, "since": iso(), "pin": pin,
                         "cfg_copy": cfg_copy, "eq0": (snaps.get(a) or {}).get("equity")}
    if role == "active":
        state["subs"].setdefault(a, new_sub(per_slot(cfg, state)))
    else:
        state["shadow"].setdefault(a, new_sub(per_slot(cfg, state)))
    state["rotation"]["dropped"].pop(a, None)


def sync_config(state: dict, cfg: dict, mids: dict) -> list[str]:
    """Ayar dosyasındaki elle yapılan değişiklikleri kadroya uygular."""
    notes = []
    want = {t["address"].lower(): t for t in cfg["traders"]}
    for a, r in list(state["roles"].items()):
        if r["source"] == "config" and a not in want:
            notes.append(remove_trader(state, a, "ayar dosyasından silindi", mids, cfg, state["snapshots"]))
    for a, t in want.items():
        copy = t.get("copy", True)
        r = state["roles"].get(a)
        if r is None:
            role = "active" if copy and len(state["subs"]) < n_slots(cfg, state) else "bench"
            add_role(state, a, t.get("label") or a[:8], role, "config", cfg, state["snapshots"],
                     pin=bool(t.get("pin")), cfg_copy=copy)
            continue
        r["label"] = t.get("label") or r["label"]
        r["pin"] = bool(t.get("pin"))
        r["source"] = "config"
        if r.get("cfg_copy", True) != copy:
            r["cfg_copy"] = copy
            if not copy and r["role"] == "active":
                notes.append(demote(state, a, "ayar dosyasında copy: false yapıldı", "manual", mids, cfg,
                                    state["snapshots"]))
            elif copy and r["role"] == "bench" and len(state["subs"]) < n_slots(cfg, state):
                notes.append(promote(state, a, "ayar dosyasında copy: true yapıldı", "manual", cfg,
                                     state["snapshots"]))
    # eksik alt portföyleri tamamla
    for a, r in state["roles"].items():
        if r["role"] == "active" and a not in state["subs"]:
            state["subs"][a] = new_sub(per_slot(cfg, state))
        if r["role"] == "bench" and a not in state["shadow"]:
            state["shadow"][a] = new_sub(per_slot(cfg, state))
    for a in list(state["subs"]):
        if state["roles"].get(a, {}).get("role") != "active":
            del state["subs"][a]
    for a in list(state["shadow"]):
        if state["roles"].get(a, {}).get("role") != "bench":
            del state["shadow"][a]
    return notes


# --------------------------------------------------------------------------- #
# Ölçümler, günlük/aylık kararlar, aday tarama
# --------------------------------------------------------------------------- #

def budget_left(rot: dict) -> int:
    return rot["weight_budget"] - WEIGHT["used"]


def refresh_metrics(state: dict, rot: dict, now_ms: int) -> None:
    """Her çalışmada, API sınırına takılmadan, ölçümü en eski olan birkaç trader'ı günceller."""
    order = sorted(state["roles"], key=lambda a: (state["metrics"].get(a) or {}).get("t", 0))
    for a in order:
        if now_ms - (state["metrics"].get(a) or {}).get("t", 0) < 20 * rot_mod.HOUR_MS:
            break
        if budget_left(rot) < 160:
            break
        try:
            state["metrics"][a] = rot_mod.analyze(fetch_portfolio(a), fetch_fills(a), now_ms)
        except Exception as ex:
            print(f"[uyarı] {a[:8]} ölçümü alınamadı: {ex}", file=sys.stderr)
            break


def fresh_metrics(state: dict, a: str, now_ms: int, max_h: float = 48):
    m = state["metrics"].get(a)
    return m if m and now_ms - m.get("t", 0) < max_h * rot_mod.HOUR_MS else None


def bench_status(state: dict, a: str, mids: dict, snaps: dict, now_ms: int, rot: dict) -> tuple[bool, str]:
    m = fresh_metrics(state, a, now_ms)
    r = state["roles"][a]
    risk = rot_mod.risk_reasons(m, snaps.get(a) or {"equity": 0, "positions": {}}, r.get("eq0"), now_ms, rot)
    sh = state["shadow"].get(a)
    return rot_mod.promotion_check(m, sub_return(sh, mids) if sh else None, days_since(r["since"]), risk, rot)


def daily_review(state: dict, cfg: dict, rot: dict, snaps: dict, mids: dict, now_ms: int) -> list[str]:
    n = now_ist()
    today = n.date().isoformat()
    rs = state["rotation"]
    if rs["last_daily"] == today or n.hour < 9:
        return []
    # Ölçümler henüz güncellenmediyse biraz bekle (en geç 21:00'e kadar)
    stale = [a for a in actives(state) if not fresh_metrics(state, a, now_ms, 30)]
    if stale and n.hour < 21:
        return []
    rs["last_daily"] = today
    notes = []

    # 1) Risk kontrolü: anında gözleme
    for a in actives(state):
        r = state["roles"][a]
        if r.get("pin"):
            continue
        reasons = rot_mod.risk_reasons(fresh_metrics(state, a, now_ms), snaps.get(a) or {"equity": 0, "positions": {}},
                                       r.get("eq0"), now_ms, rot)
        if reasons:
            notes.append(demote(state, a, "risk: " + "; ".join(reasons), "risk", mids, cfg, snaps))

    # 2) Aylık performans kontrolü (ayın ilk günlük kontrolünde)
    month = n.strftime("%Y-%m")
    if rs["last_monthly"] != month:
        rs["last_monthly"] = month
        left = rot["max_changes_per_month"] - changes_this_month(state, {"perf", "swap"})
        cands = []
        for a in actives(state):
            r = state["roles"][a]
            if r.get("pin") or days_since(r["since"]) < rot["min_active_days"]:
                continue
            m = fresh_metrics(state, a, now_ms)
            reasons = rot_mod.performance_reasons(m, sub_return(state["subs"][a], mids), rot)
            if reasons:
                cands.append(((m or {}).get("ret_window") or 0, a, reasons))
        for _, a, reasons in sorted(cands):
            if left <= 0:
                notes.append(f"ℹ️ {e(label_of(state, a))} da çıkarma kuralına takıldı ama bu ayki "
                             f"değişiklik sınırı ({rot['max_changes_per_month']}) doldu; ana listede kalıyor")
                continue
            notes.append(demote(state, a, "performans: " + "; ".join(reasons), "perf", mids, cfg, snaps))
            left -= 1
        # Yer değiştirme: dolu listede, gözlemde çok daha iyi biri varsa
        if left > 0 and free_slots(cfg, state) == 0:
            weak = []
            for a in actives(state):
                r = state["roles"][a]
                m = fresh_metrics(state, a, now_ms)
                if (r.get("pin") or days_since(r["since"]) < rot["min_active_days"] or not m
                        or m.get("ret_window") is None or m["ret_window"] >= 0):
                    continue
                weak.append((m["ret_window"], a))
            ready = []
            for b in benches(state):
                ok, why = bench_status(state, b, mids, snaps, now_ms, rot)
                if ok:
                    ready.append((state["metrics"][b]["ret_window"], b, why))
            if weak and ready:
                wr, wa = min(weak)
                br, ba, why = max(ready)
                if br > wr + rot["swap_margin"]:
                    notes.append(demote(state, wa, f"gözlemdeki {label_of(state, ba)} çok daha iyi durumda "
                                        f"(son dönem {pct(wr)} / {pct(br)})", "swap", mids, cfg, snaps))
                    notes.append(promote(state, ba, why, "swap-in", cfg, snaps))

    # 3) Gözlem listesinin bakımı (yalnızca otomatik bulunanlar silinir)
    for b in benches(state):
        r = state["roles"][b]
        if r["source"] == "auto" and days_since(r["since"]) > rot["bench_drop_days"]:
            notes.append(remove_trader(state, b, f"{rot['bench_drop_days']} gündür gözlemde, düzelmedi",
                                       mids, cfg, snaps))
    auto_b = sorted((sub_return(state["shadow"][b], mids), b) for b in benches(state)
                    if state["roles"][b]["source"] == "auto")
    while len(benches(state)) > rot["bench_max"] and auto_b:
        _, b = auto_b.pop(0)
        notes.append(remove_trader(state, b, "gözlem listesi dolu; gölge portföyü en zayıf olan", mids, cfg, snaps))

    # 4) Boş yerleri gözlemdeki hazır trader'larla doldur
    if free_slots(cfg, state) > 0:
        ready = []
        for b in benches(state):
            ok, why = bench_status(state, b, mids, snaps, now_ms, rot)
            if ok:
                ready.append((sub_return(state["shadow"][b], mids), b, why))
        for _, b, why in sorted(ready, reverse=True)[: free_slots(cfg, state)]:
            notes.append(promote(state, b, why, "promote", cfg, snaps))

    # 5) Hâlâ boş yer varsa yeni aday aramayı başlat
    disc = rot["discovery"]
    if (free_slots(cfg, state) > 0 and disc["enabled"] and not rs["discovery"]
            and days_since(rs["last_discovery"]) >= (disc["retry_days"] if rs["last_discovery"] else 0)):
        rs["discovery"] = {"started": iso(), "queue": None, "found": [], "checked": 0}
        notes.append(f"🔎 {free_slots(cfg, state)} boş yer için Hyperliquid'de yeni aday aranıyor "
                     f"(birkaç çalışma sürebilir)")
    return notes


def discovery_step(state: dict, cfg: dict, rot: dict, mids: dict, now_ms: int) -> list[str]:
    rs = state["rotation"]
    d = rs.get("discovery")
    if not d:
        return []
    disc = rot["discovery"]
    dexes = cfg.get("dexes", [""])
    if d["queue"] is None:
        recent_drop = {a for a, t in rs["dropped"].items() if days_since(t) < 180}
        try:
            rows = fetch_leaderboard()
        except Exception as ex:
            print(f"[uyarı] sıralama listesi alınamadı: {ex}", file=sys.stderr)
            return []
        d["queue"] = rot_mod.prefilter_leaderboard(rows, set(state["roles"]) | recent_drop, disc)
    need = free_slots(cfg, state) + disc["extra_to_bench"]
    while d["queue"] and budget_left(rot) >= 180 and len(d["found"]) < need:
        a = d["queue"].pop(0)
        try:
            snap = fetch_account(a, dexes)
            m = rot_mod.analyze(fetch_portfolio(a), fetch_fills(a), now_ms)
        except Exception as ex:
            print(f"[uyarı] aday {a[:8]} incelenemedi: {ex}", file=sys.stderr)
            continue
        d["checked"] += 1
        ok, score, desc = rot_mod.candidate_check(m, snap, disc)
        if ok:
            d["found"].append({"a": a, "score": round(score, 4), "desc": desc})
            state["metrics"][a] = m
    if d["queue"] and len(d["found"]) < need:
        return []            # sonraki çalışmada devam

    # Sonuç
    notes = []
    found = sorted(d["found"], key=lambda x: -x["score"])
    for f in found:
        a = f["a"]
        if a in state["roles"]:
            continue
        if free_slots(cfg, state) > 0:
            add_role(state, a, f"{a[:6]} (oto)", "active", "auto", cfg, {})
            state["rotation"]["changes"].append([iso(), "new", a, f"{a[:6]} (oto)"])
            notes.append(f"⬆️ Yeni trader {link(a, a[:6] + ' (oto)')} <b>ana kopyaya</b> alındı "
                         f"({usd(per_slot(cfg, state))})\n   {e(f['desc'])}\n"
                         f"   Mevcut pozisyonları kopyalanmaz; yeni hareketleri kopyalanır")
        elif len(benches(state)) < rot["bench_max"]:
            add_role(state, a, f"{a[:6]} (oto)", "bench", "auto", cfg, {})
            notes.append(f"👁 Yeni aday {link(a, a[:6] + ' (oto)')} <b>gözleme</b> alındı\n   {e(f['desc'])}")
    if not found:
        notes.append(f"🔎 Aday taraması bitti: {d['checked']} hesap incelendi, kriterleri karşılayan çıkmadı. "
                     f"{disc['retry_days']} gün sonra tekrar aranacak.")
    rs["discovery"] = None
    rs["last_discovery"] = iso()
    return notes


def change_message(notes: list[str]) -> str:
    text = "🔁 <b>Kadro değişikliği</b>\n\n" + "\n\n".join(notes)
    if any(n.startswith(("⬇️", "⬆️")) for n in notes):
        text += ("\n\n👉 Hyperdash'te gerçekten kopyalıyorsan aynı değişikliği orada da yap "
                 "(bot oradaki ayarlarını değiştiremez).")
    return text


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
    eq = total_equity(state, mids, cfg)
    cap = total_capital(state, cfg)
    realized = sum(s["realized"] for s in state["subs"].values())
    fees = sum(s["fees"] for s in state["subs"].values())
    upnl = sum(sub_equity(s, mids) - s["capital"] - s["realized"] + s["fees"] for s in state["subs"].values())
    mdd = max_drawdown(state["history"], eq)
    lines = [f"📊 <b>{title}</b>",
             f"Başlangıç {e(state['started'][:10])} · sermaye {usd(cap)}",
             f"<b>Sanal portföy: {usd(eq)} ({pct(eq / cap - 1)})</b>",
             f"Gerçekleşen {usd(realized, True)} · açık {usd(upnl, True)} · ücret {usd(-fees)}"]
    if state.get("closed_pnl"):
        lines.append(f"Listeden çıkarılanların sonucu: {usd(state['closed_pnl'], True)}")
    if free_slots(cfg, state):
        lines.append(f"Boş yer: {free_slots(cfg, state)} (nakit bekliyor)")
    lines += [f"En büyük düşüş: {pct(-mdd)}", "", f"<b>Ana kopya ({len(state['subs'])})</b>"]
    rows = []
    for addr, s in state["subs"].items():
        se = sub_equity(s, mids)
        poss = ", ".join(f"{c} {side(p['sz'])}" for c, p in s["positions"].items()) or "pozisyon yok"
        rows.append((se / s["capital"] - 1,
                     f"• {e(label_of(state, addr))}: {usd(se)} ({pct(se / s['capital'] - 1)}) · "
                     f"{s['trades']} işlem, {s['skipped']} atlanan · {e(poss)}"))
    lines += [r for _, r in sorted(rows, reverse=True)]
    if state["shadow"]:
        lines.append(f"\nGözlemde {len(state['shadow'])} trader (ayrıntı: /gozlem)")
    return "\n".join(lines)


def bench_text(state: dict, cfg: dict, rot: dict, mids: dict, now_ms: int) -> str:
    if not state["shadow"]:
        return "👁 Gözlem listesi boş."
    rows = []
    for a, sh in state["shadow"].items():
        ok, why = bench_status(state, a, mids, state["snapshots"], now_ms, rot)
        r = state["roles"][a]
        moves = state.get("watch_events", {}).get(a, 0)
        rows.append((sub_return(sh, mids),
                     f"• {e(r['label'])}: gölge {pct(sub_return(sh, mids))} · {days_since(r['since']):.0f} gün · "
                     f"bu hafta {moves} hareket · {'✅ geri dönmeye hazır' if ok else e(why)}"))
    return ("👁 <b>Gözlem listesi</b> (gölge portföy: kopyalansaydı ne olurdu; ana portföye katılmaz)\n"
            + "\n".join(r for _, r in sorted(rows, reverse=True)))


def weekly_report(state: dict, cfg: dict, rot: dict, mids: dict, now_ms: int) -> str:
    eq = total_equity(state, mids, cfg)
    last = state["last_report"].get("equity") or total_capital(state, cfg)
    text = summary_text(state, cfg, mids, "Haftalık rapor")
    text = text.replace("\n", f"\nBu hafta: {pct(eq / last - 1)}\n", 1) if last else text
    week_ago = now_ist() - dt.timedelta(days=7)
    ch = [c for c in state["rotation"]["changes"] if dt.datetime.fromisoformat(c[0]) >= week_ago]
    if ch:
        kinds = {"risk": "risk", "perf": "performans", "swap": "yer değiştirme", "swap-in": "yer değiştirme",
                 "promote": "geri döndü", "new": "yeni aday", "manual": "elle", "remove": "silindi"}
        text += "\n\n<b>Bu haftaki kadro değişiklikleri</b>\n" + "\n".join(
            f"• {c[0][5:10]} {e(c[3] if len(c) > 3 else label_of(state, c[2]))}: {kinds.get(c[1], c[1])}" for c in ch)
    if state["shadow"]:
        text += "\n\n" + bench_text(state, cfg, rot, mids, now_ms)
    return text + "\n\n" + DISCLAIMER


# --------------------------------------------------------------------------- #
# Ana akış
# --------------------------------------------------------------------------- #

def process_events(state: dict, cfg: dict, a: str, old: dict, new: dict, mids: dict, tg: Telegram) -> None:
    r = state["roles"][a]
    active = r["role"] == "active"
    sub = state["subs"][a] if active else state["shadow"][a]
    cfg_t = next((t for t in cfg["traders"] if t["address"].lower() == a), {})
    for coin in sorted(set(old["positions"]) | set(new["positions"])):
        prev, now = old["positions"].get(coin), new["positions"].get(coin)
        ev = classify(prev["szi"] if prev else 0.0, now["szi"] if now else 0.0)
        if not ev:
            continue
        lines = [trader_line(r["label"], ev, prev, now, new["equity"], coin)]
        if ev in {"OPEN", "FLIP"} and coin not in sub["followed"]:
            sub["followed"].append(coin)
        mid = mids.get(coin)
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
                act = (f"kapatıldı @ {px(info['price'])}" if target == 0 else
                       f"{side(target)} {qty(target)} {e(coin)} (~{usd(abs(target) * mid)}) @ {px(info['price'])}")
                rr = f" · gerçekleşen {usd(info['realized'], True)}" if info["realized"] else ""
                se = sub_equity(sub, mids)
                lines.append(f"   📒 Sanal: {act}{rr}\n   alt portföy {usd(se)} ({pct(se / sub['capital'] - 1)})")
        if ev == "CLOSE" and coin in sub["followed"]:
            sub["followed"].remove(coin)
        if active:
            tg.send("\n".join(lines))
        else:
            state["watch_events"][a] = state["watch_events"].get(a, 0) + 1
            if cfg_t.get("instant"):
                tg.send("\n".join(lines) + "\n   👁 gözlem listesi (gölge portföy)")


def run(cfg: dict, state: dict, tg: Telegram) -> None:
    rot = cfg["_rot"]
    dexes = cfg.get("dexes", [""])
    now_ms = int(time.time() * 1000)
    rs = state["rotation"]
    if not rs["slots"]:
        rs["slots"] = rot.get("slots") or max(1, sum(1 for t in cfg["traders"] if t.get("copy", True)))
    first_run = not state["snapshots"]

    mids = fetch_mids(dexes)
    notes = sync_config(state, cfg, mids)

    # Sermaye ayarı değiştiyse haftalık karşılaştırma tabanını yenile
    sig = [cfg["paper_capital_usd"], n_slots(cfg, state)]
    if rs["cap_sig"] != sig:
        if not first_run:
            state["last_report"]["equity"] = round(total_equity(state, mids, cfg), 2)
        rs["cap_sig"] = sig

    addrs = list(state["roles"])
    snaps = fetch_accounts(addrs, dexes)
    for a, r in state["roles"].items():
        if r.get("eq0") is None:
            r["eq0"] = snaps[a]["equity"]

    if first_run:
        lines = ["🤖 <b>Hyperliquid takip botu başladı</b>",
                 f"Sanal sermaye {usd(cfg['paper_capital_usd'])} · {n_slots(cfg, state)} ana kopya yeri "
                 f"(her birine {usd(per_slot(cfg, state))}) · kaldıraç sınırı {cfg['max_leverage']:g}x",
                 "Mevcut pozisyonlar kopyalanmaz; yalnızca bundan sonraki hareketler izlenir.", ""]
        for a in addrs:
            s = snaps[a]
            poss = ", ".join(f"{c} {side(p['szi'])} {usd(p['value'])}" for c, p in s["positions"].items()) or "pozisyon yok"
            tag = "ana kopya" if state["roles"][a]["role"] == "active" else "gözlem"
            lines.append(f"<b>{e(label_of(state, a))}</b> ({tag}) · {usd(s['equity'])}\n   {e(poss)}")
        lines.append("\nKomutlar: /durum · /rapor · /gozlem")
        tg.send("\n".join(lines))
        state["snapshots"] = snaps
        state["history"].append([iso(), round(total_equity(state, mids, cfg), 2)])
        return

    for a in addrs:
        old, new = state["snapshots"].get(a), snaps[a]
        if old is not None:                 # sonradan eklenen trader'ın ilk kaydı: sadece başlangıç
            process_events(state, cfg, a, old, new, mids, tg)
        state["snapshots"][a] = new

    # Kadro yönetimi
    if rot["enabled"]:
        refresh_metrics(state, rot, now_ms)
        notes += daily_review(state, cfg, rot, snaps, mids, now_ms)
        notes += discovery_step(state, cfg, rot, mids, now_ms)
    if notes:
        tg.send(change_message(notes))

    # Saatlik değer kaydı
    eq = total_equity(state, mids, cfg)
    last_t = dt.datetime.fromisoformat(state["history"][-1][0]) if state["history"] else None
    if not last_t or (now_ist() - last_t) >= dt.timedelta(minutes=55):
        state["history"].append([iso(), round(eq, 2)])
        state["history"] = state["history"][-3000:]

    # Komutlar (Cloudflare Worker kuruluysa komutlara o cevap verir)
    cmds, state["tg_offset"] = tg.commands(state["tg_offset"])
    for c in cmds:
        if c == "/durum":
            tg.send(summary_text(state, cfg, mids, "Anlık durum") + "\n\n" + DISCLAIMER)
        elif c == "/rapor":
            tg.send(weekly_report(state, cfg, rot, mids, now_ms))
        elif c in {"/gozlem", "/gözlem"}:
            tg.send(bench_text(state, cfg, rot, mids, now_ms))
        elif c in {"/start", "/yardim", "/help"}:
            tg.send("Komutlar: /durum · /rapor · /gozlem")

    # Haftalık rapor: pazartesi 09:00 İstanbul sonrası ilk çalışma
    n = now_ist()
    week = f"{n.isocalendar()[0]}-W{n.isocalendar()[1]:02d}"
    if n.weekday() == 0 and n.hour >= 9 and state["last_report"]["week"] != week:
        tg.send(weekly_report(state, cfg, rot, mids, now_ms))
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
    cfg["_rot"] = rot_mod.merged_config(cfg)
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print("TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID gerekli.", file=sys.stderr)
        return 1

    tg = Telegram(token, chat)
    state = load_json(STATE_PATH, None) or init_state(cfg)
    migrate(state, cfg)
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
            tg.send(f"⚠️ Son 4 çalışma başarısız oldu: {e(str(ex)[:200])}\nBot denemeye devam ediyor.")
    finally:
        after = json.dumps(state, sort_keys=True)
        if after != before:
            STATE_PATH.write_text(json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8")
    errors = getattr(tg, "errors", [])
    print(f"Telegram: {getattr(tg, 'sent', 0)} mesaj gönderildi, {len(errors)} hata. API ağırlığı: {WEIGHT['used']}")
    if errors:
        print("Telegram mesajları gönderilemedi. TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID secret'larını kontrol et "
              "(token yenilendiyse GitHub'daki secret'ı da güncellemek gerekir).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
