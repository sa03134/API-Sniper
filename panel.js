(function () {
  "use strict";

  // ── State ──
  const collectedRequests = [];

  // ── DOM refs ──
  const requestListEl = document.getElementById("requestList");
  const emptyStateEl = document.getElementById("emptyState");
  const requestCountEl = document.getElementById("requestCount");
  const filterInput = document.getElementById("filterInput");
  const btnCopy = document.getElementById("btnCopy");
  const btnClear = document.getElementById("btnClear");
  const toastEl = document.getElementById("toast");

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

  function updateCount() {
    requestCountEl.textContent = collectedRequests.length;
  }

  // ── Rendering ──

  function renderRequest(entry, index) {
    const card = document.createElement("div");
    card.className = "request-card";
    card.dataset.index = index;

    const method = (entry.method || "GET").toUpperCase();
    const url = entry.url || "";
    const status = entry.statusCode;

    card.innerHTML = `
      <div class="request-header">
        <span class="method-badge ${methodClass(method)}">${escapeHtml(method)}</span>
        <span class="request-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
        <span class="request-status ${statusClass(status)}">${status || "..."}</span>
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

  btnCopy.addEventListener("click", function () {
    if (collectedRequests.length === 0) {
      showToast("No data to copy.");
      return;
    }

    const exportData = collectedRequests.map(function (r) {
      return {
        url: r.url,
        method: r.method,
        statusCode: r.statusCode,
        requestHeaders: r.requestHeaders,
        responseHeaders: r.responseHeaders,
        responseBody: r.responseBody,
      };
    });

    const text = JSON.stringify(exportData, null, 2);

    // Use a textarea fallback since DevTools panels may not support
    // navigator.clipboard in all contexts.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand("copy");
      showToast("Copied " + collectedRequests.length + " request(s) to clipboard!");
    } catch (err) {
      // Fallback to async clipboard API if available
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(function () {
            showToast("Copied " + collectedRequests.length + " request(s) to clipboard!");
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
  });

  btnClear.addEventListener("click", function () {
    collectedRequests.length = 0;
    updateCount();
    renderAll();
  });

  filterInput.addEventListener("input", function () {
    renderAll();
  });

  // ── Initial render ──
  renderAll();
})();
