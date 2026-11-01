"""
Kadro yönetimi için analiz kuralları (hl_watcher.py tarafından kullanılır).

Bu dosyadaki fonksiyonlar yalnızca hesap yapar: Hyperliquid'den gelen ham veriyi
(portfolio, işlem kayıtları, anlık hesap durumu, sıralama listesi) alır, ölçümleri
ve kararların gerekçelerini döndürür. API çağrıları ve durum değişiklikleri
hl_watcher.py içindedir.

Kurallar özetle:
- Günlük risk kontrolü (anında gözleme alma): hesap kaldıracı, son 30 gün düşüş,
  hesaptan büyük çekiş, işlem tarzının dakikalık işlemlere kayması, uzun süre işlemsizlik.
- Aylık performans kontrolü: değerlendirme penceresi trader'ın pozisyon tutma süresine göre
  (hızlı: 8 hafta, swing: 90 gün, pozisyon trader'ı: 150 gün). Pencere sonucu eksi VE
  trader'ın geçmişteki en kötü aynı uzunluktaki döneminden kötüyse; ya da zirveden düşüş
  geçmişteki en büyük düşüşün 1,5 katını aştıysa; ya da kopya alt portföyü %15'ten fazla
  zarardaysa gözleme alınır.
- Gözlemden geri dönüş: en az 6 hafta gözlemde, risk işareti yok, gölge portföy +%5 üstünde
  ve kendi hesabı son pencerede kârda.
- Yeni aday: Hyperliquid sıralama listesinden ön eleme + derin inceleme.
"""

from __future__ import annotations

import bisect
import datetime as dt
import statistics

DAY_MS = 86_400_000
HOUR_MS = 3_600_000
MIN_BASE = 20_000.0          # bundan küçük hesap değerlerine oranlanan getiri/düşüş hesaba katılmaz
LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"

DEFAULTS = {
    "enabled": True,
    "slots": None,                 # ana kopya kişi sayısı; boşsa ilk kurulumdaki kopya trader sayısı
    "min_active_days": 56,         # performansa bakılarak çıkarılmadan önce ana listede en az 8 hafta
    "min_bench_days": 42,          # geri alınmadan önce gözlemde en az 6 hafta
    "max_changes_per_month": 3,    # performans kaynaklı çıkarma + yer değiştirme sınırı (risk hariç)
    "fallback_window_loss": -0.10, # geçmiş yetersizse pencere için zarar eşiği
    "dd_mult": 1.5,                # zirveden düşüş > geçmiş en büyük düşüş × 1,5
    "dd_min": 0.10,
    "paper_stop": -0.15,           # kopya alt portföyü bu kadar zarardaysa
    "promote_min_return": 0.05,    # gölge portföy getirisi bu eşiğin üstünde olmalı
    "swap_margin": 0.05,           # gözlemdeki aday, ana listedeki en zayıftan bu kadar iyi olmalı
    "risk_max_leverage": 10,
    "risk_dd30": 0.25,
    "risk_withdraw": 0.5,          # hesap değeri girişteki değerin yarısının altına inerse
    "risk_inactive_days": 30,
    "risk_min_hold_h": 1,
    "bench_max": 20,
    "bench_drop_days": 180,        # otomatik bulunan ve bu kadar gün gözlemde kalanlar listeden silinir
    "weight_budget": 900,          # her çalışmada Hyperliquid API'ye en fazla bu kadar "ağırlık" (sınır 1200/dk)
    "discovery": {
        "enabled": True,
        "min_equity": 100_000,
        "min_history_days": 365,
        "min_profitable_share": 0.60,
        "worst_month": -0.25,
        "max_best_month_share": 0.50,
        "min_hold_h": 4,
        "max_leverage": 3,
        "max_fills_per_hour": 10,
        "max_fills_per_hour_unknown_hold": 3,  # pozisyon süresi ölçülemeyenlerde (uzun tutup ekleme yapanlar)
        "max_equity": 20_000_000,
        "max_volume_ratio": 500,   # toplam hacim / hesap değeri (piyasa yapıcı ve botları eler)
        "max_month_turnover": 30,  # son ay hacmi / hesap değeri
        "candidates": 80,          # derin incelemeye alınacak en fazla aday
        "retry_days": 3,           # aday bulunamazsa tekrar arama aralığı
        "extra_to_bench": 2,       # boş yerden fazla bulunan iyi adaylar gözleme
    },
}


def merged_config(cfg: dict) -> dict:
    rot = {**DEFAULTS, **(cfg.get("rotation") or {})}
    rot["discovery"] = {**DEFAULTS["discovery"], **((cfg.get("rotation") or {}).get("discovery") or {})}
    return rot


# --------------------------------------------------------------------------- #
# Zaman serileri
# --------------------------------------------------------------------------- #

class Series:
    """[(zaman_ms, değer)] serisi; belirli bir andaki son değeri bulur."""

    def __init__(self, points):
        pts = sorted((int(t), float(v)) for t, v in points or [])
        self.t = [p[0] for p in pts]
        self.v = [p[1] for p in pts]

    def __len__(self):
        return len(self.t)

    def at(self, t: int):
        i = bisect.bisect_right(self.t, t) - 1
        if i < 0:
            return None
        return self.v[i]

    def at_or_first(self, t: int):
        v = self.at(t)
        return self.v[0] if v is None and self.v else v


def _period(portfolio, key) -> dict:
    for k, v in portfolio or []:
        if k == key:
            return v or {}
    return {}


def window_return(pnl: Series, av: Series, now_ms: int, days: float, min_av=MIN_BASE):
    """Son 'days' gündeki kâr / dönem başındaki hesap değeri. Geçmiş yetersizse None."""
    if not len(pnl):
        return None
    t0 = now_ms - int(days * DAY_MS)
    if pnl.t[0] > t0 + 14 * DAY_MS:
        return None
    p0 = pnl.at_or_first(t0)
    a0 = av.at_or_first(t0)
    if a0 is None or a0 < min_av:
        return None
    return (pnl.v[-1] - p0) / a0


def worst_past_window(pnl: Series, av: Series, now_ms: int, days: float, min_av=MIN_BASE):
    """Mevcut pencereden önce biten, aynı uzunluktaki dönemlerin en kötü getirisi (en az 3 dönem)."""
    w = int(days * DAY_MS)
    rets = []
    for te, pe in zip(pnl.t, pnl.v):
        if te > now_ms - w or te - w < pnl.t[0]:
            continue
        p0, a0 = pnl.at(te - w), av.at_or_first(te - w)
        if p0 is None or a0 is None or a0 < min_av:
            continue
        rets.append((pe - p0) / a0)
    return min(rets) if len(rets) >= 3 else None


def drawdowns(pnl: Series, av: Series):
    """(şu anki düşüş, mevcut zirveden önceki en büyük düşüş); hesap değerine oranla."""
    if len(pnl) < 2:
        return None, None
    peak_v, peak_t = pnl.v[0], pnl.t[0]
    for t, v in zip(pnl.t, pnl.v):
        if v >= peak_v:
            peak_v, peak_t = v, t
    # mevcut zirveden önceki en büyük düşüş
    hist_before = 0.0
    pv, pt = pnl.v[0], pnl.t[0]
    for t, v in zip(pnl.t, pnl.v):
        if t > peak_t:
            break
        if v >= pv:
            pv, pt = v, t
            continue
        base = av.at_or_first(pt) or 0
        if base >= MIN_BASE:
            hist_before = max(hist_before, (pv - v) / base)
    base = av.at_or_first(peak_t) or 0
    cur = (peak_v - pnl.v[-1]) / base if base >= MIN_BASE else None
    return cur, hist_before


def max_drawdown_in(pnl: Series, av: Series):
    if len(pnl) < 2:
        return None
    peak_v, peak_t, dd = pnl.v[0], pnl.t[0], 0.0
    for t, v in zip(pnl.t, pnl.v):
        if v >= peak_v:
            peak_v, peak_t = v, t
            continue
        base = av.at_or_first(peak_t) or 0
        if base >= MIN_BASE:
            dd = max(dd, (peak_v - v) / base)
    return dd


def monthly_stats(pnl: Series, av: Series):
    """Aylık kâr dağılımı: kârlı ay oranı, en kötü ay (ay başı hesaba oranla), en iyi ayın payı."""
    if len(pnl) < 2:
        return None
    last_by_month, av_by_month = {}, {}
    ym = lambda t: dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).strftime("%Y-%m")
    for t, v in zip(pnl.t, pnl.v):
        last_by_month[ym(t)] = v
    for t, v in zip(av.t, av.v):
        av_by_month[ym(t)] = v
    keys = sorted(last_by_month)
    months = []
    prev_v = pnl.v[0]
    for i, k in enumerate(keys):
        d = last_by_month[k] - prev_v
        base = av_by_month.get(keys[i - 1]) if i else None
        months.append((k, d, d / base if base and base > 20_000 else None))
        prev_v = last_by_month[k]
    active = [m for m in months if abs(m[1]) > 300]
    if not active:
        return None
    total = pnl.v[-1] - pnl.v[0]
    neg = [m[2] for m in active if m[1] < 0 and m[2] is not None]
    # Hesabı kurtarmak için para eklenen aylarda kayıp, ay başı hesaptan büyük çıkar: en kötü ay olarak sayılır
    best = max(active, key=lambda m: m[1])
    return {
        "months": len(active),
        "profitable_share": sum(1 for m in active if m[1] > 0) / len(active),
        "worst_month": min(neg) if neg else 0.0,
        "best_month_share": best[1] / total if total > 0 else None,
        "total": total,
    }


# --------------------------------------------------------------------------- #
# İşlem kayıtları
# --------------------------------------------------------------------------- #

def hold_stats(fills: list, now_ms: int) -> dict:
    """Pozisyon açılıştan sıfırlanmaya kadar geçen süreler (saat)."""
    fs = sorted((f for f in fills or [] if not str(f.get("coin", "")).startswith("@")
                 and "/" not in str(f.get("coin", ""))), key=lambda f: f["time"])
    opened, durs = {}, []
    for f in fs:
        c = f["coin"]
        s, z = float(f["startPosition"]), float(f["sz"])
        after = s + (z if f["side"] == "B" else -z)
        tol = 1e-9 * max(1.0, abs(s))
        if abs(s) <= tol and abs(after) > tol:
            opened[c] = f["time"]
        elif abs(s) > tol and (abs(after) <= tol or (s > 0) != (after > 0)):
            if c in opened:
                durs.append((f["time"], (f["time"] - opened.pop(c)) / HOUR_MS))
            if abs(after) > tol:
                opened[c] = f["time"]
    all_h = [d for _, d in durs]
    recent = [d for t, d in durs if t >= now_ms - 30 * DAY_MS]
    all_times = sorted(f["time"] for f in fills or [])
    span_h = (all_times[-1] - all_times[0]) / HOUR_MS if len(all_times) > 1 else 0
    return {
        "episodes": len(all_h),
        "median_hold_h": statistics.median(all_h) if len(all_h) >= 5 else None,
        "median_hold_30d_h": statistics.median(recent) if len(recent) >= 10 else None,
        "fills_per_hour": (len(all_times) / span_h) if span_h > 0 else 0.0,
        "last_fill_ms": all_times[-1] if all_times else None,
    }


def window_days_for(median_hold_h) -> int:
    """Değerlendirme penceresi: trader'ın işlem temposuna göre."""
    if median_hold_h is None:
        return 90
    if median_hold_h < 8:
        return 56
    if median_hold_h < 72:
        return 90
    return 150


def style_name(median_hold_h) -> str:
    if median_hold_h is None:
        return "belirsiz"
    if median_hold_h < 8:
        return "hızlı"
    if median_hold_h < 72:
        return "swing"
    return "pozisyon"


# --------------------------------------------------------------------------- #
# Ölçümler
# --------------------------------------------------------------------------- #

def analyze(portfolio, fills, now_ms: int) -> dict:
    """Bir trader'ın kural kontrolünde kullanılan bütün ölçümleri hesaplar."""
    pnl = Series(_period(portfolio, "perpAllTime").get("pnlHistory"))
    av = Series(_period(portfolio, "allTime").get("accountValueHistory"))
    m_pnl = Series(_period(portfolio, "perpMonth").get("pnlHistory"))
    m_av = Series(_period(portfolio, "month").get("accountValueHistory"))
    hs = hold_stats(fills, now_ms)
    win = window_days_for(hs["median_hold_h"])
    cur_dd, hist_dd = drawdowns(pnl, av)
    ms = monthly_stats(pnl, av)
    out = {
        "t": now_ms,
        "history_days": (now_ms - pnl.t[0]) / DAY_MS if len(pnl) else 0,
        "median_hold_h": hs["median_hold_h"],
        "median_hold_30d_h": hs["median_hold_30d_h"],
        "fills_per_hour": hs["fills_per_hour"],
        "last_fill_ms": hs["last_fill_ms"],
        "window_days": win,
        "ret_window": window_return(pnl, av, now_ms, win),
        "worst_past_window": worst_past_window(pnl, av, now_ms, win),
        "ret_90": window_return(pnl, av, now_ms, 90),
        "ret_365": window_return(pnl, av, now_ms, 365),
        "dd_now": cur_dd,
        "dd_hist": hist_dd,
        "dd_30": max_drawdown_in(m_pnl, m_av),
    }
    if ms:
        out.update({"months": ms["months"], "profitable_share": ms["profitable_share"],
                    "worst_month": ms["worst_month"], "best_month_share": ms["best_month_share"]})
    return {k: (round(v, 5) if isinstance(v, float) else v) for k, v in out.items()}


def account_leverage(snap: dict) -> float:
    eq = snap.get("equity") or 0
    gross = sum(p["value"] for p in snap.get("positions", {}).values())
    return gross / eq if eq > 0 else (float("inf") if gross > 0 else 0.0)


# --------------------------------------------------------------------------- #
# Kurallar
# --------------------------------------------------------------------------- #

def _p(x) -> str:
    return f"{'+' if x > 0 else ('−' if x < 0 else '')}%{abs(x) * 100:.1f}"


def risk_reasons(m: dict | None, snap: dict, eq0: float | None, now_ms: int, rot: dict) -> list[str]:
    """Anında gözleme almayı gerektiren davranış değişiklikleri."""
    out = []
    lev = account_leverage(snap)
    if lev > rot["risk_max_leverage"]:
        out.append(f"hesap kaldıracı {lev:.1f}x (sınır {rot['risk_max_leverage']:g}x)")
    if eq0 and snap.get("equity") is not None and snap["equity"] < rot["risk_withdraw"] * eq0:
        out.append(f"hesap değeri listeye girdiğindeki seviyenin %{snap['equity'] / eq0 * 100:.0f}'ine indi "
                   f"(para çekme veya büyük zarar)")
    if m:
        if m.get("dd_30") is not None and m["dd_30"] > rot["risk_dd30"]:
            out.append(f"son 30 günde zirveden düşüş {_p(-m['dd_30'])}")
        h30 = m.get("median_hold_30d_h")
        if h30 is not None and h30 < rot["risk_min_hold_h"]:
            out.append(f"işlem tarzı değişti: son 30 günde pozisyonları ortalama {h30 * 60:.0f} dk tutuyor")
        lf = m.get("last_fill_ms")
        if (lf is None or lf < now_ms - rot["risk_inactive_days"] * DAY_MS) and not snap.get("positions"):
            out.append(f"{rot['risk_inactive_days']} gündür işlem yok ve açık pozisyonu yok")
    return out


def performance_reasons(m: dict | None, paper_return: float | None, rot: dict) -> list[str]:
    """Aylık kontrol: trader'ı kendi geçmişiyle karşılaştırır."""
    out = []
    if m:
        r, worst, w = m.get("ret_window"), m.get("worst_past_window"), m.get("window_days", 90)
        if r is not None and r < 0:
            limit = worst if worst is not None else rot["fallback_window_loss"]
            if r < limit:
                ref = (f"geçmişteki en kötü {w} günlük dönemi {_p(worst)}" if worst is not None
                       else f"eşik {_p(limit)}")
                out.append(f"son {w} gün {_p(r)}; {ref} ({style_name(m.get('median_hold_h'))} trader)")
        dd, hist = m.get("dd_now"), m.get("dd_hist")
        if dd is not None:
            limit = max(rot["dd_min"], rot["dd_mult"] * hist) if hist else max(rot["dd_min"], 0.25)
            if dd > limit:
                out.append(f"zirveden düşüş {_p(-dd)}; geçmişteki en büyük düşüş {_p(-(hist or 0))}")
    if paper_return is not None and paper_return < rot["paper_stop"]:
        out.append(f"kopya alt portföyü {_p(paper_return)}")
    return out


def promotion_check(m: dict | None, shadow_return: float | None, bench_days: float,
                    risk: list[str], rot: dict) -> tuple[bool, str]:
    if bench_days < rot["min_bench_days"]:
        return False, f"gözlemde {bench_days:.0f}/{rot['min_bench_days']} gün"
    if risk:
        return False, "risk işareti: " + risk[0]
    if shadow_return is None or shadow_return < rot["promote_min_return"]:
        return False, f"gölge portföy {_p(shadow_return or 0)} (gereken {_p(rot['promote_min_return'])})"
    r = (m or {}).get("ret_window")
    if r is None or r <= 0:
        return False, "kendi hesabı son dönemde kârda değil"
    return True, (f"gözlemde {bench_days:.0f} gün, gölge portföy {_p(shadow_return)}, "
                  f"son {m.get('window_days', 90)} gün {_p(r)}")


def prefilter_leaderboard(rows: list, exclude: set, disc: dict) -> list[str]:
    """Sıralama listesinden derin incelemeye girecek adresler (toplam kâra göre sıralı)."""
    picked = []
    for row in rows or []:
        addr = str(row.get("ethAddress", "")).lower()
        if not addr or addr in exclude:
            continue
        try:
            eq = float(row.get("accountValue") or 0)
            wp = {k: v for k, v in row.get("windowPerformances") or []}
            at, mo, wk = wp.get("allTime") or {}, wp.get("month") or {}, wp.get("week") or {}
            at_pnl, mo_pnl, wk_pnl = float(at.get("pnl") or 0), float(mo.get("pnl") or 0), float(wk.get("pnl") or 0)
            vlm, mo_vlm = float(at.get("vlm") or 0), float(mo.get("vlm") or 0)
            roi, mo_roi = float(at.get("roi") or 0), float(mo.get("roi") or 0)
        except (TypeError, ValueError):
            continue
        if not (disc["min_equity"] <= eq <= disc["max_equity"]) or at_pnl <= 0 or mo_pnl <= 0 or wk_pnl < 0:
            continue
        if vlm / eq > disc["max_volume_ratio"] or not (1 <= mo_vlm / eq <= disc["max_month_turnover"]):
            continue          # piyasa yapıcı/botlar ve son ay işlem yapmayanlar (ör. sadece spot tutanlar)
        if not (0.3 <= roi <= 10) or not (0 < mo_roi <= 0.3):
            continue          # piyango kazancı gibi aşırı getiriler hariç
        picked.append((at_pnl, addr))
    picked.sort(reverse=True)
    return [a for _, a in picked[: disc["candidates"]]]


def candidate_check(m: dict, snap: dict, disc: dict) -> tuple[bool, float, str]:
    """Yeni aday için derin inceleme; (uygun mu, puan, açıklama)."""
    fails = []
    if (snap.get("equity") or 0) < disc["min_equity"]:
        fails.append("hesap küçük")
    if m.get("history_days", 0) < disc["min_history_days"]:
        fails.append(f"geçmiş {m.get('history_days', 0):.0f} gün")
    ps = m.get("profitable_share")
    if ps is None or ps < disc["min_profitable_share"]:
        fails.append(f"kârlı ay oranı {0 if ps is None else ps * 100:.0f}%")
    wm = m.get("worst_month")
    if wm is None or wm < disc["worst_month"]:
        fails.append(f"en kötü ay {_p(wm or 0)}")
    bs = m.get("best_month_share")
    if bs is None or bs > disc["max_best_month_share"]:
        fails.append("kâr tek aya yığılmış")
    mh = m.get("median_hold_h")
    fph = m.get("fills_per_hour") or 0
    if mh is None:
        if fph > disc["max_fills_per_hour_unknown_hold"]:
            fails.append("pozisyon süresi ölçülemedi ve sık işlem yapıyor")
    elif mh < disc["min_hold_h"]:
        fails.append("pozisyon süresi kısa")
    if fph > disc["max_fills_per_hour"]:
        fails.append("çok sık işlem")
    lev = account_leverage(snap)
    if lev > disc["max_leverage"]:
        fails.append(f"kaldıraç {lev:.1f}x")
    r365 = m.get("ret_365")
    if r365 is None or r365 <= 0:
        fails.append("son 12 ay kârda değil")
    if fails:
        return False, 0.0, ", ".join(fails)
    score = r365 / max(0.05, abs(wm))
    desc = (f"{m['history_days'] / 30:.0f} ay geçmiş, kârlı ay %{ps * 100:.0f}, en kötü ay {_p(wm)}, "
            f"12 ay {_p(r365)}, {style_name(mh) + f' ({mh:.0f} saat)' if mh is not None else 'uzun vadeli'}, "
            f"kaldıraç {lev:.1f}x")
    return True, score, desc
