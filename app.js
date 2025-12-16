(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- toast / clipboard ----------
  async function copyToClipboard(text){
    await navigator.clipboard.writeText(String(text ?? ""));
  }
  let toastTimer = null;
  function toast(msg){
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 850);
  }

  // ---------- parsing ----------
  function normalizeText(input){
    return (input ?? "")
      .replaceAll('"codigo_de_rasteio"', '"codigo_de_rastreio"')
      .replaceAll("'codigo_de_rasteio'", "'codigo_de_rastreio'");
  }

  function coerceToJSONArray(text){
    let t = normalizeText((text ?? "").trim());
    if (!t) return "[]";
    if (t.startsWith("[") && t.endsWith("]")) return t;
    if (!t.startsWith("[") && t.endsWith("]")) return "[" + t;
    if (t.startsWith("{") && t.endsWith("}")) return "[" + t + "]";
    if (t.includes("},") && t.includes('"Nome"')) {
      t = t.replace(/,\s*$/,"");
      return "[" + t + "]";
    }
    return t;
  }

  function safeJSONParse(text){
    const fixed = coerceToJSONArray(text);
    return { fixed, data: JSON.parse(fixed) };
  }

  function normRecord(r){
    const tracking =
      Array.isArray(r.codigo_de_rastreio) ? r.codigo_de_rastreio :
      Array.isArray(r.codigo_de_rasteio) ? r.codigo_de_rasteio :
      (typeof r.codigo_de_rastreio === "string" && r.codigo_de_rastreio.trim()) ? [r.codigo_de_rastreio.trim()] : [];

    return {
      nome: String(r.Nome ?? "").trim(),
      tracking,
      trackingOne: tracking[0] ?? "",
      telefone: (r.telefone == null) ? "" : String(r.telefone),
      marketplace: String(r.codigo_de_marketplace ?? "").trim(),
      marketplaceOrder: String(r.codigo_de_cada_marketplace ?? "").trim(),
      cidade: (r.cidade == null) ? "" : String(r.cidade).trim(),
      estado: (r.estado == null) ? "" : String(r.estado).trim(),
      done: !!r.done
    };
  }

  function toExportObject(r){
    return {
      Nome: r.nome || null,
      codigo_de_rastreio: Array.isArray(r.tracking) ? r.tracking : [],
      telefone: r.telefone ? r.telefone : null,
      codigo_de_marketplace: r.marketplace || null,
      codigo_de_cada_marketplace: r.marketplaceOrder || null,
      cidade: r.cidade || null,
      estado: r.estado || null,
      done: !!r.done
    };
  }

  // ---------- CSV ----------
  function escapeCSV(v){
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return '"' + s.replaceAll('"','""') + '"';
    return s;
  }
  function buildCSV(list){
    const headers=["Nome","CodigoRastreio","Telefone","Marketplace","PedidoMarketplace","Cidade","Estado","Done"];
    const lines=[headers.join(",")];
    for (const r of list){
      lines.push([
        escapeCSV(r.nome),
        escapeCSV(r.tracking.join(" | ")),
        escapeCSV(r.telefone),
        escapeCSV(r.marketplace),
        escapeCSV(r.marketplaceOrder),
        escapeCSV(r.cidade),
        escapeCSV(r.estado),
        escapeCSV(String(r.done))
      ].join(","));
    }
    return lines.join("\n");
  }
  function downloadText(filename, text){
    const blob = new Blob([text], { type:"text/plain;charset=utf-8" });
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download=filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  // ---------- state ----------
  let rows = [];
  let view = [];
  let sortKey = "idx";
  let sortDir = "asc";

  // ---------- UI helpers ----------
  function setHint(msg){ $("parseHint").textContent = msg; }
  function showError(msg){ const b=$("errBox"); b.style.display="block"; b.textContent=msg; }
  function clearError(){ const b=$("errBox"); b.style.display="none"; b.textContent=""; }

  function refreshMarketplaceOptions(){
    const sel = $("mp");
    const prev = sel.value;
    const mps = [...new Set(rows.map(r=>r.marketplace).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All marketplaces</option>' + mps.map(mp=>`<option value="${mp}">${mp}</option>`).join("");
    sel.value = mps.includes(prev) ? prev : "";
  }

  function sortView(){
    const dir = sortDir==="asc" ? 1 : -1;
    view.sort((a,b)=>{
      const av = (sortKey==="idx") ? a.idx : (sortKey==="done") ? Number(a.done) : (a[sortKey] ?? "");
      const bv = (sortKey==="idx") ? b.idx : (sortKey==="done") ? Number(b.done) : (b[sortKey] ?? "");
      if (typeof av==="number" && typeof bv==="number") return (av-bv)*dir;
      return String(av).localeCompare(String(bv), "pt-BR", { sensitivity:"base" }) * dir;
    });
  }

  // ---------- virtualization ----------
  const rowH = 54;        // must match --rowH
  const overscan = 10;
  let lastRange = { start: 0, end: -1 };
  let rafScroll = 0;

  function updateRowCountPill(){
    $("rowsPill").innerHTML = `<b>${view.length}</b> <span>rows (filtered)</span>`;
  }

  function updateVirtual(resetScroll){
    updateRowCountPill();
    const total = view.length * rowH;

    if (resetScroll) $("viewport").scrollTop = 0;
    $("topSpacer").style.height = "0px";
    $("botSpacer").style.height = total + "px";

    lastRange = { start: 0, end: -1 };
    renderVisible();
  }

  // safe escape for HTML text + attribute
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const escAttr = esc;

  function renderVisible(){
    const vp = $("viewport");
    const host = $("rowsHost");

    const scrollTop = vp.scrollTop;
    const vpH = vp.clientHeight;

    const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
    const end = Math.min(view.length, start + Math.ceil(vpH / rowH) + overscan*2);

    if (start === lastRange.start && end === lastRange.end) return;
    lastRange = { start, end };

    $("topSpacer").style.height = (start * rowH) + "px";
    $("botSpacer").style.height = Math.max(0, (view.length - end) * rowH) + "px";

    let html = "";
    for (let i = start; i < end; i++){
      const r = view[i];
      const doneClass = r.done ? " rowDone" : "";
      const trackCopy = r.tracking.join(" | ");
      const nome = r.nome || "—";
      const trackOne = r.trackingOne || "";
      const mp = r.marketplace || "";
      const order = r.marketplaceOrder || "—";
      const city = r.cidade || "—";
      const uf = r.estado || "—";

      html += `
        <div class="row${doneClass}" data-idx="${r.idx}">
          <div class="cell mono dim" data-copy="${escAttr(r.idx)}">${esc(r.idx)}</div>
          <div class="cell" data-copy="${escAttr(r.nome || "")}">${esc(nome)}</div>

          <div class="cell" data-copy="${escAttr(trackCopy)}">
            ${trackOne ? `<span class="tag mono">${esc(trackOne)}</span>` : `<span class="dim">—</span>`}
          </div>

          <div class="cell" data-copy="${escAttr(mp)}">
            ${mp ? `<span class="tag">${esc(mp)}</span>` : `<span class="dim">—</span>`}
          </div>

          <div class="cell mono" data-copy="${escAttr(r.marketplaceOrder || "")}">${esc(order)}</div>
          <div class="cell" data-copy="${escAttr(r.cidade || "")}">${esc(city)}</div>
          <div class="cell" data-copy="${escAttr(r.estado || "")}">${esc(uf)}</div>

          <div class="switch" data-on="${r.done}" data-idx="${r.idx}">
            <div class="knob"></div>
          </div>
        </div>
      `;
    }

    host.innerHTML = html;
  }

  function applyFilters(){
    const q = ($("q").value || "").trim().toLowerCase();
    const mp = $("mp").value;
    const done = $("done").value;
    const missing = $("missing").value;

    view = rows.filter(r => {
      if (mp && r.marketplace !== mp) return false;
      if (done !== "" && String(r.done) !== done) return false;
      if (missing === "missing" && (r.cidade && r.estado)) return false;

      if (!q) return true;
      const hay = [
        r.nome, r.tracking.join(" "), r.marketplace, r.marketplaceOrder, r.cidade, r.estado, r.telefone
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });

    sortView();
    updateVirtual(true);
  }

  function parseNow(){
    clearError();
    setHint("Parsing…");
    try{
      const raw = $("raw").value;
      const { data } = safeJSONParse(raw);
      if (!Array.isArray(data)) throw new Error("Parsed data is not an array.");

      rows = data.map(normRecord).map((r,i)=>({ ...r, idx:i+1 }));
      refreshMarketplaceOptions();
      applyFilters();

      setHint("OK");
      return true;
    } catch(e){
      rows = [];
      view = [];
      updateVirtual(true);
      setHint("Error");
      showError(String(e?.message ?? e));
      return false;
    }
  }

  // ---------- debounce ----------
  function debounce(fn, ms=140){
    let t=null;
    return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
  }
  const applyFiltersDebounced = debounce(applyFilters, 140);

  // ---------- events ----------
  $("parseBtn").addEventListener("click", () => parseNow());

  $("copyJsonBtn").addEventListener("click", async ()=>{
    // Copy CURRENT state (including done toggles) as clean JSON array
    const out = rows.map(toExportObject);
    await copyToClipboard(JSON.stringify(out, null, 2));
    toast("Current JSON copied");
  });

  $("csvBtn").addEventListener("click", ()=>{
    const csv = buildCSV(view.length ? view : rows);
    downloadText("extracted.csv", csv);
    toast("CSV downloaded");
  });

  $("copyCsvBtn").addEventListener("click", async ()=>{
    const csv = buildCSV(view.length ? view : rows);
    await copyToClipboard(csv);
    toast("CSV copied");
  });

  $("clearBtn").addEventListener("click", ()=>{
    $("raw").value="";
    rows=[]; view=[];
    clearError();
    setHint("Ready");
    refreshMarketplaceOptions();
    updateVirtual(true);
    toast("Cleared");
  });

  $("sampleBtn").addEventListener("click", ()=>{
    $("raw").value = window.SAMPLE_DATA || "";
    parseNow();
    toast("Sample loaded");
  });

  $("q").addEventListener("input", applyFiltersDebounced);
  $("mp").addEventListener("change", applyFilters);
  $("done").addEventListener("change", applyFilters);
  $("missing").addEventListener("change", applyFilters);

  $("listHeader").addEventListener("click", (e)=>{
    const h = e.target.closest(".hcell");
    if (!h) return;
    const k = h.dataset.k;
    if (!k) return;

    if (sortKey === k) sortDir = (sortDir==="asc" ? "desc" : "asc");
    else { sortKey = k; sortDir="asc"; }

    sortView();
    updateVirtual(true);
    toast(`Sorted: ${k} (${sortDir})`);
  });

  $("viewport").addEventListener("scroll", ()=>{
    if (rafScroll) return;
    rafScroll = requestAnimationFrame(()=>{
      rafScroll = 0;
      renderVisible();
    });
  });

  // click-to-copy + done toggle
  $("rowsHost").addEventListener("click", async (e)=>{
    const sw = e.target.closest(".switch");
    if (sw){
      const idx = Number(sw.dataset.idx);
      const r = rows.find(x => x.idx === idx);
      if (!r) return;
      r.done = !r.done;

      // re-filter keeps view consistent, still fast because list is virtualized
      applyFilters();
      toast(r.done ? "Marked as done" : "Marked as pending");
      return;
    }

    const c = e.target.closest(".cell");
    if (!c || !("copy" in c.dataset)) return;
    const val = c.dataset.copy ?? "";
    await copyToClipboard(val);
    toast(val ? "Copied" : "Nothing to copy");
  });

  $("themeBtn").addEventListener("click", ()=>{
    const b=document.body;
    b.setAttribute("data-theme", b.getAttribute("data-theme")==="dark" ? "light" : "dark");
  });

  $("fxBtn").addEventListener("click", ()=>{
    const b=document.body;
    const on = b.getAttribute("data-fx")==="on";
    b.setAttribute("data-fx", on ? "off" : "on");
    $("fxBtn").textContent = on ? "FX: Off" : "FX: On";
    toast(on ? "FX disabled (faster)" : "FX enabled (prettier)");
  });

  // ---------- boot ----------
  // Start with sample by default (comment these 2 lines if you prefer empty on load)
  if (window.SAMPLE_DATA) $("raw").value = window.SAMPLE_DATA;
  parseNow();
})();
