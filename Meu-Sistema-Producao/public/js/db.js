// ============================================================
//  db.js — Todas as operações Firestore
// ============================================================
import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc,
  deleteDoc, setDoc, onSnapshot, query, where, orderBy,
  serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── Helpers ──────────────────────────────────────────────────
const col = (path) => collection(db, path);
const ref = (path, id) => doc(db, path, id);

// ================================================================
//  USUÁRIOS
// ================================================================
export async function getUsuario(uid) {
  const snap = await getDoc(ref("usuarios", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export async function getAllUsuarios() {
  const snap = await getDocs(col("usuarios"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function setUsuario(uid, data) {
  await setDoc(ref("usuarios", uid), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}
export async function updateUsuario(uid, data) {
  await updateDoc(ref("usuarios", uid), { ...data, updatedAt: serverTimestamp() });
}

// ================================================================
//  REGISTROS (Ordens de Produção)
// ================================================================
function ordenarRegistros(rows) {
  return rows.sort((a, b) => {
    const ao = Number(a.sortOrder ?? 0);
    const bo = Number(b.sortOrder ?? 0);

    if (ao !== bo) return ao - bo;

    const ad = a.dtDesejada || a.criadoEm?.seconds || 0;
    const bd = b.dtDesejada || b.criadoEm?.seconds || 0;

    return String(ad).localeCompare(String(bd));
  });
}

export async function getAllRegistros() {
  const snap = await getDocs(col("registros"));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return ordenarRegistros(rows);
}

export async function addRegistro(data) {
  return await addDoc(col("registros"), {
    ...data,
    sortOrder: Date.now(),
    criadoEm: serverTimestamp()
  });
}

export async function updateRegistro(id, data) {
  await updateDoc(ref("registros", id), {
    ...data,
    atualizadoEm: serverTimestamp()
  });
}

export async function deleteRegistro(id) {
  await deleteDoc(ref("registros", id));
}

export function watchRegistros(callback) {
  return onSnapshot(col("registros"), snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(ordenarRegistros(rows));
  });
}

// ================================================================
//  MÁQUINAS
// ================================================================
export async function getAllMaquinas() {
  const snap = await getDocs(query(col("maquinas"), orderBy("nome")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function addMaquina(data) {
  return await addDoc(col("maquinas"), { ...data, criadoEm: serverTimestamp() });
}
export async function updateMaquina(id, data) {
  await updateDoc(ref("maquinas", id), { ...data, atualizadoEm: serverTimestamp() });
}
export async function deleteMaquina(id) {
  await deleteDoc(ref("maquinas", id));
}
export async function upsertMaquinaByNome(nome, data = {}) {
  const snap = await getDocs(query(col("maquinas"), where("nome", "==", nome)));

  if (!snap.empty) {
    const docId = snap.docs[0].id;
    await updateDoc(ref("maquinas", docId), {
      ...data,
      atualizadoEm: serverTimestamp()
    });
    return docId;
  }

  const r = await addDoc(col("maquinas"), {
    nome,
    ...data,
    criadoEm: serverTimestamp()
  });

  return r.id;
}

// ================================================================
//  INSUMOS
// ================================================================
export async function getAllInsumos() {
  const snap = await getDocs(query(col("insumos"), orderBy("nome")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function addInsumo(data) {
  return await addDoc(col("insumos"), { ...data, criadoEm: serverTimestamp() });
}
export async function updateInsumo(id, data) {
  await updateDoc(ref("insumos", id), { ...data, atualizadoEm: serverTimestamp() });
}
export async function deleteInsumo(id) {
  await deleteDoc(ref("insumos", id));
}

// ================================================================
//  FICHAS TÉCNICAS
// ================================================================
export async function getAllFichas() {
  const snap = await getDocs(col("fichas"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function getFicha(produtoNome) {
  const snap = await getDocs(query(col("fichas"), where("produto", "==", produtoNome)));
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}
export async function setFicha(data) {
  const existing = await getFicha(data.produto);
  if (existing) {
    await updateDoc(ref("fichas", existing.id), { ...data, atualizadoEm: serverTimestamp() });
    return existing.id;
  } else {
    const r = await addDoc(col("fichas"), { ...data, criadoEm: serverTimestamp() });
    return r.id;
  }
}

// ================================================================
//  APONTAMENTOS (hora a hora)
// ================================================================
export async function getApontamento(a, b) {
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const date = isDate(a) ? a : b;
  const registroId = isDate(a) ? b : a;
  const id = `${date}_${registroId}`;
  const snap = await getDoc(ref("apontamentos", id));
  return snap.exists() ? snap.data() : null;
}
export async function setApontamento(a, b, horas) {
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const date = isDate(a) ? a : b;
  const registroId = isDate(a) ? b : a;
  const id = `${date}_${registroId}`;
  await setDoc(ref("apontamentos", id), { date, registroId, horas, atualizadoEm: serverTimestamp() }, { merge: true });
}
export async function getApontamentosByRegistro(registroId) {
  const snap = await getDocs(query(col("apontamentos"), where("registroId", "==", registroId)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function getTotalApontado(registroId) {
  const apons = await getApontamentosByRegistro(registroId);
  const HORAS = [7,8,9,10,11,12,13,14,15,16,17];
  return apons.reduce((total, a) => {
    return total + HORAS.reduce((s, h) => s + (parseInt(a.horas?.[h]) || 0), 0);
  }, 0);
}

// ================================================================
//  CONFIGURAÇÕES GLOBAIS (jornada, parâmetros, etc.)
// ================================================================
export async function getConfig(key) {
  const snap = await getDoc(ref("configuracoes", key));
  return snap.exists() ? snap.data() : null;
}

export async function setConfig(key, data) {
  await setDoc(
    ref("configuracoes", key),
    { ...data, atualizadoEm: serverTimestamp() },
    { merge: true }
  );
}

// ================================================================
//  LISTENERS em tempo real (aliases usados pelo app.js)
// ================================================================
const _unsubs = [];

export function onRegistros(callback) {
  const unsub = onSnapshot(
    col("registros"),
    snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(ordenarRegistros(rows));
    }
  );
  _unsubs.push(unsub);
  return unsub;
}

export function onMaquinas(callback) {
  const unsub = onSnapshot(
    query(col("maquinas"), orderBy("nome")),
    snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
  _unsubs.push(unsub);
  return unsub;
}

export function onUsuarios(callback) {
  const unsub = onSnapshot(
    col("usuarios"),
    snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
  _unsubs.push(unsub);
  return unsub;
}

export function cancelAllListeners() {
  _unsubs.forEach(u => u());
  _unsubs.length = 0;
}

// ================================================================
//  APONTAMENTOS — alias saveApontamento usado pelo app.js
// ================================================================
export async function saveApontamento(registroId, date, horas) {
  return setApontamento(date, registroId, horas);
}

// ================================================================
//  JORNADA
// ================================================================
export async function getJornada() {
  const data = await getConfig("jornada");

  const padrao = {
    dom: 0,
    seg: 9,
    ter: 9,
    qua: 9,
    qui: 9,
    sex: 8,
    sab: 8
  };

  if (!data || !data.dias) return padrao;

  if (!Array.isArray(data.dias)) {
    return {
      dom: Number(data.dias.dom ?? 0),
      seg: Number(data.dias.seg ?? 9),
      ter: Number(data.dias.ter ?? 9),
      qua: Number(data.dias.qua ?? 9),
      qui: Number(data.dias.qui ?? 9),
      sex: Number(data.dias.sex ?? 8),
      sab: Number(data.dias.sab ?? 8)
    };
  }

  const arr = data.dias;
  return {
    dom: Number(arr[0] ?? 0),
    seg: Number(arr[1] ?? 9),
    ter: Number(arr[2] ?? 9),
    qua: Number(arr[3] ?? 9),
    qui: Number(arr[4] ?? 9),
    sex: Number(arr[5] ?? 8),
    sab: Number(arr[6] ?? 8)
  };
}

export async function saveJornada(dias) {
  const normalizado = {
    dom: Number(dias.dom ?? 0),
    seg: Number(dias.seg ?? 9),
    ter: Number(dias.ter ?? 9),
    qua: Number(dias.qua ?? 9),
    qui: Number(dias.qui ?? 9),
    sex: Number(dias.sex ?? 8),
    sab: Number(dias.sab ?? 8)
  };

  return setConfig("jornada", { dias: normalizado });
}

// ================================================================
//  BUILD APON TOTALS — soma apontamentos por registro
// ================================================================
export async function buildAponTotals(ids) {
  const totals = {};
  await Promise.all(ids.map(async id => {
    totals[id] = await getTotalApontado(id);
  }));
  return totals;
}

// ================================================================
//  BACKUP / EXPORTAÇÃO
// ================================================================
export async function exportarBackup() {
  const [registros, maquinas, apontamentos, usuarios] = await Promise.all([
    getDocs(col("registros")),
    getDocs(col("maquinas")),
    getDocs(col("apontamentos")),
    getDocs(col("usuarios")),
  ]);
  return {
    exportadoEm: new Date().toISOString(),
    registros:    registros.docs.map(d => ({ id: d.id, ...d.data() })),
    maquinas:     maquinas.docs.map(d => ({ id: d.id, ...d.data() })),
    apontamentos: apontamentos.docs.map(d => ({ id: d.id, ...d.data() })),
    usuarios:     usuarios.docs.map(d => ({ id: d.id, ...d.data() })),
  };
}

// ================================================================
//  SEED — cria dados iniciais se Firestore estiver vazio
// ================================================================
export async function seedIfEmpty() {
  const snap = await getDocs(col("maquinas"));
  if (!snap.empty) return; // already seeded

  console.log("[DB] Criando dados iniciais...");
  const batch = writeBatch(db);

  const maquinas = [
    { nome:"SELGRON 01",       setor:"A", capacidade:300, ativo:true },
    { nome:"SELGRON 02",       setor:"A", capacidade:300, ativo:true },
    { nome:"IMAPACK 12",       setor:"D", capacidade:450, ativo:true },
    { nome:"OLC 13",           setor:"D", capacidade:400, ativo:true },
    { nome:"ALFATECK 14",      setor:"B", capacidade:350, ativo:true },
    { nome:"ALFATECK 15",      setor:"B", capacidade:350, ativo:true },
    { nome:"ALFATECK 16",      setor:"B", capacidade:350, ativo:true },
    { nome:"MASIPACK 07-08",   setor:"E", capacidade:280, ativo:true },
    { nome:"MASIPACK 10",      setor:"E", capacidade:280, ativo:true },
    { nome:"GOLPACK 06",       setor:"C", capacidade:320, ativo:true },
  ];
  maquinas.forEach(m => batch.set(doc(col("maquinas")), { ...m, criadoEm: serverTimestamp() }));

  const insumos = [
    { nome:"Polvilho Azedo",         categoria:"MATERIA PRIMA", unidade:"KG",  estoqueAtual:2100, estoqueMinimo:1500, consumoSemanal:400 },
    { nome:"Polvilho Doce",          categoria:"MATERIA PRIMA", unidade:"KG",  estoqueAtual:3400, estoqueMinimo:1000, consumoSemanal:280 },
    { nome:"Coco Ralado Desidratado",categoria:"MATERIA PRIMA", unidade:"KG",  estoqueAtual:920,  estoqueMinimo:600,  consumoSemanal:150 },
    { nome:"Farinha de Milho",       categoria:"MATERIA PRIMA", unidade:"KG",  estoqueAtual:1800, estoqueMinimo:800,  consumoSemanal:320 },
    { nome:"Colorifico Vermelho",    categoria:"MATERIA PRIMA", unidade:"KG",  estoqueAtual:320,  estoqueMinimo:200,  consumoSemanal:60  },
    { nome:"Bicarbonato de Sódio",   categoria:"MATERIA PRIMA", unidade:"KG",  estoqueAtual:540,  estoqueMinimo:300,  consumoSemanal:80  },
    { nome:"Bobina BOPP 80mm",       categoria:"EMBALAGEM",     unidade:"RL",  estoqueAtual:45,   estoqueMinimo:60,   consumoSemanal:12  },
    { nome:"Bobina BOPP 100mm",      categoria:"EMBALAGEM",     unidade:"RL",  estoqueAtual:82,   estoqueMinimo:60,   consumoSemanal:18  },
    { nome:"Caixa 06 Produtos",      categoria:"EMBALAGEM",     unidade:"UN",  estoqueAtual:3100, estoqueMinimo:2000, consumoSemanal:500 },
    { nome:"Saco Pouch Kraft",       categoria:"EMBALAGEM",     unidade:"UN",  estoqueAtual:1240, estoqueMinimo:1000, consumoSemanal:200 },
  ];
  insumos.forEach(i => batch.set(doc(col("insumos")), { ...i, criadoEm: serverTimestamp() }));

  // Jornada padrão
  batch.set(ref("config","jornada"), { dias:[0,9,9,9,9,9,8,0], atualizadoEm: serverTimestamp() });

  await batch.commit();
  console.log("[DB] Dados iniciais criados ✓");
}
