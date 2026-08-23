/* ═══════════════════════════════════════════════════════════════════════
   filter-enhance.js — makes every filter dropdown searchable and adds a
   free-text search inside the filter panel.
   The original <select data-filter> elements stay in the DOM and remain the
   source of truth: this only puts a searchable box in front of each one and
   writes back with a normal "change" event, so the existing cascading,
   filtering and KPI code runs untouched.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn)
      : fn();

  function optionsOf(select) {
    return [...select.options].map((o) => ({ value: o.value, label: o.textContent }));
  }

  function buildCombo(select) {
    if (select.dataset.comboReady === "1") return;
    select.dataset.comboReady = "1";
    const wrap = document.createElement("div");
    wrap.className = "combo";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "combo-input";
    input.autocomplete = "off";
    input.placeholder = "All";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    const list = document.createElement("div");
    list.className = "combo-list";
    list.hidden = true;
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(input);
    wrap.appendChild(list);
    wrap.appendChild(select);
    select.classList.add("combo-hidden");

    const showValue = () => {
      const picked = select.options[select.selectedIndex];
      input.value = picked && picked.value ? picked.textContent : "";
      input.classList.toggle("has-value", Boolean(select.value));
    };

    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
    const open = (term = "") => {
      const needle = term.trim().toLowerCase();
      const matches = optionsOf(select).filter(
        (o) => !needle || o.label.toLowerCase().includes(needle),
      );
      list.innerHTML = matches.length
        ? matches
            .map(
              (o) =>
                `<button type="button" class="combo-opt${o.value === select.value ? " on" : ""}" data-value="${
                  String(o.value).replace(/"/g, "&quot;")
                }">${o.label}</button>`,
            )
            .join("")
        : `<p class="combo-empty">No match</p>`;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      list.querySelectorAll(".combo-opt").forEach((btn) =>
        btn.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          select.value = btn.dataset.value;
          // Existing handler cascades the other filters and re-applies.
          select.dispatchEvent(new Event("change", { bubbles: true }));
          showValue();
          close();
        }),
      );
    };
    input.addEventListener("focus", () => open(""));
    input.addEventListener("input", () => open(input.value));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { close(); input.blur(); }
      if (ev.key === "Enter") {
        const first = list.querySelector(".combo-opt");
        if (first && !list.hidden) { ev.preventDefault(); first.dispatchEvent(new Event("mousedown")); }
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
    // Cascading repopulates the select; keep the visible text in step.
    new MutationObserver(showValue).observe(select, { childList: true });
    select.addEventListener("change", showValue);
    showValue();
  }

  function addPanelSearch() {
    const panel = document.querySelector(".filter-panel");
    const source = document.getElementById("global-search");
    if (!panel || !source || panel.querySelector(".panel-search")) return;
    const box = document.createElement("div");
    box.className = "panel-search";
    box.innerHTML =
      `<label for="panel-search-input">Search outlets</label>` +
      `<input id="panel-search-input" type="search" autocomplete="off"
         placeholder="Outlet code, name, officer, area — anything">`;
    const actions = panel.querySelector("#reset-filters");
    (actions ? actions.parentNode : panel).insertBefore(box, actions || null);
    const input = box.querySelector("input");
    input.value = source.value;
    // Drives the dashboard's own search so results and dropdowns stay in step.
    input.addEventListener("input", () => {
      source.value = input.value;
      source.dispatchEvent(new Event("input", { bubbles: true }));
    });
    source.addEventListener("input", () => {
      if (document.activeElement !== input) input.value = source.value;
    });
  }
  function enhance() {
    document.querySelectorAll("select[data-filter]").forEach(buildCombo);
    // addPanelSearch();
  }

  ready(() => {
    enhance();
    // Filters are rebuilt whenever new data loads.
    new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true });
  });
})();
