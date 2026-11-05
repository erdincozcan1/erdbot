/**
 * Hyperliquid takip botu — anlık komut yanıtlayıcı (Cloudflare Worker)
 *
 * Telegram'da /durum veya /rapor yazınca birkaç saniye içinde cevap verir.
 * GitHub deposundaki hl_state.json ve hl_traders.json dosyalarını okur,
 * açık sanal pozisyonları Hyperliquid'in o anki fiyatlarıyla değerler.
 * Hiç işlem açmaz; sadece okur ve mesaj gönderir.
 *
 * Gerekli değişkenler (Cloudflare → Worker → Settings → Variables and Secrets):
 *   TELEGRAM_BOT_TOKEN   Telegram bot token'ı
 *   TELEGRAM_CHAT_ID     senin chat ID'n (yalnızca bu sohbete cevap verilir)
 *   GITHUB_REPO          "kullaniciadi/depoadi"
 *   GITHUB_TOKEN         depo özel (private) ise: yalnızca o depoda "Contents: Read-only" yetkili token
 *   WEBHOOK_SECRET       kendi belirlediğin uzun rastgele bir kelime (ör. 30+ harf/rakam)
 *   GITHUB_DISPATCH      "1" ise: Cron tetikleyicisi her çalıştığında GitHub botunu başlatır
 *                        (token'ın "Actions: Read and write" yetkisi de olmalı)
 *   PANEL_KEY            tarayıcı paneli için anahtar (https://<worker-adresi>/panel); boşsa panel kapalı
 *
 * Güvenilir 5 dakikalık çalışma için: Worker → Settings → Trigger events → Cron → "her 5 dakikada bir" (ifade: yıldız-bölü-5 ve dört yıldız)
 *
 * Kurulumdan sonra bir kez tarayıcıda aç:  https://<worker-adresi>/setup?key=<WEBHOOK_SECRET>
 */

const HL_API = "https://api.hyperliquid.xyz/info";
const DISCLAIMER = "<i>Simülasyondur, yatırım tavsiyesi değildir.</i>";

export default {
  // Cron tetikleyicisi: GitHub'ın kendi zamanlayıcısı güvenilir olmadığı için botu buradan başlatır
  async scheduled(event, env, ctx) {
    env = clean(env);
    if (env.GITHUB_DISPATCH !== "1") return;
    ctx.waitUntil(dispatchWorkflow(env));
  },

  async fetch(request, env) {
    env = clean(env);
    const url = new URL(request.url);

    // Teşhis sayfası: ayarların ve Telegram bağlantısının durumunu gösterir (token'ları göstermez)
    if (request.method === "GET" && url.pathname === "/check") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("Yetkisiz", { status: 403 });
      }
      const out = { ayarlar: {}, beklenen_webhook: `${url.origin}/telegram` };
      for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_REPO", "GITHUB_TOKEN", "GITHUB_DISPATCH", "WEBHOOK_SECRET", "PANEL_KEY"]) {
        out.ayarlar[k] = env[k] ? "var" : "EKSİK";
      }
      out.ayarlar.TELEGRAM_CHAT_ID_degeri = env.TELEGRAM_CHAT_ID || null;
      out.ayarlar.GITHUB_REPO_degeri = env.GITHUB_REPO || null;
      try {
        const me = await tg(env, "getMe", {});
        out.telegram_token = me.ok ? `geçerli (@${me.result.username})` : `GEÇERSİZ: ${me.description}`;
        const wh = await tg(env, "getWebhookInfo", {});
        if (wh.ok) {
          const w = wh.result;
          out.webhook = {
            adres: w.url || "(ayarlanmamış — /setup sayfasını aç)",
            dogru_adres_mi: w.url === `${url.origin}/telegram`,
            bekleyen_mesaj: w.pending_update_count,
            son_hata: w.last_error_message || "yok",
            son_hata_zamani: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : null,
          };
        }
      } catch (e) { out.telegram_token = "Telegram'a ulaşılamadı: " + String(e); }
      try {
        await loadRepo(env);
        out.github = "dosyalar okunabiliyor";
      } catch (e) { out.github = "HATA: " + String(e); }
      // Botu başlatma yetkisini dener (başarılıysa GitHub'da bir çalışma başlar)
      out.GITHUB_DISPATCH_degeri = env.GITHUB_DISPATCH || null;
      try {
        const st = await dispatchWorkflow(env);
        out.bot_baslatma = st === 204 ? "çalışıyor: GitHub'da yeni bir çalışma başlatıldı"
          : st === 403 ? "HATA 403: GITHUB_TOKEN'da 'Actions: Read and write' yetkisi yok"
          : st === 401 ? "HATA 401: GITHUB_TOKEN hatalı veya süresi dolmuş"
          : st === 404 ? "HATA 404: depo adı yanlış ya da token'a bu depo seçilmemiş"
          : st === 422 ? "HATA 422: iş akışı dosyası (hl_watch.yml) veya 'main' dalı bulunamadı"
          : "HATA " + st;
      } catch (e) { out.bot_baslatma = "HATA: " + String(e); }
      out.not = "5 dakikalık otomatik başlatma için ayrıca Settings → Trigger events bölümünde '*/5 * * * *' Cron Trigger'ı ekli olmalı ve GITHUB_DISPATCH = 1 olmalı.";
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    // Tek seferlik kurulum: Telegram webhook'unu bu Worker'a yönlendirir
    if (request.method === "GET" && url.pathname === "/setup") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("Yetkisiz", { status: 403 });
      }
      const r = await tg(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      return new Response(JSON.stringify(r, null, 2), { headers: { "content-type": "application/json" } });
    }

    // Panel: tarayıcıdan açılan arayüz ve verisi (PANEL_KEY ile korunur)
    if (request.method === "GET" && url.pathname === "/panel") {
      return new Response(PANEL_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-robots-tag": "noindex", "referrer-policy": "no-referrer" } });
    }
    if (request.method === "GET" && url.pathname === "/panel/data") {
      if (!env.PANEL_KEY) return json({ error: "Panel kapalı: Cloudflare'de PANEL_KEY değişkenini ekle." }, 403);
      if (request.headers.get("x-panel-key") !== env.PANEL_KEY) return json({ error: "Anahtar yanlış." }, 403);
      try {
        const { cfg, state } = await loadRepo(env);
        if (!state) return json({ error: "Henüz kayıt yok. GitHub'daki bot ilk kez çalıştıktan sonra tekrar dene." }, 404);
        normalize(state, cfg);
        const mids = await fetchMids(cfg.dexes || [""]);
        const candles = await benchCandles(state.history).catch(() => ({}));
        return json(panelData(state, cfg, mids, candles));
      } catch (err) {
        return json({ error: "Veri alınamadı: " + String(err).slice(0, 200) }, 502);
      }
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Yetkisiz", { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response("ok"); }
      const msg = update.message || {};
      const chatId = String((msg.chat || {}).id || "");
      const text = String(msg.text || "").trim().split("@")[0].toLowerCase();
      if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
        console.log("Başka bir sohbetten mesaj geldi, yok sayıldı. Gelen chat id:", chatId);
        return new Response("ok");
      }
      if (!text.startsWith("/")) return new Response("ok");

      try {
        if (text === "/durum" || text === "/rapor" || text === "/gozlem" || text === "/gözlem" || text === "/adaylar") {
          const { cfg, state } = await loadRepo(env);
          if (!state) {
            await send(env, "Henüz kayıt yok. GitHub'daki bot ilk kez çalıştıktan sonra tekrar dene.");
          } else {
            normalize(state, cfg);
            const mids = await fetchMids(cfg.dexes || [""]);
            if (text === "/durum") await send(env, summaryText(state, cfg, mids, "Anlık durum") + "\n\n" + DISCLAIMER);
            else if (text === "/rapor") await send(env, weeklyText(state, cfg, mids));
            else if (text === "/adaylar") await send(env, candidatesText(state));
            else await send(env, benchText(state, mids));
          }
        } else {
          await send(env, "Komutlar: /durum · /rapor · /gozlem · /adaylar\nCevaplar birkaç saniye içinde gelir. " +
                          "Trader hareketleri GitHub botu tarafından birkaç dakikada bir işlenir.");
        }
      } catch (err) {
        await send(env, "⚠️ Veri alınamadı: " + esc(String(err).slice(0, 200)));
      }
      return new Response("ok");
    }

    return new Response("Hyperliquid takip botu çalışıyor.");
  },
};

// ------------------------------------------------------------------ yardımcılar

async function dispatchWorkflow(env) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/hl_watch.yml/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hl-watch-worker",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (r.status !== 204) console.log("GitHub tetikleme başarısız:", r.status, await r.text());
  return r.status;
}

// Ayarlara yanlışlıkla eklenen boşluk/satır sonlarını temizler (en sık hata sebebi)
function clean(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) out[k] = typeof v === "string" ? v.trim() : v;
  return out;
}

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function usd(x, sign = false) {
  const s = sign && x > 0 ? "+" : x < 0 ? "−" : "";
  const a = Math.abs(x);
  const f = (v, d) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (a >= 1e6) return `${s}${f(a / 1e6, 2)}M$`;
  if (a >= 1e4) return `${s}${f(a / 1e3, 1)}K$`;
  return `${s}${f(a, 2)}$`;
}

function pct(x) { return `${x > 0 ? "+" : x < 0 ? "−" : ""}%${(Math.abs(x) * 100).toFixed(1)}`; }

function side(s) { return s > 0 ? "LONG" : "SHORT"; }

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}

async function send(env, text) {
  for (let i = 0; i < text.length; i += 3900) {
    await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(i, i + 3900),
      parse_mode: "HTML", disable_web_page_preview: true,
    });
  }
}

async function ghFile(env, path) {
  const headers = { "Accept": "application/vnd.github.raw+json", "User-Agent": "hl-watch-worker" };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${path}: HTTP ${r.status}`);
  return JSON.parse(await r.text());
}

async function loadRepo(env) {
  const [cfg, state] = await Promise.all([ghFile(env, "hl_traders.json"), ghFile(env, "hl_state.json")]);
  if (!cfg) throw new Error("hl_traders.json depoda bulunamadı");
  return { cfg, state };
}

// Karşılaştırma ölçütleri: Hyperliquid'deki Nasdaq-100 ve altın kontratları (bot saatlik kayda da yazar)
const BENCH = { ndx: "xyz:XYZ100", gold: "xyz:GOLD" };

// Bot bu ölçütleri kaydetmeye başlamadan önceki saatler için Hyperliquid mum verisinden doldurur
async function benchCandles(history) {
  const miss = (history || []).filter(h => h[4] == null || h[5] == null);
  if (!miss.length) return {};
  const start = Date.parse(miss[0][0]) - 2 * 3600e3, end = Date.now();
  const interval = (end - start) / 3600e3 > 4800 ? "4h" : "1h";
  const out = {};
  for (const [k, coin] of Object.entries(BENCH)) {
    try {
      const r = await fetch(HL_API, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime: start, endTime: end } }) });
      const j = await r.json();
      if (Array.isArray(j)) out[k] = j.map(c => [Number(c.T || c.t), Number(c.c)]).filter(x => isFinite(x[0]) && x[1] > 0).sort((a, b) => a[0] - b[0]);
    } catch (e) { /* mum verisi alınamazsa yalnızca botun kaydettiği saatler gösterilir */ }
  }
  return out;
}
function priceAt(series, t) {
  if (!series || !series.length || t < series[0][0] - 6 * 3600e3) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (series[mid][0] <= t) lo = mid; else hi = mid - 1; }
  return series[lo][0] <= t + 3600e3 ? series[lo][1] : null;
}

async function fetchMids(dexes) {
  const out = {};
  for (const dex of dexes) {
    const r = await fetch(HL_API, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids", dex }),
    });
    const j = await r.json();
    for (const [k, v] of Object.entries(j || {})) { const n = Number(v); if (isFinite(n)) out[k] = n; }
  }
  return out;
}

// --------------------------------------------- sanal portföy (hl_watcher.py ile aynı)

function subEquity(sub, mids) {
  let upnl = 0;
  for (const [c, p] of Object.entries(sub.positions || {})) upnl += p.sz * ((mids[c] ?? p.entry) - p.entry);
  return sub.capital + sub.realized - sub.fees - (sub.funding || 0) + upnl;
}

// Eski (tek liste) ve yeni (ana kopya + gözlem) durum dosyalarını aynı biçime getirir
function normalize(state, cfg) {
  if ((state.version || 1) < 2) {
    const keep = new Set((cfg.traders || []).filter(t => t.copy !== false).map(t => t.address.toLowerCase()));
    state.subs = Object.fromEntries(Object.entries(state.subs || {}).filter(([a]) => keep.has(a)));
    state.roles = Object.fromEntries((cfg.traders || []).map(t => [t.address.toLowerCase(), { label: t.label, role: "active" }]));
    state.shadow = {};
    state.closed_pnl = 0;
    state._slots = Object.keys(state.subs).length || 1;
  } else {
    state._slots = ((cfg.rotation || {}).slots) || ((state.rotation || {}).slots) || Object.keys(state.subs || {}).length || 1;
  }
  state._per = (cfg.paper_capital_usd || 0) / state._slots;
  state._free = Math.max(0, state._slots - Object.keys(state.subs || {}).length);
}

function labelOf(state, a) { return ((state.roles || {})[a] || {}).label || a.slice(0, 8); }

function totalEquity(state, mids) {
  return Object.values(state.subs).reduce((s, sub) => s + subEquity(sub, mids), 0)
    + (state.closed_pnl || 0) + state._free * state._per;
}

function totalCapital(state) {
  return Object.values(state.subs).reduce((s, x) => s + x.capital, 0) + state._free * state._per;
}

function maxDrawdown(history, current) {
  let peak = 0, mdd = 0;
  for (const v of [...(history || []).map(h => h[1]), current]) {
    peak = Math.max(peak, v);
    if (peak > 0) mdd = Math.max(mdd, 1 - v / peak);
  }
  return mdd;
}

function daysSince(iso) { return iso ? (Date.now() - Date.parse(iso)) / 864e5 : 0; }

function summaryText(state, cfg, mids, title) {
  const subs = Object.values(state.subs);
  const cap = totalCapital(state);
  const eq = totalEquity(state, mids);
  const realized = subs.reduce((s, x) => s + x.realized, 0);
  const fees = subs.reduce((s, x) => s + x.fees, 0);
  const funding = subs.reduce((s, x) => s + (x.funding || 0), 0);
  const upnl = subs.reduce((s, x) => s + subEquity(x, mids) - x.capital - x.realized + x.fees + (x.funding || 0), 0);
  const rows = Object.entries(state.subs).map(([addr, s]) => {
    const se = subEquity(s, mids);
    const poss = Object.entries(s.positions || {}).map(([c, p]) => `${c} ${side(p.sz)}`).join(", ") || "pozisyon yok";
    return [se / s.capital - 1, `• ${esc(labelOf(state, addr))}: ${usd(se)} (${pct(se / s.capital - 1)}) · ` +
                                `${s.trades} işlem, ${s.skipped} atlanan · ${esc(poss)}`];
  }).sort((a, b) => b[0] - a[0]).map(r => r[1]);
  const lines = [
    `📊 <b>${title}</b>`,
    `Başlangıç ${esc(String(state.started).slice(0, 10))} · sermaye ${usd(cap)}`,
    `<b>Sanal portföy: ${usd(eq)} (${pct(eq / cap - 1)})</b>`,
    `Gerçekleşen ${usd(realized, true)} · açık ${usd(upnl, true)} · ücret ${usd(-fees)} · fonlama ${usd(-funding, true)}`,
  ];
  if (state.closed_pnl) lines.push(`Listeden çıkarılanların sonucu: ${usd(state.closed_pnl, true)}`);
  if (state._free) lines.push(`Boş yer: ${state._free} (nakit bekliyor)`);
  lines.push(`En büyük düşüş: ${pct(-maxDrawdown(state.history, eq))}`, "", `<b>Ana kopya (${subs.length})</b>`, ...rows);
  const nb = Object.keys(state.shadow || {}).length;
  if (nb) lines.push("", `Gözlemde ${nb} trader (ayrıntı: /gozlem)`);
  lines.push("", "<i>Fiyatlar anlık; son işlemler birkaç dakika gecikmeli işlenir.</i>");
  return lines.join("\n");
}

function benchText(state, mids) {
  const sh = Object.entries(state.shadow || {});
  if (!sh.length) return "👁 Gözlem listesi boş.";
  const rows = sh.map(([a, s]) => {
    const r = subEquity(s, mids) / s.capital - 1;
    const role = (state.roles || {})[a] || {};
    return [r, `• ${esc(labelOf(state, a))}: gölge ${pct(r)} · ${daysSince(role.since).toFixed(0)} gün gözlemde`];
  }).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  return "👁 <b>Gözlem listesi</b> (gölge portföy: kopyalansaydı ne olurdu; ana portföye katılmaz)\n" + rows.join("\n") +
         "\n\n<i>Geri dönüş için: en az 42 gün gözlem, gölge portföy +%5 üstü, risk işareti yok. Kararı her sabah bot verir.</i>";
}

function candidatesText(state, limit = 15) {
  const c = state.candidates || {};
  if (!c.total && !c.last_finished_ms) return "📚 Aday veritabanı henüz oluşturuluyor. İlk tam tarama yaklaşık 1 gün sürer.";
  const lines = ["📚 <b>Aday veritabanı</b>"];
  if (c.last_finished_ms) {
    const d = new Date(c.last_finished_ms).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    lines.push(`Son tam tarama: ${d} · ${c.n_ranked || 0} uygun aday`);
  }
  if (c.phase === "scan") lines.push(`Tarama sürüyor: ${(c.scanned || 0).toLocaleString("en-US")}/${(c.total || 0).toLocaleString("en-US")} hesap`);
  else if (c.phase === "deep") lines.push(`Ayrıntılı inceleme sürüyor: ${c.deep_done}/${c.deep_total} hesap`);
  const top = c.top || [];
  if (!top.length) lines.push("Henüz sıralama yok (ilk tarama bitince oluşur).");
  top.slice(0, limit).forEach((x, i) => {
    const role = ((state.roles || {})[x.a] || {}).role;
    const tag = role === "active" ? " · <b>ana kopyada</b>" : role === "bench" ? " · gözlemde" : "";
    lines.push(`${i + 1}. <a href="https://hyperdash.com/address/${x.a}">${x.a.slice(0, 6)}</a>${tag}\n   ${esc(x.desc || "")}`);
  });
  lines.push("\n<i>Kadroda yer açıldığında bot önce bu listeye bakar; seçmeden önce güncel veriyle yeniden kontrol eder.</i>");
  return lines.join("\n");
}

function weeklyText(state, cfg, mids) {
  const eq = totalEquity(state, mids);
  const last = (state.last_report || {}).equity || eq;
  let text = summaryText(state, cfg, mids, "Rapor");
  const btcLast = (state.last_report || {}).btc, btcNow = mids.BTC;
  const bench = btcLast && btcNow ? ` · BTC ${pct(btcNow / btcLast - 1)}` : "";
  text = text.replace("\n", `\nBu hafta: ${pct(eq / last - 1)}${bench}\n`);
  const weekAgo = Date.now() - 7 * 864e5;
  const ch = (((state.rotation || {}).changes) || []).filter(c => Date.parse(c[0]) >= weekAgo);
  if (ch.length) {
    const kinds = { risk: "risk", perf: "performans", swap: "yer değiştirme", "swap-in": "yer değiştirme",
                    promote: "geri döndü", new: "yeni aday", manual: "elle", remove: "silindi" };
    text += "\n\n<b>Bu haftaki kadro değişiklikleri</b>\n" +
      ch.map(c => `• ${c[0].slice(5, 10)} ${esc(c[3] || labelOf(state, c[2]))}: ${kinds[c[1]] || c[1]}`).join("\n");
  }
  if (Object.keys(state.shadow || {}).length) text += "\n\n" + benchText(state, mids);
  return text + "\n\n" + DISCLAIMER;
}

// ------------------------------------------------------------------ panel

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function styleName(h) { return h == null ? null : h < 8 ? "hızlı" : h < 72 ? "swing" : "pozisyon"; }

// Risk grubu: botun aday kurallarıyla aynı eşikler (hl_rotation.py DEFAULTS.discovery)
function riskGroup(m, cfg) {
  const d = Object.assign({ worst_month: -0.40, min_profitable_share: 0.60, core_worst_month: -0.15, core_min_profitable_share: 0.70,
                            min_history_days: 365 }, ((cfg.rotation || {}).discovery) || {});
  if (m.worst_month == null || m.profitable_share == null) return null;
  if ((m.history_days || 0) < d.min_history_days) return "dışında";
  if (m.worst_month >= d.core_worst_month && m.profitable_share >= d.core_min_profitable_share) return "çekirdek";
  if (m.worst_month >= d.worst_month && m.profitable_share >= d.min_profitable_share) return "geniş";
  return "dışında";
}

function panelData(state, cfg, mids, candles) {
  const pos = (s) => Object.entries(s.positions || {}).map(([c, p]) => {
    const m = mids[c] ?? p.entry;
    return { coin: c.replace("xyz:", ""), xyz: c.startsWith("xyz:"), side: p.sz > 0 ? "LONG" : "SHORT", sz: Math.abs(p.sz), entry: p.entry, mark: m,
             value: Math.abs(p.sz) * m, pnl: p.sz * (m - p.entry), pnl_pct: p.entry ? (m / p.entry - 1) * Math.sign(p.sz) : 0 };
  });
  const met = (a) => {
    const m = (state.metrics || {})[a];
    if (!m) return null;
    return { style: styleName(m.median_hold_h), hold_h: m.median_hold_h, window_days: m.window_days, ret_window: m.ret_window,
             ret_365: m.ret_365, dd_now: m.dd_now, profitable_share: m.profitable_share, worst_month: m.worst_month,
             months: m.months, history_days: m.history_days, sharpe: m.sharpe ?? null, group: riskGroup(m, cfg),
             trader_ret_since: m.since && m.since === (((state.roles || {})[a] || {}).since) ? m.trader_ret_since : null };
  };
  const row = (a, s) => {
    const r = (state.roles || {})[a] || {};
    const se = subEquity(s, mids);
    return { a, label: r.label || a.slice(0, 8), since: r.since || null, source: r.source || "config", pin: !!r.pin,
             capital: s.capital, equity: se, ret: s.capital ? se / s.capital - 1 : 0, trades: s.trades, skipped: s.skipped,
             realized: s.realized, fees: s.fees, funding: s.funding || 0, delay: s.delay || null, positions: pos(s), metrics: met(a),
             trader_equity: ((state.snapshots || {})[a] || {}).equity ?? null, moves: (state.watch_events || {})[a] || 0 };
  };
  const subs = Object.values(state.subs || {});
  const eq = totalEquity(state, mids), cap = totalCapital(state);
  candles = candles || {};
  const hist = (state.history || []).slice(-2500).map(h => {
    const t = Date.parse(h[0]);
    return [h[0], h[1], h[2] ?? null, h[3] ?? null, h[4] ?? priceAt(candles.ndx, t), h[5] ?? priceAt(candles.gold, t)];
  });
  const last = (state.last_report || {}).equity || null;
  return {
    meta: { started: state.started, last_run: state.last_run || (hist.length ? hist[hist.length - 1][0] : null),
            slots: state._slots, per_slot: state._per, free: state._free, max_leverage: cfg.max_leverage ?? 5,
            max_wide: (((cfg.rotation || {}).discovery) || {}).max_wide ?? 4, fee_pct: cfg.fee_pct ?? 0.095, min_order_usd: cfg.min_order_usd ?? 10, now: new Date().toISOString() },
    summary: { equity: eq, capital: cap, ret: cap ? eq / cap - 1 : 0, week_ret: last ? eq / last - 1 : null,
               mdd: maxDrawdown(state.history, eq),
               realized: subs.reduce((t, x) => t + x.realized, 0), fees: subs.reduce((t, x) => t + x.fees, 0),
               funding: subs.reduce((t, x) => t + (x.funding || 0), 0),
               upnl: subs.reduce((t, x) => t + subEquity(x, mids) - x.capital - x.realized + x.fees + (x.funding || 0), 0),
               delay: subs.reduce((t, x) => x.delay ? { cost: t.cost + x.delay.cost, ntl: t.ntl + x.delay.ntl, n: t.n + x.delay.n } : t, { cost: 0, ntl: 0, n: 0 }),
               closed_pnl: state.closed_pnl || 0, btc: mids.BTC || null,
               ndx: mids[BENCH.ndx] || null, gold: mids[BENCH.gold] || null, btc_week: (state.last_report || {}).btc || null },
    history: hist,
    traders: Object.entries(state.subs || {}).map(([a, s]) => row(a, s)).sort((x, y) => y.ret - x.ret),
    bench: Object.entries(state.shadow || {}).map(([a, s]) => row(a, s)).sort((x, y) => y.ret - x.ret),
    changes: (((state.rotation || {}).changes) || []).slice(-80).reverse().map(c => ({ t: c[0], kind: c[1], a: c[2], label: c[3] || null })),
    closed: (state.closed || []).slice(-40).reverse(),
    candidates: state.candidates || null,
    discovery: (state.rotation || {}).discovery ? { checked: state.rotation.discovery.checked || 0,
                 left: (state.rotation.discovery.queue || []).length } : null,
  };
}

const PANEL_HTML = String.raw`<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Kopya Portföy Paneli</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Düzen: üstte özet şeridi, altında grafik; sonra sekmeli bölümler (trader'lar, pozisyonlar, gözlem, değişiklikler, adaylar). */
:root {
  --bg: #eef2f0; --surface: #ffffff; --sunk: #f6f8f7; --ink: #14201c; --muted: #5b6a64; --line: #dbe2df;
  --accent: #1d6b58; --accent-soft: #dcebe6; --up: #1b8547; --down: #c03a33; --warn: #a86d12;
  --up-soft: #e1f2e7; --down-soft: #f8e3e1; --warn-soft: #f6ecd9;
  --c-btc: #6b7a74; --c-ndx: #3d6fd1; --c-gold: #b8860b;
  --f-display: "Familjen Grotesk", "Helvetica Neue", Arial, sans-serif;
  --f-body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --f-num: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0e1412; --surface: #151d1a; --sunk: #111816; --ink: #e5ede9; --muted: #92a19b; --line: #25302c;
    --accent: #5fc4a5; --accent-soft: #1b2f29; --up: #4cc47e; --down: #ef6f67; --warn: #e0ae4c;
    --up-soft: #16291e; --down-soft: #2e1a19; --warn-soft: #2b2315; color-scheme: dark;
    --c-btc: #9aa8a2; --c-ndx: #7ea6f2; --c-gold: #e3b54a; }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--f-body);
  padding: env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px); -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1180px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px)); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.num { font-family: var(--f-num); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.up { color: var(--up); } .down { color: var(--down); } .muted { color: var(--muted); }

header.top { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
header.top .wrap { display: flex; align-items: center; gap: 12px; padding-block: 12px; }
.brand { font: 600 18px/1.1 var(--f-display); letter-spacing: -0.01em; }
.brand small { display: block; font: 400 12px/1.3 var(--f-body); color: var(--muted); letter-spacing: 0; }
.spacer { flex: 1; }
.fresh { font-size: 12.5px; color: var(--muted); text-align: right; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--up); margin-right: 6px; vertical-align: 1px; }
.dot.stale { background: var(--warn); } .dot.dead { background: var(--down); }
@media (max-width: 640px) { .fresh { white-space: nowrap; } header.top .brand small { display: none; } .hide-sm { display: none; } }
.btn { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 13.5px; }
.btn:hover { border-color: var(--accent); }

main { padding-block: 20px 40px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
.hero { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.6fr); gap: 20px; align-items: stretch; }
@media (max-width: 860px) { .hero { grid-template-columns: minmax(0, 1fr); } }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 18px; min-width: 0; }
.eyebrow { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.big { font: 600 clamp(34px, 6vw, 46px)/1.05 var(--f-num); letter-spacing: -0.03em; margin-top: 6px; }
.pill { display: inline-flex; align-items: center; gap: 4px; font: 500 13px/1 var(--f-num); padding: 5px 8px; border-radius: 999px; }
.pill.up { background: var(--up-soft); } .pill.down { background: var(--down-soft); } .pill.flat { background: var(--sunk); color: var(--muted); }
.kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line);
  border-radius: 10px; overflow: hidden; margin-top: 16px; }
.kpi { background: var(--surface); padding: 10px 12px; min-width: 0; }
.kpi .k { font-size: 12px; color: var(--muted); }
.kpi .v { font: 500 16px/1.3 var(--f-num); font-variant-numeric: tabular-nums; }
.note { font-size: 12.5px; color: var(--muted); margin-top: 12px; }

.chart-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-left: auto; }
.seg button { border: 0; background: transparent; padding: 5px 10px; font-size: 12.5px; cursor: pointer; color: var(--muted); }
.seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--ink); font-weight: 600; }
#chart { position: relative; margin-top: 10px; height: 250px; }
#chart svg { display: block; width: 100%; height: 100%; touch-action: pan-y; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; font-size: 12.5px; color: var(--muted); }
.legend .lg { display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; padding: 2px 0; color: inherit; font: inherit; cursor: default; }
.legend button.lg { cursor: pointer; } .legend button.lg[aria-pressed="false"] { opacity: 0.45; } .legend button.lg:disabled { opacity: 0.35; cursor: default; }
.legend .lg i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; }
.legend .lg i.dash { height: 0; border-top: 2px dashed; background: none; }
.legend .lg b { font-weight: 500; color: var(--ink); }
.tip { position: absolute; pointer-events: none; background: var(--ink); color: var(--bg); font: 12px/1.35 var(--f-num);
  padding: 6px 8px; border-radius: 6px; white-space: nowrap; transform: translate(-50%, -110%); line-height: 1.45; }

nav.tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
nav.tabs::-webkit-scrollbar { display: none; }
nav.tabs button { flex: 0 0 auto; border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 7px 14px;
  font-size: 14px; cursor: pointer; }
nav.tabs button[aria-selected="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
nav.tabs .count { font-family: var(--f-num); font-size: 12px; opacity: 0.7; margin-left: 4px; }

.list { display: grid; gap: 8px; }
.row { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
.row > summary { list-style: none; cursor: pointer; display: grid; align-items: center; gap: 10px; padding: 12px 14px;
  grid-template-columns: minmax(0, 2.1fr) minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1.5fr) 18px; }
.row > summary::-webkit-details-marker { display: none; }
.row[open] > summary { border-bottom: 1px solid var(--line); }
.who { min-width: 0; }
.who b { font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.who span { font-size: 12.5px; color: var(--muted); }
.tag { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; padding: 2px 6px; border-radius: 5px;
  background: var(--sunk); color: var(--muted); margin-left: 6px; vertical-align: 1px; }
.tag.auto { background: var(--accent-soft); color: var(--accent); }
.tag.grp-core { background: var(--up-soft); color: var(--up); } .tag.grp-wide { background: var(--warn-soft); color: var(--warn); }
.tag.grp-out { background: var(--down-soft); color: var(--down); } .tag.pin { background: var(--warn-soft); color: var(--warn); }
.cell { min-width: 0; } .cell .k { font-size: 11.5px; color: var(--muted); display: block; }
.cell .v { font: 500 14.5px/1.3 var(--f-num); font-variant-numeric: tabular-nums; }
.bar { height: 6px; border-radius: 3px; background: var(--sunk); position: relative; overflow: hidden; margin-top: 5px; }
.bar i { position: absolute; top: 0; bottom: 0; border-radius: 3px; }
.chev { color: var(--muted); transition: transform .15s; }
.row[open] .chev { transform: rotate(90deg); }
.detail { padding: 12px 14px 14px; display: grid; gap: 12px; }
.facts { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--muted); }
.facts b { color: var(--ink); font-weight: 500; font-family: var(--f-num); }
@media (max-width: 640px) {
  .row > summary { grid-template-columns: minmax(0, 1fr) auto 18px; }
  .row > summary .hide-sm { display: none; }
}

.tbl-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { padding: 9px 12px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--line); }
th { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); background: var(--sunk); }
td.r, th.r { text-align: right; }
tr:last-child td { border-bottom: 0; }
.side { font: 600 11px/1 var(--f-body); letter-spacing: 0.04em; padding: 3px 6px; border-radius: 4px; }
.risk-k { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 10px; }
@media (max-width: 760px) { .risk-k { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.expo { margin-bottom: 14px; }
.expo-k { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 10px; }
@media (max-width: 760px) { .expo-k { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.expo-list { display: grid; gap: 2px; margin-top: 14px; }
.expo-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 2fr) 92px 56px minmax(0, 1fr); gap: 10px; align-items: center;
  font-size: 13.5px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.expo-row:last-child { border-bottom: 0; }
.expo-row b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.expo-row .bar { margin-top: 0; }
.expo-row > span { text-align: right; white-space: nowrap; }
@media (max-width: 640px) { .expo-row { grid-template-columns: minmax(0, 1fr) 84px 50px; } .expo-row .bar, .expo-row > span:last-child { display: none; } }
.psort { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; margin: 0 0 10px; }
.psort label { font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; }
.psort select { font: 13.5px var(--f-body); color: var(--ink); background: var(--surface); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 8px; max-width: 100%; }
.side.LONG { background: var(--up-soft); color: var(--up); } .side.SHORT { background: var(--down-soft); color: var(--down); }

.prog { height: 8px; background: var(--sunk); border-radius: 4px; overflow: hidden; }
.prog i { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
.status { font-size: 12.5px; padding: 3px 8px; border-radius: 6px; display: inline-block; }
.status.ok { background: var(--up-soft); color: var(--up); } .status.wait { background: var(--sunk); color: var(--muted); }

.feed { display: grid; gap: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
.ev { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.ev:last-child { border-bottom: 0; }
.ev time { font: 12.5px/1.4 var(--f-num); color: var(--muted); }
.kind { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 5px; margin-right: 6px; }
.kind.out { background: var(--down-soft); color: var(--down); } .kind.in { background: var(--up-soft); color: var(--up); }
.kind.other { background: var(--sunk); color: var(--muted); }
.ev p { margin: 4px 0 0; font-size: 13.5px; color: var(--muted); }

.empty { padding: 28px 16px; text-align: center; color: var(--muted); background: var(--surface); border: 1px dashed var(--line); border-radius: 10px; }
.login { max-width: 420px; margin: 12vh auto; display: grid; gap: 12px; }
.login input { font: 15px var(--f-num); padding: 11px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); width: 100%; }
.login .err { color: var(--down); font-size: 13.5px; min-height: 1.2em; }
h2 { font: 600 17px/1.2 var(--f-display); margin: 0; }
footer { color: var(--muted); font-size: 12.5px; padding-block: 0 30px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  "use strict";
  var KEY = "hlpanel-key", RANGE = "hlpanel-range", TAB = "hlpanel-tab";
  var key = store(KEY), data = null, timer = null;
  var range = store(RANGE) || "7g", tab = store(TAB) || "traders", PSORT = "hlpanel-psort", psort = store(PSORT) || "size";
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function forget(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function usd(x, sign) {
    if (x == null || isNaN(x)) return "–";
    var a = Math.abs(x), s = x < 0 ? "−" : (sign && x > 0 ? "+" : "");
    var d = a >= 1e6 ? (a / 1e6).toLocaleString("tr-TR", { maximumFractionDigits: 2 }) + " M" :
            a >= 1e4 ? (a / 1e3).toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + " B" :
            a.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return s + d + " $";
  }
  function pct(x, digits) {
    if (x == null || isNaN(x)) return "–";
    var s = x > 0 ? "+" : x < 0 ? "−" : "";
    return s + "%" + Math.abs(x * 100).toLocaleString("tr-TR", { minimumFractionDigits: digits == null ? 1 : digits, maximumFractionDigits: digits == null ? 1 : digits });
  }
  function cls(x) { return x > 0.00005 ? "up" : x < -0.00005 ? "down" : "flat"; }
  function px(x) { if (!x) return "–"; return x >= 1000 ? x.toLocaleString("tr-TR", { maximumFractionDigits: 1 }) : x >= 1 ? x.toLocaleString("tr-TR", { maximumFractionDigits: 3 }) : x.toPrecision(4); }
  function when(iso) { if (!iso) return "–"; var d = new Date(iso); return d.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  function ago(iso) {
    if (!iso) return null; var m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? "az önce" : m < 60 ? m + " dk önce" : m < 1440 ? Math.round(m / 60) + " saat önce" : Math.round(m / 1440) + " gün önce";
  }
  function days(iso) { return iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 864e5) : 0; }
  function hd(a) { return "https://hyperdash.com/address/" + a; }

  function login(msg) {
    clearInterval(timer);
    el("app").innerHTML = '<div class="wrap"><form class="login panel" id="lf">' +
      '<div class="brand">Kopya Portföy Paneli<small>Hyperliquid takip botunun sanal portföyü</small></div>' +
      '<label for="kin" class="muted">Panel anahtarı (Cloudflare\'deki PANEL_KEY)</label>' +
      '<input id="kin" type="password" autocomplete="current-password" required>' +
      '<div class="err" id="lerr">' + esc(msg || "") + '</div>' +
      '<button class="btn" type="submit">Aç</button>' +
      '<div class="note">Anahtar yalnızca bu tarayıcıda saklanır.</div></form></div>';
    el("lf").addEventListener("submit", function (e) { e.preventDefault(); key = el("kin").value.trim(); store(KEY, key); load(true); });
    el("kin").focus();
  }

  function load(first) {
    if (!key) return login();
    fetch("/panel/data", { headers: { "x-panel-key": key }, cache: "no-store" }).then(function (r) {
      return r.json().then(function (j) { return { s: r.status, j: j }; });
    }).then(function (res) {
      if (res.s === 403) { forget(KEY); key = null; return login(res.j.error); }
      if (res.s !== 200) { if (first || !data) { el("app").innerHTML = '<div class="wrap"><div class="empty" style="margin-top:12vh">' + esc(res.j.error) + '</div></div>'; } return; }
      data = res.j; render();
      clearInterval(timer); timer = setInterval(function () { if (!document.hidden) load(false); }, 60000);
    }).catch(function () { if (!data) el("app").innerHTML = '<div class="wrap"><div class="empty" style="margin-top:12vh">Bağlantı kurulamadı. İnterneti kontrol edip sayfayı yenile.</div></div>'; });
  }

  function render() {
    var d = data, s = d.summary, m = d.meta;
    var lr = m.last_run, mins = lr ? (Date.now() - Date.parse(lr)) / 60000 : 1e9;
    var dot = mins < 15 ? "" : mins < 90 ? " stale" : " dead";
    var tabs = [["traders", "Trader'lar", d.traders.length], ["positions", "Açık pozisyonlar", d.traders.reduce(function (t, x) { return t + x.positions.length; }, 0)],
                ["bench", "Gözlem", d.bench.length], ["changes", "Değişiklikler", d.changes.length], ["cands", "Adaylar", d.candidates ? (d.candidates.n_ranked || 0) : 0]];
    var h = '<header class="top"><div class="wrap"><div class="brand">Kopya Portföy Paneli<small>' + m.slots + ' ana kopya yeri · her biri ' + usd(m.per_slot) + ' · kaldıraç sınırı ' + m.max_leverage + 'x</small></div>' +
      '<div class="spacer"></div><div class="fresh"><span class="dot' + dot + '"></span>Bot ' + (ago(lr) || "henüz çalışmadı") +
      '<span class="hide-sm"><br><span class="num">' + when(lr) + '</span></span></div><button class="btn" id="rf" title="Yenile">Yenile</button></div></header>';
    h += '<main class="wrap">';
    // Özet
    h += '<section class="hero"><div class="panel"><div class="eyebrow">Sanal portföy</div>' +
      '<div class="big">' + usd(s.equity) + '</div><div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<span class="pill ' + cls(s.ret) + '">' + pct(s.ret, 2) + ' toplam</span>' +
      (s.week_ret == null ? "" : '<span class="pill ' + cls(s.week_ret) + '">' + pct(s.week_ret, 2) + ' bu hafta</span>') + '</div>' +
      '<div class="kpis">' + kpi("Sermaye", usd(s.capital)) + kpi("En büyük düşüş", pct(-s.mdd, 1), s.mdd > 0 ? "down" : "") +
      kpi("Gerçekleşen", usd(s.realized, true), cls(s.realized)) + kpi("Açık pozisyonlar", usd(s.upnl, true), cls(s.upnl)) +
      kpi("Ücret + kayma", usd(-s.fees), s.fees > 0 ? "down" : "") + kpi("Fonlama", usd(-s.funding, true), cls(-s.funding)) +
      kpi("Çıkarılanların sonucu", usd(s.closed_pnl, true), cls(s.closed_pnl)) + kpi("Kopyalama farkı", gapText(), gapCls()) +
      '</div><div class="note">Başlangıç ' + esc(String(m.started || "").slice(0, 10)) + (m.free ? ' · ' + m.free + ' boş yer nakit bekliyor' : '') +
      ' · fiyatlar anlık, son işlemler birkaç dakika gecikmeli.</div>' + delayNote(s.delay) + '</div>';
    h += '<div class="panel"><div class="chart-head"><div><div class="eyebrow">Portföy getirisi</div><h2 id="ctitle"></h2></div><div class="seg" role="group" aria-label="Zaman aralığı">' +
      ["24s", "7g", "30g", "Tümü"].map(function (r) { return '<button data-r="' + r + '" aria-pressed="' + (r === range) + '">' + r + '</button>'; }).join("") +
      '</div></div><div class="legend" id="clegend"></div><div id="chart"></div></div></section>';
    h += riskPanel();
    // Sekmeler
    h += '<nav class="tabs" role="tablist">' + tabs.map(function (t) {
      return '<button role="tab" data-t="' + t[0] + '" aria-selected="' + (t[0] === tab) + '">' + t[1] + '<span class="count">' + t[2] + '</span></button>'; }).join("") + '</nav>';
    h += '<section id="tabbody"></section>';
    h += '</main><footer class="wrap">Simülasyondur, yatırım tavsiyesi değildir. Veriler botun GitHub deposundaki kayıtlarından ve Hyperliquid\'in anlık fiyatlarından gelir.</footer>';
    var y = window.scrollY;
    el("app").innerHTML = h;
    window.scrollTo(0, y);
    el("rf").onclick = function () { load(false); };
    Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (b) { b.onclick = function () { range = b.getAttribute("data-r"); store(RANGE, range); render(); }; });
    Array.prototype.forEach.call(document.querySelectorAll("nav.tabs button"), function (b) { b.onclick = function () { tab = b.getAttribute("data-t"); store(TAB, tab); render(); }; });
    chart();
    el("tabbody").innerHTML = ({ traders: traders, positions: positions, bench: bench, changes: changes, cands: cands })[tab]();
    bindSort();
  }
  function bindSort() {
    var s = el("psort");
    if (s) s.onchange = function () { psort = s.value; store(PSORT, psort); el("tabbody").innerHTML = positions(); bindSort(); };
  }

  // Risk ölçümleri: zincirleme getiri endeksinin günlük değerlerinden (sermaye değişimleri hariç)
  function riskStats() {
    var all = returnSeries(), byDay = {}, keys = [];
    all.forEach(function (p) {
      var k = new Date(p[0]).toLocaleDateString("sv-SE", { timeZone: "Europe/Istanbul" });
      if (!(k in byDay)) keys.push(k);
      byDay[k] = p;
    });
    var d = keys.map(function (k) { return byDay[k]; });
    if (d.length < 8) return { days: d.length };
    var r = [], b = [];
    for (var i = 1; i < d.length; i++) {
      r.push(d[i][1] / d[i - 1][1] - 1);
      b.push(d[i][3] && d[i - 1][3] ? d[i][3] / d[i - 1][3] - 1 : null);
    }
    function mean(a) { return a.reduce(function (t, x) { return t + x; }, 0) / a.length; }
    function sd(a) { var m = mean(a); return Math.sqrt(a.reduce(function (t, x) { return t + (x - m) * (x - m); }, 0) / (a.length - 1)); }
    var m = mean(r), s = sd(r), down = Math.sqrt(mean(r.map(function (x) { return Math.min(0, x) * Math.min(0, x); })));
    var pr = [], pb = [];
    r.forEach(function (x, i) { if (b[i] != null) { pr.push(x); pb.push(b[i]); } });
    var corr = null, beta = null;
    if (pr.length >= 7) {
      var mr = mean(pr), mb = mean(pb), cov = 0, vb = 0, vr = 0;
      for (var j = 0; j < pr.length; j++) { cov += (pr[j] - mr) * (pb[j] - mb); vb += (pb[j] - mb) * (pb[j] - mb); vr += (pr[j] - mr) * (pr[j] - mr); }
      if (vb > 0 && vr > 0) { corr = cov / Math.sqrt(vb * vr); beta = cov / vb; }
    }
    var ann = Math.sqrt(365);
    return { days: d.length, vol: s * ann, sharpe: s > 0 ? m / s * ann : null, sortino: down > 0 ? m / down * ann : null,
             worst: Math.min.apply(null, r), best: Math.max.apply(null, r), corr: corr, beta: beta };
  }
  function num(x, d) { return x == null || isNaN(x) ? "–" : (x < 0 ? "−" : "") + Math.abs(x).toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function riskPanel() {
    var r = riskStats();
    var h = '<section class="panel"><div class="chart-head"><div><div class="eyebrow">Risk ölçümleri</div>' +
      '<div class="muted" style="font-size:12.5px">Günlük getirilerden, yıllığa çevrilmiş · ' + r.days + ' günlük veri</div></div></div>';
    if (r.days < 8) return h + '<div class="note">En az 8 günlük veri gerekiyor; ölçümler birkaç gün içinde görünecek.</div></section>';
    h += '<div class="kpis risk-k">' + kpi("Oynaklık (yıllık)", pct(r.vol, 1).replace("+", "")) + kpi("Sharpe", num(r.sharpe, 2), cls(r.sharpe || 0)) +
      kpi("Sortino", num(r.sortino, 2), cls(r.sortino || 0)) + kpi("En büyük düşüş", pct(-data.summary.mdd, 1), data.summary.mdd > 0 ? "down" : "") +
      kpi("En kötü gün", pct(r.worst, 2), cls(r.worst)) + kpi("En iyi gün", pct(r.best, 2), cls(r.best)) +
      kpi("BTC ile korelasyon", num(r.corr, 2)) + kpi("BTC betası", num(r.beta, 2)) + '</div>';
    h += '<div class="note">' + (r.days < 30 ? '⚠️ 30 günden kısa veriyle bu oranlar çok oynaktır; karar için en az 2–3 ay beklemek gerekir. ' : '') +
      'Korelasyon 1\'e yakınsa portföy BTC ile birlikte hareket ediyor demektir; beta, BTC %1 oynadığında portföyün ortalama ne kadar oynadığını gösterir.</div></section>';
    return h;
  }

  function gap() {
    var p = data.traders.filter(function (t) { return t.metrics && t.metrics.trader_ret_since != null; });
    if (!p.length) return null;
    var tr = p.reduce(function (s, t) { return s + t.metrics.trader_ret_since; }, 0) / p.length;
    var cp = p.reduce(function (s, t) { return s + t.ret; }, 0) / p.length;
    return { n: p.length, trader: tr, copy: cp, diff: cp - tr };
  }
  function bps(d) { return d && d.ntl ? -d.cost / d.ntl * 1e4 : 0; }
  function delayNote(d) {
    if (!d || !d.n) return '<div class="note">Gecikme etkisi: kopyalanan ilk işlemlerden sonra trader\'ların gerçek fiyatlarıyla ölçülecek.</div>';
    var b = bps(d);
    return '<div class="note">Gecikme etkisi (trader\'ların gerçek işlem fiyatına göre, ' + d.n + ' işlem): <span class="num ' + cls(-d.cost) + '">' +
      usd(-d.cost, true) + ' · ' + (b > 0 ? "+" : b < 0 ? "−" : "") + Math.abs(b).toFixed(0) + ' bps</span></div>';
  }
  function gapText() { var g = gap(); return g ? pct(g.diff, 2) : "ölçülüyor"; }
  function gapCls() { var g = gap(); return g ? cls(g.diff) : ""; }
  function kpi(k, v, c) { return '<div class="kpi"><div class="k">' + k + '</div><div class="v ' + (c || "") + '">' + v + '</div></div>'; }

  // Getiri serisi: sermaye değişiklikleri (trader ekleme/çıkarma) kazanç sayılmasın diye zincirleme hesaplanır
  function returnSeries() {
    var raw = data.history.map(function (p) { return [Date.parse(p[0]), p[1], p.length > 2 ? p[2] : null, p.length > 3 ? p[3] : null,
                                                     p.length > 4 ? p[4] : null, p.length > 5 ? p[5] : null]; });
    raw.push([Date.now(), data.summary.equity, data.summary.capital, data.summary.btc, data.summary.ndx, data.summary.gold]);
    var out = [], idx = 1;
    for (var i = 0; i < raw.length; i++) {
      if (i > 0) {
        var a = raw[i - 1], b = raw[i], r;
        if (a[2] != null && b[2] != null) r = (b[1] - (b[2] - a[2])) / a[1] - 1;     // sermaye farkını düş
        else { r = b[1] / a[1] - 1; if (Math.abs(r) > 0.08) r = 0; }                 // eski kayıtlar: ani sıçrama = sermaye değişimi
        idx *= 1 + r;
      }
      out.push([raw[i][0], idx, raw[i][1], raw[i][3], raw[i][4], raw[i][5]]);
    }
    return out;
  }

  // Karşılaştırma çizgileri: veri dizisindeki sütun, ad, renk (lejanttan açılıp kapatılabilir)
  var BENCHES = [{ k: 3, id: "btc", name: "BTC", col: "var(--c-btc)", dash: "2 3" },
                 { k: 4, id: "ndx", name: "Nasdaq", col: "var(--c-ndx)", dash: "6 3" },
                 { k: 5, id: "gold", name: "Altın", col: "var(--c-gold)", dash: "1 2" }];
  var BKEY = "hlpanel-bench", shown = (function () { try { return JSON.parse(store(BKEY) || "null"); } catch (e) { return null; } })() || { btc: 1, ndx: 1, gold: 1 };
  function chart() {
    var box = el("chart"), all = returnSeries();
    var span = { "24s": 864e5, "7g": 7 * 864e5, "30g": 30 * 864e5 }[range];
    var pts = span ? all.filter(function (p) { return p[0] >= Date.now() - span; }) : all;
    if (pts.length < 2) pts = all.slice(-2);
    var base = pts[0][1];
    // her ölçüt, seçili aralıkta ilk değeri olan noktadan başlar (%0)
    var b0 = BENCHES.map(function (b) { var f = pts.filter(function (p) { return p[b.k]; }); return f.length ? f[0][b.k] : null; });
    pts = pts.map(function (p) {
      return [p[0], p[1] / base - 1, p[2]].concat(BENCHES.map(function (b, i) { return p[b.k] && b0[i] ? p[b.k] / b0[i] - 1 : null; }));
    });
    var last = pts[pts.length - 1][1];
    var series = BENCHES.map(function (b, i) {
      var f = pts.filter(function (p) { return p[3 + i] != null; });
      return { b: b, i: i, pts: f, on: !!shown[b.id] && f.length > 1, last: f.length ? f[f.length - 1][3 + i] : null };
    });
    el("ctitle").innerHTML = '<span class="num ' + cls(last) + '">' + pct(last, 2) + '</span> <span class="muted" style="font:400 13px var(--f-body)">seçili aralıkta</span>';
    el("clegend").innerHTML = '<span class="lg"><i style="background:' + (last >= 0 ? "var(--up)" : "var(--down)") + '"></i>Portföy <b class="num ' + cls(last) + '">' + pct(last, 2) + '</b></span>' +
      series.map(function (s) {
        return '<button class="lg" data-b="' + s.b.id + '" aria-pressed="' + s.on + '"' + (s.pts.length > 1 ? '' : ' disabled title="Veri henüz yok"') + '>' +
          '<i class="dash" style="border-color:' + s.b.col + '"></i>' + s.b.name + ' <b class="num">' + (s.last == null || s.pts.length < 2 ? "–" : pct(s.last, 2)) + '</b></button>';
      }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("#clegend button"), function (btn) {
      btn.onclick = function () { var id = btn.getAttribute("data-b"); shown[id] = shown[id] ? 0 : 1; store(BKEY, JSON.stringify(shown)); chart(); };
    });
    var W = box.clientWidth || 600, H = box.clientHeight || 250, L = 8, R = 58, T = 12, B = 26;
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    series.forEach(function (s) { if (s.on) ys = ys.concat(s.pts.map(function (p) { return p[3 + s.i]; })); });
    var y0 = Math.min.apply(null, ys.concat([0])), y1 = Math.max.apply(null, ys.concat([0]));
    var pad = (y1 - y0) * 0.15 || 0.002; y0 -= pad; y1 += pad;
    var x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
    function X(t) { return L + (t - x0) / (x1 - x0) * (W - L - R); }
    function Y(v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); }
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1); }).join(" ");
    var zero = Y(0);
    var blines = series.filter(function (s) { return s.on; }).map(function (s) {
      var d = s.pts.map(function (p, i) { return (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[3 + s.i]).toFixed(1); }).join(" ");
      return '<path d="' + d + '" fill="none" stroke="' + s.b.col + '" stroke-width="1.5" stroke-dasharray="' + s.b.dash + '" opacity="0.9"/>';
    }).join("");
    var area = line + " L" + X(x1).toFixed(1) + " " + zero.toFixed(1) + " L" + X(x0).toFixed(1) + " " + zero.toFixed(1) + " Z";
    var col = last >= 0 ? "var(--up)" : "var(--down)";
    var ticks = 4, g = "";
    for (var i = 0; i <= ticks; i++) { var v = y0 + (y1 - y0) * i / ticks, yy = Y(v);
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--line)" stroke-width="1"/>' +
           '<text x="' + (W - R + 8) + '" y="' + (yy + 4) + '" fill="var(--muted)" font-size="11" font-family="IBM Plex Mono, monospace">' + pct(v, Math.abs(y1 - y0) < 0.02 ? 2 : 1) + '</text>'; }
    var xt = "", n = W < 500 ? 3 : 4;
    for (var j = 0; j <= n; j++) { var t = x0 + (x1 - x0) * j / n, lbl = new Date(t).toLocaleString("tr-TR", (x1 - x0) <= 2 * 864e5 ? { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" } : { day: "2-digit", month: "2-digit", timeZone: "Europe/Istanbul" });
      xt += '<text x="' + X(t) + '" y="' + (H - 7) + '" fill="var(--muted)" font-size="11" text-anchor="' + (j === 0 ? "start" : j === n ? "end" : "middle") + '" font-family="IBM Plex Mono, monospace">' + lbl + '</text>'; }
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Portföy getirisi grafiği, BTC, Nasdaq ve altınla karşılaştırmalı">' +
      '<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + col + '" stop-opacity="0.22"/><stop offset="1" stop-color="' + col + '" stop-opacity="0.02"/></linearGradient></defs>' +
      g + '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + zero + '" y2="' + zero + '" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="1"/>' +
      '<path d="' + area + '" fill="url(#ga)"/>' + blines +
      '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="' + X(xs[xs.length - 1]) + '" cy="' + Y(last) + '" r="4" fill="' + col + '"/>' + xt +
      '<line id="cx" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-width="1" visibility="hidden"/></svg><div class="tip" id="ctip" hidden></div>';
    var svg = box.querySelector("svg"), tip = el("ctip"), cx = el("cx");
    function move(ev) {
      var r = svg.getBoundingClientRect(), mx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * W / r.width;
      var best = 0; for (var k = 1; k < pts.length; k++) if (Math.abs(X(pts[k][0]) - mx) < Math.abs(X(pts[best][0]) - mx)) best = k;
      var p = pts[best], px_ = X(p[0]); cx.setAttribute("x1", px_); cx.setAttribute("x2", px_); cx.setAttribute("visibility", "visible");
      tip.hidden = false; tip.style.top = (Y(p[1]) * r.height / H) + "px";
      tip.innerHTML = esc(when(new Date(p[0]).toISOString())) + " · portföy " + pct(p[1], 2) + " (" + usd(p[2]) + ")" +
        series.filter(function (s) { return s.on && p[3 + s.i] != null; }).map(function (s) { return "<br>" + s.b.name + " " + pct(p[3 + s.i], 2); }).join("");
      var half = tip.offsetWidth / 2 + 4;   // ipucu kutusu grafiğin dışına taşmasın
      tip.style.left = Math.min(Math.max(px_ * r.width / W, half), Math.max(half, r.width - half)) + "px";
    }
    function out() { tip.hidden = true; cx.setAttribute("visibility", "hidden"); }
    svg.addEventListener("mousemove", move); svg.addEventListener("touchmove", move, { passive: true });
    svg.addEventListener("mouseleave", out); svg.addEventListener("touchend", out);
  }

  function retBar(r) {
    var w = Math.min(50, Math.abs(r) * 250);   // ±%20 tam genişlik
    return '<div class="bar"><i style="' + (r >= 0 ? "left:50%;width:" + w + "%;background:var(--up)" : "right:50%;width:" + w + "%;background:var(--down)") + '"></i>' +
      '<i style="left:50%;width:1px;background:var(--line)"></i></div>';
  }
  function posTable(list) {
    if (!list.length) return '<div class="muted" style="font-size:13.5px">Açık sanal pozisyon yok.</div>';
    return '<div class="tbl-wrap"><table><thead><tr><th>Varlık</th><th>Yön</th><th class="r">Büyüklük</th><th class="r">Giriş</th><th class="r">Şimdi</th><th class="r">Kâr/zarar</th></tr></thead><tbody>' +
      list.map(function (p) { return '<tr><td><b>' + esc(p.coin) + '</b></td><td><span class="side ' + p.side + '">' + p.side + '</span></td><td class="r num">' + usd(p.value) +
        '</td><td class="r num">' + px(p.entry) + '</td><td class="r num">' + px(p.mark) + '</td><td class="r num ' + cls(p.pnl) + '">' + usd(p.pnl, true) + ' <span class="muted">' + pct(p.pnl_pct) + '</span></td></tr>'; }).join("") +
      '</tbody></table></div>';
  }
  function facts(t) {
    var m = t.metrics, f = [];
    if (t.since) f.push('Listede <b>' + Math.floor(days(t.since)) + ' gün</b>');
    if (t.trader_equity != null) f.push('Trader hesabı <b>' + usd(t.trader_equity) + '</b>');
    f.push('Gerçekleşen <b>' + usd(t.realized, true) + '</b>'); f.push('Ücret <b>' + usd(-t.fees) + '</b>');
    if (t.funding) f.push('Fonlama <b class="' + cls(-t.funding) + '">' + usd(-t.funding, true) + '</b>');
    if (t.delay && t.delay.n) { var db = bps(t.delay);
      f.push('Gecikme etkisi <b class="' + cls(-t.delay.cost) + '">' + usd(-t.delay.cost, true) + ' (' + (db > 0 ? "+" : db < 0 ? "−" : "") + Math.abs(db).toFixed(0) + ' bps, ' + t.delay.n + ' işlem)</b>'); }
    if (m && m.trader_ret_since != null) {
      f.push('Trader\'ın kendi getirisi (bu listede) <b class="' + cls(m.trader_ret_since) + '">' + pct(m.trader_ret_since, 2) + '</b>');
      f.push('Kopyalama farkı <b class="' + cls(t.ret - m.trader_ret_since) + '">' + pct(t.ret - m.trader_ret_since, 2) + '</b>');
    }
    if (m) {
      if (m.hold_h != null) f.push('Pozisyon süresi <b>' + (m.hold_h < 48 ? Math.round(m.hold_h) + " sa" : Math.round(m.hold_h / 24) + " gün") + '</b>');
      if (m.ret_window != null) f.push('Hesabı son ' + m.window_days + ' gün <b class="' + cls(m.ret_window) + '">' + pct(m.ret_window) + '</b>');
      if (m.ret_365 != null) f.push('Son 12 ay <b class="' + cls(m.ret_365) + '">' + pct(m.ret_365) + '</b>');
      if (m.sharpe != null) f.push('Sharpe (12 ay) <b>' + num(m.sharpe, 2) + '</b>');
      if (m.profitable_share != null) f.push('Kârlı ay <b>%' + Math.round(m.profitable_share * 100) + '</b>');
      if (m.worst_month != null) f.push('En kötü ay <b class="down">' + pct(m.worst_month) + '</b>');
      if (m.dd_now != null) f.push('Zirveden düşüş <b>' + pct(-m.dd_now) + '</b>');
    }
    return '<div class="facts">' + f.join("") + '</div>';
  }
  function traderRows(list, shadow) {
    return '<div class="list">' + list.map(function (t) {
      var g = t.metrics && t.metrics.group;
      var tags = (g ? '<span class="tag grp-' + (g === "çekirdek" ? "core" : g === "geniş" ? "wide" : "out") + '" title="Risk grubu">' + g.toLocaleUpperCase("tr-TR") + '</span>' : "") +
        (t.source === "auto" ? '<span class="tag auto">OTO</span>' : "") + (t.pin ? '<span class="tag pin">SABİT</span>' : "");
      var style = t.metrics && t.metrics.style ? t.metrics.style : "–";
      var right = shadow ? statusOf(t) : '<span class="k">İşlem</span><span class="v">' + t.trades + (t.skipped ? ' <span class="muted">· ' + t.skipped + ' atlanan</span>' : '') + '</span>';
      return '<details class="row"><summary><div class="who"><b>' + esc(t.label) + tags + '</b><span>' + style + ' · ' + t.positions.length + ' açık pozisyon</span></div>' +
        '<div class="cell hide-sm"><span class="k">' + (shadow ? "Gölge değer" : "Alt portföy") + '</span><span class="v">' + usd(t.equity) + '</span></div>' +
        '<div class="cell"><span class="k">Getiri</span><span class="v ' + cls(t.ret) + '">' + pct(t.ret, 2) + '</span>' + retBar(t.ret) + '</div>' +
        '<div class="cell hide-sm">' + right + '</div><span class="chev" aria-hidden="true">›</span></summary>' +
        '<div class="detail">' + facts(t) + posTable(t.positions) + '<div><a href="' + hd(t.a) + '" target="_blank" rel="noopener">Hyperdash\'te aç ↗</a> <span class="muted num" style="font-size:12px;margin-left:8px">' + t.a + '</span></div></div></details>';
    }).join("") + '</div>';
  }
  function statusOf(t) {
    var dd = days(t.since), ready = dd >= 42 && t.ret >= 0.05;
    return '<span class="k">Geri dönüş</span>' + (ready ? '<span class="status ok">Şartları yakın</span>' :
      '<span class="status wait">' + (dd < 42 ? Math.floor(dd) + '/42 gün' : 'gölge ' + pct(t.ret) + ' (gereken +%5)') + '</span>');
  }
  function traders() {
    if (!data.traders.length) return '<div class="empty">Ana kopyada trader yok.</div>';
    var c = { "çekirdek": 0, "geniş": 0, "dışında": 0 };
    data.traders.forEach(function (t) { var g = t.metrics && t.metrics.group; if (g) c[g]++; });
    return '<div class="note" style="margin:0 0 10px">Risk grupları: <b>' + c["çekirdek"] + '</b> çekirdek · <b>' + c["geniş"] + '</b> geniş (yüksek risk) · <b>' +
      c["dışında"] + '</b> kuralların dışında. Yeni adaylar Sharpe oranına göre seçilir; çekirdek dışından ana kopyada en fazla ' + data.meta.max_wide + ' trader olur.</div>' +
      traderRows(data.traders, false);
  }
  function bench() {
    if (!data.bench.length) return '<div class="empty">Gözlem listesi boş.</div>';
    return '<div class="note" style="margin:0 0 10px">Gölge portföy: bu trader\'lar kopyalansaydı ne olurdu. Ana portföye katılmaz. Geri dönüş için en az 42 gün gözlem, gölge portföy +%5 üstü ve risk işareti olmaması gerekir; son kararı bot her sabah verir.</div>' + traderRows(data.bench, true);
  }
  function positions() {
    var all = [];
    data.traders.forEach(function (t) { t.positions.forEach(function (p) { all.push([t, p]); }); });
    if (!all.length) return '<div class="empty">Ana portföyde açık sanal pozisyon yok.</div>';
    var sorts = { size: ["Büyüklük (büyükten küçüğe)", function (a, b) { return b[1].value - a[1].value; }],
                  pnl_asc: ["Kâr/zarar $ (küçükten büyüğe)", function (a, b) { return a[1].pnl - b[1].pnl; }],
                  pnl_desc: ["Kâr/zarar $ (büyükten küçüğe)", function (a, b) { return b[1].pnl - a[1].pnl; }],
                  pct_asc: ["Kâr/zarar % (küçükten büyüğe)", function (a, b) { return a[1].pnl_pct - b[1].pnl_pct; }],
                  pct_desc: ["Kâr/zarar % (büyükten küçüğe)", function (a, b) { return b[1].pnl_pct - a[1].pnl_pct; }] };
    if (!sorts[psort]) psort = "size";
    all.sort(sorts[psort][1]);
    var gross = all.reduce(function (s, x) { return s + x[1].value; }, 0), net = all.reduce(function (s, x) { return s + x[1].pnl; }, 0);
    return exposure(all) + '<div class="psort"><div class="note" style="margin:0">Toplam ' + all.length + ' pozisyon · büyüklük <span class="num">' + usd(gross) + '</span> · açık kâr/zarar <span class="num ' + cls(net) + '">' + usd(net, true) + '</span></div>' +
      '<label class="muted">Sırala <select id="psort">' + Object.keys(sorts).map(function (k) {
        return '<option value="' + k + '"' + (k === psort ? ' selected' : '') + '>' + sorts[k][0] + '</option>'; }).join("") + '</select></label></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Trader</th><th>Varlık</th><th>Yön</th><th class="r">Büyüklük</th><th class="r">Giriş</th><th class="r">Şimdi</th><th class="r">Kâr/zarar</th></tr></thead><tbody>' +
      all.map(function (x) { var t = x[0], p = x[1]; return '<tr><td>' + esc(t.label) + '</td><td><b>' + esc(p.coin) + '</b></td><td><span class="side ' + p.side + '">' + p.side + '</span></td><td class="r num">' + usd(p.value) +
        '</td><td class="r num">' + px(p.entry) + '</td><td class="r num">' + px(p.mark) + '</td><td class="r num ' + cls(p.pnl) + '">' + usd(p.pnl, true) + ' <span class="muted">' + pct(p.pnl_pct) + '</span></td></tr>'; }).join("") +
      '</tbody></table></div>';
  }
  // Yoğunlaşma: aynı varlıkta toplanan net pozisyon (farklı trader'lar aynı bahiste mi?)
  function exposure(all) {
    var eq = data.summary.equity || 1, by = {}, gross = 0, net = 0, xyz = 0;
    all.forEach(function (x) {
      var t = x[0], p = x[1], v = p.side === "LONG" ? p.value : -p.value;
      var k = (p.xyz ? "xyz:" : "") + p.coin;
      var b = by[k] || (by[k] = { coin: p.coin, xyz: p.xyz, net: 0, gross: 0, long: {}, short: {} });
      b.net += v; b.gross += p.value; b[p.side === "LONG" ? "long" : "short"][t.a] = 1;
      gross += p.value; net += v; if (p.xyz) xyz += p.value;
    });
    var rows = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return Math.abs(b.net) - Math.abs(a.net); });
    var maxAbs = rows.length ? Math.abs(rows[0].net) : 1, LIM = 0.10;
    var hot = rows.filter(function (r) { return Math.abs(r.net) / eq > LIM; });
    var crowd = rows.filter(function (r) { return Object.keys(r.long).length + Object.keys(r.short).length > 1; });
    // Zıt yönde pozisyonlar: bir trader long, diğeri short; portföy açısından birbirini götürür ama iki taraf da ücret öder
    var opp = rows.filter(function (r) { return Object.keys(r.long).length && Object.keys(r.short).length; });
    var off = rows.reduce(function (t, r) { return t + (r.gross - Math.abs(r.net)); }, 0);
    var h = '<div class="panel expo"><div class="eyebrow">Yoğunlaşma</div>' +
      '<div class="kpis expo-k">' +
      kpi("Toplam pozisyon", usd(gross) + ' <span class="muted">· portföyün ' + pct(gross / eq, 0).replace("+", "") + '</span>') +
      kpi("Net yön", usd(net, true) + ' <span class="muted">' + (net < 0 ? "short" : "long") + '</span>', net < 0 ? "down" : "up") +
      kpi("Hisse ve endeks kontratları", pct(gross ? xyz / gross : 0, 0).replace("+", "") + ' <span class="muted">toplamın</span>') +
      kpi("Birbirini götüren pozisyon", usd(off) + ' <span class="muted">· ' + opp.length + ' varlık</span>') + '</div>';
    h += '<div class="expo-list">' + rows.slice(0, 8).map(function (r) {
      var w = Math.max(2, Math.abs(r.net) / maxAbs * 50), nl = Object.keys(r.long).length, ns = Object.keys(r.short).length;
      return '<div class="expo-row"><b>' + esc(r.coin) + (r.xyz ? ' <span class="tag">hisse/endeks</span>' : '') + '</b>' +
        '<div class="bar"><i style="' + (r.net >= 0 ? "left:50%;width:" + w + "%;background:var(--up)" : "right:50%;width:" + w + "%;background:var(--down)") + '"></i><i style="left:50%;width:1px;background:var(--line)"></i></div>' +
        '<span class="num ' + cls(r.net) + '">' + usd(r.net, true) + '</span>' +
        '<span class="muted num">' + pct(Math.abs(r.net) / eq, 1).replace("+", "") + '</span>' +
        '<span class="muted">' + (nl ? nl + ' long' : '') + (nl && ns ? ' · ' : '') + (ns ? ns + ' short' : '') + '</span></div>';
    }).join("") + '</div>';
    h += '<div class="note">' + (hot.length ? '⚠️ ' + hot.map(function (r) { return esc(r.coin); }).join(", ") + ': net pozisyon portföyün %10\'unu aşıyor. ' : 'Hiçbir varlıkta net pozisyon portföyün %10\'unu aşmıyor. ') +
      crowd.length + ' varlıkta birden çok trader var. Yüzdeler portföy değerine göre; aynı yöndeki trader\'lar aynı riski taşır, zıt yöndekiler birbirini götürür (ama iki taraf da ücret öder).</div></div>';
    return h;
  }
  function changes() {
    var names = { risk: ["Gözleme alındı · risk", "out"], perf: ["Gözleme alındı · performans", "out"], quality: ["Gözleme alındı · kalite (Sharpe)", "out"], swap: ["Yer değiştirdi · çıktı", "out"],
      "swap-in": ["Yer değiştirdi · girdi", "in"], promote: ["Gözlemden geri döndü", "in"], "new": ["Yeni aday · ana kopya", "in"],
      manual: ["Elle değiştirildi", "other"], remove: ["Listeden silindi", "out"] };
    var why = {};
    data.closed.forEach(function (c) { why[c.a + "|" + String(c.to).slice(0, 16)] = c; });
    if (!data.changes.length) return '<div class="empty">Henüz kadro değişikliği yok.</div>';
    return '<div class="feed">' + data.changes.map(function (c) {
      var n = names[c.kind] || [c.kind, "other"], w = why[c.a + "|" + String(c.t).slice(0, 16)];
      return '<div class="ev"><time>' + when(c.t) + '</time><div><span class="kind ' + n[1] + '">' + n[0] + '</span><a href="' + hd(c.a) + '" target="_blank" rel="noopener"><b>' + esc(c.label || c.a.slice(0, 8)) + '</b></a>' +
        (w ? '<p>' + esc(w.why) + '<br>Kopya sonucu: <span class="num ' + cls(w.pnl) + '">' + usd(w.pnl, true) + ' (' + pct(w.ret) + ')</span></p>' : '') + '</div></div>';
    }).join("") + '</div>';
  }
  function cands() {
    var c = data.candidates;
    if (!c || !(c.total || c.last_finished_ms)) return '<div class="empty">Aday veritabanı henüz oluşturuluyor. İlk tam tarama yaklaşık 10 saat sürer.</div>';
    var h = '<div class="panel" style="display:grid;gap:10px">';
    if (c.phase === "scan" || c.phase === "deep") {
      var done = c.phase === "scan" ? c.scanned : c.deep_done, tot = c.phase === "scan" ? c.total : c.deep_total;
      h += '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>' + (c.phase === "scan" ? "Hesaplar taranıyor" : "En iyi adaylar ayrıntılı inceleniyor") + '</b><span class="num muted">' + (done || 0).toLocaleString("tr-TR") + ' / ' + (tot || 0).toLocaleString("tr-TR") + '</span></div>' +
        '<div class="prog"><i style="width:' + (tot ? Math.min(100, done / tot * 100) : 0).toFixed(1) + '%"></i></div>';
    }
    if (c.last_finished_ms) h += '<div class="muted" style="font-size:13.5px">Son tam tarama ' + when(new Date(c.last_finished_ms).toISOString()) + ' · ' + (c.n_ranked || 0) + ' uygun aday. Kadroda yer açıldığında bot önce bu listeye bakar ve seçmeden önce güncel veriyle yeniden kontrol eder.</div>';
    h += '</div>';
    var top = c.top || [];
    if (!top.length) return h;
    var role = {}; data.traders.forEach(function (t) { role[t.a] = "ana kopyada"; }); data.bench.forEach(function (t) { role[t.a] = "gözlemde"; });
    return h + '<div class="feed" style="margin-top:10px">' + top.map(function (x, i) {
      return '<div class="ev"><time class="num">#' + (i + 1) + '</time><div><a href="' + hd(x.a) + '" target="_blank" rel="noopener"><b class="num">' + x.a.slice(0, 6) + '…' + x.a.slice(-4) + '</b></a>' +
        (role[x.a] ? ' <span class="kind in">' + role[x.a] + '</span>' : '') + '<p>' + esc(x.desc || "") + '</p></div></div>';
    }).join("") + '</div>';
  }

  window.addEventListener("resize", function () { if (data) chart(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && data) load(false); });
  load(true);
})();
</script>
</body>
</html>`;
