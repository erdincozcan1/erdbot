"""
Aday veritabanı: Hyperliquid'deki büyük hesapları haftada bir tarar ve hazır bir aday
sıralaması tutar (hl_watcher.py tarafından kullanılır).

Döngü (her hafta yeniden başlar):
  1. Sıralama listesinden hesap değeri 100 bin $ üstü bütün hesaplar kuyruğa alınır (~15.000).
  2. Tarama: her hesabın aylık geçmişi (portfolio) okunur; kârlı ay oranı, en kötü ay,
     en iyi ayın payı, 12 aylık getiri ve düşüşler kaydedilir. Hyperliquid'in hız sınırına
     takılmamak için her çalışmada birkaç dakika çalışır ve kaldığı yerden devam eder.
  3. Derin inceleme: aylık geçmişe göre en iyi 200 hesabın işlem kayıtları ve açık pozisyonları
     incelenir (pozisyon süresi, işlem sıklığı, kaldıraç).
  4. Kriterleri geçenler puana göre sıralanır. Kadroda yer açıldığında bot önce bu listeye bakar.

Veritabanı hl_db.json dosyasında tutulur (GitHub Actions önbelleğinde; depoya yazılmaz).
Özet ve en iyi adaylar hl_state.json içine yazılır.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import hl_rotation as R

FIELDS = ("t", "history_days", "profitable_share", "worst_month", "best_month_share",
          "ret_365", "ret_90", "dd_now", "dd_hist", "months", "lb_eq")

DEFAULTS = {
    "enabled": True,
    "min_equity": 100_000,      # taranacak hesaplar
    "refresh_days": 7,          # tam tarama sıklığı
    "deep_top": 200,            # derin incelemeye alınacak en iyi hesap sayısı
    "run_seconds": 170,         # her çalışmada taramaya ayrılan en fazla süre
    "keep_top": 30,             # hl_state.json'a yazılacak aday sayısı
}


def merged(cfg_rot: dict) -> dict:
    return {**DEFAULTS, **(cfg_rot.get("scanner") or {})}


def load(path: Path) -> dict:
    try:
        db = json.loads(path.read_text(encoding="utf-8"))
        if db.get("version") == 1:
            return db
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {"version": 1, "cycle": None, "accounts": {}, "deep": {}, "ranking": []}


def save(path: Path, db: dict) -> None:
    path.write_text(json.dumps(db, separators=(",", ":")), encoding="utf-8")


def pack(m: dict, lb_eq: float) -> list:
    m = {**m, "lb_eq": round(lb_eq)}
    return [m.get(k) for k in FIELDS]


def unpack(row: list) -> dict:
    return dict(zip(FIELDS, row))


def portfolio_check(m: dict, disc: dict) -> tuple[bool, float]:
    """Yalnızca aylık geçmişe dayanan ön kontrol (işlem kaydı gerektirmez)."""
    ps, wm, bs, r365 = m.get("profitable_share"), m.get("worst_month"), m.get("best_month_share"), m.get("ret_365")
    if (m.get("history_days") or 0) < disc["min_history_days"]:
        return False, 0.0
    if ps is None or ps < disc["min_profitable_share"]:
        return False, 0.0
    if wm is None or wm < disc["worst_month"]:
        return False, 0.0
    if bs is None or bs > disc["max_best_month_share"]:
        return False, 0.0
    if r365 is None or r365 <= 0:
        return False, 0.0
    return True, r365 / max(0.05, abs(wm))


def start_cycle(db: dict, rows: list, sc: dict, now_ms: int) -> None:
    picked = []
    for row in rows or []:
        a = str(row.get("ethAddress", "")).lower()
        try:
            eq = float(row.get("accountValue") or 0)
            wp = {k: v for k, v in row.get("windowPerformances") or []}
            pnl = float((wp.get("allTime") or {}).get("pnl") or 0)
        except (TypeError, ValueError):
            continue
        if a and eq >= sc["min_equity"]:
            picked.append((pnl, a, eq))
    picked.sort(reverse=True)               # kârlı hesaplar önce
    db["cycle"] = {"started_ms": now_ms, "phase": "scan", "queue": [[a, round(eq)] for _, a, eq in picked],
                   "total": len(picked), "scanned": 0, "errors": 0, "deep_queue": [], "deep_total": 0,
                   "deep_done": 0, "finished_ms": None}


def build_ranking(db: dict) -> None:
    ranked = sorted(((d["score"], a) for a, d in db["deep"].items() if d.get("ok")), reverse=True)
    db["ranking"] = [a for _, a in ranked]


def step(db: dict, rot: dict, api, now_ms: int, deadline: float, clock=None) -> list[str]:
    """Bir çalışmalık tarama. api: leaderboard(), portfolio(a), fills(a), account(a)."""
    clock = clock or (lambda: time.time())
    sc = merged(rot)
    if not sc["enabled"]:
        return []
    disc = rot["discovery"]
    notes = []
    cyc = db.get("cycle")
    if not cyc or (cyc["phase"] == "done" and now_ms - cyc["started_ms"] >= sc["refresh_days"] * R.DAY_MS):
        try:
            start_cycle(db, api.leaderboard(), sc, now_ms)
        except Exception as ex:
            print(f"[uyarı] aday taraması başlatılamadı: {ex}")
            return []
        cyc = db["cycle"]

    fails_in_row = 0
    if cyc["phase"] == "scan":
        while cyc["queue"] and clock() < deadline:
            a, lb_eq = cyc["queue"][0]
            try:
                m = R.analyze(api.portfolio(a), [], now_ms)
                db["accounts"][a] = pack(m, lb_eq)
                fails_in_row = 0
            except Exception as ex:
                cyc["errors"] += 1
                fails_in_row += 1
                if fails_in_row >= 3:
                    print(f"[uyarı] tarama durdu (art arda hata): {ex}")
                    return notes
            cyc["queue"].pop(0)
            cyc["scanned"] += 1
        if not cyc["queue"]:
            scored = []
            for a, row in db["accounts"].items():
                m = unpack(row)
                if m["t"] is None or m["t"] < cyc["started_ms"]:
                    continue
                ok, score = portfolio_check(m, disc)
                if ok:
                    scored.append((score, a))
            scored.sort(reverse=True)
            cyc["deep_queue"] = [a for _, a in scored[: sc["deep_top"]]]
            cyc["deep_total"] = len(cyc["deep_queue"])
            cyc["phase"] = "deep"

    if cyc["phase"] == "deep":
        while cyc["deep_queue"] and clock() < deadline:
            a = cyc["deep_queue"][0]
            try:
                snap = api.account(a)
                hs = R.hold_stats(api.fills(a), now_ms)
                m = {**unpack(db["accounts"][a]), "median_hold_h": hs["median_hold_h"],
                     "fills_per_hour": hs["fills_per_hour"]}
                ok, score, desc = R.candidate_check(m, snap, disc)
                db["deep"][a] = {"t": now_ms, "ok": ok, "score": round(score, 4), "desc": desc,
                                 "eq": round(snap.get("equity") or 0), "lev": round(R.account_leverage(snap), 2),
                                 "mh": None if hs["median_hold_h"] is None else round(hs["median_hold_h"], 1)}
                fails_in_row = 0
            except Exception as ex:
                fails_in_row += 1
                if fails_in_row >= 3:
                    print(f"[uyarı] derin inceleme durdu (art arda hata): {ex}")
                    return notes
            cyc["deep_queue"].pop(0)
            cyc["deep_done"] += 1
        if not cyc["deep_queue"]:
            # Bu döngüde incelenmeyen eski derin sonuçları temizle
            db["deep"] = {a: d for a, d in db["deep"].items() if d["t"] >= cyc["started_ms"]}
            build_ranking(db)
            cyc["phase"] = "done"
            cyc["finished_ms"] = now_ms
            db["last_finished_ms"] = now_ms
            hours = (now_ms - cyc["started_ms"]) / R.HOUR_MS
            notes.append(f"📚 Aday veritabanı güncellendi: {cyc['scanned']:,} hesap tarandı, "
                         f"{cyc['deep_total']} tanesi ayrıntılı incelendi, {len(db['ranking'])} uygun aday "
                         f"bulundu ({hours:.0f} saat sürdü). Liste: /adaylar")
    return notes


def summary(db: dict, roles: dict, sc: dict) -> dict:
    """hl_state.json'a yazılan küçük özet (Telegram komutları ve Worker bunu okur)."""
    cyc = db.get("cycle") or {}
    top = []
    for a in db.get("ranking", [])[: sc["keep_top"]]:
        d = db["deep"].get(a, {})
        top.append({"a": a, "score": d.get("score"), "desc": d.get("desc"),
                    "role": (roles.get(a) or {}).get("role")})
    return {"phase": cyc.get("phase"), "scanned": cyc.get("scanned", 0), "total": cyc.get("total", 0),
            "deep_done": cyc.get("deep_done", 0), "deep_total": cyc.get("deep_total", 0),
            "started_ms": cyc.get("started_ms"), "finished_ms": cyc.get("finished_ms"),
            "last_finished_ms": db.get("last_finished_ms"),
            "n_ranked": len(db.get("ranking", [])), "top": top}
