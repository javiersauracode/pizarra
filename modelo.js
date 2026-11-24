/* =========================================================
   Pizarra · modelo de almacenamiento en Nextcloud
   ---------------------------------------------------------
   Reparte los datos de la app (el objeto S de index.html) en entidades independientes, cada una con un id estable,
   y vuelve a montarlas. Es la ÚNICA definición del reparto: la usan la web (dentro de la app Android) y las
   herramientas del ordenador (bajar-copia, migrar-a-nextcloud, enviar-hoja). En Nextcloud cada entidad es un archivo:
       Pizarra/datos/<tipo>/<id>.json
   Tipos:
       perfiles/<id>        S.profiles[]
       publicaciones/<id>   S.contents[]
       proyectos/<id>       S.projects[]  (con su hoja de ruta, hábitos y marcas)
       tareas/<id>          S.tasks[]
       biblioteca/<id>      S.library[]   (Mis hojas)
       macros/<id>          S.health.macros[]
       pesadas/<AAAA-MM>    S.health.weight[] de ese mes  → {items:[…]}
       pasos/<AAAA-MM>      S.health.steps[] de ese mes   → {items:[{d:'AAAA-MM-DD', n, src:'hc'|'salud'|'manual'}]}
       nutricion/<AAAA-MM>  S.health.nutri[] de ese mes   → {items:[{d, kcal, p, c, g, fib, bmr, burned, ok, op, oc, og, src}]}
                            (ingesta, gasto y objetivo de cada día, de SparkyFitness)
       ajustes/<clave>      cualquier otra clave de S      → {valor: …}
         ajustes/health       el resto de S.health (objetivo, pesadas borradas, vista…)
         ajustes/orden        el orden de cada lista (perfiles, proyectos…) → {valor:{profiles:[ids], …}}
         ajustes/sinid-<k>    elementos sin id (no debería haber; así no se pierden)
   Lo que es de cada dispositivo (S.ui: vista, pestaña…; S.device) no se guarda en Nextcloud.
   ========================================================= */
(function (raiz) {
  'use strict';
  const COLECCIONES = {profiles:'perfiles', contents:'publicaciones', projects:'proyectos', tasks:'tareas', library:'biblioteca'};
  const LOCALES = new Set(['ui', 'device']);

  /** S → Map("tipo/id" → datos). Los valores son los mismos objetos de S (no copias). */
  function trocear(S){
    const m = new Map(), orden = {};
    for (const [k, tipo] of Object.entries(COLECCIONES)){
      orden[k] = []; const sinId = [];
      for (const x of (Array.isArray(S[k]) ? S[k] : [])){
        if (x && x.id != null && x.id !== '' && !m.has(tipo + '/' + x.id)){ m.set(tipo + '/' + x.id, x); orden[k].push(String(x.id)); }
        else sinId.push(x);
      }
      if (sinId.length) m.set('ajustes/sinid-' + k, {valor:sinId});
    }
    const H = S.health && typeof S.health === 'object' ? S.health : null;
    if (H){
      orden.macros = []; const sinIdM = [];
      for (const x of (Array.isArray(H.macros) ? H.macros : [])){
        if (x && x.id != null && x.id !== '' && !m.has('macros/' + x.id)){ m.set('macros/' + x.id, x); orden.macros.push(String(x.id)); }
        else sinIdM.push(x);
      }
      if (sinIdM.length) m.set('ajustes/sinid-macros', {valor:sinIdM});
      const meses = {};
      for (const w of (Array.isArray(H.weight) ? H.weight : [])){
        if (!w || typeof w.t !== 'string' || w.t.length < 7) continue;
        (meses[w.t.slice(0, 7)] = meses[w.t.slice(0, 7)] || []).push(w);
      }
      for (const mes of Object.keys(meses).sort()) m.set('pesadas/' + mes, {items:meses[mes].slice().sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0)});
      const mesesP = {};
      for (const s of (Array.isArray(H.steps) ? H.steps : [])){
        if (!s || typeof s.d !== 'string' || s.d.length < 10) continue;
        (mesesP[s.d.slice(0, 7)] = mesesP[s.d.slice(0, 7)] || []).push(s);
      }
      for (const mes of Object.keys(mesesP).sort()) m.set('pasos/' + mes, {items:mesesP[mes].slice().sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0)});
      const mesesN = {};
      for (const s of (Array.isArray(H.nutri) ? H.nutri : [])){
        if (!s || typeof s.d !== 'string' || s.d.length < 10) continue;
        (mesesN[s.d.slice(0, 7)] = mesesN[s.d.slice(0, 7)] || []).push(s);
      }
      for (const mes of Object.keys(mesesN).sort()) m.set('nutricion/' + mes, {items:mesesN[mes].slice().sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0)});
      const resto = {}; for (const k of Object.keys(H)) if (k !== 'weight' && k !== 'macros' && k !== 'steps' && k !== 'nutri') resto[k] = H[k];
      m.set('ajustes/health', {valor:resto});
    }
    for (const k of Object.keys(S)){
      if (COLECCIONES[k] || k === 'health' || LOCALES.has(k) || S[k] === undefined) continue;
      m.set('ajustes/' + k, {valor:S[k]});
    }
    m.set('ajustes/orden', {valor:orden});
    return m;
  }

  /** [{tipo,id,datos}] → S (sin ui ni device). Siempre devuelve las listas, aunque estén vacías. */
  function ensamblar(lista){
    const por = {};
    for (const e of lista || []){ if (e && e.tipo && e.datos != null) (por[e.tipo] = por[e.tipo] || []).push(e); }
    const ajuste = id => { const e = (por.ajustes || []).find(x => x.id === id); return e && e.datos ? e.datos.valor : undefined; };
    const orden = ajuste('orden') || {};
    const ordenar = (tipo, clave) => {
      const idx = new Map((orden[clave] || []).map((id, i) => [String(id), i]));
      return (por[tipo] || []).slice().sort((a, b) => {
        const ia = idx.has(String(a.id)) ? idx.get(String(a.id)) : Infinity, ib = idx.has(String(b.id)) ? idx.get(String(b.id)) : Infinity;
        return ia !== ib ? ia - ib : String(a.id) < String(b.id) ? -1 : 1;
      }).map(e => e.datos);
    };
    const S = {};
    for (const [k, tipo] of Object.entries(COLECCIONES)){
      S[k] = ordenar(tipo, k);
      const sin = ajuste('sinid-' + k); if (Array.isArray(sin)) S[k].push(...sin);
    }
    const resto = ajuste('health');
    const pesos = (por.pesadas || []).slice().sort((a, b) => a.id < b.id ? -1 : 1).flatMap(e => (e.datos && Array.isArray(e.datos.items)) ? e.datos.items : [])
      .sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
    const pasos = (por.pasos || []).slice().sort((a, b) => a.id < b.id ? -1 : 1).flatMap(e => (e.datos && Array.isArray(e.datos.items)) ? e.datos.items : [])
      .sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    const nutri = (por.nutricion || []).slice().sort((a, b) => a.id < b.id ? -1 : 1).flatMap(e => (e.datos && Array.isArray(e.datos.items)) ? e.datos.items : [])
      .sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    const macros = ordenar('macros', 'macros'); const sinM = ajuste('sinid-macros'); if (Array.isArray(sinM)) macros.push(...sinM);
    if (resto !== undefined || pesos.length || macros.length || pasos.length || nutri.length)
      S.health = Object.assign({}, resto || {}, {weight:pesos, macros}, pasos.length ? {steps:pasos} : {}, nutri.length ? {nutri} : {});
    for (const e of por.ajustes || []){
      if (e.id === 'orden' || e.id === 'health' || e.id.startsWith('sinid-')) continue;
      S[e.id] = e.datos.valor;
    }
    return S;
  }

  /** Huella de cada entidad (para saber qué ha cambiado desde la última vez). */
  function huellas(mapa){ const h = new Map(); for (const [k, v] of mapa) h.set(k, JSON.stringify(v)); return h; }

  /** Nombre de archivo para un id (igual que Rutas.archivo en la app Android). */
  function archivo(id){
    id = String(id);
    if (/^[A-Za-z0-9._-]{1,120}$/.test(id) && !id.startsWith('~')) return id + '.json';
    const b64 = typeof Buffer !== 'undefined' ? Buffer.from(id, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(id)));
    return '~' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.json';
  }

  const api = {COLECCIONES, trocear, ensamblar, huellas, archivo, ESQUEMA:1};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  raiz.PizarraModelo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
