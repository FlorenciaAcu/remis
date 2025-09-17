// ============ CONFIG ============
const CONFIG = {
  SPREADSHEET_ID: '1JJ4XmL9UAO8PkdS3C3fjYIIfnHNtlKZ4jcW2sJMuDJk',
  SHEET_NAME: 'SaldoMts',   // nombre de la pestaña
  // Opcional: si preferís CSV, poné el gid y cambiá USE_GVIZ=false
  SHEET_GID: null,
  USE_GVIZ: true,           // usa /gviz/tq (recomendado). Si falla, intenta CSV.
  LOGO_URL: 'https://www.juangas.com.ar/img/logo.png'
};

// ============ HELPERS ============
const $ = sel => document.querySelector(sel);
const canon = s => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

const numAR = s => {
  if (typeof s === 'number') return s;
  const t = String(s ?? '').trim();
  if (!t) return NaN;
  const n = Number(t.replace(/\./g,'').replace(/,/g,'.'));
  return isNaN(n) ? NaN : n;
};
const fmtAR = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n);

// Busca índices de columnas tolerante a nombres distintos
function mapIndexes(headers) {
  const H = headers.map(canon);
  const find = (...aliases) => {
    const A = aliases.map(canon);
    for (let i=0;i<H.length;i++){
      if (A.includes(H[i]) || A.some(a => H[i].includes(a))) return i;
    }
    return -1;
  };
  return {
    iCliente: find('cliente','patente'),
    iSaldo:   find('saldo'),
    iSuma:    find('sumadecantidad','sumadesumadecantidad','cantidad'),
    iPremio:  find('sumadecantmetropremio','sumadesumadecantmetropremio','metropremio','premio'),
  };
}

// ============ FETCH SHEET ============
let SHEET_CACHE = null;
async function fetchSheet() {
  if (SHEET_CACHE) return SHEET_CACHE;

  const base = `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}`;
  let lastModified = null;

  // 1) GViz
  if (CONFIG.USE_GVIZ) {
    const url = `${base}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(CONFIG.SHEET_NAME)}`;
    const res = await fetch(url, { cache: 'no-store' });
    lastModified = res.headers.get('Last-Modified');
    const txt = await res.text();
    // Respuesta es: google.visualization.Query.setResponse({...});
    const json = JSON.parse(txt.replace(/^[^{]+/, '').replace(/;?\s*$/, ''));
    const table = json.table;
    const headers = table.cols.map(c => c.label || '');
    const rows = table.rows.map(r => r.c.map(c => (c ? c.v : '')));
    SHEET_CACHE = { headers, rows, lastModified };
    return SHEET_CACHE;
  }

  // 2) CSV (fallback)
  const gid = CONFIG.SHEET_GID;
  if (!gid) throw new Error('Falta SHEET_GID para usar CSV.');
  const url = `${base}/export?format=csv&gid=${gid}`;
  const res = await fetch(url, { cache: 'no-store' });
  lastModified = res.headers.get('Last-Modified');
  const csv = await res.text();
  const rows = parseCsv(csv);
  const headers = rows.shift() || [];
  SHEET_CACHE = { headers, rows, lastModified };
  return SHEET_CACHE;
}

// CSV simple (comillas soportadas)
function parseCsv(text){
  const out = [];
  let row = [], cur = '', inQ = false;
  for (let i=0;i<text.length;i++){
    const ch = text[i], nx = text[i+1];
    if (inQ) {
      if (ch === '"' && nx === '"'){ cur += '"'; i++; }
      else if (ch === '"'){ inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ','){ row.push(cur); cur = ''; }
      else if (ch === '\n'){ row.push(cur); out.push(row); row = []; cur=''; }
      else if (ch === '\r'){ /* ignore */ }
      else cur += ch;
    }
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out;
}

// ============ UI / LÓGICA ============
async function consultar(patenteRaw){
  const alertBox = $('#alert');
  const block = $('#resultBlock');
  const title = $('#resTitle');
  const saldoBig = $('#saldoBig');
  const last = $('#lastUpd');

  alertBox.hidden = true;
  block.hidden = true;

  try{
    const { headers, rows, lastModified } = await fetchSheet();
    const idx = mapIndexes(headers);

    if (idx.iCliente < 0 || (idx.iSaldo < 0 && (idx.iSuma < 0 || idx.iPremio < 0))){
      throw new Error('No encuentro columnas necesarias. Necesito Cliente/Patente y (Saldo o Cantidad + Metro/Premio).');
    }

    const patCanon = canon(patenteRaw);
    const row = rows.find(r => canon(r[idx.iCliente]) === patCanon);

    if (!row){
      alertBox.textContent = `No encontramos registros para la patente “${patenteRaw}”. Verificá que esté sin espacios y tal como figura en tu vehículo.`;
      alertBox.hidden = false;
      return;
    }

    let saldo = (idx.iSaldo >= 0) ? numAR(row[idx.iSaldo]) : NaN;
    if (!(isFinite(saldo))){
      const suma   = numAR(row[idx.iSuma]);
      const premio = numAR(row[idx.iPremio]);
      saldo = (isNaN(suma) ? 0 : suma) - (isNaN(premio) ? 0 : premio);
    }

    title.textContent = `Saldo de la patente: ${patenteRaw.toUpperCase()}`;
    saldoBig.textContent = fmtAR(saldo);

    if (lastModified){
      const d = new Date(lastModified);
      last.textContent = `*Última actualización: ${d.toLocaleDateString('es-AR')} ${d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}`;
      last.hidden = false;
    } else {
      last.hidden = true;
    }

    block.hidden = false;

  }catch(err){
    alertBox.textContent = err.message || String(err);
    alertBox.hidden = false;
  }
}

function syncUI(){
  const inp = $('#patente');
  const btn = $('#btnConsultar');
  if (!inp || !btn) return;
  inp.value = inp.value.toUpperCase().replace(/\s+/g,'');
  btn.disabled = (inp.value.trim() === '');
}

function setYear(){ $('#year').textContent = new Date().getFullYear(); }

window.addEventListener('DOMContentLoaded', () => {
  setYear();

  // Normalización + deshabilitar botón si está vacío
  const inp = $('#patente');
  const btn = $('#btnConsultar');
  const form = $('#formConsulta');

  // Rellenar con la query si viene
  const q = new URLSearchParams(location.search);
  const p = (q.get('patente') || '').toUpperCase();
  if (p) inp.value = p;

  syncUI();
  inp.addEventListener('input', () => {
    syncUI();
    // Ocultar resultados si borran
    if (!inp.value.trim()){
      $('#resultBlock').hidden = true;
      $('#alert').hidden = true;
      // limpiar URL
      const url = new URL(location.href);
      url.searchParams.delete('patente');
      history.replaceState({}, '', url.pathname);
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const patente = inp.value.trim().toUpperCase();
    if (!patente) return;
    btn.disabled = true;
    btn.textContent = 'Consultando…';

    // Actualizo la URL (?patente=)
    const url = new URL(location.href);
    url.searchParams.set('patente', patente);
    history.replaceState({}, '', `${url.pathname}?${url.searchParams}`);

    await consultar(patente);

    btn.disabled = false;
    btn.textContent = 'Consultar';
  });

  // Si vino con ?patente=, consultá
  if (p) consultar(p);
});
