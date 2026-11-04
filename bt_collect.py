"""
Geriye dönük test için veri toplayıcı (botun çalışmasına dokunmaz).

Sıralama listesinden toplam hacmi 10 milyon $ üstü hesapları seçer (bugün küçülmüş ya da
kapanmış hesaplar dahil), her birinin tüm zamanlar geçmişini (perpAllTime kâr serisi +
allTime hesap değeri serisi) indirir ve bir .json.gz dosyasına yazar.
Hız sınırına takılmamak için dakikada en fazla ~55 istek yapar.

Kullanım: python bt_collect.py [çıktı] [süre_dk] [atlanacak_dosya ...]
  Atlanacak dosyalardaki hesaplar tekrar indirilmez (önceki toplamaların devamı için).
"""

import gzip
import json
import os
import random
import sys
import time

import requests

INFO = "https://api.hyperliquid.xyz/info"
LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
MIN_VLM = 10_000_000
OUT = sys.argv[1] if len(sys.argv) > 1 else "bt_data.json.gz"
DEADLINE_S = (float(sys.argv[2]) if len(sys.argv) > 2 else 100) * 60
SKIP_FILES = sys.argv[3:]
GAP_S = 1.1            # portfolio isteği 20 ağırlık; dakikada ~1090 ağırlık, 1200 sınırının altında

s = requests.Session()
t_start = time.time()


def post(body):
    for attempt in range(6):
        try:
            r = s.post(INFO, json=body, timeout=30)
            if r.status_code == 429:
                time.sleep(20 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.json()
        except Exception as ex:
            print("hata:", ex)
            time.sleep(5 * (attempt + 1))
    return None


def save(out):
    tmp = OUT + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, OUT)


skip = set()
for fn in SKIP_FILES:
    try:
        skip |= set(json.load(gzip.open(fn, "rt"))["accounts"])
    except Exception as ex:
        print("atlanacak dosya okunamadı:", fn, ex)

rows = s.get(LB, timeout=120).json()["leaderboardRows"]
picked = []
for row in rows:
    wp = {k: v for k, v in row.get("windowPerformances") or []}
    try:
        vlm = float((wp.get("allTime") or {}).get("vlm") or 0)
    except (TypeError, ValueError):
        continue
    if vlm >= MIN_VLM:
        picked.append((row["ethAddress"].lower(), round(vlm), round(float(row.get("accountValue") or 0))))
n_eligible = len(picked)
picked = [p for p in picked if p[0] not in skip]
print(f"sıralama: {len(rows)} hesap, hacmi 10M+ olan: {n_eligible}, daha önce indirilen: {len(skip)}, kalan: {len(picked)}")
random.seed(42)
random.shuffle(picked)     # süre biterse indirilenler yine rastgele bir örneklem olur

out = {"t": int(time.time() * 1000), "n_lb": len(rows), "n_eligible": n_eligible, "n_skipped": len(skip), "accounts": {}}
for i, (a, vlm, eq) in enumerate(picked):
    if time.time() - t_start > DEADLINE_S:
        print("süre doldu")
        break
    t0 = time.time()
    p = post({"type": "portfolio", "user": a})
    if p:
        d = {k: v for k, v in p}
        pnl = [[int(t), round(float(v), 2)] for t, v in (d.get("perpAllTime") or {}).get("pnlHistory") or []]
        av = [[int(t), round(float(v), 2)] for t, v in (d.get("allTime") or {}).get("accountValueHistory") or []]
        out["accounts"][a] = {"vlm": vlm, "eq": eq, "pnl": pnl, "av": av}
    if i % 200 == 0:
        print(f"{i}/{len(picked)}  ({(time.time() - t_start) / 60:.0f} dk)")
        save(out)          # ara kayıt
    time.sleep(max(0.0, GAP_S - (time.time() - t0)))

save(out)
print(f"bitti: {len(out['accounts'])} hesap, {(time.time() - t_start) / 60:.0f} dk")
