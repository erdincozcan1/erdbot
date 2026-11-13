"""
İşlem kaydı toplayıcı (tek seferlik test aracı; botun çalışmasına dokunmaz).

Amaç: iki öneriyi gerçek veriyle test etmek.
  1) Pozisyonu kısa tutan trader'larda kopyalama gecikmesi kazancı ne kadar yiyor?
  2) Uzun süre yeni işlem açmayan trader'lar kadroda yer tutarken ne kaybediyoruz?

bt_pool.json'daki hesapların (geçmişte botun kurallarını geçmiş adaylar + bugünkü kadro ve yedekler)
son ~100 günlük işlem kayıtlarını, hesap değeri geçmişini ve açık pozisyonlarını indirir; işlem gören
varlıkların günlük ve 5 dakikalık fiyatlarını ekler. Sonucu bt_fills.json.gz olarak yazar.

Kullanım: python bt_fills.py [çıktı] [süre_dk]
"""

from __future__ import annotations

import collections
import gzip
import json
import os
import sys
import time

import requests

INFO = "https://api.hyperliquid.xyz/info"
OUT = sys.argv[1] if len(sys.argv) > 1 else "bt_fills.json.gz"
DEADLINE_S = (float(sys.argv[2]) if len(sys.argv) > 2 else 150) * 60
DAY = 86_400_000
RATE = 950                 # dakikada en fazla ağırlık (Hyperliquid sınırı 1200)
RECENT_DAYS = 17           # 5 dakikalık fiyat verisi en fazla ~17 gün geriye gider
MAX_PAGES = 6              # hesap başına, her dönem için en fazla sayfa (sayfa = 2000 işlem)
MAX_5M_COINS = 150

s = requests.Session()
t_start = time.time()
_recent = collections.deque()
STATS = {"calls": 0, "weight": 0, "errors": 0}


def left() -> float:
    return DEADLINE_S - (time.time() - t_start)


def _wait(w: int) -> None:
    while True:
        now = time.time()
        while _recent and now - _recent[0][0] > 60:
            _recent.popleft()
        if not _recent or sum(x[1] for x in _recent) + w <= RATE:
            _recent.append([now, w])
            return
        time.sleep(max(0.05, 60 - (now - _recent[0][0]) + 0.05))


def post(body: dict, weight: int = 20, per: int = 0):
    """per > 0 ise yanıttaki her 'per' kayıt 1 ek ağırlık sayılır (işlem kaydı 20, mum 60)."""
    for attempt in range(5):
        _wait(weight)
        try:
            r = s.post(INFO, json=body, timeout=40)
            if r.status_code == 429:
                time.sleep(15 * (attempt + 1))
                continue
            if r.status_code >= 500:
                time.sleep(3 * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json()
            STATS["calls"] += 1
            STATS["weight"] += weight
            if per and isinstance(data, list) and len(data) >= per:
                extra = len(data) // per
                _recent.append([time.time(), extra])
                STATS["weight"] += extra
            return data
        except Exception as ex:                      # ağ hatası: bekle, yeniden dene
            print("hata:", body.get("type"), str(ex)[:120])
            time.sleep(4 * (attempt + 1))
    STATS["errors"] += 1
    return None


def is_perp(coin) -> bool:
    return isinstance(coin, str) and bool(coin) and not coin.startswith("@") and "/" not in coin


def row(f: dict):
    try:
        if not is_perp(f.get("coin")):
            return None
        sz = float(f["sz"])
        return [int(f["time"]), f["coin"], float(f["px"]), sz if f.get("side") == "B" else -sz,
                float(f.get("startPosition") or 0), round(float(f.get("closedPnl") or 0), 4)]
    except (KeyError, TypeError, ValueError):
        return None


def fetch_fills(addr: str, start: int, end: int) -> tuple[list, dict]:
    """[start, end] aralığındaki işlemler. API bir yanıtta en fazla 2000 kayıt verir; hangi uçtan kestiğine
    güvenmeden önce ileri (en yeni kayıttan sonrası), sonra geri (en eski kayıttan öncesi) sayfalar."""
    seen, out = set(), []
    info = {"pages": 0, "full": True}

    def page(lo: int, hi: int):
        """(yeni kayıt sayısı, yanıttaki en küçük zaman, en büyük zaman); hata olursa None."""
        if left() < 60 or info["pages"] >= 2 * MAX_PAGES:
            info["full"] = False
            return None
        data = post({"type": "userFillsByTime", "user": addr, "startTime": int(lo), "endTime": int(hi),
                     "aggregateByTime": True}, weight=20, per=20)
        if data is None:
            info["full"] = False
            return None
        info["pages"] += 1
        new, times = 0, []
        for f in data if isinstance(data, list) else []:
            try:
                t = int(f["time"])
            except (KeyError, TypeError, ValueError):
                continue
            times.append(t)
            key = (t, f.get("coin"), f.get("side"), f.get("px"), f.get("sz"), f.get("startPosition"))
            if key in seen:
                continue
            seen.add(key)
            new += 1
            r = row(f)
            if r:
                out.append(r)
        return (new, min(times), max(times)) if times else (0, None, None)

    lo, tmin = start, None
    while lo <= end:                           # ileri
        res = page(lo, end)
        if not res or not res[0]:
            break
        tmin = res[1] if tmin is None else min(tmin, res[1])
        lo = res[2]                            # aynı milisaniyedeki kayıtlar kaçmasın diye dahil; yinelenenler elenir
    while tmin is not None and tmin > start:        # geri (sınırdaki milisaniye dahil; yinelenenler elenir)
        res = page(start, tmin)
        if not res or not res[0]:
            break
        tmin = min(tmin, res[1])
    out.sort(key=lambda x: x[0])
    return out, info


def fetch_candles(coin: str, interval: str, start: int, end: int):
    data = post({"type": "candleSnapshot", "req": {"coin": coin, "interval": interval,
                                                   "startTime": int(start), "endTime": int(end)}}, weight=20, per=60)
    out = []
    for c in data if isinstance(data, list) else []:
        try:
            out.append([int(c["t"]) // 1000, float(c["o"]), float(c["c"])])
        except (KeyError, TypeError, ValueError):
            continue
    out.sort(key=lambda x: x[0])
    return out


def series(points):
    out = []
    for p in points or []:
        try:
            out.append([int(p[0]), round(float(p[1]), 2)])
        except (TypeError, ValueError, IndexError):
            continue
    return out


def save(out: dict) -> None:
    tmp = OUT + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, OUT)


def main() -> int:
    pool = json.load(open("bt_pool.json"))
    addrs = [a.lower() for a in pool["addrs"]]
    # Bugünkü kadro ve yedekler de eklenir
    try:
        st = json.load(open("hl_state.json"))
        for a, r in (st.get("roles") or {}).items():
            if a.lower() not in addrs:
                addrs.append(a.lower())
    except Exception as ex:
        print("hl_state.json okunamadı:", ex)
    now = int(time.time() * 1000)
    start = int(pool["t"]) - 92 * DAY
    cut = now - RECENT_DAYS * DAY
    print(f"hesap {len(addrs)}, dönem {(now - start) / DAY:.0f} gün")
    out = {"t": now, "start": start, "recent_start": cut, "pool_t": pool["t"], "accounts": {}, "mids": {},
           "d1": {}, "m5": {}, "stats": STATS}

    try:
        for i, a in enumerate(addrs):
            if left() < 25 * 60:               # fiyat verisine süre bırak
                print("süre: işlem kayıtları", i, "hesapta durdu")
                break
            acc = {"fills": [], "info": {}}
            recent, i1 = fetch_fills(a, cut, now)             # önce son 17 gün (gecikme ölçümü için şart)
            older, i2 = fetch_fills(a, start, cut - 1)
            acc["fills"] = older + recent
            acc["info"] = {"recent": i1, "older": i2}
            pf = post({"type": "portfolio", "user": a})
            if isinstance(pf, list):
                d = {}
                for item in pf:
                    try:
                        d[item[0]] = item[1]
                    except (TypeError, IndexError):
                        continue
                acc["av"] = series((d.get("allTime") or {}).get("accountValueHistory"))
                acc["av_m"] = series((d.get("month") or {}).get("accountValueHistory"))
                acc["pnl"] = series((d.get("perpAllTime") or {}).get("pnlHistory"))
            pos, eq = {}, 0.0
            for dex in ("", "xyz"):
                cs = post({"type": "clearinghouseState", "user": a, "dex": dex}, weight=2)
                if not isinstance(cs, dict):
                    continue
                try:
                    eq += float((cs.get("marginSummary") or {}).get("accountValue") or 0)
                    for ap in cs.get("assetPositions") or []:
                        p = ap["position"]
                        if float(p["szi"]):
                            pos[p["coin"]] = [float(p["szi"]), float(p.get("entryPx") or 0)]
                except (KeyError, TypeError, ValueError):
                    pass
            acc["pos"], acc["eq"] = pos, round(eq, 2)
            out["accounts"][a] = acc
            if (i + 1) % 10 == 0:
                print(f"{i + 1}/{len(addrs)} hesap · {sum(len(x['fills']) for x in out['accounts'].values()):,} işlem · "
                      f"{(time.time() - t_start) / 60:.0f} dk · ağırlık {STATS['weight']:,}")
            if (i + 1) % 40 == 0:
                save(out)

        for dex in ("", "xyz"):
            m = post({"type": "allMids", "dex": dex}, weight=2)
            for k, v in (m or {}).items() if isinstance(m, dict) else []:
                try:
                    out["mids"][k] = float(v)
                except (TypeError, ValueError):
                    pass
        out["t_mids"] = int(time.time() * 1000)
        save(out)

        # Fiyatlar: bütün varlıklar için günlük; son 17 günde en çok işlem görenler için 5 dakikalık
        ntl_all, ntl_recent = collections.Counter(), collections.Counter()
        for acc in out["accounts"].values():
            for t, coin, px, sz, _, _ in acc["fills"]:
                ntl_all[coin] += abs(sz) * px
                if t >= cut:
                    ntl_recent[coin] += abs(sz) * px
            for coin in acc.get("pos") or {}:
                ntl_all[coin] += 0
        end = int(time.time() * 1000)
        print(f"varlık: {len(ntl_all)} (son {RECENT_DAYS} günde {len(ntl_recent)})")
        for j, (coin, _) in enumerate(ntl_all.most_common()):
            if left() < 12 * 60:
                print("süre: günlük fiyatlar", j, "varlıkta durdu")
                break
            c = fetch_candles(coin, "1d", start - 3 * DAY, end)
            if c:
                out["d1"][coin] = [[x[0], x[2]] for x in c]
        save(out)
        for j, (coin, _) in enumerate(ntl_recent.most_common(MAX_5M_COINS)):
            if left() < 90:
                print("süre: 5 dk fiyatlar", j, "varlıkta durdu")
                break
            c = fetch_candles(coin, "5m", cut - 600_000, end)
            if c:
                out["m5"][coin] = c
            if (j + 1) % 25 == 0:
                print(f"5 dk fiyat {j + 1} varlık · {(time.time() - t_start) / 60:.0f} dk")
    finally:
        out["minutes"] = round((time.time() - t_start) / 60, 1)
        save(out)
    n = sum(len(x["fills"]) for x in out["accounts"].values())
    part = sum(1 for x in out["accounts"].values() if not (x["info"]["recent"]["full"] and x["info"]["older"]["full"]))
    print(f"bitti: {len(out['accounts'])} hesap, {n:,} işlem, {part} hesapta kayıt eksik (çok sık işlem yapanlar), "
          f"günlük fiyat {len(out['d1'])}, 5 dk fiyat {len(out['m5'])}, {out['minutes']} dk, "
          f"istek {STATS['calls']}, hata {STATS['errors']}, dosya {os.path.getsize(OUT) / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
