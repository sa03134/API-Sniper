(function () {
  "use strict";

  // ── State ──
  const collectedRequests = [];
  var pageOrigin = "";

  // Grab the inspected page's origin once
  try {
    chrome.devtools.inspectedWindow.eval("location.origin", function (result) {
      if (result) pageOrigin = result;
    });
  } catch (_) {}

  // ── Noise filter — built-in keyword list ──
  const DEFAULT_NOISE_KEYWORDS = [
    "segment.io",
    "segment.com",
    "amplitude.com",
    "google-analytics",
    "googleanalytics",
    "analytics.google",
    "bugsnag.com",
    "sentry.io",
    "hotjar.com",
    "clarity.ms",
    "doubleclick.net",
    "facebook.net",
    "fbevents",
    "mixpanel.com",
    "datadog",
    "newrelic",
    "badge-count",
    "unread-exist",
    "/health",
    "/ping",
    "/heartbeat",
    "/alive",
    "/polling",
  ];
  const NOISE_METHODS = ["OPTIONS"];

  // ── Persistent settings (localStorage) ──
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

  // ── Noise detection ──
  function getAllNoiseKeywords() {
    return DEFAULT_NOISE_KEYWORDS.concat(settings.customKeywords || []);
  }

  function isEmptyBody(body) {
    if (body === null || body === undefined) return true;
    if (typeof body === "string") {
      var t = body.trim();
      return t === "" || t === "{}" || t === "[]" || t === "null" || t === "true" || t === "false";
    }
    if (typeof body === "object") {
      if (Array.isArray(body)) return body.length === 0;
      return Object.keys(body).length === 0;
    }
    return false;
  }

  function isNoise(entry) {
    var url = (entry.url || "").toLowerCase();
    var method = (entry.method || "").toUpperCase();

    // OPTIONS always noise
    if (NOISE_METHODS.includes(method)) return true;

    // Same-origin filter
    if (settings.sameOriginOnly && pageOrigin) {
      try {
        var reqOrigin = new URL(entry.url).origin;
        if (reqOrigin !== pageOrigin) return true;
      } catch (_) {}
    }

    // Keyword match (built-in + custom)
    var keywords = getAllNoiseKeywords();
    if (keywords.some(function (kw) { return url.includes(kw.toLowerCase()); })) return true;

    // Empty body filter
    if (settings.hideEmptyBody && isEmptyBody(entry.responseBody)) return true;

    // JSON-only filter
    if (settings.jsonOnly) {
      var ct = (entry.responseHeaders && (entry.responseHeaders["content-type"] || entry.responseHeaders["Content-Type"])) || "";
      if (!ct.includes("json")) return true;
    }

    // Static resource extensions
    if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|eot|ico|map)(\?|$)/i.test(entry.url)) return true;

    return false;
  }

  // ── DOM refs ──
  var requestListEl = document.getElementById("requestList");
  var requestCountEl = document.getElementById("requestCount");
  var filterInput = document.getElementById("filterInput");
  var btnCopy = document.getElementById("btnCopy");
  var btnCopyClean = document.getElementById("btnCopyClean");
  var btnClear = document.getElementById("btnClear");
  var cleanCountEl = document.getElementById("cleanCount");
  var toastEl = document.getElementById("toast");

  // Settings UI refs
  var btnSettings = document.getElementById("btnSettings");
  var settingsDrawer = document.getElementById("settingsDrawer");
  var chkSameOrigin = document.getElementById("chkSameOrigin");
  var chkHideEmpty = document.getElementById("chkHideEmpty");
  var chkJsonOnly = document.getElementById("chkJsonOnly");
  var customKeywordsInput = document.getElementById("customKeywordsInput");
  var btnAddKeyword = document.getElementById("btnAddKeyword");
  var customKeywordsList = document.getElementById("customKeywordsList");

  // ── Helpers ──

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 2000);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function methodClass(method) {
    const m = (method || "GET").toUpperCase();
    const known = ["GET", "POST", "PUT", "DELETE", "PATCH"];
    return known.includes(m) ? "method-" + m : "method-OTHER";
  }

  function statusClass(code) {
    if (!code || code === 0) return "status-pending";
    return code >= 200 && code < 400 ? "status-ok" : "status-err";
  }

  function formatHeaders(headers) {
    if (!headers || typeof headers !== "object") return "{}";
    return JSON.stringify(headers, null, 2);
  }

  function tryParseJson(text) {
    if (!text) return text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function getCleanRequests() {
    return collectedRequests.filter(function (r) { return !isNoise(r); });
  }

  function updateCount() {
    const total = collectedRequests.length;
    const clean = getCleanRequests().length;
    requestCountEl.textContent = total;
    cleanCountEl.textContent = clean;
  }

  // ── Rendering ──

  function renderRequest(entry, index) {
    const card = document.createElement("div");
    const noise = isNoise(entry);
    card.className = "request-card" + (noise ? " noise" : "");
    card.dataset.index = index;

    const method = (entry.method || "GET").toUpperCase();
    const url = entry.url || "";
    const status = entry.statusCode;

    card.innerHTML = `
      <div class="request-header">
        <span class="method-badge ${methodClass(method)}">${escapeHtml(method)}</span>
        <span class="request-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
        <span class="request-status ${statusClass(status)}">${status || "..."}</span>
        ${noise ? '<span class="noise-tag">NOISE</span>' : ''}
        <span class="expand-arrow">&#x25B6;</span>
      </div>
      <div class="request-detail">
        <div class="detail-section">
          <div class="detail-label">Request Headers</div>
          <pre class="detail-pre">${escapeHtml(formatHeaders(entry.requestHeaders))}</pre>
        </div>
        <div class="detail-section">
          <div class="detail-label">Response Headers</div>
          <pre class="detail-pre">${escapeHtml(formatHeaders(entry.responseHeaders))}</pre>
        </div>
        <div class="detail-section">
          <div class="detail-label">Response Body</div>
          <pre class="detail-pre">${escapeHtml(
            typeof entry.responseBody === "string"
              ? entry.responseBody
              : JSON.stringify(entry.responseBody, null, 2)
          )}</pre>
        </div>
      </div>
    `;

    card.querySelector(".request-header").addEventListener("click", () => {
      card.classList.toggle("expanded");
    });

    return card;
  }

  function renderAll() {
    const filter = filterInput.value.toLowerCase();

    // Remove everything except the empty state
    while (requestListEl.firstChild) {
      requestListEl.removeChild(requestListEl.firstChild);
    }

    const filtered = collectedRequests.filter(
      (r) => !filter || (r.url && r.url.toLowerCase().includes(filter))
    );

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = filter
        ? '<div class="empty-state-icon">&#x1f50e;</div><div class="empty-state-text">No requests match the filter.</div>'
        : '<div class="empty-state-icon">&#x1f50d;</div><div class="empty-state-text">No requests captured yet. Navigate or refresh the inspected page.</div>';
      requestListEl.appendChild(empty);
      return;
    }

    // Render in reverse (newest first)
    for (let i = filtered.length - 1; i >= 0; i--) {
      requestListEl.appendChild(renderRequest(filtered[i], i));
    }
  }

  // ── Network listener via chrome.devtools.network ──

  function isXhrOrFetch(request) {
    const type = (request._resourceType || "").toLowerCase();
    if (type === "xhr" || type === "fetch") return true;

    // Fallback: check common API content types
    const response = request.response;
    if (response && response.content) {
      const mime = (response.content.mimeType || "").toLowerCase();
      if (mime.includes("application/json") || mime.includes("text/json")) {
        return true;
      }
    }

    return false;
  }

  function extractHeaders(headerArray) {
    if (!headerArray || !Array.isArray(headerArray)) return {};
    const obj = {};
    for (const h of headerArray) {
      obj[h.name] = h.value;
    }
    return obj;
  }

  function handleRequest(request) {
    if (!isXhrOrFetch(request)) return;

    const entry = {
      url: request.request.url,
      method: request.request.method,
      statusCode: request.response ? request.response.status : null,
      requestHeaders: extractHeaders(request.request.headers),
      responseHeaders: extractHeaders(
        request.response ? request.response.headers : []
      ),
      responseBody: null,
    };

    const idx = collectedRequests.length;
    collectedRequests.push(entry);
    updateCount();

    // Fetch response body asynchronously
    request.getContent(function (body, encoding) {
      let parsed = body;
      if (body) {
        parsed = tryParseJson(body);
      }
      collectedRequests[idx].responseBody = parsed;
      renderAll();
    });

    renderAll();
  }

  // ── Initialise listener ──
  chrome.devtools.network.onRequestFinished.addListener(handleRequest);

  // Also pick up requests that finished before the panel opened
  chrome.devtools.network.getHAR(function (harLog) {
    if (harLog && harLog.entries) {
      for (const entry of harLog.entries) {
        handleRequest(entry);
      }
    }
  });

  // ── Button handlers ──

  function copyToClipboard(text, count, label) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand("copy");
      showToast("Copied " + count + " " + label + " request(s)!");
    } catch (err) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(function () {
            showToast("Copied " + count + " " + label + " request(s)!");
          })
          .catch(function () {
            showToast("Failed to copy. Check permissions.");
          });
      } else {
        showToast("Failed to copy. Check permissions.");
      }
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function buildExportData(requests) {
    return requests.map(function (r) {
      return {
        url: r.url,
        method: r.method,
        statusCode: r.statusCode,
        requestHeaders: r.requestHeaders,
        responseHeaders: r.responseHeaders,
        responseBody: r.responseBody,
      };
    });
  }

  btnCopy.addEventListener("click", function () {
    if (collectedRequests.length === 0) {
      showToast("No data to copy.");
      return;
    }
    var text = JSON.stringify(buildExportData(collectedRequests), null, 2);
    copyToClipboard(text, collectedRequests.length, "total");
  });

  btnCopyClean.addEventListener("click", function () {
    var clean = getCleanRequests();
    if (clean.length === 0) {
      showToast("No clean data to copy (all filtered as noise).");
      return;
    }
    var text = JSON.stringify(buildExportData(clean), null, 2);
    copyToClipboard(text, clean.length, "clean");
  });

  btnClear.addEventListener("click", function () {
    collectedRequests.length = 0;
    updateCount();
    renderAll();
  });

  filterInput.addEventListener("input", function () {
    renderAll();
  });

  // ── Settings drawer logic ──
  btnSettings.addEventListener("click", function () {
    settingsDrawer.classList.toggle("open");
  });

  // Close drawer when clicking outside
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
    updateCount();
    renderAll();
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
    // Attach remove handlers
    customKeywordsList.querySelectorAll(".keyword-remove").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(this.dataset.idx, 10);
        settings.customKeywords.splice(idx, 1);
        saveSettings(settings);
        renderCustomKeywords();
        updateCount();
        renderAll();
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
    updateCount();
    renderAll();
  });

  customKeywordsInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      btnAddKeyword.click();
    }
  });

  applySettingsToUI();

  // ── Initial render ──
  renderAll();
})();
