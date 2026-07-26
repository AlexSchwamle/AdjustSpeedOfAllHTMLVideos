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
  const videoOverlayPairs = []; // { video, bar, host, updateLabel, showOverlay, hideOverlay, ... }

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

  /* ── Per-overlay visibility via bounding-box hit test ────────── */
  /* Each pair has its own { timer, hoveringBar } state.
     The global mousemove checks cursor vs. each <video>'s bbox —
     overlays only appear when the cursor is geometrically inside the
     video rect, ignoring any DOM layers stacked above it. */

  function pointInRect(x, y, r) {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      const mx = e.clientX;
      const my = e.clientY;
      for (const pair of videoOverlayPairs) {
        const rect = pair.video.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        pair.updateHostRect(rect);
        if (pointInRect(mx, my, rect)) {
          pair.cursorInside = true;
          if (!pair.isHoveringBar()) pair.showOverlay();
        } else if (pair.cursorInside) {
          /* Cursor just left the video bbox — hide immediately */
          pair.cursorInside = false;
          pair.hideOverlay(true);
        }
      }
    },
    { passive: true }
  );

  /* ── Right-mouse-held + scroll → speed change ────────────────── */
  /* Only intercepts the wheel event while the right mouse button is
     physically held down AND the cursor is over a managed video's
     bbox (reusing the same cursorInside flag the fade logic keeps
     up to date above). Any other wheel usage — including scripts
     like a YouTube audio adjuster listening for plain scroll — is
     left completely untouched.

     All of these are bound on `window` (not `document`) in the
     capture phase. Capture always visits window before document
     before anything deeper — so this runs before a page's own
     handlers no matter when THEIR script registered, which matters
     because a site's script (e.g. YouTube's in-page custom
     right-click menu with Loop / Stats for nerds / etc.) typically
     runs well before this content script (injected at
     document_idle). Two capture listeners on the *same* target fire
     in registration order, so being on document alone wasn't enough
     to guarantee we go first — window does. */
  let rightMouseDown = false;
  let scrollUsedDuringHold = false;

  window.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 2) {
        rightMouseDown = true;
        scrollUsedDuringHold = false; // fresh hold, nothing consumed yet
      }
    },
    true
  );
  window.addEventListener(
    "mouseup",
    (e) => {
      if (e.button === 2) rightMouseDown = false;
    },
    true
  );
  window.addEventListener("blur", () => {
    rightMouseDown = false;
  });

  window.addEventListener(
    "wheel",
    (e) => {
      if (!rightMouseDown) return;
      const pair = videoOverlayPairs.find((p) => p.cursorInside);
      if (!pair) return;

      /* stopImmediatePropagation so this never reaches other scroll
         listeners (e.g. an audio-volume script) while the right
         button is down over a video. */
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      scrollUsedDuringHold = true;

      const direction = e.deltaY < 0 ? 1 : -1;
      pair.video.playbackRate = clampRate(pair.video.playbackRate + config.delta * direction);
      pair.updateLabel();
      pair.showOverlay();
    },
    { capture: true, passive: false }
  );

  /* contextmenu fires on right-button release. If we used the hold to
     change speed, block it here — both the native browser menu via
     preventDefault, and any in-page custom menu (like YouTube's) via
     stopImmediatePropagation, since that stops the event before it
     ever reaches the site's own contextmenu listener. */
  window.addEventListener(
    "contextmenu",
    (e) => {
      if (scrollUsedDuringHold) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        scrollUsedDuringHold = false;
      }
    },
    true
  );

  /* ── Hotkey listener ────────────────────────────────────────── */
  document.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
    if (videoOverlayPairs.length === 0) return;

    if (e.key === config.hotkeyDec || e.key === config.hotkeyInc) {
      const direction = e.key === config.hotkeyInc ? 1 : -1;
      videoOverlayPairs.forEach(({ video, updateLabel, showOverlay }) => {
        video.playbackRate = clampRate(video.playbackRate + config.delta * direction);
        updateLabel();
        showOverlay();
      });
      e.preventDefault();
    }
  });

  /* ── Build the overlay for a single <video> ─────────────────── */
  function attachOverlay(video) {
    if (managedVideos.has(video)) return;
    managedVideos.add(video);

    /* Apply default speed */
    video.playbackRate = config.defaultSpeed;

    /* Shadow DOM host so page CSS can't leak in.
       Positioned fixed and synced to the video's own getBoundingClientRect()
       (the same rect the bbox fade-logic already tracks) rather than sized
       to the parent element — the parent can be larger than the video
       itself (e.g. YouTube theater mode letterboxing), which previously
       left the bar pinned to the parent's corner instead of the video's. */
    const host = document.createElement("div");
    host.className = "vsc-overlay-host";
    host.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;";

    function updateHostRect(rect) {
      const r = rect || video.getBoundingClientRect();
      host.style.top = r.top + "px";
      host.style.left = r.left + "px";
      host.style.width = r.width + "px";
      host.style.height = r.height + "px";
    }

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
          opacity: 0;
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

    function updateLabel() {
      rateLabel.textContent = fmtRate(video.playbackRate);
    }

    /* ── Per-overlay visibility state ─────────────────────────── */
    let hideTimer = null;
    let hoveringBar = false;

    function showOverlay() {
      bar.style.opacity = "1";
      bar.style.pointerEvents = "auto";
      clearTimeout(hideTimer);
      const delay = hoveringBar ? HIDE_DELAY_HOVER : HIDE_DELAY_NORMAL;
      hideTimer = setTimeout(() => hideOverlay(false), delay);
    }

    function hideOverlay(force) {
      /* force=true: bbox exit — always hide, even if hovering the bar
         force=false: timer expiry — respect the hoveringBar guard */
      if (!force && hoveringBar) return;
      clearTimeout(hideTimer);
      hoveringBar = false;
      bar.style.opacity = "0";
      bar.style.pointerEvents = "none";
    }

    /* Register the pair (with show/hide methods for the global mousemove & hotkeys) */
    const pair = {
      video,
      bar,
      host,
      updateLabel,
      showOverlay,
      hideOverlay,
      updateHostRect,
      cursorInside: false,
      isHoveringBar: () => hoveringBar,
    };
    videoOverlayPairs.push(pair);

    /* Keep the host aligned even when the mouse isn't moving — window
       resizes, scrolling, entering/leaving theater or fullscreen mode,
       etc. The mousemove loop above also calls updateHostRect on every
       move, so this mainly covers the no-mouse-movement cases. */
    const resizeObserver = new ResizeObserver(() => updateHostRect());
    resizeObserver.observe(video);
    window.addEventListener("resize", () => updateHostRect());
    window.addEventListener("scroll", () => updateHostRect(), { capture: true, passive: true });

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
        showOverlay();
      },
      { passive: false }
    );

    /* Keep label in sync if something else changes the rate */
    video.addEventListener("ratechange", updateLabel);

    /* Hover on bar: switch to longer 10s timeout */
    bar.addEventListener("mouseenter", () => {
      hoveringBar = true;
      clearTimeout(hideTimer);
      bar.style.opacity = "1";
      bar.style.pointerEvents = "auto";
      hideTimer = setTimeout(() => hideOverlay(false), HIDE_DELAY_HOVER);
    });
    bar.addEventListener("mouseleave", () => {
      hoveringBar = false;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => hideOverlay(false), HIDE_DELAY_NORMAL);
    });

    /* Insert overlay directly on body — position is fully self-managed
       via updateHostRect(), so it no longer depends on the parent
       element's box matching the video's. */
    document.body.appendChild(host);
    updateHostRect();

    /* Overlay starts hidden — only appears on mouse-in-bbox */

    /* Cleanup if video removed from DOM */
    const mo = new MutationObserver(() => {
      if (!document.contains(video)) {
        host.remove();
        mo.disconnect();
        resizeObserver.disconnect();
        clearTimeout(hideTimer);
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