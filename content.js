(() => {
  "use strict";

  const SYNC_KEYS = {
    delta: "vsc_delta",
    defaultSpeed: "vsc_defaultSpeed",
    hotkeyDec: "vsc_hotkeyDec",
    hotkeyInc: "vsc_hotkeyInc",
    volumeStep: "vsc_volumeStep",
  };
  const LOCAL_KEYS = { volume: "vsc_volume" };
  const DEFAULTS = {
    delta: 0.05,
    defaultSpeed: 1.0,
    hotkeyDec: "[",
    hotkeyInc: "]",
    volumeStep: 5,
    volume: 1.0,
  };

  const HIDE_DELAY_NORMAL = 3000;
  const HIDE_DELAY_HOVER = 10000;

  let config = { ...DEFAULTS };
  const managedVideos = new WeakSet();
  const videoOverlayPairs = []; // { video, bar, host, updateLabel, showOverlay, hideOverlay, ... }

  /* ── Load config from storage ───────────────────────────────── */
  function loadConfig(cb) {
    let pending = 0;
    let done = 0;
    function maybeFinish() {
      done++;
      if (done >= pending && cb) cb();
    }

    if (chrome?.storage?.sync) {
      pending++;
      chrome.storage.sync.get(Object.values(SYNC_KEYS), (res) => {
        if (chrome.runtime.lastError) console.warn("VSC sync load failed:", chrome.runtime.lastError.message);
        if (res[SYNC_KEYS.delta] != null) config.delta = parseFloat(res[SYNC_KEYS.delta]);
        if (res[SYNC_KEYS.defaultSpeed] != null) config.defaultSpeed = parseFloat(res[SYNC_KEYS.defaultSpeed]);
        if (res[SYNC_KEYS.hotkeyDec] != null) config.hotkeyDec = res[SYNC_KEYS.hotkeyDec];
        if (res[SYNC_KEYS.hotkeyInc] != null) config.hotkeyInc = res[SYNC_KEYS.hotkeyInc];
        if (res[SYNC_KEYS.volumeStep] != null) config.volumeStep = parseFloat(res[SYNC_KEYS.volumeStep]);
        maybeFinish();
      });
    }
    if (chrome?.storage?.local) {
      pending++;
      chrome.storage.local.get([LOCAL_KEYS.volume], (res) => {
        if (chrome.runtime.lastError) console.warn("VSC local load failed:", chrome.runtime.lastError.message);
        if (res[LOCAL_KEYS.volume] != null) config.volume = parseFloat(res[LOCAL_KEYS.volume]);
        maybeFinish();
      });
    }
    if (pending === 0 && cb) cb();
  }

  /* Listen for config changes from popup / other tabs — applies instantly everywhere */
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") {
        if (changes[SYNC_KEYS.delta]?.newValue != null)
          config.delta = parseFloat(changes[SYNC_KEYS.delta].newValue);
        if (changes[SYNC_KEYS.defaultSpeed]?.newValue != null)
          config.defaultSpeed = parseFloat(changes[SYNC_KEYS.defaultSpeed].newValue);
        if (changes[SYNC_KEYS.hotkeyDec]?.newValue != null)
          config.hotkeyDec = changes[SYNC_KEYS.hotkeyDec].newValue;
        if (changes[SYNC_KEYS.hotkeyInc]?.newValue != null)
          config.hotkeyInc = changes[SYNC_KEYS.hotkeyInc].newValue;
        if (changes[SYNC_KEYS.volumeStep]?.newValue != null)
          config.volumeStep = parseFloat(changes[SYNC_KEYS.volumeStep].newValue);

        /* Apply new default speed to all existing videos immediately */
        if (changes[SYNC_KEYS.defaultSpeed]?.newValue != null) {
          videoOverlayPairs.forEach(({ video, updateLabel }) => {
            video.playbackRate = config.defaultSpeed;
            updateLabel();
          });
        }
      } else if (area === "local") {
        if (changes[LOCAL_KEYS.volume]?.newValue != null) {
          config.volume = parseFloat(changes[LOCAL_KEYS.volume].newValue);
          /* Applies to every managed video, including ones on other tabs/
             pages — this is what makes "the next video I see" pick up the
             last-used volume. No toast here; that's reserved for the
             video actually being scrolled over. */
          videoOverlayPairs.forEach(({ video }) => {
            video.volume = config.volume;
          });
        }
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
  let leftMouseDown = false;
  let scrollUsedDuringHold = false;
  const FINE_VOLUME_STEP_PERCENT = 1; // left-click-held scroll always uses this, ignoring the configured Volume Step

  window.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 2) {
        rightMouseDown = true;
        scrollUsedDuringHold = false; // fresh hold, nothing consumed yet
      } else if (e.button === 0) {
        leftMouseDown = true;
      }
    },
    true
  );
  window.addEventListener(
    "mouseup",
    (e) => {
      if (e.button === 2) rightMouseDown = false;
      else if (e.button === 0) leftMouseDown = false;
    },
    true
  );
  window.addEventListener("blur", () => {
    rightMouseDown = false;
    leftMouseDown = false;
  });

  /* ── Scroll → volume (plain / left-click held = fine) or speed (right-click held) ── */
  /* Any scroll while the cursor is over a managed video is now ours:
     plain scroll adjusts .volume (left-click held = a fine 1% step
     instead of the configured Volume Step, for small corrections),
     right-click-held scroll adjusts speed (above). Scrolling anywhere
     NOT over a managed video is left completely alone. Note this does
     mean plain-scroll-over-video is no longer available to other
     page/user scripts (e.g. a separate YouTube volume-scroll script)
     — this feature takes that role over natively for every video on
     every site. */
  let volumeSaveTimer = null;
  function persistVolume(vol) {
    clearTimeout(volumeSaveTimer);
    /* Matches the volume toast's own 1s auto-hide — the write lands
       right as the UI fades, instead of on every single wheel tick. */
    volumeSaveTimer = setTimeout(() => {
      if (!chrome?.storage?.local) return;
      chrome.storage.local.set({ [LOCAL_KEYS.volume]: vol }, () => {
        if (chrome.runtime.lastError) console.warn("VSC volume save failed:", chrome.runtime.lastError.message);
      });
    }, 1000);
  }

  window.addEventListener(
    "wheel",
    (e) => {
      const pair = videoOverlayPairs.find((p) => p.cursorInside);
      if (!pair) return;

      /* stopImmediatePropagation so this never reaches other scroll
         listeners while the cursor is over a managed video. */
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const direction = e.deltaY < 0 ? 1 : -1;

      if (rightMouseDown) {
        scrollUsedDuringHold = true;
        pair.video.playbackRate = clampRate(pair.video.playbackRate + config.delta * direction);
        pair.updateLabel();
        pair.showOverlay();
        return;
      }

      const stepPercent = leftMouseDown ? FINE_VOLUME_STEP_PERCENT : config.volumeStep ?? DEFAULTS.volumeStep;
      const newVol = clampVolume(pair.video.volume + (stepPercent / 100) * direction);
      pair.video.volume = newVol;
      config.volume = newVol;
      pair.showVolumeToast(newVol);
      persistVolume(newVol);
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
    /* Apply the shared volume level */
    video.volume = config.volume;

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
        #vsc-volume-toast {
          position: absolute;
          top: 10px;
          left: 50%;
          transform: translateX(-50%);
          font-family: "SF Mono", "Consolas", "Menlo", monospace;
          font-size: 28px;
          font-weight: 800;
          color: #ffffff;
          -webkit-text-stroke: 3px #000000;
          paint-order: stroke fill;
          letter-spacing: -0.02em;
          user-select: none;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.15s ease;
          white-space: nowrap;
        }
        #vsc-volume-toast.show {
          opacity: 1;
        }
      </style>
      <div id="vsc-bar">
        <button class="vsc-btn" id="vsc-dec" title="Decrease speed">&minus;</button>
        <span id="vsc-rate">${fmtRate(video.playbackRate)}</span>
        <button class="vsc-btn" id="vsc-inc" title="Increase speed">+</button>
      </div>
      <div id="vsc-volume-toast"></div>
    `;

    const bar = shadow.getElementById("vsc-bar");
    const rateLabel = shadow.getElementById("vsc-rate");
    const decBtn = shadow.getElementById("vsc-dec");
    const incBtn = shadow.getElementById("vsc-inc");
    const volumeToast = shadow.getElementById("vsc-volume-toast");

    function updateLabel() {
      rateLabel.textContent = fmtRate(video.playbackRate);
    }

    /* Shows the current volume centered near the top of the video for
       1 second, resetting the hide timer on every scroll tick so a
       continuous scroll keeps it visible without flicker. */
    let volumeHideTimer = null;
    function showVolumeToast(vol) {
      volumeToast.textContent = Math.round(vol * 100) + "%";
      volumeToast.classList.add("show");
      clearTimeout(volumeHideTimer);
      volumeHideTimer = setTimeout(() => volumeToast.classList.remove("show"), 1000);
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
      showVolumeToast,
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

    /* Some sites (autoplay init, "unmute" buttons, feed videos loading
       in, etc.) set their own .volume after we've already applied
       ours — commonly resetting it to 1. Rather than a MutationObserver
       or a one-time "did it stick" check, just listen for the video's
       own volumechange and snap back if the new value isn't ours. The
       epsilon guard means our own corrective assignment (which itself
       fires another volumechange) is a no-op the second time through,
       so this can't loop. This does mean any native on-page volume
       control gets overridden too — intentional, so this extension
       stays the single source of truth for volume. */
    video.addEventListener("volumechange", () => {
      if (Math.abs(video.volume - config.volume) > 0.0005) {
        video.volume = config.volume;
      }
    });

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
        clearTimeout(volumeHideTimer);
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

  function clampVolume(v) {
    return Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
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