// ============ CONFIG ============
const CONFIG = {
  SPREADSHEET_ID: "1JJ4XmL9UAO8PkdS3C3fjYIIfnHNtlKZ4jcW2sJMuDJk",
  SHEET_NAME: "SaldoMts", // nombre de la pestaña
  SHEET_GID: null, // poné el gid si querés habilitar el fallback CSV
  USE_GVIZ: true, // usa /gviz/tq (recomendado)
};

// ============ HELPERS ============
const $ = (sel) => document.querySelector(sel);

const canon = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const numAR = (s) => {
  if (typeof s === "number") return s;
  const t = String(s ?? "").trim();
  if (!t) return NaN;
  const n = Number(t.replace(/\./g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : NaN;
};

const fmtAR = (n) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);

function mapIndexes(headers) {
  const H = headers.map(canon);
  const find = (...aliases) => {
    const A = aliases.map(canon);
    for (let i = 0; i < H.length; i++) {
      if (A.includes(H[i]) || A.some((a) => H[i].includes(a))) return i;
    }
    return -1;
  };
  return {
    iCliente: find("cliente", "patente"),
    iSaldo: find("saldo"),
    iSuma: find(
      "sumadecantidad",
      "suma de cantidad",
      "sumadesumadecantidad",
      "cantidad"
    ),
    iPremio: find(
      "sumadecantmetropremio",
      "suma de cantmetropremio",
      "sumadesumadecantmetropremio",
      "metropremio",
      "premio"
    ),
  };
}

// ============ GVIZ: URL builders y parser ============
function gvizUrlSelect(patente) {
  // select A(cliente), D(saldo), B(cantidad), C(premio)
  const tq = `
    select A,D,B,C
    where lower(A) = lower('${String(patente).replace(/'/g, "\\'")}')
    limit 1
  `
    .replace(/\s+/g, " ")
    .trim();

  const base = `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}/gviz/tq`;
  const params = new URLSearchParams({
    tqx: "out:json",
    tq,
    sheet: CONFIG.SHEET_NAME,
  });
  return `${base}?${params.toString()}`;
}

function gvizUrlFull() {
  const base = `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}/gviz/tq`;
  const params = new URLSearchParams({
    tqx: "out:json",
    sheet: CONFIG.SHEET_NAME,
  });
  return `${base}?${params.toString()}`;
}

function extractGVizJSON(txt) {
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    if (/Sign in|Inicia sesi[oó]n|google\.com\/a\/|<html/i.test(txt)) {
      throw new Error(
        "No se pudo leer la hoja. Verificá que el documento sea público o esté publicado."
      );
    }
    throw new Error("Respuesta GViz inválida (no se encontró JSON interno).");
  }
  return JSON.parse(txt.slice(start, end + 1));
}

// ============ LECTURA DE SALDO ============
async function fetchSaldoByGViz(patente) {
  const res = await fetch(gvizUrlSelect(patente), { cache: "no-store" });
  const txt = await res.text();

  const json = extractGVizJSON(txt);
  const rows = json.table?.rows ?? [];
  if (!rows.length) return null;

  // select A,D,B,C -> c[0]=cliente, c[1]=saldo, c[2]=cantidad, c[3]=premio
  const c = rows[0].c;
  const cliente = c[0]?.v ?? "";
  const saldoCell = c[1]?.v;
  const cantCell = c[2]?.v;
  const premCell = c[3]?.v;

  let saldo = numAR(saldoCell);
  if (!Number.isFinite(saldo)) {
    const cant = numAR(cantCell);
    const prem = numAR(premCell);
    saldo = (isNaN(cant) ? 0 : cant) - (isNaN(prem) ? 0 : prem);
  }

  return { cliente, saldo };
}

async function fetchSaldoByGVizFull(patente) {
  const res = await fetch(gvizUrlFull(), { cache: "no-store" });
  const txt = await res.text();
  const json = extractGVizJSON(txt);
  const table = json.table;
  const headers = table.cols.map((c) => c.label || "");
  const rows = table.rows.map((r) => r.c.map((c) => (c ? c.v : "")));

  const idx = mapIndexes(headers);
  if (
    idx.iCliente < 0 ||
    (idx.iSaldo < 0 && (idx.iSuma < 0 || idx.iPremio < 0))
  ) {
    throw new Error(
      "La hoja no contiene las columnas necesarias (Cliente y Saldo o Cantidad+MetroPremio)."
    );
  }

  const row = rows.find((r) => canon(r[idx.iCliente]) === canon(patente));
  if (!row) return null;

  let saldo = idx.iSaldo >= 0 ? numAR(row[idx.iSaldo]) : NaN;
  if (!Number.isFinite(saldo)) {
    const suma = numAR(row[idx.iSuma]);
    const premio = numAR(row[idx.iPremio]);
    saldo = (isNaN(suma) ? 0 : suma) - (isNaN(premio) ? 0 : premio);
  }

  return { cliente: row[idx.iCliente], saldo };
}

async function fetchSaldoByCSV(patente) {
  if (!CONFIG.SHEET_GID) return null;
  const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}/export?format=csv&gid=${CONFIG.SHEET_GID}`;
  const res = await fetch(url, { cache: "no-store" });
  const csv = await res.text();

  const rows = parseCsv(csv);
  const headers = rows.shift() || [];
  const idx = mapIndexes(headers);
  if (
    idx.iCliente < 0 ||
    (idx.iSaldo < 0 && (idx.iSuma < 0 || idx.iPremio < 0))
  ) {
    throw new Error("La hoja CSV no contiene las columnas necesarias.");
  }

  const row = rows.find((r) => canon(r[idx.iCliente]) === canon(patente));
  if (!row) return null;

  let saldo = idx.iSaldo >= 0 ? numAR(row[idx.iSaldo]) : NaN;
  if (!Number.isFinite(saldo)) {
    const suma = numAR(row[idx.iSuma]);
    const premio = numAR(row[idx.iPremio]);
    saldo = (isNaN(suma) ? 0 : suma) - (isNaN(premio) ? 0 : premio);
  }

  return { cliente: row[idx.iCliente], saldo };
}

// CSV simple (soporta comillas dobles)
function parseCsv(text) {
  const out = [];
  let row = [],
    cur = "",
    inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i],
      nx = text[i + 1];
    if (inQ) {
      if (ch === '"' && nx === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\n") {
        row.push(cur);
        out.push(row);
        row = [];
        cur = "";
      } else if (ch === "\r") {
        /* ignore */
      } else cur += ch;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out;
}
// ============ UI / LÓGICA ============
async function consultar(patenteRaw) {
  const alertBox = $("#alert");
  const block = $("#resultBlock");
  const title = $("#resTitle");
  const saldoBig = $("#saldoBig");
  const last = $("#lastUpd");

  alertBox.hidden = true;
  block.hidden = true;

  try {
    const patente = String(patenteRaw || "")
      .trim()
      .toUpperCase();
    if (!patente) throw new Error("Ingresá una patente.");

    let data = null;

    // A) rápido: GViz con filtro
    if (CONFIG.USE_GVIZ) {
      try {
        data = await fetchSaldoByGViz(patente);
      } catch (e) {
        /* fallback */
      }
    }

    // B) fallback: GViz full
    if (!data) {
      try {
        data = await fetchSaldoByGVizFull(patente);
      } catch (e) {
        /* fallback */
      }
    }

    // C) fallback opcional: CSV
    if (!data) {
      data = await fetchSaldoByCSV(patente);
    }

    if (!data) {
      alertBox.textContent = `No encontramos registros para la patente “${patente}”. Verificá que esté sin espacios y tal como figura en tu vehículo.`;
      alertBox.hidden = false;
      return;
    }

    title.textContent = `Saldo de la patente: ${patente}`;
    saldoBig.textContent = fmtAR(data.saldo);

    // Última actualización real del archivo
    const dt = await fetchModifiedTime();
    if (dt) {
      last.textContent = `*Última actualización: ${dt.toLocaleDateString(
        "es-AR"
      )} ${dt.toLocaleTimeString("es-AR", {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
      last.hidden = false;
    } else {
      last.hidden = true;
    }

    block.hidden = false;
  } catch (err) {
    alertBox.textContent = err.message || String(err);
    alertBox.hidden = false;
  }
}

function syncUI() {
  const inp = $("#patente");
  const btn = $("#btnConsultar");
  if (!inp || !btn) return;
  inp.value = inp.value.toUpperCase().replace(/\s+/g, "");
  btn.disabled = inp.value.trim() === "";
}

function setYear() {
  const y = $("#year");
  if (y) y.textContent = new Date().getFullYear();
}

window.addEventListener("DOMContentLoaded", () => {
  setYear();

  const inp = $("#patente");
  const btn = $("#btnConsultar");
  const form = $("#formConsulta");

  // Rellenar con la query si viene
  const q = new URLSearchParams(location.search);
  const p = (q.get("patente") || "").toUpperCase();
  if (p) inp.value = p;

  syncUI();
  inp.addEventListener("input", () => {
    syncUI();
    if (!inp.value.trim()) {
      $("#resultBlock").hidden = true;
      $("#alert").hidden = true;
      const url = new URL(location.href);
      url.searchParams.delete("patente");
      history.replaceState({}, "", url.pathname);
    }
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const patente = inp.value.trim().toUpperCase();
    if (!patente) return;
    btn.disabled = true;
    btn.textContent = "Consultando…";

    // Actualizo la URL (?patente=)
    const url = new URL(location.href);
    url.searchParams.set("patente", patente);
    history.replaceState({}, "", `${url.pathname}?${url.searchParams}`);

    await consultar(patente);

    btn.disabled = false;
    btn.textContent = "Consultar";
  });

  if (p) consultar(p);
});
