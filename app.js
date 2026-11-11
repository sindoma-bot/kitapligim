/* Kitaplığım — main app */
(() => {
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const low = s => String(s ?? "").toLocaleLowerCase("tr");
const coll = new Intl.Collator("tr", {sensitivity:"base", numeric:true});
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STATUS = {unread:"Okunacak", reading:"Okunuyor", read:"Okundu"};
const CLOTH = [["#6b2a2a","#f2e6d0"],["#24423a","#efe6cf"],["#1f3550","#eadfc6"],["#5a4a1e","#f6eedb"],["#3e2f4f","#efe4d2"],["#7a4b2a","#fbf1e1"],["#2d4b55","#f2e9d6"],["#4a5a2c","#f5eedd"],["#8a3b35","#fff3e4"],["#33373d","#e9dfc8"]];

let books = new Map();   // id -> book
let shelves = new Map(); // id -> {id,name,order}
let loaded = false;
const photoUrls = new Map(); // photoId -> objectURL
const ui = {shelf:"all", status:"all", q:"", sort:"title", view:"grid", select:false, selected:new Set()};
try { const s = JSON.parse(localStorage.getItem("kitaplik-ui") || "{}"); if (s.sort) ui.sort = s.sort; if (s.view) ui.view = s.view; } catch {}
const saveUi = () => { try { localStorage.setItem("kitaplik-ui", JSON.stringify({sort:ui.sort, view:ui.view})); } catch {} };
$("#sortSel").value = ui.sort;

/* ---------- sync with the NAS ----------
   Only active when the app is served by its own server (Synology). On GitHub Pages it stays local. */
const Sync = (() => {
  const st = {enabled:false, busy:false, again:false, timer:null, lastOk:0, state:"local", needLogin:false};
  let rev = 0; try { rev = +localStorage.getItem("kitaplik-rev") || 0; } catch {}
  const setRev = r => { rev = r; try { localStorage.setItem("kitaplik-rev", String(r)); } catch {} };
  const setState = s => { st.state = s; render(); };

  async function api(path, opts={}){
    const ctl = new AbortController(); const t = setTimeout(()=>ctl.abort(), opts.timeout || 20000);
    try { return await fetch(path, {credentials:"same-origin", cache:"no-store", ...opts, signal:ctl.signal}); }
    finally { clearTimeout(t); }
  }

  async function detect(){
    let remembered = false; try { remembered = localStorage.getItem("kitaplik-server")==="1"; } catch {}
    try {
      const r = await api("api/gesundheit", {timeout: remembered ? 4000 : 2500});
      const j = r.ok ? await r.json() : null;
      st.enabled = !!(j && j.app === "kitapligim");
      if (st.enabled) try { localStorage.setItem("kitaplik-server","1"); } catch {}
    } catch { st.enabled = remembered; }
    Lookup.setNas(st.enabled);
    return st.enabled;
  }

  async function uploadPhotos(){
    for (const b of [...books.values()].filter(b=>b._photoUp && b.photoId)) {
      const blob = await Store.getPhoto(b.photoId);
      if (blob) {
        const r = await api(`api/fotos/${encodeURIComponent(b.photoId)}`, {method:"PUT", body:blob, headers:{"Content-Type": blob.type || "image/jpeg"}});
        if (r.status === 401) throw Object.assign(new Error("login"), {login:true});
        if (!r.ok) continue;
      }
      const cur = books.get(b.id); if (!cur) continue;
      delete cur._photoUp; await Store.put("books", cur);
    }
  }

  async function apply(kind, incoming, full){
    const map = kind==="books" ? books : shelves;
    const seen = new Set(), puts = [], dels = [];
    for (const inc of incoming) {
      seen.add(inc.id);
      const local = map.get(inc.id) || tombs[kind].get(inc.id);
      if (local && local._dirty && (local.updatedAt||0) > (inc.updatedAt||0)) continue; // newer local edit still waiting
      if (inc.deleted) { dels.push(inc.id); map.delete(inc.id); tombs[kind].delete(inc.id); }
      else { const r = {...inc}; if (local && local._photoUp && local.photoId === r.photoId) r._photoUp = 1; puts.push(r); map.set(r.id, r); tombs[kind].delete(r.id); }
    }
    if (full) for (const [id, r] of [...map]) if (!seen.has(id) && !r._dirty) { map.delete(id); dels.push(id); }
    if (puts.length) await Store.putMany(kind, puts);
    if (dels.length) await Store.delMany(kind, dels);
  }

  async function run(){
    if (!st.enabled) return;
    if (st.busy) { st.again = true; return; }
    st.busy = true; clearTimeout(st.timer);
    try {
      await uploadPhotos();
      const dirty = k => [...(k==="books"?books:shelves).values(), ...tombs[k].values()].filter(r=>r._dirty);
      const body = {books: dirty("books"), shelves: dirty("shelves")};
      const r = await api(`api/sync?seit=${rev}`, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body), timeout: 60000});
      if (r.status === 401) { st.needLogin = true; setState("login"); showLogin(); return; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      await apply("shelves", d.shelves || [], d.voll);
      await apply("books", d.books || [], d.voll);
      setRev(d.rev || 0);
      st.needLogin = false; st.lastOk = Date.now(); setState("ok");
    } catch (e) {
      if (e && e.login) { st.needLogin = true; setState("login"); showLogin(); }
      else setState("offline");
    } finally {
      st.busy = false;
      if (st.again) { st.again = false; soon(300); }
    }
  }
  function soon(ms = 1500){ if (!st.enabled || st.needLogin) return; clearTimeout(st.timer); st.timer = setTimeout(run, ms); }

  async function login(passwort){
    const r = await api("api/anmelden", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({passwort})});
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error(j.error || "Giriş yapılamadı.");
    st.needLogin = false; setRev(0); await run();
  }
  async function logout(){ try { await api("api/abmelden", {method:"POST"}); } catch {} st.needLogin = true; setState("login"); }

  document.addEventListener("visibilitychange", ()=>{ if (document.visibilityState === "visible") soon(200); });
  window.addEventListener("online", ()=>soon(200));
  setInterval(()=>{ if (document.visibilityState === "visible") soon(0); }, 60000);

  return {
    get enabled(){ return st.enabled; }, get state(){ return st.state; }, get lastOk(){ return st.lastOk; },
    detect, run, soon, login, logout
  };
})();

function showLogin(){
  if (document.querySelector("#loginForm")) return;
  const sh = openSheet(`<div class="sheethead"><h2>NAS'a giriş</h2></div>
    <form class="form" id="loginForm" novalidate>
      <p class="meta" style="margin:0">Kitaplığın NAS'ta saklanıyor. Bu cihazda bir kez şifreni gir, cihaz bir yıl boyunca hatırlar.</p>
      <label class="f">Şifre<input id="f_pw" type="password" autocomplete="current-password" enterkeyhint="go"></label>
      <p class="meta" id="loginErr" style="margin:0;color:var(--danger)" hidden></p>
      <div class="foot"><button type="button" class="btn" data-close>Şimdilik değil</button><button class="btn primary" type="submit" id="loginBtn">Giriş yap</button></div>
    </form>`);
  setTimeout(()=>sh.querySelector("#f_pw").focus(), 60);
  sh.querySelector("#loginForm").addEventListener("submit", async e=>{
    e.preventDefault();
    const btn = sh.querySelector("#loginBtn"), err = sh.querySelector("#loginErr");
    btn.disabled = true; err.hidden = true;
    try { await Sync.login(sh.querySelector("#f_pw").value); closeSheet(); toast("Giriş yapıldı, kitaplar eşitleniyor"); }
    catch (ex) { err.textContent = ex.message || "Giriş yapılamadı."; err.hidden = false; btn.disabled = false; }
  });
}

/* ---------- data ops ----------
   Every change is marked _dirty and stamped with updatedAt; Sync sends it to the NAS when one is present.
   Deletions are kept as tombstones until the NAS has them (only when syncing). */
const tombs = {books:new Map(), shelves:new Map()};
async function putRecords(kind, list, {dirty=true} = {}){
  const now = Date.now();
  for (const r of list) if (dirty) { r.updatedAt = Math.max(now, (r.updatedAt||0) + 1); r._dirty = 1; }
  await Store.putMany(kind, list);
  const map = kind==="books" ? books : shelves;
  for (const r of list) map.set(r.id, r);
  if (dirty) Sync.soon();
}
async function removeRecords(kind, ids){
  const map = kind==="books" ? books : shelves;
  if (Sync.enabled) {
    const now = Date.now();
    const t = ids.map(id => ({id, deleted:true, updatedAt: Math.max(now, (map.get(id)?.updatedAt||0)+1), _dirty:1}));
    await Store.putMany(kind, t);
    for (const r of t) tombs[kind].set(r.id, r);
    Sync.soon();
  } else await Store.delMany(kind, ids);
  for (const id of ids) map.delete(id);
}
async function saveBook(b){ await putRecords("books", [b]); render(); }
async function deleteBooks(ids){
  const photos = ids.map(id => books.get(id)?.photoId).filter(Boolean);
  await removeRecords("books", ids);
  for (const p of photos) { try { await Store.delPhoto(p); } catch {} dropPhotoUrl(p); }
  for (const id of ids) ui.selected.delete(id);
  render();
}
async function saveShelf(s){ await putRecords("shelves", [s]); render(); }
async function deleteShelf(id){
  await removeRecords("shelves", [id]);
  const touched = [];
  for (const b of books.values()) if ((b.shelves||[]).includes(id)) { b.shelves = b.shelves.filter(x => x !== id); touched.push(b); }
  if (touched.length) await putRecords("books", touched);
  render();
}
function shelfByName(name, create){
  const hit = [...shelves.values()].find(s => low(s.name) === low(name));
  if (hit || !create) return hit;
  return {id: Store.newId(), name, order: Date.now() + shelves.size};
}
function dropPhotoUrl(p){ const u = photoUrls.get(p); if (u) { URL.revokeObjectURL(u); photoUrls.delete(p); } }

/* ---------- covers ---------- */
function hashColor(s){ let h=0; for (const c of String(s)) h=(h*31+c.charCodeAt(0))|0; return CLOTH[Math.abs(h)%CLOTH.length]; }
function clothHTML(b){
  const [c, ink] = hashColor((b.title||"")+(b.author||""));
  return `<div class="cloth" style="--c:${c};--ink:${ink}"><div><div class="ct">${esc(b.title||"Adsız")}</div><div class="rule"></div></div><div class="ca">${esc(b.author||"")}</div></div>`;
}
function coverHTML(b){
  if (b.photoId) return `<div class="cover">${clothHTML(b)}<img data-photo="${esc(b.photoId)}" alt="" style="position:absolute;inset:0" hidden></div>`;
  if (b.coverUrl) return `<div class="cover">${clothHTML(b)}<img class="remote" src="${esc(b.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="position:absolute;inset:0" onload="this.naturalWidth<20&&this.remove()" onerror="this.remove()"></div>`;
  return `<div class="cover" aria-hidden="true">${clothHTML(b)}</div>`;
}
/* Covers in the grid load only when they come near the screen (557 covers at once made the start slow). */
let photoIO = null;
function hydrateLazy(root){
  if (!("IntersectionObserver" in window)) return hydratePhotos(root);
  if (!photoIO) photoIO = new IntersectionObserver(entries=>{
    for (const e of entries) if (e.isIntersecting) {
      photoIO.unobserve(e.target);
      const img = e.target.querySelector("img[data-photo]"); if (img) loadPhoto(img);
    }
  }, {rootMargin: "800px 0px"});
  photoIO.disconnect();
  // The img itself is hidden (display:none) until loaded, and hidden elements never intersect, so watch its visible box.
  for (const img of root.querySelectorAll("img[data-photo]")) photoIO.observe(img.parentElement);
}
async function hydratePhotos(root){
  for (const img of root.querySelectorAll("img[data-photo]")) await loadPhoto(img);
}
async function loadPhoto(img){
  {
    const id = img.dataset.photo;
    let url = photoUrls.get(id);
    if (!url) {
      try {
        const blob = await Store.getPhoto(id);
        if (blob) { url = URL.createObjectURL(blob); photoUrls.set(id, url); }
        else if (Sync.enabled) url = `api/fotos/${encodeURIComponent(id)}`;
        else return;
      } catch { return; }
    }
    img.src = url; img.hidden = false;
  }
}

/* ---------- toast / helpers ---------- */
let toastT;
function toast(msg, ms=2800){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true, ms); }
function armable(btn, label, armedLabel, action){
  let t;
  btn.addEventListener("click", async ()=>{
    if (!btn.classList.contains("armed")){ btn.classList.add("armed"); btn.textContent=armedLabel; t=setTimeout(()=>{btn.classList.remove("armed");btn.textContent=label;},3500); return; }
    clearTimeout(t); btn.classList.remove("armed"); btn.textContent=label; btn.disabled=true;
    try { await action(); } finally { btn.disabled=false; }
  });
}
async function offerFile(name, blob){
  const file = new File([blob], name, {type: blob.type});
  if (navigator.canShare && navigator.canShare({files:[file]})) {
    try { await navigator.share({files:[file], title:name}); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
}

/* ---------- derived view ---------- */
const shelfList = () => [...shelves.values()].sort((a,b)=>(a.order??0)-(b.order??0) || coll.compare(a.name,b.name));
function inShelf(b, sid){
  if (sid==="all") return true;
  if (sid==="none") return !(b.shelves||[]).some(s=>shelves.has(s));
  if (sid==="loan") return !!b.loanTo;
  return (b.shelves||[]).includes(sid);
}
function matches(b){
  if (ui.status==="nocover") { if (b.photoId || b.coverUrl) return false; }
  else if (ui.status==="fav") { if ((b.rating||0) < 4) return false; }
  else if (ui.status==="notes") { if (!String(b.note||"").trim()) return false; }
  else if (ui.status!=="all" && (b.status||"unread")!==ui.status) return false;
  if (!ui.q) return true;
  const hay = low([b.title,b.author,b.publisher,b.translator,b.isbn,b.note,b.about,b.loanTo,b.year,b.category,b.origLanguage].join(" "));
  return low(ui.q).split(/\s+/).filter(Boolean).every(w=>hay.includes(w));
}
function sorted(list){
  const t = (a,b)=>coll.compare(a.title||"",b.title||"");
  const by = {
    title:t,
    author:(a,b)=>coll.compare(a.author||"~",b.author||"~")||t(a,b),
    added:(a,b)=>(b.addedAt||0)-(a.addedAt||0),
    year:(a,b)=>(+b.year||0)-(+a.year||0)||t(a,b),
    rating:(a,b)=>(b.rating||0)-(a.rating||0)||t(a,b)
  }[ui.sort] || t;
  return list.sort(by);
}

const svgI = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const NAVI = {
  all: svgI('<path d="M3 5.5c2.5-.9 5.6-.7 8 .7v13.3c-2.4-1.3-5.5-1.5-8-.6zM21 5.5c-2.5-.9-5.6-.7-8 .7v13.3c2.4-1.3 5.5-1.5 8-.6z"/>'),
  unread: svgI('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  reading: svgI('<path d="M12 6c-2-1.5-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13c-3-.5-6 0-8 1.5zM12 6v13"/>'),
  read: svgI('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>'),
  fav: svgI('<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>'),
  notes: svgI('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>'),
  nocover: svgI('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m4 17 5-5 4 4 2-2 5 5M4 3l16 18"/>'),
  loan: svgI('<path d="M4 12h12M12 8l4 4-4 4M20 4v16"/>')};
const STATUS_ICON = {unread: NAVI.unread, reading: NAVI.reading, read: NAVI.read};
function listHTML(view){
  const rows = view.map(b=>{
    const st = b.status||"unread";
    const raf = (b.shelves||[]).map(id=>shelves.get(id)?.name).filter(Boolean).join(", ");
    const sel = ui.selected.has(b.id);
    return `<tr data-id="${esc(b.id)}" ${ui.select?`role="checkbox" aria-checked="${sel}"`:""}>
      <td class="lk"><span class="thumb">${coverHTML(b)}</span><span class="lt"><b>${esc(b.title||"Adsız")}</b><small>${esc(b.author||"")}</small></span></td>
      <td class="la">${esc(b.author||"")}</td>
      <td class="lc">${esc(String(b.category||"").split(/\s*[>›]\s*/).filter(Boolean).pop()||"")}</td>
      <td class="lr">${esc(raf)}</td>
      <td class="ls"><span class="st st-${st}">${STATUS_ICON[st]}${STATUS[st]}</span>${b.loanTo?`<span class="tag loan">Ödünç</span>`:""}</td>
      <td class="lx"><button class="rb" data-rowact="detail" aria-label="Ayrıntılar">${NAVI.all}</button><button class="rb" data-rowact="menu" aria-label="Diğer">⋯</button></td>
    </tr>`;
  }).join("");
  return `<table class="booktable"><thead><tr><th>Kitap</th><th class="la">Yazar</th><th class="lc">Kategori</th><th class="lr">Raf</th><th class="ls">Durum</th><th class="lx"><span class="sr">İşlemler</span></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- reading progress ---------- */
const pct = b => { const p = parseInt(b.pages)||0, c = Math.min(parseInt(b.currentPage)||0, p||Infinity); return p ? Math.round(100*c/p) : 0; };
function progressHTML(b){
  const p = parseInt(b.pages)||0, c = parseInt(b.currentPage)||0;
  return `<div class="prog"><div class="progress"><i style="width:${pct(b)}%"></i></div><div class="progt"><span>${p?`${c} / ${p} sayfa`:c?`${c}. sayfa`:"Sayfa henüz girilmedi"}</span><b>${p?`%${pct(b)}`:""}</b></div></div>`;
}
function renderReading(all){
  const box = $("#readingNow"); if (!box) return;
  const list = all.filter(b=>b.status==="reading").sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  const show = list.length && ui.status==="all" && ui.shelf==="all" && !ui.q && !ui.select;
  box.hidden = !show; if (!show) return;
  box.innerHTML = `<h2 class="rnh">${NAVI.reading}Şu an okuyorum</h2><div class="rnl">${list.slice(0,6).map(b=>`<button type="button" class="rn" data-open="${esc(b.id)}">
      <span class="rnc">${coverHTML(b)}</span><span class="rni"><b>${esc(b.title||"Adsız")}</b><small>${esc(b.author||"")}</small>${progressHTML(b)}</span></button>`).join("")}</div>`;
  hydratePhotos(box);
}
$("#readingNow")?.addEventListener("click", e=>{ const t=e.target.closest("[data-open]"); if (t) openDetail(t.dataset.open); });

/* ---------- render ---------- */
function render(){
  const all = [...books.values()];
  const counts = {all:all.length, none:0, loan:0};
  for (const b of all){ if (inShelf(b,"none")) counts.none++; if (b.loanTo) counts.loan++; }
  const sl = shelfList();
  if (!["all","none","loan"].includes(ui.shelf) && !shelves.has(ui.shelf)) ui.shelf="all";
  if (ui.shelf==="loan" && !counts.loan) ui.shelf="all";
  const chip = (id,name,n) => `<button class="chip" data-shelf="${esc(id)}" aria-pressed="${ui.shelf===id}">${esc(name)}<span class="n">${n}</span></button>`;
  $("#chips").innerHTML = chip("all","Tümü",counts.all) + chip("none","Rafsız",counts.none)
    + sl.map(s=>chip(s.id,s.name,all.filter(b=>(b.shelves||[]).includes(s.id)).length)).join("")
    + (counts.loan ? chip("loan","Ödünçte",counts.loan) : "")
    + `<button class="chip add" id="chipAdd">+ Raf ekle</button>`;
  const cnt = {all:all.length, unread:0, reading:0, read:0, fav:0, notes:0, nocover:0};
  for (const b of all){ cnt[b.status||"unread"]++; if ((b.rating||0)>=4) cnt.fav++; if (String(b.note||"").trim()) cnt.notes++; if (!b.photoId&&!b.coverUrl) cnt.nocover++; }
  const NAV = [["all","Tüm Kitaplar",NAVI.all],["unread","Okunacak",NAVI.unread],["reading","Okunuyor",NAVI.reading],["read","Okundu",NAVI.read],
    ["fav","Favoriler",NAVI.fav],["notes","Notlarım",NAVI.notes],["nocover","Kapaksız",NAVI.nocover]];
  $("#nav").innerHTML = NAV.map(([k,v,ic])=>`<button class="navitem" data-nav="${k}" aria-current="${ui.status===k && (k!=="all" || ui.shelf==="all")}">${ic}<span>${v}</span><b>${cnt[k]}</b></button>`).join("")
    + (counts.loan ? `<button class="navitem" data-nav="loan" aria-current="${ui.shelf==="loan"}">${NAVI.loan}<span>Ödünçte</span><b>${counts.loan}</b></button>` : "");
  $("#navShelves").innerHTML = [["none","Rafsız",counts.none], ...sl.map(s=>[s.id,s.name,all.filter(b=>(b.shelves||[]).includes(s.id)).length])]
    .map(([id,n,c])=>`<button class="navitem sub" data-shelf="${esc(id)}" aria-current="${ui.shelf===id}"><span>${esc(n)}</span><b>${c}</b></button>`).join("");
  $("#statusRow").innerHTML = [["all","Hepsi"],["unread","Okunacak"],["reading","Okunuyor"],["read","Okundu"],["fav","Favoriler"],["notes","Notlarım"],["nocover",`Kapaksız (${cnt.nocover})`]]
    .map(([k,v])=>`<button class="pill" data-status="${k}" aria-pressed="${ui.status===k}">${v}</button>`).join("");
  $("#viewGrid").setAttribute("aria-pressed", ui.view==="grid"); $("#viewList").setAttribute("aria-pressed", ui.view==="list");

  const read = all.filter(b=>b.status==="read").length;
  const syncTxt = !Sync.enabled ? "" : ({ok:" · NAS ile eşit", offline:" · NAS'a ulaşılamıyor, sonra eşitlenecek", login:" · NAS girişi gerekli", local:" · eşitleniyor…"}[Sync.state] || "");
  $("#countline").textContent = loaded ? `${all.length} kitap · ${read} okundu${syncTxt}` : "Kitaplar yükleniyor…";
  $("#sampleBanner").hidden = !all.some(b=>b.sample);

  const view = sorted(all.filter(b=>inShelf(b,ui.shelf) && matches(b)));
  const stName = {all:"Tüm Kitaplar", unread:"Okunacak", reading:"Okunuyor", read:"Okundu", fav:"Favoriler", notes:"Notlarım", nocover:"Kapaksız"}[ui.status] || "";
  const shName = ui.shelf==="all" ? "" : ui.shelf==="none" ? "Rafsız" : ui.shelf==="loan" ? "Ödünçte" : (shelves.get(ui.shelf)?.name || "");
  const vt = shName ? (ui.status!=="all" ? `${shName} · ${stName}` : shName) : stName;
  $("#viewTitle").innerHTML = `<b>${esc(vt)}</b><span>${view.length} kitap${ui.q ? " bulundu" : ""}</span>`;
  const grid = $("#grid");
  grid.className = ui.view==="list" ? "list" : "grid";
  if (ui.view==="list") grid.innerHTML = view.length ? listHTML(view) : "";
  else grid.innerHTML = view.map(b=>{
    const tags = [];
    if (b.status==="read") tags.push(`<span class="tag read">Okundu</span>`);
    else if (b.status==="reading") tags.push(`<span class="tag">Okunuyor</span>`);
    if (b.loanTo) tags.push(`<span class="tag loan">Ödünç: ${esc(b.loanTo)}</span>`);
    if (b.rating) tags.push(`<span class="tag">${"★".repeat(b.rating)}</span>`);
    const sel = ui.selected.has(b.id);
    return `<button class="card" data-id="${esc(b.id)}" ${ui.select?`role="checkbox" aria-checked="${sel}"`:""}>
      ${coverHTML(b)}${ui.select?`<span class="check">${sel?"✓":""}</span>`:""}
      <span class="t">${esc(b.title||"Adsız")}</span>
      <span class="a">${esc(b.author||"Yazar yok")}</span>
      ${tags.length?`<span class="tags">${tags.join("")}</span>`:""}
    </button>`;
  }).join("");
  hydrateLazy(grid);
  renderReading(all);

  const empty = $("#empty");
  if (!loaded) empty.hidden = true;
  else if (!all.length){
    empty.hidden=false;
    empty.innerHTML = `<h2>Kitaplığın boş</h2><p>Sağ alttaki düğmeyle barkod okut, elle ekle ya da elindeki listeyi CSV olarak içe aktar.</p>
      <div class="btns"><button class="btn primary" data-act="scan">Barkod okut</button><button class="btn" data-act="add">Elle ekle</button><button class="btn" data-act="import">CSV içe aktar</button></div>`;
  } else if (!view.length){
    empty.hidden=false; empty.innerHTML = `<h2>Sonuç yok</h2><p>Bu filtreyle eşleşen kitap bulunamadı.</p>`;
  } else empty.hidden = true;

  $("#selbar").hidden = !ui.select;
  $("#fabScan").hidden = ui.select;
  $("#selCount").textContent = `${ui.selected.size} seçili`;
  { const v = [...books.values()].filter(b=>inShelf(b,ui.shelf) && matches(b)); $("#selAll").textContent = v.length && v.every(b=>ui.selected.has(b.id)) ? "Seçimi kaldır" : "Tümünü seç"; }
  $("#selShelf").innerHTML = sl.length ? sl.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("") : `<option value="">Önce raf oluştur</option>`;
  for (const b of ["#selApply","#selUnshelf","#selDelete"]) $(b).disabled = !ui.selected.size || (b!=="#selDelete" && !sl.length);
}

/* ---------- main events ---------- */
$("#chips").addEventListener("click", e=>{
  const c = e.target.closest("[data-shelf]");
  if (c){ ui.shelf = c.dataset.shelf; render(); return; }
  if (e.target.closest("#chipAdd")) openShelfSheet();
});
$("#statusRow").addEventListener("click", e=>{ const p=e.target.closest("[data-status]"); if(p){ ui.status=p.dataset.status; render(); }});
$("#sortSel").addEventListener("change", e=>{ ui.sort=e.target.value; saveUi(); render(); });
for (const [btn, v] of [["#viewGrid","grid"],["#viewList","list"]]) $(btn).addEventListener("click", ()=>{ ui.view=v; saveUi(); render(); });
$("#nav").addEventListener("click", e=>{ const n=e.target.closest("[data-nav]"); if(!n) return;
  const v=n.dataset.nav; if (v==="loan") { ui.shelf="loan"; ui.status="all"; } else { ui.status=v; if (v==="all") ui.shelf="all"; } render(); });
$("#navShelves").addEventListener("click", e=>{ const n=e.target.closest("[data-shelf]"); if(n){ ui.shelf=n.dataset.shelf; render(); } });
$("#navShelfAdd").addEventListener("click", ()=>openShelfSheet());
$("#btnSettings2").addEventListener("click", ()=>openSettings());
$("#btnSearch").addEventListener("click", ()=>{
  const r=$("#searchRow"); r.hidden=!r.hidden;
  $("#btnSearch").setAttribute("aria-expanded",!r.hidden); $("#btnSearch").classList.toggle("on",!r.hidden);
  if(!r.hidden) $("#q").focus(); else { ui.q=""; $("#q").value=""; render(); }
});
$("#q").addEventListener("input", e=>{ ui.q=e.target.value.trim(); render(); });
$("#btnAdd").addEventListener("click", ()=>openBook(null));
$("#fabScan").addEventListener("click", ()=>openScanner());
$("#btnSettings").addEventListener("click", openSettings);
$("#btnSelect").addEventListener("click", ()=>{
  ui.select=!ui.select; ui.selected.clear();
  $("#btnSelect").classList.toggle("on",ui.select); $("#btnSelect").setAttribute("aria-pressed",ui.select); render();
});
$("#empty").addEventListener("click", e=>{
  const a=e.target.closest("[data-act]"); if(!a) return;
  if (a.dataset.act==="add") openBook(null); else if (a.dataset.act==="scan") openScanner(); else $("#csvInput").click();
});
$("#grid").addEventListener("click", e=>{
  const c = e.target.closest("[data-id]"); if(!c) return;
  if (longPressed) { longPressed = false; e.preventDefault(); return; }
  const ra = e.target.closest("[data-rowact]");
  if (ra && !ui.select) { if (ra.dataset.rowact==="detail") openDetail(c.dataset.id); else { const r=ra.getBoundingClientRect(); openBookMenu(c.dataset.id, r.right-200, r.bottom+4); } return; }
  const id = c.dataset.id;
  if (ui.select){ ui.selected.has(id)?ui.selected.delete(id):ui.selected.add(id); render(); }
  else openDetail(id);
});
$("#selApply").addEventListener("click", ()=>bulkShelf(true));
$("#selAll").addEventListener("click", ()=>{
  const view = [...books.values()].filter(b=>inShelf(b,ui.shelf) && matches(b));
  const all = view.length && view.every(b=>ui.selected.has(b.id));
  for (const b of view) all ? ui.selected.delete(b.id) : ui.selected.add(b.id);
  render();
});
$("#selUnshelf").addEventListener("click", ()=>bulkShelf(false));
armable($("#selDelete"), "Sil", "Emin misin? Sil", async ()=>{
  const n = ui.selected.size; await deleteBooks([...ui.selected]); toast(`${n} kitap silindi`);
});
$("#btnClearSamples").addEventListener("click", async ()=>{
  await deleteBooks([...books.values()].filter(b=>b.sample).map(b=>b.id));
  const sampleShelves = [...shelves.values()].filter(s=>s.sample);
  for (const s of sampleShelves) if (![...books.values()].some(b=>(b.shelves||[]).includes(s.id))) await deleteShelf(s.id);
  toast("Örnek kitaplar silindi");
});
async function bulkShelf(add){
  const sid = $("#selShelf").value; if(!sid) return;
  const list = [];
  for (const id of ui.selected){
    const b = books.get(id); if(!b) continue;
    const s = new Set(b.shelves||[]); add?s.add(sid):s.delete(sid);
    b.shelves=[...s]; b.updatedAt=Date.now(); list.push(b);
  }
  await putRecords("books", list); render();
  toast(add ? `${list.length} kitap “${shelves.get(sid)?.name}” rafına eklendi` : `${list.length} kitap “${shelves.get(sid)?.name}” rafından çıkarıldı`);
}

/* ---------- sheets ---------- */
let onSheetClose = null;
function openSheet(html, onClose, cls=""){
  closeSheet();
  const root = $("#sheetRoot");
  root.innerHTML = `<div class="scrim"><div class="sheet ${cls}" role="dialog" aria-modal="true"><div class="wrap">${cls?"":`<div class="grab"></div>`}${html}</div></div></div>`;
  const scrim = root.firstChild;
  scrim.addEventListener("click", e=>{ if(e.target===scrim) closeSheet(); });
  document.addEventListener("keydown", escClose);
  onSheetClose = onClose || null;
  const sh = scrim.querySelector(".sheet");
  sh.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click", closeSheet));
  return sh;
}
function escClose(e){ if(e.key==="Escape") closeSheet(); }
function closeSheet(){
  if (onSheetClose) { const f = onSheetClose; onSheetClose = null; try { f(); } catch {} }
  $("#sheetRoot").innerHTML=""; document.removeEventListener("keydown", escClose);
}
const head = (title) => `<div class="sheethead"><h2>${title}</h2><button class="iconbtn" data-close aria-label="Kapat">✕</button></div>`;

/* ---------- book menu (right click / long press) ---------- */
let longPressed = false, lpTimer = null, lpStart = null;
$("#grid").addEventListener("contextmenu", e=>{
  const c = e.target.closest("[data-id]"); if (!c || ui.select) return;
  e.preventDefault(); openBookMenu(c.dataset.id, e.clientX, e.clientY);
});
$("#grid").addEventListener("touchstart", e=>{
  const c = e.target.closest("[data-id]"); if (!c || ui.select || e.touches.length !== 1) return;
  const t = e.touches[0]; lpStart = {x:t.clientX, y:t.clientY}; longPressed = false;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(()=>{ longPressed = true; navigator.vibrate?.(10); openBookMenu(c.dataset.id, lpStart.x, lpStart.y); }, 500);
}, {passive:true});
$("#grid").addEventListener("touchmove", e=>{
  if (!lpStart) return; const t = e.touches[0];
  if (Math.hypot(t.clientX-lpStart.x, t.clientY-lpStart.y) > 10) clearTimeout(lpTimer);
}, {passive:true});
for (const ev of ["touchend","touchcancel"]) $("#grid").addEventListener(ev, ()=>{ clearTimeout(lpTimer); lpStart = null; });

function closeBookMenu(){ document.querySelector(".bmenu-scrim")?.remove(); }
function openBookMenu(id, x, y){
  const b = books.get(id); if (!b) return;
  closeBookMenu();
  const st = b.status || "unread";
  const scrim = document.createElement("div"); scrim.className = "bmenu-scrim";
  const MI = {
    shelf: svgI('<path d="M4 4v16M20 4v16M4 9h16M4 15h16"/>'),
    search: svgI('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
    info: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>'),
    pen: svgI('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
    trash: svgI('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>')};
  scrim.innerHTML = `<div class="bmenu" role="menu" aria-label="${esc(b.title)}">
    <div class="bmenu-hd"><div class="bmenu-cv">${coverHTML(b)}</div><div><b>${esc(b.title||"Adsız")}</b>${b.author?`<span>${esc(b.author)}</span>`:""}</div></div>
    <div class="bmenu-st">${Object.entries(STATUS).map(([k,v])=>`<button role="menuitemradio" aria-checked="${st===k}" data-m="st:${k}">${STATUS_ICON[k]}${v}</button>`).join("")}</div>
    <div class="bmenu-tl"><button role="menuitem" data-m="shelves">${MI.shelf}Raf düzenle</button><button role="menuitem" data-m="cover">${MI.search}Kapak ara</button></div>
    <div class="bmenu-ft"><button role="menuitem" data-m="detail">${MI.info}Ayrıntı</button><button role="menuitem" data-m="edit">${MI.pen}Düzenle</button><button role="menuitem" data-m="del" class="danger">${MI.trash}<span>Sil</span></button></div>
  </div>`;
  document.body.appendChild(scrim);
  hydratePhotos(scrim);
  const m = scrim.firstElementChild;
  const r = m.getBoundingClientRect(), W = innerWidth, H = innerHeight;
  m.style.left = Math.max(8, Math.min(x, W - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y, H - r.height - 8)) + "px";
  m.querySelector("button").focus({preventScroll:true});
  const esc2 = e=>{ if (e.key==="Escape"){ closeBookMenu(); document.removeEventListener("keydown", esc2); } };
  document.addEventListener("keydown", esc2);
  scrim.addEventListener("contextmenu", e=>{ e.preventDefault(); closeBookMenu(); });
  scrim.addEventListener("click", async e=>{
    const t = e.target.closest("[data-m]");
    if (!t) { if (e.target === scrim) closeBookMenu(); return; }
    const a = t.dataset.m;
    if (a === "del") {
      if (!t.dataset.armed) { t.dataset.armed = "1"; t.classList.add("armed"); t.querySelector("span").textContent = "Emin misin?"; return; }
      closeBookMenu(); await deleteBooks([id]); toast("Kitap silindi"); return;
    }
    closeBookMenu();
    if (a === "shelves") openShelfPicker(id);
    else if (a === "detail") openDetail(id);
    else if (a === "edit") openBook(id);
    else if (a === "cover") { openBook(id); const fc = document.querySelector(".sheet #findCover"); if (fc) { fc.scrollIntoView({block:"center"}); fc.click(); } }
    else if (a.startsWith("st:")) { const k = a.slice(3); await saveBook({...books.get(id), status:k, updatedAt:Date.now()}); toast(`${b.title}: ${STATUS[k]}`); }
  });
}
function openShelfPicker(id){
  const b = books.get(id); if (!b) return;
  const draw = () => {
    const cur = new Set(books.get(id)?.shelves || []);
    return shelfList().map(s=>`<label><input type="checkbox" value="${esc(s.id)}" ${cur.has(s.id)?"checked":""}>${esc(s.name)}</label>`).join("") || `<span class="meta">Henüz raf yok. Aşağıdan oluştur.</span>`;
  };
  const sh = openSheet(`${head("Raf düzenle")}
    <p class="meta" style="margin:-6px 0 12px">${esc(b.title)}</p>
    <div class="shelfpick" id="spPick">${draw()}</div>
    <form class="lookup" id="spNew" style="margin-top:14px"><label class="f">Yeni raf<input id="spName" placeholder="Raf adı" autocomplete="off"></label><button class="btn" type="submit">Ekle</button></form>
    <div class="foot" style="margin-top:14px"><span></span><button class="btn primary" data-close>Tamam</button></div>`);
  sh.querySelector("#spPick").addEventListener("change", async ()=>{
    const ids = [...sh.querySelectorAll("#spPick input:checked")].map(i=>i.value);
    await saveBook({...books.get(id), shelves: ids, updatedAt: Date.now()});
  });
  sh.querySelector("#spNew").addEventListener("submit", async e=>{
    e.preventDefault(); const name = sh.querySelector("#spName").value.trim(); if (!name) return;
    const s = shelfByName(name, true); if (!shelves.has(s.id)) await saveShelf(s);
    const nb = books.get(id); const set = new Set(nb.shelves||[]); set.add(s.id);
    await saveBook({...nb, shelves:[...set], updatedAt:Date.now()});
    sh.querySelector("#spPick").innerHTML = draw(); sh.querySelector("#spName").value = "";
    toast(`“${s.name}” rafına eklendi`);
  });
}

/* ---------- author bio (fetched on the NAS from Vikipedi, cached on the device) ---------- */
const firstAuthor = a => String(a||"").split(/[,;&]| ve /)[0].trim();
const yazarKey = a => low(firstAuthor(a)).replace(/\b(prof|dr|doç|doc|yrd|ord)\b\.?/g," ").replace(/[^\p{L}\p{N}]+/gu," ").trim();
const yazarCache = new Map();
try { for (const [k,v] of Object.entries(JSON.parse(localStorage.getItem("kitaplik-yazar")||"{}"))) yazarCache.set(k,v); } catch {}
function saveYazarCache(){ try { localStorage.setItem("kitaplik-yazar", JSON.stringify(Object.fromEntries(yazarCache))); } catch {} }
function yazarHTML(b, y){
  const key = yazarKey(b.author);
  const others = [...books.values()].filter(x=>x.id!==b.id && yazarKey(x.author)===key).sort((a,c)=>coll.compare(a.title||"",c.title||""));
  const works = others.length ? `<div class="yzw"><b>Kitaplığımdaki diğer eserleri (${others.length}):</b>${others.slice(0,12).map(x=>`<button type="button" class="yzl" data-open="${esc(x.id)}">${esc(x.title)}</button>`).join("")}${others.length>12?`<span class="meta">ve ${others.length-12} kitap daha</span>`:""}</div>` : "";
  const name = esc(y?.name || firstAuthor(b.author));
  const photo = (y?.photoId ? `<img data-photo="${esc(y.photoId)}" alt="" hidden>` : `<span class="yzi">${esc((firstAuthor(b.author)[0]||"?").toLocaleUpperCase("tr"))}</span>`)
    + (Sync.enabled ? `<span class="yzcam" aria-hidden="true">${svgI('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>')}</span>` : "");
  let body;
  if (!y) body = `<p class="meta">${Sync.enabled ? "Özgeçmiş aranıyor…" : "Özgeçmiş NAS bağlantısıyla gelir."}</p>`;
  else if (y.bio) body = `<div class="yzbio clamp" id="yzBio">${esc(y.bio)}</div><button type="button" class="more" id="yzMore" hidden>Devamını oku ↓</button>
      <div class="meta yzsrc">${y.manuell?"Kendi notun":`Kaynak: ${y.url?`<a href="${esc(y.url)}" target="_blank" rel="noopener">Vikipedi</a>`:"Vikipedi"}`} · <button type="button" class="linkbtn" id="yzEdit">Düzenle</button></div>`;
  else body = `<p class="meta">${y.fehler?`Vikipedi'ye ulaşılamadı (${esc(y.fehler)}).`:"Vikipedi'de bu yazar bulunamadı."} <button type="button" class="linkbtn" id="yzEdit">Kendin yaz</button>${y.fehler?` · <button type="button" class="linkbtn" id="yzRetry">Tekrar dene</button>`:""}</p>`;
  return `<button type="button" class="yzp" id="yzPhoto" aria-label="Yazar fotoğrafı seç" ${Sync.enabled?"":"disabled"}>${photo}</button><div class="yzt"><div class="yzn">${name}</div><div class="meta">Özgeçmişi</div>${body}
    <div id="yzForm" hidden><textarea id="yzText" rows="6" placeholder="Yazar hakkında kısa bilgi">${esc(y?.bio||"")}</textarea>
      <div class="foot"><button type="button" class="btn" id="yzCancel">Vazgeç</button><button type="button" class="btn primary" id="yzSave">Kaydet</button></div></div>${works}</div>`;
}
async function loadYazar(sh, b, neu){
  const key = yazarKey(b.author), box = sh.querySelector("#yzBox"); if (!box) return;
  const draw = y => { box.innerHTML = yazarHTML(b, y); hydratePhotos(box); wireYazar(sh, b); };
  draw(yazarCache.get(key));
  if (!Sync.enabled) return;
  try {
    const r = await fetch(`api/yazar?ad=${encodeURIComponent(firstAuthor(b.author))}${neu?"&neu=1":""}`, {credentials:"same-origin", cache:"no-store"});
    if (!r.ok) return;
    const y = {...await r.json(), at: Date.now()};
    if (!y.fehler) { yazarCache.set(key, y); saveYazarCache(); }
    if (sh.isConnected) draw(y);
  } catch {}
}
function wireYazar(sh, b){
  const box = sh.querySelector("#yzBox");
  const bio = box.querySelector("#yzBio"), more = box.querySelector("#yzMore");
  if (bio) requestAnimationFrame(()=>{ if (bio.scrollHeight > bio.clientHeight + 4) more.hidden = false; });
  more?.addEventListener("click", ()=>{ const c = bio.classList.toggle("clamp"); more.textContent = c ? "Devamını oku ↓" : "Gizle ↑"; });
  box.querySelector("#yzRetry")?.addEventListener("click", ()=>loadYazar(sh, b, true));
  box.querySelector("#yzEdit")?.addEventListener("click", ()=>{ box.querySelector("#yzForm").hidden=false; box.querySelector("#yzText").focus(); });
  box.querySelector("#yzCancel")?.addEventListener("click", ()=>{ box.querySelector("#yzForm").hidden=true; });
  box.querySelector("#yzSave")?.addEventListener("click", async ()=>{
    if (!Sync.enabled) { toast("Bunun için NAS bağlantısı gerekli"); return; }
    try {
      const r = await fetch("api/yazar", {method:"PUT", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ad: firstAuthor(b.author), bio: box.querySelector("#yzText").value})});
      if (!r.ok) throw 0;
      const y = {...await r.json(), at: Date.now()}; yazarCache.set(yazarKey(b.author), y); saveYazarCache();
      box.innerHTML = yazarHTML(b, y); hydratePhotos(box); wireYazar(sh, b); toast("Kaydedildi");
    } catch { toast("Kaydedilemedi"); }
  });
  box.querySelectorAll("[data-open]").forEach(x=>x.addEventListener("click", ()=>openDetail(x.dataset.open)));
  box.querySelector("#yzPhoto")?.addEventListener("click", ()=>{
    if (!Sync.enabled) return;
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
    inp.onchange = async ()=>{
      const file = inp.files[0]; if (!file) return;
      try {
        const blob = await shrink(file, 400);
        const fid = "yzr-" + Store.newId().replace(/[^A-Za-z0-9]/g,"").slice(0,24);
        let r = await fetch(`api/fotos/${fid}`, {method:"PUT", credentials:"same-origin", body: blob});
        if (!r.ok) throw 0;
        r = await fetch("api/yazar", {method:"PUT", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ad: firstAuthor(b.author), photoId: fid})});
        if (!r.ok) throw 0;
        const y = {...await r.json(), at: Date.now()}; yazarCache.set(yazarKey(b.author), y); saveYazarCache();
        box.innerHTML = yazarHTML(b, y); hydratePhotos(box); wireYazar(sh, b); toast("Fotoğraf kaydedildi");
      } catch { toast("Fotoğraf kaydedilemedi"); }
    };
    inp.click();
  });
}

/* ---------- book detail (read view) ---------- */
const ICON_ST = {
  unread:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  reading:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6c-2-1.5-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13c-3-.5-6 0-8 1.5zM12 6v13"/></svg>',
  read:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>'};
const ST_VERB = {unread:"Okuyacağım", reading:"Okuyorum", read:"Okudum"};
const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
function openDetail(id){
  const b = books.get(id); if (!b) return;
  const künye = [["Yayınevi",b.publisher],["Yayın yılı",b.year],["Dil",b.language],["Orijinal dili",b.origLanguage],["Çevirmen",b.translator],["Sayfa sayısı",b.pages],["ISBN",b.isbn]].filter(([,v])=>v);
  const kategori = String(b.category||"").split(/\s*[>›]\s*/).filter(Boolean);
  const raf = (b.shelves||[]).map(sid=>shelves.get(sid)?.name).filter(Boolean);
  const sh = openSheet(`<div class="pagehead"><button class="back" data-close aria-label="Geri">${BACK_ICON}</button><span class="pt">${esc(b.title||"Adsız")}</span><span class="pa"><button type="button" class="barbtn" id="dEdit">Düzenle</button></span></div>
    <div class="detail">
      <div class="dtop">
        <div class="dleft"><button type="button" class="dcover" id="dZoom" aria-label="Kapağı büyüt">${coverHTML(b)}</button>
          <div class="dstars" id="dStars" aria-label="Puan"></div></div>
        <div class="dside">
          <div class="dhead"><h2>${esc(b.title||"Adsız")}</h2>
            ${b.author?`<div class="dauthor">${esc(b.author)}</div>`:""}${b.publisher?`<div class="dpub">${esc(b.publisher)}</div>`:""}</div>
          <div class="dstatus" role="group" aria-label="Okuma durumu">
            ${Object.keys(ST_VERB).map(k=>`<button type="button" data-st="${k}" aria-pressed="${(b.status||"unread")===k}">${ICON_ST[k]}<span>${ST_VERB[k]}</span></button>`).join("")}
          </div>
          <div class="dpage" id="dPage" ${(b.status||"unread")==="reading"?"":"hidden"}>
            <label for="dCur">Kaçıncı sayfadasın?</label><div class="dcur"><input id="dCur" type="number" inputmode="numeric" min="0" value="${esc(b.currentPage||"")}" placeholder="0"> ${b.pages?`/ ${esc(b.pages)}`:""}</div>
            <div id="dProg">${progressHTML(b)}</div>
          </div>
        </div>
      </div>
      <section class="dsec"><h3>Notum</h3>
        <div id="dNoteView">${b.note?`<p class="dnote">${esc(b.note)}</p>`:""}<button type="button" class="btn" id="dNoteEdit">${b.note?"Notu düzenle":"Not ekle"}</button></div>
        <div id="dNoteForm" hidden><textarea id="dNote" rows="5" placeholder="Altını çizdiğin yerler, düşüncelerin, nereden aldığın…">${esc(b.note)}</textarea>
          <div class="foot"><button type="button" class="btn" id="dNoteCancel">Vazgeç</button><button type="button" class="btn primary" id="dNoteSave">Notu kaydet</button></div></div>
      </section>
      ${b.about?`<section class="dsec"><h3>Hakkında</h3><div class="dabout clamp" id="dAbout">${esc(b.about)}</div><button type="button" class="more" id="dMore" hidden>Devamını oku ↓</button></section>`:""}
      ${(künye.length||kategori.length)?`<section class="dsec"><h3>Künye</h3><dl class="dkunye">${künye.map(([k,v])=>`<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${kategori.length?`<div class="dcat">${kategori.map((c,i)=>i===kategori.length-1?`<b>${esc(c)}</b>`:esc(c)).join(" › ")}</div>`:""}</section>`:""}
      ${b.author?`<section class="dsec" id="dYazar"><h3>Yazar Hakkında</h3><div class="yz" id="yzBox">${yazarHTML(b, yazarCache.get(yazarKey(b.author)))}</div></section>`:""}
      <section class="dsec"><h3>Kitaplığımda</h3><dl class="dkunye">
        <dt>Raf</dt><dd>${raf.length?raf.map(esc).join(", "):"Rafsız"}</dd>
        ${b.loanTo?`<dt>Ödünç</dt><dd>${esc(b.loanTo)}${b.loanDate?` · ${esc(new Date(b.loanDate).toLocaleDateString("tr-TR"))}`:""}</dd>`:""}
        ${b.addedAt?`<dt>Eklenme</dt><dd>${new Date(b.addedAt).toLocaleDateString("tr-TR",{day:"numeric",month:"long",year:"numeric"})}</dd>`:""}
      </dl></section>
    </div>`, null, "page");
  hydratePhotos(sh);
  // vom linken Rand nach rechts wischen = zurück (wie in iOS)
  let sx = null, sy = 0;
  sh.addEventListener("touchstart", e=>{ const t=e.touches[0]; sx = t.clientX < 30 ? t.clientX : null; sy = t.clientY; }, {passive:true});
  sh.addEventListener("touchmove", e=>{ if (sx===null) return; const t=e.touches[0], dx=t.clientX-sx;
    if (Math.abs(t.clientY-sy) > 60) { sx=null; sh.style.transform=""; return; }
    if (dx > 0) sh.style.transform = `translateX(${dx}px)`; }, {passive:true});
  sh.addEventListener("touchend", e=>{ if (sx===null) return; const dx=e.changedTouches[0].clientX-sx; sx=null;
    if (dx > 90) closeSheet(); else sh.style.transform=""; });
  const cur = () => books.get(id) || b;
  const update = async patch => { const nb = {...cur(), ...patch, updatedAt: Date.now()}; await saveBook(nb); return nb; };
  sh.querySelector(".dstatus").addEventListener("click", async e=>{
    const t = e.target.closest("[data-st]"); if (!t) return;
    const st = t.dataset.st, patch = {status:st};
    if (st==="read" && parseInt(cur().pages)) patch.currentPage = cur().pages;
    if (st==="reading" && !cur().startedAt) patch.startedAt = Date.now();
    if (st==="read") patch.finishedAt = Date.now();
    await update(patch);
    sh.querySelectorAll("[data-st]").forEach(x=>x.setAttribute("aria-pressed", x===t));
    sh.querySelector("#dPage").hidden = st!=="reading";
    toast(STATUS[t.dataset.st]);
  });
  sh.querySelector("#dCur").addEventListener("change", async e=>{
    const p = parseInt(cur().pages)||0; let c = Math.max(0, parseInt(e.target.value)||0); if (p) c = Math.min(c, p);
    e.target.value = c;
    const nb = await update({currentPage: String(c)});
    sh.querySelector("#dProg").innerHTML = progressHTML(nb);
    if (p && c >= p) toast("Bitti mi? “Okudum”a dokunabilirsin");
  });
  const drawStars = () => { const r = cur().rating||0; sh.querySelector("#dStars").innerHTML = [1,2,3,4,5].map(i=>`<button type="button" data-r="${i}" class="${i<=r?"on":""}" aria-label="${i} yıldız">★</button>`).join(""); };
  drawStars();
  sh.querySelector("#dStars").addEventListener("click", async e=>{ const t=e.target.closest("[data-r]"); if(!t) return; const r=+t.dataset.r; await update({rating: r===(cur().rating||0)?0:r}); drawStars(); });
  const nv = sh.querySelector("#dNoteView"), nf = sh.querySelector("#dNoteForm");
  sh.querySelector("#dNoteEdit").addEventListener("click", ()=>{ nv.hidden=true; nf.hidden=false; sh.querySelector("#dNote").focus(); });
  sh.querySelector("#dNoteCancel").addEventListener("click", ()=>{ nf.hidden=true; nv.hidden=false; });
  sh.querySelector("#dNoteSave").addEventListener("click", async ()=>{
    const note = sh.querySelector("#dNote").value; await update({note});
    nv.innerHTML = `${note.trim()?`<p class="dnote">${esc(note)}</p>`:""}<button type="button" class="btn" id="dNoteEdit">${note.trim()?"Notu düzenle":"Not ekle"}</button>`;
    nv.querySelector("#dNoteEdit").addEventListener("click", ()=>{ nv.hidden=true; nf.hidden=false; });
    nf.hidden=true; nv.hidden=false; toast("Not kaydedildi");
  });
  if (b.author) loadYazar(sh, b);
  const ab = sh.querySelector("#dAbout"), more = sh.querySelector("#dMore");
  if (ab) requestAnimationFrame(()=>{ if (ab.scrollHeight > ab.clientHeight + 4) more.hidden = false; });
  if (more) more.addEventListener("click", ()=>{ const open = ab.classList.toggle("clamp"); more.textContent = open ? "Devamını oku ↓" : "Daha az göster ↑"; });
  sh.querySelector("#dEdit").addEventListener("click", ()=>openBook(id, null, true));
  sh.querySelector("#dZoom").addEventListener("click", ()=>{
    const img = sh.querySelector(".dcover img:not([hidden])");
    if (!img || !img.src) return;
    const z = document.createElement("div"); z.className = "zoom"; z.innerHTML = `<img src="${img.src}" alt=""><button class="iconbtn" aria-label="Kapat">✕</button>`;
    z.addEventListener("click", ()=>z.remove()); document.body.appendChild(z);
  });
}

/* ---------- book form ---------- */
let pendingPhoto = null; // {blob, url}
function openBook(id, prefill, fromDetail){
  if (id && !books.has(id)) return;
  const b = id ? {...books.get(id)} : {status:"unread", shelves: (!["all","none","loan"].includes(ui.shelf))?[ui.shelf]:[], ...(prefill||{})};
  pendingPhoto = null;
  let rating = b.rating||0;
  const sl = shelfList();
  const sh = openSheet(`<div class="pagehead"><button type="button" class="back" id="fBack" aria-label="${fromDetail?"Geri":"Kapat"}">${BACK_ICON}</button><span class="pt">${id?"Kitabı düzenle":"Yeni kitap"}</span>
      <span class="pa">${id?`<button type="button" class="barbtn ghost" id="delBook">Sil</button>`:""}<button type="submit" form="bookForm" class="barbtn" id="saveBook">${id?"Kaydet":"Ekle"}</button></span></div>
    <form class="form" id="bookForm" novalidate>
      <div class="lookup">
        <label class="f">ISBN<input id="f_isbn" inputmode="numeric" value="${esc(b.isbn)}" autocomplete="off" placeholder="978…"></label>
        <button type="button" class="btn" id="scanHere" aria-label="Barkod okut"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 8v8M12 8v8M16 8v8"/></svg></button>
        <button type="button" class="btn" id="fetchIsbn">Bilgileri getir</button>
      </div>
      <div class="photo">
        <div class="pvcol"><div id="pv">${coverHTML(b)}</div><div class="stars pstars" id="stars" aria-label="Puan"></div></div>
        <div class="pbtns">
          <button type="button" class="btn" id="takePhoto">Kapağı fotoğrafla</button>
          <button type="button" class="btn" id="pickPhoto">Galeriden seç</button>
          <button type="button" class="btn" id="findCover">İnternette kapak ara</button>
          ${(b.photoId||b.coverUrl)?`<button type="button" class="btn" id="rmPhoto">Kapağı kaldır</button>`:""}
        </div>
        <div class="pmeta">
          <div style="font-size:.78rem;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Raflar</div>
          <div class="rsel"><div class="rtags" id="rtags"></div>
            <div class="rpop" id="rpop" hidden><input id="rq" placeholder="Raf ara veya yeni raf yaz…" autocomplete="off"><div class="rlist" id="rlist"></div></div></div>
          <div id="shelfpick" hidden>
            ${sl.map(s=>`<input type="checkbox" value="${esc(s.id)}" data-name="${esc(s.name)}" ${(b.shelves||[]).includes(s.id)?"checked":""}>`).join("")}
          </div>
        </div>
      </div>
      <div id="coverResults" hidden></div>
      <details id="coverLinkBox"><summary class="meta" style="cursor:pointer;padding-block:2px">Mağazada ara: kapak ve bilgiler (Kitapyurdu, idefix, Amazon)</summary>
        <div class="form" style="gap:8px;margin-top:8px">
          <div style="display:flex;gap:8px;flex-wrap:wrap" id="storeLinks"></div>
          <p class="meta" style="margin:0">Mağazada kapağa uzun bas → “Görsel adresini kopyala”, sonra buraya yapıştır.</p>
          <div class="lookup"><label class="f">Kapak bağlantısı<input id="f_coverUrl" inputmode="url" autocomplete="off" placeholder="https://…jpg"></label><button type="button" class="btn" id="useCoverUrl">Kullan</button></div>
        </div>
      </details>
      <label class="f">Kitap adı<input id="f_title" required value="${esc(b.title)}" autocomplete="off"></label>
      <label class="f">Yazar<input id="f_author" value="${esc(b.author)}" autocomplete="off" list="authors"></label>
      <datalist id="authors">${[...new Set([...books.values()].map(x=>x.author).filter(Boolean))].sort(coll.compare).slice(0,600).map(a=>`<option value="${esc(a)}">`).join("")}</datalist>
      <div class="row2">
        <label class="f">Yayınevi<input id="f_publisher" value="${esc(b.publisher)}" autocomplete="off" list="publishers"></label>
        <label class="f">Çevirmen<input id="f_translator" value="${esc(b.translator)}" autocomplete="off"></label>
      </div>
      <label class="f">Kategori<input id="f_category" value="${esc(b.category)}" autocomplete="off" list="categories" placeholder="Örn. Edebiyat > Roman > Yerli"></label>
      <datalist id="categories">${[...new Set([...books.values()].map(x=>x.category).filter(Boolean))].sort(coll.compare).slice(0,300).map(a=>`<option value="${esc(a)}">`).join("")}</datalist>
      <div class="row2">
        <label class="f">Dil<input id="f_language" value="${esc(b.language)}" autocomplete="off" placeholder="Türkçe"></label>
        <label class="f">Orijinal dili<input id="f_origLanguage" value="${esc(b.origLanguage)}" autocomplete="off" placeholder="Çeviriyse, örn. Rusça" list="langs"></label>
      </div>
      <datalist id="langs">${["Türkçe","İngilizce","Almanca","Fransızca","Rusça","Arapça","Farsça","İspanyolca","İtalyanca","Japonca",...new Set([...books.values()].map(x=>x.origLanguage).filter(Boolean))].filter((v,i,a)=>a.indexOf(v)===i).map(a=>`<option value="${esc(a)}">`).join("")}</datalist>
      <datalist id="publishers">${[...new Set([...books.values()].map(x=>x.publisher).filter(Boolean))].sort(coll.compare).slice(0,400).map(a=>`<option value="${esc(a)}">`).join("")}</datalist>
      <div class="row2">
        <label class="f">Yıl<input id="f_year" inputmode="numeric" value="${esc(b.year)}"></label>
        <label class="f">Sayfa<input id="f_pages" inputmode="numeric" value="${esc(b.pages)}"></label>
      </div>
      <div class="row2">
        <label class="f">Durum<select id="f_status">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${b.status===k?"selected":""}>${v}</option>`).join("")}</select></label>
        <span></span>
      </div>
      <div class="row2">
        <label class="f">Ödünç verildi (kime)<input id="f_loanTo" value="${esc(b.loanTo)}" placeholder="Boşsa evde" autocomplete="off"></label>
        <label class="f">Ödünç tarihi<input id="f_loanDate" type="date" value="${esc(b.loanDate)}"></label>
      </div>
      <label class="f">Notlarım<textarea id="f_note" placeholder="Altını çizdiğin yerler, düşüncelerin, nereden aldığın…">${esc(b.note)}</textarea></label>
      <details ${b.about?"":"open"}><summary class="meta" style="cursor:pointer;padding-block:4px">Hakkında (kitabın tanıtımı)</summary>
        <label class="f" style="margin-top:6px"><span class="sr">Hakkında</span><textarea id="f_about" placeholder="Arka kapak yazısı">${esc(b.about)}</textarea></label>
      </details>
      ${b.addedAt?`<span class="meta">Eklenme: ${new Date(b.addedAt).toLocaleDateString("tr-TR",{day:"numeric",month:"long",year:"numeric"})}${b.sample?" · örnek kayıt":""}</span>`:""}
    </form>`, ()=>{ if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.url); pendingPhoto=null; }, "page");
  const leave = () => { closeSheet(); if (fromDetail && books.has(id)) openDetail(id); };
  sh.querySelector("#fBack").addEventListener("click", leave);
  hydratePhotos(sh);
  const f = k => sh.querySelector("#f_"+k);
  const preview = () => { sh.querySelector("#pv").innerHTML = pendingPhoto ? `<div class="cover"><img src="${pendingPhoto.url}" alt=""></div>` : coverHTML({...b, title:f("title").value, author:f("author").value}); hydratePhotos(sh); };
  const drawStars = () => sh.querySelector("#stars").innerHTML = [1,2,3,4,5].map(i=>`<button type="button" data-r="${i}" class="${i<=rating?"on":""}" aria-label="${i} yıldız">★</button>`).join("");
  drawStars();
  sh.querySelector("#stars").addEventListener("click", e=>{ const r=e.target.closest("[data-r]"); if(!r) return; rating = (+r.dataset.r===rating)?0:+r.dataset.r; drawStars(); });
  wireShelfSelect(sh);
  sh.querySelector("#takePhoto").addEventListener("click", ()=>$("#photoInput").click());
  sh.querySelector("#pickPhoto").addEventListener("click", ()=>$("#photoInputLib").click());
  sh._setPhoto = () => { b._removePhoto = false; preview(); };
  const rm = sh.querySelector("#rmPhoto");
  if (rm) rm.addEventListener("click", ()=>{ b._removePhoto = true; b.coverUrl=""; if (pendingPhoto){URL.revokeObjectURL(pendingPhoto.url); pendingPhoto=null;} const keep=b.photoId; b.photoId=null; preview(); b._oldPhoto=keep; rm.remove(); });

  const fill = (info, overwrite) => {
    for (const k of ["title","author","publisher","year","pages","language","about"]) if (info[k] && f(k) && (overwrite || !f(k).value.trim())) f(k).value = info[k];
    if (info.isbn) f("isbn").value = info.isbn;
    if (info.coverUrl && !b.photoId && !pendingPhoto) { b.coverUrl = info.coverUrl; preview(); }
  };
  if (prefill && prefill.coverUrl) preview();

  sh.querySelector("#fetchIsbn").addEventListener("click", async e=>{
    const isbn = Lookup.cleanIsbn(f("isbn").value);
    if (!isbn) { toast("Önce ISBN yaz ya da barkodu okut"); f("isbn").focus(); return; }
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Aranıyor…";
    try {
      const info = await Lookup.byIsbn(isbn);
      if (info) { fill(info, !f("title").value.trim()); toast(`Bilgiler ${info.source} kaynağından geldi`); }
      else showStores(), toast(Lookup.errors().some(e=>e.includes("429")) ? "Bulunamadı: Google'ın günlük sorgu hakkı dolmuş (yarın sabah tekrar dene). Bilgileri elle yazabilirsin." : "Bu ISBN için kayıt bulunamadı. Bilgileri elle yazabilirsin.", 4500);
    } catch { showStores(); toast("Bilgi kaynaklarına ulaşılamadı. Mağaza bağlantılarıyla bakabilirsin."); }
    btn.disabled = false; btn.textContent = "Bilgileri getir";
  });
  sh.querySelector("#scanHere").addEventListener("click", ()=>{
    const draft = collect(); openScanner({single:true, onCode: async code => {
      const info = await Lookup.byIsbn(code).catch(()=>null);
      openBook(id, {...draft, ...(info||{}), isbn: code, title: draft.title || info?.title || "", author: draft.author || info?.author || ""});
      if (!info) toast("Barkod okundu ama kitap bilgisi bulunamadı.", 3500);
    }});
  });
  const drawStoreLinks = () => {
    const q = encodeURIComponent([f("title").value.trim(), f("author").value.trim()].filter(Boolean).join(" ") || Lookup.cleanIsbn(f("isbn").value));
    sh.querySelector("#storeLinks").innerHTML = [
      ["Kitapyurdu", `https://www.kitapyurdu.com/index.php?route=product/search&filter_name=${q}`],
      ["idefix", `https://www.idefix.com/arama?q=${q}`],
      ["Amazon", `https://www.amazon.com.tr/s?k=${q}&i=stripbooks`]
    ].map(([n,u])=>`<a class="btn" href="${u}" target="_blank" rel="noopener noreferrer">${n}'da ara</a>`).join("");
  };
  sh.querySelector("#coverLinkBox").addEventListener("toggle", drawStoreLinks);
  const showStores = () => { const d = sh.querySelector("#coverLinkBox"); d.open = true; drawStoreLinks(); d.scrollIntoView({block:"center", behavior:"smooth"}); };
  if (!id && prefill && prefill.isbn && !prefill.title) setTimeout(showStores, 300);
  sh.querySelector("#useCoverUrl").addEventListener("click", ()=>{
    const u = f("coverUrl").value.trim();
    if (!/^https:\/\/\S+$/i.test(u)) { toast("https:// ile başlayan bir görsel bağlantısı yapıştır"); return; }
    if (pendingPhoto){URL.revokeObjectURL(pendingPhoto.url); pendingPhoto=null;}
    if (b.photoId){ b._oldPhoto=b.photoId; b.photoId=null; }
    b.coverUrl = u; preview(); toast("Kapak eklendi, kaydetmeyi unutma");
  });
  sh.querySelector("#findCover").addEventListener("click", async e=>{
    const title = f("title").value.trim(); if (!title){ toast("Önce kitap adını yaz"); f("title").focus(); return; }
    const box = sh.querySelector("#coverResults"); box.hidden=false; box.innerHTML = `<span class="meta">Kapaklar aranıyor…</span>`;
    if (Sync.enabled) {
      const r = await nasCover({title, author: f("author").value.trim(), isbn: Lookup.cleanIsbn(f("isbn").value)});
      if (r.photoId) {
        if (pendingPhoto){URL.revokeObjectURL(pendingPhoto.url); pendingPhoto=null;}
        if (b.photoId) b._oldPhoto = b.photoId;
        b.photoId = r.photoId; b.coverUrl = ""; preview();
        box.innerHTML = `<span class="meta">Kapak ${esc(r.quelle)} kaynağından bulundu. Yanlışsa mağaza bağlantısıyla değiştirebilirsin. Kaydetmeyi unutma.</span>`;
        return;
      }
      box.innerHTML = `<span class="meta">NAS'ta kapak bulunamadı${r.error?` (${esc(r.error)})`:(r.fehler&&r.fehler.length?` (${esc(r.fehler.join(", "))})`:"")}. Google'da aranıyor…</span>`;
    }
    try {
      const res = (await Lookup.search(title, f("author").value.trim(), 12)).filter(r=>r.coverUrl);
      if (!res.length){ box.innerHTML = `<span class="meta">Kapak bulunamadı. Fotoğrafını çekebilirsin.</span>`; return; }
      box.innerHTML = `<span class="meta">Doğru kapağa dokun:</span><div class="coverpick">${res.slice(0,8).map((r,i)=>`<button type="button" data-i="${i}" aria-label="${esc(r.title)}"><img src="${esc(r.coverUrl)}" alt="" referrerpolicy="no-referrer"></button>`).join("")}</div>`;
      box.querySelector(".coverpick").addEventListener("click", ev=>{
        const btn = ev.target.closest("[data-i]"); if(!btn) return;
        const r = res[+btn.dataset.i];
        if (pendingPhoto){URL.revokeObjectURL(pendingPhoto.url); pendingPhoto=null;}
        if (b.photoId){ b._oldPhoto=b.photoId; b.photoId=null; }
        b.coverUrl = r.coverUrl; fill({...r, coverUrl:""}, false); preview(); box.hidden=true;
      });
    } catch { box.innerHTML = `<span class="meta">İnternete bağlanılamadı.</span>`; }
  });

  function collect(){
    const v = k => f(k).value.trim();
    return {title:v("title"), author:v("author"), publisher:v("publisher"), translator:v("translator"), year:v("year"), pages:v("pages"),
      isbn:Lookup.cleanIsbn(v("isbn")), status:v("status"), rating,
      shelves:[...sh.querySelectorAll("#shelfpick input:checked")].map(i=>i.value),
      loanTo:v("loanTo"), loanDate:v("loanDate"), note:f("note").value, language:v("language"), origLanguage:v("origLanguage"), category:v("category"), about:f("about").value};
  }
  if (id) armable(sh.querySelector("#delBook"), "Sil", "Emin misin?", async ()=>{ await deleteBooks([id]); closeSheet(); toast("Kitap silindi"); });
  sh.querySelector("#bookForm").addEventListener("submit", async e=>{
    e.preventDefault();
    const d = collect();
    if (!d.title){ f("title").focus(); toast("Kitap adı gerekli"); return; }
    if (!id && d.isbn && [...books.values()].some(x=>x.isbn===d.isbn)) {
      const btn = sh.querySelector("#saveBook");
      if (!btn.dataset.dupOk){ btn.dataset.dupOk="1"; btn.textContent="Yine de ekle"; toast("Bu ISBN zaten kitaplığında var. Yine de eklemek için tekrar dokun.", 4000); return; }
    }
    try{
      let photoId = b.photoId||null;
      let photoUp = false;
      if (pendingPhoto){ photoId = Store.newId(); await Store.putPhoto(photoId, pendingPhoto.blob); photoUp = true; }
      const old = b._oldPhoto || (pendingPhoto && b.photoId) || null;
      if (old && old !== photoId){ try{ await Store.delPhoto(old); }catch{} dropPhotoUrl(old); }
      const book = {...(id?books.get(id):{}), ...d, id: id || Store.newId(), photoId, coverUrl: photoId ? "" : (b.coverUrl||""),
        addedAt: b.addedAt || Date.now(), sample: false};
      if (photoUp) book._photoUp = 1;
      await saveBook(book);
      leave(); toast(id?"Kaydedildi":"Kitaplığa eklendi");
    }catch(err){ toast("Kaydedilemedi: telefonda yer kalmamış olabilir."); }
  });
  if (!id && !prefill) setTimeout(()=>f("isbn").focus(), 60);
}

async function handlePhoto(file){
  if (!file) return;
  try{
    const blob = await shrink(file, 1000);
    if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.url);
    pendingPhoto = {blob, url:URL.createObjectURL(blob)};
    const sh = document.querySelector(".sheet"); if (sh && sh._setPhoto) sh._setPhoto();
  }catch{ toast("Fotoğraf okunamadı. Başka bir fotoğraf dene."); }
}
function shrink(file, max){
  return new Promise((res,rej)=>{
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = ()=>{ const s=Math.min(1,max/Math.max(img.width,img.height)); const c=document.createElement("canvas"); c.width=Math.round(img.width*s); c.height=Math.round(img.height*s); c.getContext("2d").drawImage(img,0,0,c.width,c.height); URL.revokeObjectURL(u); c.toBlob(b=>b?res(b):rej(), "image/jpeg", .82); };
    img.onerror = ()=>{ URL.revokeObjectURL(u); rej(); };
    img.src = u;
  });
}
for (const id of ["#photoInput","#photoInputLib"]) $(id).addEventListener("change", e=>{ handlePhoto(e.target.files[0]); e.target.value=""; });

/* ---------- barcode scanner ---------- */
let scannerLib = null;
function loadScanner(){
  if (scannerLib) return scannerLib;
  scannerLib = new Promise((res, rej)=>{
    const s = document.createElement("script"); s.src = "vendor/html5-qrcode.min.js";
    s.onload = ()=>res(window.__Html5QrcodeLibrary__); s.onerror = ()=>{ scannerLib=null; rej(); };
    document.head.appendChild(s);
  });
  return scannerLib;
}
async function openScanner(opts = {}){
  const single = !!opts.single;
  let scanner = null, stopped = false;
  const seen = new Map(); // code -> time
  const sh = openSheet(`${head(single ? "Barkodu okut" : "Barkodla kitap ekle")}
    <div class="scanbox">
      <div id="reader"></div>
      <p class="meta" id="scanMsg" style="margin:0">Kameraya kitabın arkasındaki ISBN barkodunu göster.</p>
      ${single ? "" : `
      <label class="switch"><input type="checkbox" id="batchMode"> Arka arkaya tara (her kitabı sormadan ekler)</label>
      <div class="scanlog" id="scanLog" hidden></div>`}
      <div class="lookup">
        <label class="f">Barkod okunmazsa ISBN'i yaz<input id="manualIsbn" inputmode="numeric" autocomplete="off" placeholder="978…"></label>
        <button type="button" class="btn" id="manualGo">Tamam</button>
      </div>
    </div>`, ()=>{ stopped = true; if (scanner) { scanner.stop().catch(()=>{}).finally(()=>{ try{scanner.clear();}catch{} }); } });
  const msg = sh.querySelector("#scanMsg");
  const batch = () => !single && sh.querySelector("#batchMode")?.checked;
  try { const saved = localStorage.getItem("kitaplik-batch")==="1"; if (!single && saved) sh.querySelector("#batchMode").checked = true; } catch {}
  sh.querySelector("#batchMode")?.addEventListener("change", e=>{ try{localStorage.setItem("kitaplik-batch", e.target.checked?"1":"0")}catch{} });

  const handle = async code => {
    code = Lookup.cleanIsbn(code);
    if (!Lookup.isValidIsbn(code)) { msg.textContent = `Bu bir ISBN barkodu değil (${code}). Kitabın arkasındaki 978 ile başlayan barkodu dene.`; return; }
    const now = Date.now(); if (seen.has(code) && now - seen.get(code) < 4000) return; seen.set(code, now);
    if (navigator.vibrate) try{ navigator.vibrate(60); }catch{}
    if (single) { closeSheet(); await opts.onCode(code); return; }
    const dup = [...books.values()].find(b=>b.isbn===code);
    if (!batch()) {
      closeSheet();
      if (dup) { toast(`“${dup.title}” zaten kitaplığında`, 3500); openBook(dup.id); return; }
      toast("Kitap bilgisi aranıyor…");
      const info = await Lookup.byIsbn(code).catch(()=>null);
      openBook(null, {...(info||{}), isbn: code});
      if (!info) toast("Kitap bilgisi bulunamadı. Adını ve yazarını elle yazabilirsin.", 4000);
      return;
    }
    // batch mode: add directly
    const log = sh.querySelector("#scanLog"); log.hidden = false;
    const row = document.createElement("div"); row.innerHTML = `<span>${code}</span><span class="meta">aranıyor…</span>`; log.prepend(row);
    if (dup) { row.innerHTML = `<span>${esc(dup.title)}</span><span class="bad">zaten var</span>`; return; }
    let info = null; try { info = await Lookup.byIsbn(code); } catch {}
    const shelfIds = (!["all","none","loan"].includes(ui.shelf)) ? [ui.shelf] : [];
    const book = {id:Store.newId(), title: info?.title || `ISBN ${code}`, author: info?.author||"", publisher: info?.publisher||"", translator:"",
      year: info?.year||"", pages: info?.pages||"", isbn: code, coverUrl: info?.coverUrl||"", status:"unread", rating:0, shelves: shelfIds,
      loanTo:"", loanDate:"", note:"", photoId:null, addedAt: Date.now(), sample:false, needsInfo: !info};
    await saveBook(book);
    row.innerHTML = `<span>${esc(book.title)}</span><span class="${info?"ok":"bad"}">${info?"eklendi":"eklendi, bilgisi eksik"}</span>`;
  };

  sh.querySelector("#manualGo").addEventListener("click", ()=>{ const v = sh.querySelector("#manualIsbn").value; if (v.trim()) handle(v); });
  sh.querySelector("#manualIsbn").addEventListener("keydown", e=>{ if (e.key==="Enter"){ e.preventDefault(); sh.querySelector("#manualGo").click(); }});

  try {
    const lib = await loadScanner(); if (stopped) return;
    const F = lib.Html5QrcodeSupportedFormats;
    scanner = new lib.Html5Qrcode("reader", {formatsToSupport:[F.EAN_13, F.EAN_8, F.UPC_A], verbose:false,
      experimentalFeatures:{useBarCodeDetectorIfSupported:true}});
    await scanner.start({facingMode:"environment"}, {fps:12, qrbox:(w,h)=>({width:Math.min(300,Math.floor(w*.85)), height:Math.min(140,Math.floor(h*.5))}), aspectRatio:1.333},
      text => { handle(text); }, ()=>{});
    if (stopped) { scanner.stop().catch(()=>{}); }
  } catch (e) {
    sh.querySelector("#reader").hidden = true;
    msg.textContent = location.protocol !== "https:" && location.hostname !== "localhost"
      ? "Kamera sadece güvenli (https) adreste çalışır."
      : "Kameraya erişilemedi. Ayarlar > Safari > Kamera iznini kontrol et ya da ISBN'i aşağıya yaz.";
  }
}

/* ---------- shelves ---------- */
/* Shelf choice in the edit form: only the chosen shelves as tags, "+ Raf seç" opens a searchable list. */
function wireShelfSelect(sh){
  const box = sh.querySelector("#shelfpick"), tags = sh.querySelector("#rtags"), pop = sh.querySelector("#rpop"), q = sh.querySelector("#rq"), list = sh.querySelector("#rlist");
  const boxes = () => [...box.querySelectorAll("input")];
  const X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>';
  const CK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
  const drawTags = () => {
    tags.innerHTML = boxes().filter(i=>i.checked).map(i=>`<span class="rtag">${esc(i.dataset.name)}<button type="button" data-rm="${esc(i.value)}" aria-label="${esc(i.dataset.name)} rafından çıkar">${X}</button></span>`).join("")
      + `<button type="button" class="radd" id="radd" aria-expanded="${!pop.hidden}">+ Raf seç</button>`;
  };
  const drawList = () => {
    const t = q.value.trim(), tl = t.toLocaleLowerCase("tr");
    const hits = boxes().filter(i=>!tl || i.dataset.name.toLocaleLowerCase("tr").includes(tl));
    list.innerHTML = hits.map(i=>`<button type="button" data-tg="${esc(i.value)}" class="${i.checked?"on":""}">${esc(i.dataset.name)}${i.checked?CK:""}</button>`).join("")
      + (t && !boxes().some(i=>i.dataset.name.toLocaleLowerCase("tr")===tl) ? `<button type="button" class="rnew" data-new="1">+ “${esc(t)}” rafını oluştur</button>` : "")
      + (!hits.length && !t ? `<span class="meta">Henüz raf yok. Yukarıya bir ad yaz.</span>` : "");
  };
  const open = on => { pop.hidden = !on; drawTags(); if (on) { q.value = ""; drawList(); q.focus({preventScroll:true}); } };
  tags.addEventListener("click", e=>{
    const rm = e.target.closest("[data-rm]");
    if (rm) { const i = boxes().find(x=>x.value===rm.dataset.rm); if (i) i.checked = false; drawTags(); if (!pop.hidden) drawList(); return; }
    if (e.target.closest("#radd")) open(pop.hidden);
  });
  list.addEventListener("click", async e=>{
    const tg = e.target.closest("[data-tg]");
    if (tg) { const i = boxes().find(x=>x.value===tg.dataset.tg); i.checked = !i.checked; drawTags(); drawList(); return; }
    if (e.target.closest("[data-new]")) {
      const name = q.value.trim(); if (!name) return;
      const s = shelfByName(name, true); await saveShelf(s);
      box.insertAdjacentHTML("beforeend", `<input type="checkbox" value="${esc(s.id)}" data-name="${esc(s.name)}" checked>`);
      q.value = ""; drawTags(); drawList(); toast(`“${name}” rafı oluşturuldu`);
    }
  });
  q.addEventListener("input", drawList);
  q.addEventListener("keydown", e=>{ if (e.key==="Enter") { e.preventDefault(); list.querySelector("button")?.click(); } if (e.key==="Escape") { e.stopPropagation(); open(false); } });
  sh.addEventListener("click", e=>{ if (!pop.hidden && !e.composedPath().some(n=>n.classList?.contains("rsel"))) open(false); });
  drawTags();
}
function openShelfSheet(){
  const sh = openSheet(`${head("Yeni raf")}
    <form class="form" id="shelfForm"><label class="f">Raf adı<input id="f_shelf" placeholder="Örn. Araştırma, Şiir, Okunacaklar" autocomplete="off"></label>
    <div class="foot"><span></span><button class="btn primary" type="submit">Rafı oluştur</button></div></form>`);
  setTimeout(()=>sh.querySelector("#f_shelf").focus(), 60);
  sh.querySelector("#shelfForm").addEventListener("submit", async e=>{
    e.preventDefault(); const name = sh.querySelector("#f_shelf").value.trim(); if(!name) return;
    if (shelfByName(name)) { toast("Bu adda bir raf zaten var"); return; }
    const s = shelfByName(name, true); await saveShelf(s); ui.shelf = s.id; closeSheet(); render(); toast(`“${name}” rafı oluşturuldu`);
  });
}

/* ---------- settings ---------- */
function openSettings(){
  const all=[...books.values()];
  const n=all.length, read=all.filter(b=>b.status==="read").length, loan=all.filter(b=>b.loanTo).length;
  const pages=all.filter(b=>b.status==="read").reduce((s,b)=>s+(parseInt(b.pages)||0),0);
  const noCover = all.filter(b=>!b.photoId && !b.coverUrl).length;
  const needInfo = all.filter(b=>b.isbn && (!b.author || b.needsInfo)).length;
  let lastBackup = ""; try { const t = +localStorage.getItem("kitaplik-backup"); if (t) lastBackup = new Date(t).toLocaleDateString("tr-TR",{day:"numeric",month:"long",year:"numeric"}); } catch {}
  const sh = openSheet(`${head("Ayarlar")}
    <div class="form">
      <div class="stats">
        <div class="stat"><b>${n}</b><span>kitap</span></div>
        <div class="stat"><b>${read}</b><span>okundu</span></div>
        <div class="stat"><b>${pages.toLocaleString("tr-TR")}</b><span>okunan sayfa</span></div>
        <div class="stat"><b>${loan}</b><span>ödünçte</span></div>
      </div>
      <div class="section">
        <h3>Raflar</h3>
        <div id="shelfEdits" class="form" style="gap:8px"></div>
        <button class="btn" id="newShelf" style="justify-self:start">+ Raf ekle</button>
      </div>
      <div class="section">
        <h3>Eksik bilgileri tamamla</h3>
        <p class="meta" style="margin:0">${noCover} kitabın kapağı yok${needInfo?`, ${needInfo} kitabın bilgisi eksik`:""}. İnternetten (Google Books, Open Library) bulunabilenleri otomatik ekler. Bulunamayanlar için fotoğraf çekebilirsin.</p>
        <button class="btn" id="fillMissing" style="justify-self:start" ${noCover||needInfo?"":"disabled"}>Eksikleri internetten bul</button>
        <div id="fillProg" hidden><div class="progress"><i></i></div><span class="meta" id="fillText"></span></div>
      </div>
      ${Sync.enabled?`<div class="section">
        <h3>Eksik ISBN'leri bul</h3>
        <p class="meta" style="margin:0">${all.filter(b=>!b.isbn).length} kitabın ISBN'i yok. NAS, Google Books'ta kitap adı, yazar ve yayınevine göre arar; yalnızca ad ve yayınevi uyuşursa ISBN eklenir. Günlük sorgu hakkı dolarsa durur, sonra kaldığı yerden devam eder.</p>
        <button class="btn" id="findIsbn" style="justify-self:start" ${all.some(b=>!b.isbn)?"":"disabled"}>Eksik ISBN'leri bul</button>
        <div id="isbnProg" hidden><div class="progress"><i></i></div><span class="meta" id="isbnText"></span></div>
      </div>`:""}
      <div class="section">
        <h3>CSV içe aktar</h3>
        <p class="meta" style="margin:0">Excel, Google E-Tablolar veya Kitapyurdu'dan aldığın listeyi yükle. İlk satırda “Kitap adı”, “Yazar”, “Yayınevi”, “ISBN”, “Raf”, “Not” gibi sütun adları varsa otomatik eşleşir. Raf sütunundaki adlar için raflar kendiliğinden oluşur. Aynı kitap ikinci kez eklenmez.</p>
        <button class="btn" id="doImport" style="justify-self:start">CSV dosyası seç</button>
        <div id="impProg" hidden><div class="progress"><i></i></div><span class="meta" id="impText"></span></div>
      </div>
      <div class="section">
        <h3>Yedekleme</h3>
        <p class="meta" style="margin:0">${Sync.enabled ? "NAS her gün veritabanının bir kopyasını alır. İstersen buradan ayrıca bir dosya yedeği alabilirsin." : "Kitapların bu telefonda saklanıyor. Telefon değişirse ya da Safari verileri silinirse kaybolmasın diye ara sıra tam yedek al ve iCloud Drive'a kaydet."} ${lastBackup?`Son yedek: ${lastBackup}.`:""}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="doBackup">Tam yedek al (fotoğraflarla)</button>
          <button class="btn" id="doRestore">Yedekten geri yükle</button>
          <button class="btn" id="doExport">CSV olarak dışa aktar</button>
        </div>
      </div>
      ${Sync.enabled ? `<div class="section">
        <h3>NAS</h3>
        <p class="meta" style="margin:0">Kitapların ve kapak fotoğrafların NAS'ta saklanıyor; iPhone, iPad ve bilgisayar aynı listeyi görür. ${Sync.lastOk ? `Son eşitleme: ${new Date(Sync.lastOk).toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"})}.` : ""}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="syncNow">Şimdi eşitle</button><button class="btn" id="logoutBtn">Bu cihazda çıkış yap</button></div>
      </div>` : ""}
      <div class="section">
        <h3>Telefona kur</h3>
        <p class="meta" style="margin:0">iPhone'da Safari'de bu sayfayı açıp Paylaş düğmesine, sonra “Ana Ekrana Ekle”ye dokun. Uygulama gibi açılır ve internetsiz de çalışır.</p>
      </div>
    </div>`);
  sh.querySelector("#newShelf").addEventListener("click", openShelfSheet);
  sh.querySelector("#syncNow")?.addEventListener("click", async ()=>{ await Sync.run(); toast(Sync.state==="ok" ? "Eşitlendi" : "NAS'a ulaşılamadı"); });
  sh.querySelector("#logoutBtn")?.addEventListener("click", async ()=>{ await Sync.logout(); closeSheet(); showLogin(); });
  sh.querySelector("#doImport").addEventListener("click", ()=>$("#csvInput").click());
  sh.querySelector("#doExport").addEventListener("click", exportCsv);
  sh.querySelector("#doBackup").addEventListener("click", exportBackup);
  sh.querySelector("#doRestore").addEventListener("click", ()=>$("#jsonInput").click());
  sh.querySelector("#fillMissing").addEventListener("click", e=>fillMissing(e.currentTarget, sh));
  sh.querySelector("#findIsbn")?.addEventListener("click", e=>findIsbns(e.currentTarget, sh));
  const se = sh.querySelector("#shelfEdits");
  const sl = shelfList();
  se.innerHTML = sl.length ? sl.map(s=>`<div class="shelfedit" data-sid="${esc(s.id)}"><input value="${esc(s.name)}" aria-label="Raf adı"><button class="btn" data-ren>Kaydet</button><button class="btn danger" data-del>Sil</button></div>`).join("") : `<span class="meta">Henüz raf yok.</span>`;
  se.querySelectorAll(".shelfedit").forEach(row=>{
    const sid=row.dataset.sid;
    row.querySelector("[data-ren]").addEventListener("click", async ()=>{ const name=row.querySelector("input").value.trim(); if(!name) return; await saveShelf({...shelves.get(sid), name}); toast("Raf adı güncellendi"); });
    armable(row.querySelector("[data-del]"), "Sil", "Emin misin?", async ()=>{ await deleteShelf(sid); row.remove(); toast("Raf silindi. Kitaplar silinmedi."); });
  });
}

async function findIsbns(btn, sh){
  btn.disabled = true;
  const prog = sh.querySelector("#isbnProg"); prog.hidden = false;
  const bar = prog.querySelector("i"), txt = sh.querySelector("#isbnText");
  // Bücher, die schon einmal ohne Treffer gesucht wurden, kommen zuletzt
  const todo = [...books.values()].filter(b=>!b.isbn && b.title && !b.title.startsWith("ISBN ")).sort((a,b)=>(a.isbnTried||0)-(b.isbnTried||0));
  let found = 0, i = 0, fails = 0;
  for (const b of todo){
    if (!document.body.contains(btn)) break;
    i++; bar.style.width = (100*i/todo.length)+"%";
    txt.textContent = `${i} / ${todo.length} · ${found} ISBN bulundu`;
    let r;
    try {
      const res = await fetch("api/isbn-bul", {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({title:b.title, author:firstAuthor(b.author), publisher:b.publisher||""})});
      if (res.status === 401) { showLogin(); txt.textContent = "Durdu: NAS girişi gerekli"; break; }
      r = await res.json();
    } catch { if (++fails >= 5) { txt.textContent = "Durdu: NAS'a ulaşılamıyor"; break; } continue; }
    fails = 0;
    if (r.fehler && r.fehler.includes("429")) { txt.textContent = `Durdu: Google'ın günlük sorgu hakkı doldu. ${found} ISBN bulundu. Yarın sabah 9'dan sonra tekrar bas, kaldığı yerden devam eder.`; btn.disabled = false; return; }
    const cur = books.get(b.id); if (!cur) continue;
    if (r.isbn && ![...books.values()].some(x=>x.isbn===r.isbn)) { await saveBook({...cur, isbn: r.isbn, updatedAt: Date.now()}); found++; }
    else if (!r.fehler) await saveBook({...cur, isbnTried: Date.now(), updatedAt: Date.now()});
  }
  if (i === todo.length) txt.textContent = `Bitti: ${found} ISBN bulundu, ${todo.length-found} kitapta uygun kayıt yok.`;
  btn.disabled = false;
}
async function fillMissing(btn, sh){
  btn.disabled = true;
  const prog = sh.querySelector("#fillProg"); prog.hidden = false;
  const bar = prog.querySelector("i"), txt = sh.querySelector("#fillText");
  const todo = [...books.values()].filter(b=>(!b.photoId && !b.coverUrl) || (b.isbn && (!b.author || b.needsInfo)));
  let found = 0, i = 0;
  if (Sync.enabled) {
    // Search on the NAS: Kitapyurdu, Google Books, Open Library; the image is stored on the NAS.
    const errs = new Map(); let fails = 0;
    for (const b of todo.filter(b=>!b.photoId && !b.coverUrl)){
      if (!document.body.contains(btn)) break;
      i++; bar.style.width = (100*i/todo.length)+"%";
      txt.textContent = `${i} / ${todo.length} · ${found} kapak bulundu${errs.size?` · sorunlar: ${[...errs.keys()].join(", ")}`:""}`;
      const r = await nasCover(b);
      if (r.error) { if (++fails >= 5) { txt.textContent = `Durdu: ${r.error}`; btn.disabled = false; return; } continue; }
      fails = 0;
      for (const e of r.fehler || []) errs.set(e, (errs.get(e)||0)+1);
      if (r.photoId) { const cur = books.get(b.id); if (cur) { await saveBook({...cur, photoId: r.photoId, coverUrl: "", coverSource: r.quelle}); found++; } }
    }
    const fromIdefix = [...books.values()].filter(x=>x.coverSource==="idefix").length;
    txt.textContent = `Bitti: ${found} kapak bulundu.${fromIdefix?` ${fromIdefix} kapak idefix'ten geldi, yanlış baskı olabilir; bir göz at.`:""}${errs.size?` Sorunlar: ${[...errs].map(([k,v])=>`${k} (${v}×)`).join(", ")}`:""}${[...errs.keys()].some(k=>k.includes("429"))?" Google'ın günlük sorgu hakkı dolmuş olabilir; yarın sabah tekrar dene.":""}`;
    btn.disabled = false;
    return;
  }
  for (const b of todo){
    if (!document.body.contains(btn)) break; // sheet closed
    i++; bar.style.width = (100*i/todo.length)+"%"; txt.textContent = `${i} / ${todo.length} · ${found} kitap tamamlandı`;
    try {
      let info = null;
      if (b.isbn) info = await Lookup.byIsbn(b.isbn);
      if ((!info || !info.coverUrl) && b.title && !b.title.startsWith("ISBN ")) {
        const res = await Lookup.search(b.title, b.author, 5);
        const tl = low(b.title);
        const hit = res.find(r=>r.coverUrl && low(r.title).includes(tl.slice(0, Math.max(4, Math.min(tl.length, 20)))));
        if (hit) info = {...hit, ...(info||{}), coverUrl: hit.coverUrl};
      }
      if (info){
        const nb = {...b};
        if (!nb.photoId && !nb.coverUrl && info.coverUrl) nb.coverUrl = info.coverUrl;
        for (const k of ["author","publisher","year","pages"]) if (!nb[k] && info[k]) nb[k] = info[k];
        if (nb.title.startsWith("ISBN ") && info.title) nb.title = info.title;
        if (!nb.isbn && info.isbn) nb.isbn = info.isbn;
        nb.needsInfo = false;
        await saveBook(nb); found++;
      }
    } catch (e) { txt.textContent = `Arama durdu: ${e && e.message || "bağlantı yok"}. Daha sonra tekrar dene.`; btn.disabled = false; return; }
    await sleep(250);
  }
  txt.textContent = `Bitti: ${found} kitap internetten tamamlandı.`;
  btn.disabled = false;
}

async function nasCover(b){
  try {
    const r = await fetch("api/kapak", {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({title: b.title, author: b.author, isbn: b.isbn})});
    if (r.status === 401) { showLogin(); return {error: "NAS girişi gerekli"}; }
    if (!r.ok) return {error: `NAS HTTP ${r.status}`};
    return await r.json();
  } catch { return {error: "NAS'a ulaşılamıyor"}; }
}

/* ---------- CSV ---------- */
const COLS = [["title","Başlık"],["author","Yazar"],["publisher","Yayınevi"],["translator","Çevirmen"],["year","Yıl"],["pages","Sayfa"],["isbn","ISBN"],["status","Durum"],["rating","Puan"],["shelves","Raflar"],["loanTo","Ödünç verilen"],["loanDate","Ödünç tarihi"],["note","Notum"],["language","Dil"],["origLanguage","Orijinal dili"],["category","Kategori"],["about","Hakkında"],["addedAt","Eklenme tarihi"]];
const csvCell = v => { v = String(v ?? ""); return /[";\n\r]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v; };
function buildCsv(){
  const rows = [COLS.map(c=>c[1])];
  for (const b of sorted([...books.values()])){
    rows.push(COLS.map(([k])=>{
      if (k==="status") return STATUS[b.status]||"";
      if (k==="shelves") return (b.shelves||[]).map(s=>shelves.get(s)?.name).filter(Boolean).join(" | ");
      if (k==="addedAt") return b.addedAt?new Date(b.addedAt).toISOString().slice(0,10):"";
      if (k==="rating") return b.rating||"";
      if (k==="isbn") return b.isbn ? b.isbn : "";
      return b[k]??"";
    }));
  }
  return "﻿" + rows.map(r=>r.map(csvCell).join(";")).join("\r\n");
}
const today = () => new Date().toISOString().slice(0,10);
async function exportCsv(){ await offerFile(`kitapligim-${today()}.csv`, new Blob([buildCsv()],{type:"text/csv;charset=utf-8"})); }

function parseCsv(text){
  text = text.replace(/^﻿/,"");
  const first = text.split(/\r?\n/,1)[0];
  const cnt = ch => first.split(ch).length - 1;
  const sep = [";",",","\t"].sort((a,b)=>cnt(b)-cnt(a))[0];
  const rows=[]; let row=[], cell="", q=false;
  for (let i=0;i<text.length;i++){
    const ch=text[i];
    if (q){ if(ch==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else q=false; } else cell+=ch; }
    else if (ch==='"') q=true;
    else if (ch===sep){ row.push(cell); cell=""; }
    else if (ch==="\n"||ch==="\r"){ if(ch==="\r"&&text[i+1]==="\n") i++; row.push(cell); rows.push(row); row=[]; cell=""; }
    else cell+=ch;
  }
  if (cell||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(c=>c.trim()));
}
const ALIAS = {
  title:["başlık","baslik","kitap adı","kitap adi","kitabın adı","kitabın ismi","kitap ismi","kitap i̇smi","isim","i̇sim","kitap","ad","adı","başlığı","ürün adı","urun adi","title","name","eser","eser adı"],
  author:["yazar","yazarlar","author","authors","yazar adı"],
  publisher:["yayınevi","yayinevi","yayın evi","publisher"],
  translator:["çevirmen","cevirmen","translator","çeviri"],
  year:["yıl","yil","yayın yılı","basım yılı","year"],
  pages:["sayfa","sayfa sayısı","pages","page count"],
  isbn:["isbn","isbn13","isbn-13","isbn10","barkod","barcode"],
  status:["durum","okuma durumu","status"],
  rating:["puan","rating","yıldız"],
  shelves:["raf","raflar","shelf","shelves","kategori","etiket","etiketler"],
  loanTo:["ödünç verilen","ödünç","kime","loaned to"],
  loanDate:["ödünç tarihi"],
  note:["not","notlar","notlarım","notum","note","notes"],
  about:["hakkında","hakkinda","açıklama","tanıtım","özet","description","about"],
  language:["kitap dili","dil","language"],
  origLanguage:["orijinal dili","orijinal dil","asıl dili","original language"],
  category:["kategori","tür","tur","category","genre"],
  addedAt:["eklenme tarihi","eklenme","date added"]
};
const FIELD_LABELS = [["title","Kitap adı"],["author","Yazar"],["publisher","Yayınevi"],["translator","Çevirmen"],["year","Yıl"],["pages","Sayfa"],["isbn","ISBN"],["language","Dil"],["origLanguage","Orijinal dili"],["category","Kategori"],["shelves","Raf"],["status","Durum"],["rating","Puan"],["note","Notum"],["about","Hakkında"],["loanTo","Ödünç verilen"],["loanDate","Ödünç tarihi"],["addedAt","Eklenme tarihi"]];
$("#csvInput").addEventListener("change", async e=>{
  const file = e.target.files[0]; e.target.value=""; if(!file) return;
  let text = await file.text();
  if (text.includes("�")) { try{ text = new TextDecoder("windows-1254").decode(await file.arrayBuffer()); }catch{} }
  const rows = parseCsv(text);
  if (!rows.length){ toast("Dosyada satır bulunamadı"); return; }
  const norm = h => low(h).replace(/[\s_\-.:]+/g," ").trim();
  const headRow = rows[0].map(norm);
  const map = {};
  for (const [k,al] of Object.entries(ALIAS)){
    let i = headRow.findIndex(h=>al.includes(h));
    if (i<0) i = headRow.findIndex(h=>h && al.some(a=>a.length>3 && h.includes(a)) && !Object.values(map).includes(headRow.indexOf(h)));
    if (i>=0 && !Object.values(map).includes(i)) map[k]=i;
  }
  const hasHeader = Object.keys(map).length >= 1;
  openImportMapping(rows, hasHeader, map);
});

function openImportMapping(rows, hasHeader, map){
  const ncol = Math.max(...rows.slice(0, 50).map(r=>r.length));
  let header = hasHeader;
  const sample = () => rows[header ? 1 : 0] || [];
  const colName = i => header ? (rows[0][i] || `Sütun ${i+1}`) : `Sütun ${i+1}`;
  const sh = openSheet(`${head("CSV içe aktar")}
    <div class="form">
      <p class="meta" style="margin:0">Her bilginin hangi sütunda olduğunu kontrol et. Sağdaki gri yazı ilk kitabın değeri.</p>
      <label class="switch"><input type="checkbox" id="hasHead" ${header?"checked":""}> İlk satır sütun adları</label>
      <div id="mapRows" class="form" style="gap:8px"></div>
      <div class="foot"><button class="btn" data-close type="button">Vazgeç</button><button class="btn primary" id="doImp" type="button"></button></div>
    </div>`);
  const draw = () => {
    const smp = sample();
    sh.querySelector("#mapRows").innerHTML = FIELD_LABELS.map(([k,label])=>`
      <label class="f">${label}
        <select data-k="${k}"><option value="">—</option>${Array.from({length:ncol},(_,i)=>`<option value="${i}" ${map[k]===i?"selected":""}>${esc(colName(i))}${smp[i]?` · ${esc(String(smp[i]).slice(0,40))}`:""}</option>`).join("")}</select>
      </label>`).join("");
    sh.querySelector("#doImp").textContent = `${rows.length - (header?1:0)} satırı içe aktar`;
  };
  draw();
  sh.querySelector("#hasHead").addEventListener("change", e=>{ header = e.target.checked; draw(); });
  sh.querySelector("#mapRows").addEventListener("change", e=>{ const sel=e.target.closest("select"); if(!sel) return; if (sel.value==="") delete map[sel.dataset.k]; else map[sel.dataset.k] = +sel.value; });
  sh.querySelector("#doImp").addEventListener("click", async ()=>{
    if (map.title===undefined){ toast("Kitap adı sütununu seç"); return; }
    closeSheet();
    await importRows(header ? rows.slice(1) : rows, map);
  });
}

async function importRows(body, map){
  const exist = new Set([...books.values()].map(b=>low(b.title)+"|"+low(b.author)));
  const existIsbn = new Set([...books.values()].map(b=>b.isbn).filter(Boolean));
  const statusOf = s => { s=low(s); if(/okunacak|unread/.test(s)) return "unread"; if(/okunuyor|reading/.test(s)) return "reading"; if(/okundu|read|bitti|evet/.test(s)) return "read"; return "unread"; };
  const newShelves = new Map(), newBooks = []; let skipped = 0, i = 0;
  for (const r of body){
    i++;
    const g = k => map[k]!==undefined ? (r[map[k]]||"").trim() : "";
    const title = g("title"); if(!title){ skipped++; continue; }
    const isbn = Lookup.cleanIsbn(g("isbn"));
    const key = low(title)+"|"+low(g("author"));
    if (exist.has(key) || (isbn && existIsbn.has(isbn))){ skipped++; continue; }
    exist.add(key); if (isbn) existIsbn.add(isbn);
    const sids=[];
    for (const nm of g("shelves").split(/[|,/]/).map(s=>s.trim()).filter(Boolean)){
      let s = shelfByName(nm) || newShelves.get(low(nm));
      if (!s){ s = shelfByName(nm, true); newShelves.set(low(nm), s); }
      sids.push(s.id);
    }
    const added = Date.parse(g("addedAt"));
    newBooks.push({id:Store.newId(), title, author:g("author"), publisher:g("publisher"), translator:g("translator"), year:g("year"), pages:g("pages"),
      isbn, status:statusOf(g("status")), rating:Math.max(0,Math.min(5,parseInt(g("rating"))||0)),
      shelves:sids, loanTo:g("loanTo"), loanDate:g("loanDate"), note:g("note"), about:g("about"), language:g("language"), origLanguage:g("origLanguage"), category:g("category"), photoId:null, coverUrl:"",
      addedAt: isNaN(added) ? Date.now()-i : added, updatedAt:Date.now(), sample:false});
  }
  try {
    if (newShelves.size) await putRecords("shelves", [...newShelves.values()]);
    await putRecords("books", newBooks);
    render();
    toast(`${newBooks.length} kitap içe aktarıldı${skipped?`, ${skipped} satır atlandı (boş ya da zaten var)`:""}. Kapaklar için Ayarlar → “Eksikleri internetten bul”.`, 6000);
  } catch { toast("İçe aktarılamadı: yer kalmamış olabilir."); }
}

/* ---------- full backup (JSON with photos) ---------- */
const blobToDataUrl = blob => new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(blob); });
async function exportBackup(){
  toast("Yedek hazırlanıyor…");
  const photos = {};
  for (const b of books.values()) if (b.photoId){
    try{
      let blob = await Store.getPhoto(b.photoId);
      if (!blob && Sync.enabled){ const r = await fetch(`api/fotos/${encodeURIComponent(b.photoId)}`); if (r.ok) blob = await r.blob(); }
      if (blob) photos[b.photoId] = await blobToDataUrl(blob);
    }catch{}
  }
  const data = {app:"kitapligim", version:1, exportedAt:new Date().toISOString(), shelves:[...shelves.values()], books:[...books.values()], photos};
  await offerFile(`kitapligim-yedek-${today()}.json`, new Blob([JSON.stringify(data)],{type:"application/json"}));
  try { localStorage.setItem("kitaplik-backup", String(Date.now())); } catch {}
}
$("#jsonInput").addEventListener("change", async e=>{
  const file = e.target.files[0]; e.target.value=""; if(!file) return;
  let data; try { data = JSON.parse(await file.text()); } catch { toast("Bu dosya okunamadı."); return; }
  if (data.app !== "kitapligim" || !Array.isArray(data.books)) { toast("Bu bir Kitaplığım yedeği değil."); return; }
  try {
    for (const [id, url] of Object.entries(data.photos||{})) { const blob = await (await fetch(url)).blob(); await Store.putPhoto(id, blob); }
    const live = data.books.filter(b=>!b.deleted).map(b=>({...b, _photoUp: b.photoId && data.photos && data.photos[b.photoId] ? 1 : 0}));
    await putRecords("shelves", (data.shelves||[]).filter(s=>!s.deleted));
    await putRecords("books", live);
    render(); closeSheet(); toast(`Yedekten ${data.books.length} kitap geri yüklendi`, 3500);
  } catch { toast("Geri yükleme yarıda kaldı: telefonda yer kalmamış olabilir."); }
});

/* ---------- first run sample ---------- */
async function seedSamples(){
  const shelf = {id:"ornek-arastirma", name:"Araştırma", order:1, sample:true};
  const t = Date.now();
  const mk = (id,title,author,publisher,extra) => ({id,title,author,publisher,translator:"",year:"",pages:"",isbn:"",status:"unread",rating:0,shelves:[],loanTo:"",loanDate:"",note:"",photoId:null,coverUrl:"",addedAt:t,updatedAt:t,sample:true,...extra});
  const list = [
    mk("ornek-0400","04:00","Hikmet Hükümenoğlu","Can Yayınları",{status:"read",rating:4,note:"Örnek not.",addedAt:t-3}),
    mk("ornek-folklor","100 Soruda Türk Folkloru","Pertev Naili Boratav","",{status:"reading",shelves:[shelf.id],addedAt:t-2}),
    mk("ornek-1984","1984","George Orwell","Can Yayınları",{translator:"Celal Üster",status:"read",rating:5,loanTo:"Ahmet",loanDate:"2026-10-20",addedAt:t-1}),
    mk("ornek-2035","2035 Sonun Başlangıcı","Ali Demirsoy","Asi Kitap",{shelves:[shelf.id]})
  ];
  await Store.put("shelves", shelf); await Store.putMany("books", list);
}

/* ---------- install hint (iOS Safari, not yet installed) ---------- */
function installHint(){
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let dismissed = false; try { dismissed = localStorage.getItem("kitaplik-hint")==="1"; } catch {}
  if (standalone || !ios || dismissed) return;
  const h = $("#installHint");
  h.innerHTML = `<span>Uygulama gibi kullanmak için Safari'de Paylaş düğmesine, sonra “Ana Ekrana Ekle”ye dokun.</span><button class="btn" id="hintOk">Tamam</button>`;
  h.hidden = false;
  h.querySelector("#hintOk").addEventListener("click", ()=>{ h.hidden=true; try{localStorage.setItem("kitaplik-hint","1")}catch{} });
}

/* ---------- boot ---------- */
(async ()=>{
  render();
  try {
    let first = false; try { first = !localStorage.getItem("kitaplik-seeded"); } catch {}
    const [server, loadedAll] = await Promise.all([Sync.detect(), Promise.all([Store.all("books"), Store.all("shelves")])]);
    let [bs, ss] = loadedAll;
    if (!server && first && !bs.length && !ss.length) { await seedSamples(); [bs, ss] = await Promise.all([Store.all("books"), Store.all("shelves")]); }
    try { localStorage.setItem("kitaplik-seeded","1"); } catch {}
    const split = (list, kind) => { const live = []; for (const r of list) (r.deleted ? tombs[kind].set(r.id, r) : live.push(r)); return new Map(live.map(r=>[r.id,r])); };
    books = split(bs, "books"); shelves = split(ss, "shelves");
    loaded = true; render();
    Store.persist();
    if (server) Sync.run();
  } catch {
    loaded = true; render();
    toast("Bu tarayıcı kayıt tutmaya izin vermiyor. Özel sekmede olabilirsin.", 6000);
  }
  installHint();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
})();
