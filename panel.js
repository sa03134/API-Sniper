(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════
  var collectedRequests = [];
  var pageOrigin = "";

  try {
    chrome.devtools.inspectedWindow.eval("location.origin", function (res) {
      if (res) pageOrigin = res;
    });
  } catch (_) {}

  // ═══════════════════════════════════════════════════════
  // Constants — noise & scoring
  // ═══════════════════════════════════════════════════════
  var NOISE_URL_KEYWORDS = [
    "analytics", "ads", "collect", "pixel", "telemetry",
    "log", "bugsnag", "sentry", "amplitude", "segment",
    "cloudfront", "static",
    "google-analytics", "googleanalytics", "analytics.google",
    "hotjar", "clarity.ms", "doubleclick", "facebook.net",
    "fbevents", "mixpanel", "datadog", "newrelic",
    "badge-count", "unread-exist",
    "/health", "/ping", "/heartbeat", "/alive", "/polling",
  ];

  var NOISE_METHODS = ["OPTIONS"];

  var BUSINESS_KEYS = [
    "title", "content", "items", "list", "message",
    "price", "user", "name", "email", "description",
    "data", "results", "products", "orders", "comments",
    "posts", "replies", "notifications", "amount", "total",
    "address", "phone", "image", "url", "body", "text",
    "label", "status", "type", "category", "tags",
  ];

  var VVIP_THRESHOLD = 70;
  var MIN_BODY_LENGTH = 150;

  // ═══════════════════════════════════════════════════════
  // Persistent settings
  // ═══════════════════════════════════════════════════════
  var STORAGE_KEY = "apisniper_settings";

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return null;
  }

  function saveSettings(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
  }

  function getDefaultSettings() {
    return {
      sameOriginOnly: true,
      hideEmptyBody: true,
      jsonOnly: false,
      customKeywords: [],
    };
  }

  var settings = Object.assign(getDefaultSettings(), loadSettings() || {});

  // ═══════════════════════════════════════════════════════
  // Interest Scoring Engine
  // ═══════════════════════════════════════════════════════

  // -- JSON depth calculator --
  function jsonDepth(obj, current) {
    if (current === undefined) current = 0;
    if (obj === null || typeof obj !== "object") return current;
    var max = current + 1;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        var d = jsonDepth(obj[i], current + 1);
        if (d > max) max = d;
      }
    } else {
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++) {
        var d2 = jsonDepth(obj[keys[k]], current + 1);
        if (d2 > max) max = d2;
      }
    }
    return max;
  }

  // -- Check if value contains any array recursively --
  function containsArray(obj) {
    if (obj === null || typeof obj !== "object") return false;
    if (Array.isArray(obj)) return obj.length > 0;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (containsArray(obj[keys[i]])) return true;
    }
    return false;
  }

  // -- Collect all keys recursively --
  function collectKeys(obj, out) {
    if (!out) out = [];
    if (obj === null || typeof obj !== "object") return out;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) collectKeys(obj[i], out);
    } else {
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++) {
        out.push(keys[k].toLowerCase());
        collectKeys(obj[keys[k]], out);
      }
    }
    return out;
  }

  // -- Body as string length --
  function bodyStringLength(body) {
    if (body === null || body === undefined) return 0;
    if (typeof body === "string") return body.length;
    try { return JSON.stringify(body).length; } catch (_) { return 0; }
  }

  // -- Is body parseable as JSON object/array? --
  function isJsonBody(entry) {
    var body = entry.responseBody;
    if (body !== null && typeof body === "object") return true;
    if (typeof body === "string") {
      var t = body.trim();
      return (t.charAt(0) === "{" || t.charAt(0) === "[");
    }
    return false;
  }

  // -- Parse body to object --
  function bodyAsObject(entry) {
    var body = entry.responseBody;
    if (body !== null && typeof body === "object") return body;
    if (typeof body === "string") {
      try { return JSON.parse(body); } catch (_) {}
    }
    return null;
  }

  /**
   * computeScore(entry) → { score: number, reasons: string[], isNoise: boolean }
   *
   * Phase 1 — Disqualify (score = 0):
   *   - OPTIONS method
   *   - URL matches noise keywords or custom keywords
   *   - Same-origin filter (when enabled)
   *   - Static resource extension
   *   - Response is not JSON
   *   - JSON body shorter than 150 chars
   *
   * Phase 2 — Base + Bonuses:
   *   Base = 10
   *   +30  body contains array
   *   +40  keys include business keywords
   *   +20  depth >= 3
   */
  function computeScore(entry) {
    var reasons = [];
    var url = (entry.url || "").toLowerCase();
    var method = (entry.method || "").toUpperCase();

    // ── Phase 1: disqualify → noise ──

    if (NOISE_METHODS.indexOf(method) !== -1) {
      return { score: 0, reasons: ["OPTIONS method"], isNoise: true };
    }

    // Same-origin
    if (settings.sameOriginOnly && pageOrigin) {
      try {
        if (new URL(entry.url).origin !== pageOrigin) {
          return { score: 0, reasons: ["3rd-party origin"], isNoise: true };
        }
      } catch (_) {}
    }

    // Noise keywords (built-in + custom)
    var allKeywords = NOISE_URL_KEYWORDS.concat(settings.customKeywords || []);
    for (var ki = 0; ki < allKeywords.length; ki++) {
      if (url.indexOf(allKeywords[ki].toLowerCase()) !== -1) {
        return { score: 0, reasons: ["URL keyword: " + allKeywords[ki]], isNoise: true };
      }
    }

    // Static resource
    if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|eot|ico|map)(\?|$)/i.test(entry.url)) {
      return { score: 0, reasons: ["Static resource"], isNoise: true };
    }

    // Not JSON body
    if (!isJsonBody(entry)) {
      return { score: 0, reasons: ["Non-JSON response"], isNoise: true };
    }

    // Body too short
    if (bodyStringLength(entry.responseBody) < MIN_BODY_LENGTH) {
      return { score: 0, reasons: ["Body < " + MIN_BODY_LENGTH + " chars"], isNoise: true };
    }

    // ── Phase 2: scoring ──

    var score = 10;
    reasons.push("Base +10");

    var parsed = bodyAsObject(entry);
    if (parsed === null) {
      return { score: score, reasons: reasons, isNoise: false };
    }

    // +30 — contains array
    if (containsArray(parsed)) {
      score += 30;
      reasons.push("Contains array +30");
    }

    // +40 — business keywords in keys
    var allKeys = collectKeys(parsed);
    var matchedBiz = [];
    for (var bi = 0; bi < BUSINESS_KEYS.length; bi++) {
      for (var ai = 0; ai < allKeys.length; ai++) {
        if (allKeys[ai].indexOf(BUSINESS_KEYS[bi]) !== -1) {
          matchedBiz.push(BUSINESS_KEYS[bi]);
          break;
        }
      }
      if (matchedBiz.length >= 1) break; // one match is enough
    }
    if (matchedBiz.length > 0) {
      score += 40;
      reasons.push("Business keys +40");
    }

    // +20 — depth >= 3
    var depth = jsonDepth(parsed);
    if (depth >= 3) {
      score += 20;
      reasons.push("Depth " + depth + " >= 3 +20");
    }

    return { score: score, reasons: reasons, isNoise: false };
  }

  // ═══════════════════════════════════════════════════════
  // Header cleanup for export
  // ═══════════════════════════════════════════════════════
  var ESSENTIAL_REQ_HEADERS = ["authorization", "cookie", "content-type"];

  function cleanHeaders(headers) {
    if (!headers || typeof headers !== "object") return {};
    var cleaned = {};
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      if (ESSENTIAL_REQ_HEADERS.indexOf(keys[i].toLowerCase()) !== -1) {
        cleaned[keys[i]] = headers[keys[i]];
      }
    }
    return cleaned;
  }

  // ═══════════════════════════════════════════════════════
  // DOM refs
  // ═══════════════════════════════════════════════════════
  var requestListEl = document.getElementById("requestList");
  var requestCountEl = document.getElementById("requestCount");
  var cleanCountEl = document.getElementById("cleanCount");
  var vvipCountEl = document.getElementById("vvipCount");
  var filterInput = document.getElementById("filterInput");
  var btnCopyVvip = document.getElementById("btnCopyVvip");
  var btnCopy = document.getElementById("btnCopy");
  var btnClear = document.getElementById("btnClear");
  var toastEl = document.getElementById("toast");

  // Settings
  var btnSettings = document.getElementById("btnSettings");
  var settingsDrawer = document.getElementById("settingsDrawer");
  var chkSameOrigin = document.getElementById("chkSameOrigin");
  var chkHideEmpty = document.getElementById("chkHideEmpty");
  var chkJsonOnly = document.getElementById("chkJsonOnly");
  var customKeywordsInput = document.getElementById("customKeywordsInput");
  var btnAddKeyword = document.getElementById("btnAddKeyword");
  var customKeywordsList = document.getElementById("customKeywordsList");

  // ═══════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(function () { toastEl.classList.remove("show"); }, 2000);
  }

  function escapeHtml(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function methodClass(m) {
    m = (m || "GET").toUpperCase();
    return ["GET","POST","PUT","DELETE","PATCH"].indexOf(m) !== -1
      ? "method-" + m : "method-OTHER";
  }

  function statusClass(code) {
    if (!code || code === 0) return "status-pending";
    return (code >= 200 && code < 400) ? "status-ok" : "status-err";
  }

  function formatHeaders(headers) {
    if (!headers || typeof headers !== "object") return "{}";
    return JSON.stringify(headers, null, 2);
  }

  function tryParseJson(text) {
    if (!text) return text;
    try { return JSON.parse(text); } catch (_) { return text; }
  }

  // ═══════════════════════════════════════════════════════
  // Counts
  // ═══════════════════════════════════════════════════════

  function getCategorized() {
    var clean = [];
    var vvip = [];
    for (var i = 0; i < collectedRequests.length; i++) {
      var r = collectedRequests[i];
      var s = r._score !== undefined ? r._score : 0;
      if (s > 0) clean.push(r);
      if (s >= VVIP_THRESHOLD) vvip.push(r);
    }
    return { clean: clean, vvip: vvip };
  }

  function updateCount() {
    var c = getCategorized();
    requestCountEl.textContent = collectedRequests.length;
    cleanCountEl.textContent = c.clean.length;
    vvipCountEl.textContent = c.vvip.length;
  }

  // ═══════════════════════════════════════════════════════
  // Rendering
  // ═══════════════════════════════════════════════════════

  function scoreBadgeClass(score) {
    if (score >= VVIP_THRESHOLD) return "score-vvip";
    if (score > 0) return "score-ok";
    return "score-noise";
  }

  function renderRequest(entry) {
    var card = document.createElement("div");
    var score = entry._score !== undefined ? entry._score : 0;
    var isVvip = score >= VVIP_THRESHOLD;
    var isNoiseReq = score === 0;

    var cls = "request-card";
    if (isVvip) cls += " vvip";
    else if (isNoiseReq) cls += " noise";
    card.className = cls;

    var method = (entry.method || "GET").toUpperCase();
    var url = entry.url || "";
    var status = entry.statusCode;
    var reasons = (entry._scoreReasons || []).join(" | ");

    var tagHtml = "";
    if (isVvip) {
      tagHtml = '<span class="vvip-tag">VVIP</span>';
    } else if (isNoiseReq) {
      tagHtml = '<span class="noise-tag">NOISE</span>';
    }

    card.innerHTML =
      '<div class="request-header">' +
        '<span class="score-badge ' + scoreBadgeClass(score) + '">' + score + '</span>' +
        '<span class="method-badge ' + methodClass(method) + '">' + escapeHtml(method) + '</span>' +
        '<span class="request-url" title="' + escapeHtml(url) + '">' + escapeHtml(url) + '</span>' +
        '<span class="request-status ' + statusClass(status) + '">' + (status || "...") + '</span>' +
        tagHtml +
        '<span class="expand-arrow">&#x25B6;</span>' +
      '</div>' +
      '<div class="request-detail">' +
        '<div class="detail-section">' +
          '<div class="detail-label">Score Breakdown</div>' +
          '<pre class="detail-pre detail-pre-sm">' + escapeHtml(reasons) + '</pre>' +
        '</div>' +
        '<div class="detail-section">' +
          '<div class="detail-label">Request Headers</div>' +
          '<pre class="detail-pre">' + escapeHtml(formatHeaders(entry.requestHeaders)) + '</pre>' +
        '</div>' +
        '<div class="detail-section">' +
          '<div class="detail-label">Response Headers</div>' +
          '<pre class="detail-pre">' + escapeHtml(formatHeaders(entry.responseHeaders)) + '</pre>' +
        '</div>' +
        '<div class="detail-section">' +
          '<div class="detail-label">Response Body</div>' +
          '<pre class="detail-pre">' + escapeHtml(
            typeof entry.responseBody === "string"
              ? entry.responseBody
              : JSON.stringify(entry.responseBody, null, 2)
          ) + '</pre>' +
        '</div>' +
      '</div>';

    card.querySelector(".request-header").addEventListener("click", function () {
      card.classList.toggle("expanded");
    });

    return card;
  }

  function renderAll() {
    var filter = filterInput.value.toLowerCase();

    while (requestListEl.firstChild) {
      requestListEl.removeChild(requestListEl.firstChild);
    }

    var filtered = [];
    for (var i = 0; i < collectedRequests.length; i++) {
      var r = collectedRequests[i];
      if (filter && (!r.url || r.url.toLowerCase().indexOf(filter) === -1)) continue;
      filtered.push(r);
    }

    if (filtered.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = filter
        ? '<div class="empty-state-icon">&#x1f50e;</div><div class="empty-state-text">No requests match the filter.</div>'
        : '<div class="empty-state-icon">&#x1f50d;</div><div class="empty-state-text">No requests captured yet. Navigate or refresh the inspected page.</div>';
      requestListEl.appendChild(empty);
      return;
    }

    // Sort: VVIP first, then by score desc, newest first within same score
    filtered.sort(function (a, b) {
      var sa = a._score !== undefined ? a._score : 0;
      var sb = b._score !== undefined ? b._score : 0;
      if (sb !== sa) return sb - sa;
      return (b._ts || 0) - (a._ts || 0);
    });

    for (var j = 0; j < filtered.length; j++) {
      requestListEl.appendChild(renderRequest(filtered[j]));
    }
  }

  // Recalculate all scores (after settings change)
  function rescoreAll() {
    for (var i = 0; i < collectedRequests.length; i++) {
      var result = computeScore(collectedRequests[i]);
      collectedRequests[i]._score = result.score;
      collectedRequests[i]._scoreReasons = result.reasons;
    }
    updateCount();
    renderAll();
  }

  // ═══════════════════════════════════════════════════════
  // Network listener
  // ═══════════════════════════════════════════════════════

  function isXhrOrFetch(request) {
    var type = (request._resourceType || "").toLowerCase();
    if (type === "xhr" || type === "fetch") return true;
    var resp = request.response;
    if (resp && resp.content) {
      var mime = (resp.content.mimeType || "").toLowerCase();
      if (mime.indexOf("json") !== -1) return true;
    }
    return false;
  }

  function extractHeaders(arr) {
    if (!arr || !Array.isArray(arr)) return {};
    var obj = {};
    for (var i = 0; i < arr.length; i++) {
      obj[arr[i].name] = arr[i].value;
    }
    return obj;
  }

  function handleRequest(request) {
    if (!isXhrOrFetch(request)) return;

    var entry = {
      url: request.request.url,
      method: request.request.method,
      statusCode: request.response ? request.response.status : null,
      requestHeaders: extractHeaders(request.request.headers),
      responseHeaders: extractHeaders(
        request.response ? request.response.headers : []
      ),
      responseBody: null,
      _score: 0,
      _scoreReasons: [],
      _ts: Date.now(),
    };

    var idx = collectedRequests.length;
    collectedRequests.push(entry);

    // Fetch body then score
    request.getContent(function (body) {
      if (body) collectedRequests[idx].responseBody = tryParseJson(body);
      var result = computeScore(collectedRequests[idx]);
      collectedRequests[idx]._score = result.score;
      collectedRequests[idx]._scoreReasons = result.reasons;
      updateCount();
      renderAll();
    });

    // Score immediately with what we have (no body yet)
    var imm = computeScore(entry);
    entry._score = imm.score;
    entry._scoreReasons = imm.reasons;
    updateCount();
    renderAll();
  }

  chrome.devtools.network.onRequestFinished.addListener(handleRequest);

  chrome.devtools.network.getHAR(function (harLog) {
    if (harLog && harLog.entries) {
      for (var i = 0; i < harLog.entries.length; i++) {
        handleRequest(harLog.entries[i]);
      }
    }
  });

  // ═══════════════════════════════════════════════════════
  // Copy / Export
  // ═══════════════════════════════════════════════════════

  function copyToClipboard(text, msg) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast(msg);
    } catch (_) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function () { showToast(msg); })
          .catch(function () { showToast("Failed to copy."); });
      } else {
        showToast("Failed to copy.");
      }
    } finally {
      document.body.removeChild(ta);
    }
  }

  function buildCleanExport(requests) {
    return requests.map(function (r) {
      return {
        url: r.url,
        method: r.method,
        statusCode: r.statusCode,
        interestScore: r._score || 0,
        requestHeaders: cleanHeaders(r.requestHeaders),
        responseBody: r.responseBody,
      };
    });
  }

  function buildFullExport(requests) {
    return requests.map(function (r) {
      return {
        url: r.url,
        method: r.method,
        statusCode: r.statusCode,
        interestScore: r._score || 0,
        requestHeaders: r.requestHeaders,
        responseHeaders: r.responseHeaders,
        responseBody: r.responseBody,
      };
    });
  }

  // Copy VVIP — cleaned headers, only high-score
  btnCopyVvip.addEventListener("click", function () {
    var cat = getCategorized();
    if (cat.vvip.length === 0) {
      showToast("No VVIP data (score >= " + VVIP_THRESHOLD + ").");
      return;
    }
    var text = JSON.stringify(buildCleanExport(cat.vvip), null, 2);
    copyToClipboard(text, "Copied " + cat.vvip.length + " VVIP request(s)!");
  });

  // Copy All — full data
  btnCopy.addEventListener("click", function () {
    if (collectedRequests.length === 0) {
      showToast("No data to copy.");
      return;
    }
    var text = JSON.stringify(buildFullExport(collectedRequests), null, 2);
    copyToClipboard(text, "Copied " + collectedRequests.length + " request(s)!");
  });

  btnClear.addEventListener("click", function () {
    collectedRequests.length = 0;
    updateCount();
    renderAll();
  });

  filterInput.addEventListener("input", function () { renderAll(); });

  // ═══════════════════════════════════════════════════════
  // Settings drawer
  // ═══════════════════════════════════════════════════════

  btnSettings.addEventListener("click", function () {
    settingsDrawer.classList.toggle("open");
  });

  document.addEventListener("click", function (e) {
    if (settingsDrawer.classList.contains("open") &&
        !settingsDrawer.contains(e.target) &&
        e.target !== btnSettings) {
      settingsDrawer.classList.remove("open");
    }
  });

  function applySettingsToUI() {
    chkSameOrigin.checked = settings.sameOriginOnly;
    chkHideEmpty.checked = settings.hideEmptyBody;
    chkJsonOnly.checked = settings.jsonOnly;
    renderCustomKeywords();
  }

  function onSettingChange() {
    settings.sameOriginOnly = chkSameOrigin.checked;
    settings.hideEmptyBody = chkHideEmpty.checked;
    settings.jsonOnly = chkJsonOnly.checked;
    saveSettings(settings);
    rescoreAll();
  }

  chkSameOrigin.addEventListener("change", onSettingChange);
  chkHideEmpty.addEventListener("change", onSettingChange);
  chkJsonOnly.addEventListener("change", onSettingChange);

  // ── Custom keywords ──
  function renderCustomKeywords() {
    customKeywordsList.innerHTML = "";
    (settings.customKeywords || []).forEach(function (kw, i) {
      var tag = document.createElement("span");
      tag.className = "keyword-tag";
      tag.innerHTML = escapeHtml(kw) + '<span class="keyword-remove" data-idx="' + i + '">&times;</span>';
      customKeywordsList.appendChild(tag);
    });
    customKeywordsList.querySelectorAll(".keyword-remove").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(this.dataset.idx, 10);
        settings.customKeywords.splice(idx, 1);
        saveSettings(settings);
        renderCustomKeywords();
        rescoreAll();
      });
    });
  }

  btnAddKeyword.addEventListener("click", function () {
    var val = customKeywordsInput.value.trim();
    if (!val) return;
    if (!settings.customKeywords) settings.customKeywords = [];
    settings.customKeywords.push(val);
    customKeywordsInput.value = "";
    saveSettings(settings);
    renderCustomKeywords();
    rescoreAll();
  });

  customKeywordsInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); btnAddKeyword.click(); }
  });

  applySettingsToUI();
  renderAll();
})();
