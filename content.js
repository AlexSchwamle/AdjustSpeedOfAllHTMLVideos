(() => {
  "use strict";

  const SYNC_KEYS = {
    delta: "vsc_delta",
    defaultSpeed: "vsc_defaultSpeed",
    hotkeyDec: "vsc_hotkeyDec",
    hotkeyInc: "vsc_hotkeyInc",
    volumeStep: "vsc_volumeStep",
  };
  /* Volume lives in chrome.storage.local, not sync. sync has a hard
     write-rate quota (~120 writes/min, shared across every key this
     extension stores) — scrolling volume can easily burst past that,
     and once it's hit, writes silently fail unless you explicitly
     check chrome.runtime.lastError. That's almost certainly why the
     volume looked "sometimes persistent" — some writes landed, later
     ones during a scroll session got dropped, and reads then quietly
     fell back to whatever the last successful write happened to be.
     local has no such write-frequency cap, so this removes the
     problem instead of just working around it. */
  const LOCAL_KEYS = { volume: "vsc_volume", blacklist: "vsc_blacklist" };
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

  /* ── Element blacklist ─────────────────────────────────────────
     Some pages (Netflix/Disney+ hero banners are the classic case)
     have a huge or offscreen autoplaying <video> that this extension
     has no business managing — hijacking scroll over it to change its
     volume instead of scrolling the page is actively harmful there.
     Rather than guess at a size/position heuristic (which breaks down
     immediately for fullscreen players, which SHOULD be managed),
     right-clicking directly on a <video> element offers a native
     "VSC: Block this element…" context menu entry (see background.js)
     that permanently excludes that specific element going forward.
     Entries are matched per-hostname against a structural selector
     (tag names + nth-of-type, so it survives dynamic/hashed class
     names) with the element's src as a secondary matcher when
     available — neither is bulletproof against every possible page
     structure, but between the two it holds up well in practice, and
     the options page (right-click the extension icon → Options) lets
     you review and remove entries if one ever mismatches. */
  let blacklist = []; // [{ hostname, selector, src, addedAt }]

  function loadBlacklist(cb) {
    if (!chrome?.storage?.local) {
      if (cb) cb();
      return;
    }
    chrome.storage.local.get([LOCAL_KEYS.blacklist], (res) => {
      if (chrome.runtime.lastError) console.warn("VSC blacklist load failed:", chrome.runtime.lastError.message);
      blacklist = Array.isArray(res[LOCAL_KEYS.blacklist]) ? res[LOCAL_KEYS.blacklist] : [];
      if (cb) cb();
    });
  }

  /* Structural path from the element up to the nearest ancestor with an
     id (a stable anchor, if one exists) or up to <body>. Deliberately
     ignores class names — many sites hash or randomize those per build,
     which would silently break every stored entry. */
  function computeSelector(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function isBlacklisted(video) {
    if (blacklist.length === 0) return false;
    const host = location.hostname;
    const src = video.currentSrc || video.getAttribute("src") || "";
    const sel = computeSelector(video);
    return blacklist.some(
      (entry) => entry.hostname === host && (entry.selector === sel || (src && entry.src && entry.src === src))
    );
  }

  /* Brief red outline so the person can visually confirm which element
     just got blocked — the browser's own context-menu click gives no
     other feedback that anything happened. */
  function flashBlockedHighlight(video) {
    const rect = video.getBoundingClientRect();
    const flash = document.createElement("div");
    flash.style.cssText = [
      "position:fixed",
      `top:${rect.top}px`,
      `left:${rect.left}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      "border:4px dashed #ff3b3b",
      "background:rgba(255,59,59,0.15)",
      "z-index:2147483647",
      "pointer-events:none",
      "box-sizing:border-box",
    ].join(";");
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 1500);
  }

  function blockElement(video) {
    const entry = {
      hostname: location.hostname,
      selector: computeSelector(video),
      src: video.currentSrc || video.getAttribute("src") || "",
      addedAt: Date.now(),
    };
    blacklist.push(entry);
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ [LOCAL_KEYS.blacklist]: blacklist }, () => {
        if (chrome.runtime.lastError) console.warn("VSC blacklist save failed:", chrome.runtime.lastError.message);
      });
    }
    flashBlockedHighlight(video);
    const pair = videoOverlayPairs.find((p) => p.video === video);
    if (pair) pair.destroy();
  }

  /* Set by the contextmenu listener down by the wheel handler: whichever
     managed video's overlay is visible at right-click time. The
     background script's context-menu click arrives later as a runtime
     message, by which point the mouse may have moved, so this is
     captured at the moment of the actual right-click instead of
     re-derived from cursor position at click time. */
  let lastRightClickedVideoEl = null;

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "vsc-block-element" && lastRightClickedVideoEl) {
        blockElement(lastRightClickedVideoEl);
        lastRightClickedVideoEl = null;
      }
    });
  }

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
            applyVolume(video, config.volume);
          });
        }
        if (changes[LOCAL_KEYS.blacklist]?.newValue != null) {
          blacklist = Array.isArray(changes[LOCAL_KEYS.blacklist].newValue) ? changes[LOCAL_KEYS.blacklist].newValue : [];
          /* Covers both directions live, no reload needed: an entry
             added elsewhere (e.g. another tab's context-menu action, or
             removed via the options page) should detach a video we're
             currently managing; a removed entry should let a previously
             -skipped video get picked up on the next scan. */
          videoOverlayPairs.slice().forEach((pair) => {
            if (isBlacklisted(pair.video)) pair.destroy();
          });
          scanVideos();
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

  /* Latest known cursor position, kept up to date here for the hold-boost
     drift check below — cheaper than a second dedicated mousemove listener. */
  let lastMouseX = 0;
  let lastMouseY = 0;

  document.addEventListener(
    "mousemove",
    (e) => {
      const mx = e.clientX;
      const my = e.clientY;
      lastMouseX = mx;
      lastMouseY = my;
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
  let middleMouseDown = false;
  let scrollUsedDuringHold = false;
  const FINE_VOLUME_STEP_PERCENT = 1; // middle-click-held scroll always uses this, ignoring the configured Volume Step

  /* ── Left-click-held on a video → 2x speed boost, released on mouseup ── */
  /* Deliberately does NOT preventDefault/stopPropagation anything for
     the left button — earlier attempts at that broke play/pause and
     custom seek-bar dragging on sites (X) whose controls are separate
     overlay elements sitting on top of the video but within the same
     bounding box we use for "is the cursor over this video". There's
     no reliable way to geometrically tell "the bare video surface"
     apart from "the site's own scrubber drawn on top of it" — only
     the DOM target could, and that's too site-specific to rely on —
     so instead this only ever *reacts*: it lets every mousedown /
     mouseup / click reach the page exactly as it normally would, and
     fixes up the outcome afterward. Two corrections happen this way:
     (1) the ratechange listener down in attachOverlay keeps snapping
     the rate back to 2x for the duration of the hold, so a competing
     native feature (YouTube ships this exact gesture) can't visibly
     win; (2) the click listener below resumes playback shortly after
     release if the hold's trailing click paused it. Neither approach
     can ever break another site's own UI, since nothing is ever
     blocked — worst case is a one-frame flicker before we correct it.

     On top of that: dragging a seek bar (or any other custom control)
     is itself a mousedown-then-move gesture, indistinguishable from a
     hold at mousedown time. Rather than try to special-case every
     site's own scrubber implementation — no universal signal for "a
     drag is in progress" reliably exists; not every custom player
     even sets video.seeking — this only engages the boost if the
     cursor is still within HOLD_BOOST_MAX_DRIFT_PX of where the press
     started once the threshold elapses. A real hold keeps the cursor
     roughly put; a drag has already moved it. Moving fast enough to
     clear that radius before the threshold fires still avoids the
     boost; moving slower than that doesn't — an accepted tradeoff
     rather than a fully general solution. */
  const HOLD_BOOST_THRESHOLD_MS = 200;
  const HOLD_BOOST_RATE = 2.0;
  const HOLD_BOOST_MAX_DRIFT_PX = 10;
  let holdBoostTimer = null;
  let holdBoostPair = null;
  let holdBoostPreRate = null;
  let holdBoostActive = false;
  let holdJustReleased = false;
  let lastBoostedVideo = null;
  let holdStartX = 0;
  let holdStartY = 0;

  function engageHoldBoost(pair) {
    holdBoostActive = true;
    holdBoostPreRate = pair.video.playbackRate;
    if (pair.video.paused) pair.video.play().catch(() => {});
    pair.video.playbackRate = HOLD_BOOST_RATE;
    pair.updateLabel();
    pair.showOverlay();
    pair.showBoostIcon();
  }

  function releaseHoldBoost() {
    clearTimeout(holdBoostTimer);
    holdBoostTimer = null;
    if (holdBoostActive && holdBoostPair) {
      holdBoostPair.video.playbackRate = holdBoostPreRate;
      holdBoostPair.updateLabel();
      holdBoostPair.showOverlay();
      holdBoostPair.hideBoostIcon();
    }
    holdBoostActive = false;
    holdBoostPair = null;
    holdBoostPreRate = null;
  }

  /* Tracks, per button, whether *this* press/release pair started over a
     managed video (and not the overlay bar) and therefore got
     intercepted — checked again at mouseup instead of re-querying
     cursorInside, since the mouse may well have moved off the video (or
     even off-window) by release time and we still need to swallow that
     mouseup consistently. This still applies to middle/right, which
     don't have the "must never block the page" constraint the left
     button does (no click-to-pause or drag surface competes with a
     scroll modifier or a context menu). */
  let interceptRight = false;
  let interceptMiddle = false;

  function findVideoPair() {
    return videoOverlayPairs.find((p) => p.cursorInside && !p.isHoveringBar());
  }

  window.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 2) {
        const pair = findVideoPair();
        interceptRight = !!pair;
        if (pair) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        rightMouseDown = true;
        scrollUsedDuringHold = false; // fresh hold, nothing consumed yet
      } else if (e.button === 1) {
        const pair = findVideoPair();
        interceptMiddle = !!pair;
        if (pair) {
          e.preventDefault(); // also stops the browser's middle-click autoscroll/paste
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        middleMouseDown = true;
      } else if (e.button === 0) {
        /* Purely passive — see the block comment above for why. */
        const pair = findVideoPair();
        if (pair) {
          holdBoostPair = pair;
          holdStartX = e.clientX;
          holdStartY = e.clientY;
          clearTimeout(holdBoostTimer);
          holdBoostTimer = setTimeout(() => {
            const dx = lastMouseX - holdStartX;
            const dy = lastMouseY - holdStartY;
            if (Math.sqrt(dx * dx + dy * dy) > HOLD_BOOST_MAX_DRIFT_PX) return; // moved — this is a drag/seek, not a hold
            engageHoldBoost(pair);
          }, HOLD_BOOST_THRESHOLD_MS);
        }
      }
    },
    true
  );
  window.addEventListener(
    "mouseup",
    (e) => {
      if (e.button === 2) {
        if (interceptRight) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        interceptRight = false;
        rightMouseDown = false;
      } else if (e.button === 1) {
        if (interceptMiddle) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        interceptMiddle = false;
        middleMouseDown = false;
      } else if (e.button === 0) {
        const wasBoosted = holdBoostActive;
        if (wasBoosted) lastBoostedVideo = holdBoostPair.video;
        releaseHoldBoost();
        holdJustReleased = wasBoosted;
      }
    },
    true
  );
  window.addEventListener(
    "click",
    () => {
      /* Purely observational — never preventDefault/stopPropagation
         here, so the page's own click handling (pause toggle, or
         anything else) always runs completely normally. If a hold
         happened, we just want the video playing afterward regardless
         of what that click did; scheduling this as a real task (not a
         microtask) guarantees it runs after the click has finished
         propagating through every listener on the page, including any
         bubble-phase pause toggle that fires after us. */
      if (!holdJustReleased) return;
      holdJustReleased = false;
      const video = lastBoostedVideo;
      lastBoostedVideo = null;
      if (!video) return;
      setTimeout(() => {
        if (video.paused) video.play().catch(() => {});
      }, 0);
    },
    true
  );
  window.addEventListener("blur", () => {
    rightMouseDown = false;
    middleMouseDown = false;
    interceptRight = false;
    interceptMiddle = false;
    releaseHoldBoost();
  });

  /* ── Scroll → speed (bar-hover, or right-click held) or volume (plain / middle-click held = fine) ── */
  /* Any scroll while the cursor is over a managed video is now ours:
     hovering the rate overlay bar itself always means "adjust speed"
     regardless of mouse buttons (the bar IS the speed control, so it
     should never touch volume); otherwise plain scroll adjusts
     .volume (middle-click held = a fine 1% step instead of the
     configured Volume Step, for small corrections), and right-click-
     held scroll adjusts speed. Scrolling anywhere NOT over a managed
     video is left completely alone. Note this does mean plain-scroll-
     over-video is no longer available to other page/user scripts
     (e.g. a separate YouTube volume-scroll script) — this feature
     takes that role over natively for every video on every site. */
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

      if (pair.isHoveringBar()) {
        pair.video.playbackRate = clampRate(pair.video.playbackRate + config.delta * direction);
        pair.updateLabel();
        pair.showOverlay();
        pair.showRateToast(pair.video.playbackRate);
        return;
      }

      if (rightMouseDown) {
        scrollUsedDuringHold = true;
        pair.video.playbackRate = clampRate(pair.video.playbackRate + config.delta * direction);
        pair.updateLabel();
        pair.showOverlay();
        pair.showRateToast(pair.video.playbackRate);
        return;
      }

      const stepPercent = middleMouseDown ? FINE_VOLUME_STEP_PERCENT : config.volumeStep ?? DEFAULTS.volumeStep;
      const newVol = clampVolume(pair.video.volume + (stepPercent / 100) * direction);
      config.volume = newVol;
      applyVolumeFromScroll(pair.video, newVol);
      pair.showVolumeToast(newVol);
      persistVolume(newVol);
    },
    { capture: true, passive: false }
  );

  /* contextmenu fires on right-button release. If we used the hold to
     change speed, block it here — both the native browser menu via
     preventDefault, and any in-page custom menu (like YouTube's) via
     stopImmediatePropagation, since that stops the event before it
     ever reaches the site's own contextmenu listener. Also records
     which video the "VSC: Block this element…" context menu item
     (added by background.js) should target: whichever managed video
     currently has its overlay visible (cursorInside), NOT e.target —
     on most custom players the actual click target is one of many
     control/UI divs layered on top of the <video> tag, so e.target is
     essentially never the video itself. Falling back to e.target only
     covers the rare case where the raw <video> really was what got
     clicked (no overlay UI there at all). */
  window.addEventListener(
    "contextmenu",
    (e) => {
      const hoveredPair = videoOverlayPairs.find((p) => p.cursorInside);
      if (hoveredPair) {
        lastRightClickedVideoEl = hoveredPair.video;
      } else if (e.target && e.target.tagName === "VIDEO") {
        lastRightClickedVideoEl = e.target;
      }
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
      videoOverlayPairs.forEach(({ video, updateLabel, showOverlay, showRateToast }) => {
        video.playbackRate = clampRate(video.playbackRate + config.delta * direction);
        updateLabel();
        showOverlay();
        showRateToast(video.playbackRate);
      });
      e.preventDefault();
    }
  });

  /* ── Build the overlay for a single <video> ─────────────────── */
  function attachOverlay(video) {
    if (managedVideos.has(video)) return;
    if (isBlacklisted(video)) return;
    managedVideos.add(video);

    /* Apply default speed */
    video.playbackRate = config.defaultSpeed;
    /* Apply the shared volume level */
    applyVolume(video, config.volume);

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
        #vsc-toast {
          position: absolute;
          top: 15px;
          left: 50%;
          transform: translateX(-50%);
          font-family: "SF Mono", "Consolas", "Menlo", monospace;
          font-size: 24px;
          font-weight: 800;
          color: #ffffff;
          -webkit-text-stroke: 2.5px #000000;
          paint-order: stroke fill;
          letter-spacing: -0.01em;
          user-select: none;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.12s ease;
          white-space: nowrap;
        }
        #vsc-toast.show {
          opacity: 1;
        }
      </style>
      <div id="vsc-bar">
        <button class="vsc-btn" id="vsc-dec" title="Decrease speed">&minus;</button>
        <span id="vsc-rate">${fmtRate(video.playbackRate)}</span>
        <button class="vsc-btn" id="vsc-inc" title="Increase speed">+</button>
      </div>
      <div id="vsc-toast"></div>
    `;

    const bar = shadow.getElementById("vsc-bar");
    const rateLabel = shadow.getElementById("vsc-rate");
    const decBtn = shadow.getElementById("vsc-dec");
    const incBtn = shadow.getElementById("vsc-inc");
    const toastEl = shadow.getElementById("vsc-toast");

    function updateLabel() {
      rateLabel.textContent = fmtRate(video.playbackRate);
    }

    /* Single generalized indicator shared by all three notification
       types (2x boost / playback rate / volume) — only one is ever on
       screen. Priority is 2x > rate > volume: while the boost is
       active, calls to the temporary (rate/volume) toast are ignored
       outright, so nothing can interrupt or flicker under it. Rate and
       volume don't have a priority order between themselves — whichever
       fires most recently just takes over the display and resets the
       1s countdown, so e.g. scrolling volume then immediately hitting
       a speed hotkey correctly swaps to the rate toast right away. */
    let toastHideTimer = null;
    let boostToastActive = false;

    function showToast(text) {
      if (boostToastActive) return;
      toastEl.textContent = text;
      toastEl.classList.add("show");
      clearTimeout(toastHideTimer);
      toastHideTimer = setTimeout(() => toastEl.classList.remove("show"), 1000);
    }

    function showVolumeToast(vol) {
      showToast(Math.round(vol * 100) + "%");
    }

    function showRateToast(rate) {
      showToast(fmtRate(rate));
    }

    /* Persistent — no auto-hide timer, since it stays up for as long as
       the left button is held; engage/release control it directly. */
    function showBoostToast() {
      boostToastActive = true;
      clearTimeout(toastHideTimer);
      toastEl.textContent = HOLD_BOOST_RATE.toFixed(0) + "x \u25B6\u25B6";
      toastEl.classList.add("show");
    }
    function hideBoostToast() {
      boostToastActive = false;
      toastEl.classList.remove("show");
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
      showRateToast,
      showBoostIcon: showBoostToast,
      hideBoostIcon: hideBoostToast,
      cursorInside: false,
      isHoveringBar: () => hoveringBar,
      destroy: () => destroy(),
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
      showRateToast(video.playbackRate);
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

    /* Keep label in sync if something else changes the rate — and,
       while a left-click hold-boost is active on THIS video, re-assert
       2x if anything else (our own release aside) tries to set a
       different rate. See the hold-boost block above for why this is
       the chosen way to "prevent other scripts from doing this too"
       instead of fighting over the mousedown event itself. */
    video.addEventListener("ratechange", () => {
      if (holdBoostActive && holdBoostPair === pair && Math.abs(video.playbackRate - HOLD_BOOST_RATE) > 0.001) {
        video.playbackRate = HOLD_BOOST_RATE;
      }
      updateLabel();
    });

    /* Some sites (autoplay init, feed videos loading in, etc.) set
       their own .volume after we've already applied ours — commonly
       resetting it to 1. Rather than a MutationObserver or a one-time
       "did it stick" check, just listen for the video's own
       volumechange and snap the level back if it isn't ours. This
       deliberately leaves .muted alone — see applyVolume above for
       why — so a site muting/unmuting the video on its own terms still
       works; only the numeric level is enforced. The epsilon guard
       means our own corrective assignment (which itself fires another
       volumechange) is a no-op the second time through, so this can't
       loop. */
    video.addEventListener("volumechange", () => {
      if (Math.abs(video.volume - config.volume) > 0.0005) {
        applyVolume(video, config.volume);
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

    function destroy() {
      host.remove();
      mo.disconnect();
      resizeObserver.disconnect();
      clearTimeout(hideTimer);
      clearTimeout(toastHideTimer);
      const idx = videoOverlayPairs.indexOf(pair);
      if (idx >= 0) videoOverlayPairs.splice(idx, 1);
      managedVideos.delete(video);
    }

    /* Cleanup if video removed from DOM */
    const mo = new MutationObserver(() => {
      if (!document.contains(video)) destroy();
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

  /* Every place we set .volume funnels through here. This only ever
     touches .volume — it deliberately does NOT touch .muted, so an
     initially-muted video (autoplay defaults, a site's own preference,
     etc.) stays muted through page load and cross-tab broadcasts.
     Un-muting only happens as a direct result of the person actually
     scrolling — see applyVolumeFromScroll below — since that's the one
     case where "I'm adjusting volume" clearly implies "I want to hear
     it," rather than us silently flipping mute state behind the scenes
     on every video that loads. */
  function applyVolume(video, vol) {
    video.volume = vol;
  }

  /* Scroll-triggered volume changes also un-mute, since scrolling to a
     specific level is an unambiguous signal the person wants audio. */
  function applyVolumeFromScroll(video, vol) {
    applyVolume(video, vol);
    if (video.muted) video.muted = false;
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
  let configReady = false;
  let blacklistReady = false;
  function tryBootstrap() {
    if (!configReady || !blacklistReady) return;
    scanVideos();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  loadConfig(() => {
    configReady = true;
    tryBootstrap();
  });
  loadBlacklist(() => {
    blacklistReady = true;
    tryBootstrap();
  });
})();