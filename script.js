(function () {
  if (window.__btc_dashboard_initialized) return;
  window.__btc_dashboard_initialized = true;

  const API_BASE = location.origin;
  let currentInterval = "15m";
  let currentTZ = "auto";

  // --- helpers ---
  function el(id) { return document.getElementById(id); }
  function q(sel) { return document.querySelector(sel); }
  function safeText(d) { return (d === undefined || d === null) ? "" : String(d); }
  function nowLocalDateString(tsSec) {
    const tz = currentTZ === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : currentTZ;
    try {
      return new Date(Number(tsSec) * 1000).toLocaleString('en-CA', { timeZone: tz }).split(',')[0];
    } catch {
      return new Date(Number(tsSec) * 1000).toISOString().slice(0, 10);
    }
  }
  async function safeFetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (ct.includes("application/json")) return JSON.parse(text);
    try { return JSON.parse(text); } catch { throw new Error("Non-JSON response from server"); }
  }

  // --- DOM / chart setup ---
  const chartContainer = el("chart");
  if (!chartContainer) { console.error("Missing #chart element"); return; }

  if (!window.__btcChart) {
    chartContainer.innerHTML = "";
    window.__btcChart = LightweightCharts.createChart(chartContainer, {
      layout: { background: { color: "#071021" }, textColor: "#dbeafe" },
      grid: { vertLines: { color: "#07182b" }, horzLines: { color: "#07182b" } },
      timeScale: { timeVisible: true, secondsVisible: false }
    });
    window.__btcSeries = window.__btcChart.addCandlestickSeries({
      upColor: "#10b981", downColor: "#ef4444",
      wickUpColor: "#10b981", wickDownColor: "#ef4444", borderVisible: false
    });
  }
  const chart = window.__btcChart;
  const candles = window.__btcSeries;

  // price lines storage
  if (!window.__btcPriceLines) window.__btcPriceLines = [];
  function clearPriceLines() { try { (window.__btcPriceLines || []).forEach(l => candles.removePriceLine(l)); } catch (e) {} window.__btcPriceLines = []; }
  function addPriceLine(opts) { try { const pl = candles.createPriceLine(opts); window.__btcPriceLines.push(pl); return pl; } catch (e) { return null; } }

  // responsive sizing
  if (!window.__btcResizeObserver) {
    window.__btcResizeObserver = new ResizeObserver(entries => {
      for (const e of entries) {
        const w = Math.max(300, Math.floor(e.contentRect.width));
        const h = Math.max(250, Math.floor(window.innerHeight * 0.58));
        chart.applyOptions({ width: w, height: h });
        const barSpacing = w < 520 ? 4 : w < 900 ? 8 : 12;
        chart.applyOptions({ timeScale: { barSpacing } });
      }
    });
    window.__btcResizeObserver.observe(chartContainer);
  }

  // UI refs
  const lastPriceEl = el("last-price");
  const newsEl = el("news");
  const profitEl = el("profit");
  const aiText = el("ai-text");
  const aiFill = el("ai-fill");
  const aiReason = el("ai-reason");
  const refreshAiBtn = el("refresh-ai");
  const tzSelect = el("timezone");
  const intervalsContainer = document.querySelector(".intervals");
  const themeBtn = el("theme-toggle");
  const strategyPanel = el("strategy-panel");
  const strategyStatus = el("strategy-status");

  // attach a rich UI inside #strategy-panel if present
  function buildStrategyPanelUI() {
    if (!strategyPanel) return;
    // keep existing title; ensure content area exists
    let content = el("strategy-rich");
    if (!content) {
      content = document.createElement("div");
      content.id = "strategy-rich";
      content.style.marginTop = "8px";
      content.innerHTML = `
        <div id="strategy-summary" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div id="strategy-badge" style="font-weight:700;padding:6px 8px;border-radius:8px;background:linear-gradient(90deg,#0ea5a0,#06b6d4);color:#022c2e">🎯  Strategy</div>
          <div id="strategy-line" style="flex:1;color:#cde7f5">Using 15m opposite-candle-break logic • Max 2 trades/day • TP 3–5%</div>
          <div id="strategy-count" style="font-weight:600">Trades: 0/2</div>
        </div>

        <div id="strategy-status-emoji" style="margin-top:8px;font-size:1.05rem"></div>

        <div id="strategy-prog" style="margin-top:10px;background:rgba(255,255,255,0.04);border-radius:8px;padding:6px;display:flex;align-items:center;gap:8px">
          <div style="min-width:120px"><small class="muted">Profit target (daily)</small>
            <div id="strategy-bar" style="height:10px;background:rgba(255,255,255,0.06);border-radius:6px;overflow:hidden;margin-top:6px">
              <div id="strategy-bar-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#ffd166,#06b6d4);transition:width .6s ease"></div>
            </div>
          </div>
          <div style="flex:1">
            <div id="strategy-reason" class="muted" style="font-size:0.95rem">Waiting for signals...</div>
          </div>
        </div>

        <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
          <button id="show-tradelog" style="padding:6px;border-radius:8px;background:#0b1220;color:#dbeafe;border:1px solid rgba(255,255,255,0.03)">📜 View Trade Log</button>
          <button id="clear-tradelog" style="padding:6px;border-radius:8px;background:#7f1d1d;color:#fff;border:none">🧹 Clear Sim</button>
        </div>

        <div id="trades-log-panel" style="margin-top:10px;display:none">
          <table id="trade-log-table" style="width:100%;border-collapse:collapse;font-size:0.92rem">
            <thead style="text-align:left;color:#94a3b8"><tr><th>Type</th><th>Time</th><th>Entry</th><th>TP</th><th>Result</th></tr></thead>
            <tbody id="trade-log-body"></tbody>
          </table>
        </div>
      `;
      strategyPanel.appendChild(content);

      // wire buttons
      const showBtn = el("show-tradelog"), clearBtn = el("clear-tradelog");
      showBtn.addEventListener("click", () => {
        const panel = el("trades-log-panel");
        panel.style.display = panel.style.display === "none" ? "block" : "none";
        renderTradeLog();
      });
      clearBtn.addEventListener("click", () => {
        localStorage.removeItem("btc_trades_sim");
        renderTradeLog();
        updateStrategySummaryUI([], 0);
      });
    }
  }
  buildStrategyPanelUI();

  // --- manual zones persistence & UI (reuse earlier functions) ---
  function getManualZones() { try { return JSON.parse(localStorage.getItem("btc_manual_zones") || "[]"); } catch { return []; } }
  function saveManualZones(zs) { localStorage.setItem("btc_manual_zones", JSON.stringify(zs || [])); }
  function addManualZone(z) { const zs = getManualZones(); zs.push(z); saveManualZones(zs); }
  function removeManualZone(idx) { const zs = getManualZones(); zs.splice(idx, 1); saveManualZones(zs); }

  function renderZonesListUI() {
    const list = el("zones-list");
    if (!list) return;
    list.innerHTML = "";
    getManualZones().forEach((z, i) => {
      const item = document.createElement("div");
      item.style.cssText = "display:flex;justify-content:space-between;align-items:center;background:#0f1724;padding:6px;border-radius:6px;border:1px solid #111827;margin-bottom:6px";
      item.innerHTML = `<div style="font-weight:600">${z.type.toUpperCase()} • ${Number(z.price).toFixed(2)}</div>
                        <div><button data-i="${i}" class="rmz" style="padding:6px;border-radius:6px;background:#7f1d1d;color:#fff;border:none">Remove</button></div>`;
      list.appendChild(item);
    });
    list.querySelectorAll(".rmz").forEach(b => b.addEventListener("click", ev => {
      const i = Number(ev.target.dataset.i);
      removeManualZone(i);
      renderZonesListUI();
      loadCandles();
    }));
  }
  renderZonesListUI();

  // settings persistence
  function getStrategySettings() { try { return JSON.parse(localStorage.getItem("btc_strategy_settings") || '{"tpPct":4,"autoSupport":true}'); } catch { return { tpPct: 4, autoSupport: true }; } }
  function saveStrategySettings() { const tp = Number(el("tp-pct") ? el("tp-pct").value : 4) || 4; const autoSupport = !!(el("auto-support-toggle") && el("auto-support-toggle").checked); localStorage.setItem("btc_strategy_settings", JSON.stringify({ tpPct: tp, autoSupport })); }

  // trades persisted (simulation)
  function getSavedTrades() { try { return JSON.parse(localStorage.getItem("btc_trades_sim") || "[]"); } catch { return []; } }
  function saveTradeSim(trade) { const t = getSavedTrades(); t.push(trade); localStorage.setItem("btc_trades_sim", JSON.stringify(t)); }
  function tradesCountForDay(dateStr) { const t = getSavedTrades(); return t.filter(x => x.day === dateStr).length; }

  // timezone formatter used by chart
  function tzTimeFormatterFor(tz) {
    return t => {
      try {
        const tzName = tz === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz;
        return new Date(t * 1000).toLocaleString([], {
          timeZone: tzName, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short"
        });
      } catch { return String(t); }
    };
  }

  // consolidation detection
  function detectConsolidation(data, lookback = 8, thresholdPct = 0.7) {
    if (!Array.isArray(data) || data.length < lookback) return false;
    const slice = data.slice(-lookback);
    let high = -Infinity, low = Infinity;
    slice.forEach(d => { if (d.high > high) high = d.high; if (d.low < low) low = d.low; });
    const range = high - low;
    const avg = slice.reduce((s, d) => s + d.close, 0) / slice.length;
    const rangePct = range / avg;
    const threshold = (thresholdPct / 100) || 0.007;
    return rangePct <= threshold;
  }

  // auto support detection (cluster lows)
  function detectAutoSupports(data, lookback = 36, clusterTolerancePct = 0.5) {
    if (!Array.isArray(data) || data.length < lookback) return [];
    const slice = data.slice(-lookback);
    const lows = slice.map(d => d.low);
    const avg = lows.reduce((a, b) => a + b, 0) / lows.length;
    const tol = (clusterTolerancePct / 100) * avg;
    const clusters = [];
    for (const l of lows) {
      let placed = false;
      for (const c of clusters) {
        if (Math.abs(c.mean - l) <= tol) {
          c.values.push(l);
          c.mean = c.values.reduce((a, b) => a + b, 0) / c.values.length;
          placed = true; break;
        }
      }
      if (!placed) clusters.push({ values: [l], mean: l });
    }
    return clusters.filter(c => c.values.length >= 2).map(c => c.mean);
  }

  // draw small zone/trade markers (merged later with trend arrows)
  function drawZoneMarkers(manualZones, autoSupports) {
    const markers = [];
    (manualZones || []).forEach(z => {
      markers.push({
        time: Math.floor(Date.now() / 1000),
        position: z.type === "support" ? "belowBar" : "aboveBar",
        color: z.type === "support" ? "#06b6d4" : "#f97316",
        shape: "circle",
        text: `${z.type.toUpperCase()} ${Number(z.price).toFixed(2)}`
      });
    });
    (autoSupports || []).forEach(p => {
      markers.push({
        time: Math.floor(Date.now() / 1000),
        position: "belowBar",
        color: "#94a3b8",
        shape: "square",
        text: `AutoSUP ${Number(p).toFixed(2)}`
      });
    });
    return markers;
  }

  // trade markers creation
  function createTradeMarkersFromTrades(trades) {
    const markers = [];
    (trades || []).forEach(t => {
      if (!t || !t.entryTime) return;
      // Buy arrow
      markers.push({
        time: t.entryTime,
        position: "belowBar",
        color: "#00ff88",
        shape: "arrowUp",
        text: `🟢 BUY ${Number(t.entryPrice).toFixed(2)}`
      });
      // TP arrow or flag
      if (t.tpTime && t.tpPrice) {
        markers.push({
          time: t.tpTime,
          position: "aboveBar",
          color: "#ffd166",
          shape: "arrowDown",
          text: `🎯 TP ${Number(t.tpPrice).toFixed(2)}`
        });
      } else {
        markers.push({
          time: t.entryTime,
          position: "aboveBar",
          color: "#94a3b8",
          shape: "flag",
          text: `TP target ${Number(t.tpPrice).toFixed(2)}`
        });
      }
    });
    return markers;
  }

  // trend arrows + zones + trades merged
  function drawTrendArrows(data, manualZones = [], autoSupports = [], simulatedTrades = []) {
    const markers = [];
    if (Array.isArray(data) && data.length >= 2) {
      for (let i = 1; i < data.length; i++) {
        const prevGreen = data[i - 1].close > data[i - 1].open;
        const currGreen = data[i].close > data[i].open;
        if (prevGreen !== currGreen) {
          markers.push({
            time: data[i].time,
            position: currGreen ? "belowBar" : "aboveBar",
            color: currGreen ? "#00ff88" : "#ff4444",
            shape: currGreen ? "arrowUp" : "arrowDown",
            text: currGreen ? "Bullish" : "Bearish"
          });
        }
      }
    }
    const zoneMarkers = drawZoneMarkers(manualZones, autoSupports);
    const tradeMarkers = createTradeMarkersFromTrades(simulatedTrades);
    const all = markers.concat(zoneMarkers).concat(tradeMarkers).slice(-100);
    candles.setMarkers(all);
  }

  // draw price lines (manual solid, auto dashed)
  function drawPriceLines(manualZones, autoSupports) {
    clearPriceLines();
    (manualZones || []).forEach(z => {
      addPriceLine({
        price: Number(z.price),
        color: z.type === "support" ? 'rgba(6,182,212,0.95)' : 'rgba(249,115,22,0.95)',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: `${z.type} ${Number(z.price).toFixed(2)}`
      });
    });
    (autoSupports || []).forEach((p, i) => {
      addPriceLine({
        price: Number(p),
        color: 'rgba(148,163,184,0.55)',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `auto ${i + 1} ${Number(p).toFixed(2)}`
      });
    });
  }

  // update strategy summary UI (counts and bar)
  function updateStrategySummaryUI(savedTrades, dailyProfit) {
    const countEl = el("strategy-count");
    if (countEl) {
      const today = nowLocalDateString(Math.floor(Date.now() / 1000));
      const todayCount = savedTrades.filter(t => t.day === today).length;
      countEl.textContent = `Trades: ${todayCount}/2`;
    }
    const fill = el("strategy-bar-fill");
    if (fill) {
      // dailyProfit is in absolute USD. We show it as percent of hypothetical premium.
      // We'll map profit to a percent of a notional "100" for visual. Keep simple: percent = min(100, (dailyProfit / 1000) * 100)
      // But better: compute percent relative to 3% target of example notional (assume notional = 1000). This is just visual.
      const notional = 1000;
      const targetPct = (dailyProfit / (notional * 0.03)) * 100; // how close to 3% of notional
      const pct = Math.max(0, Math.min(100, targetPct));
      fill.style.width = `${pct}%`;
    }
  }

  // render trade log in panel
  function renderTradeLog() {
    const body = el("trade-log-body");
    if (!body) return;
    body.innerHTML = "";
    const list = getSavedTrades().slice(-50).reverse();
    list.forEach(t => {
      const tr = document.createElement("tr");
      const when = new Date(Number(t.entryTime) * 1000).toLocaleString();
      const result = t.tpTime ? `✅ ${(t.tpPrice - t.entryPrice).toFixed(2)}` : '⏳ Pending';
      tr.innerHTML = `<td>${t.entryPrice ? 'BUY' : ''}</td><td>${when}</td><td>${Number(t.entryPrice).toFixed(2)}</td><td>${Number(t.tpPrice).toFixed(2)}</td><td>${result}</td>`;
      body.appendChild(tr);
    });
  }

  // ----------------- CORE STRATEGY (15m logic, visualized) -----------------
  async function applyStrategy(chartData) {
    // fetch 15m candles for strategy decisions (always use 15m)
    let sCandles;
    try {
      const tz = currentTZ === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : currentTZ;
      sCandles = await safeFetchJson(`${API_BASE}/api/candles?interval=15m&timezone=${encodeURIComponent(tz)}`);
    } catch (e) {
      console.warn("applyStrategy: couldn't fetch 15m, falling back", e);
      sCandles = null;
    }
    if (!Array.isArray(sCandles) || sCandles.length === 0) sCandles = chartData;

    const sData = sCandles.map(d => ({
      time: Math.floor(Number(d.time)),
      open: Number(d.open),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close)
    })).sort((a, b) => a.time - b.time);

    const settings = getStrategySettings();
    const tpPct = (settings.tpPct || 4) / 100;
    const manualZones = getManualZones();
    const autoSupports = settings.autoSupport ? detectAutoSupports(sData, 36, 0.5) : [];

    // draw S/R lines
    drawPriceLines(manualZones, autoSupports);

    // status element
    const statusEl = el("strategy-status");
    const emojiEl = el("strategy-status-emoji");
    const reasonEl = el("strategy-reason");

    if (!sData || sData.length < 3) {
      if (statusEl) statusEl.textContent = "Not enough 15m data to analyze strategy.";
      if (emojiEl) emojiEl.textContent = "⏳";
      drawTrendArrows(chartData, manualZones, autoSupports, getSavedTrades());
      return;
    }

    // detect consolidation/pattern
    const isConsolidating = detectConsolidation(sData, 8, 0.7);

    // find opposite-candle-break candidates on 15m
    const candidates = [];
    for (let i = 1; i < sData.length; i++) {
      const prev = sData[i - 1], curr = sData[i];
      const bullishBreak = (prev.close < prev.open) && (curr.high > prev.high);
      const bearishBreak = (prev.close > prev.open) && (curr.low < prev.low);
      if (bullishBreak || bearishBreak) {
        candidates.push({ idx: i, prev, curr, type: bullishBreak ? 'bull' : 'bear' });
      }
    }

    // evaluate candidates, but only allow buys (as requested) and respect max 2/day
    const today = nowLocalDateString(sData[sData.length - 1].time);
    let tradesToday = tradesCountForDay(today);
    const maxTradesPerDay = 2;
    const planned = [];

    for (const c of candidates) {
      if (tradesToday >= maxTradesPerDay) break;

      const entry = Number(c.curr.open);

      // skip consolidation
      if (isConsolidating) {
        // mark avoid zone visually
        planned.push({ skip: true, reason: 'pattern/consolidation' });
        continue;
      }

      // proximity to manual or auto S/R
      const proxTol = 0.006; // 0.6%
      const nearManual = manualZones.some(z => Math.abs(entry - Number(z.price)) / entry <= proxTol);
      const nearAuto = autoSupports.some(p => Math.abs(entry - p) / entry <= proxTol);
      if (nearManual || nearAuto) {
        planned.push({ skip: true, reason: nearManual ? 'near manual S/R' : 'near auto S/R' });
        continue;
      }

      // skip tiny candles
      const candleRangePct = (c.curr.high - c.curr.low) / c.curr.open;
      if (candleRangePct < 0.002) { planned.push({ skip: true, reason: 'small candle' }); continue; }

      // accept trade: compute TP and check if TP hit in next 12 15m candles
      const entryTime = c.curr.time;
      const tpPrice = entry * (1 + tpPct);
      let tpHit = false, tpTime = null;
      for (let j = c.idx + 1; j < Math.min(sData.length, c.idx + 13); j++) {
        if (sData[j].high >= tpPrice) { tpHit = true; tpTime = sData[j].time; break; }
      }
      const rec = { day: nowLocalDateString(entryTime), entryTime, entryPrice: entry, tpPrice, tpTime: tpHit ? tpTime : null, realized: tpHit ? (tpPrice - entry) : 0 };
      planned.push({ skip: false, rec });
      tradesToday++;
    }

    // save accepted planned trades
    planned.forEach(p => { if (!p.skip && p.rec) saveTradeSim(p.rec); });

    // compute today's profit
    const saved = getSavedTrades();
    const todays = saved.filter(x => x.day === today).slice(-maxTradesPerDay);
    let sumProfit = 0;
    todays.forEach(t => { sumProfit += (t.tpPrice ? (t.tpPrice - t.entryPrice) : Math.max(0, (t.tpPrice - t.entryPrice))); });

    // Update UI: summary, emoji, reason, progress bar, trade log
    if (statusEl) {
      const candCount = candidates.length;
      const plannedCount = planned.filter(p => !p.skip).length;
      statusEl.innerHTML = `
        <div style="font-weight:700">Rules: 15m opposite-candle break → BUY. Max ${maxTradesPerDay}/day. TP ${Math.round(tpPct*100)}%.</div>
        <div style="margin-top:6px">Candidates (15m): ${candCount} · New planned: ${plannedCount} · Consolidation: ${isConsolidating ? 'Yes' : 'No'}</div>
      `;
    }
    if (emojiEl) {
      if (planned.some(p => !p.skip)) emojiEl.textContent = "🟢 Buy signal(s) detected! — check chart for arrows.";
      else if (isConsolidating) emojiEl.textContent = "⚠️ Pattern / consolidation — avoiding entries.";
      else emojiEl.textContent = "⏳ Waiting for opposite-candle break on 15m.";
    }
    if (reasonEl) {
      const reasons = [];
      planned.slice(0,3).forEach((p,i) => {
        if (p.skip) reasons.push(`${i+1}. ❌ ${p.reason}`);
        else reasons.push(`${i+1}. ✅ Planned entry ${p.rec ? p.rec.entryPrice : ''} TP ${p.rec ? p.rec.tpPrice.toFixed(2) : ''}`);
      });
      reasonEl.textContent = reasons.length ? reasons.join(' · ') : 'No signals right now.';
    }

    // update progress and trade count
    updateStrategySummaryUI(saved, sumProfit);
    renderTradeLog();

    // visual markers: mark avoid zones (if consolidation or near S/R) with flags and buy arrows for planned trades
    const avoidMarkers = [];
    if (isConsolidating) {
      // place a warning flag at latest candle time
      avoidMarkers.push({
        time: sData[sData.length - 1].time,
        position: "aboveBar",
        color: "#f59e0b",
        shape: "flag",
        text: "⚠️ Consolidation"
      });
    }
    // markers for near S/R (manual or auto)
    manualZones.forEach(z => {
      avoidMarkers.push({
        time: sData[sData.length - 1].time,
        position: z.type === "support" ? "belowBar" : "aboveBar",
        color: z.type === "support" ? "#06b6d4" : "#fb923c",
        shape: "circle",
        text: `${z.type.toUpperCase()} ${Number(z.price).toFixed(2)}`
      });
    });
    autoSupports.forEach(p => {
      avoidMarkers.push({
        time: sData[sData.length - 1].time,
        position: "belowBar",
        color: "#94a3b8",
        shape: "square",
        text: `AutoSUP ${Number(p).toFixed(0)}`
      });
    });

    // existing saved trades markers
    const tradeMarkers = createTradeMarkersFromTrades(saved);
    // trend arrows and merge
    drawTrendArrows(chartData, manualZones, autoSupports, saved);

    // finally ensure price lines are drawn (manual + auto)
    drawPriceLines(manualZones, autoSupports);
  }

  // --- AI & news (kept same style) ---
  async function loadNews() {
    if (!newsEl) return;
    newsEl.innerHTML = "Loading news…";
    try {
      const res = await safeFetchJson(`${API_BASE}/api/btc_news`);
      if (!Array.isArray(res) || res.length === 0) {
        newsEl.innerHTML = `<div class="news-item" style="background:#374151">No news</div>`;
        return;
      }
      newsEl.innerHTML = "";
      const tzName = currentTZ === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : currentTZ;
      res.slice(0, 10).forEach(n => {
        const a = document.createElement("a");
        a.className = "news-item";
        a.href = n.link || "#";
        a.target = "_blank";
        a.style.background = n.sentiment === "positive" ? "#064e3b" : n.sentiment === "negative" ? "#7f1d1d" : "#0f1724";
        const dateStr = n.pubDate ? new Date(n.pubDate).toLocaleString([], { timeZone: tzName }) : "";
        a.innerHTML = `<strong>${safeText(n.title)}</strong><br><small style="opacity:0.85">${dateStr}</small>`;
        newsEl.appendChild(a);
      });
    } catch (err) {
      console.error("loadNews:", err);
      newsEl.innerHTML = `<div class="news-item" style="background:#374151">Failed to load news</div>`;
    }
  }

  async function loadAI() {
    if (!aiText || !aiFill) return;
    aiText.textContent = "Loading prediction...";
    aiReason.textContent = "";
    aiFill.style.width = "0%";
    try {
      const tz = currentTZ === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : currentTZ;
      const url = `${API_BASE}/api/predict?interval=${encodeURIComponent(currentInterval)}&timezone=${encodeURIComponent(tz)}`;
      const res = await safeFetchJson(url);
      const p = (res && res.prediction) ? res.prediction : null;
      if (!p) throw new Error("No prediction");
      const pct = Math.max(0, Math.min(100, Math.round((p.prob || 0.5) * 100)));
      aiFill.style.width = `${pct}%`;
      aiText.textContent = `${(p.label || "neutral").toUpperCase()} · ${pct}%`;
      aiReason.textContent = p.reason || "";
      if (p.label === "bullish") aiFill.style.background = "linear-gradient(90deg,#00ff88,#06b6d4)";
      else if (p.label === "bearish") aiFill.style.background = "linear-gradient(90deg,#ff7b7b,#ff4444)";
      else aiFill.style.background = "linear-gradient(90deg,#94a3b8,#64748b)";
    } catch (err) {
      console.error("loadAI:", err);
      aiText.textContent = "AI unavailable";
      if (aiReason) aiReason.textContent = "";
      if (aiFill) aiFill.style.width = "0%";
    }
  }

  function setLastPrice(v) { if (lastPriceEl) lastPriceEl.textContent = v; }
  function setProfit(v) { if (profitEl) profitEl.textContent = v; }

  // load candles for chart and run strategy
  async function loadCandles() {
    try {
      const tz = currentTZ === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : currentTZ;
      const url = `${API_BASE}/api/candles?interval=${encodeURIComponent(currentInterval)}&timezone=${encodeURIComponent(tz)}`;
      const data = await safeFetchJson(url);
      if (!Array.isArray(data) || data.length === 0) {
        candles.setData([]);
        setLastPrice("No data");
        return;
      }
      const chartData = data.map(d => ({
        time: Math.floor(Number(d.time)),
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close)
      })).sort((a, b) => a.time - b.time);
      candles.setData(chartData);
      const last = chartData[chartData.length - 1];
      if (last) setLastPrice(`Last: $${Number(last.close).toFixed(2)} USD`);

      // strategy (uses 15m fetch internally)
      await applyStrategy(chartData);

      // refresh AI & news
      loadAI();
      loadNews();
      renderZonesListUI();
    } catch (err) {
      console.error("loadCandles:", err);
      setLastPrice("Chart load error");
    }
  }

  // intervals UI wiring
  if (intervalsContainer) {
    intervalsContainer.addEventListener("click", ev => {
      const btn = ev.target.closest("button[data-interval]");
      if (!btn) return;
      intervalsContainer.querySelectorAll("button[data-interval]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const iv = btn.dataset.interval;
      if (iv && iv !== currentInterval) {
        currentInterval = iv;
        loadCandles();
      }
    });
  }

  // timezone select wiring
  if (tzSelect) {
    function populateTZ() {
      const zones = ["auto","UTC","Asia/Kolkata","Asia/Tokyo","Europe/London","America/New_York"];
      tzSelect.innerHTML = "";
      zones.forEach(z => {
        const o = document.createElement("option");
        o.value = z;
        o.textContent = z === "auto" ? "Auto (browser)" : z;
        tzSelect.appendChild(o);
      });
      tzSelect.value = "auto";
    }
    populateTZ();
    tzSelect.addEventListener("change", () => {
      currentTZ = tzSelect.value;
      chart.applyOptions({ timeScale: { timeFormatter: tzTimeFormatterFor(currentTZ) } });
      loadCandles();
      loadNews();
    });
    chart.applyOptions({ timeScale: { timeFormatter: tzTimeFormatterFor(currentTZ) } });
  }

  // theme toggle
  if (themeBtn) {
    let dark = true;
    themeBtn.addEventListener("click", () => {
      dark = !dark;
      if (!dark) {
        document.documentElement.style.setProperty('--bg', '#f8fafc');
        document.documentElement.style.setProperty('--panel', '#e2e8f0');
        document.body.style.color = '#0b1220';
        themeBtn.textContent = '☀️';
      } else {
        document.documentElement.style.setProperty('--bg', '#0d1117');
        document.documentElement.style.setProperty('--panel', '#111827');
        document.body.style.color = '#fff';
        themeBtn.textContent = '🌙';
      }
      loadCandles();
    });
  }

  if (refreshAiBtn) refreshAiBtn.addEventListener("click", loadAI);

  // initial load + polling
  loadCandles();
  setInterval(() => { loadCandles(); }, 20000);

})();
