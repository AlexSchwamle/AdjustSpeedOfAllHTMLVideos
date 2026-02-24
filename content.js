(() => {
  "use strict";

  const STORAGE_KEYS = {
    delta: "vsc_delta",
    defaultSpeed: "vsc_defaultSpeed",
    hotkeyDec: "vsc_hotkeyDec",
    hotkeyInc: "vsc_hotkeyInc",
  };
  const DEFAULTS = { delta: 0.05, defaultSpeed: 1.0, hotkeyDec: "[", hotkeyInc: "]" };

  const HIDE_DELAY_NORMAL = 3000;
  const HIDE_DELAY_HOVER = 10000;

  let config = { ...DEFAULTS };
  const managedVideos = new WeakSet();
  const videoOverlayPairs = []; // { video, bar, host, updateLabel }

  /* ── Load config from storage ───────────────────────────────── */
  function loadConfig(cb) {
    if (chrome?.storage?.sync) {
      chrome.storage.sync.get(Object.values(STORAGE_KEYS), (res) => {
        if (res[STORAGE_KEYS.delta] != null)
          config.delta = parseFloat(res[STORAGE_KEYS.delta]);
        if (res[STORAGE_KEYS.defaultSpeed] != null)
          config.defaultSpeed = parseFloat(res[STORAGE_KEYS.defaultSpeed]);
        if (res[STORAGE_KEYS.hotkeyDec] != null)
          config.hotkeyDec = res[STORAGE_KEYS.hotkeyDec];
        if (res[STORAGE_KEYS.hotkeyInc] != null)
          config.hotkeyInc = res[STORAGE_KEYS.hotkeyInc];
        if (cb) cb();
      });
    } else if (cb) cb();
  }

  /* Listen for config changes from popup — applies instantly to ALL tabs */
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes[STORAGE_KEYS.delta]?.newValue != null)
        config.delta = parseFloat(changes[STORAGE_KEYS.delta].newValue);
      if (changes[STORAGE_KEYS.defaultSpeed]?.newValue != null)
        config.defaultSpeed = parseFloat(changes[STORAGE_KEYS.defaultSpeed].newValue);
      if (changes[STORAGE_KEYS.hotkeyDec]?.newValue != null)
        config.hotkeyDec = changes[STORAGE_KEYS.hotkeyDec].newValue;
      if (changes[STORAGE_KEYS.hotkeyInc]?.newValue != null)
        config.hotkeyInc = changes[STORAGE_KEYS.hotkeyInc].newValue;

      /* Apply new default speed to all existing videos immediately */
      if (changes[STORAGE_KEYS.defaultSpeed]?.newValue != null) {
        videoOverlayPairs.forEach(({ video, updateLabel }) => {
          video.playbackRate = config.defaultSpeed;
          updateLabel();
        });
      }
    });
  }

  /* ── Visibility / fade logic ────────────────────────────────── */
  let globalTimer = null;
  let isHoveringBar = false;
  const allOverlays = new Set();

  function showAllOverlays() {
    allOverlays.forEach((el) => {
      el.style.opacity = "1";
      el.style.pointerEvents = "auto";
    });
    scheduleHide();
  }

  function scheduleHide() {
    clearTimeout(globalTimer);
    const delay = isHoveringBar ? HIDE_DELAY_HOVER : HIDE_DELAY_NORMAL;
    globalTimer = setTimeout(hideAllOverlays, delay);
  }

  function hideAllOverlays() {
    if (isHoveringBar) return;
    allOverlays.forEach((el) => {
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
    });
  }

  /* Global mouse-move listener (catches overlay UIs like Instagram) */
  document.addEventListener("mousemove", showAllOverlays, { passive: true });

  /* ── Hotkey listener ────────────────────────────────────────── */
  document.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
    if (videoOverlayPairs.length === 0) return;

    if (e.key === config.hotkeyDec || e.key === config.hotkeyInc) {
      const direction = e.key === config.hotkeyInc ? 1 : -1;
      videoOverlayPairs.forEach(({ video, updateLabel }) => {
        video.playbackRate = clampRate(video.playbackRate + config.delta * direction);
        updateLabel();
      });
      showAllOverlays();
      e.preventDefault();
    }
  });

  /* ── Build the overlay for a single <video> ─────────────────── */
  function attachOverlay(video) {
    if (managedVideos.has(video)) return;
    managedVideos.add(video);

    /* Apply default speed */
    video.playbackRate = config.defaultSpeed;

    /* Shadow DOM host so page CSS can't leak in */
    const host = document.createElement("div");
    host.className = "vsc-overlay-host";
    host.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;";

    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        #vsc-bar {
          position: absolute;
          top: 8px;
          right: 8px;
          display: flex;
          align-items: center;
          gap: 0;
          font-family: "SF Mono", "Consolas", "Menlo", monospace;
          font-size: 13px;
          line-height: 1;
          background: rgba(30, 30, 30, 0.55);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: rgba(255, 255, 255, 0.88);
          user-select: none;
          pointer-events: auto;
          opacity: 1;
          transition: opacity 0.35s ease;
          overflow: hidden;
        }
        .vsc-btn {
          background: none;
          border: none;
          color: rgba(255, 255, 255, 0.85);
          font: inherit;
          font-size: 15px;
          padding: 5px 9px;
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
          line-height: 1;
        }
        .vsc-btn:hover {
          background: rgba(255, 255, 255, 0.15);
          color: #fff;
        }
        .vsc-btn:active {
          background: rgba(255, 255, 255, 0.25);
        }
        #vsc-rate {
          padding: 5px 6px;
          min-width: 46px;
          text-align: center;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.02em;
          cursor: default;
        }
      </style>
      <div id="vsc-bar">
        <button class="vsc-btn" id="vsc-dec" title="Decrease speed">&minus;</button>
        <span id="vsc-rate">${fmtRate(video.playbackRate)}</span>
        <button class="vsc-btn" id="vsc-inc" title="Increase speed">+</button>
      </div>
    `;

    const bar = shadow.getElementById("vsc-bar");
    const rateLabel = shadow.getElementById("vsc-rate");
    const decBtn = shadow.getElementById("vsc-dec");
    const incBtn = shadow.getElementById("vsc-inc");

    allOverlays.add(bar);

    function updateLabel() {
      rateLabel.textContent = fmtRate(video.playbackRate);
    }

    const pair = { video, bar, host, updateLabel };
    videoOverlayPairs.push(pair);

    function adjustSpeed(direction) {
      video.playbackRate = clampRate(video.playbackRate + config.delta * direction);
      updateLabel();
    }

    decBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      adjustSpeed(-1);
    });

    incBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      adjustSpeed(1);
    });

    /* Scroll wheel on the bar: scroll-up → faster, scroll-down → slower */
    bar.addEventListener(
      "wheel",
      (e) => {
        e.stopPropagation();
        e.preventDefault();
        adjustSpeed(e.deltaY < 0 ? 1 : -1);
        showAllOverlays();
      },
      { passive: false }
    );

    /* Keep label in sync if something else changes the rate */
    video.addEventListener("ratechange", updateLabel);

    /* Hover on bar: switch to longer 10s timeout */
    bar.addEventListener("mouseenter", () => {
      isHoveringBar = true;
      clearTimeout(globalTimer);
      bar.style.opacity = "1";
      bar.style.pointerEvents = "auto";
      scheduleHide();
    });
    bar.addEventListener("mouseleave", () => {
      isHoveringBar = false;
      scheduleHide();
    });

    /* Insert overlay — need a positioned parent */
    ensurePositionedParent(video);
    video.parentElement.appendChild(host);

    /* Show briefly on attach, then auto-hide */
    showAllOverlays();

    /* Cleanup if video removed from DOM */
    const mo = new MutationObserver(() => {
      if (!document.contains(video)) {
        allOverlays.delete(bar);
        host.remove();
        mo.disconnect();
        const idx = videoOverlayPairs.indexOf(pair);
        if (idx >= 0) videoOverlayPairs.splice(idx, 1);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  /* ── Helpers ────────────────────────────────────────────────── */
  function fmtRate(r) {
    return r.toFixed(2) + "x";
  }

  function clampRate(r) {
    return Math.min(16, Math.max(0.0625, Math.round(r * 1000) / 1000));
  }

  function ensurePositionedParent(video) {
    const parent = video.parentElement;
    if (!parent) return;
    const pos = getComputedStyle(parent).position;
    if (pos === "static" || pos === "") {
      parent.style.position = "relative";
    }
  }

  /* ── Scan & observe for <video> elements ────────────────────── */
  function scanVideos() {
    document.querySelectorAll("video").forEach(attachOverlay);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") attachOverlay(node);
        else if (node.querySelectorAll) {
          node.querySelectorAll("video").forEach(attachOverlay);
        }
      }
    }
  });

  /* ── Bootstrap ──────────────────────────────────────────────── */
  loadConfig(() => {
    scanVideos();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();
