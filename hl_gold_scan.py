"""
Altın tarayıcı (tek seferlik araç; botun çalışmasına dokunmaz).

Sıralama listesindeki hesap değeri ALTIN_MIN_HESAP (varsayılan 100.000 $) üstündeki bütün hesapların açık
pozisyonlarına bakar ve altın pozisyonu olanları listeler (xyz:GOLD ve ana borsadaki PAXG).
Altına en çok ağırlık veren hesapları botun bütün aday kurallarından geçirir.
Sonucu Telegram'a gönderir ve inceleme/altin_tarama.txt / .json olarak yazar.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import hl_rotation as R
import hl_watcher as w

OUT = Path("inceleme")
MIN_EQ = float(os.environ.get("ALTIN_MIN_HESAP") or 100_000)
DEADLINE_S = 85 * 60
DEEP = 25                       # kurallardan geçirilecek en fazla hesap


def is_gold(coin: str) -> bool:
    c = coin.upper()
    return "GOLD" in c or "PAXG" in c or "XAU" in c


def positions(addr: str) -> dict:
    """Ana borsa ve xyz (hisse/emtia) açık pozisyonları."""
    out = {}
    for dex in ("", "xyz"):
        st = w.post({"type": "clearinghouseState", "user": addr, "dex": dex}) or {}
        for ap in st.get("assetPositions", []):
            p = ap["position"]
            szi = float(p["szi"])
            if szi:
                out[p["coin"]] = {"szi": szi, "value": abs(float(p.get("positionValue") or 0)),
                                  "lev": float((p.get("leverage") or {}).get("value") or 1)}
    return out


def main() -> int:
    t0 = time.time()
    cfg = w.load_json(w.CONFIG_PATH, {}) or {}
    disc = R.merged_config(cfg)["discovery"]
    rows = w.fetch_leaderboard()
    accts = []
    for r in rows:
        try:
            eq = float(r.get("accountValue") or 0)
        except (TypeError, ValueError):
            continue
        if eq >= MIN_EQ:
            wp = {k: v for k, v in r.get("windowPerformances") or []}
            accts.append((r["ethAddress"].lower(), eq, wp))
    print(f"sıralama {len(rows)} hesap, {MIN_EQ:,.0f} $ üstü {len(accts)}")

    found, scanned = [], [0]

    def one(item):
        a, eq, wp = item
        if time.time() - t0 > DEADLINE_S:
            return None
        try:
            pos = positions(a)
        except Exception as ex:
            print("okunamadı", a[:10], ex)
            return None
        scanned[0] += 1
        if scanned[0] % 1000 == 0:
            print(f"{scanned[0]}/{len(accts)}  ({(time.time() - t0) / 60:.0f} dk)")
        gold = {c: p for c, p in pos.items() if is_gold(c)}
        if not gold:
            return None
        gross = sum(p["value"] for p in pos.values())
        gv = sum(p["value"] for p in gold.values())
        net = sum(p["value"] * (1 if p["szi"] > 0 else -1) for p in gold.values())
        return {"a": a, "eq": eq, "gold_value": gv, "gold_net": net, "gold_share": gv / gross if gross else 0,
                "gold_to_eq": gv / eq if eq else 0, "gross_lev": gross / eq if eq else 0, "n_pos": len(pos),
                "coins": {c: [round(p["szi"], 4), round(p["value"]), p["lev"]] for c, p in gold.items()},
                "pnl_all": float((wp.get("allTime") or {}).get("pnl") or 0),
                "roi_month": float((wp.get("month") or {}).get("roi") or 0)}

    with ThreadPoolExecutor(max_workers=6) as ex:
        for res in ex.map(one, accts):
            if res:
                found.append(res)
    found.sort(key=lambda x: -x["gold_value"])
    print(f"taranan {scanned[0]}, altın pozisyonu olan {len(found)}")

    # Altına ağırlık veren (pozisyonlarının en az %25'i altın) en büyük hesapları kurallardan geçir
    focus = [f for f in found if f["gold_share"] >= 0.25][:DEEP]
    now_ms = int(time.time() * 1000)
    for f in focus:
        try:
            snap = w.fetch_account(f["a"], cfg.get("dexes") or ["", "xyz"])
            m = R.analyze(w.fetch_portfolio(f["a"]), w.fetch_fills(f["a"]), now_ms)
            ok, score, desc = R.candidate_check(m, snap, disc)
            f.update({"pass": ok, "desc": desc, "group": R.risk_group(m, disc), "sharpe": m.get("sharpe"),
                      "ret_365": m.get("ret_365"), "worst_month": m.get("worst_month"),
                      "history_days": m.get("history_days"), "hold_h": m.get("median_hold_h")})
        except Exception as ex:
            f.update({"pass": None, "desc": f"incelenemedi: {str(ex)[:80]}"})

    p = lambda x: "-" if x is None else w.pct(x)
    L = [f"🥇 <b>Altın taraması</b>: {scanned[0]:,} hesap tarandı (hesap ≥ {w.usd(MIN_EQ)}); "
         f"<b>{len(found)}</b> hesapta altın pozisyonu var.",
         f"Bunların {sum(1 for f in found if f['gold_share'] >= 0.25)} tanesinde altın, pozisyonlarının en az %25'i.",
         "", "<b>En büyük altın pozisyonları</b>"]
    for f in found[:12]:
        L.append(f"• {w.link(f['a'], f['a'][:6] + '…' + f['a'][-4:])} {'LONG' if f['gold_net'] >= 0 else 'SHORT'} "
                 f"{w.usd(f['gold_value'])} · hesap {w.usd(f['eq'])} · pozisyonlarının %{f['gold_share'] * 100:.0f}'i altın")
    L += ["", f"<b>Altına ağırlık veren {len(focus)} hesap, botun kurallarıyla</b>"]
    passed = [f for f in focus if f.get("pass")]
    for f in sorted(focus, key=lambda x: (not x.get("pass"), -(x.get("sharpe") or -9)))[:15]:
        sh = f.get("sharpe")
        L.append(f"{'✅' if f.get('pass') else '❌'} {w.link(f['a'], f['a'][:6] + '…' + f['a'][-4:])} "
                 f"altın %{f['gold_share'] * 100:.0f} · Sharpe {'-' if sh is None else f'{sh:.2f}'} · 12 ay {p(f.get('ret_365'))} · "
                 f"en kötü ay {p(f.get('worst_month'))}" + ("" if f.get("pass") else f" · <i>{w.e((f.get('desc') or '')[:90])}</i>"))
    L += ["", f"Kurallardan geçen altın odaklı hesap: <b>{len(passed)}</b>. "
              "Ayrıntı için \"Adres incele\" kullanılabilir.", w.DISCLAIMER]
    text = "\n".join(L)
    OUT.mkdir(exist_ok=True)
    (OUT / "altin_tarama.txt").write_text(re.sub(r"<[^>]+>", "", text), encoding="utf-8")
    (OUT / "altin_tarama.json").write_text(json.dumps({"t": now_ms, "min_eq": MIN_EQ, "scanned": scanned[0],
                                                       "found": found}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(re.sub(r"<[^>]+>", "", text))
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if tok and chat:
        w.Telegram(tok, chat).send(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
