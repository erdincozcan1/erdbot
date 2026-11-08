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

// Kopya büyüklüğü çarpanı (hl_watcher.size_mult ile aynı)
function sizeMult(m, snap, cfg) {
  const tv = cfg.size_target_vol, vol = (m || {}).vol_12m;
  if (!tv || !vol || vol <= 0) return 1;
  let k = Math.min(Math.max(tv / vol, 1), cfg.size_max_mult ?? 3);
  const eq = (snap || {}).equity || 0;
  const lev = eq > 0 ? Object.values((snap || {}).positions || {}).reduce((t, p) => t + p.value, 0) / eq : 0;
  if (lev > 0) k = Math.min(k, Math.max(1, (cfg.size_lev_cap ?? 5) / lev));
  return k;
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
             trader_equity: ((state.snapshots || {})[a] || {}).equity ?? null,
             mult: sizeMult((state.metrics || {})[a], (state.snapshots || {})[a], cfg), moves: (state.watch_events || {})[a] || 0 };
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
<title>Astral</title>
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAX7ElEQVR42uV7e5RU5ZXvb59XPfpZ/SgaQXkkqIDGTMCF0UBVQXNDDIJAnwaFxKUzA8mNiTPJXHUSk+qarMmYyTX3jqOJYnLvOFcZqSOIyqAC3VXVKGJsfAKOGh+I0E1VdVU/qqqr6pzz7ftHdUHTIBEaXM6as1atXr2q6jt19rf3b//2b+8P+Iwv3q27PgrrLnxOLumzulE4rMsAkC6K2c46mg4AHAxK/2UM0NgYJwAQLH+ZZXYDANr+C3nA8Rjgq1RItQAA4wCdmyVBn3sD+P0xGwAYPFtAOM/VusFgUCICn+33lc9m00FE4HRkaS0TTbFtFM/JumFdptaQffipxW6tTpIbv/bU4OfTAwxdAgCblUtqPU6VCJ4SMMTP2nU54lOo1bB7diyfqlW5fnC2oPrZGGD4QYmkL5FLgURwj2E14ohPoUDMSkVXzpVl6VG2pM2l3Q+dHwxgBo0FaOD3cin+MXv4b9MncYTu59ZUfOLvCAYl5iBRIGalYvpNsowYkfipd+HGdzisyxSCOC8GIAITgRlnawRDMAclBs9B0QZAtaMfDAASRXGpKhdqT4XszLpMoZAgConeWOvfe8ZV/Itl2v+jIbB5ZzkcznkWKP+IZHTl9A8iPicBfKaewMMo3bP9wCRiXGIN2WAhLgIAJEqegZmldCjZtMiUJfWU8U6G3bPzunHpmP50XVPFj1PdmU318x+/pxwO5ykNln4f20JUwnsXAESjPvmTPKGra6160u75oxIAaAqudLtV51DBYiZcAgDQDcEMolbD/iBykxNE10JTcye6H0CBmJWM6gtdDtee2hrn4vSRzKEhy1rHwaDUFvULnC8iREQcifiUxgXG28woJiP6A4FAzNrbNeuU6XPWYNoR79B9RGDmExFZSHyFU5OhqRIRaOux4BjOEBWUvxLgK6RiIXdCzL+8Vk1GWu5yqPJ2gCZnsqZdtPHnExdu6cXMAxQKhcR5ZYJ+f8xmDkofVXv+gRlLkxH9p7Nn7zW7HpylnpSTA0aGCNOT7SuWE4VEJOJT4I/ZzCBZiPX9mWIyk7M+qPfiLmZQ/3O6R5/qkUrQLlYw4OwfGjQBAHvXKhQKid7B1N/U17l+XijYQ5VuBfmCdW9Ts7FjLHF/RgYosawDNHv2ehNkf7e+yf138Z0tfzF73Sgj6IYAAIeMTZCkX3z45HVTAoGYBQQJbUGqW7D5oFm0lxOJ79FlRhGGLgmVLsSsB63kntXVBOhEJHuqa+sBAM70cOahSXDIqKxQXf2Z4luC6GfhsC5jmFl+JlSYyLDDYV1uDGzekurJddY3uh7q2blizex1e03uKhmBCByJ+JTqeUaCWeyub6zY+lFYdxGFBNpCzAzyNm/aVReX2pl1+RCgAahB1C9LWfaA4AUjx4OFEtDmPUwEFszdZqb4cC5vXz84mLtmXMDI6LohyvSXw7o8Fip8RrQTAJKR1qsyL66ys7tXcaKjZfXI9zisy8yg3vYVM4t7V3NfrHVn/45v1TMHJeaglHh+1QXJDv02ADiy/frpyQ79J+X1j7br30p0rFg6vI4GAN3PralI7dBrTsxMJWwprVna+fj25dO6I0snn4030Jlzb8M+2r5ic121Y1kub3OuYP7l+ObNv2cOSkQhwQARwPH2lj80Tq+7Mvkfqe80BIz1RMQA0NvR+nVNpYIl+McgBGybN8oSUiTjgCQpbxHLb1Vd80i868FZ6kUXT76zsapwD83emuOutepAJjm5OjfhI7jesMupL9Gh30FAvt6L32LmDIvozEDxjIoho5QYqU9Wf57LW0tNm7mx1vW73vaWAaKQ0bdbrwMwxF818qmY1FZMDrUBqCQiTu9a6VeIvy8Ys2xmlRkfCsFhBhcsm6Z5KrTvMzMyueJQ366VrxBgDOXNR2n21txA5IaGZCZ9tYMdu+nafy4AQE9Uv7zSqTyUH7I+bAgYq5hBZ4MEdHYVmGHH21u2VLiU6xRFsgeyxd82Bh6/7b0dek29jC/Wzjf2lj+fiKzwu5zKD8C0xLLFBtvEo9kiv3zRIiM1ct1kpOWPElGVbdEqRcGVmkNaZ5oiq6ryM7mcOUN2arfWXbPh4NGI3qQRbnNVqLfn8/bztXM3+oJBSG1tJbb6mRRDzCBVojYAklbjUIlpKgB8YaHRb5Kg3uiKbwBAulP/a4eqPFvhcS0bytvx2rnhb+fy5v66WmVvYpc+iyM+5YPITc7heM7ajLbG5nAEsHf0Ju15RHhY1aTbVU3+Yt01Gw4CgMz8o9pL6+7M5azudDK/lBnU1hbEcVwISqWaoVS/MIMYpdc5MUA593oCxmuDefN6K2f+ExO/Xwafhqr6122b1hZeWb1LghRkZj3xcaat0q2Mj29fPm1iRokXC3aHZEOjQMx6OZEzgRAT0ZsFywxHIj7FEtJeVyXm18wN33P4o8wUWaXBgV0rd7+zbZGDQQ12YqjDtOzWKcue7IOhS0QhUapXSrVCqWYoeQQRmFB6jSkEyqLGJ/2fiuqXg1FTFzCeT0X1rQ63smCwvzCzaeHm9wGgN9J6HzN3N8w3/v5YjTDM4pLbFlWzs/KGxvmPP3g0oldKwJqCZRoTlCv6KRCygoD0w12t74Low4wprZwQ+LdkWQ1qawsxEfidbYsck8bVXlLIU9ESVo6s4gBXafz6YDwbGFErdD04S73w4qkODUXlNfRlzgoD0BgnJLyMqR4JzjTBmGEd8e+tc5BrCZhZlqQH4kezUy9p/ffD+8K6NhOwoc/g3uj+H8PluLf+mS9maASFPfzUYrfD7fI0NBtHuGRZLrt0Wxtw68JXK2TLsd8zuebC3g/6f90QMH60L6xrl7UaRQLwZljXmhqxxeWQvzFUEDYg8gBlmaEAKBIgkwRBjBRJdJAkHGCbny8ydnwqA/C2RY5URY3XEiI9LmBkTvYOXSYybO5a6+4dTA8y87dVTd5j5UW+odk4XE6RmYjelJMs8vqe6B7tQaMl9DLZYQalonq72yXPzA5ZUSLSLWF/Y9z8zc8NvrhqXKVanUoOpoMNF1T8JJvMw7QFqtwqZJkwkDFhC/EhgJdlwvMWaK8Kfqd6npH41CHADHr3mUWax1l1mSLTclWTJtkWv0aC/0AKUvHDfOgLrUY/AMQ79Ecl4tp6/+OLUzH9kC34lcYALYNRosqnQ+mTQywoJZ98tQJV2p2STIJzg79quPbZgUREv5OYbyZFuoUt9iGv3QetWCWp5FckfE8QTYMQMYmkZ6CKF6vmhN8qe9RJZXooJM6MCHFQ6nvhrWUy6KdVldoVhYKNQtH+OG+J6zS4P1QdhXg2Z/71uOZN9x/c+k2Py1kxpbG29k2avd4c8ZDH6+w/YYyenSu+pGiS1TDPOAAAqZh+qynwrMzoNAX/cHzz44+N/m7/S9+qr5nz/3pHeyiicYLfL0qAe/z+dEbCxoi4TXfqLQT6hUOTLsgM2SEwZRuaXPfnB4ooFq3bauYZ954rGh6J+JTLyfttRZYeHMiKcW6Nv685Zd02xQ9I4KMCkLGgWBdEL05RKCSO4ZTfL0ChT8wAxwzADIpGfTIAJBJe1vfPYLSFTkksykQIABJbllQNVTqqL2o2Dic79E63U3bnivarDlW+xLTtty0Lj2Qp/tJkf6xwNiSFGYS2IFEoJI5s0xvNKtWaNHdDOtmpz6h2qfuzWSsmS/jfeWEflElJ1lXU9GDWeHv0Lo+JCTIHpWg0KvlL6gDgh8DebjmdTrvrFpZiv8TJW1K2YH9T86Y3AGDwhTXevFmcpHDhXU/gyb5yjXAueoxXNrrVKs69TyC9fn74hdPJeX/KEMRdi929GcciVZanEPNAwRbvuh3Su+6Cu5cCD+dP9aXu59ZUuJXCRFtFE9u4QNOkywtFsU5R1C/WeMws8h4ux/35uuLtLXtkonD9fOPXiXZ9iaNC1rjIb1RrSg/mPDJ4KuA7tQEY1LN9jdvhML+iKLyCmZYAmGILkbUFDrLgblmWuoUtUtUVymBfX8EYt+iJ1wGA9+laIo6vujT5twXTrqj3YyrRcZVmGDcYY9x5jvgUuCa6ezPFKpbQJMk02+VS7s5mzLuFwFHvhIr/C2bYOQsDObNPAvZBoi6JsSsvii96fU90f5IHnhQC3LVWHcgPfIPZvpmZrqttcMkwBQp5C5oiIZe3U7m8WOZdEO48htY7ljcrivy7hoAxube99VqWkOpI8Mv6n0h9n7bpmehc1lSpOX2FojVXCCz01DimkVNGKj70cyH4SU2j7zJTtS1EhypL+wWbhylf0V9tJjJtL80xT6cb0uhYH0kbe2MrL1RkrALzzaoiTzctAbdTRqEokLfsOQ5NPmizuN4u8AAzQkz2EqdDbS8UxGM5B+56rxA3A2OQrD/pSsVa5zmcSjiXNf9X43zjl2NZSzkue4UEAMEMKvfyyLfxEIBffRTW7/NcIJYw8/eyQ7aXiH9hCxzIDCjsdFh/sG1BksSeIorJhr7c1Kprny18EsE5K08ACJGg3K+8eZFpQavzhTsT7Su6maRkmakiU2XtB+SZUz2Mp8fbCJ0+/X2qLBAMBiW//0SvOFUjgoNBqde3/5Cq0C8HMtbm6hrtIghxqWXzoCxrO2u+tqHv0yDyJz48B+nQiwccFSY9JhGmc4GbhYIugG4chOv5KaPAejRnGbMgUopFXQKG+XlYlzGKKyQ79H+tr3N+K5szIWzxjs38P7MFc/OEhVtSY0l/JQ2wdJ++XTd6cmwqDkFXMvN9gsRNEpNPhnlfbtAuSqrslV2Kx+vf9OqnTYNnBUwc8R0LndSu1ivSkZWTeyMtq8xX1oh0TP+3xJYlVaP7fmd1r30lcZQZFA7rMh1PgVsSHS0bAYBfW1PBkZucyYj+QO7FVfnM7lWcjOj3jBRpz5kiVKrqwBSIWcnIsonpztatnkrtNRuiXZhK50B/IWEKPNV4/VODvG2RAwBGuuKnVWyDwaDEAKVT4tJ4h76SCNzaatiCQcmd+gRNlZfKsjSvb9eNU+nLj2Qp8HDesvCwEHDkC3bBU639MBVt/W2ZsZ5uE87IAEQhEY8tG9+/a+UvVVX70O1Uvlk0xVFmvqfxvz12hIGfg/GPvE/X4BqymUGp9uWT+LU1FcxM5d7Bn7pPKBQSbUGQp0faLxEa0536s/GdrV8hAkPCA2Bud2l0g2mazYd36BcBQNNC48Vc3n6ivsntSA8UUelWvpOKtf6+TKVHt+rOeD6gb9eNnniHvlKTtbtVVfLYFt9SyJszB4qZaY3zH/9Nqf9nbWqsc05MJHDvcEPzDkHynni6QETE8eiKuZejrulYKJ0Gg9oQBLUadkPAuE/Y1FNdJe/t61z5BgB/3hxa7frqxmhDwHhIVlEzuHPVOGaQbVnfyaUKfyfL9J4tGJ4G1y198w9s2RfWK4lCgrnUvzizWmCYQSV36hMUkpy1Cza+d9Jnnr+lKmn2XyJDusHlki8wTV5lCV5jC/swWLq4cb6xPrF9xWwodON9sZl/M3PmAdJbDVEGx+Se1dVSJj+5rnnTG11da9XZs9eb8ciKxS6Het1AgX7yQsJKL2jkw3WN7nHxnqGbvRM9Ww+93V170dKn/1iSudaqs9cdp97dz62pqHCbqwXzd2u87i/3J3Jvpft5/pTFRs/oLCZ9ijTBANDQbBwuPzxHfApHfAqHdTm5bXV1ysxMsi1Oeao8d7queuwG0xZXOzXpEUWWpzTON9Yf2r58mqxJT0KSng6FQkIfsS4AsDXItkSLAGDWrLRggARJB52aNMcaGqrx1eByzaE0JuJDP5KL2ub+eN+r3glVr3fv0FcCwKy1aTESoMd//ZFs9dyN6z/u4TnpnuxqTVOosV5+M9mxYg4FYtbIcKAzpaUj00o4rMutozq0/dHl00whX02SiCuy8gSAXcx8uWVzoSFgTOKutWp08G3+QsFbXemk+zJ5vnXPAPoDDXjGoWD1Xjue9vv9otzh6du98lZFln5lFuygZ174H4ezwN2N49x35AZNDAwUrxr/9U0vjdzZctoeUZdQds8Na82C/d9Ni3/ZuMDYUCZoZ9VV5WBQKnOAQ5FlEyssRRJVWl+ur6hoipgIAE3Nm96Ib18+zeFSH6uud34lncjtO3IUsy5rNYoAcDhyQ4Nbsl832V7s9W96NdHRkgQo2DjfuB8AUp26z+FUfioYl+Zz1p2NAeORSMSn+KN+gTYgHnlzYU2l8/aiKa7KFgtzxgee2DdSqzhOoo4bIrVDr7Fk/DmEeGu/nNzhj/oFnY06U2aG6c7W21WZfjZUFJanSsv29Rfua1jw+D+M/lxfrHWdqkm3WjY3sMBjgHhOEA6YFjQv0JOwxDSnS3mlWBSDRPSvTOyr9zgvGxgofPjKH49O/9Jkr18iuGp9eArG8d4EAAzsvuEvCnnrL0ng5oZm40AwCCl0imGpsnBbFnIalv5ZlugMNMFyjUCthv3xs0svrKpw3uvQpOszOYtdDpncLgXxvsKfef3G69i7VsGs8XZf9LVqaM67zaK19f7opm1/tWDVconEQ06HUjuYNeNElBWCVUlCrSSRyswfybJ0sFgUhqqir1Dga8Y1P35b4vklVZLtqq33bTx0jEsYugR9BhOFxJH25ZM0RW62Bf7d6zeOgk7EmFM9wxlhwAm72dm6SiL6p6pah7eYs1A0bQA4OJS3NnibN/2YGYSoTy6RpZa76y+uu6P3nfT6hoCxDgAS7S3/Isv8+4wlve9xSFcXLD6kKGxqkpo0hTX+13cd7QrFSvfqjbZeW8fTt1MgZMV3rLxYdQmf52vGQyOz08jfltyzurrhqkcHzllzdGRRcWjbsolVldpvaryu6zK9eZiWvUeWqEOAduTS2T9MWLI1N7welwEm2aG/WVGlXpobtBbXzw8/l2jXL2FZeL3+Tbt6YysvZMu+vmHB4/98TOWJrHigwq0153KFxQ3Ry99Jzds3XdYcR2rnbkgn2vUbGyZUPJrqznZawEqv3zhaBuWx8P7TsjIKhQR3rVX7sv1/pWp0O9uc7u3JBh0OeUudz3jjVGJpuXhJ7tRn1NU6Lov35tY1Ldz8HLMuJ2LC3RiXdnPXWhWDb3d3q97HmIMS9nbLeHq83csHLnE3uL6Q/dC6mkKh/zjSqcetrFkSbonnFvqLdl2tY15v/9DVRNhcYpUxa8SD05mqT8rp4r3PK38pOZC+xeVW2IZ9Xc3XwntOkqoSXi41PUpxVRJVYCU6+EepgcLGpoWb10ciPgV7PSTlsu9R66M2ADve3nqt0+IXiEKCIz6JQutFIqL/H+RtPyQMAcD4HqSwfwaXCAtdattCKpqwwdIFwxLtqef6xmoAIoC7PJKZ6YWmOn5WedWG9AkPPZynT9IFGEQUs+KxZeNhk6cwMLSGw7oMv2ETxRiAuS+sa+O9aKuu1v52sH/oOgDHRuYaGrGxL5G7H0AlAKAxTlF/nBCCIOABAH4iyIJ5Es7zgQmm2etNr3/Tq7VzN6Q54lPK7IkCsdOMoQQJAGShXEECd01YsjWH/TNKY7bB0r3GefFIXY3jb9kSLFhaDQDRstBymVE0bfGUxDh2pigQiFnBIKS6gBHODlldqlNhiWh8+XvndUyuPGhw+oc+sVrkYFAqFq1XGpqNA8wYrsRAFILo2/VNDwR/M9VfsFAaWogAgD/h5eGxWVJlZTNJOOFQVZvfJxGBZYl+DYmIGZNK4Ta2KdHzfkhi9IRZIrLC39+5UuRfuoET7S07Tpj6Gs5Igy+uGpeMtNw8+j1mEG9b5EhF9I8THS3JkWLJ5+7M0ElC6PB5AQlSoLJa5XzR7lM1sW5kOVwmLtVffeyoDdpVWqPkdQQwoj6Zrn22IFj8pqZSqz/SXR65D37+DDA6H7dFYwIAbJsXSKos5U2+o3bu5vejEZ88OrQYwLiA8ceTcnppDSoq0kNDBSvvUIcHrnFuDl6dv1AonwV4ftUFmRdXFZMd+svMoHJYnM2wZkkTXHHHsaz0uT42549KzCDZtBdUuFWVge8QgY2xYAvzgwRpEv4zXOFjI7Z6NLGzZUO5thjLmh9EbnLGO/SfccSnnP0pls/AA5hBra2G3bNz1Tgwj3dodFupBRcTY1lzSuDhPCTxdNryVpyLlvt5u8o7nYy03JyMtHz/2LjKuTLwGHf/vHuA3x+zyyFQ76DflVLb2A85jCyHP/cYwBGfMnrk/fN0/X+GRgxYzFVK3gAAAABJRU5ErkJggg==">
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
header.top .wrap { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; padding-block: 14px; }
.brand { font: 600 32px/1.05 var(--f-display); letter-spacing: -0.02em; text-align: center; }
.brand .mark { height: 1.5em; width: auto; margin-right: 10px; vertical-align: -0.36em; filter: brightness(0.86) saturate(1.35); }
@media (prefers-color-scheme: dark) { .brand .mark { filter: none; } }
.brand small { display: block; margin-top: 4px; font: 400 12px/1.3 var(--f-body); color: var(--muted); letter-spacing: 0; }
.top-r { display: flex; align-items: center; justify-content: flex-end; gap: 12px; min-width: 0; }
.login .brand { font-size: 36px; margin-bottom: 6px; }
.spacer { flex: 1; }
.fresh { font-size: 12.5px; color: var(--muted); text-align: right; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--up); margin-right: 6px; vertical-align: 1px; }
.dot.stale { background: var(--warn); } .dot.dead { background: var(--down); }
@media (max-width: 640px) { .fresh { white-space: nowrap; } header.top .brand small { display: none; } .hide-sm { display: none; }
  .brand { font-size: 26px; } .fresh .lbl { display: none; } header.top .wrap { gap: 8px; padding-block: 10px; } }
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
  var LOGO = "data:image/png;base64,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";
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
      '<div class="brand"><img class="mark" src="' + LOGO + '" alt="">Astral<small>Hyperliquid kopya portföyü</small></div>' +
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
    var h = '<header class="top"><div class="wrap"><div></div><div class="brand"><img class="mark" src="' + LOGO + '" alt="">Astral<small>Kopya portföyü · ' + m.slots + ' ana kopya yeri · her biri ' + usd(m.per_slot) + ' · kaldıraç sınırı ' + m.max_leverage + 'x</small></div>' +
      '<div class="top-r"><div class="fresh"><span class="dot' + dot + '"></span><span class="lbl">Bot ' + (ago(lr) || "henüz çalışmadı") +
      '</span><span class="hide-sm"><br><span class="num">' + when(lr) + '</span></span></div><button class="btn" id="rf" title="Yenile">Yenile</button></div></div></header>';
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
    if (t.mult && t.mult > 1.005) f.push('Kopya büyüklüğü <b>' + num(t.mult, 2) + 'x</b>');
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
