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
function uniqueSorted(key,rows=state.rows){
  return [...new Set(rows.map(r=>String(r[key] ?? "").trim()).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}
function matchingRows(excludedFilterKey=""){
  const search=normalize(state.search);
  const active=Object.entries(state.filters).filter(([key,value])=>value && key!==excludedFilterKey);
  return state.rows.filter(row=>{
    for(const [key,value] of active){
      if(String(row[key] ?? "") !== value) return false;
    }
    if(search){
      let found=false;
      for(const [key] of COLUMNS){
        if(normalize(row[key]).includes(search)){found=true;break;}
      }
      if(!found) return false;
    }
    return true;
  });
}
function filterOptionValues(key){
  const current=state.filters[key] || "";
  const values=uniqueSorted(key,matchingRows(key));
  // Never silently clear a user's selection. If another filter makes the
  // combination empty, keep the current value available so it can be changed.
  if(current && !values.includes(current)) values.unshift(current);
  return values;
}
function populateSelect(select){
  const key=select.dataset.filter;
  const current=state.filters[key] || "";
  const opts=filterOptionValues(key);
  select.innerHTML=`<option value="">All</option>`+opts.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
  select.value=current;
  select.dispatchEvent(new CustomEvent("filter-options-updated",{bubbles:false}));
}
function refreshFilterOptions(){
  document.querySelectorAll("select[data-filter]").forEach(populateSelect);
}
function initFilters(){
  document.querySelectorAll("select[data-filter]").forEach(select=>{
    populateSelect(select);
    select.addEventListener("change",()=>{
      state.filters[select.dataset.filter]=select.value;
      state.page=1;
      applyFilters();
    });
  });
  $("global-search").addEventListener("input",e=>{
    state.search=e.target.value;
    state.page=1;
    applyFilters();
  });
  $("reset-filters").addEventListener("click",()=>{
    state.search="";
    state.filters={};
    state.sortKeys=null;
    $("global-search").value="";
    document.querySelectorAll("select[data-filter]").forEach(s=>{s.value="";});
    state.page=1;
    applyFilters();
  });
  $("advanced-toggle").addEventListener("click",()=>{
    $("advanced-filters").classList.toggle("hidden");
    $("advanced-toggle").textContent=$("advanced-filters").classList.contains("hidden")?"More filters":"Fewer filters";
  });
}

function applyFilters(){
  state.filtered=matchingRows();
  refreshFilterOptions();
  sortRows();
  renderAll();
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
function sortChain(){
  // state.sortKeys is the multi-level chain; the older single-key fields are
  // kept in step so the header arrows and any other reader keep working.
  if(!Array.isArray(state.sortKeys) || !state.sortKeys.length){
    state.sortKeys=[{key:state.sortKey||COLUMNS[0][0],dir:state.sortDirection||"asc"}];
  }
  return state.sortKeys;
}
function sortRows(){
  const chain=sortChain();
  state.filtered.sort((a,b)=>{
    for(const {key,dir} of chain){
      const def=COLUMNS.find(c=>c[0]===key)||COLUMNS[0];
      const cmp=compareValues(a[key],b[key],def[2])*(dir==="asc"?1:-1);
      if(cmp) return cmp;
    }
    return 0;
  });
}
function setSort(key,additive=false){
  const chain=sortChain();
  const at=chain.findIndex(c=>c.key===key);
  if(additive){
    if(at>=0) chain[at].dir=chain[at].dir==="asc"?"desc":"asc";
    else chain.push({key,dir:"asc"});
  } else if(at===0 && chain.length===1){
    chain[0].dir=chain[0].dir==="asc"?"desc":"asc";
  } else {
    state.sortKeys=[{key,dir:"asc"}];
  }
  const first=sortChain()[0];
  state.sortKey=first.key; state.sortDirection=first.dir;
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
  const defs=[
    ["Visible Outlets",numberFmt.format(r.length),`${numberFmt.format(state.rows.length)} total source rows`,"accent"],
    ["Total SFT",numberFmt.format(Math.round(totalSft)),"filtered network area",""],
    ["Average SFT",numberFmt.format(Math.round(avgSft)),"per visible outlet",""],
    ["PNP",numberFmt.format(countValue(r,"PNP Non PNP status","PNP")),"visible outlets","accent"],
    ["Non-PNP",numberFmt.format(countValue(r,"PNP Non PNP status","Non-PNP")),"visible outlets",""],
    ["OWN",numberFmt.format(countValue(r,"Status","OWN")),"visible outlets","accent"],
    ["FR",numberFmt.format(countValue(r,"Status","FR")),"visible outlets",""],
    ["Districts",numberFmt.format(countDistinct(r,"District")),"represented in current view",""],
  ];
  $("kpi-grid").innerHTML=defs.map(([label,value,note,cls])=>
    `<article class="kpi ${cls}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-note">${esc(note)}</div></article>`
  ).join("");
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
  const legend=entries.slice(0,8).map(([label,value],i)=>
    `<div class="legend-row"><span class="legend-dot" style="background:${COLORS[i%COLORS.length]}"></span><span class="legend-label" title="${esc(label)}">${esc(label)}</span><span class="legend-value">${numberFmt.format(value)}</span></div>`
  ).join("");
  target.innerHTML=`<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${stops.join(",")})"><div class="donut-center">${numberFmt.format(total)}</div></div><div class="legend">${legend}</div></div>`;
}
function renderBars(targetId,key,limit=7){
  const target=$(targetId), entries=frequencies(state.filtered,key).slice(0,limit);
  if(!entries.length){ target.innerHTML=`<div class="empty-state">No matching rows</div>`; return; }
  const max=entries[0][1] || 1;
  target.innerHTML=`<div class="bars">${entries.map(([label,value])=>
    `<div class="bar-row"><div class="bar-label" title="${esc(label)}">${esc(label)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,value/max*100)}%"></div></div><div class="bar-value">${numberFmt.format(value)}</div></div>`
  ).join("")}</div>`;
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
    const chain=sortChain();
    const at=chain.findIndex(c=>c.key===key);
    const rank=at>=0&&chain.length>1?`<sup class="sort-rank">${at+1}</sup>`:"";
    const dirMark=at>=0?(chain[at].dir==="asc"?"▲":"▼"):mark;
    return `<th data-key="${esc(key)}" class="${columnClass(key)} ${at>=0?"sorted":""}" title="Click to sort · Shift-click to add a level">${esc(label)} <span class="sort-mark">${dirMark}${rank}</span></th>`;
  }).join("");
  $("table-head").querySelectorAll("th").forEach(th=>th.addEventListener("click",ev=>setSort(th.dataset.key,ev.shiftKey)));
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
  if(state.pageSize==="all") return state.filtered;
  const start=(state.page-1)*state.pageSize;
  return state.filtered.slice(start,start+state.pageSize);
}
function renderTable(){
  renderHead();
  const columns=COLUMNS.filter(c=>state.visibleColumns.has(c[0]));
  const rows=pageRows();
  $("table-body").innerHTML=rows.length
    ? rows.map(row=>`<tr>${columns.map(col=>renderCell(row,col)).join("")}</tr>`).join("")
    : `<tr><td colspan="${Math.max(1,columns.length)}"><div class="empty-state">No rows match the current filters.</div></td></tr>`;

  const total=state.filtered.length;
  const pageCount=state.pageSize==="all"?1:Math.max(1,Math.ceil(total/state.pageSize));
  if(state.page>pageCount) state.page=pageCount;
  const from=total===0?0:(state.pageSize==="all"?1:(state.page-1)*state.pageSize+1);
  const to=state.pageSize==="all"?total:Math.min(total,state.page*state.pageSize);
  $("table-summary").textContent=`${numberFmt.format(total)} visible outlets · showing ${numberFmt.format(from)}–${numberFmt.format(to)} · sorted by ${state.sortKey} ${state.sortDirection==="asc"?"ascending":"descending"}`;
  $("page-info").textContent=state.pageSize==="all"?`All ${numberFmt.format(total)} rows`:`Page ${state.page} of ${pageCount}`;
  $("prev-page").disabled=state.page<=1 || state.pageSize==="all";
  $("next-page").disabled=state.page>=pageCount || state.pageSize==="all";
}
function renderAll(){
  renderKpis();
  renderCharts();
  renderTable();
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
    const pages=Math.ceil(state.filtered.length/state.pageSize);
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
  state.filtered.forEach(r=>lines.push(cols.map(c=>csvCell(r[c[0]])).join(",")));
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
    $("download-csv").addEventListener("click",downloadCsv);
    applyFilters();
  }catch(err){
    document.body.innerHTML=`<div style="padding:40px;font-family:Segoe UI,Arial"><h2>Dashboard could not load</h2><p>${esc(err.message)}</p><p>Run <code>python scripts/build.py</code> and deploy the generated <code>site</code> folder.</p></div>`;
  }
}
init();
