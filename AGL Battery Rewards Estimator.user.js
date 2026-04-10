// ==UserScript==
// @name         AGL Battery Rewards Estimator
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Calculates electricity cost, FiT revenue, and net cost from AGL usage page
// @author       jia11-501ng
// @match        https://myaccount.agl.com.au/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /**
   * TARIFF CONSTANTS
   * These values should be updated if your AGL plan changes.
   */

  // ─── Tariff Constants ───────────────────────────
  const SUPPLY_CHARGE_CENTS_PER_DAY = 160.655;  // c/day
  const PEAK_RATE_CENTS_PER_KWH = 50.38;        // c/kWh
  const SHOULDER_RATE_CENTS_PER_KWH = 19.998;   // c/kWh
  const OFFPEAK_RATE_CENTS_PER_KWH = 19.998;    // c/kWh
  const CL31_RATE_CENTS_PER_KWH = 17.666;       // c/kWh
  const CL31_SUPPLY_CENTS_PER_DAY = 0;          // c/day
  const SOLAR_FIT_CENTS_PER_KWH = 3;            // c/kWh

  // Adjustments for non-eligible usage/export
  // Use these to exclude specific amounts from the daily calculations (e.g. export outside reward window)
  const DAILY_EXPORT_EXCLUDE_KWH = 1.5;         // kWh to subtract from daily export

  // Feed-in tariff logic:
  // The page already shows the $ credit AGL gives.
  // We extract the dollar value directly from the page to stay accurate to AGL's calculations.

  // Gift card tiers (min kWh inclusive, max kWh inclusive, card value $)
  const GIFT_CARD_TIERS = [
    [1, 40, 10],
    [40.1, 80, 20],
    [80.1, 120, 30],
    [120.1, 160, 40],
    [160.1, 200, 50],
    [200.1, 240, 60],
    [240.1, 280, 70],
    [280.1, 320, 80],
    [320.1, 360, 90],
    [360.1, 400, 100],
    [400.1, 440, 110],
    [440.1, 480, 120],
    [480.1, 520, 130],
    [520.1, 560, 140],
    [560.1, 600, 150],
    [600.1, 640, 160],
    [640.1, 680, 170],
    [680.1, 720, 180],
    [720.1, 760, 190],
    [760.1, 800, 200],
    [800.1, 840, 210],
    [840.1, 880, 220],
    [880.1, 920, 230],
    [920.1, 960, 240],
    [960.1, 1000, 250],
    [1000.1, 1040, 260],
    [1040.1, 1080, 270],
    [1080.1, 1120, 280],
    [1120.1, 1160, 290],
    [1160.1, 1200, 300],
    [1200.1, 1240, 310],
    [1240.1, 1280, 320],
    [1280.1, 1320, 330],
    [1320.1, 1360, 340],
    [1360.1, 1400, 350],
    [1400.1, 1440, 360],
    [1440.1, 1480, 370],
    [1480.1, 1520, 380],
    [1520.1, 1560, 390],
    [1560.1, Infinity, 400],
  ];

  /**
   * HELPERS
   */

  /**
   * Extracts the total number of days in the billing period from the URL or page header.
   */
  function getDaysFromBillPeriod() {
    // -- Primary: billPeriod URL param (e.g. 2026-03-01%2F2026-05-29) --
    const params = new URLSearchParams(window.location.search);
    let billPeriod = params.get('billPeriod');
    if (billPeriod) {
      billPeriod = decodeURIComponent(billPeriod); // handle %252F → %2F → /
      const parts = billPeriod.split('/');
      if (parts.length === 2) {
        const start = new Date(parts[0]);
        const end = new Date(parts[1]);
        if (!isNaN(start) && !isNaN(end))
          return Math.round((end - start) / (1000 * 60 * 60 * 24));
      }
    }

    // -- Fallback: parse h2 text like "01 March to 29 May 2026" --
    const h2 = document.querySelector(
      'h2.usage-and-solar-nav__context.visible-lg, h2.usage-and-solar-nav__context'
    );
    if (h2) {
      const text = h2.textContent.trim();
      // Match "01 March to 29 May 2026" or "1 March to 29 May 2026"
      const m = text.match(
        /(\d{1,2})\s+(\w+)\s+(?:to|-)\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i
      );
      if (m) {
        const [, d1, mo1, d2, mo2, yr] = m;
        const start = new Date(`${d1} ${mo1} ${yr}`);
        const end = new Date(`${d2} ${mo2} ${yr}`);
        if (!isNaN(start) && !isNaN(end))
          return Math.round((end - start) / (1000 * 60 * 60 * 24));
      }
    }
    return null;
  }

  /**
   * Returns the dollar value of the gift card for a given amount of solar export (kWh).
   */
  function getGiftCardTier(kwh) {
    if (kwh < 1) return null;
    for (const [min, max, value] of GIFT_CARD_TIERS) {
      if (kwh >= min && kwh <= max) return value;
    }
    return null;
  }

  /**
   * Returns a string representing the kWh range for the current gift card tier.
   */
  function getGiftCardTierRange(kwh) {
    if (kwh < 1) return null;
    for (const [min, max, value] of GIFT_CARD_TIERS) {
      if (kwh >= min && kwh <= max) return `${min}-${max} kWh`;
    }
    return null;
  }

  /**
   * Parses a currency string (e.g., "$123.45") into a float.
   */
  function parseMoney(text) {
    if (!text) return null;
    const m = text.match(/\$?\s*([\d,]+\.?\d*)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }

  /**
   * Parses a kWh string (e.g., "123.45 kWh") into a float.
   */
  function parseKwh(text) {
    if (!text) return null;
    const m = text.match(/([\d,]+\.?\d*)\s*kWh/i);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }

  /**
   * DOM SELECTORS
   * The rendered DOM uses these Angular component classes. These may change if AGL updates their dashboard.
   * - .usage-and-solar-info__item-summary: The main card container for usage/solar totals.
   * - .usage-and-solar-info__item-summary-content-primary: The dollar value ($) on the card.
   * - .usage-and-solar-info__item-summary-content-secondary: The energy value (kWh) on the card.
   */

  /**
   * Extracts the number of days left in the billing cycle from a text string.
   */
  function parseDaysLeft(text) {
    if (!text) return null;
    const m = text.match(/(\d+)\s*days?\s*left/i);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * DOM EXTRACTION
   * Scrapes the AGL usage page for electricity bought, solar sold, and cycle progress.
   */
  function extractData() {
    const cards = document.querySelectorAll('.usage-and-solar-info__item-summary');
    const result = {
      boughtDollars: null,
      boughtKwh: null,
      soldDollars: null,
      soldKwh: null,
      daysLeft: null,
    };

    cards.forEach(card => {
      const titleEl = card.querySelector('.usage-and-solar-info__item-summary-header-title.hidden-xs');
      if (!titleEl) return;
      const title = titleEl.textContent.trim().toLowerCase();

      const primaryEl = card.querySelector('.usage-and-solar-info__item-summary-content-primary');
      const secondaryEl = card.querySelector('.usage-and-solar-info__item-summary-content-secondary span.hidden-xs');

      if (title.includes('electricity bought') || title.includes('bought from grid')) {
        result.boughtDollars = parseMoney(primaryEl?.textContent);
        result.boughtKwh = parseKwh(secondaryEl?.textContent);
      } else if (title.includes('solar electricity sold') || title.includes('sold to grid')) {
        result.soldDollars = parseMoney(primaryEl?.textContent);
        result.soldKwh = parseKwh(secondaryEl?.textContent);
      } else if (title.includes('net usage')) {
        // e.g. "64 days left in cycle"
        result.daysLeft = parseDaysLeft(secondaryEl?.textContent);
      }
    });

    return result;
  }

  /**
   * UI RENDERING
   * Creates a modern floating panel fixed at the bottom right.
   * Using flat design with subtle gradients and glassmorphism elements.
   */

  /**
   * UI RENDERING
   * Creates and displays the summary panel with calculations and forecasts.
   */
  function renderPanel(data) {
    // Remove any existing panel
    document.getElementById('agl-calc-panel')?.remove();

    const {
      days,
      daysElapsed,
      daysLeft,
      boughtDollars,
      boughtKwh,
      supplyChargeDollars,
      totalCostDollars,
      soldKwh,
      soldDollars,       // AGL's own feed-in credit shown on page
      giftCardValue,
      totalRevenueDollars,
      netCostDollars,
      // Forecast
      fcstBoughtDollars,
      fcstSupplyDollars,
      fcstTotalCostDollars,
      fcstSoldKwh,
      fcstFeedInDollars,
      fcstGiftCardValue,
      fcstTotalRevenueDollars,
      fcstNetCostDollars,
      fcstRawSoldKwh,
      fcstRawFeedInDollars,
      warnings,
      pageData,
    } = data;

    const isProfit = netCostDollars !== null && netCostDollars <= 0;
    const netClass = netCostDollars !== null ? (isProfit ? 'profit' : 'loss') : '';
    const netLabel = netCostDollars !== null ? (isProfit ? '🤭 Estimated Credit' : '😟 Estimated Owning') : '—';
    const netFormatted = netCostDollars !== null
      ? (isProfit ? '+$' : '-$') + Math.abs(netCostDollars).toFixed(2)
      : 'N/A';

    const fcstIsProfit = fcstNetCostDollars !== null && fcstNetCostDollars <= 0;
    const fcstNetClass = fcstNetCostDollars !== null ? (fcstIsProfit ? 'profit' : 'loss') : '';
    const fcstNetLabel = fcstNetCostDollars !== null ? (fcstIsProfit ? '🤭 Projected credit' : '😟 Projected owning') : '—';
    const fcstNetFormatted = fcstNetCostDollars !== null
      ? (fcstIsProfit ? '+$' : '-$') + Math.abs(fcstNetCostDollars).toFixed(2)
      : 'N/A';

    const fmt = v => v !== null ? '$' + v.toFixed(2) : 'N/A';
    const fmtKwh = v => v !== null ? v.toFixed(2) + ' kWh' : 'N/A';

    const panel = document.createElement('div');
    panel.id = 'agl-calc-panel';
    panel.innerHTML = `
<style>
  #agl-calc-panel *{box-sizing:border-box;margin:0;padding:0}
  #agl-calc-panel{
    position:fixed;bottom:24px;right:24px;width:400px;
    max-height:calc(100vh - 48px);
    display:flex;flex-direction:column;
    background:linear-gradient(150deg,#00157a 0%,#001cb0 55%,#0028cc 100%);
    color:#fff;border-radius:18px;
    box-shadow:0 12px 40px rgba(0,20,140,.55),0 2px 10px rgba(0,0,0,.3);
    font-family:'Open Sans','Titillium Web',sans-serif;font-size:12px;
    z-index:999999;overflow:hidden;
    animation:aglSlide .35s cubic-bezier(.22,1,.36,1);
  }
  @keyframes aglSlide{from{transform:translateY(30px) scale(.96);opacity:0}to{transform:none;opacity:1}}

  /* Header — pinned */
  #agl-calc-panel .ap-hdr{
    flex-shrink:0;display:flex;align-items:center;justify-content:space-between;
    padding:11px 14px 9px;border-bottom:1px solid rgba(255,255,255,.14);
  }
  #agl-calc-panel .ap-hdr-title{font-size:13px;font-weight:700;letter-spacing:.4px;color:#7feff6;cursor:pointer;transition:opacity .15s}
  #agl-calc-panel .ap-hdr-title:hover{opacity:.8}
  #agl-calc-panel .ap-hdr-sub{font-size:10px;color:rgba(255,255,255,.5);margin-top:1px}
  #agl-calc-panel .ap-hdr-btns{display:flex;align-items:center;gap:4px}
  #agl-calc-panel .ap-close,#agl-calc-panel .ap-toggle{
    background:none;border:none;color:rgba(255,255,255,.5);cursor:pointer;
    font-size:16px;line-height:1;padding:2px 5px;border-radius:50%;
    transition:color .15s,background .15s;
  }
  #agl-calc-panel .ap-close:hover,#agl-calc-panel .ap-toggle:hover{color:#fff;background:rgba(255,255,255,.12)}

  /* Body */
  #agl-calc-panel .ap-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 12px 12px}
  #agl-calc-panel .ap-body::-webkit-scrollbar{width:3px}
  #agl-calc-panel .ap-body::-webkit-scrollbar-track{background:transparent}
  #agl-calc-panel .ap-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:99px}

  /* Warnings */
  #agl-calc-panel .ap-warn{
    background:rgba(255,200,50,.15);border:1px solid rgba(255,200,50,.4);
    border-radius:8px;padding:6px 9px;color:#ffe08a;font-size:10px;line-height:1.5;margin-bottom:8px;
  }

  /* ── Two-column pane layout ── */
  #agl-calc-panel .ap-cols{
    display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:7px;
  }
  #agl-calc-panel .ap-pane{
    background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);
    border-radius:11px;padding:8px 10px;
  }
  #agl-calc-panel .ap-pane-title{
    font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
    color:rgba(255,255,255,.4);margin-bottom:6px;
  }
  #agl-calc-panel .ap-row{
    display:flex;justify-content:space-between;align-items:baseline;
    padding:2px 0;color:rgba(255,255,255,.8);
  }
  #agl-calc-panel .ap-row-lbl{flex:1;padding-right:4px;font-size:11px;line-height:1.3}
  #agl-calc-panel .ap-row-lbl small{display:block;font-size:9px;color:rgba(255,255,255,.38);margin-top:1px}
  #agl-calc-panel .ap-row-val{font-size:11px;font-weight:600;white-space:nowrap}
  #agl-calc-panel .ap-divider{border:none;border-top:1px solid rgba(255,255,255,.1);margin:5px 0 3px}
  #agl-calc-panel .ap-row.ap-total .ap-row-lbl{font-weight:700;color:#fff;font-size:11px}
  #agl-calc-panel .ap-row.ap-total .ap-row-val{font-weight:700;color:#fff;font-size:12px}

  /* ── Net result bar ── */
  #agl-calc-panel .ap-net{
    display:flex;justify-content:space-between;align-items:center;
    border-radius:10px;padding:8px 12px;margin-bottom:7px;
  }
  #agl-calc-panel .ap-net.profit{background:rgba(0,210,110,.15);border:1px solid rgba(0,220,120,.3)}
  #agl-calc-panel .ap-net.loss  {background:rgba(255,70,70,.13); border:1px solid rgba(255,100,100,.3)}
  #agl-calc-panel .ap-net-lbl{font-size:11px;font-weight:700;color:rgba(255,255,255,.85)}
  #agl-calc-panel .ap-net-val{font-size:20px;font-weight:800;letter-spacing:-.5px}
  #agl-calc-panel .ap-net.profit .ap-net-val{color:#4aff9a}
  #agl-calc-panel .ap-net.loss   .ap-net-val{color:#ff7070}

  /* ── Forecast section ── */
  #agl-calc-panel .ap-fcst-wrap{
    background:rgba(127,239,246,.06);border:1px solid rgba(127,239,246,.2);
    border-radius:11px;padding:8px 10px;margin-bottom:7px;
  }
  #agl-calc-panel .ap-fcst-hdr{
    display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;
  }
  #agl-calc-panel .ap-fcst-title{
    font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
    color:rgba(127,239,246,.7);
  }
  #agl-calc-panel .ap-fcst-days{font-size:9px;color:rgba(255,255,255,.4)}
  #agl-calc-panel .ap-progress-bar-wrap{
    height:3px;background:rgba(255,255,255,.1);border-radius:99px;
    margin-bottom:7px;overflow:hidden;
  }
  #agl-calc-panel .ap-progress-bar{
    height:100%;border-radius:99px;
    background:linear-gradient(90deg,#7feff6,#4aff9a);
    transition:width .6s ease;
  }
  #agl-calc-panel .ap-fcst-wrap .ap-pane{
    background:rgba(127,239,246,.05);border-color:rgba(127,239,246,.15);
  }
  #agl-calc-panel .ap-fcst-wrap .ap-row{color:rgba(255,255,255,.7)}
  #agl-calc-panel .ap-fcst-wrap .ap-row-lbl small{color:rgba(127,239,246,.35)}

  /* ── Tariff footer — collapsed by default ── */
  #agl-calc-panel .ap-foot{border-top:1px solid rgba(255,255,255,.1);padding-top:8px;margin-top:2px}
  #agl-calc-panel .ap-foot-toggle{
    display:flex;align-items:center;justify-content:space-between;
    cursor:pointer;user-select:none;padding:0 0 4px;
  }
  #agl-calc-panel .ap-foot-title{
    font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
    color:rgba(255,255,255,.28);
  }
  #agl-calc-panel .ap-foot-chevron{
    font-size:9px;color:rgba(255,255,255,.22);
    transition:transform .22s;display:inline-block;transform:rotate(-90deg);
  }
  #agl-calc-panel .ap-foot.open .ap-foot-chevron{transform:rotate(0deg)}
  #agl-calc-panel .ap-tariff{
    display:grid;grid-template-columns:1fr auto;gap:1px 8px;
    overflow:hidden;transition:max-height .3s ease,opacity .25s;
    max-height:0;opacity:0;
  }
  #agl-calc-panel .ap-foot.open .ap-tariff{max-height:260px;opacity:1}
  #agl-calc-panel .ap-tariff-lbl{font-size:9px;color:rgba(255,255,255,.38);line-height:1.7}
  #agl-calc-panel .ap-tariff-lbl small{display:block;font-size:8px;color:rgba(255,255,255,.2);line-height:1.3}
  #agl-calc-panel .ap-tariff-val{font-size:9px;font-weight:600;color:rgba(255,255,255,.5);text-align:right;white-space:nowrap;line-height:1.7}
  #agl-calc-panel .ap-tariff-sep{grid-column:1/-1;border:none;border-top:1px solid rgba(255,255,255,.06);margin:2px 0}
  #agl-calc-panel .ap-fit-ctrl{cursor:pointer;border-radius:8px;transition:background .2s;margin:0 -4px;padding:0 4px}
  #agl-calc-panel .ap-fit-ctrl:hover{background:rgba(255,255,255,.05)}
  #agl-calc-panel .ap-fit-adj{max-height:0;overflow:hidden;transition:all .25s ease;opacity:0}
  #agl-calc-panel .ap-fit-ctrl.open .ap-fit-adj{max-height:40px;opacity:1;padding-bottom:4px}
  #agl-calc-panel .ap-fit-chevron{display:inline-block;transition:transform .22s;font-size:8px;opacity:0.3;vertical-align:middle;margin-top:-2px}
  #agl-calc-panel .ap-fit-ctrl.open .ap-fit-chevron{transform:rotate(180deg)}
</style>

<div class="ap-hdr">
  <div>
    <div class="ap-hdr-title">⚡ AGL Battery Rewards Estimator</div>
    <div class="ap-hdr-sub">${days !== null ? days + '-day period' : 'Period unknown'}${daysElapsed !== null ? ' · day ' + daysElapsed + ' of ' + days : ''}</div>
  </div>
  <div class="ap-hdr-btns">
    <button class="ap-toggle" title="Show / Hide">👁</button>
    <button class="ap-close" title="Close">✕</button>
  </div>
</div>

<div class="ap-body">
  ${warnings.length ? `<div class="ap-warn">⚠ ${warnings.join('<br>⚠ ')}</div>` : ''}

  <!-- ── Cost + Revenue side by side ── -->
  <div class="ap-cols">

    <div class="ap-pane">
      <div class="ap-pane-title">💸 Cost</div>
      <div class="ap-row">
        <span class="ap-row-lbl">Grid usage<small>${fmtKwh(boughtKwh)}, ${fmtKwh(boughtKwh / daysElapsed)}/d</small></span>
        <span class="ap-row-val">${fmt(boughtDollars)}</span>
      </div>
      <div class="ap-row">
        <span class="ap-row-lbl">Supply<small>${daysElapsed !== null ? daysElapsed + 'd × ' + SUPPLY_CHARGE_CENTS_PER_DAY + 'c' : '—'}</small></span>
        <span class="ap-row-val">${fmt(supplyChargeDollars)}</span>
      </div>
      <div class="ap-divider"></div>
      <div class="ap-row ap-total">
        <span class="ap-row-lbl">Total</span>
        <span class="ap-row-val">${fmt(totalCostDollars)}</span>
      </div>
    </div>

    <div class="ap-pane">
      <div class="ap-pane-title">☀️ Revenue</div>
      
      <div class="ap-row">
        <span class="ap-row-lbl">Feed-in<small>${fmtKwh(pageData.soldKwh)}, ${fmtKwh(pageData.soldKwh / daysElapsed)}/d</small></span>
        <span class="ap-row-val">${fmt(pageData.soldDollars)}</span>
      </div>

      <div class="${DAILY_EXPORT_EXCLUDE_KWH > 0 ? 'ap-fit-ctrl' : ''}" id="ap-gc-ctrl">
        <div class="ap-row">
          <span class="ap-row-lbl">Gift card ${DAILY_EXPORT_EXCLUDE_KWH > 0 ? '<span class="ap-fit-chevron">▾</span>' : ''}<small>${giftCardValue !== null ? getGiftCardTierRange(soldKwh) : '—'}</small></span>
          <span class="ap-row-val">${giftCardValue !== null ? '$' + giftCardValue + '.00' : 'N/A'}</span>
        </div>
        ${DAILY_EXPORT_EXCLUDE_KWH > 0 && daysElapsed !== null ? `
        <div class="ap-fit-adj" id="ap-gc-adj">
          <div class="ap-row" style="opacity:0.6; font-size:10px; padding-top:0">
            <span class="ap-row-lbl">Excluded<small>${DAILY_EXPORT_EXCLUDE_KWH} kWh/d adjustment</small></span>
            <span class="ap-row-val">-${(daysElapsed * DAILY_EXPORT_EXCLUDE_KWH).toFixed(1)} kWh</span>
          </div>
        </div>
        ` : ''}
      </div>
      <div class="ap-divider"></div>
      <div class="ap-row ap-total">
        <span class="ap-row-lbl">Adjusted Total</span>
        <span class="ap-row-val">${fmt(totalRevenueDollars)}</span>
      </div>
    </div>

  </div>

  <!-- ── Net ── -->
  ${netCostDollars !== null ? `
  <div class="ap-net ${netClass}">
    <div class="ap-net-lbl">${netLabel}</div>
    <div class="ap-net-val">${netFormatted}</div>
  </div>
  ` : `<div class="ap-warn">Cannot calculate net cost — some data missing.</div>`}

  <!-- ── Forecast ── -->
  ${daysElapsed !== null && days !== null ? `
  <div class="ap-fcst-wrap">
    <div class="ap-fcst-hdr">
      <span class="ap-fcst-title">📈 End-of-Quarter Forecast</span>
      <span class="ap-fcst-days">Day ${daysElapsed}/${days} · ${daysLeft} left</span>
    </div>
    <div class="ap-progress-bar-wrap">
      <div class="ap-progress-bar" style="width:${Math.round(daysElapsed / days * 100)}%"></div>
    </div>

    <div class="ap-cols" style="margin-bottom:0">

      <div class="ap-pane">
        <div class="ap-pane-title">Proj. Cost</div>
        <div class="ap-row">
          <span class="ap-row-lbl">Grid<small>${daysElapsed && boughtDollars ? '$' + (boughtDollars / daysElapsed).toFixed(3) + '/d' : '—'}</small></span>
          <span class="ap-row-val">${fmt(fcstBoughtDollars)}</span>
        </div>
        <div class="ap-row">
          <span class="ap-row-lbl">Supply<small>${days}d total</small></span>
          <span class="ap-row-val">${fmt(fcstSupplyDollars)}</span>
        </div>
        <div class="ap-divider"></div>
        <div class="ap-row ap-total">
          <span class="ap-row-lbl">Total</span>
          <span class="ap-row-val">${fmt(fcstTotalCostDollars)}</span>
        </div>
      </div>

      <div class="ap-pane">
        <div class="ap-pane-title">Proj. Revenue</div>
        
        <div class="ap-row">
          <span class="ap-row-lbl">Feed-in<small>${fcstRawSoldKwh ? fmtKwh(fcstRawSoldKwh) : '—'}</small></span>
          <span class="ap-row-val">${fmt(fcstRawFeedInDollars)}</span>
        </div>

        <div class="${DAILY_EXPORT_EXCLUDE_KWH > 0 ? 'ap-fit-ctrl' : ''}" id="ap-gc-fcst-ctrl">
          <div class="ap-row">
            <span class="ap-row-lbl">Gift card ${DAILY_EXPORT_EXCLUDE_KWH > 0 ? '<span class="ap-fit-chevron">▾</span>' : ''}<small>${fcstGiftCardValue !== null ? getGiftCardTierRange(fcstSoldKwh) + ' tier' : '—'}</small></span>
            <span class="ap-row-val">${fcstGiftCardValue !== null ? '$' + fcstGiftCardValue + '.00' : 'N/A'}</span>
          </div>
          ${DAILY_EXPORT_EXCLUDE_KWH > 0 && fcstRawSoldKwh !== null ? `
          <div class="ap-fit-adj" id="ap-gc-fcst-adj">
            <div class="ap-row" style="opacity:0.6; font-size:10px; padding-top:0">
              <span class="ap-row-lbl">Excluded<small>${DAILY_EXPORT_EXCLUDE_KWH} kWh/d adjustment</small></span>
              <span class="ap-row-val">-${(days * DAILY_EXPORT_EXCLUDE_KWH).toFixed(1)} kWh</span>
            </div>
          </div>
          ` : ''}
        </div>

        <div class="ap-divider"></div>
        <div class="ap-row ap-total">
          <span class="ap-row-lbl">Adjusted Total</span>
          <span class="ap-row-val">${fmt(fcstTotalRevenueDollars)}</span>
        </div>
      </div>

    </div>
  </div>
  ${fcstNetCostDollars !== null ? `
  <div class="ap-net ${fcstNetClass}" style="margin-bottom:7px">
    <div class="ap-net-lbl">${fcstNetLabel}</div>
    <div class="ap-net-val">${fcstNetFormatted}</div>
  </div>
  ` : ''}
  ` : ''}

  <!-- ── Tariff (collapsed by default) ── -->
  <div class="ap-foot" id="ap-foot">
    <div class="ap-foot-toggle" id="ap-foot-toggle">
      <span class="ap-foot-title">Residential TOU &amp; CL31 Tariff</span>
      <span class="ap-foot-chevron">▾</span>
    </div>
    <div class="ap-tariff">
      <span class="ap-tariff-lbl">Daily Supply<small>every day</small></span>
      <span class="ap-tariff-val">${SUPPLY_CHARGE_CENTS_PER_DAY}c/day</span>
      <hr class="ap-tariff-sep">
      <span class="ap-tariff-lbl">Peak<small>4 pm – 9 pm</small></span>
      <span class="ap-tariff-val">${PEAK_RATE_CENTS_PER_KWH}c/kWh</span>
      <span class="ap-tariff-lbl">Shoulder<small>9 pm – 9 am</small></span>
      <span class="ap-tariff-val">${SHOULDER_RATE_CENTS_PER_KWH}c/kWh</span>
      <span class="ap-tariff-lbl">Off Peak<small>9 am – 4 pm</small></span>
      <span class="ap-tariff-val">${OFFPEAK_RATE_CENTS_PER_KWH}c/kWh</span>
      <hr class="ap-tariff-sep">
      <span class="ap-tariff-lbl">T31 Controlled Load<small>≥ 8 hrs/day</small></span>
      <span class="ap-tariff-val">${CL31_RATE_CENTS_PER_KWH}c/kWh</span>
      <span class="ap-tariff-lbl">CL31 Supply</span>
      <span class="ap-tariff-val">${CL31_SUPPLY_CENTS_PER_DAY}c/day</span>
      <hr class="ap-tariff-sep">
      <span class="ap-tariff-lbl">Solar Feed-in<small>excl. GST</small></span>
      <span class="ap-tariff-val">${SOLAR_FIT_CENTS_PER_KWH}c/kWh</span>
    </div>
  </div>

</div>
`;

    panel.querySelector('.ap-close').addEventListener('click', () => panel.remove());

    // Show / hide body toggle
    const toggleBtn = panel.querySelector('.ap-toggle');
    const hdrTitle = panel.querySelector('.ap-hdr-title');
    const body = panel.querySelector('.ap-body');
    const onToggle = () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      toggleBtn.title = hidden ? 'Hide' : 'Show';
      toggleBtn.textContent = hidden ? '👁' : '🙈';
    };
    toggleBtn.addEventListener('click', onToggle);
    hdrTitle.addEventListener('click', onToggle);

    // Collapse / expand tariff footer
    const footToggle = panel.querySelector('#ap-foot-toggle');
    const foot = panel.querySelector('#ap-foot');
    footToggle.addEventListener('click', () => {
      foot.classList.toggle('open');
    });

    // Collapse / expand Gift Card adjustment
    const gcCtrl = panel.querySelector('#ap-gc-ctrl');
    if (gcCtrl) {
      gcCtrl.addEventListener('click', () => {
        gcCtrl.classList.toggle('open');
      });
    }

    const gcFcstCtrl = panel.querySelector('#ap-gc-fcst-ctrl');
    if (gcFcstCtrl) {
      gcFcstCtrl.addEventListener('click', () => {
        gcFcstCtrl.classList.toggle('open');
      });
    }

    document.body.appendChild(panel);
  }

  // ─── Main ──────────────────────────────────────────────────────────

  /**
   * MAIN LOGIC
   * Orchestrates data extraction, calculation, and UI updates.
   */
  function run() {
    const warnings = [];

    // 1. Total days from URL (with h2 fallback)
    const days = getDaysFromBillPeriod();
    if (days === null) warnings.push('Could not determine billing period — supply charge skipped.');

    // 2. Extract from DOM
    const pageData = extractData();
    let { boughtDollars, boughtKwh, soldDollars, soldKwh, daysLeft } = pageData;

    if (boughtDollars === null) warnings.push('"Electricity Bought From Grid" $ not found in page.');
    if (soldDollars === null) warnings.push('"Solar Electricity Sold to Grid" $ not found in page.');
    if (soldKwh === null) warnings.push('"Solar Electricity Sold to Grid" kWh not found in page.');
    if (daysLeft === null) warnings.push('Could not read "days left in cycle" — forecast unavailable.');

    // Log warnings for debugging (open console to view)
    if (warnings.length > 0) {
      console.warn('[AGL-Calc] Some data points missed:', warnings);
    }

    // 3. Days elapsed so far
    const daysElapsed = (days !== null && daysLeft !== null)
      ? Math.max(1, days - daysLeft)
      : null;

    // 4. Usage Adjustments (Exclude non-eligible/external components for Gift Card Tier)
    if (daysElapsed !== null) {
      if (soldKwh !== null && DAILY_EXPORT_EXCLUDE_KWH > 0) {
        const excludeKwh = daysElapsed * DAILY_EXPORT_EXCLUDE_KWH;
        // Adjust kWh for gift card tier calculation
        soldKwh = Math.max(0, soldKwh - excludeKwh);
        // Note: soldDollars (FiT revenue) remains raw because all export earns 3c/kWh
      }
    }

    // 5. Current period calculations
    const supplyChargeDollars = daysElapsed !== null
      ? parseFloat(((daysElapsed * SUPPLY_CHARGE_CENTS_PER_DAY) / 100).toFixed(2))
      : null;

    const totalCostDollars = (boughtDollars !== null && supplyChargeDollars !== null)
      ? parseFloat((boughtDollars + supplyChargeDollars).toFixed(2))
      : null;

    const giftCardValue = soldKwh !== null ? getGiftCardTier(soldKwh) : null;
    if (soldKwh !== null && giftCardValue === null) warnings.push('Solar kWh below 1 kWh — no gift card tier applicable.');

    const totalRevenueDollars = (soldDollars !== null)
      ? parseFloat(((soldDollars ?? 0) + (giftCardValue ?? 0)).toFixed(2))
      : (giftCardValue !== null ? giftCardValue : null);

    const netCostDollars = (totalCostDollars !== null && totalRevenueDollars !== null)
      ? parseFloat((totalCostDollars - totalRevenueDollars).toFixed(2))
      : null;

    // 5. End-of-quarter forecast (linear extrapolation from daily average)
    let fcstBoughtDollars = null;
    let fcstSupplyDollars = null;
    let fcstTotalCostDollars = null;
    let fcstSoldKwh = null;
    let fcstFeedInDollars = null;
    let fcstGiftCardValue = null;
    let fcstTotalRevenueDollars = null;
    let fcstNetCostDollars = null;
    let fcstRawSoldKwh = null;
    let fcstRawFeedInDollars = null;

    if (daysElapsed !== null && days !== null) {
      // Daily raw rates (before adjustment)
      const dailyRawSoldKwh = pageData.soldKwh !== null ? pageData.soldKwh / daysElapsed : null;
      const dailyRawFeedInDollars = pageData.soldDollars !== null ? pageData.soldDollars / daysElapsed : null;
      const dailyBoughtDollars = boughtDollars !== null ? boughtDollars / daysElapsed : null;

      // Projected raw totals
      fcstRawSoldKwh = dailyRawSoldKwh !== null ? parseFloat((dailyRawSoldKwh * days).toFixed(2)) : null;
      fcstRawFeedInDollars = dailyRawFeedInDollars !== null ? parseFloat((dailyRawFeedInDollars * days).toFixed(2)) : null;

      // Forecast Adjustments
      const fcstExcludeKwh = days * DAILY_EXPORT_EXCLUDE_KWH;
      const fcstExcludeDollars = (fcstExcludeKwh * SOLAR_FIT_CENTS_PER_KWH) / 100;

      fcstSoldKwh = fcstRawSoldKwh !== null ? Math.max(0, fcstRawSoldKwh - fcstExcludeKwh) : null;
      fcstFeedInDollars = fcstRawFeedInDollars; // All export earns 3c/kWh

      // Projected Costs
      fcstBoughtDollars = dailyBoughtDollars !== null ? parseFloat((dailyBoughtDollars * days).toFixed(2)) : null;
      fcstSupplyDollars = parseFloat(((days * SUPPLY_CHARGE_CENTS_PER_DAY) / 100).toFixed(2));
      fcstTotalCostDollars = (fcstBoughtDollars !== null) ? parseFloat((fcstBoughtDollars + fcstSupplyDollars).toFixed(2)) : null;

      // Projected Revenue
      fcstGiftCardValue = fcstSoldKwh !== null ? getGiftCardTier(fcstSoldKwh) : null;
      fcstTotalRevenueDollars = (fcstFeedInDollars !== null)
        ? parseFloat(((fcstFeedInDollars ?? 0) + (fcstGiftCardValue ?? 0)).toFixed(2))
        : (fcstGiftCardValue !== null ? fcstGiftCardValue : null);

      // Projected Net
      fcstNetCostDollars = (fcstTotalCostDollars !== null && fcstTotalRevenueDollars !== null)
        ? parseFloat((fcstTotalCostDollars - fcstTotalRevenueDollars).toFixed(2)) : null;
    }

    renderPanel({
      days,
      daysElapsed,
      daysLeft,
      boughtDollars,
      boughtKwh,
      supplyChargeDollars,
      totalCostDollars,
      soldKwh,
      soldDollars,
      giftCardValue,
      totalRevenueDollars,
      netCostDollars,
      fcstBoughtDollars,
      fcstSupplyDollars,
      fcstTotalCostDollars,
      fcstSoldKwh,
      fcstFeedInDollars,
      fcstGiftCardValue,
      fcstTotalRevenueDollars,
      fcstNetCostDollars,
      fcstRawSoldKwh,
      fcstRawFeedInDollars,
      warnings,
      pageData,
    });
  }

  /**
   * MutationObserver wrapper to wait for the Angular components to load data onto the page.
   */
  function waitForUsageCards(callback) {
    // Check immediately in case the DOM is already populated when the script runs
    const existing = document.querySelectorAll('.usage-and-solar-info__item-summary-content-primary');
    if (existing.length >= 2) {
      setTimeout(callback, 300);
      return;
    }

    const target = document.body;

    const observer = new MutationObserver(() => {
      const cards = document.querySelectorAll('.usage-and-solar-info__item-summary-content-primary');
      if (cards.length >= 2) {
        observer.disconnect();
        setTimeout(callback, 300); // small buffer for values to populate
      }
    });

    observer.observe(target, { childList: true, subtree: true });
  }

  // Start watching immediately
  waitForUsageCards(run)

  // Expose for manual re-run in console
  window.aglCalculate = run;

})();