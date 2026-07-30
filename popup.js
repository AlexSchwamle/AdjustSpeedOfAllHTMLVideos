(() => {
  const KEYS = {
    delta: "vsc_delta",
    defaultSpeed: "vsc_defaultSpeed",
    hotkeyDec: "vsc_hotkeyDec",
    hotkeyInc: "vsc_hotkeyInc",
    volumeStep: "vsc_volumeStep",
  };
  /* Same key content.js reads/writes for the scroll-driven volume —
     this field is just another way to set the same shared value, and
     it lives in chrome.storage.local (not sync) since it changes
     frequently and local has no write-rate quota. */
  const LOCAL_KEYS = { volume: "vsc_volume" };
  const DEFAULTS = { delta: 0.05, defaultSpeed: 1.0, hotkeyDec: "[", hotkeyInc: "]", volumeStep: 5, volume: 1.0 };

  const deltaInput = document.getElementById("delta");
  const speedInput = document.getElementById("defaultSpeed");
  const volumeStepInput = document.getElementById("volumeStep");
  const defaultVolumeInput = document.getElementById("defaultVolume");
  const hotkeyDecInput = document.getElementById("hotkeyDec");
  const hotkeyIncInput = document.getElementById("hotkeyInc");
  const savedMsg = document.getElementById("saved");

  /* ── Load current values ──────────────────────────────────── */
  chrome.storage.sync.get(Object.values(KEYS), (res) => {
    deltaInput.value = (
      res[KEYS.delta] != null ? parseFloat(res[KEYS.delta]) : DEFAULTS.delta
    ).toFixed(2);
    speedInput.value = (
      res[KEYS.defaultSpeed] != null ? parseFloat(res[KEYS.defaultSpeed]) : DEFAULTS.defaultSpeed
    ).toFixed(2);
    volumeStepInput.value = (
      res[KEYS.volumeStep] != null ? parseFloat(res[KEYS.volumeStep]) : DEFAULTS.volumeStep
    ).toFixed(2);
    hotkeyDecInput.value = res[KEYS.hotkeyDec] || DEFAULTS.hotkeyDec;
    hotkeyIncInput.value = res[KEYS.hotkeyInc] || DEFAULTS.hotkeyInc;
  });

  chrome.storage.local.get([LOCAL_KEYS.volume], (res) => {
    const vol = res[LOCAL_KEYS.volume] != null ? parseFloat(res[LOCAL_KEYS.volume]) : DEFAULTS.volume;
    defaultVolumeInput.value = (vol * 100).toFixed(2);
  });

  /* Keep the field live if volume changes elsewhere (e.g. scrolling a
     video on another tab) while this popup happens to be open. */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LOCAL_KEYS.volume]?.newValue != null) {
      defaultVolumeInput.value = (parseFloat(changes[LOCAL_KEYS.volume].newValue) * 100).toFixed(2);
    }
  });

  /* ── Save fields: settings to sync, volume to local ─────────── */
  function save() {
    const d = Math.max(0.01, Math.min(5, parseFloat(deltaInput.value) || DEFAULTS.delta));
    const s = Math.max(0.0625, Math.min(16, parseFloat(speedInput.value) || DEFAULTS.defaultSpeed));
    const v = Math.max(0.1, Math.min(100, parseFloat(volumeStepInput.value) || DEFAULTS.volumeStep));
    const vol = Math.max(0, Math.min(100, parseFloat(defaultVolumeInput.value) || DEFAULTS.volume * 100)) / 100;

    deltaInput.value = d.toFixed(2);
    speedInput.value = s.toFixed(2);
    volumeStepInput.value = v.toFixed(2);
    defaultVolumeInput.value = (vol * 100).toFixed(2);

    chrome.storage.sync.set(
      {
        [KEYS.delta]: d,
        [KEYS.defaultSpeed]: s,
        [KEYS.volumeStep]: v,
        [KEYS.hotkeyDec]: hotkeyDecInput.value || DEFAULTS.hotkeyDec,
        [KEYS.hotkeyInc]: hotkeyIncInput.value || DEFAULTS.hotkeyInc,
      },
      flash
    );

    chrome.storage.local.set({ [LOCAL_KEYS.volume]: vol }, () => {
      if (chrome.runtime.lastError) console.warn("VSC volume save failed:", chrome.runtime.lastError.message);
    });
  }

  function flash() {
    savedMsg.classList.add("show");
    clearTimeout(flash._t);
    flash._t = setTimeout(() => savedMsg.classList.remove("show"), 1200);
  }

  /* Numeric inputs: save on change AND on input (for spin buttons / typing) */
  deltaInput.addEventListener("change", save);
  speedInput.addEventListener("change", save);
  volumeStepInput.addEventListener("change", save);
  defaultVolumeInput.addEventListener("change", save);
  deltaInput.addEventListener("input", debounce(save, 400));
  speedInput.addEventListener("input", debounce(save, 400));
  volumeStepInput.addEventListener("input", debounce(save, 400));
  defaultVolumeInput.addEventListener("input", debounce(save, 400));

  /* ── Spin buttons ─────────────────────────────────────────── */
  document.querySelectorAll(".spin-btns button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      const step = parseFloat(input.step) || 0.01;
      const dir = parseInt(btn.dataset.dir, 10);
      const val = parseFloat(input.value) + step * dir;
      input.value = Math.max(parseFloat(input.min), Math.min(parseFloat(input.max), val)).toFixed(2);
      save();
    });
  });

  /* ── Hotkey capture ───────────────────────────────────────── */
  [hotkeyDecInput, hotkeyIncInput].forEach((el) => {
    el.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Tab" || e.key === "Escape") {
        el.blur();
        return;
      }
      el.value = e.key;
      save();
      el.blur();
    });
    // Make it visually obvious it's capturable
    el.addEventListener("focus", () => {
      el.value = "…";
    });
    el.addEventListener("blur", () => {
      // Restore saved value if user didn't press anything
      chrome.storage.sync.get(
        [el.id === "hotkeyDec" ? KEYS.hotkeyDec : KEYS.hotkeyInc],
        (res) => {
          const key = el.id === "hotkeyDec" ? KEYS.hotkeyDec : KEYS.hotkeyInc;
          const def = el.id === "hotkeyDec" ? DEFAULTS.hotkeyDec : DEFAULTS.hotkeyInc;
          el.value = res[key] || def;
        }
      );
    });
  });

  /* ── Util ─────────────────────────────────────────────────── */
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }
})();