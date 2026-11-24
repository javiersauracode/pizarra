/* =========================================================
   Pizarra · sincronización con Nextcloud desde el navegador (iPhone)
   ---------------------------------------------------------
   Cuando la web se sirve desde el propio Nextcloud (Raw Fileserver: https://<nube>/raw/<token>/), está en el MISMO
   dominio que WebDAV, así que puede leer y escribir la carpeta Pizarra del usuario sin CORS ni servidor propio.
   Mismo formato que la app Android (GUIA-NEXTCLOUD §5): /Pizarra/datos/<tipo>/<id>.json, un sobre por entidad,
   lápidas para los borrados, If-Match / If-None-Match y fusión a tres bandas (igual que dominio/Fusion.kt).
   Credenciales: contraseña de aplicación (Login Flow v2), guardada en este navegador.
   Lo que NO hace (lo hace la app Android): buzón, copias diarias, purga de lápidas, métricas compartidas, CalDAV.
   ========================================================= */
(function (raiz) {
  'use strict';
  const M = raiz.PizarraModelo;
  if (!M) return;
  const CFG = 'pizarra.nube', ENT = 'pizarra.nube.ent';
  const TIPOS = ['perfiles', 'publicaciones', 'proyectos', 'tareas', 'biblioteca', 'macros', 'pesadas', 'pasos', 'ajustes'];
  const enNextcloud = /^\/(index\.php\/)?raw\//.test(location.pathname) || /[?&]nube=1\b/.test(location.search);
  const leer = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const escribir = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let cfg = leer(CFG);                       // {server, user, nombre, pass, dev, at}
  let ent = leer(ENT) || {e:{}, carpetas:{}}; // e["tipo/id"] = {etag, base: canon de lo último sincronizado}
  let hooks = null, ocupado = false, otraVez = false, temporizador = null, error = '', login = null;

  /* ---------- JSON canónico (claves ordenadas) para comparar sin depender del orden ---------- */
  function canon(v){
    if (v === undefined) v = null;
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }

  /* ---------- Fusión a tres bandas (copia de Fusion.kt) ---------- */
  const AUS = {}; // la clave no existe
  const igual = (a, b) => a === b || (a !== AUS && b !== AUS && canon(a) === canon(b));
  const esObj = x => x && typeof x === 'object' && !Array.isArray(x) && x !== AUS;
  function fusionar(b, l, r){
    if (igual(l, r)) return l;
    if (igual(b, l)) return r;
    if (igual(b, r)) return l;
    if (l === AUS) return r;           // borrado aquí y editado allí: gana la edición
    if (r === AUS) return l;
    if (esObj(l) && esObj(r)){
      const out = {}, bb = esObj(b) ? b : null;
      for (const k of new Set([...Object.keys(l), ...Object.keys(r)])){
        const v = fusionar(bb && k in bb ? bb[k] : AUS, k in l ? l[k] : AUS, k in r ? r[k] : AUS);
        if (v !== AUS) out[k] = v;
      }
      return out;
    }
    if (Array.isArray(l) && Array.isArray(r)){
      const bb = Array.isArray(b) ? b : [], todos = [...l, ...r, ...bb];
      if (todos.every(x => !x || typeof x !== 'object')){       // listas simples: altas y bajas de cada lado
        const sb = new Set(bb.map(canon)), sl = new Set(l.map(canon)), sr = new Set(r.map(canon)), vistos = new Set(), out = [];
        for (const x of [...l, ...r]){
          const s = canon(x);
          if (vistos.has(s)) continue; vistos.add(s);
          if (sb.has(s) && (!sl.has(s) || !sr.has(s))) continue;
          out.push(x);
        }
        const ordenada = l.every(x => typeof x === 'string') && l.every((x, i) => !i || l[i - 1] <= x);
        return ordenada && out.every(x => typeof x === 'string') ? out.sort() : out;
      }
      if (todos.every(esObj)){                                   // listas de objetos con id / t / k: elemento a elemento
        const clave = o => o.id != null ? 'i' + canon(o.id) : o.t != null ? 't' + canon(o.t) : o.k != null ? 'k' + canon(o.k) : 'j' + canon(o);
        const mb = new Map(bb.map(x => [clave(x), x])), ml = new Map(l.map(x => [clave(x), x])), mr = new Map(r.map(x => [clave(x), x]));
        const vistos = new Set(), out = [];
        for (const x of [...l, ...r]){
          const k = clave(x);
          if (vistos.has(k)) continue; vistos.add(k);
          const v = fusionar(mb.has(k) ? mb.get(k) : AUS, ml.has(k) ? ml.get(k) : AUS, mr.has(k) ? mr.get(k) : AUS);
          if (v !== AUS) out.push(v);
        }
        return out;
      }
    }
    return l; // el mismo campo cambiado distinto en los dos lados: gana este dispositivo
  }

  /* ---------- WebDAV ---------- */
  const b64 = s => btoa(unescape(encodeURIComponent(s)));
  const auth = () => 'Basic ' + b64(cfg.user + ':' + cfg.pass);
  const raizDav = () => cfg.server + '/remote.php/dav/files/' + encodeURIComponent(cfg.user) + '/Pizarra';
  async function dav(metodo, ruta, opts = {}){
    const r = await fetch(raizDav() + ruta, {method:metodo, credentials:'omit', cache:'no-store', body:opts.body,
      headers:Object.assign({Authorization:auth()}, opts.headers || {})});
    if (r.status === 401) throw Object.assign(new Error('Nextcloud ha rechazado la contraseña de aplicación: vuelve a conectar la cuenta'), {auth:true});
    return r;
  }
  const PROPFIND = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>';
  async function listar(ruta){
    const r = await dav('PROPFIND', ruta, {body:PROPFIND, headers:{Depth:'1', 'Content-Type':'application/xml'}});
    if (r.status === 404) return null;
    if (r.status !== 207) throw new Error('Nextcloud respondió ' + r.status + ' al listar ' + ruta);
    const doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
    const NS = 'DAV:', out = [];
    for (const resp of Array.from(doc.getElementsByTagNameNS(NS, 'response'))){
      const href = (resp.getElementsByTagNameNS(NS, 'href')[0] || {}).textContent || '';
      const partes = href.replace(/\/+$/, '').split('/');
      const nombre = decodeURIComponent(partes[partes.length - 1] || '');
      const etag = ((resp.getElementsByTagNameNS(NS, 'getetag')[0] || {}).textContent || '').trim();
      const dir = resp.getElementsByTagNameNS(NS, 'collection').length > 0;
      out.push({href, nombre, etag, dir});
    }
    return out.slice(1); // la primera respuesta es la propia carpeta
  }
  const etagDe = r => r.headers.get('OC-ETag') || r.headers.get('ETag') || '';
  function idDeArchivo(n){
    if (!n.endsWith('.json')) return null;
    const b = n.slice(0, -5);
    if (!b.startsWith('~')) return b;
    try { return decodeURIComponent(escape(atob(b.slice(1).replace(/-/g, '+').replace(/_/g, '/')))); } catch (e) { return null; }
  }
  async function estructura(){
    if (ent.estructura) return;
    for (const ruta of ['', '/datos', ...TIPOS.map(t => '/datos/' + t)]){
      const r = await dav('MKCOL', ruta + '/');
      if (!r.ok && r.status !== 405) throw new Error('No se pudo crear la carpeta Pizarra' + ruta + ' (' + r.status + ')');
    }
    await dav('PUT', '/esquema.json', {body:JSON.stringify({esquema:M.ESQUEMA, app:'Pizarra'}), headers:{'If-None-Match':'*', 'Content-Type':'application/json'}});
    ent.estructura = true; guardarEnt();
  }
  const guardarEnt = () => escribir(ENT, ent);

  /* ---------- Aplicar lo remoto a la copia de trabajo ---------- */
  // cur: Map("tipo/id" → datos) de los datos actuales. Devuelve true si cambió algo aquí.
  function aplicar(cur, k, remoto, etag){
    const e = ent.e[k], local = cur.has(k) ? cur.get(k) : null;
    const sinCambiosAqui = e ? canon(local) === e.base : local == null;
    let nuevo;
    if (sinCambiosAqui) nuevo = remoto;
    else {
      const base = e ? JSON.parse(e.base) : null;
      const v = fusionar(base == null ? AUS : base, local == null ? AUS : local, remoto == null ? AUS : remoto);
      nuevo = v === AUS ? null : v;
    }
    ent.e[k] = {etag, base:canon(remoto)};
    if (canon(nuevo) === canon(local)) return false;
    if (nuevo == null) cur.delete(k); else cur.set(k, nuevo);
    return true;
  }
  function adoptar(cur){
    const lista = [];
    for (const [k, datos] of cur){ const i = k.indexOf('/'); lista.push({tipo:k.slice(0, i), id:k.slice(i + 1), datos}); }
    hooks.adoptar(M.ensamblar(lista));
  }

  /* ---------- Bajar: solo las carpetas y archivos cuyo ETag cambió ---------- */
  async function bajar(){
    if (hooks.puedeAdoptar && !hooks.puedeAdoptar()) return;
    const arriba = await listar('/datos/');
    if (!arriba) { ent.estructura = false; await estructura(); return; }
    const llegados = [], desaparecidos = [], carpetas = {};
    for (const c of arriba){
      if (!c.dir || !TIPOS.includes(c.nombre)) continue;
      if (ent.carpetas[c.nombre] === c.etag) continue;
      const archivos = await listar('/datos/' + c.nombre + '/') || [];
      const vistos = new Set();
      for (const f of archivos){
        if (f.dir) continue;
        const id = idDeArchivo(f.nombre); if (id == null) continue;
        const k = c.nombre + '/' + id; vistos.add(k);
        if (ent.e[k] && ent.e[k].etag === f.etag && f.etag) continue;
        const r = await dav('GET', '/datos/' + c.nombre + '/' + encodeURIComponent(f.nombre));
        if (!r.ok) continue;
        let s; try { s = await r.json(); } catch (e) { continue; }
        if ((s.esquema || 1) > M.ESQUEMA) throw new Error('Datos de una versión más nueva de Pizarra');
        llegados.push({k, remoto:s.borrado ? null : s.datos, etag:etagDe(r) || f.etag});
      }
      for (const k of Object.keys(ent.e)) if (k.startsWith(c.nombre + '/') && !vistos.has(k)) desaparecidos.push(k);
      carpetas[c.nombre] = c.etag;
    }
    if (!llegados.length && !desaparecidos.length){ Object.assign(ent.carpetas, carpetas); guardarEnt(); return; }
    if (hooks.puedeAdoptar && !hooks.puedeAdoptar()) return; // ficha abierta: se aplica al cerrarla (la web pide otra pasada)
    // Todo lo que sigue es síncrono: se parte de los datos de este momento (aunque se editara mientras se descargaba)
    let cur = M.trocear(hooks.obtener());
    if (ent.primera){
      const hay = llegados.some(x => x.remoto != null);
      if (hay){ cur = new Map(); ent.e = {}; } // primera conexión: mandan los datos de Nextcloud
      delete ent.primera;
    }
    let cambio = false;
    for (const x of llegados) cambio = aplicar(cur, x.k, x.remoto, x.etag) || cambio;
    for (const k of desaparecidos){
      const e = ent.e[k], local = cur.has(k) ? cur.get(k) : null;
      if (canon(local) === e.base && local != null){ cur.delete(k); cambio = true; }
      delete ent.e[k];
    }
    Object.assign(ent.carpetas, carpetas); guardarEnt();
    if (cambio) adoptar(cur);
  }

  /* ---------- Subir: cada entidad que cambió desde la última sincronización ---------- */
  function pendientes(){
    if (!cfg || !hooks) return [];
    const cur = M.trocear(hooks.obtener()), out = [];
    for (const [k, v] of cur){ const c = canon(v), e = ent.e[k]; if (!e || e.base !== c) out.push({k, v, c}); }
    for (const k of Object.keys(ent.e)) if (!cur.has(k) && ent.e[k].base !== 'null') out.push({k, v:null, c:'null'});
    return out;
  }
  async function subir(){
    for (const p of pendientes()){
      const i = p.k.indexOf('/'), tipo = p.k.slice(0, i), id = p.k.slice(i + 1), e = ent.e[p.k];
      const sobre = {esquema:M.ESQUEMA, tipo, id, upd:Date.now(), dev:cfg.dev, borrado:p.v == null, datos:p.v == null ? null : p.v};
      const ruta = '/datos/' + tipo + '/' + encodeURIComponent(M.archivo(id));
      const cab = {'Content-Type':'application/json'};
      if (e && e.etag) cab['If-Match'] = e.etag; else cab['If-None-Match'] = '*';
      let r = await dav('PUT', ruta, {body:JSON.stringify(sobre), headers:cab});
      if (r.status === 404 || r.status === 409){ await dav('MKCOL', '/datos/' + tipo + '/'); r = await dav('PUT', ruta, {body:JSON.stringify(sobre), headers:cab}); }
      if (r.ok){ ent.e[p.k] = {etag:etagDe(r), base:p.c}; guardarEnt(); continue; }
      if (r.status === 412){ // otro dispositivo lo cambió: se baja, se fusiona y se vuelve a subir en la siguiente vuelta
        const g = await dav('GET', ruta);
        if (g.ok){
          const s = await g.json();
          if (hooks.puedeAdoptar && !hooks.puedeAdoptar()) continue; // se reintenta en la siguiente pasada
          const cur = M.trocear(hooks.obtener());
          if (aplicar(cur, p.k, s.borrado ? null : s.datos, etagDe(g))) adoptar(cur);
          guardarEnt(); otraVez = true;
        } else if (g.status === 404){ delete ent.e[p.k]; guardarEnt(); otraVez = true; }
        continue;
      }
      throw new Error('Nextcloud respondió ' + r.status + ' al guardar ' + p.k);
    }
  }

  /* ---------- Una pasada ---------- */
  async function sincronizar(){
    if (!cfg || !hooks) return;
    if (ocupado){ otraVez = true; return; }
    ocupado = true; otraVez = false; avisar();
    try {
      await estructura();
      await bajar();
      if (!ent.primera) await subir();
      error = ''; cfg.at = Date.now(); escribir(CFG, cfg);
    } catch (e) {
      error = e && e.message === 'Failed to fetch' ? 'Sin conexión: los cambios se guardan aquí y se enviarán solos' : (e && e.message) || String(e);
    } finally {
      ocupado = false; avisar();
      if (otraVez && !error) programar(1500);
    }
  }
  function programar(ms = 3000){ if (!cfg) return; clearTimeout(temporizador); temporizador = setTimeout(sincronizar, ms); }
  const avisar = () => { try { hooks && hooks.estado && hooks.estado(); } catch (e) {} };

  /* ---------- Cuenta: Login Flow v2 (misma web de Nextcloud, mismo dominio) ---------- */
  async function iniciarLogin(){
    const r = await fetch(location.origin + '/index.php/login/v2', {method:'POST', credentials:'omit'});
    if (!r.ok) throw new Error('Nextcloud no ha iniciado el acceso (' + r.status + ')');
    const j = await r.json();
    login = {url:j.login, token:j.poll.token, endpoint:j.poll.endpoint, hasta:Date.now() + 20 * 60e3};
    esperarLogin(); avisar();
    return login.url;
  }
  async function esperarLogin(){
    while (login && Date.now() < login.hasta){
      await new Promise(res => setTimeout(res, 2000));
      if (!login) return;
      if (document.visibilityState !== 'visible') continue;
      try {
        const r = await fetch(login.endpoint, {method:'POST', credentials:'omit', body:new URLSearchParams({token:login.token})});
        if (r.status === 200){ const j = await r.json(); login = null; await guardarCuenta(j.loginName, j.appPassword); return; }
      } catch (e) {}
    }
    login = null; avisar();
  }
  async function guardarCuenta(usuario, pass){
    // El id real del usuario (la ruta de WebDAV) puede no coincidir con lo escrito al entrar (correo, inicio de sesión externo…)
    const r = await fetch(location.origin + '/ocs/v2.php/cloud/user?format=json', {credentials:'omit', cache:'no-store',
      headers:{Authorization:'Basic ' + b64(usuario + ':' + pass), 'OCS-APIRequest':'true', Accept:'application/json'}});
    if (!r.ok) throw new Error(r.status === 401 ? 'Usuario o contraseña de aplicación incorrectos' : 'Nextcloud respondió ' + r.status);
    const d = (await r.json()).ocs.data;
    const dev = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
    cfg = {server:location.origin, user:d.id, nombre:d.displayname || d['display-name'] || d.id, pass, dev, at:0};
    ent = {e:{}, carpetas:{}, primera:true};
    escribir(CFG, cfg); guardarEnt(); error = '';
    avisar();
    await sincronizar();
  }
  async function desconectar(){
    if (cfg){ try { await fetch(location.origin + '/ocs/v2.php/core/apppassword', {method:'DELETE', credentials:'omit', headers:{Authorization:auth(), 'OCS-APIRequest':'true'}}); } catch (e) {} }
    cfg = null; ent = {e:{}, carpetas:{}}; escribir(CFG, null); escribir(ENT, null); error = ''; login = null; avisar();
  }

  function estado(){
    return {disponible:enNextcloud || !!cfg, enNextcloud, conectado:!!cfg, usuario:cfg && cfg.user, nombre:cfg && cfg.nombre,
      at:cfg && cfg.at, error, ocupado, pendientes:cfg && !ent.primera ? pendientes().length : 0, login:login && login.url, primera:!!ent.primera};
  }

  function init(h){
    hooks = h;
    document.addEventListener('visibilitychange', () => { if (cfg && document.visibilityState === 'visible') programar(300); });
    setInterval(() => { if (cfg && document.visibilityState === 'visible') sincronizar(); }, 60e3);
    if (cfg) sincronizar();
  }

  raiz.PizarraNube = {enNextcloud, init, estado, sincronizar, programar, iniciarLogin, guardarCuenta, desconectar,
    cancelarLogin(){ login = null; avisar(); }, conectado:() => !!cfg, _fusionar:fusionar, _canon:canon};
})(typeof globalThis !== 'undefined' ? globalThis : this);
