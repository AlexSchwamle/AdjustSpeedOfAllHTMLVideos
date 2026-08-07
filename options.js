(() => {
  const KEY = "vsc_blacklist";

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const clearAllBtn = document.getElementById("clearAll");
  const savedMsg = document.getElementById("saved");

  function flash() {
    savedMsg.classList.add("show");
    clearTimeout(flash._t);
    flash._t = setTimeout(() => savedMsg.classList.remove("show"), 1200);
  }

  function fmtDate(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return "";
    }
  }

  function render(entries) {
    listEl.innerHTML = "";
    const hasEntries = entries.length > 0;
    emptyEl.style.display = hasEntries ? "none" : "block";
    clearAllBtn.style.display = hasEntries ? "inline" : "none";

    entries.forEach((entry, idx) => {
      const row = document.createElement("div");
      row.className = "entry";

      const info = document.createElement("div");
      info.className = "entry-info";

      const host = document.createElement("div");
      host.className = "entry-host";
      host.textContent = entry.hostname || "(unknown site)";
      info.appendChild(host);

      const sel = document.createElement("div");
      sel.className = "entry-selector";
      sel.title = entry.selector || "";
      sel.textContent = entry.selector || entry.src || "(no selector recorded)";
      info.appendChild(sel);

      if (entry.addedAt) {
        const meta = document.createElement("div");
        meta.className = "entry-meta";
        meta.textContent = "Blocked " + fmtDate(entry.addedAt);
        info.appendChild(meta);
      }

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => removeEntry(idx));

      row.appendChild(info);
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    });
  }

  function load() {
    chrome.storage.local.get([KEY], (res) => {
      if (chrome.runtime.lastError) {
        console.warn("VSC options load failed:", chrome.runtime.lastError.message);
        render([]);
        return;
      }
      render(Array.isArray(res[KEY]) ? res[KEY] : []);
    });
  }

  function save(entries) {
    chrome.storage.local.set({ [KEY]: entries }, () => {
      if (chrome.runtime.lastError) {
        console.warn("VSC options save failed:", chrome.runtime.lastError.message);
        return;
      }
      flash();
    });
    render(entries);
  }

  function removeEntry(idx) {
    chrome.storage.local.get([KEY], (res) => {
      const entries = Array.isArray(res[KEY]) ? res[KEY] : [];
      entries.splice(idx, 1);
      save(entries);
    });
  }

  clearAllBtn.addEventListener("click", () => {
    if (!confirm("Remove all blocked-element entries? This can't be undone.")) return;
    save([]);
  });

  // Keep the page live if another tab's context-menu action or removal changes the list.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) {
      render(Array.isArray(changes[KEY].newValue) ? changes[KEY].newValue : []);
    }
  });

  load();
})();