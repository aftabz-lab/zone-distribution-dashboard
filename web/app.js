const COLORS = ["#0b607f","#d71920","#49a3b8","#f29b38","#617a8a","#9b65a5","#6aa45f","#c46c83","#a88445"];
const numberFmt = new Intl.NumberFormat("en-US");
const decimalFmt = new Intl.NumberFormat("en-US",{maximumFractionDigits:0});
const compactFmt = new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1});

const COLUMNS = [
  ["SL","SL","number"],
  ["CODE","CODE","text"],
  ["Outlet Name","Outlet Name","text"],
  ["Regional Head ID","Regional Head ID","text"],
  ["Regional Head HR Name","Regional Head HR Name","text"],
  ["Leader","Leader","text"],
  ["Regional Head Contact","Regional Head Contact","text"],
  ["Zonal ID","Zonal ID","text"],
  ["Zonal HR Name","Zonal HR Name","text"],
  ["Zonal","Zonal","text"],
  ["Zonal Contact","Zonal Contact","text"],
  ["Launching Date","Launching Date","date"],
  ["SFT","SFT","number"],
  ["Format","Format","text"],
  ["Division","Division","text"],
  ["District","District","text"],
  ["Area","Area","text"],
  ["PNP Non PNP status","PNP / Non-PNP","text"],
  ["Status","Status","text"],
  ["Geo Location","Geo Location","url"],
  ["Location Type","Location Type","text"],
  ["Location Type(Dv,Ds,T)","Location Type (Dv, Ds, T)","text"],
  ["Population Density","Population Density","text"],
  ["Income level","Income Level","text"],
  ["Floor type","Floor Type","text"],
  ["Layout shape","Layout Shape","text"],
];
const CORE_COLUMNS = new Set([
  "SL","CODE","Outlet Name","Regional Head HR Name","Zonal HR Name",
  "Launching Date","SFT","Format","Division","District","Area",
  "PNP Non PNP status","Status","Location Type","Population Density","Income level"
]);

const state = {
  data:null,
  rows:[],
  filtered:[],
  search:"",
  filters:{},
  sortKey:"SL",
  sortDirection:"asc",
  page:1,
  pageSize:100,
  visibleColumns:new Set(COLUMNS.map(c=>c[0])),
  detailFilter:null,
  personnelMode:null,
};

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));

function formatDate(value){
  if(!value) return "";
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if(!m) return String(value);
  const dt=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
  return dt.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
}
function normalize(value){ return String(value ?? "").trim().toLocaleLowerCase(); }
function uniqueSortedFromRows(rows,key){
  return [...new Set(rows.map(r=>String(r[key] ?? "").trim()).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}

function rowMatchesSearch(row){
  const search=normalize(state.search);
  if(!search) return true;
  for(const [key] of COLUMNS){
    if(normalize(row[key]).includes(search)) return true;
  }
  return false;
}

function rowMatchesFilters(row,excludeKey=""){
  for(const [key,value] of Object.entries(state.filters)){
    if(!value || key===excludeKey) continue;
    if(String(row[key] ?? "") !== value) return false;
  }
  return true;
}

function rowsForFacet(key){
  return state.rows.filter(row=>rowMatchesSearch(row) && rowMatchesFilters(row,key));
}

function populateSelect(select,rows=null){
  const key=select.dataset.filter;
  const current=state.filters[key] || "";
  const sourceRows=rows || state.rows;
  const opts=uniqueSortedFromRows(sourceRows,key);
  select.innerHTML=`<option value="">All</option>`+opts.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if(current && opts.includes(current)) select.value=current;
  else select.value="";
}

function syncCascadingFilters(){
  const selects=[...document.querySelectorAll("select[data-filter]")];

  // If a newly selected filter makes another active filter impossible,
  // clear only the impossible filter. Repeat until the combination is valid.
  for(let pass=0;pass<selects.length;pass++){
    let changed=false;
    for(const select of selects){
      const key=select.dataset.filter;
      const current=state.filters[key] || "";
      if(!current) continue;
      const allowed=uniqueSortedFromRows(rowsForFacet(key),key);
      if(!allowed.includes(current)){
        state.filters[key]="";
        changed=true;
      }
    }
    if(!changed) break;
  }

  // Faceted/cascading dropdowns:
  // each dropdown shows only values compatible with all OTHER active filters.
  for(const select of selects){
    populateSelect(select,rowsForFacet(select.dataset.filter));
  }
}

function initFilters(){
  const selects=[...document.querySelectorAll("select[data-filter]")];
  selects.forEach(select=>{
    populateSelect(select);
    select.addEventListener("change",()=>{
      state.filters[select.dataset.filter]=select.value;
      state.page=1;
      clearDetailFilter(false);
      syncCascadingFilters();
      applyFilters(false);
    });
  });

  $("global-search").addEventListener("input",e=>{
    state.search=e.target.value;
    state.page=1;
    clearDetailFilter(false);
    // Search affects results immediately; dropdown selections are preserved.
    applyFilters(false);
  });

  $("reset-filters").addEventListener("click",()=>{
    state.search="";
    state.filters={};
    $("global-search").value="";
    state.page=1;
    clearDetailFilter(false);
    syncCascadingFilters();
    applyFilters(false);
  });

  $("advanced-toggle").addEventListener("click",()=>{
    $("advanced-filters").classList.toggle("hidden");
    $("advanced-toggle").textContent=$("advanced-filters").classList.contains("hidden")?"More filters":"Fewer filters";
  });
}

function applyFilters(syncFacets=true){
  if(syncFacets) syncCascadingFilters();

  state.filtered=state.rows.filter(row=>{
    if(!rowMatchesSearch(row)) return false;
    return rowMatchesFilters(row);
  });

  sortRows();
  renderAll();
}

function clearDetailFilter(render=true){
  state.detailFilter=null;
  state.personnelMode=null;
  state.page=1;
  renderPersonnelDirectories();
  if(render) renderTable();
}

function detailFilteredRows(){
  if(!state.detailFilter) return state.filtered;
  const f=state.detailFilter;

  if(f.mode==="all") return state.filtered;
  if(f.mode==="nonblank"){
    return state.filtered.filter(row=>String(row[f.key] ?? "").trim()!=="");
  }
  if(f.mode==="blank"){
    return state.filtered.filter(row=>String(row[f.key] ?? "").trim()==="");
  }

  if(f.mode==="zonal-only"){
    return zonalRowsExcludingRhoNames(state.filtered);
  }

  const wanted=String(f.value ?? "").trim();
  return state.filtered.filter(row=>String(row[f.key] ?? "").trim()===wanted);
}

function renderDetailFilterChip(){
  const chip=$("detail-filter-chip"), text=$("detail-filter-text");
  if(!chip || !text) return;
  if(!state.detailFilter){
    chip.classList.add("hidden");
    text.textContent="";
    return;
  }

  const f=state.detailFilter;
  const actual=detailFilteredRows().length;
  const base=f.description || (
    f.mode==="all" ? (f.label || "Current view") :
    f.mode==="nonblank" ? `${f.label || f.key}: mapped outlets` :
    f.mode==="blank" ? `${f.label || f.key}: blank` :
    `${f.label || f.key}: ${f.value}`
  );
  text.textContent=`${base} · ${numberFmt.format(actual)} outlet(s)`;
  chip.classList.remove("hidden");
}

function scrollToDetailView(){
  const target=$("detail-view");
  if(target) target.scrollIntoView({behavior:"smooth",block:"start"});
}

function personnelNameKey(value){
  return String(value ?? "").trim().replace(/\s+/g," ").toLowerCase();
}

function rhoNameSet(rows){
  return new Set(
    rows
      .map(row=>personnelNameKey(row["Regional Head HR Name"]))
      .filter(Boolean)
  );
}

function zonalRowsExcludingRhoNames(rows){
  const rhoNames=rhoNameSet(rows);
  return rows.filter(row=>{
    const zonalName=personnelNameKey(row["Zonal HR Name"]);
    return zonalName && !rhoNames.has(zonalName);
  });
}

function formatMobile(value){
  const text=String(value ?? "").trim();
  if(!text) return "";
  const digits=text.replace(/\D/g,"");
  if(digits.length===10 && digits.startsWith("1")) return `0${digits}`;
  if(digits.length===13 && digits.startsWith("880")) return `+${digits}`;
  return text;
}

function uniquePersonnel(rows,mode){
  const isRho=mode==="rho";
  const nameKey=isRho ? "Regional Head HR Name" : "Zonal HR Name";
  const idKey=isRho ? "Regional Head ID" : "Zonal ID";
  const contactKey=isRho ? "Regional Head Contact" : "Zonal Contact";
  const map=new Map();
  const rhoNames=isRho ? new Set() : rhoNameSet(rows);

  rows.forEach(row=>{
    const name=String(row[nameKey] ?? "").trim();
    const id=String(row[idKey] ?? "").trim();
    const mobile=formatMobile(row[contactKey]);
    if(!name && !id && !mobile) return;

    // If the same person's name appears in RHO and Zonal data,
    // show that person only in the RHO section.
    if(!isRho && rhoNames.has(personnelNameKey(name))) return;
    const key=`${name}|${id}|${mobile}`;
    if(!map.has(key)) map.set(key,{name,id,mobile});
  });

  return [...map.values()].sort((a,b)=>
    a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}) ||
    a.id.localeCompare(b.id,undefined,{numeric:true,sensitivity:"base"})
  );
}

function renderPersonnelDirectories(){
  const rhoCard=$("rho-directory"), zonalCard=$("zonal-directory");
  if(!rhoCard || !zonalCard) return;

  const rhoPeople=uniquePersonnel(state.filtered,"rho");
  const zonalPeople=uniquePersonnel(state.filtered,"zonal");

  $("rho-directory-summary").textContent=
    `${numberFmt.format(rhoPeople.length)} Regional Head(s) in the current filtered view.`;
  $("rho-directory-body").innerHTML=rhoPeople.length
    ? rhoPeople.map(p=>`<tr>
        <td>${esc(p.name)}</td>
        <td>${esc(p.id)}</td>
        <td>${esc(p.mobile)}</td>
      </tr>`).join("")
    : `<tr><td colspan="3"><div class="empty-state">No Regional Head records found.</div></td></tr>`;

  $("zonal-directory-summary").textContent=
    `${numberFmt.format(zonalPeople.length)} Zonal(s) in the current filtered view.`;
  $("zonal-directory-body").innerHTML=zonalPeople.length
    ? zonalPeople.map(p=>`<tr>
        <td>${esc(p.name)}</td>
        <td>${esc(p.id)}</td>
        <td>${esc(p.mobile)}</td>
      </tr>`).join("")
    : `<tr><td colspan="3"><div class="empty-state">No Zonal records found.</div></td></tr>`;

  // Always keep both windows visible at the bottom of the dashboard.
  rhoCard.classList.remove("hidden");
  zonalCard.classList.remove("hidden");
}


function setDetailFilter(key,value,label,description="",mode="value",personnel=""){
  state.detailFilter={key,value,label,description,mode};
  state.personnelMode=personnel || null;
  state.page=1;
  renderTable();
  renderPersonnelDirectories();
  scrollToDetailView();
}

function attachDrilldownHandlers(target){
  target.querySelectorAll("[data-drill-key]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      setDetailFilter(
        btn.dataset.drillKey || "",
        btn.dataset.drillValue || "",
        btn.dataset.drillLabel || btn.dataset.drillKey || "Current view",
        btn.dataset.drillDescription || "",
        btn.dataset.drillMode || "value",
        btn.dataset.personnel || ""
      );
    });
  });
}


function compareValues(a,b,type){
  if(type==="number"){
    const an=Number(a), bn=Number(b);
    if(Number.isFinite(an)&&Number.isFinite(bn)) return an-bn;
  }
  if(type==="date"){
    const at=Date.parse(a||""), bt=Date.parse(b||"");
    if(Number.isFinite(at)&&Number.isFinite(bt)) return at-bt;
  }
  return String(a??"").localeCompare(String(b??""),undefined,{numeric:true,sensitivity:"base"});
}
function sortRows(){
  const def=COLUMNS.find(c=>c[0]===state.sortKey) || COLUMNS[0];
  const type=def[2];
  const direction=state.sortDirection==="asc"?1:-1;
  state.filtered.sort((a,b)=>compareValues(a[state.sortKey],b[state.sortKey],type)*direction);
}
function setSort(key){
  if(state.sortKey===key) state.sortDirection=state.sortDirection==="asc"?"desc":"asc";
  else { state.sortKey=key; state.sortDirection="asc"; }
  state.page=1;
  sortRows();
  renderTable();
}

function sum(rows,key){
  return rows.reduce((acc,r)=>{
    const n=Number(r[key]);
    return acc+(Number.isFinite(n)?n:0);
  },0);
}
function countDistinct(rows,key){
  return new Set(rows.map(r=>String(r[key]??"").trim()).filter(Boolean)).size;
}
function countValue(rows,key,value){
  return rows.filter(r=>String(r[key]??"")===value).length;
}
function renderKpis(){
  const r=state.filtered;
  const totalSft=sum(r,"SFT");
  const avgSft=r.length?totalSft/r.length:0;
  const pnp=countValue(r,"PNP Non PNP status","PNP");
  const nonPnp=countValue(r,"PNP Non PNP status","Non-PNP");
  const own=countValue(r,"Status","OWN");
  const fr=countValue(r,"Status","FR");
  const rhoQty=countDistinct(r,"Regional Head HR Name");
  const zonalQty=uniquePersonnel(r,"zonal").length;
  const districts=countDistinct(r,"District");

  const defs=[
    {label:"Visible Outlets",value:numberFmt.format(r.length),note:`${numberFmt.format(state.rows.length)} total source rows`,cls:"accent",
      drill:{key:"",value:"",label:"Visible Outlets",mode:"all",description:"Visible outlets in current filtered view"}},
    {label:"Total SFT",value:numberFmt.format(Math.round(totalSft)),note:"filtered network area",cls:"",
      drill:{key:"",value:"",label:"Total SFT",mode:"all",description:"Outlets contributing to Total SFT"}},
    {label:"Average SFT",value:numberFmt.format(Math.round(avgSft)),note:"per visible outlet",cls:"",
      drill:{key:"",value:"",label:"Average SFT",mode:"all",description:"Outlets contributing to Average SFT"}},
    {label:"PNP",value:numberFmt.format(pnp),note:"visible outlets",cls:"accent",
      drill:{key:"PNP Non PNP status",value:"PNP",label:"PNP",mode:"value",description:"PNP outlets"}},
    {label:"Non-PNP",value:numberFmt.format(nonPnp),note:"visible outlets",cls:"",
      drill:{key:"PNP Non PNP status",value:"Non-PNP",label:"Non-PNP",mode:"value",description:"Non-PNP outlets"}},
    {label:"OWN",value:numberFmt.format(own),note:"visible outlets",cls:"accent",
      drill:{key:"Status",value:"OWN",label:"OWN",mode:"value",description:"OWN outlets"}},
    {label:"FR",value:numberFmt.format(fr),note:"visible outlets",cls:"",
      drill:{key:"Status",value:"FR",label:"FR",mode:"value",description:"FR outlets"}},
    {label:"RHO Qty",value:numberFmt.format(rhoQty),note:"regional heads in current view",cls:"accent",
      drill:{key:"Regional Head HR Name",value:"",label:"RHO Qty",mode:"nonblank",
        description:`Outlets under ${numberFmt.format(rhoQty)} RHO(s)`,personnel:"rho"}},
    {label:"Zonal Qty",value:numberFmt.format(zonalQty),note:"zonals in current view",cls:"",
      drill:{key:"Zonal HR Name",value:"",label:"Zonal Qty",mode:"zonal-only",
        description:`Outlets under ${numberFmt.format(zonalQty)} Zonal(s) excluding names already listed as RHO`,personnel:"zonal"}},
    {label:"Districts",value:numberFmt.format(districts),note:"represented in current view",cls:"",
      drill:{key:"",value:"",label:"Districts",mode:"all",description:`Outlets across ${numberFmt.format(districts)} district(s)`}},
  ];

  $("kpi-grid").innerHTML=defs.map(d=>`<article class="kpi ${d.cls}">
    <div class="kpi-label">${esc(d.label)}</div>
    <button type="button" class="kpi-value kpi-drill-value"
      data-drill-key="${esc(d.drill.key)}"
      data-drill-value="${esc(d.drill.value)}"
      data-drill-label="${esc(d.drill.label)}"
      data-drill-mode="${esc(d.drill.mode)}"
      data-drill-description="${esc(d.drill.description)}"
      ${d.drill.personnel?`data-personnel="${esc(d.drill.personnel)}"`:""}
      title="Show related details">${esc(d.value)}</button>
    <div class="kpi-note">${esc(d.note)}</div>
  </article>`).join("");

  attachDrilldownHandlers($("kpi-grid"));
}


function frequencies(rows,key){
  const map=new Map();
  rows.forEach(r=>{
    const v=String(r[key]??"").trim()||"(blank)";
    map.set(v,(map.get(v)||0)+1);
  });
  return [...map.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
}
function renderDonut(targetId,key){
  const target=$(targetId), entries=frequencies(state.filtered,key);
  if(!state.filtered.length){ target.innerHTML=`<div class="empty-state">No matching rows</div>`; return; }

  const total=entries.reduce((a,b)=>a+b[1],0);
  let angle=0, stops=[];
  entries.forEach(([label,value],i)=>{
    const pct=value/total*100;
    stops.push(`${COLORS[i%COLORS.length]} ${angle}% ${angle+pct}%`);
    angle+=pct;
  });

  const legend=entries.slice(0,8).map(([label,value],i)=>{
    const isBlank=label==="(blank)";
    return `<div class="legend-row">
      <span class="legend-dot" style="background:${COLORS[i%COLORS.length]}"></span>
      <span class="legend-label" title="${esc(label)}">${esc(label)}</span>
      <button type="button" class="legend-value drill-count-btn"
        data-drill-key="${esc(key)}"
        data-drill-value="${esc(isBlank?"":label)}"
        data-drill-label="${esc(key)}"
        data-drill-mode="${isBlank?"blank":"value"}"
        data-drill-description="${esc(`${key}: ${label}`)}"
        title="Show exactly these ${numberFmt.format(value)} outlet(s) in Detail View">${numberFmt.format(value)}</button>
    </div>`;
  }).join("");

  target.innerHTML=`<div class="donut-wrap">
    <div class="donut" style="background:conic-gradient(${stops.join(",")})">
      <div class="donut-center">${numberFmt.format(total)}</div>
    </div>
    <div class="legend">${legend}</div>
  </div>`;
  attachDrilldownHandlers(target);
}

function renderBars(targetId,key,limit=7){
  const target=$(targetId), entries=frequencies(state.filtered,key).slice(0,limit);
  if(!entries.length){ target.innerHTML=`<div class="empty-state">No matching rows</div>`; return; }

  const max=entries[0][1] || 1;
  target.innerHTML=`<div class="bars">${entries.map(([label,value])=>{
    const isBlank=label==="(blank)";
    return `<div class="bar-row">
      <div class="bar-label" title="${esc(label)}">${esc(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,value/max*100)}%"></div></div>
      <button type="button" class="bar-value drill-count-btn"
        data-drill-key="${esc(key)}"
        data-drill-value="${esc(isBlank?"":label)}"
        data-drill-label="${esc(key)}"
        data-drill-mode="${isBlank?"blank":"value"}"
        data-drill-description="${esc(`${key}: ${label}`)}"
        title="Show exactly these ${numberFmt.format(value)} outlet(s) in Detail View">${numberFmt.format(value)}</button>
    </div>`;
  }).join("")}</div>`;
  attachDrilldownHandlers(target);
}

function renderCharts(){
  renderDonut("chart-format","Format");
  renderDonut("chart-status","Status");
  renderBars("chart-division","Division",9);
  renderBars("chart-location","Location Type",7);
}

function columnClass(key){
  const index=COLUMNS.findIndex(c=>c[0]===key);
  if(index===0) return "sticky-col-1";
  if(index===1) return "sticky-col-2";
  if(index===2) return "sticky-col-3";
  return "";
}
function renderHead(){
  const columns=COLUMNS.filter(c=>state.visibleColumns.has(c[0]));
  $("table-head").innerHTML=columns.map(([key,label])=>{
    const sorted=state.sortKey===key;
    const mark=sorted?(state.sortDirection==="asc"?"▲":"▼"):"↕";
    return `<th data-key="${esc(key)}" class="${columnClass(key)} ${sorted?"sorted":""}">${esc(label)} <span class="sort-mark">${mark}</span></th>`;
  }).join("");
  $("table-head").querySelectorAll("th").forEach(th=>th.addEventListener("click",()=>setSort(th.dataset.key)));
}
function renderCell(row,col){
  const [key,,type]=col;
  let value=row[key];
  let display=value ?? "";
  let cls=columnClass(key);
  if(type==="number"){
    cls+=(cls?" ":"")+"numeric";
    display=(value===null||value==="")?"":numberFmt.format(Number(value));
  } else if(type==="date"){
    display=formatDate(value);
  } else if(type==="url"){
    const url=String(value||"").trim();
    if(url && /^https?:\/\//i.test(url)){
      return `<td class="${cls}"><a href="${esc(url)}" target="_blank" rel="noopener">Open map ↗</a></td>`;
    }
  }
  const title=String(display).length>32?` title="${esc(display)}"`:"";
  return `<td class="${cls}"${title}>${esc(display)}</td>`;
}
function pageRows(){
  const rows=detailFilteredRows();
  if(state.pageSize==="all") return rows;
  const start=(state.page-1)*state.pageSize;
  return rows.slice(start,start+state.pageSize);
}
function renderTable(){
  renderHead();
  const columns=COLUMNS.filter(c=>state.visibleColumns.has(c[0]));
  const rows=pageRows();
  $("table-body").innerHTML=rows.length
    ? rows.map(row=>`<tr>${columns.map(col=>renderCell(row,col)).join("")}</tr>`).join("")
    : `<tr><td colspan="${Math.max(1,columns.length)}"><div class="empty-state">No outlet rows match the selected detail link.</div></td></tr>`;

  const detailRows=detailFilteredRows();
  const total=detailRows.length;
  const pageCount=state.pageSize==="all"?1:Math.max(1,Math.ceil(total/state.pageSize));
  if(state.page>pageCount) state.page=pageCount;
  const from=total===0?0:(state.pageSize==="all"?1:(state.page-1)*state.pageSize+1);
  const to=state.pageSize==="all"?total:Math.min(total,state.page*state.pageSize);
  $("table-summary").textContent=`${numberFmt.format(total)} detail outlet(s) · showing ${numberFmt.format(from)}–${numberFmt.format(to)} · sorted by ${state.sortKey} ${state.sortDirection==="asc"?"ascending":"descending"}`;
  renderDetailFilterChip();
  $("page-info").textContent=state.pageSize==="all"?`All ${numberFmt.format(total)} rows`:`Page ${state.page} of ${pageCount}`;
  $("prev-page").disabled=state.page<=1 || state.pageSize==="all";
  $("next-page").disabled=state.page>=pageCount || state.pageSize==="all";
}
function renderAll(){
  renderKpis();
  renderCharts();
  renderTable();
  renderPersonnelDirectories();
}

function initPagination(){
  $("page-size").value=String(state.pageSize);
  $("page-size").addEventListener("change",e=>{
    state.pageSize=e.target.value==="all"?"all":Number(e.target.value);
    state.page=1;
    renderTable();
  });
  $("prev-page").addEventListener("click",()=>{if(state.page>1){state.page--;renderTable();}});
  $("next-page").addEventListener("click",()=>{
    if(state.pageSize==="all") return;
    const pages=Math.ceil(detailFilteredRows().length/state.pageSize);
    if(state.page<pages){state.page++;renderTable();}
  });
}

function initColumnChooser(){
  const options=$("column-options");
  options.innerHTML=COLUMNS.map(([key,label])=>
    `<label class="column-option"><input type="checkbox" data-column="${esc(key)}" checked><span>${esc(label)}</span></label>`
  ).join("");
  options.querySelectorAll("input[data-column]").forEach(cb=>cb.addEventListener("change",()=>{
    if(cb.checked) state.visibleColumns.add(cb.dataset.column);
    else state.visibleColumns.delete(cb.dataset.column);
    if(!state.visibleColumns.size){ state.visibleColumns.add("CODE"); }
    renderTable();
  }));
  $("column-toggle").addEventListener("click",()=>$("column-panel").classList.toggle("hidden"));
  $("show-all-columns").addEventListener("click",()=>{
    state.visibleColumns=new Set(COLUMNS.map(c=>c[0]));
    options.querySelectorAll("input[data-column]").forEach(cb=>cb.checked=true);
    renderTable();
  });
  $("core-columns").addEventListener("click",()=>{
    state.visibleColumns=new Set(CORE_COLUMNS);
    options.querySelectorAll("input[data-column]").forEach(cb=>cb.checked=CORE_COLUMNS.has(cb.dataset.column));
    renderTable();
  });
}

function csvCell(value){
  const text=String(value??"");
  return `"${text.replaceAll('"','""')}"`;
}
function downloadCsv(){
  const cols=COLUMNS;
  const lines=[cols.map(c=>csvCell(c[1])).join(",")];
  detailFilteredRows().forEach(r=>lines.push(cols.map(c=>csvCell(r[c[0]])).join(",")));
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download="zone_distribution_filtered.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function init(){
  try{
    const res=await fetch("data/dashboard_data.json",{cache:"no-store"});
    if(!res.ok) throw new Error(`Could not load dashboard data (${res.status})`);
    state.data=await res.json();
    state.rows=state.data.rows || [];
    state.filtered=[...state.rows];

    const cfg=state.data.config || {};
    $("dashboard-title").textContent=cfg.title || "Zone Distribution Dashboard";
    $("dashboard-subtitle").textContent=cfg.subtitle || "";
    $("table-title").textContent=cfg.tableTitle || "Outlet-wise Zone Distribution";
    document.title=cfg.title || "Zone Distribution Dashboard";

    if(cfg.defaultPageSize) state.pageSize=Number(cfg.defaultPageSize);
    if(cfg.defaultSort){
      state.sortKey=cfg.defaultSort.column || "SL";
      state.sortDirection=cfg.defaultSort.direction || "asc";
    }

    const meta=state.data.meta || {};
    $("source-badge").textContent=`${meta.rowCount?.toLocaleString?.() || state.rows.length} rows · schema-detected workbook`;
    $("source-badge").title=`Source file: ${meta.sourceWorkbook || ""}\nWorksheet: ${meta.sourceWorksheet || ""}`;
    const quality=(meta.duplicateCodes||0)+(meta.blankCodes||0);
    $("quality-badge").textContent=quality===0?"Data check: codes clean":`Data check: ${meta.duplicateCodes||0} duplicate · ${meta.blankCodes||0} blank codes`;
    if(quality) $("quality-badge").style.background="rgba(215,25,32,.18)";

    initFilters();
    initPagination();
    initColumnChooser();
    $("clear-detail-filter").addEventListener("click",()=>clearDetailFilter(true));
    $("download-csv").addEventListener("click",downloadCsv);
    applyFilters();

    // Exposed so local-source-init.js can swap in rows read from a folder on
    // this computer and re-render, without duplicating any of the logic above.
    window.__dashboardState = state;
    window.__dashboardRefresh = () => { initFilters(); applyFilters(); };
  }catch(err){
    document.body.innerHTML=`<div style="padding:40px;font-family:Segoe UI,Arial"><h2>Dashboard could not load</h2><p>${esc(err.message)}</p><p>Run <code>python scripts/build.py</code> and deploy the generated <code>site</code> folder.</p></div>`;
  }
}
init();
