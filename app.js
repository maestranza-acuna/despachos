/* =====================================================================
   Despachos Acuña · app del piloto
   Interfaz del prototipo + Supabase (login, roles, datos en vivo),
   cola de envío para trabajar sin señal y exportación a Excel.
   ===================================================================== */
"use strict";

/* ===== Constantes del negocio ===== */
const TIPOS = {
  obra:    { label: "Obra", traslado: "Traslados Internos" },
  galv:    { label: "Galvanizado", traslado: "Otros Traslados No Venta", senor: "GALVANIZADORA Y METALES S A", rut: "96.562.040-0" },
  pintura: { label: "Pintura", traslado: "Traslados Internos" },
  otro:    { label: "Otro destino", traslado: "Otros Traslados No Venta" }
};
const SALIDAS = ["obra", "galv", "pintura", "otro"];
const PLANTILLAS = [
  { k: "Pernos", txt: "PER. " }, { k: "Perfil suelto", txt: "CJ" }, { k: "Plancha", txt: "PL" },
  { k: "Golillones", txt: "GOLILLONES " }, { k: "Otro", txt: "" }
];
const ROLES = { admin: "Administrador", oficina: "Oficina", despacho: "Despacho", montaje: "Montaje" };
const PESTANAS = {
  admin: ["despachar", "oficina", "recepcion", "avance"],
  oficina: ["despachar", "oficina", "recepcion", "avance"],
  despacho: ["despachar", "oficina", "avance"],
  montaje: ["recepcion", "oficina", "avance"]
};
const INICIO = { admin: "despachar", oficina: "oficina", despacho: "despachar", montaje: "recepcion" };

/* Marca como se escribe en la guía: sin guion (CV-12 → CV12).
   Si la familia termina en número (C1-1, I2-1) se mantiene el guion para no confundir C1-11 con C11-1. */
function marcaGuia(m) { return /[A-Z]-\d+[A-Z]?$/.test(m) ? m.replace("-", "") : m; }

/* ===== Utilidades ===== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").toUpperCase().replace(/[\s\-_.]/g, "");
const fmt = n => Number(n || 0).toLocaleString("es-CL", { maximumFractionDigits: 1 });
const peso = kg => kg >= 1000 ? fmt(kg / 1000) + " t" : fmt(Math.round(kg)) + " kg";
const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
function fechaCorta(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("es-CL", { day: "2-digit", month: "short" }) + " " + d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
}
function parseNum(s) {
  s = String(s ?? "").replace(/\s/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s); return isNaN(n) ? 0 : n;
}
function famDe(m) { return m.replace(/-\d+[A-Z]?$/, ""); }
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}
function sinRed(err) {
  const m = String((err && (err.message || err)) || "");
  return !navigator.onLine || /Failed to fetch|NetworkError|Load failed|network/i.test(m);
}
function textoError(err) {
  if (sinRed(err)) return "Sin señal. Intenta de nuevo cuando vuelva la conexión.";
  return (err && err.message) || "Ocurrió un error inesperado.";
}

/* ===== Conexión ===== */
const CFG = window.CONFIG || {};
const sb = (window.supabase && CFG.supabaseUrl && CFG.supabaseKey)
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "despachos-sesion" } })
  : null;

/* ===== Estado ===== */
const S = {
  tab: "despachar", obraId: store.get("obraId", null),
  obras: [], marcas: {}, movs: [], perfiles: {}, despachos: [],
  sesion: null, yo: null, red: "conectando", ultimaSync: null,
  cola: store.get("cola", []), enviando: false,
  fam: "", q: "", soloPend: true, limite: 80, vista: "elegir", mov: "salida",
  filtroOf: "por_emitir", filtroAv: "pend", qAv: "", confirmando: null, abierto: null
};
let cargas = store.get("cargas", {});
const cacheListado = {};

const rol = () => (S.yo && S.yo.rol) || null;
const puede = {
  despachar: () => ["admin", "oficina", "despacho"].includes(rol()),
  oficina: () => ["admin", "oficina"].includes(rol()),
  recibir: () => ["admin", "oficina", "montaje"].includes(rol()),
  admin: () => rol() === "admin"
};

/* ----- Filas de la base → objetos de la app ----- */
function aObra(r) {
  return { id: r.id, nombre: r.nombre, constructora: r.constructora, rut: r.rut, obraGuia: r.obra_guia,
    requiereGalv: r.requiere_galv, listadoRev: r.listado_rev, esPrueba: r.es_prueba };
}
function aMov(r) {
  return { id: r.id, clientId: r.client_id, obraId: r.obra_id, seq: r.seq, codigo: r.codigo, tipo: r.tipo, destino: r.destino,
    items: r.items || [], extras: r.extras || [], piezas: r.piezas, kg: +r.kg, chofer: r.chofer, patente: r.patente, obs: r.obs,
    estado: r.estado, guia: r.guia, guiaExt: r.guia_ext, creadoPor: r.creado_por, creadoEn: r.creado_en,
    emitidaPor: r.emitida_por, emitidaEn: r.emitida_en,
    recepcion: r.recepcion ? Object.assign({}, r.recepcion, { por: r.recibida_por, en: r.recibida_en }) : null };
}
function deCola(c) {
  return { id: "cola-" + c.client_id, clientId: c.client_id, obraId: c.obra_id, seq: 0, codigo: "Sin enviar", tipo: c.tipo,
    destino: c.destino, items: c.items, extras: c.extras, piezas: c.piezas, kg: c.kg, chofer: c.chofer, patente: c.patente,
    obs: c.obs, estado: "cola", guia: null, guiaExt: c.guia_ext, creadoPor: S.yo && S.yo.id, creadoEn: c.creado_local,
    recepcion: null, errorCola: c.error || "" };
}
function recomputar() {
  const enBase = new Set(S.movs.map(m => m.clientId));
  S.despachos = S.movs.concat(S.cola.filter(c => !enBase.has(c.client_id)).map(deCola));
}

function obra(id = S.obraId) {
  const o = S.obras.find(x => x.id === id);
  return o || { id: null, nombre: "Sin obras", constructora: "", rut: "", obraGuia: "", requiereGalv: false, listadoRev: "", esPrueba: false };
}
function listado(o = obra()) {
  const filas = S.marcas[o.id] || [];
  if (cacheListado[o.id] && cacheListado[o.id].filas === filas) return cacheListado[o.id].data;
  const marcas = filas.map(r => ({ m: r.marca, perfil: r.perfil, cant: r.cant, largo: r.largo, kgU: +r.kg_unit, desc: r.descripcion, fam: r.familia || famDe(r.marca) }))
    .sort((a, b) => a.m.localeCompare(b.m, "es", { numeric: true }));
  const map = {}; marcas.forEach(x => map[x.m] = x);
  const data = { marcas, map };
  cacheListado[o.id] = { filas, data };
  return data;
}
function claveCarga() { return S.mov === "entrada" ? S.obraId + "|entrada" : S.obraId; }
function carga() {
  const k = claveCarga();
  if (!cargas[k]) cargas[k] = { items: {}, extras: [], tipo: S.mov === "entrada" ? "retorno" : (obra().requiereGalv ? "galv" : "obra"), destino: "", chofer: "", patente: "", obs: "", guiaExt: "" };
  return cargas[k];
}
function guardarCarga() { store.set("cargas", cargas); }

/* Movimientos por marca: a galvanizado/pintura (aTrat), vuelta a maestranza (ret) y a obra (aObra) */
function consumo(obraId = S.obraId) {
  const aObra = {}, aTrat = {}, ret = {}, recibido = {};
  for (const d of S.despachos) {
    if (d.obraId !== obraId || d.estado === "anulada") continue;
    const dest = d.tipo === "obra" ? aObra : (d.tipo === "galv" || d.tipo === "pintura") ? aTrat : d.tipo === "retorno" ? ret : null;
    if (!dest) continue;
    for (const it of d.items || []) {
      dest[it.m] = (dest[it.m] || 0) + it.q;
      if (d.tipo === "obra" && d.recepcion) recibido[it.m] = (recibido[it.m] || 0) + ((d.recepcion.items || {})[it.m] ?? it.q);
    }
  }
  return { aObra, aTrat, ret, recibido };
}
function saldoDe(mk, cons, c) {
  if (c.tipo === "retorno") return (cons.aTrat[mk.m] || 0) - (cons.ret[mk.m] || 0);
  if (c.tipo === "obra") return mk.cant - (cons.aObra[mk.m] || 0);
  return mk.cant - (cons.aTrat[mk.m] || 0);
}
function listasObra(mk, cons) { return (cons.ret[mk.m] || 0) - (cons.aObra[mk.m] || 0); }

/* ===== Datos: carga inicial, copia local, cambios en vivo ===== */
async function todas(construir) {
  const out = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await construir().range(desde, desde + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
function guardarCopia() {
  store.set("copia", { obras: S.obras, marcas: S.marcas, movs: S.movs, perfiles: S.perfiles, en: S.ultimaSync, uid: S.yo && S.yo.id });
}
function leerCopia() {
  const c = store.get("copia", null);
  if (!c || !S.yo || c.uid !== S.yo.id) return false;
  S.obras = c.obras || []; S.marcas = c.marcas || {}; S.movs = c.movs || []; S.perfiles = c.perfiles || {}; S.ultimaSync = c.en;
  return true;
}
async function cargarMarcas(obraId) {
  S.marcas[obraId] = await todas(() => sb.from("marcas").select("marca,perfil,cant,largo,kg_unit,descripcion,familia").eq("obra_id", obraId).order("marca"));
}
async function cargarTodo() {
  const [obras, movs, perfiles] = await Promise.all([
    todas(() => sb.from("obras").select("*").eq("activa", true).order("creado_en")),
    todas(() => sb.from("movimientos").select("*").order("creado_en", { ascending: false })),
    todas(() => sb.from("perfiles").select("id,nombre,rol,activo"))
  ]);
  const antes = Object.fromEntries(S.obras.map(o => [o.id, o.listadoRev]));
  S.obras = obras.map(aObra);
  S.movs = movs.map(aMov);
  S.perfiles = Object.fromEntries(perfiles.map(p => [p.id, p]));
  await Promise.all(S.obras.filter(o => !S.marcas[o.id] || antes[o.id] !== o.listadoRev).map(o => cargarMarcas(o.id)));
  S.ultimaSync = new Date().toISOString();
  S.red = "en_linea";
  recomputar(); guardarCopia();
}
let canal = null;
function escucharCambios() {
  if (canal) return;
  canal = sb.channel("cambios")
    .on("postgres_changes", { event: "*", schema: "public", table: "movimientos" }, p => {
      if (p.eventType === "DELETE") S.movs = S.movs.filter(m => m.id !== p.old.id);
      else {
        const m = aMov(p.new), i = S.movs.findIndex(x => x.id === m.id);
        if (i >= 0) S.movs[i] = m; else S.movs.unshift(m);
        S.cola = S.cola.filter(c => c.client_id !== m.clientId); store.set("cola", S.cola);
      }
      recomputar(); guardarCopia(); renderSeguro();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "obras" }, () => refrescar())
    .subscribe(st => { if (st === "SUBSCRIBED") { S.red = "en_linea"; setSync(); } });
}
async function refrescar() {
  if (!sb || !S.yo || !S.yo.activo) return;
  try { await cargarTodo(); poblarObras(); renderSeguro(); enviarCola(); }
  catch (e) { if (sinRed(e)) { S.red = "sin_senal"; setSync(); } }
}

/* ----- Cola de envío: lo que se registra sin señal se envía solo al volver ----- */
function encolar(body) {
  S.cola.push(body); store.set("cola", S.cola); recomputar();
  enviarCola();
}
async function enviarCola() {
  if (S.enviando || !S.cola.length || !sb) return;
  S.enviando = true; setSync();
  try {
    for (const c of S.cola.slice()) {
      const { creado_local, error: _e, ...body } = c;
      const { data, error } = await sb.from("movimientos").insert(body).select().single();
      if (error) {
        if (sinRed(error)) { S.red = "sin_senal"; break; }
        if (error.code === "23505" && /client_id/.test(error.message + error.details)) {
          S.cola = S.cola.filter(x => x.client_id !== c.client_id);
          continue;
        }
        c.error = textoError(error);
        continue;
      }
      const m = aMov(data);
      if (!S.movs.some(x => x.id === m.id)) S.movs.unshift(m);
      S.cola = S.cola.filter(x => x.client_id !== c.client_id);
      S.red = "en_linea";
      toast(m.tipo === "retorno" ? `Entrada ${m.codigo} registrada` : `Despacho ${m.codigo} enviado a oficina`);
    }
  } finally {
    S.enviando = false; store.set("cola", S.cola); recomputar(); guardarCopia(); setSync(); renderSeguro();
  }
}

/* ===== Texto de la guía ===== */
function textoGuia(d, o) {
  const partes = (d.items || []).map(i => `${i.q} ${marcaGuia(i.m)}`)
    .concat((d.extras || []).filter(e => e.txt && e.q > 0).map(e => `${e.q} ${e.txt.trim().toUpperCase()}`));
  const lineas = ["ELEMENTOS", partes.join("/"), "OBRA: " + (o.obraGuia || o.nombre).toUpperCase()];
  if ((d.tipo === "pintura" || d.tipo === "otro") && d.destino) lineas.push("DESTINO: " + d.destino.toUpperCase());
  lineas.push("CHOFER: " + (d.chofer || "").toUpperCase());
  if (d.patente) lineas.push("PATENTE: " + d.patente.toUpperCase());
  return lineas.join("\n");
}
function totales(d, o) {
  const L = listado(o);
  let piezas = 0, kg = 0;
  (d.items || []).forEach(i => { piezas += i.q; kg += i.q * ((L.map[i.m] || {}).kgU || 0); });
  (d.extras || []).forEach(e => { if (e.txt && e.q > 0) piezas += e.q; });
  return { piezas, kg: Math.round(kg * 10) / 10 };
}
function datosGuia(d, o) {
  const t = TIPOS[d.tipo] || TIPOS.obra;
  const senor = d.tipo === "galv" ? t.senor : o.constructora;
  const rut = d.tipo === "galv" ? t.rut : o.rut;
  return `<dl class="kv">
    <dt>Señor(es)</dt><dd>${esc(senor || "—")}</dd>
    <dt>R.U.T.</dt><dd>${esc(rut || "completar")}</dd>
    <dt>Tipo traslado</dt><dd>${esc(t.traslado)}</dd>
    <dt>Cantidad</dt><dd class="num">${fmt(totales(d, o).piezas)} UN</dd>
  </dl>`;
}
function nombreDe(uid) { const p = S.perfiles[uid]; return (p && p.nombre) || "alguien del equipo"; }

/* ===== Pantallas de acceso ===== */
function pantallaAcceso(modo = "entrar", msg = "") {
  $(".nav").hidden = true; $("#cargo").hidden = true; $("#cuentaBtn").hidden = true; $("#obraSel").hidden = true;
  $("#sync").hidden = true;
  const m = $("#main");
  if (!sb) {
    m.innerHTML = `<h2>Falta configurar la conexión</h2><div class="note warn">La app no tiene configurada la base de datos (config.js).</div>`;
    return;
  }
  m.innerHTML = `
    <div class="acceso">
      <img src="iconos/icono-192.png" alt="" width="72" height="72">
      <h2>${modo === "entrar" ? "Entrar" : "Crear cuenta"}</h2>
      ${msg ? `<div class="note ${/Listo|creada/.test(msg) ? "" : "warn"}">${esc(msg)}</div>` : ""}
      <form id="formAcceso" autocomplete="on" novalidate>
        ${modo === "crear" ? `<div class="field"><label for="aNombre">Nombre y apellido</label><input id="aNombre" class="inp" autocomplete="name" required></div>` : ""}
        <div class="field"><label for="aCorreo">Correo</label><input id="aCorreo" class="inp" type="email" inputmode="email" autocomplete="username" autocapitalize="none" required></div>
        <div class="field"><label for="aClave">Contraseña</label><input id="aClave" class="inp" type="password" autocomplete="${modo === "entrar" ? "current-password" : "new-password"}" minlength="8" required></div>
        <button class="btn pri block" type="submit">${modo === "entrar" ? "Entrar" : "Crear cuenta"}</button>
      </form>
      <p class="small" style="text-align:center">${modo === "entrar"
        ? `¿Primera vez? <button type="button" class="link" data-acceso="crear">Crear cuenta</button>`
        : `¿Ya tienes cuenta? <button type="button" class="link" data-acceso="entrar">Entrar</button>`}</p>
      <p class="small muted" style="text-align:center">Si olvidaste tu contraseña, pídele al administrador que te asigne una nueva.</p>
    </div>`;
  S.modoAcceso = modo;
}
function pantallaPendiente() {
  $(".nav").hidden = true; $("#cargo").hidden = true; $("#obraSel").hidden = true;
  $("#cuentaBtn").hidden = false; $("#cuentaBtn").textContent = iniciales(S.yo.nombre);
  $("#main").innerHTML = `
    <div class="acceso">
      <h2>Cuenta creada</h2>
      <div class="note">Hola ${esc(S.yo.nombre || "")}. Tu usuario ya existe, pero falta que el administrador lo active y te asigne un rol (despacho, oficina o montaje). Avísale y luego toca “Revisar de nuevo”.</div>
      <p><button class="btn pri block" type="button" data-revisar>Revisar de nuevo</button></p>
      <p><button class="btn block" type="button" data-salir>Cerrar sesión</button></p>
    </div>`;
}
function iniciales(n) { return (n || "?").trim().split(/\s+/).slice(0, 2).map(p => p[0]).join("").toUpperCase() || "?"; }

async function cargarPerfil() {
  const uid = S.sesion.user.id;
  const { data, error } = await sb.from("perfiles").select("id,nombre,rol,activo").eq("id", uid).maybeSingle();
  if (error) throw error;
  S.yo = data ? Object.assign({ correo: S.sesion.user.email }, data) : { id: uid, nombre: "", rol: null, activo: false, correo: S.sesion.user.email };
  store.set("yo", S.yo);
}
async function arrancar() {
  try { await cargarPerfil(); }
  catch (e) {
    const guardado = store.get("yo", null);
    if (sinRed(e) && guardado && guardado.id === S.sesion.user.id) { S.yo = guardado; S.red = "sin_senal"; }
    else { pantallaAcceso("entrar", textoError(e)); return; }
  }
  if (!S.yo.activo || !S.yo.rol) { pantallaPendiente(); return; }
  if (!PESTANAS[rol()].includes(S.tab)) S.tab = INICIO[rol()];
  const h = (location.hash || "").slice(1);
  if (PESTANAS[rol()].includes(h)) S.tab = h;
  const tenia = leerCopia();
  if (tenia) { recomputar(); prepararUI(); render(); }
  try { await cargarTodo(); }
  catch (e) {
    if (!tenia) { $("#main").innerHTML = `<div class="note warn">${esc(textoError(e))}</div><p><button class="btn block" type="button" data-revisar>Reintentar</button></p>`; return; }
    S.red = "sin_senal";
  }
  prepararUI(); render(); escucharCambios(); enviarCola();
}
function prepararUI() {
  const tabs = PESTANAS[rol()];
  const nav = $(".nav"); nav.hidden = false;
  nav.querySelector(".wrap").style.gridTemplateColumns = `repeat(${tabs.length},1fr)`;
  nav.querySelectorAll("button[data-tab]").forEach(b => b.hidden = !tabs.includes(b.dataset.tab));
  $("#cuentaBtn").hidden = false; $("#cuentaBtn").textContent = iniciales(S.yo.nombre);
  $("#obraSel").hidden = false; $("#sync").hidden = false;
  poblarObras(); setSync();
}

/* ===== Render ===== */
function setSync() {
  const el = $("#sync"), n = S.cola.length;
  const estado = S.enviando ? "enviando" : S.red;
  el.className = "sync " + (estado === "en_linea" ? (n ? "local" : "on") : estado === "sin_senal" ? "local" : "");
  el.querySelector("span").textContent =
    estado === "enviando" ? "Enviando…" :
    estado === "sin_senal" ? `Sin señal${n ? ` · ${n} por enviar` : ""}` :
    estado === "en_linea" ? (n ? `${n} por enviar` : "En línea") : "Conectando…";
}
function poblarObras() {
  const sel = $("#obraSel");
  if (!S.obras.some(o => o.id === S.obraId)) S.obraId = S.obras.length ? S.obras[0].id : null;
  const html = S.obras.map(o => `<option value="${esc(o.id)}">${esc(o.nombre)}${o.esPrueba ? " · PRUEBA" : ""}</option>`).join("") || `<option value="">Sin obras</option>`;
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.value = S.obraId || "";
}
function render() {
  if (!S.yo || !S.yo.activo) return;
  document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === S.tab ? "page" : "false"));
  const porEmitir = S.despachos.filter(d => d.obraId === S.obraId && d.estado === "por_emitir").length;
  const porRecibir = S.despachos.filter(d => d.obraId === S.obraId && d.tipo === "obra" && d.estado === "emitida" && !d.recepcion).length;
  $("#bOf").hidden = !porEmitir || !puede.oficina(); $("#bOf").textContent = porEmitir;
  $("#bRc").hidden = !porRecibir; $("#bRc").textContent = porRecibir;
  document.body.classList.toggle("prueba", !!obra().esPrueba);
  const m = $("#main");
  if (!S.obraId && S.tab !== "cuenta") { renderSinObras(m); }
  else if (S.tab === "cuenta") renderCuenta(m);
  else if (S.tab === "despachar") S.vista === "revisar" ? renderRevisar(m) : renderElegir(m);
  else if (S.tab === "oficina") renderOficina(m);
  else if (S.tab === "recepcion") renderRecepcion(m);
  else renderAvance(m);
  renderCargo(); setSync();
  document.querySelectorAll("[data-uid]").forEach(e => e.textContent = nombreDe(e.dataset.uid));
}
function renderSinObras(m) {
  m.innerHTML = `<h2>Sin obras activas</h2><div class="note">Todavía no hay obras cargadas.${puede.oficina() ? " Crea una en Oficina." : " Avísale a oficina."}</div>
    ${puede.oficina() ? `<div class="card" style="padding:12px;margin-top:12px"><div class="field"><label for="nNombre">Nombre de la obra</label><input id="nNombre" class="inp"></div><button class="btn block" type="button" data-nueva-obra>Crear obra</button></div>` : ""}`;
}
/* Cambios de otros usuarios: si alguien está escribiendo, se repinta al salir del campo */
function renderSeguro() {
  if (!S.yo || !S.yo.activo) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox") {
    S.pendiente = true;
    if (a.id === "buscar") { pintarLista(); renderCargo(); S.pendiente = false; }
    setSync();
    return;
  }
  render();
}
document.addEventListener("focusout", () => setTimeout(() => {
  const a = document.activeElement;
  if (S.pendiente && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) { S.pendiente = false; render(); }
}, 50));

/* --- Despachar: elegir piezas --- */
function marcasFiltradas() {
  const L = listado(), cons = consumo(), c = carga(), q = norm(S.q);
  let arr = L.marcas;
  if (S.fam) arr = arr.filter(x => x.fam === S.fam);
  if (q) {
    arr = arr.filter(x => norm(x.m).startsWith(q) || (q.length > 2 && norm(x.desc).includes(q)));
    arr = arr.slice().sort((a, b) => (norm(b.m) === q) - (norm(a.m) === q));
  }
  if (S.soloPend) arr = arr.filter(x => saldoDe(x, cons, c) > 0 || c.items[x.m]);
  if (c.tipo === "obra" && obra().requiereGalv && !q) {
    const listas = arr.filter(x => listasObra(x, cons) > 0);
    if (listas.length) arr = listas.concat(arr.filter(x => listasObra(x, cons) <= 0));
  }
  return arr;
}
function filaMarca(x, cons, c) {
  const saldo = saldoDe(x, cons, c), enCarga = c.items[x.m] || 0;
  const aviso = avisoMarca(x, cons, c, enCarga);
  const etq = c.tipo === "retorno" ? "en GYMSA" : c.tipo === "obra" ? "falta a obra" : c.tipo === "galv" ? "por galvanizar" : "por enviar";
  const listas = c.tipo === "obra" && obra().requiereGalv ? Math.max(listasObra(x, cons), 0) : null;
  return `<div class="mk ${enCarga ? "incart" : ""} ${saldo <= 0 && !enCarga ? "done" : ""}" id="mk-${esc(x.m)}" data-add="${esc(x.m)}" role="button" tabindex="0" aria-label="Agregar ${esc(x.m)}">
    <div class="code">${esc(marcaGuia(x.m))}</div>
    <div class="meta"><b>${esc(x.desc)}</b>${esc(x.perfil)} · ${fmt(x.largo)} mm · ${fmt(x.kgU)} kg</div>
    <div class="side">
      <div class="saldo num">${etq} <strong>${fmt(Math.max(saldo, 0))}</strong>${c.tipo === "retorno" ? "" : "/" + fmt(x.cant)}</div>
      ${listas && !enCarga ? `<span class="pill ok">${fmt(listas)} galvanizada${listas > 1 ? "s" : ""} en planta</span>` : ""}
      ${enCarga ? `<div class="qtyctl" data-stop>
          <button type="button" data-dec="${esc(x.m)}" aria-label="Quitar uno">−</button>
          <input type="number" inputmode="numeric" min="0" value="${enCarga}" data-set="${esc(x.m)}" id="q-${esc(x.m)}" aria-label="Cantidad ${esc(x.m)}">
        </div>${aviso ? `<div class="over">${aviso}</div>` : ""}`
      : `<span class="addhint">+ Agregar</span>`}
    </div>
  </div>`;
}
/* Advertencias (no bloquean): pasarse del listado o sacar a obra algo que no ha vuelto de galvanizado */
function avisoMarca(x, cons, c, q) {
  if (!q) return "";
  const saldo = saldoDe(x, cons, c);
  if (q > saldo) return c.tipo === "retorno" ? `Solo ${fmt(Math.max(saldo, 0))} en GYMSA` : `Excede listado (quedan ${fmt(Math.max(saldo, 0))})`;
  if (c.tipo === "obra" && obra().requiereGalv && q > listasObra(x, cons)) return `Sin galvanizar: solo ${fmt(Math.max(listasObra(x, cons), 0))} volvieron de GYMSA`;
  return "";
}
function renderElegir(m) {
  if (!puede.despachar()) { S.tab = INICIO[rol()]; return render(); }
  const o = obra(), L = listado(o), c = carga(), cons = consumo();
  if (!L.marcas.length) {
    m.innerHTML = `<h2>${esc(o.nombre)}</h2>
      <div class="note warn">Esta obra todavía no tiene listado de conjuntos. Oficina lo carga desde <b>Oficina → Listado</b> pegándolo desde el Excel de Tekla. Mientras tanto puedes despachar ítems fuera de listado (pernos, perfiles, planchas).</div>
      <p><button class="btn pri block" type="button" data-go="revisar">Armar despacho sin listado</button></p>`;
    return;
  }
  const fams = {};
  L.marcas.forEach(x => { const s = saldoDe(x, cons, c); fams[x.fam] = (fams[x.fam] || 0) + (s > 0 ? 1 : 0); });
  const famKeys = Object.keys(fams).sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
  const destActual = S.mov === "entrada" ? "retorno" : c.tipo;
  const opciones = o.requiereGalv
    ? [["galv", "→ A galvanizado"], ["retorno", "← Vuelve de GYMSA"], ["obra", "→ A obra"]]
    : [["obra", "→ A obra"], ["otro", "Otro destino"]];
  const movSeg = `<div class="seg mov" role="group" aria-label="Movimiento" style="grid-template-columns:repeat(${opciones.length},1fr);margin-bottom:10px">
      ${opciones.map(([k, t]) => `<button type="button" data-dest="${k}" aria-pressed="${destActual === k || (k === "otro" && (destActual === "pintura" || destActual === "galv"))}">${t}</button>`).join("")}</div>`;
  m.innerHTML = `
    <div class="picker-head">
      ${movSeg}
      ${S.mov === "entrada" ? `<p class="small" style="margin:0 0 8px"><b>Entrada a maestranza:</b> marca lo que volvió de GYMSA. No genera guía nuestra.</p>` : ""}
      <div class="search">
        <input id="buscar" class="inp" type="search" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
          placeholder="Escribe la marca: CV12, XL-3…" value="${esc(S.q)}" aria-label="Buscar marca">
        <button class="clear" type="button" data-clear aria-label="Borrar búsqueda" ${S.q ? "" : "hidden"}>×</button>
      </div>
      <div class="chips" role="group" aria-label="Familias">
        <button type="button" class="chip" data-fam="" aria-pressed="${!S.fam}">Todas</button>
        ${famKeys.map(f => `<button type="button" class="chip" data-fam="${esc(f)}" aria-pressed="${S.fam === f}">${esc(f)} <span>${fams[f]}</span></button>`).join("")}
      </div>
      <div class="toggles">
        <label class="switch"><input type="checkbox" id="soloPend" ${S.soloPend ? "checked" : ""}> ${S.mov === "entrada" ? "Solo marcas que están en GYMSA" : "Ocultar marcas ya despachadas"}</label>
        <span class="num" id="nMarcas"></span>
      </div>
    </div>
    <div id="listaWrap"></div>`;
  pintarLista();
}
function pintarLista() {
  const w = $("#listaWrap"); if (!w) return;
  const cons = consumo(), c = carga(), arr = marcasFiltradas(), vis = arr.slice(0, S.limite);
  w.innerHTML = `<div class="list" id="lista">
      ${vis.length ? vis.map(x => filaMarca(x, cons, c)).join("")
        : !S.q && !S.fam && S.mov === "entrada" && S.soloPend ? `<div class="empty">No hay piezas de esta obra en GYMSA. Primero se despachan con destino “Galvanizado”.</div>`
        : `<div class="empty">No hay marcas que coincidan con “${esc(S.q)}”${S.fam ? " en la familia " + esc(S.fam) : ""}.</div>`}
    </div>
    ${arr.length > S.limite ? `<div class="more"><button class="btn" type="button" data-more>Ver ${fmt(Math.min(80, arr.length - S.limite))} marcas más</button></div>` : ""}`;
  $("#nMarcas").textContent = fmt(arr.length) + " marcas";
  const cl = document.querySelector("[data-clear]"); if (cl) cl.hidden = !S.q;
}
function actualizarFila(mk) {
  const el = document.getElementById("mk-" + mk);
  const x = listado().map[mk];
  if (el && x) { const tmp = document.createElement("div"); tmp.innerHTML = filaMarca(x, consumo(), carga()); el.replaceWith(tmp.firstElementChild); }
  renderCargo();
}
function renderCargo() {
  const el = $("#cargo");
  if (!S.obraId || !puede.despachar()) { el.hidden = true; return; }
  const c = carga();
  const d = { items: Object.entries(c.items).map(([m, q]) => ({ m, q })), extras: c.extras };
  const t = totales(d, obra());
  const n = Object.keys(c.items).length + c.extras.filter(e => e.txt).length;
  el.hidden = !(S.tab === "despachar" && S.vista === "elegir" && n > 0);
  $("#cargoBtn").innerHTML = `<span>${c.tipo === "retorno" ? "Revisar entrada" : "Revisar carga"}</span><span class="cnt num">${fmt(t.piezas)} pzs · ${peso(t.kg)}</span>`;
}

/* --- Despachar: revisar y enviar --- */
function filasItems(items, L, cons, c) {
  return items.length ? items.map(i => {
    const x = L.map[i.m] || { desc: "", kgU: 0, cant: 0 };
    const aviso = x.m ? avisoMarca(x, cons, c, i.q) : "";
    return `<div class="it"><div><div class="code">${esc(marcaGuia(i.m))}</div><div class="sub">${esc(x.desc)} · ${peso(i.q * x.kgU)}${aviso ? ` · <span class="over">${aviso}</span>` : ""}</div></div>
      <div class="qtyctl"><button type="button" data-dec="${esc(i.m)}" aria-label="Quitar uno">−</button>
      <input type="number" inputmode="numeric" min="0" value="${i.q}" data-set="${esc(i.m)}" id="r-${esc(i.m)}" aria-label="Cantidad ${esc(i.m)}">
      <button type="button" data-inc="${esc(i.m)}" aria-label="Agregar uno">+</button></div></div>`;
  }).join("") : `<div class="empty">Sin piezas del listado.</div>`;
}
function renderEntrada(m) {
  const o = obra(), L = listado(o), c = carga(), cons = consumo();
  const items = Object.entries(c.items).map(([mk, q]) => ({ m: mk, q }));
  const t = totales({ items, extras: [] }, o);
  m.innerHTML = `
    <p><button class="btn ghost" type="button" data-go="elegir">← Seguir marcando piezas</button></p>
    <h2>Entrada desde galvanizado</h2>
    <p class="small muted">Piezas que vuelven de GYMSA a la maestranza. Quedan disponibles para despachar a obra.</p>
    <div class="items">${filasItems(items, L, cons, c)}</div>
    <div class="tot"><span>Total entrada</span><span class="num">${fmt(t.piezas)} UN · ${peso(t.kg)}</span></div>
    <div class="grid2" style="margin-top:14px">
      <div class="field"><label for="guiaExt">Nº guía de GYMSA</label><input id="guiaExt" class="inp num" inputmode="numeric" value="${esc(c.guiaExt)}" placeholder="Opcional"></div>
      <div class="field"><label for="patente">Patente</label><input id="patente" class="inp" value="${esc(c.patente)}" autocapitalize="characters" autocomplete="off"></div>
    </div>
    <div class="field"><label for="obs">Observaciones</label><textarea id="obs" class="inp" placeholder="Ej: YL-34 vino con exceso de zinc en perforaciones">${esc(c.obs)}</textarea></div>
    <p style="margin-top:16px"><button class="btn pri block" type="button" data-enviar ${items.length ? "" : "disabled"}>Registrar entrada a maestranza</button></p>`;
}
function renderRevisar(m) {
  if (!puede.despachar()) { S.tab = INICIO[rol()]; return render(); }
  if (S.mov === "entrada") return renderEntrada(m);
  const o = obra(), L = listado(o), c = carga(), cons = consumo();
  const items = Object.entries(c.items).map(([mk, q]) => ({ m: mk, q }));
  const d = Object.assign({}, c, { items, obraId: o.id });
  const t = totales(d, o);
  const listo = items.length + c.extras.filter(e => e.txt && e.q > 0).length > 0;
  m.innerHTML = `
    <p><button class="btn ghost" type="button" data-go="elegir">← Seguir agregando piezas</button></p>
    <h2>Revisar carga</h2>
    <h3>Destino</h3>
    <div class="seg" role="group" aria-label="Destino">
      ${SALIDAS.map(k => `<button type="button" data-tipo="${k}" aria-pressed="${c.tipo === k}">${TIPOS[k].label}</button>`).join("")}
    </div>
    ${c.tipo === "galv" ? `<p class="small muted">Sale a GYMSA. Cuando vuelva, regístralo en “Vuelve de GYMSA” y después despacha a obra con otra guía.</p>` : ""}
    ${c.tipo === "pintura" || c.tipo === "otro" ? `<div class="field" style="margin-top:12px"><label for="destino">Dirección / empresa de destino</label>
      <input id="destino" class="inp" value="${esc(c.destino)}" placeholder="${c.tipo === "pintura" ? "HOMECOATING - LOS CIPRESES 2635, LA PINTANA" : "Empresa y dirección"}"></div>` : ""}

    <h3>Piezas del listado</h3>
    <div class="items">${filasItems(items, L, cons, c)}</div>

    <h3>Fuera de listado</h3>
    <div class="items">
      ${c.extras.map((e, i) => `<div class="extra">
        <input class="txt" id="ex-t-${i}" data-ext="${i}" value="${esc(e.txt)}" placeholder="Ej: PER.5/8X2 1/4 A325 C/TH+GP" aria-label="Descripción">
        <div class="qtyctl"><input type="number" inputmode="numeric" min="0" id="ex-q-${i}" data-exq="${i}" value="${e.q}" aria-label="Cantidad"></div>
        <button type="button" class="x" data-exdel="${i}" aria-label="Eliminar">×</button></div>`).join("")}
      <div style="padding:10px 12px;display:flex;gap:8px;flex-wrap:wrap">
        ${PLANTILLAS.map((p, i) => `<button type="button" class="chip" data-plant="${i}">+ ${esc(p.k)}</button>`).join("")}
      </div>
    </div>
    <div class="tot"><span>Total carga</span><span class="num">${fmt(t.piezas)} UN · ${peso(t.kg)}</span></div>

    <h3>Transporte</h3>
    <div class="grid2">
      <div class="field"><label for="chofer">Chofer</label><input id="chofer" class="inp" value="${esc(c.chofer)}" autocomplete="off"></div>
      <div class="field"><label for="patente">Patente</label><input id="patente" class="inp" value="${esc(c.patente)}" autocapitalize="characters" autocomplete="off"></div>
    </div>
    <div class="field"><label for="obs">Nota para oficina (opcional)</label><textarea id="obs" class="inp" placeholder="Ej: faltó cargar CV-12, va en el próximo camión">${esc(c.obs)}</textarea></div>

    <h3>Así queda la glosa de la guía</h3>
    <div class="guia"><pre id="prev">${esc(textoGuia(d, o))}</pre>${datosGuia(d, o)}</div>
    <p style="margin-top:16px"><button class="btn pri block" type="button" data-enviar ${listo ? "" : "disabled"}>Enviar a oficina para emitir guía</button></p>
    <p><button class="btn danger block" type="button" data-vaciar ${listo ? "" : "disabled"}>Vaciar carga</button></p>
    ${S.confirmando === "vaciar" ? `<div class="confirm"><p>¿Vaciar toda la carga?</p><button class="btn danger" type="button" data-vaciar-ok>Sí, vaciar</button><button class="btn" type="button" data-cancel>No</button></div>` : ""}`;
}
function enviar() {
  const o = obra(), c = carga();
  const items = Object.entries(c.items).filter(([, q]) => q > 0).map(([m, q]) => ({ m, q }));
  const entrada = c.tipo === "retorno";
  const extras = entrada ? [] : c.extras.filter(e => e.txt && e.q > 0).map(e => ({ txt: e.txt.trim().toUpperCase(), q: e.q }));
  const body = {
    client_id: uuid(), obra_id: o.id, tipo: c.tipo, destino: (c.destino || "").trim(), items, extras,
    chofer: (c.chofer || "").trim().toUpperCase(), patente: (c.patente || "").replace(/\s/g, "").toUpperCase(), obs: (c.obs || "").trim(),
    guia_ext: entrada ? (c.guiaExt || "").replace(/\D/g, "") : "", estado: entrada ? "registrada" : "por_emitir",
    creado_local: new Date().toISOString()
  };
  Object.assign(body, totales({ items, extras }, o));
  cargas[claveCarga()] = { items: {}, extras: [], tipo: c.tipo, destino: c.destino, chofer: c.chofer, patente: c.patente, obs: "", guiaExt: "" };
  guardarCarga(); S.vista = "elegir"; S.q = "";
  encolar(body);
  render(); window.scrollTo(0, 0);
  if (!navigator.onLine) toast("Sin señal: quedó guardado en el teléfono y se enviará solo al volver la conexión.");
}

/* --- Oficina --- */
function tarjetaEntrada(d, o) {
  return `<details class="card ${d.estado === "anulada" ? "anulada" : ""}" data-card="${esc(d.id)}" ${S.abierto === d.id ? "open" : ""}>
    <summary>
      <div><div class="cid num">${esc(d.codigo)}</div>
        <div class="cmeta">Llegó de galvanizado · ${fmt(d.piezas)} pzs · ${peso(d.kg || 0)}${d.guiaExt ? " · guía GYMSA " + esc(d.guiaExt) : ""}</div>
        <div class="cmeta muted small">${fechaCorta(d.creadoEn)}${d.creadoPor ? ` · <span data-uid="${esc(d.creadoPor)}"></span>` : ""}</div></div>
      <div class="cright">${d.estado === "cola" ? `<span class="pill warn">Sin enviar</span>` : d.estado === "anulada" ? `<span class="pill mute">Anulada</span>` : `<span class="pill ok">Entrada</span>`}</div>
    </summary>
    <div class="body">
      <p style="margin:0" class="num">${(d.items || []).map(i => `${i.q} ${esc(marcaGuia(i.m))}`).join(" / ")}</p>
      ${d.obs ? `<div class="note">${esc(d.obs)}</div>` : ""}
      ${d.errorCola ? `<div class="note warn">${esc(d.errorCola)}</div>` : ""}
      ${botonAnular(d, "entrada")}
    </div>
  </details>`;
}
function botonAnular(d, que) {
  if (d.estado === "cola") return `<button class="btn danger" type="button" data-descartar="${esc(d.clientId)}">Descartar (no se ha enviado)</button>`;
  if (!puede.oficina() || d.estado === "anulada" || d.recepcion) return "";
  if (S.confirmando === "anular:" + d.id)
    return `<div class="confirm"><p>¿Anular ${esc(d.codigo)}? ${que === "entrada" ? "Las piezas vuelven a figurar en GYMSA." : "Las piezas vuelven a “por despachar”."}</p><button class="btn danger" type="button" data-anular-ok="${esc(d.id)}">Sí, anular</button><button class="btn" type="button" data-cancel>No</button></div>`;
  return `<button class="btn danger" type="button" data-anular="${esc(d.id)}">${que === "entrada" ? "Anular entrada" : "Anular despacho"}</button>`;
}
function tarjeta(d, o) {
  if (d.tipo === "retorno") return tarjetaEntrada(d, o);
  const t = TIPOS[d.tipo] || TIPOS.obra;
  const est = d.estado === "cola" ? `<span class="pill warn">Sin enviar</span>`
    : d.estado === "anulada" ? `<span class="pill mute">Anulado</span>`
    : d.estado === "por_emitir" ? `<span class="pill warn">Por emitir</span>`
    : d.recepcion ? (d.recepcion.diferencias ? `<span class="pill bad">Recibido c/ diferencias</span>` : `<span class="pill ok">Recibido</span>`)
    : `<span class="pill info">Guía Nº ${esc(d.guia)}</span>`;
  const texto = textoGuia(d, o);
  return `<details class="card ${d.estado === "anulada" ? "anulada" : ""}" data-card="${esc(d.id)}" ${S.abierto === d.id ? "open" : ""}>
    <summary>
      <div><div class="cid num">${esc(d.codigo)}</div>
        <div class="cmeta">${esc(t.label)}${d.tipo !== "obra" && d.destino ? " · " + esc(d.destino) : ""} · ${fmt(d.piezas)} pzs · ${peso(d.kg || 0)}</div>
        <div class="cmeta muted small">${fechaCorta(d.creadoEn)}${d.creadoPor ? ` · <span data-uid="${esc(d.creadoPor)}"></span>` : ""}</div></div>
      <div class="cright">${est}</div>
    </summary>
    <div class="body">
      ${d.errorCola ? `<div class="note warn">No se pudo enviar: ${esc(d.errorCola)}</div>` : ""}
      <div class="guia"><div class="gh"><b>Glosa para el SII</b><button class="btn" style="min-height:40px;padding:0 12px;font-size:15px" type="button" data-copiar="${esc(d.id)}">Copiar</button></div>
        <pre id="txt-${esc(d.id)}">${esc(texto)}</pre>${datosGuia(d, o)}</div>
      ${d.obs ? `<div class="note"><b>Nota de despacho:</b> ${esc(d.obs)}</div>` : ""}
      <a class="btn block" href="https://wa.me/?text=${encodeURIComponent(texto)}" target="_blank" rel="noopener">Enviar glosa por WhatsApp</a>
      ${puede.oficina() && d.estado === "por_emitir" ? `
        <div class="field" style="margin:0"><label for="g-${esc(d.id)}">Nº de guía emitida en el SII</label>
          <input id="g-${esc(d.id)}" class="inp num" inputmode="numeric" placeholder="Ej: 15077"></div>
        <button class="btn pri block" type="button" data-emitir="${esc(d.id)}">Registrar guía</button>` : ""}
      ${d.guia ? `<p class="small muted" style="margin:0">Guía Nº ${esc(d.guia)} registrada ${fechaCorta(d.emitidaEn)}${d.emitidaPor ? ` por <span data-uid="${esc(d.emitidaPor)}"></span>` : ""}.</p>` : ""}
      ${d.recepcion ? `<p class="small" style="margin:0">Recepción ${fechaCorta(d.recepcion.en)}${d.recepcion.por ? ` por <span data-uid="${esc(d.recepcion.por)}"></span>` : ""}${d.recepcion.obs ? ": " + esc(d.recepcion.obs) : ""}</p>` : ""}
      ${botonAnular(d, "despacho")}
    </div>
  </details>`;
}
function renderOficina(m) {
  const o = obra();
  const todos = S.despachos.filter(d => d.obraId === o.id).sort((a, b) => (b.creadoEn || "").localeCompare(a.creadoEn || ""));
  const grupos = {
    por_emitir: todos.filter(d => d.estado === "por_emitir" || d.estado === "cola"),
    emitida: todos.filter(d => d.estado === "emitida"),
    todas: todos
  };
  const lista = grupos[S.filtroOf] || todos;
  const L = listado(o);
  const ofi = puede.oficina();
  m.innerHTML = `
    <h2>${ofi ? "Oficina" : "Despachos"}</h2>
    ${o.esPrueba ? `<div class="note warn" style="margin-bottom:12px"><b>Obra de prueba.</b> Todo lo que hagas aquí se borra antes de partir el piloto.</div>` : ""}
    <div class="tabs2" role="group" aria-label="Filtro">
      <button type="button" class="chip" data-fof="por_emitir" aria-pressed="${S.filtroOf === "por_emitir"}">Por emitir <span>${grupos.por_emitir.length}</span></button>
      <button type="button" class="chip" data-fof="emitida" aria-pressed="${S.filtroOf === "emitida"}">Emitidas <span>${grupos.emitida.length}</span></button>
      <button type="button" class="chip" data-fof="todas" aria-pressed="${S.filtroOf === "todas"}">Todas <span>${todos.length}</span></button>
    </div>
    <div class="cards" style="margin-top:12px">
      ${lista.length ? lista.slice(0, 60).map(d => tarjeta(d, o)).join("") : `<div class="empty">${S.filtroOf === "por_emitir" ? "No hay despachos esperando guía." : "Sin despachos todavía."}</div>`}
    </div>
    ${lista.length > 60 ? `<p class="small muted">Mostrando los 60 más recientes. El historial completo está en “Exportar a Excel”.</p>` : ""}

    ${ofi ? `
    <h3>Exportar</h3>
    <div class="row-btns">
      <button class="btn" type="button" data-exportar="movimientos">Despachos a Excel</button>
      <button class="btn" type="button" data-exportar="avance">Avance por marca a Excel</button>
    </div>

    <h3 id="listados">Listado de conjuntos de esta obra</h3>
    <div class="card" style="padding:12px">
      ${L.marcas.length
        ? `<p style="margin:0 0 8px"><b>${fmt(L.marcas.length)} marcas · ${fmt(L.marcas.reduce((s, x) => s + x.cant, 0))} piezas · ${peso(L.marcas.reduce((s, x) => s + x.cant * x.kgU, 0))}</b></p><p class="small muted" style="margin:0 0 10px">${esc(o.listadoRev || "")}</p>`
        : `<p style="margin:0 0 10px">Aún no hay listado cargado.</p>`}
      <details><summary class="btn block">${L.marcas.length ? "Reemplazar por una nueva revisión" : "Cargar listado"}</summary>
        <div style="margin-top:12px">
          <p class="small">Abre el <b>lista_conjuntos.xls</b> de Tekla, selecciona todo (Ctrl+A), copia y pega aquí. Se leen las filas con marca, perfil, cantidad, largo y peso unitario. Lo ya despachado se conserva.</p>
          <div class="field"><label for="pegar">Listado pegado</label><textarea id="pegar" class="inp" placeholder="AR-1	LA65X65X5		1	1040	0,3	5,2	5,2	ANGULO REMATE"></textarea></div>
          <div class="field"><label for="rev">Revisión</label><input id="rev" class="inp" placeholder="Rev. B · 15-10-2026"></div>
          <div id="pegarRes" class="small"></div>
          <button class="btn pri block" type="button" data-cargar-listado>Guardar listado</button>
        </div>
      </details>
    </div>

    <h3>Datos de la obra para la guía</h3>
    <div class="card" style="padding:12px">
      <div class="field"><label for="oConst">Constructora (Señor/es)</label><input id="oConst" class="inp" value="${esc(o.constructora)}"></div>
      <div class="grid2">
        <div class="field"><label for="oRut">R.U.T.</label><input id="oRut" class="inp" value="${esc(o.rut)}" placeholder="96.513.310-0"></div>
        <div class="field"><label for="oGuia">Nombre en “OBRA:”</label><input id="oGuia" class="inp" value="${esc(o.obraGuia)}"></div>
      </div>
      <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="oGalv" ${o.requiereGalv ? "checked" : ""}> Las piezas de esta obra van a galvanizado antes de ir a obra</label>
      <button class="btn block" type="button" data-guardar-obra>Guardar datos de la obra</button>
    </div>

    <h3>Nueva obra</h3>
    <div class="card" style="padding:12px">
      <div class="field"><label for="nNombre">Nombre de la obra</label><input id="nNombre" class="inp" placeholder="Ej: CD Novo Lucero"></div>
      <button class="btn block" type="button" data-nueva-obra>Crear obra</button>
    </div>` : ""}`;
}
function leerListado(texto) {
  const out = [];
  for (const linea of texto.split(/\r?\n/)) {
    const cells = linea.split(linea.includes("\t") ? "\t" : ";").map(s => s.trim());
    const mk = (cells[0] || "").toUpperCase();
    if (!/^[A-Z0-9]{1,6}-\d+[A-Z]?$/.test(mk)) continue;
    const cant = parseNum(cells[3]);
    if (!cant) continue;
    out.push({ marca: mk, perfil: cells[1] || "", cant: Math.round(cant), largo: Math.round(parseNum(cells[4])), kg_unit: parseNum(cells[6]), descripcion: (cells[8] || "").toUpperCase(), familia: famDe(mk) });
  }
  return out;
}

/* --- Recepción --- */
function renderRecepcion(m) {
  const o = obra();
  const pend = S.despachos.filter(d => d.obraId === o.id && d.tipo === "obra" && d.estado !== "anulada" && d.estado !== "cola" && !d.recepcion)
    .sort((a, b) => (a.creadoEn || "").localeCompare(b.creadoEn || ""));
  const hechos = S.despachos.filter(d => d.obraId === o.id && d.tipo === "obra" && d.recepcion)
    .sort((a, b) => (b.recepcion.en || "").localeCompare(a.recepcion.en || "")).slice(0, 10);
  const sel = S.recibiendo && pend.find(d => d.id === S.recibiendo);
  if (sel && puede.recibir()) {
    const r = S.borradorRec || (S.borradorRec = { items: Object.fromEntries(sel.items.map(i => [i.m, i.q])), obs: "" });
    const L = listado(o);
    const dif = sel.items.some(i => (r.items[i.m] ?? i.q) !== i.q);
    m.innerHTML = `
      <p><button class="btn ghost" type="button" data-rec-volver>← Volver</button></p>
      <h2>Recibir ${sel.guia ? "guía Nº " + esc(sel.guia) : "despacho " + esc(sel.codigo)}</h2>
      ${!sel.guia ? `<div class="note warn">Oficina aún no registra el Nº de guía de este despacho.</div>` : ""}
      <p class="small muted">Ajusta solo lo que no llegó o llegó dañado. Todo lo demás se da por recibido.</p>
      <div class="items">
        ${sel.items.map(i => { const q = r.items[i.m] ?? i.q; return `<div class="rc ${q !== i.q ? "diff" : ""}">
          <div><div class="code cond" style="font-weight:700;font-size:24px;line-height:1">${esc(marcaGuia(i.m))}</div><div class="sub small muted">${esc((L.map[i.m] || {}).desc || "")} · enviadas ${i.q}</div></div>
          <div class="qtyctl"><button type="button" data-rdec="${esc(i.m)}" aria-label="Una menos">−</button>
            <input type="number" inputmode="numeric" min="0" id="rc-${esc(i.m)}" data-rset="${esc(i.m)}" value="${q}" aria-label="Recibidas ${esc(i.m)}">
            <button type="button" data-rinc="${esc(i.m)}" aria-label="Una más">+</button></div></div>`; }).join("")}
        ${(sel.extras || []).map(e => `<div class="rc"><div><b>${esc(e.txt)}</b></div><div class="num"><b>${fmt(e.q)}</b> UN</div></div>`).join("")}
      </div>
      <div class="field" style="margin-top:12px"><label for="recObs">Observaciones</label><textarea id="recObs" class="inp" placeholder="Ej: CV-14 con golpe en ala, se deja apartada">${esc(r.obs)}</textarea></div>
      <button class="btn pri block" type="button" data-rec-ok="${esc(sel.id)}">${dif ? "Confirmar recepción con diferencias" : "Confirmar: llegó todo"}</button>`;
    return;
  }
  m.innerHTML = `
    <h2>Recepción en obra</h2>
    <p class="small muted" style="margin-top:0">Para el supervisor y los visitadores de montaje: confirma cada camión al descargar.</p>
    <div class="cards">
      ${pend.length ? pend.map(d => `<button type="button" class="card" style="text-align:left;padding:12px;display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center" data-recibir="${esc(d.id)}" ${puede.recibir() ? "" : "disabled"}>
          <div><div class="cid cond" style="font-weight:700;font-size:24px">${d.guia ? "Guía Nº " + esc(d.guia) : "Despacho " + esc(d.codigo)}</div>
          <div class="cmeta small">${fechaCorta(d.creadoEn)} · ${fmt(d.piezas)} pzs · ${peso(d.kg || 0)}${d.patente ? " · " + esc(d.patente) : ""}</div></div>
          ${puede.recibir() ? `<span class="btn pri" style="min-height:44px">Recibir</span>` : `<span class="pill info">En camino</span>`}</button>`).join("")
        : `<div class="empty">No hay camiones en camino a esta obra.</div>`}
    </div>
    ${hechos.length ? `<h3>Últimas recepciones</h3><div class="cards">${hechos.map(d => tarjeta(d, o)).join("")}</div>` : ""}`;
}

/* --- Avance --- */
function etapas(o = obra()) {
  const L = listado(o), cons = consumo(o.id);
  const T = { kg: 0, pz: 0, obra: [0, 0], lista: [0, 0], gymsa: [0, 0] }, fams = {}, filas = [];
  for (const x of L.marcas) {
    const eo = Math.min(cons.aObra[x.m] || 0, x.cant);
    const vuelta = Math.min(cons.ret[x.m] || 0, x.cant), salida = Math.min(cons.aTrat[x.m] || 0, x.cant);
    const lista = Math.max(vuelta - eo, 0), gymsa = Math.max(salida - Math.max(vuelta, eo), 0);
    T.kg += x.cant * x.kgU; T.pz += x.cant;
    T.obra[0] += eo; T.obra[1] += eo * x.kgU; T.lista[0] += lista; T.lista[1] += lista * x.kgU; T.gymsa[0] += gymsa; T.gymsa[1] += gymsa * x.kgU;
    const f = fams[x.fam] || (fams[x.fam] = { kg: 0, oKg: 0, lKg: 0, gKg: 0, desc: x.desc });
    f.kg += x.cant * x.kgU; f.oKg += eo * x.kgU; f.lKg += lista * x.kgU; f.gKg += gymsa * x.kgU;
    filas.push({ x, eo: cons.aObra[x.m] || 0, et: cons.aTrat[x.m] || 0, er: cons.ret[x.m] || 0, rec: cons.recibido[x.m] || 0 });
  }
  return { T, fams, filas };
}
function renderAvance(m) {
  const o = obra(), L = listado(o);
  if (!L.marcas.length) { m.innerHTML = `<h2>Avance</h2><div class="note">Carga el listado de conjuntos en Oficina para ver el avance de esta obra.</div>`; return; }
  const { T, fams } = etapas(o);
  const galv = !!o.requiereGalv;
  const guias = S.despachos.filter(d => d.obraId === o.id && d.estado !== "anulada" && d.tipo !== "retorno");
  const conDif = guias.filter(d => d.recepcion && d.recepcion.diferencias).length;
  const famArr = Object.entries(fams).sort((a, b) => b[1].kg - a[1].kg);
  const barra = (o_, l_, g_, tot) => `<i class="b-obra" style="width:${pct(o_, tot)}%"></i><i class="b-lista" style="width:${pct(l_, tot)}%"></i><i class="b-trat" style="width:${pct(g_, tot)}%"></i>`;
  m.innerHTML = `
    <h2>Avance de despacho</h2>
    <div class="kpis">
      <div class="kpi big"><div class="v num">${pct(T.obra[1], T.kg)}%</div><div class="l">del peso total ya despachado a obra · ${peso(T.obra[1])} de ${peso(T.kg)}</div>
        <div class="bar" aria-hidden="true">${barra(T.obra[1], T.lista[1], T.gymsa[1], T.kg)}</div>
        <div class="legend"><span><i style="background:var(--ok)"></i>En obra</span>
          ${galv ? `<span><i style="background:var(--lista)"></i>Galvanizado en planta</span><span><i style="background:var(--info)"></i>En GYMSA</span>` : `<span><i style="background:var(--info)"></i>En pintura / tratamiento</span>`}
          <span><i style="background:var(--surface-2);border:1px solid var(--line-soft)"></i>${galv ? "Por galvanizar" : "En maestranza"}</span></div></div>
      <div class="kpi"><div class="v num">${fmt(T.obra[0])}</div><div class="l">de ${fmt(T.pz)} piezas en obra</div></div>
      ${galv ? `<div class="kpi"><div class="v num">${fmt(T.lista[0])}</div><div class="l">galvanizadas en planta, listas para obra · ${peso(T.lista[1])}</div></div>` : ""}
      <div class="kpi"><div class="v num">${fmt(T.gymsa[0])}</div><div class="l">${galv ? "piezas en GYMSA" : "piezas en tratamiento"} · ${peso(T.gymsa[1])}</div></div>
      <div class="kpi"><div class="v num">${fmt(guias.length)}</div><div class="l">despachos (${fmt(guias.filter(d => d.guia).length)} con guía)</div></div>
      <div class="kpi"><div class="v num" style="color:${conDif ? "var(--bad)" : "inherit"}">${fmt(conDif)}</div><div class="l">recepciones con diferencias</div></div>
    </div>

    <h3>Por familia (peso)</h3>
    <div>${famArr.map(([f, v]) => `<div class="fam"><div class="code">${esc(f)}</div>
      <div class="bar" role="img" aria-label="${esc(f)}: ${pct(v.oKg, v.kg)}% en obra">${barra(v.oKg, v.lKg, v.gKg, v.kg)}</div>
      <div class="val num">${pct(v.oKg, v.kg)}% · ${peso(v.kg)}</div><div class="dsc">${esc(v.desc)}</div></div>`).join("")}</div>

    <h3>Detalle por marca</h3>
    <div class="tabs2" role="group" aria-label="Filtro de marcas">
      <button type="button" class="chip" data-fav="pend" aria-pressed="${S.filtroAv === "pend"}">Pendientes</button>
      <button type="button" class="chip" data-fav="desp" aria-pressed="${S.filtroAv === "desp"}">Con despacho</button>
      <button type="button" class="chip" data-fav="todas" aria-pressed="${S.filtroAv === "todas"}">Todas</button>
    </div>
    <div class="field" style="margin-top:10px"><input id="qAv" class="inp" type="search" placeholder="Buscar marca" value="${esc(S.qAv)}" aria-label="Buscar marca en avance" autocapitalize="characters"></div>
    <div id="avTabla"></div>`;
  pintarTablaAv();
}
function pintarTablaAv() {
  const w = $("#avTabla"); if (!w) return;
  const q = norm(S.qAv);
  let { filas } = etapas();
  if (S.filtroAv === "pend") filas = filas.filter(f => f.eo < f.x.cant);
  if (S.filtroAv === "desp") filas = filas.filter(f => f.eo > 0);
  if (q) filas = filas.filter(f => norm(f.x.m).startsWith(q));
  const filasVis = filas.slice(0, 150);
  w.innerHTML = `<div class="tblwrap"><table>
      <thead><tr><th>Marca</th><th>Total</th><th>A galv.</th><th>Volvió</th><th>En obra</th><th>Faltan</th></tr></thead>
      <tbody>${filasVis.map(f => `<tr><td class="code">${esc(marcaGuia(f.x.m))}</td><td class="num">${f.x.cant}</td><td class="num">${f.et || ""}</td><td class="num">${f.er || ""}</td><td class="num">${f.eo || ""}</td>
        <td class="num"><b>${Math.max(f.x.cant - f.eo, 0) || "✓"}</b></td></tr>`).join("")}</tbody>
    </table></div>
    ${filas.length > filasVis.length ? `<p class="small muted">Mostrando 150 de ${fmt(filas.length)}. Usa el buscador para acotar.</p>` : ""}
    ${!filas.length ? `<div class="empty">Sin marcas para este filtro.</div>` : ""}`;
}

/* --- Mi cuenta (y administración) --- */
function renderCuenta(m) {
  const yo = S.yo, n = S.cola.length;
  const perfiles = Object.values(S.perfiles).sort((a, b) => (a.activo - b.activo) || (a.nombre || "").localeCompare(b.nombre || ""));
  const o = obra();
  const pruebas = S.obras.filter(x => x.esPrueba);
  m.innerHTML = `
    <h2>Mi cuenta</h2>
    <div class="card" style="padding:12px">
      <p style="margin:0 0 4px"><b>${esc(yo.nombre || "Sin nombre")}</b> · ${esc(ROLES[yo.rol] || "")}</p>
      <p class="small muted" style="margin:0">${esc(yo.correo || "")}</p>
    </div>

    <h3>Conexión</h3>
    <div class="card" style="padding:12px">
      <p style="margin:0 0 6px">${S.red === "sin_senal" ? "Sin señal en este momento." : "En línea."} ${S.ultimaSync ? `Última actualización: ${fechaCorta(S.ultimaSync)}.` : ""}</p>
      ${n ? `<p style="margin:0 0 10px"><b>${n} movimiento${n > 1 ? "s" : ""} guardado${n > 1 ? "s" : ""} en este teléfono sin enviar.</b> Se envían solos al volver la señal.</p>
        <button class="btn block" type="button" data-reintentar>Intentar enviar ahora</button>` : `<p class="small muted" style="margin:0">No hay nada pendiente de envío.</p>`}
    </div>

    <h3>Pantalla</h3>
    <div class="seg" role="group" aria-label="Modo de pantalla" style="grid-template-columns:repeat(3,1fr)">
      ${["auto", "sol", "noche"].map(k => `<button type="button" data-modo="${k}" aria-pressed="${store.get("modo", "auto") === k}">${ETQ[k]}</button>`).join("")}
    </div>

    ${puede.admin() ? `
    <h3>Usuarios</h3>
    <p class="small muted" style="margin-top:0">Cada persona crea su cuenta desde la app (“Crear cuenta”). Aparece aquí inactiva: asígnale un rol y actívala. Para cambiar una contraseña olvidada: Supabase → Authentication → Users.</p>
    <div class="items">
      ${perfiles.map(p => `<div class="usr">
        <input class="inp" id="un-${esc(p.id)}" value="${esc(p.nombre)}" aria-label="Nombre">
        <select class="inp" id="ur-${esc(p.id)}" aria-label="Rol">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${p.rol === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        <label class="switch"><input type="checkbox" id="ua-${esc(p.id)}" ${p.activo ? "checked" : ""}> Activo</label>
        <button class="btn" type="button" data-guardar-usr="${esc(p.id)}">Guardar</button>
      </div>`).join("")}
    </div>

    <h3>Obra de prueba</h3>
    <div class="card" style="padding:12px">
      <p class="small" style="margin:0 0 10px">Crea una copia de <b>${esc(o.nombre)}</b> (mismo listado, sin movimientos) para simular despachos sin tocar los datos reales.</p>
      <button class="btn block" type="button" data-crear-prueba ${o.id && !o.esPrueba ? "" : "disabled"}>Crear obra de prueba</button>
      ${pruebas.map(p => S.confirmando === "borrar:" + p.id
        ? `<div class="confirm" style="margin-top:10px"><p>¿Borrar “${esc(p.nombre)}” y todos sus movimientos?</p><button class="btn danger" type="button" data-borrar-prueba-ok="${esc(p.id)}">Sí, borrar</button><button class="btn" type="button" data-cancel>No</button></div>`
        : `<button class="btn danger block" style="margin-top:10px" type="button" data-borrar-prueba="${esc(p.id)}">Borrar ${esc(p.nombre)}</button>`).join("")}
    </div>` : ""}

    <p style="margin-top:20px"><button class="btn block" type="button" data-salir>Cerrar sesión</button></p>
    <p class="small muted" style="text-align:center">Despachos Acuña ${esc(CFG.version || "")}</p>`;
}

/* ===== Exportar a Excel (CSV con ; y tildes) ===== */
function descargarCSV(nombre, filas) {
  const csv = "﻿" + filas.map(f => f.map(v => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function exportar(que) {
  const o = obra(), hoy = new Date().toISOString().slice(0, 10), base = norm(o.nombre).slice(0, 20);
  if (que === "movimientos") {
    const filas = [["Código", "Fecha", "Tipo", "Estado", "Nº guía", "Guía GYMSA", "Piezas", "Kg", "Chofer", "Patente", "Detalle", "Registrado por", "Recepción", "Obs. recepción", "Nota"]];
    S.despachos.filter(d => d.obraId === o.id).sort((a, b) => (a.creadoEn || "").localeCompare(b.creadoEn || "")).forEach(d => filas.push([
      d.codigo, fechaCorta(d.creadoEn), d.tipo === "retorno" ? "Entrada desde galvanizado" : (TIPOS[d.tipo] || {}).label, d.estado,
      d.guia || "", d.guiaExt || "", d.piezas, String(d.kg).replace(".", ","), d.chofer, d.patente,
      (d.items || []).map(i => `${i.q} ${marcaGuia(i.m)}`).concat((d.extras || []).map(e => `${e.q} ${e.txt}`)).join("/"),
      nombreDe(d.creadoPor), d.recepcion ? (d.recepcion.diferencias ? "Con diferencias" : "OK") : "", d.recepcion ? d.recepcion.obs : "", d.obs
    ]));
    descargarCSV(`despachos_${base}_${hoy}.csv`, filas);
  } else {
    const filas = [["Marca", "Marca guía", "Descripción", "Perfil", "Cantidad", "Kg unit.", "A galvanizado", "Volvió", "A obra", "Recibido en obra", "Faltan"]];
    etapas(o).filas.forEach(f => filas.push([f.x.m, marcaGuia(f.x.m), f.x.desc, f.x.perfil, f.x.cant, String(f.x.kgU).replace(".", ","), f.et, f.er, f.eo, f.rec, Math.max(f.x.cant - f.eo, 0)]));
    descargarCSV(`avance_${base}_${hoy}.csv`, filas);
  }
  toast("Archivo descargado. Ábrelo con Excel.");
}

/* ===== Acciones contra la base ===== */
async function rpc(fn, args) {
  const { error } = await sb.rpc(fn, args);
  if (error) throw error;
}
async function releerMov(id) {
  const { data } = await sb.from("movimientos").select("*").eq("id", id).maybeSingle();
  if (data) { const m = aMov(data), i = S.movs.findIndex(x => x.id === id); if (i >= 0) S.movs[i] = m; else S.movs.unshift(m); recomputar(); guardarCopia(); }
}
async function guardarListado(o, filas, rev) {
  const anteriores = new Set((S.marcas[o.id] || []).map(r => r.marca));
  const nuevas = new Set(filas.map(f => f.marca));
  const sacar = [...anteriores].filter(m => !nuevas.has(m));
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await sb.from("marcas").upsert(filas.slice(i, i + 500).map(f => Object.assign({ obra_id: o.id }, f)), { onConflict: "obra_id,marca" });
    if (error) throw error;
  }
  for (let i = 0; i < sacar.length; i += 100) {
    const { error } = await sb.from("marcas").delete().eq("obra_id", o.id).in("marca", sacar.slice(i, i + 100));
    if (error) throw error;
  }
  const { error } = await sb.from("obras").update({ listado_rev: rev }).eq("id", o.id);
  if (error) throw error;
  await cargarMarcas(o.id);
  return sacar;
}

/* ===== Eventos ===== */
function cambiarCant(mk, q) {
  const c = carga();
  q = Math.max(0, Math.round(q || 0));
  if (q) c.items[mk] = q; else delete c.items[mk];
  guardarCarga();
}
async function conBoton(t, fn) {
  t.disabled = true;
  try { await fn(); } catch (e) { toast(textoError(e)); } finally { if (t.isConnected) t.disabled = false; }
}
document.addEventListener("submit", async ev => {
  if (ev.target.id !== "formAcceso") return;
  ev.preventDefault();
  const correo = $("#aCorreo").value.trim(), clave = $("#aClave").value;
  const btn = ev.target.querySelector("button[type=submit]");
  if (!correo || clave.length < 8) { toast("Escribe tu correo y una contraseña de al menos 8 caracteres."); return; }
  btn.disabled = true;
  try {
    if (S.modoAcceso === "crear") {
      const nombre = $("#aNombre").value.trim();
      if (!nombre) { toast("Escribe tu nombre."); btn.disabled = false; return; }
      const { data, error } = await sb.auth.signUp({ email: correo, password: clave, options: { data: { nombre } } });
      if (error) throw error;
      if (!data.session) { pantallaAcceso("entrar", "Cuenta creada. Revisa tu correo para confirmarla y luego entra."); return; }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email: correo, password: clave });
      if (error) throw (/Invalid login/i.test(error.message) ? new Error("Correo o contraseña incorrectos.") : error);
    }
  } catch (e) { toast(textoError(e)); btn.disabled = false; }
});
document.addEventListener("click", async ev => {
  const t = ev.target.closest("button, [data-add], a");
  if (!t) return;
  const ds = t.dataset;
  if (ds.acceso) { pantallaAcceso(ds.acceso); return; }
  if (ds.revisar !== undefined) { $("#main").innerHTML = `<div class="empty">Cargando…</div>`; arrancar(); return; }
  if (ds.salir !== undefined) { await sb.auth.signOut(); store.set("copia", null); store.set("yo", null); location.reload(); return; }
  if (t.id === "cuentaBtn") { if (S.yo && S.yo.activo) { S.tab = "cuenta"; S.confirmando = null; render(); window.scrollTo(0, 0); } return; }
  if (ds.tab) { S.tab = ds.tab; S.vista = "elegir"; S.confirmando = null; S.recibiendo = null; history.replaceState(null, "", "#" + ds.tab); render(); window.scrollTo(0, 0); return; }
  if (ev.target.closest("[data-stop]") && !ds.dec) return;
  if (ds.add !== undefined && t.classList.contains("mk")) {
    cambiarCant(ds.add, (carga().items[ds.add] || 0) + 1); actualizarFila(ds.add); pedirWakeLock(); return;
  }
  if (ds.dec) { cambiarCant(ds.dec, (carga().items[ds.dec] || 0) - 1); S.vista === "revisar" ? render() : actualizarFila(ds.dec); return; }
  if (ds.inc) { cambiarCant(ds.inc, (carga().items[ds.inc] || 0) + 1); render(); return; }
  if (ds.fam !== undefined) { S.fam = ds.fam; S.limite = 80; render(); return; }
  if (ds.clear !== undefined) { S.q = ""; render(); $("#buscar").focus(); return; }
  if (ds.more !== undefined) { S.limite += 80; pintarLista(); return; }
  if (ds.go) { S.vista = ds.go; S.confirmando = null; render(); window.scrollTo(0, 0); return; }
  if (t.id === "cargoBtn") { S.vista = "revisar"; render(); window.scrollTo(0, 0); return; }
  if (t.id === "modoBtn") { ciclarModo(); return; }
  if (ds.modo) { store.set("modo", ds.modo); aplicarModo(ds.modo); render(); return; }
  if (ds.tipo) { carga().tipo = ds.tipo; guardarCarga(); render(); return; }
  if (ds.dest) {
    S.mov = ds.dest === "retorno" ? "entrada" : "salida";
    if (S.mov === "salida") { carga().tipo = ds.dest; guardarCarga(); }
    S.fam = ""; S.q = ""; S.limite = 80; S.vista = "elegir"; render(); return;
  }
  if (ds.plant) { const p = PLANTILLAS[+ds.plant]; carga().extras.push({ txt: p.txt, q: 1 }); guardarCarga(); render();
    const i = carga().extras.length - 1, el = document.getElementById("ex-t-" + i); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } return; }
  if (ds.exdel) { carga().extras.splice(+ds.exdel, 1); guardarCarga(); render(); return; }
  if (ds.enviar !== undefined) { enviar(); return; }
  if (ds.vaciar !== undefined) { S.confirmando = "vaciar"; render(); return; }
  if (ds.vaciarOk !== undefined) { const c = carga(); c.items = {}; c.extras = []; guardarCarga(); S.confirmando = null; S.vista = "elegir"; render(); toast("Carga vaciada"); return; }
  if (ds.cancel !== undefined) { S.confirmando = null; render(); return; }
  if (ds.fof) { S.filtroOf = ds.fof; render(); return; }
  if (ds.fav) { S.filtroAv = ds.fav; render(); return; }
  if (ds.reintentar !== undefined) { S.red = "conectando"; refrescar(); return; }
  if (ds.exportar) { exportar(ds.exportar); return; }
  if (ds.descartar) {
    S.cola = S.cola.filter(c => c.client_id !== ds.descartar); store.set("cola", S.cola); recomputar(); render(); toast("Movimiento descartado"); return;
  }
  if (ds.copiar) {
    const pre = document.getElementById("txt-" + ds.copiar), txt = pre.textContent;
    try { await navigator.clipboard.writeText(txt); toast("Glosa copiada. Pégala en el detalle de la guía."); }
    catch (e) { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Texto seleccionado: usa Copiar del teléfono."); }
    return;
  }
  if (ds.emitir) {
    const inp = document.getElementById("g-" + ds.emitir), nro = (inp.value || "").replace(/\D/g, "");
    if (!nro) { inp.focus(); toast("Escribe el Nº de guía antes de registrar."); return; }
    const dup = S.despachos.find(x => x.guia === nro && x.estado !== "anulada");
    if (dup) { toast(`La guía Nº ${nro} ya está registrada en ${dup.codigo}.`); return; }
    await conBoton(t, async () => { await rpc("emitir_guia", { p_id: ds.emitir, p_guia: nro }); await releerMov(ds.emitir); render(); toast(`Guía Nº ${nro} registrada`); });
    return;
  }
  if (ds.anular) { S.confirmando = "anular:" + ds.anular; S.abierto = ds.anular; render(); return; }
  if (ds.anularOk) {
    const d = S.despachos.find(x => x.id === ds.anularOk); S.confirmando = null;
    await conBoton(t, async () => { await rpc("anular_movimiento", { p_id: d.id }); await releerMov(d.id); render(); toast(`${d.codigo} anulado`); });
    return;
  }
  if (ds.recibir) { S.recibiendo = ds.recibir; S.borradorRec = null; render(); window.scrollTo(0, 0); return; }
  if (ds.recVolver !== undefined) { S.recibiendo = null; render(); return; }
  if (ds.rdec || ds.rinc) {
    const mk = ds.rdec || ds.rinc, r = S.borradorRec, d = S.despachos.find(x => x.id === S.recibiendo);
    const env = d.items.find(i => i.m === mk).q, cur = r.items[mk] ?? env;
    r.items[mk] = Math.max(0, cur + (ds.rinc ? 1 : -1)); render(); return;
  }
  if (ds.recOk) {
    const d = S.despachos.find(x => x.id === ds.recOk), r = S.borradorRec;
    r.obs = ($("#recObs") || {}).value || "";
    const diferencias = d.items.some(i => (r.items[i.m] ?? i.q) !== i.q);
    const soloDif = Object.fromEntries(Object.entries(r.items).filter(([mk, q]) => (d.items.find(i => i.m === mk) || {}).q !== q));
    await conBoton(t, async () => {
      await rpc("recibir_en_obra", { p_id: d.id, p_items: soloDif, p_obs: r.obs, p_diferencias: diferencias });
      await releerMov(d.id);
      S.recibiendo = null; S.borradorRec = null; render();
      toast(diferencias ? "Recepción guardada con diferencias. Oficina lo verá en Avance." : "Recepción confirmada");
    });
    return;
  }
  if (ds.cargarListado !== undefined) {
    const filas = leerListado($("#pegar").value);
    if (!filas.length) { $("#pegarRes").textContent = "No encontré filas de conjuntos. Copia desde la columna “Conjunto” del Excel de Tekla."; return; }
    const o = obra(), rev = $("#rev").value.trim() || "Cargado " + new Date().toLocaleDateString("es-CL");
    $("#pegarRes").textContent = `Guardando ${filas.length} marcas…`;
    await conBoton(t, async () => {
      const sacadas = await guardarListado(o, filas, rev);
      await refrescar();
      toast(`Listado guardado: ${filas.length} marcas${sacadas.length ? ` · ${sacadas.length} marcas ya no están en esta revisión` : ""}`);
    });
    return;
  }
  if (ds.guardarObra !== undefined) {
    const o = obra();
    await conBoton(t, async () => {
      const { error } = await sb.from("obras").update({ constructora: $("#oConst").value.trim().toUpperCase(), rut: $("#oRut").value.trim(),
        obra_guia: $("#oGuia").value.trim().toUpperCase(), requiere_galv: $("#oGalv").checked }).eq("id", o.id);
      if (error) throw error;
      await refrescar(); toast("Datos de la obra guardados");
    });
    return;
  }
  if (ds.nuevaObra !== undefined) {
    const nombre = $("#nNombre").value.trim();
    if (!nombre) { $("#nNombre").focus(); return; }
    await conBoton(t, async () => {
      const { data, error } = await sb.from("obras").insert({ nombre, obra_guia: nombre.toUpperCase() }).select().single();
      if (error) throw error;
      S.obraId = data.id; store.set("obraId", data.id);
      await refrescar(); S.tab = "oficina"; render(); toast("Obra creada. Ahora carga su listado y datos.");
    });
    return;
  }
  if (ds.guardarUsr) {
    const id = ds.guardarUsr;
    await conBoton(t, async () => {
      const { error } = await sb.from("perfiles").update({ nombre: $("#un-" + id).value.trim(), rol: $("#ur-" + id).value, activo: $("#ua-" + id).checked }).eq("id", id);
      if (error) throw error;
      await refrescar(); toast("Usuario actualizado");
    });
    return;
  }
  if (ds.crearPrueba !== undefined) {
    const o = obra();
    await conBoton(t, async () => {
      const { data, error } = await sb.from("obras").insert({ nombre: o.nombre + " (prueba)", constructora: o.constructora, rut: o.rut,
        obra_guia: o.obraGuia, requiere_galv: o.requiereGalv, listado_rev: o.listadoRev, es_prueba: true }).select().single();
      if (error) throw error;
      const filas = (S.marcas[o.id] || []).map(r => Object.assign({ obra_id: data.id }, r));
      for (let i = 0; i < filas.length; i += 500) {
        const r = await sb.from("marcas").insert(filas.slice(i, i + 500));
        if (r.error) throw r.error;
      }
      S.obraId = data.id; store.set("obraId", data.id);
      await refrescar(); S.tab = "despachar"; render(); toast("Obra de prueba creada. Ya puedes simular despachos.");
    });
    return;
  }
  if (ds.borrarPrueba) { S.confirmando = "borrar:" + ds.borrarPrueba; render(); return; }
  if (ds.borrarPruebaOk) {
    const id = ds.borrarPruebaOk; S.confirmando = null;
    await conBoton(t, async () => {
      await rpc("borrar_obra_prueba", { p_obra: id });
      S.cola = S.cola.filter(c => c.obra_id !== id); store.set("cola", S.cola);
      S.movs = S.movs.filter(m => m.obraId !== id); delete S.marcas[id];
      await refrescar(); render(); toast("Obra de prueba borrada");
    });
    return;
  }
});
document.addEventListener("keydown", ev => {
  const t = ev.target;
  if ((ev.key === "Enter" || ev.key === " ") && t.classList && t.classList.contains("mk")) { ev.preventDefault(); t.click(); }
  if (ev.key === "Enter" && t.id === "buscar") {
    const arr = marcasFiltradas();
    if (arr.length === 1 || (arr.length && norm(arr[0].m) === norm(S.q))) {
      const mk = arr[0].m; cambiarCant(mk, (carga().items[mk] || 0) + 1);
      S.q = ""; t.value = ""; pintarLista(); renderCargo(); toast(`${marcaGuia(mk)} agregada · ${carga().items[mk]} en carga`);
    } else if (arr.length) toast(`Hay ${arr.length} marcas que empiezan con “${S.q.toUpperCase()}”. Toca la correcta.`);
    else toast(`No existe “${S.q.toUpperCase()}” en el listado`);
  }
});
document.addEventListener("input", ev => {
  const t = ev.target, ds = t.dataset;
  if (t.id === "buscar") { S.q = t.value; S.limite = 80; clearTimeout(S.hq); S.hq = setTimeout(pintarLista, 100); return; }
  if (t.id === "qAv") { S.qAv = t.value; clearTimeout(S.hq); S.hq = setTimeout(pintarTablaAv, 150); return; }
  if (!S.obraId) return;
  const c = carga();
  if (["chofer", "patente", "obs", "destino", "guiaExt"].includes(t.id)) { c[t.id] = t.value; guardarCarga(); actualizarPrev(); return; }
  if (ds.ext !== undefined) { c.extras[+ds.ext].txt = t.value; guardarCarga(); actualizarPrev(); return; }
  if (ds.exq !== undefined) { c.extras[+ds.exq].q = Math.max(0, Math.round(+t.value || 0)); guardarCarga(); actualizarPrev(); return; }
  if (ds.rset !== undefined && S.borradorRec) { S.borradorRec.items[ds.rset] = Math.max(0, Math.round(+t.value || 0)); return; }
  if (t.id === "recObs" && S.borradorRec) { S.borradorRec.obs = t.value; return; }
});
document.addEventListener("change", ev => {
  const t = ev.target, ds = t.dataset;
  if (t.id === "soloPend") { S.soloPend = t.checked; render(); return; }
  if (t.id === "obraSel") { S.obraId = t.value; store.set("obraId", t.value); S.fam = ""; S.q = ""; S.vista = "elegir"; S.recibiendo = null;
    if (!obra().requiereGalv) S.mov = "salida"; if (S.tab === "cuenta") S.tab = INICIO[rol()]; render(); return; }
  if (ds.set !== undefined) { cambiarCant(ds.set, +t.value); S.vista === "revisar" ? render() : actualizarFila(ds.set); return; }
  if (ds.exq !== undefined || ds.rset !== undefined) { render(); return; }
});
document.addEventListener("toggle", ev => {
  const c = ev.target.closest && ev.target.closest("[data-card]");
  if (c && ev.target === c) S.abierto = c.open ? c.dataset.card : (S.abierto === c.dataset.card ? null : S.abierto);
}, true);
function actualizarPrev() {
  const p = $("#prev"); if (!p) return;
  const c = carga(), d = Object.assign({}, c, { items: Object.entries(c.items).map(([m, q]) => ({ m, q })) });
  p.textContent = textoGuia(d, obra());
}

/* ===== Modo de pantalla: Auto / Sol / Noche ===== */
const MODOS = ["auto", "sol", "noche"], ETQ = { auto: "Auto", sol: "☀ Sol", noche: "☾ Noche" };
function aplicarModo(m) {
  document.documentElement.classList.remove("m-sol", "m-noche");
  if (m !== "auto") document.documentElement.classList.add("m-" + m);
  $("#modoBtn").textContent = ETQ[m];
  const oscuro = m === "noche" || (m === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = oscuro ? "#0D0E0B" : "#FFCE00";
}
function ciclarModo() { const m = MODOS[(MODOS.indexOf(store.get("modo", "auto")) + 1) % 3]; store.set("modo", m); aplicarModo(m); if (S.tab === "cuenta") render(); }

/* Mantener la pantalla encendida mientras se carga el camión */
let wake = null;
async function pedirWakeLock() {
  if (wake || !("wakeLock" in navigator)) return;
  try { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => wake = null); } catch (e) {}
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2800);
}

/* ===== Inicio ===== */
(async function inicio() {
  aplicarModo(store.get("modo", "auto"));
  const medir = () => document.documentElement.style.setProperty("--hdr", $(".top").offsetHeight + "px");
  medir(); addEventListener("resize", medir);
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!sb) { pantallaAcceso(); return; }

  addEventListener("online", () => { S.red = "conectando"; setSync(); refrescar(); });
  addEventListener("offline", () => { S.red = "sin_senal"; setSync(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refrescar(); });
  setInterval(() => { if (S.cola.length) enviarCola(); }, 20000);

  /* No consultar la base dentro de este aviso (la librería lo bloquea): se arranca en el siguiente ciclo */
  sb.auth.onAuthStateChange((evento, sesion) => {
    if (evento === "SIGNED_IN" && sesion && (!S.sesion || S.sesion.user.id !== sesion.user.id)) { S.sesion = sesion; setTimeout(arrancar, 0); }
    if (evento === "SIGNED_OUT") { S.sesion = null; S.yo = null; pantallaAcceso(); }
  });
  let sesion = null;
  try { sesion = (await sb.auth.getSession()).data.session; } catch (e) {}
  const yoGuardado = store.get("yo", null);
  if (sesion) { S.sesion = sesion; arrancar(); }
  else if (!navigator.onLine && yoGuardado && yoGuardado.activo) {
    /* Sin señal y con la sesión vencida: se abre con la copia local; al volver la señal se valida la sesión */
    S.sesion = { user: { id: yoGuardado.id, email: yoGuardado.correo } }; S.red = "sin_senal"; arrancar();
    addEventListener("online", async () => { const s = (await sb.auth.getSession()).data.session; if (!s) pantallaAcceso("entrar", "Tu sesión venció. Entra de nuevo."); }, { once: true });
  }
  else pantallaAcceso();
})();
