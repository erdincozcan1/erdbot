"""
Aylık sistem testi (botun çalışmasına dokunmaz).

bt_collect.py ile toplanan güncel veride, botun bugünkü seçim kurallarını geçmişe uygular:
geçmişte 7 farklı tarihte (12 ay önce … 6 ay önce) yalnızca o güne kadarki veriyle aday seçer,
sonraki 183 günü ölçer. Sonuçları Telegram'a gönderir ve bt_rapor.txt dosyasına yazar.

Ölçülenler:
  1) Kaç trader en iyisi? (botun kurallarıyla seçilen en iyi N, eşit pay)
  2) Sharpe eşiği hâlâ ayrıştırıyor mu? (Sharpe dilimlerine göre sonraki 6 ay)
  3) Sharpe sıralaması rastgele seçimden iyi mi?
Kural değişikliği otomatik yapılmaz; rapor öneri verir, karar kullanıcınındır.

Kullanım: python bt_monthly.py bt_fresh.json.gz
"""

from __future__ import annotations

import gzip
import json
import os
import sys

import numpy as np

import hl_rotation as R
import hl_watcher as w

DAY = R.DAY_MS
FWD = 183
STEP = 7
T0S = (365, 335, 305, 274, 244, 213, 183)
NS = (5, 8, 10, 12, 15, 20)


def cut(points, t):
    return [p for p in points if p[0] <= t]


def obs_at(acc: dict, t0: int) -> dict | None:
    """t0 anındaki ölçümler (yalnızca o güne kadarki veri) + sonraki 183 günün yolu."""
    pnl_all = R.Series(acc["pnl"])
    if not len(pnl_all) or pnl_all.t[0] > t0 - 365 * DAY:
        return None
    av = R.Series(cut(acc["av"], t0))
    a0 = av.at(t0)
    if a0 is None or a0 < 100_000:
        return None
    pnl = R.Series(cut(acc["pnl"], t0))
    if pnl.t[-1] < t0 - 20 * DAY or abs(pnl.v[-1] - pnl.at_or_first(t0 - 60 * DAY)) < 300:
        return None          # o tarihte işlem yapmayan hesap (bot da seçmezdi)
    m = R.analyze([["perpAllTime", {"pnlHistory": cut(acc["pnl"], t0)}],
                   ["allTime", {"accountValueHistory": cut(acc["av"], t0)}]], [], t0)
    if m.get("worst_month") is None or m.get("sharpe") is None:
        return None
    p0 = pnl.v[-1]
    path = []
    for k in range(0, FWD + 1, STEP):
        v = max(-1.0, (pnl_all.at(t0 + k * DAY) - p0) / a0)
        path.append(-1.0 if path and path[-1] <= -1.0 else v)
    m["path"] = np.array(path)
    m["fwd"] = path[-1]
    return m


def rules_ok(m: dict, disc: dict) -> bool:
    """Geçmişten ölçülebilen aday kuralları (kaldıraç ve pozisyon kuralları geçmişte ölçülemez)."""
    if m["history_days"] < disc["min_history_days"]:
        return False
    if R.risk_group(m, disc) == "dışında":
        return False
    bs = m.get("best_month_share")
    if bs is None or bs > disc["max_best_month_share"]:
        return False
    return not R.recent_profit_fails(m, disc)


def port(paths: np.ndarray) -> dict:
    p = paths.mean(axis=0)
    eq = 1 + p
    peak = np.maximum.accumulate(eq)
    return {"ret": float(p[-1]), "mdd": float(((peak - eq) / peak).max())}


def pick(pool: list, n: int, disc: dict) -> list:
    """Botun seçimi: Sharpe sırası, çekirdek dışından en fazla max_wide."""
    out, wide = [], 0
    for m in sorted(pool, key=lambda x: -x["sharpe"]):
        if len(out) >= n:
            break
        if R.risk_group(m, disc) != "çekirdek":
            if wide >= disc["max_wide"]:
                continue
            wide += 1
        out.append(m)
    return out


def main(path: str) -> str:
    cfg = w.load_json(w.CONFIG_PATH, {}) or {}
    rot = R.merged_config(cfg)
    disc = rot["discovery"]
    slots = int(rot.get("slots") or 20)
    data = json.load(gzip.open(path, "rt"))
    now = data["t"]
    frac = len(data["accounts"]) / max(1, data.get("n_eligible") or len(data["accounts"]))
    pools = {d: [] for d in T0S}
    for acc in data["accounts"].values():
        for d in T0S:
            m = obs_at(acc, now - d * DAY)
            if m and rules_ok(m, disc):
                pools[d].append(m)

    L = [f"🧪 <b>Aylık sistem testi</b> ({len(data['accounts']):,} hesap, sıralama listesinin %{frac * 100:.0f}'i)",
         f"Botun bugünkü kuralları geçmişte 7 tarihte uygulandı, sonraki 6 ay ölçüldü.",
         "Uygun aday sayısı (dönem başına): " + ", ".join(str(len(p)) for p in pools.values())
         + f" · Sharpe ≥ {disc['min_sharpe']:g}: "
         + ", ".join(str(sum(1 for m in p if m['sharpe'] >= disc['min_sharpe'])) for p in pools.values())]

    # 1) Kaç trader?
    gated = {d: [m for m in p if m["sharpe"] >= disc["min_sharpe"]] for d, p in pools.items()}
    L += ["", "<b>1) Kaç trader?</b> (örneklemdeki N, tüm piyasada yaklaşık N ÷ örneklem oranı)"]
    best = None
    for n in NS:
        rows = [port(np.array([m["path"] for m in sel])) for sel in (pick(p, n, disc) for p in gated.values()) if len(sel) == n]
        if len(rows) < 4:
            L.append(f"N={n:2}: yeterli aday yok ({len(rows)}/7 dönem)")
            continue
        r = np.array([x["ret"] for x in rows]); dd = np.array([x["mdd"] for x in rows])
        L.append(f"N={n:2} (~{n / frac:.0f} gerçek): ort {w.pct(r.mean())} · en kötü dönem {w.pct(r.min())} · "
                 f"ort düşüş {w.pct(-dd.mean())} · {len(rows)}/7 dönem")
        score = r.mean() - dd.mean()          # getiri − düşüş: ikisini birlikte gözet
        if best is None or score > best[0]:
            best = (score, n)

    # 2) Sharpe dilimleri
    allm = [m for p in pools.values() for m in p]
    L += ["", "<b>2) Sharpe dilimlerine göre sonraki 6 ay</b>"]
    edges = [(-99, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 99)]
    med = {}
    for lo, hi in edges:
        xs = np.array([m["fwd"] for m in allm if lo <= m["sharpe"] < hi])
        if len(xs) < 5:
            continue
        med[(lo, hi)] = float(np.median(xs))
        lab = f"&lt; {hi:g}" if lo == -99 else (f"≥ {lo:g}" if hi == 99 else f"{lo:g}–{hi:g}")
        L.append(f"Sharpe {lab}: n={len(xs)} · medyan {w.pct(np.median(xs))} · zararda %{np.mean(xs < 0) * 100:.0f} · "
                 f"%20+ kayıp %{np.mean(xs < -0.2) * 100:.0f}")

    # 3) Botun seçimi (Sharpe eşiği + sıralama), kurallardan geçen havuzdan rastgele seçime göre iyi mi?
    rng = np.random.default_rng(1)
    diffs = []
    for d, p in pools.items():
        sel = pick(gated[d], 10, disc)
        n = len(sel)
        if n < 5 or len(p) < n:
            continue
        top = port(np.array([m["path"] for m in sel]))["ret"]
        rnd = np.mean([port(np.array([p[i]["path"] for i in rng.choice(len(p), n, replace=False)]))["ret"]
                       for _ in range(200)])
        diffs.append(top - rnd)
    if diffs:
        L += ["", f"<b>3) Botun seçimi</b> (Sharpe eşiği + sıralama), kurallardan geçen havuzdan rastgele seçilen "
                  f"aynı sayıda trader'a göre ortalama {w.pct(float(np.mean(diffs)))} "
                  f"({sum(1 for x in diffs if x > 0)}/{len(diffs)} dönem daha iyi)"]

    # Öneriler
    L += ["", "<b>Öneri</b>"]
    if best:
        real = best[1] / frac
        if real < slots * 0.7:
            L.append(f"• En iyi sonuç ~{real:.0f} trader'la alındı; kadro {slots}. Kadroyu küçültmeyi düşün "
                     f"(hl_traders.json → rotation.slots).")
        elif real > slots * 1.3:
            L.append(f"• En iyi sonuç ~{real:.0f} trader'la alındı; kadro {slots}. Kadroyu büyütmeyi düşün.")
        else:
            L.append(f"• Kadro büyüklüğü ({slots}) test sonucuyla uyumlu (~{real:.0f}).")
    hi_med = [v for (lo, hi), v in med.items() if lo >= disc["min_sharpe"]]
    lo_med = [v for (lo, hi), v in med.items() if hi <= disc["min_sharpe"]]
    if hi_med and lo_med:
        if min(hi_med) > max(lo_med):
            L.append(f"• Sharpe ≥ {disc['min_sharpe']:g} eşiği hâlâ ayrıştırıyor; değişiklik gerekmiyor.")
        else:
            L.append(f"• Sharpe eşiği ({disc['min_sharpe']:g}) bu ay net ayrıştırmadı; bir ay daha izlenmeli.")
    if diffs and np.mean(diffs) <= 0:
        L.append("• Botun seçimi bu ay rastgele seçimi geçemedi; seçim yöntemi gözden geçirilmeli.")
    L.append("<i>Kurallar otomatik değişmez. Geçmiş sonuç geleceği garanti etmez.</i>")
    L.append(w.DISCLAIMER)
    return "\n".join(L)


if __name__ == "__main__":
    text = main(sys.argv[1] if len(sys.argv) > 1 else "bt_fresh.json.gz")
    import html
    import re
    plain = html.unescape(re.sub(r"<[^>]+>", "", text))
    print(plain)
    with open("bt_rapor.txt", "w", encoding="utf-8") as f:
        f.write(plain + "\n")
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if tok and chat:
        w.Telegram(tok, chat).send(text)
