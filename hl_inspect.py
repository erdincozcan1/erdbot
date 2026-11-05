"""
Tek bir adresi (veya virgülle ayrılmış birkaç adresi) botun aday ve risk kurallarıyla inceler.
Sonucu Telegram'a gönderir ve inceleme/<adres>.txt / .json olarak yazar. Botun durumuna dokunmaz.

Kullanım: ADRES=0x...,0x... python hl_inspect.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

import hl_rotation as R
import hl_watcher as w

OUT = Path("inceleme")


def ok(b: bool) -> str:
    return "✅" if b else "❌"


def p(x) -> str:
    return "-" if x is None else w.pct(x)


def cscore(m: dict) -> float:
    return R.candidate_score(m)


def inspect(addr: str, cfg: dict, state: dict) -> tuple[str, dict]:
    rot = cfg["_rot"]
    disc = rot["discovery"]
    now_ms = int(time.time() * 1000)
    snap = w.fetch_account(addr, cfg.get("dexes") or [""])
    port = w.fetch_portfolio(addr)
    fills = w.fetch_fills(addr)
    m = R.analyze(port, fills, now_ms)
    eq = snap.get("equity") or 0
    lev = R.account_leverage(snap)
    maxpos = R.max_position_ratio(snap)
    mh, fph = m.get("median_hold_h"), m.get("fills_per_hour") or 0
    ps, wm, bs = m.get("profitable_share"), m.get("worst_month"), m.get("best_month_share")
    s3, s6 = m.get("recent_3m_share"), m.get("recent_6m_share")
    hist = m.get("history_days") or 0
    # Ek bilgiler: hesabın gerçekten kopyalanabilir işlem yapıp yapmadığını anlamak için
    hs = R.hold_stats(fills, now_ms)
    extra = {"fills": len(fills or []), "episodes": hs["episodes"], "last_fill_ms": hs["last_fill_ms"],
             "spot": [], "vaults": [], "pnl_all": None, "pnl_perp": None}
    try:
        for b in (w.post({"type": "spotClearinghouseState", "user": addr}) or {}).get("balances", []):
            if b.get("coin") != "USDC" and float(b.get("total") or 0) > 0:
                extra["spot"].append([b["coin"], float(b["total"]), float(b.get("entryNtl") or 0)])
    except Exception as ex:
        print("spot okunamadı:", ex)
    try:
        for v in w.post({"type": "userVaultEquities", "user": addr}) or []:
            extra["vaults"].append([v.get("vaultAddress"), float(v.get("equity") or 0)])
    except Exception as ex:
        print("kasa bilgisi okunamadı:", ex)
    for key, name in (("allTime", "pnl_all"), ("perpAllTime", "pnl_perp")):
        ph = (R._period(port, key).get("pnlHistory") or [])
        if ph:
            extra[name] = float(ph[-1][1]) - float(ph[0][1])

    rules = [
        (eq >= disc["min_equity"], f"Hesap değeri {w.usd(eq)} (en az {w.usd(disc['min_equity'])})"),
        (hist >= disc["min_history_days"], f"Geçmiş {hist:.0f} gün (en az {disc['min_history_days']})"),
        (ps is not None and ps >= disc["min_profitable_share"],
         f"Kârlı ay oranı %{(ps or 0) * 100:.0f} (en az %{disc['min_profitable_share'] * 100:.0f}, {m.get('months') or 0} ay)"),
        (wm is not None and wm >= disc["worst_month"],
         (f"En kötü ay {p(wm)}" if wm is not None else "En kötü ay ölçülemiyor (zararlı ay var ama o ay hesap çok küçüktü)"
          if ps is not None else "En kötü ay: aylık veri yok")
         + f" (en kötü {p(disc['worst_month'])})"),
        (m.get("sharpe") is not None and m["sharpe"] >= disc["min_sharpe"],
         "Sharpe (son 12 ay) " + ("ölçülemedi" if m.get("sharpe") is None else f"{m['sharpe']:.2f}")
         + f" (en az {disc['min_sharpe']:g}; adaylar bununla sıralanır)"),
        (bs is not None and bs <= disc["max_best_month_share"],
         f"En iyi ayın toplam kârdaki payı " + ("-" if bs is None else f"%{bs * 100:.0f}")
         + f" (en fazla %{disc['max_best_month_share'] * 100:.0f})"),
    ]
    if mh is None:
        rules.append((fph <= disc["max_fills_per_hour_unknown_hold"],
                      f"Pozisyon süresi ölçülemedi; işlem sıklığı saatte {fph:.1f} (en fazla {disc['max_fills_per_hour_unknown_hold']})"))
    else:
        rules.append((mh >= disc["min_hold_h"], f"Pozisyon tutma süresi (medyan) {mh:.1f} saat (en az {disc['min_hold_h']})"))
    rules += [
        (fph <= disc["max_fills_per_hour"], f"İşlem sıklığı saatte {fph:.1f} (en fazla {disc['max_fills_per_hour']})"),
        (lev <= disc["max_leverage"], f"Toplam kaldıraç {lev:.2f}x (en fazla {disc['max_leverage']}x)"),
        (not ((m.get("last_fill_ms") is None or m["last_fill_ms"] < now_ms - disc["max_inactive_days"] * R.DAY_MS)
              and not snap.get("positions")),
         "Son işlem " + ("yok" if m.get("last_fill_ms") is None else f"{max(0.0, (now_ms - m['last_fill_ms']) / R.DAY_MS):.0f} gün önce")
         + (f", {len(snap.get('positions') or {})} açık pozisyon" if snap.get("positions") else "")
         + f" (en fazla {disc['max_inactive_days']} gün, açık pozisyon yoksa)"),
        (not (s3 is not None and s3 > disc["max_recent_3m_share"]),
         f"Son 3 ayın getirideki payı " + ("-" if s3 is None else f"%{s3 * 100:.0f}") + f" (en fazla %{disc['max_recent_3m_share'] * 100:.0f})"),
    ]
    if hist >= disc["recent_6m_min_history_days"]:
        rules.append((not (s6 is not None and s6 > disc["max_recent_6m_share"]),
                      f"Son 6 ayın getirideki payı " + ("-" if s6 is None else f"%{s6 * 100:.0f}")
                      + f" (en fazla %{disc['max_recent_6m_share'] * 100:.0f})"))
    rules.append((maxpos <= disc["max_position_to_equity"],
                  f"En büyük pozisyon hesabın {maxpos:.2f} katı (en fazla {disc['max_position_to_equity']:g})"))
    cross, iso_share, _ = R.liquidation_risk(snap, disc["min_liq_distance"])
    rules.append((not cross, "Çapraz teminatlı pozisyon likidasyona %20'den yakın değil" if not cross
                  else f"{cross[0]} likidasyona %{cross[1] * 100:.0f} uzakta (çapraz teminat)"))
    rules.append((iso_share <= disc["max_near_liq_margin"],
                  f"Likidasyona yakın izole pozisyon teminatı hesabın %{iso_share * 100:.0f} kadarı (en fazla %{disc['max_near_liq_margin'] * 100:.0f})"))

    passed, _score, _desc = R.candidate_check(m, snap, disc)
    score = cscore(m)
    risks = R.risk_reasons(m, snap, None, now_ms, rot)
    role = (state.get("roles") or {}).get(addr, {}).get("role")
    ranking = [c.get("a") for c in ((state.get("candidates") or {}).get("top") or [])]
    # Kadrodaki trader'ların puanları (karşılaştırma için)
    roster_scores = sorted((cscore(mm) for a, mm in (state.get("metrics") or {}).items()
                            if (state.get("roles") or {}).get(a, {}).get("role") == "active"
                            and mm.get("sharpe") is not None),
                           reverse=True)
    my_score = m.get("sharpe")
    lf = extra["last_fill_ms"]
    lf_days = max(0.0, (now_ms - lf) / R.DAY_MS) if lf else None

    pos = sorted(snap.get("positions", {}).items(), key=lambda kv: -kv[1]["value"])
    lines = [f"🔎 <b>Adres incelemesi</b> {w.link(addr, addr[:6] + '…' + addr[-4:])}",
             f"Hesap {w.usd(eq)} · kaldıraç {lev:.2f}x · {len(pos)} açık pozisyon · tarz: {R.style_name(mh)}"
             + (f" ({mh:.0f} saat)" if mh is not None else ""),
             f"Getiri: 90 gün {p(m.get('ret_90'))} · 12 ay {p(m.get('ret_365'))}",
             f"Düşüş: şu an {p(-(m.get('dd_now') or 0))} · geçmişte en büyük {p(-(m.get('dd_hist') or 0))}"
             f" · son 30 gün {p(-(m.get('dd_30') or 0))}",
             f"İşlem kaydı: {extra['fills']} işlem, {extra['episodes']} kapanmış pozisyon, son işlem "
             + ("yok" if lf_days is None else f"{lf_days:.0f} gün önce"),
             f"Toplam kâr (tüm zamanlar): perp {w.usd(extra['pnl_perp'] or 0, True)} · tüm hesap {w.usd(extra['pnl_all'] or 0, True)}"]
    if extra["spot"]:
        lines.append("Spot varlıklar: " + ", ".join(f"{w.e(c)} (maliyet {w.usd(n)})" for c, _, n in extra["spot"][:6]))
    if extra["vaults"]:
        lines.append("Kasalardaki para: " + ", ".join(f"{a[:8]} {w.usd(v)}" for a, v in extra["vaults"][:4]))
    lines += ["", "<b>Aday kuralları</b>"]
    lines += [f"{ok(b)} {w.e(t)}" for b, t in rules]
    lines += ["", "<b>Kadrodaki biri olsaydı (günlük risk kontrolü)</b>",
              ("✅ Risk uyarısı yok" if not risks else "\n".join("❌ " + w.e(r) for r in risks))]
    if pos:
        lines += ["", "<b>En büyük pozisyonlar</b>"]
        for c, q in pos[:6]:
            liq = f" · likidasyon {w.px(q['liq'])}" if q.get("liq") else ""
            lines.append(f"• {w.e(c)} {w.side(q['szi'])} {w.usd(q['value'])} ({q['value'] / eq if eq else 0:.2f}x hesap) · "
                         f"{q['lev']:g}x {'izole' if q.get('iso') else 'çapraz'}{liq}")
    grp = R.risk_group(m, disc)
    lines += ["", f"<b>Risk grubu:</b> {grp} (çekirdek: en kötü ay ≥ {p(disc['core_worst_month'])} ve kârlı ay ≥ "
              f"%{disc['core_min_profitable_share'] * 100:.0f}; geniş: en kötü ay ≥ {p(disc['worst_month'])} ve kârlı ay ≥ "
              f"%{disc['min_profitable_share'] * 100:.0f})", "", "<b>Sonuç</b>"]
    if passed:
        rank = sum(1 for s in roster_scores if s > score) + 1
        lines.append(f"✅ Bütün aday kurallarını geçiyor ({grp} grup). Sharpe {score:.2f}; kadrodaki {len(roster_scores)} "
                     f"trader arasında {rank}. sıraya girerdi.")
    else:
        n_fail = sum(1 for b, _ in rules if not b)
        lines.append(f"❌ Aday olamaz: {n_fail} kuralı geçemiyor." + (f" (Sharpe {my_score:.2f})" if my_score is not None else ""))
    if role:
        lines.append(f"Not: bu adres zaten botta ({'ana kadro' if role == 'active' else 'gözlem'}).")
    elif addr in ranking:
        lines.append("Not: aday veritabanında da listede.")
    lines.append(w.DISCLAIMER)
    data = {"addr": addr, "t": now_ms, "equity": eq, "leverage": lev, "max_pos": maxpos, "metrics": m,
            "rules": [[b, t] for b, t in rules], "passed": passed, "score": score if passed else my_score,
            "risks": risks, "role": role, "roster_scores": roster_scores,
            "positions": {c: q for c, q in pos}, "extra": extra}
    return "\n".join(lines), data


def main() -> int:
    addrs = [a.lower() for a in re.findall(r"0x[0-9a-fA-F]{40}", os.environ.get("ADRES", "") + " " + " ".join(sys.argv[1:]))]
    if not addrs:
        print("ADRES verilmedi")
        return 1
    cfg = w.load_json(w.CONFIG_PATH, None)
    cfg["_rot"] = R.merged_config(cfg)
    state = w.load_json(w.STATE_PATH, {}) or {}
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    tg = w.Telegram(token, chat) if token and chat else None
    OUT.mkdir(exist_ok=True)
    for a in dict.fromkeys(addrs):
        try:
            text, data = inspect(a, cfg, state)
        except Exception as ex:
            text, data = f"⚠️ {a} incelenemedi: {w.e(str(ex)[:200])}", {"addr": a, "error": str(ex)}
        print(re.sub(r"<[^>]+>", "", text))
        (OUT / f"{a}.txt").write_text(re.sub(r"<[^>]+>", "", text), encoding="utf-8")
        (OUT / f"{a}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        if tg:
            tg.send(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
