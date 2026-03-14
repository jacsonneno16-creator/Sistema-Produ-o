// ===== PROGPROD MES — app.js (Firebase + HTML Integration) =====
import { auth, db as firestoreDB } from './firebase-config.js';
import {
  initAuth, login, logout, currentUser,
  can, canAccess, perfilBadge, MODULOS,
  criarUsuarioSistema, listarUsuariosSistema, atualizarUsuarioSistema, excluirUsuarioSistema,
  listarFuncionariosProducao, salvarFuncionarioProducao, excluirFuncionarioProducao,
  enviarResetSenha, adminForcaReset
} from './auth.js';
import {
  collection, getDocs, addDoc, setDoc, doc, deleteDoc, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ===== TURNOS POR MÁQUINA (módulo de disponibilidade real) =====
// Nota: turnosMaquinas.js é carregado como script separado no index.html

// ===== FIREBASE DB REPLACEMENTS (IndexedDB → Firestore) =====
let records = [], pg = 1;
const PER = 15;

async function dbAll() {
  try {
    const snap = await getDocs(collection(firestoreDB, 'registros'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) {
    console.error('dbAll error:', e);
    return [];
  }
}

async function dbPut(obj) {
  const { id, ...data } = obj;
  try {
    if(id) {
      await setDoc(doc(firestoreDB, 'registros', id), data, { merge: true });
      return id;
    } else {
      const ref = await addDoc(collection(firestoreDB, 'registros'), data);
      return ref.id;
    }
  } catch(e) {
    console.error('dbPut error:', e);
    throw e;
  }
}

async function dbDel(id) {
  try {
    await deleteDoc(doc(firestoreDB, 'registros', String(id)));
  } catch(e) {
    console.error('dbDel error:', e);
    throw e;
  }
}

// ===== DADOS =====
// Array de produtos: populado do Firestore via carregarProdutosFirestore()
let PRODUTOS = [];
// Ficha técnica: populada do Firestore ou importação Excel
let FICHA_TECNICA = [];

// MAQUINAS: populado exclusivamente via carregarMaquinasFirestore() no boot
let MAQUINAS = [];

// ===== SETUP TIMES (minutes) =====
// Cache do Firestore: { maquina: { prodA_norm: { prodB_norm: minutos } } }
// Populado por carregarSetupFirestore(). Fallback: SETUP_DATA estático abaixo.
let SETUP_FIRESTORE = {};

// Carrega setup_maquinas do Firestore e popula SETUP_FIRESTORE
async function carregarSetupFirestore() {
  try {
    const snap = await getDocs(collection(firestoreDB, 'setup_maquinas'));
    SETUP_FIRESTORE = {};
    snap.docs.forEach(d => {
      const data = d.data();
      const maq = data.maquina || '';
      const pA = normProd(data.produto_origem || '');
      const pB = normProd(data.produto_destino || '');
      const t = parseInt(data.tempo_setup) || 0;
      if (!maq || !pA || !pB) return;
      if (!SETUP_FIRESTORE[maq]) SETUP_FIRESTORE[maq] = {};
      if (!SETUP_FIRESTORE[maq][pA]) SETUP_FIRESTORE[maq][pA] = {};
      SETUP_FIRESTORE[maq][pA][pB] = t;
      // Bidirecional se não existir o inverso
      if (!SETUP_FIRESTORE[maq][pB]) SETUP_FIRESTORE[maq][pB] = {};
      if (SETUP_FIRESTORE[maq][pB][pA] == null) SETUP_FIRESTORE[maq][pB][pA] = t;
    });
    if (!snap.empty) console.log('[SETUP] Carregados do Firestore:', snap.size, 'registros');
  } catch(e) {
    console.warn('[SETUP] Usando matriz estática (fallback):', e.message);
  }
}

// Salva um registro de setup no Firestore
async function salvarSetupFirestore(maquina, prodOrigem, prodDestino, tempoMinutos) {
  try {
    // Verifica se já existe
    const q = query(collection(firestoreDB, 'setup_maquinas'),
      where('maquina', '==', maquina),
      where('produto_origem', '==', prodOrigem),
      where('produto_destino', '==', prodDestino)
    );
    const snap = await getDocs(q);
    const payload = { maquina, produto_origem: prodOrigem, produto_destino: prodDestino, tempo_setup: parseInt(tempoMinutos)||0, atualizadoEm: new Date().toISOString() };
    if (!snap.empty) {
      await setDoc(doc(firestoreDB, 'setup_maquinas', snap.docs[0].id), payload);
    } else {
      await addDoc(collection(firestoreDB, 'setup_maquinas'), payload);
    }
    await carregarSetupFirestore();
  } catch(e) { toast('Erro ao salvar setup: ' + e.message, 'err'); }
}

// Normaliza nome de produto para chave de lookup
function normProd(s){
  return (s||'').toUpperCase().trim()
    .replace(/\s+/g,' ')
    .replace(/[_\-]+/g,' ')
    .replace(/\bDA\s+TERRINHA\b/g,'TERRINHA')
    .replace(/\bDE\s+TERRINHA\b/g,'TERRINHA')
    .replace(/\bDATERRINHA\b/g,'TERRINHA')
    .replace(/\bDO\s+RANCHO\b/g,'RANCHO')
    .replace(/\bCOOP\b/g,'COOP')
    .replace(/\bMERCADAO\b/g,'MERCADAO')
    .replace(/\bOBA\b/g,'OBA');
}

// Matriz de setup: agora vem exclusivamente do Firestore (coleção setup_maquinas).
// SETUP_DATA mantido como objeto vazio — não contém mais dados estáticos.
const SETUP_DATA = {};

// Retorna tempo de setup em minutos entre dois produtos na mesma máquina.
// Fonte: Firestore (setup_maquinas) → tempo padrão da máquina → 0
function getSetupMin(maq, prodDescA, prodDescB) {
  if (!maq || !prodDescA || !prodDescB) return 0;
  if (prodDescA === prodDescB) return 0;

  // 1) Firestore (carregarSetupFirestore populou SETUP_FIRESTORE)
  const fsMaq = SETUP_FIRESTORE[maq];
  if (fsMaq) {
    const normA = normProd(prodDescA);
    const normB = normProd(prodDescB);
    if (fsMaq[normA] && fsMaq[normA][normB] != null) return fsMaq[normA][normB];
    if (fsMaq[normB] && fsMaq[normB][normA] != null) return fsMaq[normB][normA];
  }

  // 2) Tempo padrão configurado na máquina (campo tempoSetupPadrao)
  const padrao = getSetupPadrao(maq);
  if (padrao > 0) return padrao;

  // 3) Sem configuração → 0 minutos
  return 0;
}

// Retorna o tempo de setup padrão de uma máquina
function getSetupPadrao(maq) {
  const d = getMaquinaData(maq);
  return (d && parseFloat(d.tempoSetupPadrao) > 0) ? parseFloat(d.tempoSetupPadrao) : 0;
}

// Calcula o tempo total de setup de uma lista de produtos em sequência numa máquina
function calcTotalSetupMin(maq, orderedProds) {
  let total = 0;
  for (let i = 1; i < orderedProds.length; i++) {
    total += getSetupMin(maq, orderedProds[i-1], orderedProds[i]);
  }
  return total;
}

// ===== WEEK FILTER HELPERS =====
let maqViewMode = 'grid'; // 'grid' or 'list'
let maqWeekFilter = ''; // '' = all, or monday dateStr

function getRecordsWeekMondaysSet(){
  const s=new Set();
  records.forEach(r=>{
    const dt=r.dtDesejada||r.dtSolicitacao;
    if(dt){
      const m=getWeekMonday(new Date(dt+'T12:00:00'));
      s.add(dateStr(m));
    }
  });
  return s;
}

function populateWeekFilters(){
  const mondays=[...getRecordsWeekMondaysSet()].sort().reverse();
  const ganttSel=document.getElementById('gantt-week-filter');
  const maqSel=document.getElementById('maq-week-filter');
  [ganttSel, maqSel].forEach(sel=>{
    if(!sel) return;
    const val=sel.value;
    const firstOpt=sel.options[0];
    sel.innerHTML='';
    sel.appendChild(firstOpt);
    mondays.forEach(ms=>{
      const d=new Date(ms+'T12:00:00');
      const sun=new Date(d); sun.setDate(d.getDate()+6);
      const o=document.createElement('option');
      o.value=ms;
      o.textContent=`${fmtDate(d)} – ${fmtDate(sun)}`;
      sel.appendChild(o);
    });
    if(val) sel.value=val;
  });
  // Show/hide week filter in gantt
  if(ganttSel) ganttSel.style.display=mondays.length>0?'block':'none';
}

function setMaqView(mode){
  maqViewMode=mode;
  document.getElementById('maq-view-grid').className='btn '+(mode==='grid'?'btn-primary':'btn-ghost');
  document.getElementById('maq-view-list').className='btn '+(mode==='list'?'btn-primary':'btn-ghost');
  document.getElementById('maq-view-grid').style.borderRadius='0';
  document.getElementById('maq-view-list').style.borderRadius='0';
  document.getElementById('maq-view-list').style.border='none';
  renderMaquinas();
}

function filterMaqWeek(val){
  maqWeekFilter=val;
  renderMaquinas();
}

// ===== INIT & RELOAD (Firebase Auth + Firestore) =====
async function appInit() {
  await carregarMaquinasFirestore();
  await carregarProdutosFirestore();
  await carregarSetupFirestore();
  const sel = document.getElementById('s-maq');
  if(sel) {
    MAQUINAS.forEach(m => {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    });
  }
  if(typeof initFichaTecnica === 'function') initFichaTecnica();
  await reload();
  document.addEventListener('click', e => {
    if(!e.target.closest('.ac-rel')) closeAC();
  });
  // Start clock
  updateClock();
  setInterval(updateClock, 1000);
}

async function reload() {
  // Mostra feedback de carregamento na tabela
  const tbodyEl = document.getElementById('tbody');
  if(tbodyEl) tbodyEl.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--text3);font-size:12px">⏳ Carregando...</td></tr>';

  records = await dbAll();
  if(!Array.isArray(records)) records = [];
  updateHeader();
  renderDashboard();
  renderTable();
  populateWeekFilters();
  // Mantém o select de filtro de máquinas atualizado com as máquinas que têm registros
  const sMaqSel = document.getElementById('s-maq');
  if(sMaqSel) {
    const currentVal = sMaqSel.value;
    const maqs = [...new Set(records.map(r=>r.maquina).filter(Boolean))].sort();
    sMaqSel.innerHTML = '<option value="">Todas as máquinas</option>' +
      maqs.map(m=>`<option value="${m}"${m===currentVal?' selected':''}>${m}</option>`).join('');
  }
  if(!ganttManualNav) {
    const sorted = [...records].filter(r=>r.dtDesejada||r.dtSolicitacao)
      .sort((a,b)=>{const da=b.dtDesejada||b.dtSolicitacao||'';const db2=a.dtDesejada||a.dtSolicitacao||'';return da.localeCompare(db2);});
    if(sorted.length>0) {
      ganttBaseMonday = getWeekMonday(new Date((sorted[0].dtDesejada||sorted[0].dtSolicitacao)+'T12:00:00'));
    } else if(!ganttBaseMonday) {
      ganttBaseMonday = getWeekMonday(new Date());
    }
  }
}

function updateClock() {
  const now = new Date();
  const el = document.getElementById('tb-time');
  const del = document.getElementById('tb-date');
  if(el) el.textContent = now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  if(del) del.textContent = now.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
}

function updateHeader(){
  // pills removed — nothing to update in header anymore
}

// ===== TABS =====
// ===== DASHBOARD =====
function renderDashboard(){
  const total=records.length;
  const pend=records.filter(r=>r.status==='Pendente').length;
  const and=records.filter(r=>r.status==='Em Andamento').length;
  const ok=records.filter(r=>r.status==='Concluído').length;
  document.getElementById('d-total').textContent=total;
  document.getElementById('d-pend').textContent=pend;
  document.getElementById('d-and').textContent=and;
  document.getElementById('d-ok').textContent=ok;

  renderRelatorio();

  // Atualiza relatório se estiver visível
  setTimeout(renderRelatorio, 0);

  const recent=[...records].sort((a,b)=>b.id-a.id).slice(0,8);
  const el=document.getElementById('dash-recent');
  if(!recent.length){
    el.innerHTML='<div class="empty"><div class="ei">📋</div>Nenhuma solicitação ainda</div>';
    return;
  }
  el.innerHTML=`<table class="recent-tbl">
    <thead><tr>
      <th>Produto</th><th>Máquina</th><th style="text-align:right">Caixas</th><th>Status</th><th>Dt Início</th>
    </tr></thead>
    <tbody>${recent.map(r=>`<tr>
      <td style="font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.produto}</td>
      <td><span class="badge b-maq">${r.maquina}</span></td>
      <td style="text-align:right;color:var(--cyan);font-family:'JetBrains Mono',monospace">${r.qntCaixas}</td>
      <td>${sBadge(r.status)}</td>
      <td style="color:var(--text2);font-size:12px;font-family:'JetBrains Mono',monospace">${r.dtDesejada||r.dtSolicitacao||'—'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}


// ════════════════════════════════════════════════════════════════
// RELATÓRIO DE PRODUÇÃO — Dashboard
// Modos: 'semana' | 'mes' | 'mes-sem'
// ════════════════════════════════════════════════════════════════
let rptMode = 'semana';          // modo atual
let rptAnchor = new Date();      // data âncora (qualquer dia do período)

function rptSetMode(m) {
  rptMode = m;
  // Atualiza visual dos botões
  ['semana','mes','mes-sem'].forEach(function(k) {
    const btn = document.getElementById('rpt-btn-'+k);
    if (!btn) return;
    const on = k === m;
    btn.style.background = on ? 'var(--cyan)' : 'transparent';
    btn.style.color = on ? '#000' : 'var(--text2)';
  });
  renderRelatorio();
}



function rptGoToday() {
  rptAnchor = new Date();
  renderRelatorio();
}

// Retorna total realizado (caixas) para um record num intervalo de datas
function rptGetRealizado(recId, datesList) {
  let total = 0;
  const suffix = '_' + recId;
  datesList.forEach(function(ds) {
    const d = aponStorageGet('apon_' + ds + '_' + recId);
    if (d) {
      (typeof APON_HOURS !== 'undefined' ? APON_HOURS : ['h1','h2','h3','h4','h5','h6','h7','h8','h9','h10','h11','h12']).forEach(function(h) {
        total += parseInt(d[h]) || 0;
      });
    }
  });
  return total;
}

// Constrói lista de datas de uma semana (Mon–Sun) como strings YYYY-MM-DD
function rptWeekDates(monday) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    out.push(dateStr(d));
  }
  return out;
}

// Semanas de um mês
function rptMonthWeeks(year, month) {
  // month 0-based
  const weeks = [];
  const firstDay = new Date(year, month, 1);
  let mon = getWeekMonday(firstDay);
  // Se segunda anterior ao mês, começar do próximo
  while (mon.getMonth() < month && mon.getFullYear() <= year) {
    const tmp = new Date(mon); tmp.setDate(tmp.getDate() + 7);
    if (tmp.getMonth() === month || (tmp.getMonth() < month && tmp.getFullYear() > year)) { mon = tmp; break; }
    mon = tmp;
  }
  // Volta até a segunda que cobre o início do mês
  const start = getWeekMonday(firstDay);
  let cur = start;
  const lastDay = new Date(year, month + 1, 0);
  while (cur <= lastDay) {
    weeks.push(new Date(cur));
    cur = new Date(cur);
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

function renderRelatorio__OLD_REMOVED() {
  const wrap = document.getElementById('rpt-table-wrap');
  if (!wrap) return;
  return; // OLD VERSION - removed to avoid duplicate declaration

  const y = rptAnchor.getFullYear();
  const mo = rptAnchor.getMonth();
  const fmt2 = function(d) { return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}); };
  const fmtWk = function(mon) {
    const sun = new Date(mon); sun.setDate(sun.getDate()+6);
    return fmt2(mon)+' – '+fmt2(sun);
  };
  const MONTH_NAMES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  // ── Constrói colunas (períodos) ──
  let cols = []; // [{label, dates:[YYYY-MM-DD,...], monday?}]

  if (rptMode === 'semana') {
    // Duas semanas: anterior e atual
    const mon = getWeekMonday(rptAnchor);
    const prevMon = new Date(mon); prevMon.setDate(prevMon.getDate()-7);
    cols = [
      { label: fmtWk(prevMon)+' (sem ant.)', dates: rptWeekDates(prevMon) },
      { label: fmtWk(mon)+' (sem atual)', dates: rptWeekDates(mon) },
    ];
    if (label) label.textContent = fmtWk(mon);

  } else if (rptMode === 'mes') {
    // Dois meses: anterior e atual
    const prevMo = mo === 0 ? 11 : mo-1;
    const prevY = mo === 0 ? y-1 : y;
    const allDaysOf = function(yr, m) {
      const out = []; const last = new Date(yr, m+1, 0).getDate();
      for (let d = 1; d <= last; d++) {
        const dt = new Date(yr, m, d);
        out.push(dateStr(dt));
      }
      return out;
    };
    cols = [
      { label: MONTH_NAMES[prevMo]+'/'+prevY, dates: allDaysOf(prevY, prevMo) },
      { label: MONTH_NAMES[mo]+'/'+y+' (atual)', dates: allDaysOf(y, mo) },
    ];
    if (label) label.textContent = MONTH_NAMES[mo]+' '+y;

  } else { // mes-sem
    // Semanas dentro do mês atual
    const weeks = rptMonthWeeks(y, mo);
    cols = weeks.map(function(mon, i) {
      return { label: 'Sem '+(i+1)+'\n'+fmtWk(mon), dates: rptWeekDates(mon) };
    });
    if (label) label.textContent = MONTH_NAMES[mo]+' '+y+' (por semana)';
  }

  // ── Agrupa por máquina ──
  const maqs = [...new Set(recs.map(r => r.maquina))].sort();

  if (!maqs.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text3);font-size:13px">Nenhum dado para o período</div>';
    return;
  }

  // ── Monta tabela HTML ──
  let totalProg = cols.map(() => 0);
  let totalReal = cols.map(() => 0);

  let rows = '';
  maqs.forEach(function(maq) {
    const maqRecs = recs.filter(r => r.maquina === maq);
    let progByCol = cols.map(function(col) {
      return maqRecs.filter(function(r) {
        const dt = r.dtDesejada || r.dtSolicitacao || '';
        return col.dates.includes(dt);
      }).reduce((s, r) => s + (parseInt(r.qntCaixas) || 0), 0);
    });
    let realByCol = cols.map(function(col) {
      return maqRecs.reduce(function(s, r) {
        return s + rptGetRealizado(r.id, col.dates);
      }, 0);
    });

    // Soma nos totais gerais
    cols.forEach(function(_, i) {
      totalProg[i] += progByCol[i];
      totalReal[i] += realByCol[i];
    });

    // Linha máquina
    rows += '<tr style="border-top:2px solid var(--border2)">';
    rows += '<td style="padding:8px 12px;font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;color:var(--purple);white-space:nowrap;background:var(--s2)" rowspan="2">'+maq+'</td>';
    rows += '<td style="padding:6px 10px;font-size:10px;color:var(--cyan);font-family:JetBrains Mono,monospace;font-weight:700;background:rgba(0,229,204,.04)">PROG</td>';
    progByCol.forEach(function(v) {
      rows += '<td style="padding:6px 12px;text-align:right;font-family:JetBrains Mono,monospace;font-size:13px;font-weight:700;color:'+(v>0?'var(--cyan)':'var(--text4)')+';background:rgba(0,229,204,.04)">'+v+'</td>';
    });
    rows += '</tr><tr>';
    rows += '<td style="padding:6px 10px;font-size:10px;color:var(--green);font-family:JetBrains Mono,monospace;font-weight:700">REAL</td>';
    realByCol.forEach(function(v, i) {
      const prog = progByCol[i];
      const perc = prog > 0 ? Math.round(v/prog*100) : (v>0?100:0);
      const col2 = v >= prog && prog > 0 ? 'var(--green)' : v > 0 ? 'var(--amber)' : 'var(--text4)';
      const percTag = prog > 0 || v > 0 ? '<span style="font-size:9px;margin-left:4px;opacity:.7">('+perc+'%)</span>' : '';
      rows += '<td style="padding:6px 12px;text-align:right;font-family:JetBrains Mono,monospace;font-size:13px;font-weight:700;color:'+col2+'">'+v+percTag+'</td>';
    });
    rows += '</tr>';
  });

  // Linha totais
  rows += '<tr style="border-top:2px solid var(--cyan);background:rgba(0,229,204,.06)">';
  rows += '<td style="padding:8px 12px;font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;color:var(--text)" rowspan="2">TOTAL GERAL</td>';
  rows += '<td style="padding:6px 10px;font-size:10px;color:var(--cyan);font-family:JetBrains Mono,monospace;font-weight:700">PROG</td>';
  totalProg.forEach(function(v) {
    rows += '<td style="padding:6px 12px;text-align:right;font-family:JetBrains Mono,monospace;font-size:14px;font-weight:700;color:var(--cyan)">'+v+'</td>';
  });
  rows += '</tr><tr style="background:rgba(0,229,204,.04)">';
  rows += '<td style="padding:6px 10px;font-size:10px;color:var(--green);font-family:JetBrains Mono,monospace;font-weight:700">REAL</td>';
  totalReal.forEach(function(v, i) {
    const prog = totalProg[i];
    const perc = prog > 0 ? Math.round(v/prog*100) : (v>0?100:0);
    const col2 = v >= prog && prog > 0 ? 'var(--green)' : v > 0 ? 'var(--amber)' : 'var(--text4)';
    const percTag = prog > 0 || v > 0 ? '<span style="font-size:9px;margin-left:4px;opacity:.7">('+perc+'%)</span>' : '';
    rows += '<td style="padding:6px 12px;text-align:right;font-family:JetBrains Mono,monospace;font-size:14px;font-weight:700;color:'+col2+'">'+v+percTag+'</td>';
  });
  rows += '</tr>';

  // Cabeçalho de colunas
  let thCols = cols.map(function(c) {
    return '<th style="padding:10px 12px;text-align:right;font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;color:var(--text3);white-space:pre-line;min-width:110px">'+c.label+'</th>';
  }).join('');

  wrap.innerHTML =
    '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<thead><tr style="background:var(--s2);border-bottom:2px solid var(--border2)">'+
        '<th style="padding:10px 12px;text-align:left;font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;color:var(--text3);min-width:120px">Máquina</th>'+
        '<th style="padding:10px 12px;text-align:left;font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;color:var(--text3);width:60px">Tipo</th>'+
        thCols+
      '</tr></thead>'+
      '<tbody>'+rows+'</tbody>'+
    '</table>';
}

// Expõe globais
window.rptSetTipo = rptSetTipo;
window.rptNav = rptNav;
window.renderRelatorio = renderRelatorio;


// ===== RELATÓRIO DE PRODUÇÃO PROGRAMADA =====
let rptTipo = 'semana';
let rptRef  = new Date();

function rptSetTipo(tipo){
  rptTipo=tipo;
  ['semana','mes','mes-semanas'].forEach(t=>{
    const btn=document.getElementById('rpt-btn-'+t);
    if(!btn) return;
    if(t===tipo){btn.style.background='var(--cyan)';btn.style.color='#000';btn.style.fontWeight='700';}
    else{btn.style.background='none';btn.style.color='var(--text2)';btn.style.fontWeight='400';}
  });
  renderRelatorio();
}

function rptNav(dir){
  const d=new Date(rptRef);
  if(rptTipo==='semana') d.setDate(d.getDate()+dir*7);
  else d.setMonth(d.getMonth()+dir);
  rptRef=d;
  renderRelatorio();
}

function rptGetPeriodLabel(){
  if(rptTipo==='semana'){
    const mon=getWeekMonday(rptRef);
    const sun=new Date(mon);sun.setDate(sun.getDate()+6);
    return mon.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})+' – '+sun.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});
  }
  return rptRef.toLocaleDateString('pt-BR',{month:'long',year:'numeric'});
}

function rptGetSlots(){
  if(rptTipo==='semana'){
    const mon=getWeekMonday(rptRef);
    const sun=new Date(mon);sun.setDate(sun.getDate()+6);
    return [{label:'Semana',start:mon,end:sun}];
  } else if(rptTipo==='mes'){
    const start=new Date(rptRef.getFullYear(),rptRef.getMonth(),1);
    const end  =new Date(rptRef.getFullYear(),rptRef.getMonth()+1,0);
    const lbl  =rptRef.toLocaleDateString('pt-BR',{month:'short',year:'numeric'});
    return [{label:lbl,start,end}];
  } else {
    // mes-semanas
    const mStart=new Date(rptRef.getFullYear(),rptRef.getMonth(),1);
    const mEnd  =new Date(rptRef.getFullYear(),rptRef.getMonth()+1,0);
    const slots=[];
    let cur=getWeekMonday(mStart);
    let wn=1;
    while(cur<=mEnd){
      const sun=new Date(cur);sun.setDate(sun.getDate()+6);
      slots.push({label:'Sem '+wn,start:new Date(cur),end:new Date(sun)});
      cur=new Date(sun);cur.setDate(cur.getDate()+1);
      wn++;
    }
    return slots;
  }
}

function rptAggregate(slot,maqFilter){
  const sStr=dateStr(slot.start);
  const eStr=dateStr(slot.end);
  const recs=records.filter(r=>{
    const dt=r.dtDesejada||r.dtSolicitacao||'';
    if(!dt||dt<sStr||dt>eStr) return false;
    if(maqFilter&&r.maquina!==maqFilter) return false;
    return true;
  });
  const caixas=recs.reduce((a,r)=>a+(r.qntCaixas||0),0);
  const unids =recs.reduce((a,r)=>a+(r.qntUnid||0),0);
  // realizado: sum apon data across slot dates
  let realCaixas=0;
  recs.forEach(r=>{
    const d=new Date(slot.start);
    while(dateStr(d)<=eStr){
      const ds=dateStr(d);
      try{
        const key=aponKey(ds,r.id);
        const raw=localStorage.getItem('apon_'+key);
        if(raw){const data=JSON.parse(raw);realCaixas+=Object.values(data).reduce((a,v)=>a+(parseInt(v)||0),0);}
      }catch(e){}
      d.setDate(d.getDate()+1);
    }
  });
  const byMaq={};
  recs.forEach(r=>{
    if(!byMaq[r.maquina]) byMaq[r.maquina]={caixas:0,unids:0,qtd:0};
    byMaq[r.maquina].caixas+=r.qntCaixas||0;
    byMaq[r.maquina].unids +=r.qntUnid||0;
    byMaq[r.maquina].qtd++;
  });
  return{recs:recs.length,caixas,unids,realCaixas,byMaq};
}

function renderRelatorio(){
  const lbl=document.getElementById('rpt-period-label');
  if(lbl) lbl.textContent=rptGetPeriodLabel();

  // Populate machine filter
  const maqSel=document.getElementById('rpt-maq-filter');
  const savedMaq=maqSel?maqSel.value:'';
  if(maqSel){
    const maqs=[...new Set(records.map(r=>r.maquina).filter(Boolean))].sort();
    maqSel.innerHTML='<option value="">Todas as máquinas</option>'+maqs.map(m=>`<option value="${m}"${m===savedMaq?' selected':''}>${m}</option>`).join('');
  }
  const maqFilter=maqSel?maqSel.value:'';

  const slots=rptGetSlots();
  const aggs=slots.map(sl=>({slot:sl,data:rptAggregate(sl,maqFilter)}));
  const body=document.getElementById('rpt-body');
  if(!body) return;

  if(!records.length){
    body.innerHTML='<div style="padding:28px;text-align:center;color:var(--text3);font-size:13px">📋 Nenhuma solicitação cadastrada ainda.</div>';
    return;
  }

  const cols=Math.min(slots.length,4);
  let html=`<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:10px;margin-bottom:18px">`;
  aggs.forEach(({slot,data})=>{
    const pct=data.caixas>0?Math.min(100,Math.round(data.realCaixas/data.caixas*100)):0;
    const pctColor=pct>=100?'var(--green)':pct>=50?'var(--cyan)':'var(--amber)';
    const s=slot.start.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
    const e=slot.end.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
    html+=`<div style="background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:16px 14px;overflow:hidden">
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">${slot.label} <span style="color:var(--text4)">${s}–${e}</span></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:6px">
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:2px">Programado</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:24px;font-weight:700;color:var(--cyan);line-height:1">${data.caixas.toLocaleString('pt-BR')}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:3px">caixas · ${data.recs} solic.</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--text3);margin-bottom:2px">Realizado</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;color:${pctColor};line-height:1">${data.realCaixas.toLocaleString('pt-BR')}</div>
          <div style="font-size:10px;color:${pctColor};margin-top:3px;font-weight:700">${pct}%</div>
        </div>
      </div>
      <div style="margin-top:10px;height:5px;background:var(--s3);border-radius:3px;overflow:hidden">
        <div style="height:100%;background:${pctColor};width:${pct}%;border-radius:3px;transition:width .6s ease"></div>
      </div>
    </div>`;
  });
  html+='</div>';

  // Detail table
  const allMaqs=[...new Set(aggs.flatMap(({data})=>Object.keys(data.byMaq)))].sort();
  if(allMaqs.length===0){
    html+='<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">Nenhuma solicitação no período selecionado.</div>';
    body.innerHTML=html; return;
  }

  html+=`<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;min-width:480px">
    <thead style="background:var(--s2);border-bottom:1px solid var(--border)"><tr>
      <th style="padding:9px 12px;text-align:left;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">Máquina</th>`;
  aggs.forEach(({slot})=>{
    const s=slot.start.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
    const e=slot.end.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
    html+=`<th style="padding:9px 12px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--cyan)">${slot.label}<br><span style="color:var(--text4);font-size:8px">${s}–${e}</span></th>`;
  });
  html+=`<th style="padding:9px 12px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">Total</th></tr></thead><tbody>`;

  allMaqs.forEach((maq,mi)=>{
    const rowBg=mi%2===1?'background:rgba(255,255,255,.01)':'';
    html+=`<tr style="${rowBg}"><td style="padding:9px 12px;color:var(--purple);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700">${maq}</td>`;
    let tot=0;
    aggs.forEach(({data})=>{
      const m=data.byMaq[maq]||{caixas:0,qtd:0};
      tot+=m.caixas;
      html+=`<td style="padding:9px 12px;text-align:center"><span style="color:var(--cyan);font-family:'JetBrains Mono',monospace;font-weight:600">${m.caixas.toLocaleString('pt-BR')}</span> <span style="font-size:10px;color:var(--text3)">(${m.qtd})</span></td>`;
    });
    html+=`<td style="padding:9px 12px;text-align:center;color:var(--text);font-family:'JetBrains Mono',monospace;font-weight:700">${tot.toLocaleString('pt-BR')}</td></tr>`;
  });

  let gTotal=0; aggs.forEach(({data})=>gTotal+=data.caixas);
  html+=`<tr style="background:rgba(0,229,204,.04);border-top:1px solid rgba(0,229,204,.2)">
    <td style="padding:10px 12px;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">TOTAL</td>`;
  aggs.forEach(({data})=>{
    html+=`<td style="padding:10px 12px;text-align:center;color:var(--cyan);font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700">${data.caixas.toLocaleString('pt-BR')}</td>`;
  });
  html+=`<td style="padding:10px 12px;text-align:center;color:var(--cyan);font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:700">${gTotal.toLocaleString('pt-BR')}</td></tr>
  </tbody></table></div>`;

  body.innerHTML=html;
}

// ===== TABLE WEEK FILTER =====
let tableWeekMonday=null; // null = show all

function tableWeekNav(dir){
  if(!tableWeekMonday){
    // start from current week
    tableWeekMonday=getWeekMonday(new Date());
  }
  const d=new Date(tableWeekMonday);
  d.setDate(d.getDate()+dir*7);
  tableWeekMonday=d;
  updateTableWeekLabel();
  pg=1;renderTable();
}

function tableWeekReset(){
  tableWeekMonday=null;
  updateTableWeekLabel();
  pg=1;renderTable();
}

function updateTableWeekLabel(){
  const el=document.getElementById('s-week-label');
  if(!el) return;
  if(!tableWeekMonday){
    el.textContent='Todas as semanas';
    el.style.color='var(--cyan)';
    return;
  }
  const sun=new Date(tableWeekMonday);sun.setDate(sun.getDate()+6);
  const fmt=d=>d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
  el.textContent=`${fmt(tableWeekMonday)} – ${fmt(sun)}`;
  el.style.color='var(--warn)';
}

// ===== TABLE =====
function getFiltered(){
   const q=document.getElementById('s-query').value.toLowerCase();
  const m=document.getElementById('s-maq').value;
  const s=document.getElementById('s-status').value;
  return records.filter(r=>{
    if(q&&!r.produto.toLowerCase().includes(q)) return false;
    if(m&&r.maquina!==m) return false;
    if(s&&r.status!==s) return false;
    if(tableWeekMonday){
      if(!r.dtDesejada) return false;
      const rd=new Date(r.dtDesejada+'T12:00:00');
      const sun=new Date(tableWeekMonday);sun.setDate(sun.getDate()+6);sun.setHours(23,59,59,999);
      if(rd<tableWeekMonday||rd>sun) return false;
    }
    return true;
  }).sort((a,b)=>b.id-a.id);
}

function renderTable(){
  const filtered=getFiltered();
  const total=filtered.length;
  const pages=Math.max(1,Math.ceil(total/PER));
  if(pg>pages) pg=pages;
  const slice=filtered.slice((pg-1)*PER,pg*PER);
  const tbody=document.getElementById('tbody');
  impLoadFromStorage();

  if(!slice.length){
    tbody.innerHTML=`<tr><td colspan="10"><div class="empty"><div class="ei">🔍</div>Nenhum registro encontrado</div></td></tr>`;
  } else {
    tbody.innerHTML=slice.map((r,i)=>{
      const n=(pg-1)*PER+i+1;
      const tempo=calcTempoStr(r.maquina,r.qntCaixas,r.qntUnid,r.pcMin,r.unidPorCx);
      const insumosLista = calcConsumoInsumosRegistro(r);
      const temInsumos = insumosLista.length > 0;
      const faltaInsumo = insumosLista.some(i => i.falta);
      const rowId = `prog-ins-${r.id}`;

      // Badge de insumos
      let insBadge = '';
      if(!temInsumos){
        insBadge = `<span style="background:rgba(255,255,255,.05);color:var(--text3);padding:2px 5px;border-radius:4px;font-size:9px">—</span>`;
      } else if(faltaInsumo){
        insBadge = `<button onclick="progToggleInsumos('${rowId}')" style="background:rgba(255,71,87,.18);border:none;color:var(--red);padding:2px 7px;border-radius:4px;font-size:10px;cursor:pointer;font-weight:700" title="Ver insumos">⚠️ Falta MP</button>`;
      } else if(insumosEstoqueData.length){
        insBadge = `<button onclick="progToggleInsumos('${rowId}')" style="background:rgba(46,201,122,.1);border:none;color:var(--green);padding:2px 7px;border-radius:4px;font-size:10px;cursor:pointer" title="Ver insumos">✅ MP OK</button>`;
      } else {
        insBadge = `<button onclick="progToggleInsumos('${rowId}')" style="background:rgba(255,255,255,.06);border:none;color:var(--text3);padding:2px 7px;border-radius:4px;font-size:10px;cursor:pointer" title="Ver insumos">📋 Insumos</button>`;
      }

      const rowBg = faltaInsumo ? 'background:rgba(255,71,87,.04);' : '';

      // Detalhe de insumos colapsável
      let insDetail = '';
      if(temInsumos){
        insDetail = `<tr id="${rowId}" style="display:none">
          <td colspan="10" style="padding:0">
            <div style="background:var(--s2);border-top:1px solid var(--border);padding:10px 16px">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px;font-weight:700">Consumo de Insumos — ${r.produto} (${r.qntCaixas} cx)</div>
              <table style="width:100%;border-collapse:collapse;font-size:11px;max-width:700px">
                <thead><tr style="background:rgba(255,255,255,.03)">
                  <th style="padding:5px 8px;text-align:left;color:var(--text3);font-size:10px">Insumo</th>
                  <th style="padding:5px 8px;text-align:right;color:var(--warn);font-size:10px">Necessário</th>
                  <th style="padding:5px 8px;text-align:right;color:var(--cyan);font-size:10px">Estoque Atual</th>
                  <th style="padding:5px 8px;text-align:right;color:var(--text3);font-size:10px">Saldo Final</th>
                </tr></thead>
                <tbody>${insumosLista.map(ins => {
                  const sc = ins.falta ? 'var(--red)' : ins.estoqueAtual!=null ? 'var(--green)' : 'var(--text3)';
                  const bg2 = ins.falta ? 'background:rgba(255,71,87,.07)' : '';
                  const estoqueStr = ins.estoqueAtual != null ? ins.estoqueAtual.toLocaleString('pt-BR',{maximumFractionDigits:3}) : '<span style="color:var(--text4)">Sem estoque MP</span>';
                  const saldoStr = ins.saldoFinal != null ? ins.saldoFinal.toLocaleString('pt-BR',{maximumFractionDigits:3}) : '—';
                  return `<tr style="${bg2}">
                    <td style="padding:5px 8px;color:var(--text)">${ins.nome}</td>
                    <td style="padding:5px 8px;text-align:right;color:var(--warn);font-family:'JetBrains Mono',monospace">${ins.consumoNecessario.toLocaleString('pt-BR',{maximumFractionDigits:3})}</td>
                    <td style="padding:5px 8px;text-align:right;font-family:'JetBrains Mono',monospace">${estoqueStr}</td>
                    <td style="padding:5px 8px;text-align:right;color:${sc};font-family:'JetBrains Mono',monospace;font-weight:700">${saldoStr}${ins.falta?' ⚠️':''}</td>
                  </tr>`;
                }).join('')}</tbody>
              </table>
            </div>
          </td>
        </tr>`;
      }

      return `<tr style="${rowBg}">
        <td style="color:var(--text3);font-family:'JetBrains Mono',monospace;font-size:11px">${n}</td>
        <td style="max-width:300px">
          <div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px" title="${r.produto}">${r.produto}</div>
          ${r.obs?`<div style="font-size:10px;color:var(--text3);margin-top:1px">${r.obs}</div>`:''}
        </td>
        <td><span class="badge b-maq">${r.maquina}</span></td>
        <td style="text-align:right;color:var(--cyan);font-family:'JetBrains Mono',monospace;font-weight:500">${r.qntCaixas}</td>
        <td style="text-align:right;color:var(--text2);font-family:'JetBrains Mono',monospace">${r.qntUnid?r.qntUnid.toLocaleString('pt-BR'):'—'}</td>
        <td style="text-align:right;color:var(--text2);font-family:'JetBrains Mono',monospace;font-size:11px">${tempo}</td>
        <td style="color:var(--text2);font-family:'JetBrains Mono',monospace;font-size:12px">${r.dtDesejada||'—'}</td>
        <td>${sBadge(r.status)}</td>
        <td style="text-align:center">${insBadge}</td>
        <td>
          <div style="display:flex;gap:5px">
            <button class="btn btn-edit" onclick="editRec('${r.id}')" style="padding:4px 9px;font-size:11px" title="Editar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn btn-danger" onclick="askDel('${r.id}')" style="padding:4px 9px;font-size:11px">🗑</button>
          </div>
        </td>
      </tr>${insDetail}`;
    }).join('');
  }

  // Pagination
  const pEl=document.getElementById('pag');
  if(pages<=1){pEl.innerHTML='';document.getElementById('pg-info').textContent=`${total} registro(s)`;return;}
  let h='';
  h+=`<button class="pg" onclick="goPg(${pg-1})" ${pg===1?'disabled':''}>‹</button>`;
  for(let i=1;i<=pages;i++){
    if(pages>8&&i>3&&i<pages-2&&Math.abs(i-pg)>1){
      if(i===4||i===pages-3) h+=`<span style="color:var(--text3);padding:0 4px">…</span>`;
      continue;
    }
    h+=`<button class="pg ${i===pg?'on':''}" onclick="goPg(${i})">${i}</button>`;
  }
  h+=`<button class="pg" onclick="goPg(${pg+1})" ${pg===pages?'disabled':''}>›</button>`;
  pEl.innerHTML=h;
  document.getElementById('pg-info').textContent=`Mostrando ${(pg-1)*PER+1}–${Math.min(pg*PER,total)} de ${total}`;
}

function goPg(p){pg=p;renderTable()}

function clearFilters(){
  document.getElementById('s-query').value='';
  document.getElementById('s-maq').value='';
  document.getElementById('s-status').value='';
  tableWeekReset();
  updateSearchX();updateMaqX();updateStatusX();
  pg=1;renderTable();
}

function updateSearchX(){
  const x=document.getElementById('s-query-x');
  if(x) x.style.display=document.getElementById('s-query').value?'block':'none';
}
function clearSearchQuery(){
  document.getElementById('s-query').value='';
  updateSearchX();pg=1;renderTable();
}
function updateMaqX(){
  const x=document.getElementById('s-maq-x');
  if(x) x.style.display=document.getElementById('s-maq').value?'inline':'none';
}
function clearMaq(){
  document.getElementById('s-maq').value='';
  updateMaqX();pg=1;renderTable();
}
function updateStatusX(){
  const x=document.getElementById('s-status-x');
  if(x) x.style.display=document.getElementById('s-status').value?'inline':'none';
}
function clearStatus(){
  document.getElementById('s-status').value='';
  updateStatusX();pg=1;renderTable();
}

async function confirmClearAll(){
  if(!confirm('⚠️ Tem certeza que deseja apagar TODA a programação?\n\nEsta ação não pode ser desfeita!')) return;
  try{
    const snap = await getDocs(collection(firestoreDB, 'registros'));
    const dels = snap.docs.map(d => deleteDoc(doc(firestoreDB, 'registros', d.id)));
    await Promise.all(dels);
    await reload();
    if(typeof showToast==='function') showToast('Programação apagada com sucesso.','ok');
    else alert('Programação apagada com sucesso!');
  }catch(e){alert('Erro ao limpar: '+e);}
}

function calcTempoStr(maq,caixas,unid,pcMinRec,unidRec){
  let pcMin = pcMinRec;
  if (!pcMin && maq && window.MAQUINAS_DATA) {
    const maqData = window.MAQUINAS_DATA[maq];
    if (maqData && maqData.pcMin) pcMin = maqData.pcMin;
  }
  if (!pcMin) pcMin = (getAllProdutos().find(x=>x.maquina===maq)||{pc_min:1}).pc_min;
  const unidCx=unidRec||(getAllProdutos().find(x=>x.maquina===maq)||{unid:1}).unid;
  if(!caixas) return '—';
  const u=unid||(caixas*unidCx);
  return fmtHrs(u/pcMin/60);
}

function sBadge(s){
  if(s==='Concluído') return `<span class="badge b-ok">✓ Concluído</span>`;
  if(s==='Em Andamento') return `<span class="badge b-and">⟳ Em Andamento</span>`;
  return `<span class="badge b-pend">● Pendente</span>`;
}



// Format hours nicely: 22.8h → "22h48min", 0.13h → "08min", 9.41h → "9h25min"
// Zero-pads minutes < 10 as requested (e.g. "10h08min")
function fmtHrs(h){
  if(!h||h<=0) return '—';
  const totalMin=Math.round(h*60);
  if(totalMin<60){
    const m=String(totalMin).padStart(2,'0');
    return m+'min';
  }
  const hh=Math.floor(totalMin/60);
  const mm=totalMin%60;
  return mm>0?`${hh}h${String(mm).padStart(2,'0')}min`:`${hh}h`;
}

// Central helper: get reliable pc_min and unid for a record
function getProdInfo(rec){
  const all = getAllProdutos();
  // Priority 1: match by product code (most reliable)
  if(rec.prodCod){
    const byCode=all.find(x=>x.cod===rec.prodCod);
    if(byCode) return byCode;
  }
  // Priority 2: match by machine + product name prefix
  const byName=all.find(x=>x.maquina===rec.maquina&&rec.produto&&rec.produto.startsWith(x.descricao.substring(0,22)));
  if(byName) return byName;
  // Priority 3: use stored pcMin/unidPorCx from record itself
  if(rec.pcMin&&rec.unidPorCx) return {pc_min:rec.pcMin, unid:rec.unidPorCx};
  // Priority 4: check machine data from Firestore
  const maqData = getMaquinaData(rec.maquina);
  if (maqData && maqData.pcMin) return {pc_min: parseFloat(maqData.pcMin), unid: rec.unidPorCx || 1};
  // Priority 5: first product of same machine
  const byMaq=all.find(x=>x.maquina===rec.maquina);
  return byMaq||{pc_min:1,unid:1};
}

// ===== MÁQUINAS =====
function renderMaquinas(){
  const grid = document.getElementById('maq-grid');
  // Mostra aviso se nenhuma máquina cadastrada no Firestore
  if (!MAQUINAS.length) {
    if(grid) grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text3);font-size:13px">'
      + '⚙️ Nenhuma máquina cadastrada no Firestore.<br>'
      + '<span style="font-size:11px">Cadastre em <strong>Configurações → Máquinas → + Adicionar Máquina</strong></span></div>';
    return;
  }
  // Apply week filter
  let filteredRecs = records.filter(r=>r.status!=='Concluído');
  if(maqWeekFilter){
    const m=new Date(maqWeekFilter+'T12:00:00');
    const sun=new Date(m); sun.setDate(m.getDate()+6);
    const ms=dateStr(m), ss=dateStr(sun);
    filteredRecs=filteredRecs.filter(r=>{const d=r.dtDesejada||r.dtSolicitacao;return d&&d>=ms&&d<=ss;});
  }
  // Compute real weekly capacity from the actual dates of the filtered records
  // Seg–Qui = 9h, Sex = 8h (DAY_HRS), or use DIA_SEMANA_HRS if date is mapped
  // Collect unique dates from filtered records to find the week
  let WEEK_AVAIL_HRS;
  if(maqWeekFilter){
    // Use the exact week from the filter
    const mon=new Date(maqWeekFilter+'T12:00:00');
    WEEK_AVAIL_HRS=getWeekDays(mon).reduce((a,d)=>a+hoursOnDay(d),0);
  } else if(filteredRecs.length>0){
    // Use most recent record's week
    const sorted=[...filteredRecs].filter(r=>r.dtDesejada||r.dtSolicitacao).sort((a,b)=>{const da=b.dtDesejada||b.dtSolicitacao||'';const db=a.dtDesejada||a.dtSolicitacao||'';return da.localeCompare(db);});
    const mon=sorted.length>0?getWeekMonday(new Date((sorted[0].dtDesejada||sorted[0].dtSolicitacao)+'T12:00:00')):getWeekMonday(new Date());
    WEEK_AVAIL_HRS=getWeekDays(mon).reduce((a,d)=>a+hoursOnDay(d),0);
  } else {
    // Default: Mon–Fri standard week (9+9+9+9+8 = 44h)
    WEEK_AVAIL_HRS=DAY_HRS.reduce((a,b)=>a+b,0);
  }

  const map={};
  MAQUINAS.forEach(m=>map[m]={items:[],caixas:0,min:0});
  filteredRecs.forEach(r=>{
    if(!map[r.maquina]) map[r.maquina]={items:[],caixas:0,min:0};
    map[r.maquina].items.push(r);
    map[r.maquina].caixas+=r.qntCaixas||0;
  });
  // Per-machine capacity: use real machine hours from turnosMaquinas config
  // Determine the reference monday: from filter, from records, or current week
  const refMon = maqWeekFilter
    ? new Date(maqWeekFilter + 'T12:00:00')
    : (filteredRecs.length > 0
        ? (() => {
            const sorted2 = [...filteredRecs].filter(r=>r.dtDesejada||r.dtSolicitacao)
              .sort((a,b)=>(b.dtDesejada||b.dtSolicitacao||'').localeCompare(a.dtDesejada||a.dtSolicitacao||''));
            return getWeekMonday(new Date((sorted2[0].dtDesejada||sorted2[0].dtSolicitacao)+'T12:00:00'));
          })()
        : getWeekMonday(new Date()));

  // Usar buildSchedule para calcular horas REAIS por máquina na semana de refMon
  // (distribui corretamente pelos blocos/turnos configurados)
  if(typeof buildSchedule==='function'){
    const {schedule:sched} = buildSchedule(refMon);
    MAQUINAS.forEach(m=>{
      const entries=sched[m]||[];
      let minTot=0;
      entries.forEach(({segments,setupSegments})=>{
        segments.forEach(s=>{ minTot+=s.hrsNoDia*60; });
        (setupSegments||[]).forEach(s=>{ minTot+=s.setupMin; });
      });
      map[m].min=minTot;
    });
  } else {
    // fallback: soma simples se buildSchedule não disponível
    filteredRecs.forEach((r,idx,arr)=>{
      const p=getProdInfo(r);
      const totalUnid=r.qntUnid||(r.qntCaixas*(p.unid||1));
      if(p.pc_min) map[r.maquina].min+=totalUnid/p.pc_min;
      const prevSameMaq=arr.slice(0,idx).filter(x=>x.maquina===r.maquina).pop();
      if(prevSameMaq) map[r.maquina].min+=getSetupMin(r.maquina, prevSameMaq.produto, r.produto);
    });
  }
  function maqWeekHrs(maq){
    if(typeof weekHoursMaq === 'function') return weekHoursMaq(refMon, maq);
    return WEEK_AVAIL_HRS;
  }
  function maqPct(usedHrs, maq){
    const cap=maqWeekHrs(maq);
    if(!cap) return 0;
    return Math.min(100,parseFloat((usedHrs/cap*100).toFixed(1)));
  }
  function maqColor(pct){return pct>100?'var(--red)':pct>=80?'var(--warn)':'var(--cyan)';}
  function barColor(pct){return pct>100?'var(--red)':pct>=80?'var(--warn)':'var(--cyan)';}

  if(maqViewMode==='list'){
    let html=`<div class="maq-list-view">
      <div class="maq-list-row" style="background:var(--s2);font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">
        <span>Máquina</span><span>Ocupação da Semana</span><span>Caixas</span><span>Prog. / Disp.</span><span>% Máquina</span>
      </div>`;
    MAQUINAS.forEach(m=>{
      const d=map[m];
      const usedHrs=d.min/60;
      const capHrs=maqWeekHrs(m);
      const pct=maqPct(usedHrs,m);
      const displayPct=Math.min(100,pct);
      const hrs=fmtHrs(usedHrs);
      const col=maqColor(pct);
      const overPct=pct>100?`<span style="color:var(--red);font-size:9px;margin-left:4px">+${(pct-100).toFixed(0)}% over</span>`:'';
      html+=`<div class="maq-list-row">
        <div style="font-family:'JetBrains Mono',monospace;font-weight:500;font-size:13px;color:var(--purple)">${m}</div>
        <div>
          <div class="maq-bar-bg" style="margin:0"><div class="maq-bar" style="width:${displayPct}%;background:${col}"></div></div>
          <div style="font-size:10px;color:var(--text3);margin-top:3px;font-family:'JetBrains Mono',monospace">${d.items.length} solicit.</div>
        </div>
        <div style="color:${col};font-family:'JetBrains Mono',monospace;font-weight:600">${d.caixas} cx</div>
        <div style="color:var(--text2);font-family:'JetBrains Mono',monospace;font-size:11px">
          <span style="color:${col};font-weight:700">${hrs}</span>
          <span style="color:var(--text3)"> / ${capHrs}h</span>
        </div>
        <div style="color:${col};font-family:'JetBrains Mono',monospace;font-weight:700">${pct}%${overPct}</div>
      </div>`;
    });
    html+=`</div>`;
    document.getElementById('maq-grid').className='';
    document.getElementById('maq-grid').innerHTML=html;
  } else {
    document.getElementById('maq-grid').className='maq-grid';
    document.getElementById('maq-grid').innerHTML=MAQUINAS.map(m=>{
      const d=map[m];
      const usedHrs=d.min/60;
      const capHrs=maqWeekHrs(m);
      const pct=maqPct(usedHrs,m);
      const displayPct=Math.min(100,pct);
      const hrs=fmtHrs(usedHrs);
      const col=maqColor(pct);
      const items=d.items.slice(0,4).map(r=>`<div class="maq-li">· ${r.produto.substring(0,38)}${r.produto.length>38?'...':''} <strong style="color:var(--text)">${r.qntCaixas}cx</strong></div>`).join('');
      const more=d.items.length>4?`<div class="maq-li" style="color:var(--text3)">+${d.items.length-4} mais...</div>`:'';
      const overFlag=pct>100?`<div style="font-size:9px;color:var(--red);margin-top:2px;font-family:'JetBrains Mono',monospace">⚠ Excede em ${(pct-100).toFixed(0)}%</div>`:'';
      // Active shifts summary
      let turnosSumario='';
      if(typeof getTurnosMaquinaDia==='function'){
        const t=getTurnosMaquinaDia(m,1);
        const ativos=['T1','T2','T3'].filter((_,i)=>t[i]);
        turnosSumario=ativos.length?`<div style="font-size:9px;color:var(--text3);font-family:'JetBrains Mono',monospace;margin-top:2px">Turnos Seg: ${ativos.join(' + ')}</div>`:'';
      }
      return `<div class="maq-card" style="cursor:pointer" onclick="toggleMaqCardDetail('maqcard-${m.replace(/[^a-zA-Z0-9]/g,'_')}')">
        <div class="maq-title">${m}</div>
        ${turnosSumario}
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2);font-family:'JetBrains Mono',monospace;margin-top:4px">
          <span>${d.items.length} solicit.</span>
          <span><strong style="color:${col}">${d.caixas}</strong> caixas</span>
        </div>
        <div class="maq-bar-bg"><div class="maq-bar" style="width:${displayPct}%;background:${col}"></div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-family:'JetBrains Mono',monospace;font-size:11px;margin-top:4px">
          <span style="color:var(--text3)">Prog:</span>
          <span style="color:${col};font-weight:700">${hrs}</span>
          <span style="color:var(--text3)">/ ${capHrs}h disp.</span>
          <span style="color:${col};font-weight:700;font-size:12px">${pct}%</span>
        </div>
        ${overFlag}
        ${d.items.length?`<div class="maq-list">${items}${more}</div>`:''}
        <div id="maqcard-${m.replace(/[^a-zA-Z0-9]/g,'_')}" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">${buildMaqCardDetail(m)}</div>
        <div style="text-align:center;margin-top:6px;font-size:10px;color:var(--text3)">▾ detalhes</div>
      </div>`;
    }).join('');
  }
}

// ===== DETALHES DA MÁQUINA (ACCORDION NO CARD) =====
function buildMaqCardDetail(nomeMaq) {
  const d = getMaquinaData(nomeMaq);
  if (!d) return '<div style="font-size:11px;color:var(--text3);padding:8px">Sem cadastro. Configure em <strong>Configurações → Máquinas</strong>.</div>';
  const cap = d.pcMin ? calcCapacidadeMaquina(d.pcMin, d.eficiencia, d.hTurno, d.nTurnos) : null;
  const prods = Array.isArray(d.produtosCompativeis) ? d.produtosCompativeis : [];
  const statusColor = d.status === 'inativa' ? '#ff6b6b' : '#00d46a';
  const tempoSetup = (d.tempoSetupPadrao && parseFloat(d.tempoSetupPadrao) > 0) ? parseFloat(d.tempoSetupPadrao) + ' min' : '—';

  // Grid de capacidade
  let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:11px;font-family:\'JetBrains Mono\',monospace;margin-bottom:8px">'
    + '<div><span style="color:var(--text3)">Setor:</span> <span style="color:var(--text2)">' + (d.setor || '—') + '</span></div>'
    + '<div><span style="color:var(--text3)">Status:</span> <span style="color:' + statusColor + ';font-weight:700">' + ((d.status || 'ativa').toUpperCase()) + '</span></div>'
    + '<div><span style="color:var(--text3)">Vel. padrão:</span> <span style="color:var(--warn);font-weight:700">' + (d.pcMin ? d.pcMin + ' saq/min' : '<span style="color:#ff6b6b">⚠ não config.</span>') + '</span></div>'
    + '<div><span style="color:var(--text3)">Eficiência:</span> <span>' + (d.eficiencia != null ? d.eficiencia + '%' : '—') + '</span></div>'
    + '<div><span style="color:var(--text3)">Turnos/dia:</span> <span>' + (d.nTurnos || '—') + '</span></div>'
    + '<div><span style="color:var(--text3)">Hrs/turno:</span> <span>' + (d.hTurno || '—') + '</span></div>'
    + '<div><span style="color:var(--text3)">Setup padrão:</span> <span>' + tempoSetup + '</span></div>'
    + (cap ? '<div><span style="color:var(--text3)">Cap/hora:</span> <span style="color:var(--cyan)">' + cap.porHora.toLocaleString('pt-BR') + ' saq</span></div>' : '<div></div>')
    + (cap ? '<div><span style="color:var(--text3)">Cap/turno:</span> <span style="color:var(--cyan)">' + cap.porTurno.toLocaleString('pt-BR') + ' saq</span></div>' : '<div></div>')
    + (cap ? '<div><span style="color:var(--text3)">Cap/dia:</span> <span style="color:var(--cyan);font-weight:700">' + cap.porDia.toLocaleString('pt-BR') + ' saq</span></div>' : '<div></div>')
    + '</div>';

  // Lista de produtos com velocidade específica
  if (!prods.length) {
    html += '<div style="font-size:11px;color:var(--warn);background:rgba(255,179,0,.08);border:1px solid rgba(255,179,0,.2);border-radius:6px;padding:6px 10px;margin-top:4px">'
      + '⚠️ Sem produtos vinculados. Edite a máquina → aba <strong>Produtos Compatíveis</strong>.</div>';
  } else {
    html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:var(--purple);font-weight:700;margin-bottom:4px;margin-top:2px">Produtos (' + prods.length + ')</div>';
    html += prods.map(function(p) {
      const vel = p.velocidade != null
        ? '<span style="color:var(--cyan);font-family:\'JetBrains Mono\',monospace">' + p.velocidade + ' saq/min</span>'
        : '<span style="color:var(--text3)">padrão' + (d.pcMin ? ' (' + d.pcMin + ')' : '') + '</span>';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px">'
        + '<span style="color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px">' + p.produto + '</span>'
        + vel + '</div>';
    }).join('');
  }
  return html;
}

function toggleMaqCardDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : 'block';
}

// ===== FORM =====
function populateMaqSelect(){
  const sel=document.getElementById('f-maq-form');
  sel.innerHTML='<option value="">— Selecione a máquina —</option>';
  MAQUINAS.forEach(m=>{const o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o)});
}

function openForm(rec){
  populateMaqSelect();
  document.getElementById('edit-id').value=rec?rec.id:'';
  document.getElementById('form-title').textContent=rec?'Editar Solicitação':'Nova Solicitação';
  document.getElementById('p-cod').value=rec?rec.prodCod:'';
  document.getElementById('p-maq-val').value=rec?rec.maquina:'';
  document.getElementById('p-pcmin-val').value=rec?rec.pcMin:'';
  document.getElementById('p-unid-val').value=rec?rec.unidPorCx:'';
  document.getElementById('f-qnt').value=rec?rec.qntCaixas:'';
  document.getElementById('f-status').value=rec?rec.status:'Pendente';
  // For new records: use the currently selected Gantt week's Monday as default start date
  const defaultDate = rec
    ? (rec.dtDesejada||rec.dtSolicitacao)
    : (ganttBaseMonday ? dateStr(ganttBaseMonday) : new Date().toISOString().slice(0,10));
  document.getElementById('f-dtsolicit').value=defaultDate;
  document.getElementById('f-obs').value=rec?(rec.obs||''):'';
  document.getElementById('calc-panel').classList.remove('on');

  if(rec){
    // Editing: set machine and show product
    document.getElementById('f-maq-form').value=rec.maquina;
    showProdStep(rec.maquina);
    setProdSelected({descricao:rec.produto,cod:rec.prodCod,maquina:rec.maquina,pc_min:rec.pcMin,unid:rec.unidPorCx});
    calcInfo();
  } else {
    document.getElementById('step-produto').style.display='none';
    document.getElementById('prod-selected').style.display='none';
  }
  document.getElementById('modal-form').classList.add('on');
}

function onMaqChange(){
  const maq=document.getElementById('f-maq-form').value;
  clearProd();
  if(!maq){document.getElementById('step-produto').style.display='none';return;}
  showProdStep(maq);
}

function showProdStep(maq){
  document.getElementById('step-produto').style.display='block';
  document.getElementById('p-search').value='';
  renderProdGrid(maq,'');
}

function renderProdGrid(maq, filter){
  // Busca produtos do cadastro real (Firestore + localStorage)
  // Se a máquina tiver produtos compatíveis cadastrados, usa eles como fonte primária
  const maqData = getMaquinaData(maq);
  const maqProds = maqData && Array.isArray(maqData.produtosCompativeis) ? maqData.produtosCompativeis : [];
  
  let prods = getAllProdutos().filter(p => p.maquina === maq && (
    !filter || p.descricao.toLowerCase().includes(filter.toLowerCase())
  ));
  
  // Se não achou no catálogo mas a máquina tem produtos compatíveis, constrói lista a partir deles
  if (!prods.length && maqProds.length) {
    prods = maqProds
      .filter(p => !filter || p.produto.toLowerCase().includes(filter.toLowerCase()))
      .map(p => ({
        descricao: p.produto, cod: 0, unid: 1,
        pc_min: p.velocidade || (maqData && maqData.pcMin) || 0,
        maquina: maq, kg_fd: 0
      }));
  }
  const grid=document.getElementById('prod-grid');
  if(!prods.length){
    grid.innerHTML=`<div style="grid-column:1/-1;padding:16px;text-align:center;color:var(--text3);font-size:12px">Nenhum produto encontrado</div>`;
    return;
  }
  grid.innerHTML=prods.map((p,i)=>`
    <div onclick="pickProdGrid(${i},'${maq.replace(/'/g,"\\'")}','${filter.replace(/'/g,"\\'")}',event)"
      style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;cursor:pointer;transition:all .15s"
      onmouseover="this.style.borderColor='var(--cyan)';this.style.background='rgba(0,229,204,.07)'"
      onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--s2)'">
      <div style="font-size:11px;color:var(--text);line-height:1.4">${p.descricao}</div>
      <div style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace;margin-top:4px">Cód:${p.cod} · ${p.pc_min}pc/min · ${p.unid}un/cx</div>
    </div>`).join('');
  grid._prods=prods;
}

function pickProdGrid(idx,maq,filter,e){
  e&&e.stopPropagation();
  const grid=document.getElementById('prod-grid');
  const prods=grid._prods;
  if(!prods||!prods[idx]) return;
  setProdSelected(prods[idx]);
}

function setProdSelected(p){
  document.getElementById('p-cod').value=p.cod;
  document.getElementById('p-maq-val').value=p.maquina;
  document.getElementById('p-pcmin-val').value=p.pc_min;
  document.getElementById('p-unid-val').value=p.unid;
  document.getElementById('sel-nome').textContent=p.descricao;
  document.getElementById('sel-info').textContent=`Cód:${p.cod} · ${p.maquina} · ${p.pc_min}pc/min · ${p.unid}un/cx`;
  document.getElementById('prod-selected').style.display='block';
  document.getElementById('prod-grid').style.display='none';
  document.getElementById('p-search').style.display='none';
  closeAC();
  calcInfo();
}

function clearProd(){
  document.getElementById('p-cod').value='';
  document.getElementById('p-maq-val').value='';
  document.getElementById('p-pcmin-val').value='';
  document.getElementById('p-unid-val').value='';
  document.getElementById('prod-selected').style.display='none';
  document.getElementById('prod-grid').style.display='grid';
  document.getElementById('p-search').style.display='block';
  document.getElementById('p-search').value='';
  document.getElementById('calc-panel').classList.remove('on');
  const mrpEl = document.getElementById('mrp-insumos-panel');
  if(mrpEl) mrpEl.style.display='none';
  const maq=document.getElementById('f-maq-form').value;
  if(maq) renderProdGrid(maq,'');
}

function closeForm(){
  document.getElementById('modal-form').classList.remove('on');
  closeAC();
}

function editRec(id){
  // id may be string or number — compare loosely
  const r=records.find(x=>String(x.id)===String(id));
  if(r) openForm(r);
  else toast('Registro não encontrado. Recarregue a página.','err');
}

async function saveForm(){
  const pCod=document.getElementById('p-cod').value;
  const pMaq=document.getElementById('p-maq-val').value;
  const pcMin=parseFloat(document.getElementById('p-pcmin-val').value)||0;
  const unidPorCx=parseInt(document.getElementById('p-unid-val').value)||0;
  const pNome=document.getElementById('sel-nome').textContent;
  const qnt=parseInt(document.getElementById('f-qnt').value);
  const dtS=document.getElementById('f-dtsolicit').value;
  const selMaq=document.getElementById('f-maq-form').value;

  if(!selMaq){toast('Selecione a máquina','err');return;}
  if(!pCod||pNome==='—'){toast('Selecione um produto da lista','err');return;}
  if(!qnt||qnt<1){toast('Informe a quantidade em caixas','err');return;}
  if(!dtS || !/^\d{4}-\d{2}-\d{2}$/.test(dtS)){toast('Informe uma data de início válida (AAAA-MM-DD)','err');return;}
  // Validação extra: data não pode ser muito antiga
  const dtObj = new Date(dtS + 'T12:00:00');
  if (isNaN(dtObj.getTime())) { toast('Data inválida','err'); return; }

  const eid=document.getElementById('edit-id').value;
  const dtFinal = dtS || new Date().toISOString().slice(0,10);
  const obj={
    produto:pNome,prodCod:parseInt(pCod),maquina:pMaq||selMaq,pcMin,unidPorCx,
    qntCaixas:qnt,qntUnid:qnt*unidPorCx,
    status:document.getElementById('f-status').value,
    dtSolicitacao:dtFinal,
    dtDesejada:dtFinal,
    obs:document.getElementById('f-obs').value.trim(),
    updatedAt:new Date().toISOString()
  };
  if(eid) obj.id=eid;

  try {
    await dbPut(obj);
  } catch(err) {
    toast('Erro ao salvar: ' + (err.message||err), 'err');
    console.error('saveForm dbPut error:', err);
    return;
  }
  closeForm();
  await reload();
  toast(eid?'Solicitação atualizada!':'Solicitação criada!','ok');
}

// ===== DELETE =====
let delId=null;
function askDel(id){delId=String(id);document.getElementById('conf-overlay').classList.add('on')}
function closeConf(){document.getElementById('conf-overlay').classList.remove('on');delId=null}
async function doDelete(){
  if(!delId) return;
  // delId is always a string (Firestore doc ID)
  const r=records.find(x=>String(x.id)===String(delId));
  if(!r){ toast('Registro não encontrado.','err'); closeConf(); return; }
  await dbDel(r.id);
  closeConf();
  await reload();
  toast('Solicitação excluída','ok');
}

// ===== AUTOCOMPLETE (filtro sobre a grade) =====
function onACInput(){
  const q=document.getElementById('p-search').value.trim();
  const maq=document.getElementById('f-maq-form').value;
  if(!maq) return;
  renderProdGrid(maq,q);
  closeAC();
}

function closeAC(){document.getElementById('ac-drop').classList.remove('on')}

// ===== CALC =====
function calcInfo(){
  const qnt=parseInt(document.getElementById('f-qnt').value)||0;
  const pcMin=parseFloat(document.getElementById('p-pcmin-val').value)||0;
  const unid=parseInt(document.getElementById('p-unid-val').value)||0;
  const panel=document.getElementById('calc-panel');
  if(!qnt||!pcMin||!unid){panel.classList.remove('on');renderMrpPanel(0);return;}
  panel.classList.add('on');
  const totalUnid=qnt*unid;
  const totalMin=Math.round(totalUnid/pcMin);
  const hrs=(totalMin/60).toFixed(1);
  const dias=Math.ceil(totalMin/600);
  document.getElementById('c-unid').textContent=totalUnid.toLocaleString('pt-BR');
  document.getElementById('c-min').textContent=totalMin.toLocaleString('pt-BR');
  document.getElementById('c-hrs').textContent=hrs;
  const dEl=document.getElementById('c-dias');
  dEl.textContent=dias;
  dEl.className='ci-val'+(dias>5?' w':'');
  renderMrpPanel(qnt);
}

// Painel MRP no modal: mostra insumos + estoque + saldo para qtd caixas
function renderMrpPanel(qntCaixas){
  const mrpEl = document.getElementById('mrp-insumos-panel');
  if(!mrpEl) return;
  const pCod = document.getElementById('p-cod').value;
  const pNome = document.getElementById('sel-nome').textContent;
  if(!pCod || pNome === '—' || !qntCaixas){ mrpEl.style.display='none'; return; }

  impLoadFromStorage();
  const insumos = findInsumosProduto(pNome, pCod);
  if(!insumos.length){ mrpEl.style.display='none'; return; }

  const fmt4 = n => n.toLocaleString('pt-BR',{maximumFractionDigits:4});

  let algumSaldoNegativo = false;
  const rows = insumos.map(ins => {
    const necessario = ins.q * qntCaixas;
    const estoqueAtual = getEstoqueInsumo(ins.n);
    const saldo = estoqueAtual != null ? estoqueAtual - necessario : null;
    if(saldo != null && saldo < 0) algumSaldoNegativo = true;
    return { ins, necessario, estoqueAtual, saldo };
  }).filter(r => r.necessario > 0);

  if(!rows.length){ mrpEl.style.display='none'; return; }

  const headerColor = algumSaldoNegativo ? 'var(--red)' : 'var(--green)';
  const headerIcon  = algumSaldoNegativo ? '⚠️' : '✅';
  const headerLabel = algumSaldoNegativo ? 'Insumos — estoque insuficiente' : 'Insumos — estoque suficiente';

  let html = `<div style="margin-top:14px;border:1px solid ${algumSaldoNegativo?'rgba(255,71,87,.35)':'rgba(46,201,122,.25)'};border-radius:8px;overflow:hidden">
    <div style="padding:7px 12px;background:${algumSaldoNegativo?'rgba(255,71,87,.08)':'rgba(46,201,122,.07)'};display:flex;align-items:center;gap:6px;border-bottom:1px solid ${algumSaldoNegativo?'rgba(255,71,87,.2)':'rgba(46,201,122,.15)'}">
      <span style="font-size:11px;font-weight:700;color:${headerColor}">${headerIcon} ${headerLabel}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:10px">
      <thead><tr style="background:var(--s2)">
        <th style="padding:5px 10px;text-align:left;color:var(--text3);font-size:9px">Insumo</th>
        <th style="padding:5px 8px;text-align:right;color:var(--warn);font-size:9px">Necessário</th>
        <th style="padding:5px 8px;text-align:right;color:var(--cyan);font-size:9px">Estoque</th>
        <th style="padding:5px 8px;text-align:right;font-size:9px">Saldo</th>
      </tr></thead>
      <tbody>`;

  rows.forEach(({ins, necessario, estoqueAtual, saldo}) => {
    const semEstoque = estoqueAtual == null;
    const negativo   = saldo != null && saldo < 0;
    const saldoColor = negativo ? 'var(--red)' : semEstoque ? 'var(--text3)' : 'var(--green)';
    const rowBg      = negativo ? 'background:rgba(255,71,87,.05)' : '';
    const saldoStr   = semEstoque ? '<span style="color:var(--text4);font-size:9px">sem dados</span>'
                                  : `<span style="font-weight:700;color:${saldoColor}">${fmt4(saldo)}${negativo?' ⚠️':''}</span>`;
    const estoqueStr = semEstoque ? '<span style="color:var(--text4);font-size:9px">—</span>'
                                  : `<span style="color:var(--cyan)">${fmt4(estoqueAtual)}</span>`;
    html += `<tr style="${rowBg}">
      <td style="padding:4px 10px;color:var(--text2)">${ins.n}</td>
      <td style="padding:4px 8px;text-align:right;color:var(--warn);font-family:'JetBrains Mono',monospace">${fmt4(necessario)}</td>
      <td style="padding:4px 8px;text-align:right;font-family:'JetBrains Mono',monospace">${estoqueStr}</td>
      <td style="padding:4px 8px;text-align:right;font-family:'JetBrains Mono',monospace">${saldoStr}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;
  mrpEl.innerHTML = html;
  mrpEl.style.display = 'block';
}

// ===== GANTT ENGINE =====
// Hours per day: Mon=9,Tue=9,Wed=9,Thu=9,Fri=8,Sat=0,Sun=0
const DAY_HRS=[0,9,9,9,9,8,0,0]; // index by getDay() (0=Sun)
const DIA_SEMANA_HRS={"2026-02-16":9,"2026-02-17":9,"2026-02-18":9,"2026-02-19":9,"2026-02-20":8,"2026-02-21":0,"2026-02-22":0,"2026-02-23":9,"2026-02-24":9,"2026-02-25":9,"2026-02-26":9,"2026-02-27":8,"2026-02-28":0,"2026-03-01":0,"2026-03-02":9,"2026-03-03":9,"2026-03-04":9,"2026-03-05":9,"2026-03-06":8,"2026-03-07":0,"2026-03-08":0,"2026-03-09":9,"2026-03-10":9,"2026-03-11":9,"2026-03-12":9,"2026-03-13":8,"2026-03-14":0,"2026-03-15":0,"2026-03-16":9,"2026-03-17":9,"2026-03-18":9,"2026-03-19":9,"2026-03-20":8,"2026-03-21":0,"2026-03-22":0,"2026-03-23":9,"2026-03-24":9,"2026-03-25":9,"2026-03-26":9,"2026-03-27":8,"2026-03-28":0,"2026-03-29":0,"2026-03-30":9,"2026-03-31":9,"2026-04-01":9,"2026-04-02":9,"2026-04-03":8,"2026-04-04":0,"2026-04-05":0,"2026-04-06":9,"2026-04-07":9,"2026-04-08":9,"2026-04-09":9,"2026-04-10":8,"2026-04-11":0,"2026-04-12":0,"2026-04-13":9,"2026-04-14":9,"2026-04-15":9,"2026-04-16":9,"2026-04-17":8,"2026-04-18":0,"2026-04-19":0,"2026-04-20":9,"2026-04-21":9,"2026-04-22":9,"2026-04-23":9,"2026-04-24":8,"2026-04-25":0,"2026-04-26":0,"2026-04-27":9,"2026-04-28":9,"2026-04-29":9,"2026-04-30":9,"2026-05-01":8,"2026-05-02":0,"2026-05-03":0,"2026-05-04":9,"2026-05-05":9,"2026-05-06":9,"2026-05-07":9,"2026-05-08":8,"2026-05-09":0,"2026-05-10":0,"2026-05-11":9,"2026-05-12":9,"2026-05-13":9,"2026-05-14":9,"2026-05-15":8,"2026-05-16":0,"2026-05-17":0};
const BAR_COLORS=['#00e5cc','#7c6af7','#ff7043','#29d984','#ffb300','#ff4757','#00b8a9','#a78bfa','#fb923c','#4ade80','#fcd34d','#f87171','#38bdf8','#e879f9','#34d399','#f59e0b'];

let ganttBaseMonday=null; // Monday of displayed week
let ganttManualNav=false; // true when user manually navigated

function getWeekMonday(date){
  const d=new Date(date);
  const day=d.getDay();
  const diff=day===0?-6:1-day;
  d.setDate(d.getDate()+diff);
  d.setHours(0,0,0,0);
  return d;
}

function ganttToday(){
  ganttBaseMonday=getWeekMonday(new Date());
  ganttManualNav=true;
  renderGantt();
}

function ganttWeek(dir){
  if(!ganttBaseMonday) ganttBaseMonday=getWeekMonday(new Date());
  ganttBaseMonday=new Date(ganttBaseMonday);
  ganttBaseMonday.setDate(ganttBaseMonday.getDate()+dir*7);
  ganttManualNav=true;
  renderGantt();
}

function ganttGoDate(){
  const v=document.getElementById('gantt-goto').value;
  if(!v) return;
  ganttBaseMonday=getWeekMonday(new Date(v+'T12:00:00'));
  ganttManualNav=true;
  renderGantt();
}

function ganttSetWeek(val){
  if(val){
    ganttBaseMonday=new Date(val+'T12:00:00');
    ganttManualNav=true;
    renderGantt();
  }
}

function dateStr(d){return d.toISOString().slice(0,10)}

function fmtDate(d){
  return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
}

const DAY_NAMES=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const DAY_NAMES_FULL=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

// Get ordered list of 7 days starting from monday
function getWeekDays(monday){
  return Array.from({length:7},(_,i)=>{
    const d=new Date(monday);
    d.setDate(d.getDate()+i);
    return d;
  });
}

// Returns hours available on a given Date (jornada geral da fábrica)
// DAY_HRS (user jornada config) takes priority over DIA_SEMANA_HRS.
function hoursOnDay(d){
  const userHrs = DAY_HRS[d.getDay()];
  if(userHrs > 0) return userHrs;
  // day is off in jornada — check specific date overrides
  const ds = dateStr(d);
  if(DIA_SEMANA_HRS.hasOwnProperty(ds)) return DIA_SEMANA_HRS[ds]||0;
  return 0;
}

// Returns hours available on a given Date FOR A SPECIFIC MACHINE
// Uses turnosMaquinas config when available; falls back to hoursOnDay (jornada geral)
function hoursOnDayMaq(d, maq){
  if(maq && typeof hoursOnDayForMaq === 'function'){
    const maqHrs = hoursOnDayForMaq(d, maq);
    return maqHrs;
  }
  return hoursOnDay(d);
}

// Returns total week hours for a specific machine
function weekHoursMaq(monday, maq){
  if(maq && typeof weekHoursForMaq === 'function'){
    return weekHoursForMaq(monday, maq);
  }
  const days = getWeekDays(monday);
  return days.reduce((a,d) => a + hoursOnDay(d), 0);
}

// Core scheduler: given list of active records, compute a timeline per shift block.
// Returns: { schedule:{ [maquina]: [{rec, segments, setupMin, setupSegments}] }, days }
//
// segments[]: { date, dayIdx, turnoIdx, turnoLabel, caixasNoDia, hrsNoDia,
//               startPct, endPct, dayAvailHrs,
//               turnoStartMin, turnoFimMin, usedInTurnoMin, useMin }
//
// The algorithm fills shift blocks (T1/T2/T3) sequentially per machine.
// Cursor state: (dayIdx, turnoBlkIdx, usedInBlkMin)
//   dayIdx       = index in days[] (0..6)
//   turnoBlkIdx  = index in activeBlocks[] for that day
//   usedInBlkMin = minutes already consumed in the current block
function buildSchedule(monday){
  const days=getWeekDays(monday);
  const mondayStr=dateStr(days[0]);
  const sundayStr=dateStr(days[6]);

  // Include records whose dtDesejada falls within this week OR started before (overflowing)
  const ativos=records.filter(r=>{
    if(r.status==='Concluído') return false;
    const startDate=r.dtDesejada||r.dtSolicitacao;
    if(!startDate) return false;
    // Show record if it starts on or before end of this week
    return startDate<=sundayStr;
  });

  // Group by machine, respect sortOrder field
  const byMaq={};
  MAQUINAS.forEach(m=>byMaq[m]=[]);
  ativos.forEach(r=>{
    if(!byMaq[r.maquina]) byMaq[r.maquina]=[];
    byMaq[r.maquina].push(r);
  });
  for(const m of MAQUINAS){
    byMaq[m].sort((a,b)=>{
      const sa=a.sortOrder!=null?a.sortOrder:a.id;
      const sb=b.sortOrder!=null?b.sortOrder:b.id;
      return sa-sb;
    });
  }

  // Helper: get active shift blocks for a machine on a given day
  function getBlocks(dayDate, maq){
    if(typeof getActiveShiftBlocks==='function'){
      return getActiveShiftBlocks(dayDate, maq);
    }
    // Fallback: treat whole jornada as single block
    const hrs=hoursOnDayMaq(dayDate, maq);
    if(hrs<=0) return [];
    return [{turnoIdx:0, label:'T1', inicioMin:0, fimMin:hrs*60}];
  }

  // Advance cursor to next valid block (skipping days/blocks with no availability)
  function advanceCursor(cursor, days, maq){
    while(cursor.dayIdx<7){
      const blocks=getBlocks(days[cursor.dayIdx], maq);
      if(cursor.blkIdx<blocks.length) return blocks; // valid
      cursor.dayIdx++;
      cursor.blkIdx=0;
      cursor.usedMin=0;
    }
    return null;
  }

  const result={};

  for(const maq of MAQUINAS){
    const recs=byMaq[maq];
    if(!recs.length){result[maq]=[];continue;}

    // Cursor: position within the week
    const cursor={dayIdx:0, blkIdx:0, usedMin:0};
    const scheduled=[];

    for(let ri=0;ri<recs.length;ri++){
      const rec=recs[ri];
      const p=getProdInfo(rec);
      const pcMin=p.pc_min;
      const unidPorCx=p.unid;
      if(!pcMin){scheduled.push({rec,segments:[],setupMin:0,setupSegments:[]});continue;}

      let setupMin=0;
      if(ri>0) setupMin=getSetupMin(maq, recs[ri-1].produto, rec.produto);

      const totalUnid=rec.qntUnid||(rec.qntCaixas*unidPorCx);
      let remainProdMin=totalUnid/pcMin;
      let remainSetupMin=setupMin;
      const cxPerMin=rec.qntCaixas/remainProdMin;

      const segments=[];
      const setupSegments=[];

      // Respect dtDesejada: advance cursor to that day if machine is free earlier
      if(rec.dtDesejada){
        const desejadaIdx=days.findIndex(d=>dateStr(d)===rec.dtDesejada);
        if(desejadaIdx>=0){
          const cursorFree=(cursor.dayIdx<desejadaIdx)||
                           (cursor.dayIdx===desejadaIdx&&cursor.blkIdx===0&&cursor.usedMin===0);
          if(cursorFree){
            cursor.dayIdx=desejadaIdx;
            cursor.blkIdx=0;
            cursor.usedMin=0;
          }
        }
      }

      // Skip to first day with availability
      while(cursor.dayIdx<7 && hoursOnDayMaq(days[cursor.dayIdx],maq)===0){
        cursor.dayIdx++;cursor.blkIdx=0;cursor.usedMin=0;
      }

      // Save cursor snapshot for this record (so we fill from here)
      const snap={dayIdx:cursor.dayIdx, blkIdx:cursor.blkIdx, usedMin:cursor.usedMin};

      // ── Consume setup time ──
      while(remainSetupMin>0.001 && snap.dayIdx<7){
        const blocks=advanceCursor(snap, days, maq);
        if(!blocks) break;
        const blk=blocks[snap.blkIdx];
        const blkTotalMin=blk.fimMin-blk.inicioMin;
        const blkAvailMin=blkTotalMin-snap.usedMin;
        if(blkAvailMin<=0.001){snap.blkIdx++;snap.usedMin=0;continue;}
        const useMin=Math.min(remainSetupMin,blkAvailMin);
        setupSegments.push({date:dateStr(days[snap.dayIdx]),dayIdx:snap.dayIdx,
          turnoIdx:blk.turnoIdx,turnoLabel:blk.label,setupMin:useMin});
        remainSetupMin-=useMin;
        snap.usedMin+=useMin;
        if(snap.usedMin>=blkTotalMin-0.001){snap.blkIdx++;snap.usedMin=0;}
      }

      // ── Consume production time ──
      while(remainProdMin>0.001 && snap.dayIdx<7){
        const blocks=advanceCursor(snap, days, maq);
        if(!blocks) break;
        const blk=blocks[snap.blkIdx];
        const blkTotalMin=blk.fimMin-blk.inicioMin;
        const blkAvailMin=blkTotalMin-snap.usedMin;
        if(blkAvailMin<=0.001){snap.blkIdx++;snap.usedMin=0;continue;}

        const useMin=Math.min(remainProdMin,blkAvailMin);
        const dayAvailHrs=hoursOnDayMaq(days[snap.dayIdx],maq);

        // startPct / endPct: fraction within the day's total available hours
        // We map the block's start within the day using turnoStartMin relative to day capacity
        const dayCapMin=dayAvailHrs*60;
        // position of block start within day capacity (blocks are ordered T1<T2<T3)
        const allBlocks=getBlocks(days[snap.dayIdx],maq);
        let blkOffsetMin=0;
        for(let bi=0;bi<snap.blkIdx;bi++) blkOffsetMin+=(allBlocks[bi].fimMin-allBlocks[bi].inicioMin);
        const absStartMin=blkOffsetMin+snap.usedMin;
        const startPct=dayCapMin>0?(absStartMin/dayCapMin)*100:0;
        const endPct=dayCapMin>0?((absStartMin+useMin)/dayCapMin)*100:0;

        const caixasHoje=Math.round(cxPerMin*useMin);
        segments.push({
          date:dateStr(days[snap.dayIdx]),
          dayIdx:snap.dayIdx,
          turnoIdx:blk.turnoIdx,
          turnoLabel:blk.label,
          caixasNoDia:caixasHoje,
          hrsNoDia:useMin/60,
          startPct,
          endPct,
          dayAvailHrs,
          turnoInicioMin:blk.inicioMin,
          turnoFimMin:blk.fimMin,
          usedInTurnoMin:snap.usedMin,
          useMin,
        });

        remainProdMin-=useMin;
        snap.usedMin+=useMin;
        if(snap.usedMin>=blkTotalMin-0.001){snap.blkIdx++;snap.usedMin=0;}
      }

      // Advance global cursor to where this record ended
      cursor.dayIdx=snap.dayIdx;
      cursor.blkIdx=snap.blkIdx;
      cursor.usedMin=snap.usedMin;
      // Skip fully-used days
      if(cursor.dayIdx<7){
        const curBlks=getBlocks(days[cursor.dayIdx],maq);
        if(cursor.blkIdx>=curBlks.length){cursor.dayIdx++;cursor.blkIdx=0;cursor.usedMin=0;}
      }

      scheduled.push({rec,segments,setupMin,setupSegments});
    }

    result[maq]=scheduled;
  }

  return {schedule:result,days};
}

function renderGantt(){
  if(!ganttBaseMonday){
    const sorted=[...records].filter(r=>r.dtDesejada||r.dtSolicitacao).sort((a,b)=>{
      const da=b.dtDesejada||b.dtSolicitacao||'';
      const db=a.dtDesejada||a.dtSolicitacao||'';
      return da.localeCompare(db);
    });
    ganttBaseMonday = sorted.length>0
      ? getWeekMonday(new Date((sorted[0].dtDesejada||sorted[0].dtSolicitacao)+'T12:00:00'))
      : getWeekMonday(new Date());
  }
  const {schedule,days}=buildSchedule(ganttBaseMonday);
  const today=dateStr(new Date());

  // Week label
  const mon=days[0],sun=days[6];
  document.getElementById('gantt-week-label').textContent=
    `${fmtDate(mon)} – ${fmtDate(sun)} / ${mon.getFullYear()}`;

  // Dynamic hours label: show per-day using general jornada for overview
  const hrsLabelEl=document.getElementById('gantt-hrs-label');
  if(hrsLabelEl){
    const dayHrsDetail=days.filter(d=>hoursOnDay(d)>0)
      .map(d=>`${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][d.getDay()]}: ${hoursOnDay(d)}h`)
      .join(' · ');
    const weekTotalHrs=days.reduce((a,d)=>a+hoursOnDay(d),0);
    hrsLabelEl.textContent=`${dayHrsDetail} · Total: ${weekTotalHrs}h`;
  }

  // Color map per record id
  const colorMap={};
  let ci=0;
  records.forEach(r=>{colorMap[r.id]=BAR_COLORS[ci++%BAR_COLORS.length]});

  // Legend
  const legendEl=document.getElementById('gantt-legend');
  const activeRecs=records.filter(r=>r.status!=='Concluído');
  legendEl.innerHTML=activeRecs.slice(0,12).map(r=>`
    <div class="legend-item">
      <div class="legend-dot" style="background:${colorMap[r.id]}"></div>
      <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">${r.produto.substring(0,30)}</span>
    </div>`).join('');

  // COL WIDTHS
  const MAQ_W=72, LABEL_W=320, QTY_W=48, TEMPO_W=52, SETUP_W=52, TOTMAQ_W=68, DQTY_W=36;
  const gridCols=`${MAQ_W}px ${LABEL_W}px ${QTY_W}px ${TEMPO_W}px ${SETUP_W}px ${TOTMAQ_W}px repeat(7,1fr) repeat(7,${DQTY_W}px)`;

  // Pre-calculate total SCHEDULED hours per machine for THIS WEEK only
  // Uses the segments from buildSchedule which already distribute by shift block
  const maqTotalHrs={};
  for(const maq of MAQUINAS){
    const entries=schedule[maq];
    if(!entries||!entries.length){maqTotalHrs[maq]=0;continue;}
    let tot=0;
    for(const {segments,setupSegments} of entries){
      // Sum only hours that fall within this week's days
      for(const seg of segments) tot+=seg.hrsNoDia;
      for(const seg of setupSegments) tot+=seg.setupMin/60;
    }
    maqTotalHrs[maq]=Math.round(tot*10)/10;
  }

  // Helper: get shift blocks for a machine+day (uses turnosMaquinas if available)
  function ganttGetBlocks(dayDate, maq){
    if(typeof getActiveShiftBlocks==='function') return getActiveShiftBlocks(dayDate, maq);
    const hrs=hoursOnDayMaq(dayDate,maq);
    if(hrs<=0) return [];
    return [{turnoIdx:0,label:'T1',inicioMin:0,fimMin:hrs*60}];
  }

  let html=`<div class="gantt-wrap">`;

  // ── Header row ──
  html+=`<div class="gantt-head-row" style="grid-template-columns:${gridCols}">
    <div class="g-head-label" style="font-size:9px">Máquina</div>
    <div class="g-head-label">Produto</div>
    <div class="g-head-label" style="font-size:9px">Qtd<br>cx</div>
    <div class="g-head-label" style="font-size:9px">Tempo<br>h</div>
    <div class="g-head-label" style="font-size:9px">Set Up<br>h</div>
    <div class="g-head-label" style="font-size:9px">H.<br>Prog.</div>`;
  days.forEach(d=>{
    const isToday=dateStr(d)===today;
    const isWknd=hoursOnDay(d)===0;
    const hrs=hoursOnDay(d);
    html+=`<div class="g-head-day ${isToday?'today':''} ${isWknd?'weekend':''}">
      <div>${DAY_NAMES[d.getDay()]}</div>
      <div class="g-date">${fmtDate(d)}</div>
      <div style="font-size:9px;margin-top:1px;color:${hrs>0?'var(--text3)':'var(--text4)'}">${hrs>0?hrs+'h':'—'}</div>
    </div>`;
  });
  days.forEach(d=>{
    const isWknd=hoursOnDay(d)===0;
    html+=`<div class="g-head-label" style="font-size:8px;padding:4px 2px;text-align:center;${isWknd?'color:var(--text4)':''}">${DAY_NAMES[d.getDay()]}<br><span style="font-size:7px;color:var(--text3)">${fmtDate(d)}</span></div>`;
  });
  html+=`</div>`;

  // ── Machine sections ──
  let hasAny=false;
  for(const maq of MAQUINAS){
    const entries=schedule[maq];
    if(!entries||!entries.length) continue;
    hasAny=true;

    const maqTotH=maqTotalHrs[maq]||0;
    // Use real machine week capacity
    const maqCapH=weekHoursMaq(ganttBaseMonday,maq);
    const maqOccPct=maqCapH>0?parseFloat((maqTotH/maqCapH*100).toFixed(1)):0;
    const maqOccColor=maqOccPct>100?'var(--red)':maqOccPct>=80?'var(--warn)':'var(--green)';
    const barPct=Math.min(100,maqOccPct);

    // Active shifts summary for this machine (show which turns are on Mon–Fri)
    let turnosSumario='';
    if(typeof getTurnosMaquinaDia==='function'){
      const seg=getTurnosMaquinaDia(maq,1); // Segunda
      const ativos=['T1','T2','T3'].filter((_,i)=>seg[i]);
      turnosSumario=ativos.length?` <span style="color:var(--text3);font-size:9px">[${ativos.join('+')}]</span>`:'';
    }

    html+=`<div class="g-maq-sep" style="grid-column:1/-1;display:flex;align-items:center;justify-content:space-between">
      <span>⚙ ${maq}${turnosSumario} · ${entries.length} produto(s)</span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;display:flex;align-items:center;gap:10px">
        <span style="color:var(--text3)">${fmtHrs(maqTotH)} prog. / ${maqCapH}h disp.</span>
        <span style="color:${maqOccColor};font-weight:700">${maqOccPct}% ocupação</span>
        <span style="display:inline-block;width:80px;height:6px;background:var(--s3);border-radius:3px;overflow:hidden;vertical-align:middle">
          <span style="display:block;height:100%;width:${barPct}%;background:${maqOccColor};border-radius:3px"></span>
        </span>
      </span>
    </div>`;

    let firstRowOfMaq=true;

    for(const {rec,segments,setupMin} of entries){
      const color=colorMap[rec.id];
      const pRow=getProdInfo(rec);
      let prodHrs=0;
      const totalUnidRow=rec.qntUnid||(rec.qntCaixas*pRow.unid);
      if(totalUnidRow&&pRow.pc_min) prodHrs=totalUnidRow/pRow.pc_min/60;
      const prodHrsStr=fmtHrs(prodHrs);

      html+=`<div class="gantt-row" style="grid-template-columns:${gridCols}">`;

      // Máquina col
      html+=`<div class="g-col-maq"><span class="g-col-maq-txt">${rec.maquina}</span></div>`;

      // Produto label col
      html+=`<div class="g-label"><strong title="${rec.produto}">${rec.produto}</strong></div>`;

      // Qtd cx col
      html+=`<div class="g-col-qty"><div class="g-col-qty-txt">${rec.qntCaixas}<br><span style="font-size:9px;color:var(--text3);font-weight:400">cx</span></div></div>`;

      // Tempo col
      html+=`<div style="display:flex;align-items:center;justify-content:center;border-left:1px solid var(--border);background:var(--s1);font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;color:var(--warn);padding:4px 2px;text-align:center">${prodHrsStr}</div>`;

      // Set Up col
      const setupHrs=setupMin/60;
      const setupStr=setupMin>0?fmtHrs(setupHrs):'—';
      const setupColor=setupMin>0?'var(--orange)':'var(--text3)';
      html+=`<div style="display:flex;align-items:center;justify-content:center;border-left:1px solid var(--border);background:var(--s1);font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:${setupMin>0?'600':'400'};color:${setupColor};padding:4px 2px;text-align:center" title="Setup: ${setupStr}">${setupStr}</div>`;

      // H. Prog. col — total scheduled hours for this machine this week (only first row)
      const weekProgStr=firstRowOfMaq?fmtHrs(maqTotH):'';
      const weekCapColor=maqTotH>maqCapH?'var(--red)':maqTotH>(maqCapH*0.85)?'var(--warn)':'var(--cyan)';
      const weekProgTitle=firstRowOfMaq?`Programado: ${fmtHrs(maqTotH)} / Disponível: ${maqCapH}h`:'';
      html+=`<div style="display:flex;align-items:center;justify-content:center;border-left:2px solid var(--border2);background:var(--s1);font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:${firstRowOfMaq?weekCapColor:'var(--text4)'};padding:4px 2px;text-align:center" title="${weekProgTitle}">${weekProgStr}</div>`;
      firstRowOfMaq=false;

      // ── Day bar cells: render per-shift bars ──
      for(let di=0;di<7;di++){
        const day=days[di];
        const isWknd=hoursOnDayMaq(day,maq)===0 && hoursOnDay(day)===0;
        const isToday=dateStr(day)===today;
        const daySeg=segments.filter(s=>s.dayIdx===di);
        const blocks=ganttGetBlocks(day,maq);
        const dayCapMin=(hoursOnDayMaq(day,maq))*60;

        html+=`<div class="g-day ${isWknd?'weekend':''}" style="${isToday?'background:rgba(0,229,204,.04)':''}">`;

        if(daySeg.length && dayCapMin>0){
          // Show bars for each segment (one per shift block used)
          html+=`<div class="g-bar-wrap" style="position:relative;width:100%;height:100%">`;

          // Draw inactive shift dividers as subtle backgrounds
          blocks.forEach((blk,bi)=>{
            const blkTotalMin=blk.fimMin-blk.inicioMin;
            let blkOffMin=0;
            for(let b2=0;b2<bi;b2++) blkOffMin+=(blocks[b2].fimMin-blocks[b2].inicioMin);
            const blkLeft=(blkOffMin/dayCapMin)*100;
            const blkW=(blkTotalMin/dayCapMin)*100;
            const blkColors=['rgba(0,229,204,.04)','rgba(160,100,255,.04)','rgba(255,153,0,.04)'];
            html+=`<div style="position:absolute;left:${blkLeft.toFixed(1)}%;width:${blkW.toFixed(1)}%;top:0;bottom:0;background:${blkColors[blk.turnoIdx]||''};border-left:1px dashed rgba(255,255,255,.06)"></div>`;
          });

          daySeg.forEach(seg=>{
            const leftPct=seg.startPct.toFixed(1);
            const widthPct=(seg.endPct-seg.startPct).toFixed(1);
            const cx=seg.caixasNoDia;
            const hrsLabel=fmtHrs(seg.hrsNoDia);
            const turnoTip=seg.turnoLabel?` · ${seg.turnoLabel}`:'';
            html+=`<div class="g-bar" style="left:${leftPct}%;width:${widthPct}%;background:${color};opacity:0.9;position:absolute;top:15%;height:70%"
              title="${rec.produto}${turnoTip} · ${cx} cx · ${hrsLabel}">
              <div class="g-bar-tip">${rec.produto.substring(0,40)}<br>${cx} cx · ${hrsLabel}${seg.turnoLabel?' · '+seg.turnoLabel:''}</div>
            </div>`;
          });
          html+=`</div>`;
        } else if(daySeg.length && dayCapMin===0){
          // Machine has no availability but somehow segment exists — show plain bar
          html+=`<div class="g-bar-wrap"><div class="g-bar" style="left:0%;width:100%;background:${color};opacity:0.5"></div></div>`;
        }
        html+=`</div>`;
      }

      // Per-day qty columns
      days.forEach((day,di)=>{
        const isWknd=hoursOnDay(day)===0;
        // Sum caixas across all segments on this day
        const cxDia=segments.filter(s=>s.dayIdx===di).reduce((a,s)=>a+s.caixasNoDia,0);
        html+=`<div style="display:flex;align-items:center;justify-content:center;border-left:1px solid rgba(31,45,61,.4);background:var(--s1);font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;color:${cxDia>0?(isWknd?'var(--text2)':'var(--cyan)'):'var(--text4)'};">${cxDia>0?cxDia:'—'}</div>`;
      });

      html+=`</div>`;
    }
  }

  if(!hasAny){
    html+=`<div style="text-align:center;padding:60px;color:var(--text3);font-size:13px">
      <div style="font-size:36px;margin-bottom:10px">📋</div>
      Nenhuma solicitação ativa para exibir
    </div>`;
  }
  html+=`</div>`;

  document.getElementById('gantt-table').innerHTML=html;
  document.getElementById('gantt-summary').innerHTML='';
}


function renderGanttSummary(schedule,days){
  let html=`<div style="font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">📦 Qtd por Dia</div>`;

  let anyMaq=false;
  for(const maq of MAQUINAS){
    const entries=schedule[maq];
    if(!entries||!entries.length) continue;
    anyMaq=true;

    html+=`<div class="gs-maq" style="margin-bottom:10px">
      <div class="gs-maq-title" style="font-size:9px;padding:6px 10px">⚙ ${maq}</div>
      <table class="gs-table" style="font-size:10px">
        <thead><tr>
          <th style="text-align:left;padding:5px 8px;font-size:9px">Produto</th>`;
    days.filter(d=>hoursOnDay(d)>0).forEach(d=>{
      html+=`<th style="padding:5px 4px;font-size:9px;min-width:28px">${DAY_NAMES[d.getDay()]}<br><span style="font-size:8px;font-weight:400">${fmtDate(d)}</span></th>`;
    });
    html+=`<th style="padding:5px 4px;font-size:9px">Tot</th></tr></thead><tbody>`;

    const weekdayIdxs=days.map((d,i)=>hoursOnDay(d)>0?i:-1).filter(i=>i>=0);
    const dayTotals=Array(7).fill(0);
    let weekTotal=0;

    for(const {rec,segments} of entries){
      const rowTotals=Array(7).fill(0);
      segments.forEach(s=>{rowTotals[s.dayIdx]+=s.caixasNoDia});
      const rowTotal=rowTotals.reduce((a,b)=>a+b,0);
      weekTotal+=rowTotal;
      rowTotals.forEach((v,i)=>dayTotals[i]+=v);

      const shortName=rec.produto.length>22?rec.produto.substring(0,22)+'…':rec.produto;
      html+=`<tr><td title="${rec.produto}" style="text-align:left;padding:4px 8px;font-size:9px;color:var(--text)">${shortName}</td>`;
      weekdayIdxs.forEach(i=>{
        const v=rowTotals[i];
        html+=`<td style="padding:4px;font-size:10px;${v>0?'color:var(--cyan)':''}">${v>0?v:'—'}</td>`;
      });
      html+=`<td style="padding:4px;font-size:10px;color:var(--text);font-weight:600">${rowTotal}</td></tr>`;
    }

    // Total row
    html+=`<tr class="total-row"><td style="text-align:left;padding:4px 8px;font-size:9px">TOTAL</td>`;
    weekdayIdxs.forEach(i=>{
      const v=dayTotals[i];
      html+=`<td style="padding:4px;font-size:10px">${v>0?v:'—'}</td>`;
    });
    html+=`<td style="padding:4px;font-size:10px">${weekTotal}</td></tr>`;
    html+=`</tbody></table></div>`;
  }

  if(!anyMaq) html+=`<div style="color:var(--text3);font-size:13px;text-align:center;padding:24px">Nenhuma solicitação ativa</div>`;
  document.getElementById('gantt-summary').innerHTML=html;
}

// ===== INSUMOS DATA =====
const INSUMOS_MAP={"13001 TAPIOCA PUBLIC 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG LISO","c":"EMBALAGEM PRIMARIA","q":0.043},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0176},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA PUBLIC 1 KG","c":"EMBALAGEM PRIMARIA","q":0.1176},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"13002 TAPIOCA PUBLIC 500 G - FD 24":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0176},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TAPIOCA PUBLIC 500 G","c":"EMBALAGEM PRIMARIA","q":0.144},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00051 TAPIOCA BENASSI 500 G - CX 24":[{"n":"BOBINA TAPIOCA BENASSI 500 G","c":"EMBALAGEM PRIMARIA","q":0.144},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"12006 TAPIOCA OBA PREMIUM 560 G - CX 12":[{"n":"BOBINA TAPIOCA OBA 80 G","c":"EMBALAGEM PRIMARIA","q":0.231},{"n":"SACO POUCH TAPIOCA OBA 560GR","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":4.572672836145889},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.1473271638541096},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.153608}],"00011 TAPIOCA DA TERRINHA LISA NA MEDIDA 70 G - CX 100":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":4.763200870985302},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.2367991290146976},{"n":"LOGISTICA - FILME STRETCH MANUAL 500x0,25","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"BOBINA LISA PORÇÃO INDIVIDUAL","c":"EMBALAGEM PRIMARIA","q":0.26},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.182866}],"00059 TAPIOCA LESTE 500 G - FD 24.0":[{"n":"BOBINA PARA FARDOS 90,0 CM 500G LISO","c":"EMBALAGEM PRIMARIA","q":0.048},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA LESTE","c":"EMBALAGEM PRIMARIA","q":0.144},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"11702 ALECRIM COOP 20 G FD 24":[{"n":"MP - ALECRIM KG","c":"MATERIA PRIMA","q":0.519877},{"n":"SOLAPA ALECRIM 20GR COOP","c":"EMBALAGEM TERCIARIA","q":24.0},{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA LISA LAMINADA ESPECIARIAS 24 CM","c":"EMBALAGEM PRIMARIA","q":0.05448}],"11300 CHA DE BOLDO COOP 10 G FD 20":[{"n":"MP - CHA BOLDO DO CHILE RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.211267},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"CAIXA CARTUCHO CHA BOLDO COOP","c":"EMBALAGEM TERCIARIA","q":20.239435},{"n":"INDL - CHA BOLDO COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"11301 CHA DE CAMOMILA COOP 10 G FD 20":[{"n":"MP - CHA CAMOMILA FLOR RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.208333},{"n":"CAIXA CARTUCHO CHA CAMOMILA COOP","c":"EMBALAGEM TERCIARIA","q":20.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"INDL - CHA CAMOMILA COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"11302 CHA DE CARQUEJA COOP 10 G - FD 20":[{"n":"MP - CHA CARQUEJA RAZURADA PARA SACHE KG","c":"MATERIA PRIMA","q":0.212765},{"n":"CAIXA CARTUCHO CHA CARQUEJA COOP","c":"EMBALAGEM TERCIARIA","q":20.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"INDL - CHA CARQUEJA COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"11305 CHA DE HORTELA COOP 10 G - FD 20":[{"n":"MP - CHA HORTELA / MENTA PIPERITA RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.2},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"CAIXA CARTUCHO CHA HORTELA COOP","c":"EMBALAGEM TERCIARIA","q":20.0},{"n":"INDL - CHA HORTELA COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"11503 FARINHA MANDIOCA TORRADA COOP 500 G FD 12":[{"n":"MP - FARINHA DE MANDIOCA TORRADA FINA KG","c":"MATERIA PRIMA","q":6.0},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"BOBINA FARINHA DE MANDIOCA TORRADA COOP 500 G","c":"EMBALAGEM PRIMARIA","q":0.072}],"11515 FUBA MIMOSO COOP 500 G FD 12":[{"n":"MP - FUBA MIMOSO KG","c":"MATERIA PRIMA","q":6.0828},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA FUBA MIMOSO COOP 500 G","c":"EMBALAGEM PRIMARIA","q":0.072}],"11514 FUBA MIMOSO COOP 1 KG FD 10":[{"n":"MP - FUBA MIMOSO KG","c":"MATERIA PRIMA","q":10.15},{"n":"SACO PLASTICO FARDO LISO 50 X 75 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004167},{"n":"BOBINA FUBA MIMOSO COOP 1 KG","c":"EMBALAGEM PRIMARIA","q":0.08}],"11508 FARINHA ROSCA COOP 500 G FD 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA FARINHA DE ROSCA COOP 500 G","c":"EMBALAGEM PRIMARIA","q":0.078},{"n":"INDL - FARINHA ROSCA COOP 500 G - UND","c":"OUTROS","q":12.0}],"11517 POLVILHO AZEDO COOP 500 G FD 12":[{"n":"MP - POLVILHO AZEDO KG","c":"MATERIA PRIMA","q":6.048},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA POLVILHO AZEDO COOP 500 G","c":"EMBALAGEM PRIMARIA","q":0.06}],"00087 TAPIOCA TAPIOK DIA% 500 G - CX 24":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA TAPIOK DIA 100% 500 G","c":"EMBALAGEM PRIMARIA","q":0.1536},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"00057 TAPIOCA SAINT MARCHE 1 KG - CX 12":[{"n":"BOBINA TAPIOCA SAINT MARCHE 1 KG","c":"EMBALAGEM PRIMARIA","q":0.096},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"00058 TAPIOCA SAINT MARCHE 500 G - CX 24":[{"n":"BOBINA TAPIOCA SAINT MARCHE 500 G","c":"EMBALAGEM PRIMARIA","q":0.144},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00089 TAPIOCA TAEQ SOLTINHA 1 KG - CX 10":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.804572672836145},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.195427327163854},{"n":"BOBINA TAPIOCA TAEQ SOLTINHA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.1},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.017686}],"00091 TAPIOCA TAEQ PREMIUM 560 G - CX 10":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":3.810560696788241},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.7894393032117581},{"n":"BOBINA TAPIOCA TAEQ SOLTINHA   80 G","c":"EMBALAGEM PRIMARIA","q":0.224},{"n":"SACO POUCH TAPIOCA TAEQ 560 GR SOLTINHA","c":"EMBALAGEM PRIMARIA","q":10.0},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.013}],"00090 TAPIOCA TAEQ SOLTINHA 500 G - CX 20":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.804572672836145},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.195427327163854},{"n":"BOBINA TAPIOCA TAEQ SOLTINHA  500 G","c":"EMBALAGEM PRIMARIA","q":0.14},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.008226}],"00088 TAPIOCA TAPIOK DIA%  1 KG - UND FD 12.0":[{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG LISO","c":"EMBALAGEM PRIMARIA","q":0.043},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA TAPIOK DIA 100% 1 KG","c":"EMBALAGEM PRIMARIA","q":0.1104},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"12508 FARINHA ROSCA OBA 500 G FD 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"INDL - FARINHA ROSCA OBA 500GR","c":"OUTROS","q":12.0},{"n":"BOBINA FARINHA DE ROSCA OBA 500 G","c":"EMBALAGEM PRIMARIA","q":0.0504},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"00033 TAPIOCA TERRAFEC 500 G - CX 24":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0176},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA TERRAFEC 500 G","c":"EMBALAGEM PRIMARIA","q":0.168},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"13011 FAROFA TRADICIONAL DIA 500 G - FD 24":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.042},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.6038132046419825},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.051067180605359155},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.04978247165931239},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.1059884880488586},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.00802943091279232},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.03211772365116928},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.004817658547675392},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.02890595128605235},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.04817658547675392},{"n":"BOBINA FAROFA PRONTA TRADICIONAL DIA 500 G","c":"EMBALAGEM PRIMARIA","q":0.201},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.061666029410245016},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.1927063419070157},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":11.241203277909246},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.003211772365116928},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0005138835784187085}],"13016 FAROFA TRADICIONAL DIA 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.597402060577251},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.0505249615062675},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.04925389329227336},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.10486312765451745},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.007944176337463443},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.03177670534985377},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.0047665058024780665},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.028599034814868397},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.04766505802478067},{"n":"BOBINA FAROFA PRONTA TRADICIONAL DIA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.13},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.06101127427171925},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.19066023209912267},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":11.12184687244882},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.0031776705349853777},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0005084272855976604}],"00105 TAPIOCA DO VALLE 500 G - CX 20":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.804572672836145},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.195427327163854},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00107 TAPIOCA TRIMAIS 500 G - FD 24.0":[{"n":"BOBINA PARA FARDOS 90,0 CM 500G LISO","c":"EMBALAGEM PRIMARIA","q":0.048},{"n":"BOBINA TAPIOCA TRIMAIS 500 G","c":"EMBALAGEM PRIMARIA","q":0.168},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00106 TAPIOCA TRIMAIS 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG LISO","c":"EMBALAGEM PRIMARIA","q":0.043},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"BOBINA TAPIOCA TRIMAIS 1 KG","c":"EMBALAGEM PRIMARIA","q":0.1152},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"11303 CHA ERVA CIDREIRA COOP 10 G - FD 20":[{"n":"MP - CHA CAPIM CIDREIRA  RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.2},{"n":"CAIXA CARTUCHO CHA ERVA CIDREIRA COOP","c":"EMBALAGEM TERCIARIA","q":20.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"INDL - CHA CIDREIRA COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"14001 TAPIOCA MERC 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG LISO","c":"EMBALAGEM PRIMARIA","q":0.043},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA MERC 1 KG","c":"EMBALAGEM PRIMARIA","q":0.1152},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"11102 ALHO FRITO GRANULADO OKKER 90 GR - CX 36":[{"n":"POTE LISO OKKER P220","c":"OUTROS","q":36.0},{"n":"TAMPA LARANJA OKKER P220","c":"OUTROS","q":36.0},{"n":"ETIQ ALHO FRITO OKKER 90G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ALHO FRITO GRANULADO 8-16 MESH F GRANDE","c":"MATERIA PRIMA","q":3.3048}],"11105 ALHO PASTA OKKER 400 GR - CX 36":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.050944953127084414},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":3.339922626338576},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":10.687752404283444},{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":36.0},{"n":"TAMPA LEITOSA OKKER P500","c":"OUTROS","q":36.0},{"n":"ETIQ ALHO PASTA OKKER 400G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X400G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.22266150842257176},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.04275100961713378},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.013894078125568478},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.013894078125568478},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.10687752404283445},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.10687752404283445},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.013359690505354306},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.017812920673805743},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.07125168269522297}],"11106 ALHO PASTA OKKER 800 GR - CX 24":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.06726065706974543},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":4.409571049152891},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":14.110627357289252},{"n":"POTE LISO OKKER P900","c":"OUTROS","q":24.0},{"n":"TAMPA LEITOSA OKKER P900","c":"OUTROS","q":24.0},{"n":"ETIQ ALHO PASTA OKKER  800G","c":"OUTROS","q":24.0},{"n":"CAIXA OKKER 24X800G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.29397140327685944},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.05644250942915701},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.018343815564476028},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.018343815564476028},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.14110627357289252},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.14110627357289252},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.017638284196611564},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.023517712262148757},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.09407084904859503}],"11122 ALHO PASTA OKKER 2 KG  - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.08378446948106284},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":5.4928629467480015},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":17.577161429593602},{"n":"BALDE SGF ALHO PASTA OKKER 2.2","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA BALDE OKKER 2.2","c":"OUTROS","q":12.0},{"n":"CAIXA OKKER 12X2KG OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.3661908631165334},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.07030864571837442},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.022850309858471685},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.022850309858471685},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.17577161429593605},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.17577161429593605},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.021971451786992006},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.029295269049322677},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.1171810761972907}],"30302 ALHO TRITURADO OKKER 200 GR - CX 36":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.025971936888317546},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":1.7027056526431958},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":5.4486580884582265},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":36.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":36.0},{"n":"ETIQ ALHO TRIT OKKER 200G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.11351371017621306},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.02179463235383291},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.007083255514995695},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.007083255514995695},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.05448658088458227},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.05448658088458227},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0068108226105727835},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.009081096814097045},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.03632438725638818}],"30303 ALHO TRITURADO OKKER 400 GR - CX 36":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.050944953127084414},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":3.339922626338576},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":10.687752404283444},{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":36.0},{"n":"TAMPA LEITOSA OKKER P500","c":"OUTROS","q":36.0},{"n":"ETIQ ALHO TRIT OKKER 400G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X400G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.22266150842257176},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.04275100961713378},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.013894078125568478},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.013894078125568478},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.10687752404283445},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.10687752404283445},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.013359690505354306},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.017812920673805743},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.07125168269522297}],"30301 ALHO TRITURADO OKKER 1 KG - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.042162775749784734},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":2.764167990589034},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":8.84533756988491},{"n":"POTE LISO OKKER P1000 P1100","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P1000 E P1100","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO TRIT  OKKER 1KG","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.18427786603926896},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.03538135027953964},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.011498938840850383},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.011498938840850383},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.08845337569884909},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.08845337569884909},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.011056671962356136},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.014742229283141518},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.05896891713256607},{"n":"CAIXA PAPELAO LISA OKKER 12 X 1 KG","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"11112 ALHO TRITURADO OKKER 3 KG - CX 6":[{"n":"BALDE SGF ALHO TRIT OKKER 3.2","c":"OUTROS","q":6.0},{"n":"BALDE LISO OKKER 3.2","c":"OUTROS","q":6.0},{"n":"ETIQ ALHO TRIT OKKER 3KG","c":"OUTROS","q":6.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.06283835211079714},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":4.119647210061001},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":13.182871072195203},{"n":"TAMPA LEITOSA BALDE OKKER 3.2","c":"OUTROS","q":6.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.2746431473374001},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.05273148428878082},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.017137732393853765},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.017137732393853765},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.13182871072195204},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.13182871072195204},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.016478588840244005},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.02197145178699201},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.08788580714796804},{"n":"CAIXA PAPELAO LISA OKKER 6 X 3 KG","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.06368119140885552},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":4.1749032829232195},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":13.359690505354305},{"n":"TAMPA LEITOSA BALDE OKKER 3.2","c":"OUTROS","q":6.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.27832688552821466},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.05343876202141722},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.017367597656960596},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.017367597656960596},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.13359690505354305},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.13359690505354305},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.01669961313169288},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.022266150842257176},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.0890646033690287},{"n":"CAIXA PAPELAO LISA OKKER 6 X 3 KG","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"11113 ALHO TEMPERADO BAIANO OKKER 200 GR - CX 36":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.013486112058406196},{"n":"MP - TEMPERO BAIANO KG","c":"MATERIA PRIMA","q":0.188},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.8841419618710357},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.094},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.494710042485838},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":36.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":36.0},{"n":"ETIQ ALHO BAIANO OKKER 200G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.05894279745806905},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.003678030561383509},{"n":"MP - COLORAU  OKKER KG","c":"MATERIA PRIMA","q":0.018},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.003536567847484143},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0047154237966455246},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":4.808094447930666},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.017632464462832294},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.006625239325128927},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.044081161157080745},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.044081161157080745},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.7804925898883481}],"30202 ALHO TEMPERADO MINEIRO OKKER 200 GR - CX 36":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.013868268576348883},{"n":"MP - ACAFRAO/CURCUMA MOIDA KG","c":"MATERIA PRIMA","q":0.038},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.909195929393502},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.5110149783405531},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.015},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":36.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":36.0},{"n":"ETIQ ALHO MINEIRO OKKER 200G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.060613061959566804},{"n":"MP - MANJERONA OKKER KG","c":"MATERIA PRIMA","q":0.009},{"n":"MP - CALDO DE GALINHA KG","c":"MATERIA PRIMA","q":0.03},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0037822550662769683},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0036367837175740082},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.004849044956765344},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":4.953486887421419},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.0181613033644141},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.00682659961809303},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.04540325841103525},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.04540325841103525},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.7994433707634159}],"30102 ALHO PASTA BISNAGA ERVAS FINAS OKKER 200 GR - CX 18":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.011063108626314318},{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":0.003},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.7252912123894877},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.008},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.07336584888370543},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.02},{"n":"ETIQ ALHO PASTA COM ERVAS FINAS OKKER 200G","c":"OUTROS","q":18.0},{"n":"CAIXA OKKER 18X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - LOURO MOIDO OKKER KG","c":"MATERIA PRIMA","q":0.005},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.04835274749263252},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0030172114435402693},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0029011648495579512},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.003868219799410602},{"n":"TAMPA AMARELA BISNAGA OKKER","c":"OUTROS","q":18.0},{"n":"BISNAGA SOPRADO OKKER 200G","c":"OUTROS","q":18.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.6143952751811828},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.010220312823483811},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.003454284585826174},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.025550782058709528},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.025550782058709528},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.15734604980743916}],"30104 ALHO PASTA BISNAGA TEMPERO DE AVES OKKER 200 GR - CX 18":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.01214673982803158},{"n":"MP - ACAFRAO/CURCUMA MOIDA KG","c":"MATERIA PRIMA","q":0.052},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.7963334677468256},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.02},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.548267096789842},{"n":"ETIQ ALHO PASTA TEMPERO PARA AVES OKKER 200G","c":"OUTROS","q":18.0},{"n":"CAIXA OKKER 18X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.053088897849788375},{"n":"MP - MANJERONA OKKER KG","c":"MATERIA PRIMA","q":0.005},{"n":"MP - CALDO DE GALINHA KG","c":"MATERIA PRIMA","q":0.02},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.010193068387159368},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0033127472258267943},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0033127472258267943},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.02548267096789842},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.02548267096789842},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0031853338709873025},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.004247111827983071},{"n":"TAMPA AMARELA BISNAGA OKKER","c":"OUTROS","q":18.0},{"n":"BISNAGA SOPRADO OKKER 200G","c":"OUTROS","q":18.0},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.1569884473119323}],"30105 ALHO PASTA BISNAGA OKKER 200 GR - CX 18":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.012985968444158773},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.8513528263215979},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.7243290442291133},{"n":"ETIQ ALHO PASTA BISNAGA OKKER 200G","c":"OUTROS","q":18.0},{"n":"CAIXA OKKER 18X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.05675685508810653},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.010897316176916454},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0035416277574978473},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0035416277574978473},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.027243290442291134},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.027243290442291134},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0034054113052863918},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.004540548407048523},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.01816219362819409},{"n":"TAMPA AMARELA BISNAGA OKKER","c":"OUTROS","q":18.0},{"n":"BISNAGA SOPRADO OKKER 200G","c":"OUTROS","q":18.0}],"11123 CEBOLA PICADA OKKER 200 GR - CX 36":[{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":1.4659113628790403},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":5.863645451516161},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":36.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":36.0},{"n":"ETIQ CEBOLA PICADA OKKER 200G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.018713762079306896},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.00873308897034322},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.046784405198267244},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.046784405198267244},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.03742752415861379}],"00703 PIMENTA BIQUINHO OKKER 250 GR - CX 24":[{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.0904780719083367},{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":24.0},{"n":"TAMPA VERMELHA OKKER P500","c":"OUTROS","q":24.0},{"n":"ETIQ PIMENTA BIQUINHO  OKKER 250G","c":"OUTROS","q":24.0},{"n":"CAIXA OKKER  24X430G (390G) OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - PIMENTA BIQUINHO OKKER KG","c":"MATERIA PRIMA","q":5.088},{"n":"MP - VINAGRE DE ALCOOL SIMPLES OKKER LT","c":"MATERIA PRIMA","q":4.361912287633347},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0021809561438166734},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.021809561438166734},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.04361912287633347},{"n":"SACO PLAST 65X50X0 HD TRANSPARENTE OKKER","c":"EMBALAGEM PRIMARIA","q":1.0}],"11103 ALHO FRITO GRANULADO (POTE) OKKER 250 GR - CX 36":[{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":36.0},{"n":"TAMPA LARANJA OKKER P500","c":"OUTROS","q":36.0},{"n":"ETIQ ALHO FRITO POTE OKKER 250G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X400G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ALHO FRITO GRANULADO 8-16 MESH F GRANDE","c":"MATERIA PRIMA","q":9.18}],"11128 ALHO PASTA OKKER 200 GR - CX 36":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.025971936888317546},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":1.7027056526431958},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":5.4486580884582265},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":36.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":36.0},{"n":"ETIQ ALHO PASTA OKKER 200G","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X200G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.11351371017621306},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.02179463235383291},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.007083255514995695},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.007083255514995695},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.05448658088458227},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.05448658088458227},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0068108226105727835},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.009081096814097045},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.03632438725638818}],"11132 ALHO TRITURADO OKKER 20 KG - UND":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.06982039123421903},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":4.577385788956668},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":14.647634524661337},{"n":"BALDE LISO OKKER 20 LITROS","c":"OUTROS","q":1.0},{"n":"TAMPA BALDE BRANCO OKKER 20LTS","c":"OUTROS","q":1.0},{"n":"ETIQ BRANCA  COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.3051590525971112},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.058590538098645346},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.01904192488205974},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.01904192488205974},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.14647634524661338},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.14647634524661338},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.018309543155826672},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.024412724207768896},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.09765089683107558}],"11130 ALHO PASTA OKKER 3 KG - CX 6":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.06283835211079714},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":4.119647210061001},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":13.182871072195203},{"n":"BALDE LISO OKKER 3.2","c":"OUTROS","q":6.0},{"n":"TAMPA LEITOSA BALDE OKKER 3.2","c":"OUTROS","q":6.0},{"n":"ETIQ ALHO PASTA OKKER 3KG","c":"OUTROS","q":6.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.2746431473374001},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.05273148428878082},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.017137732393853765},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.017137732393853765},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.13182871072195204},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.13182871072195204},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.016478588840244005},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.02197145178699201},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.08788580714796804},{"n":"CAIXA PAPELAO LISA OKKER 6 X 3 KG","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"31103 ALHO PASTA DA TERRINHA 2 KG - UND CX 6.0":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.04189223474053142},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":2.7464314733740007},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":8.788580714796801},{"n":"BALDE LISO OKKER 2.2","c":"OUTROS","q":6.0},{"n":"TAMPA LEITOSA BALDE OKKER 2.2","c":"OUTROS","q":6.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.1830954315582667},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.03515432285918721},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.011425154929235843},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.011425154929235843},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.08788580714796802},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.08788580714796802},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.010985725893496003},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.014647634524661338},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.05859053809864535},{"n":"ROTULO ALHO PASTA TERRINHA 2 KG","c":"OUTROS","q":6.0},{"n":"CAIXA PAPELAO LISA OKKER 6 X 2 KG","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"30001 ALHO FRITO GRANULADO SACHE OKKER 250 GR - CX 36":[{"n":"ETIQ ALHO FRITO SACHE OKKER 250G","c":"OUTROS","q":36.0},{"n":"SACHE 140TZ OKKER","c":"OUTROS","q":36.0},{"n":"CAIXA OKKER 36X400G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ALHO FRITO GRANULADO 8-16 MESH F GRANDE","c":"MATERIA PRIMA","q":9.18}],"30003 ALHO FRITO GRANULADO SACHE OKKER 500 GR - CX 24":[{"n":"SACHE 21X21,5X0,20 MAQUIPLAST OKKER","c":"OUTROS","q":24.0},{"n":"ETIQ ALHO FRITO OKKER 500G","c":"OUTROS","q":24.0},{"n":"ETIQ BRANCA  COLUNAS OKKER 120X49","c":"OUTROS","q":2.0},{"n":"CAIXA OKKER 36X400G OKKER","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ALHO FRITO GRANULADO 8-16 MESH F GRANDE","c":"MATERIA PRIMA","q":12.24}],"00093 TAPIOCA DO BEM 500 G - CX 24":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA GOMA PRONTA BEM 500 G","c":"EMBALAGEM PRIMARIA","q":0.18},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00094 TAPIOCA DO BEM 560 G -  CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":4.572672836145889},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.1473271638541096},{"n":"BOBINA TAPIOCA GOMA PRONTA BEM 80 G","c":"EMBALAGEM PRIMARIA","q":0.2184},{"n":"SACO POUCH TAPIOCA BEM GOMA PRONTA 560GR","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.153608}],"00074 TAPIOCA WRAPIOCA NACIONAL 400 G -  CX 25":[{"n":"BOBINA TAPIOCA WRAPIOCA NACIONAL 400 G","c":"EMBALAGEM PRIMARIA","q":0.165},{"n":"CAIXA PAPELAO TAPIOCA DELIOCA WRAP PATATI UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.804572672836145},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.195427327163854},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.033525}],"00072 TAPIOCA WRAPIOCA 630 G - CX 12":[{"n":"SACO POUCH TAPIOCA WRAPIOCA 630GR - UNID","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO TAPIOCA DELIOCA WRAP PATATI UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":5.144256940664126},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.4157430593358735},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.153607},{"n":"BOBINA TAPIOCA WRAPIOCA 90 G","c":"EMBALAGEM PRIMARIA","q":0.21}],"11128 ALHO PASTA OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.008657312296105849},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.5675685508810652},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.8162193628194088},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO PASTA OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.03783790339207102},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.007264877451277635},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.002270274203524261},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0030270322713656815},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.012108129085462726},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"11105 ALHO PASTA OKKER 400 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.01698165104236147},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":1.1133075421128587},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.5625841347611478},{"n":"CAIXA PAPELAO LISA OKKER 12 x 400 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P500","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO PASTA OKKER 400G","c":"OUTROS","q":12.0},{"n":"ETIQ BRANCA  COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.07422050280752392},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.014250336539044593},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.004631359375189492},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.004631359375189492},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.03562584134761148},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.03562584134761148},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.004453230168451435},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0059376402246019136},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.023750560898407654}],"30302 ALHO TRITURADO OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.008657312296105849},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.5675685508810652},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.8162193628194088},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO TRIT OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.03783790339207102},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.007264877451277635},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.002270274203524261},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0030270322713656815},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.012108129085462726},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"30303 ALHO TRITURADO OKKER 400 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.01698165104236147},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":1.1133075421128587},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.5625841347611478},{"n":"CAIXA PAPELAO LISA OKKER 12 x 400 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P500","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO TRIT OKKER 400G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.07422050280752392},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.014250336539044593},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.004631359375189492},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.004631359375189492},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.03562584134761148},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.03562584134761148},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.004453230168451435},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0059376402246019136},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.023750560898407654}],"30001 ALHO FRITO GRANULADO SACHE OKKER 250 GR - CX 12":[{"n":"ETIQ ALHO FRITO SACHE OKKER 250G","c":"OUTROS","q":12.0},{"n":"SACHE 140TZ OKKER","c":"OUTROS","q":12.0},{"n":"MP - ALHO FRITO GRANULADO 8-16 MESH F GRANDE","c":"MATERIA PRIMA","q":3.06},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":2.0}],"11113 ALHO TEMPERADO BAIANO OKKER 200 GR  - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.004494445759608037},{"n":"MP - TEMPERO BAIANO KG","c":"MATERIA PRIMA","q":0.062667},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.2946533496246528},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.031333},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.1649095468177274},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO BAIANO OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.019643556641643523},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0012257579344385557},{"n":"MP - COLORAU  OKKER KG","c":"MATERIA PRIMA","q":0.006},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0011786133984986113},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0015714845313314818},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.6025289060697987},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.005876791132443141},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.002208197787820762},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.014691977831107851},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.014691977831107851},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.26009639463982104}],"30201 ALHO TEMPERADO CASEIRO OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.004613133487757254},{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":0.005},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.3024344506833864},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.17024520576474508},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.005},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO CASEIRO OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - LOURO MOIDO OKKER KG","c":"MATERIA PRIMA","q":0.005},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.020162296712225764},{"n":"MP - CALDO DE CARNE OKKER KG","c":"MATERIA PRIMA","q":0.018667},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0012581273148428876},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0012097378027335459},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0016129837369780612},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.648771065245817},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.0060445040210632415},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.002272354072590305},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.015111260052658105},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.015111260052658105},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.26679862105254404}],"30202 ALHO TEMPERADO MINEIRO OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.004622755035958135},{"n":"MP - ACAFRAO/CURCUMA MOIDA KG","c":"MATERIA PRIMA","q":0.012667},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.30306523400075186},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.17033819560146618},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.005},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO MINEIRO OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.020204348933383458},{"n":"MP - MANJERONA OKKER KG","c":"MATERIA PRIMA","q":0.003},{"n":"MP - CALDO DE GALINHA KG","c":"MATERIA PRIMA","q":0.01},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0012607513734431278},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0012122609360030075},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0016163479146706768},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.6511615312082708},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.0060537651518240854},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0022755321131965435},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.015134412879560214},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.015134412879560214},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.2664814519719116}],"30203 ALHO TEMPERADO REFOGA OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.004679277296045211},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.30677080175121574},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.1714000416527824},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.007},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO REFOGA OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.020451386783414387},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0012761665352850576},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0012270832070048632},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.001636110942673151},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.6672667322150199},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.006114751900536189},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0022972731664080166},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.015286879751340472},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.015286879751340472},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.2692536150469338}],"00112 TAPIOCA TRADICIONAL OKKER 400 G - CX 25":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.025},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.04386},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.010965},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.017544},{"n":"09014 FECULA MANDIOCA BIG BAG KG","c":"OUTROS","q":6.578947},{"n":"BOBINA TAPIOCA OKKER 400 G","c":"EMBALAGEM PRIMARIA","q":0.165}],"00113 TAPIOCA TRADICIONAL OKKER 800 G - CX 15":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA OKKER 800 G","c":"EMBALAGEM PRIMARIA","q":0.1152},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0}],"11102 ALHO FRITO GRANULADO OKKER 90 GR - CX 12":[{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LARANJA OKKER P220","c":"OUTROS","q":12.0},{"n":"ETIQ ALHO FRITO OKKER 90G","c":"OUTROS","q":12.0},{"n":"MP - ALHO FRITO GRANULADO 8-16 MESH F GRANDE","c":"MATERIA PRIMA","q":1.1016},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"00311 FAROFA PRONTA DA TERRINHA TRADICIONAL 400 G - FD 12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.025},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.2389608242309004},{"n":"BOBINA FAROFA PRONTA TRADICIONAL DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.103},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.020209984602507},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.01970155731690934},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.04194525106180698},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.0031776705349853772},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.012710682139941509},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.0019066023209912265},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.011439613925947358},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.010204},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.019066023209912263},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.0244045097086877},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.07626409283964905},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":4.448738748979528},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.001271068213994151},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.00020337091423906415}],"00311 FAROFA PRONTA DA TERRINHA TRADICIONAL 400 G - CX 20":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.041667},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.39734416561849184},{"n":"BOBINA FAROFA PRONTA APIMENTADA DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.172},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.03360517145390437},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.03275975833556715},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.06974658226282036},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.008454131183372167},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.021135327958430414},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.019021795162587375},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.019021795162587375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.020408},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.03170299193764563},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.0405798296801864},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.1268119677505825},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":7.3973647854506455},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.0021135327958430416},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0003381652473348867}],"14311 FAROFA PRONTA TRADICIONAL MERCADAO 400G - FD 24":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.4779216484618008},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.040419969205014},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.03940311463381868},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.08389050212361396},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.0063553410699707545},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.025421364279883018},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.003813204641982453},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.022879227851894716},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.020408},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.038132046419824525},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.0488090194173754},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.1525281856792981},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":8.897477497959056},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.002542136427988302},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0004067418284781283},{"n":"BOBINA FAROFA PRONTA TEMPERADA MERCADAO 400 G","c":"EMBALAGEM PRIMARIA","q":0.206}],"00040 TAPIOCA DA TERRINHA EXP (5 IDIOMAS) 500 G - CX 24":[{"n":"CAIXA PAPELAO TAPIOCA DA TERRINHA 24 X 500 GR - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TAPIOCA DA TERRINHA 500 G 05 IDIOMAS (SUBSTITUIU EUA TRILINGUE)","c":"EMBALAGEM PRIMARIA","q":0.1824},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00041 EXP TAPIOCA DA TERRINHA (VM) 500 G - CX 24":[{"n":"CAIXA PAPELAO TAPIOCA DA TERRINHA 24 X 500 GR - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TAPIOCA DA TERRINHA 500 G PORTUGAL","c":"EMBALAGEM PRIMARIA","q":0.1824},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"14006 TAPIOCA NAGUMO 500 G - FD 24":[{"n":"BOBINA PARA FARDOS 90,0 CM 500G LISO","c":"EMBALAGEM PRIMARIA","q":0.048},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA NAGUMO 500 G","c":"EMBALAGEM PRIMARIA","q":0.168},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"14906 FARINHA DE MANDIOCA GROSSA MERCADAO 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.020408},{"n":"09016 FARINHA DE MANDIOCA CRUA GROSSA BIG BAG Kg","c":"OUTROS","q":12.24},{"n":"BOBINA FARINHA DE MANDIOCA GROSSA MERCADAO 1 KG","c":"EMBALAGEM PRIMARIA","q":0.096}],"14005 TAPIOCA DO PRINCIPE 400G - CX 25":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.025},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.04386},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.010965},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.175},{"n":"09014 FECULA MANDIOCA BIG BAG KG","c":"OUTROS","q":6.578947},{"n":"BOBINA TAPIOCA PRINCIPE 400 G","c":"EMBALAGEM PRIMARIA","q":0.165},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.804572672836145},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.195427327163854},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TAPIOCA PRINCIPE 400 G","c":"EMBALAGEM PRIMARIA","q":0.165},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.033525}],"19001 CREME DE AVELA DAVELA 140 G CX 10":[{"n":"INSUMO - FITA ADESIVA TRANSPARENTE 48MM X 1200/ MT","c":"OUTROS","q":0.000833},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001186},{"n":"POTE PET 125 ML - DAVELA","c":"OUTROS","q":10.0},{"n":"TAMPA 58 MM BRANCO - DAVELA","c":"OUTROS","q":10.0},{"n":"ROTULO CREME DE AVELA DAVELA 140G FRENTE","c":"OUTROS","q":10.0},{"n":"ROTULO CREME DE AVELA DAVELA 140G VERSO","c":"OUTROS","q":10.0},{"n":"CAIXA PAPELAO CREME DE AVELA DAVELA 140G UND","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ACUCAR CRISTAL TIPO 2","c":"MATERIA PRIMA","q":0.668809},{"n":"MP - GORDURA AGP 600 BD KG","c":"MATERIA PRIMA","q":0.40654},{"n":"MP - PASTA DE AVELA","c":"MATERIA PRIMA","q":0.047772},{"n":"MP - AROMA DE AVELA","c":"MATERIA PRIMA","q":0.000717},{"n":"MP - SORO DE LEITE PARA CHOCOLATE","c":"MATERIA PRIMA","q":0.11943},{"n":"MP - VANILINA KG","c":"MATERIA PRIMA","q":0.00215},{"n":"MP - LEITE EM PO DESNATADO KG","c":"MATERIA PRIMA","q":0.095544},{"n":"MP - CACAU EM PO ALCALINO KG","c":"MATERIA PRIMA","q":0.095544},{"n":"MP - ESTER DE POLIGLICEROS (PGPR90)","c":"MATERIA PRIMA","q":0.00215},{"n":"INDL - CREME DE AVELA DAVELA 140 G UN","c":"OUTROS","q":10.0}],"19002 CREME DE AVELA DAVELA 290 G CX 10":[{"n":"INSUMO - FITA ADESIVA TRANSPARENTE 48MM X 1200/ MT","c":"OUTROS","q":0.000833},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.000152},{"n":"POTE PET 250 ML - DAVELA","c":"OUTROS","q":10.0},{"n":"TAMPA 63 MM BRANCO - DAVELA","c":"OUTROS","q":10.0},{"n":"ROTULO CREME DE AVELA DAVELA 290G FRENTE","c":"OUTROS","q":10.0},{"n":"ROTULO CREME DE AVELA DAVELA 290G VERSO","c":"OUTROS","q":10.0},{"n":"CAIXA PAPELAO CREME DE AVELA DAVELA 290G UND","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ACUCAR CRISTAL TIPO 2","c":"MATERIA PRIMA","q":1.38539},{"n":"MP - GORDURA AGP 600 BD KG","c":"MATERIA PRIMA","q":0.842119},{"n":"MP - PASTA DE AVELA","c":"MATERIA PRIMA","q":0.098956},{"n":"MP - AROMA DE AVELA","c":"MATERIA PRIMA","q":0.001484},{"n":"MP - SORO DE LEITE PARA CHOCOLATE","c":"MATERIA PRIMA","q":0.247391},{"n":"MP - VANILINA KG","c":"MATERIA PRIMA","q":0.004453},{"n":"MP - LEITE EM PO DESNATADO KG","c":"MATERIA PRIMA","q":0.19791},{"n":"MP - CACAU EM PO ALCALINO KG","c":"MATERIA PRIMA","q":0.197913},{"n":"MP - MP LECETINA DE SOJA PARA CHOCOLATE KG","c":"MATERIA PRIMA","q":0.006927},{"n":"MP - ESTER DE POLIGLICEROS (PGPR90)","c":"MATERIA PRIMA","q":0.004453},{"n":"INDL - CREME DE AVELA DAVELA 290 G UN","c":"OUTROS","q":10.0}],"12002 TAPIOCA OBA 500 G - CX 24":[{"n":"BOBINA TAPIOCA OBA 500 G","c":"EMBALAGEM PRIMARIA","q":0.1632},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"14774 MANJERICAO MERCADAO 10G - CX 24.0":[{"n":"MP - MANJERICAO FLOCOS KG","c":"MATERIA PRIMA","q":0.269671},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA MANJERICAO MERCADAO 10 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14782 OREGANO MERCADAO 08 G - CX 24":[{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":0.204315},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA OREGANO MERCADAO 8 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14800 PIMENTA CALABRESA FLOC MERCADAO 15 G - CX 24":[{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.384355},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA PIMENTA CALABRESA MERCADAO 15 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14818 TEMPERO BAIANO PO MERCADAO 50 G - CX 24":[{"n":"MP - TEMPERO BAIANO KG","c":"MATERIA PRIMA","q":1.260521},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TEMPERO BAIANO MERCADAO 50 G","c":"EMBALAGEM PRIMARIA","q":0.06}],"14825 TEMPERO PARA FRANGO MERCADAO 50 G - CX 24":[{"n":"MP - TEMPERO PARA FRANGO E ARROZ KG","c":"MATERIA PRIMA","q":1.266051},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TEMPERO PARA FRANGO MERCADAO 50 G","c":"EMBALAGEM PRIMARIA","q":0.06}],"14750 CRAVO DA INDIA MERCADAO 10G - CX 24":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"MP - CRAVO DA INDIA FLOR KG","c":"MATERIA PRIMA","q":0.261667},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA CRAVO INDIA MERCADAO 10 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14717 CANELA CASCA QUEBRADA MERCADAO 10 G  - CX 24":[{"n":"MP - CANELA CASCA INTEIRA / QUEBRADA KG","c":"MATERIA PRIMA","q":0.299061},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"SACO PLAST MERCADAO CANELA CASCA 10G","c":"EMBALAGEM PRIMARIA","q":24.0}],"02606 FEIJAO BRANCO DA TERRINHA PREMIUM 500 G - CX 12":[{"n":"MP - FEIJAO BRANCO KG","c":"MATERIA PRIMA","q":6.1},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004808},{"n":"BOBINA FEIJAO BRANCO PREMIUM DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.078},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"11719 CANELA EM CASCA QUEBRADA COOP 25 G FD 24":[{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - CANELA CASCA INTEIRA / QUEBRADA KG","c":"MATERIA PRIMA","q":0.612},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005556},{"n":"BOBINA CANELA EM CASCA QUEBRADA COOP 25G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"11518 POLVILHO DOCE COOP 500 G FD 12":[{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"BOBINA POLVILHO DOCE COOP 500 G","c":"EMBALAGEM PRIMARIA","q":0.07425},{"n":"09014 FECULA MANDIOCA BIG BAG KG","c":"OUTROS","q":6.12}],"11521 TRIGO PARA KIBE COOP 500 G FD 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA TRIGO PARA KIBE COOP 500 G","c":"EMBALAGEM PRIMARIA","q":0.084},{"n":"INDL - TRIGO PARA KIBE COOP 500 GR","c":"OUTROS","q":12.0}],"12604 CANJIQUINHA OBA 500 G CX 12.0":[{"n":"MP - CANJIQUINHA DE MILHO / MASTER G1 KG","c":"MATERIA PRIMA","q":6.0972},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST CANJIQUINHA OBA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR 400 E 500G","c":"EMBALAGEM TERCIARIA","q":1.0}],"12502 FARINHA MANDIOCA CRUA FINA OBA 500G CX 12":[{"n":"MP - FARINHA DE MANDIOCA CRUA FINA KG","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST FAR MAND CRUA FINA OBA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR 400 E 500G","c":"EMBALAGEM TERCIARIA","q":1.0}],"12503 FARINHA MANDIOCA TORRADA OBA 500 G CX 12":[{"n":"MP - FARINHA DE MANDIOCA TORRADA FINA KG","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST FAR MAND TORRADA OBA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR 400 E 500G","c":"EMBALAGEM TERCIARIA","q":1.0}],"12506 FARINHA MILHO AMARELA OBA 250 G CX 12.0":[{"n":"MP - FARINHA DE MILHO AMARELA  KG","c":"MATERIA PRIMA","q":3.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST FARINHA MILHO AMAR OBA 250 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0}],"12607 GRAO DE BICO OBA 500 G CX 12":[{"n":"MP - GRAO DE BICO 9MM KG","c":"MATERIA PRIMA","q":6.1},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST GRAO DE BICO OBA 500 G - UND","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR 400 E 500G","c":"EMBALAGEM TERCIARIA","q":1.0}],"12608 LENTILHA OBA 500 G CX 12":[{"n":"MP - LENTILHA KG","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST LENTILHA OBA 500 G - UNID","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"12517 POLVILHO AZEDO OBA 500G CX 12":[{"n":"MP - POLVILHO AZEDO KG","c":"MATERIA PRIMA","q":6.048},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST POLVILHO AZEDO OBA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR 400 E 500G","c":"EMBALAGEM TERCIARIA","q":1.0}],"SEMOLA DE MILHO MESTRE CUCA 1 kg - UND FD 12.0":[{"n":"MP - FUBA ITALIANO / SEMOLA KG","c":"MATERIA PRIMA","q":12.12},{"n":"SACO PLASTICO FARDO LISO 50 X 75 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004167},{"n":"SACO PLASTICO FARDO LISO 20 X 30","c":"EMBALAGEM PRIMARIA","q":12.0}],"21789 COLORIFICO DA TERRINHA 1 kg -   (OBA) FD 6.0":[{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.21328671328671328},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004808},{"n":"BOBINA COLORIFICO DA TERRINHA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.004572},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":5.8865},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.21328671328671328}],"21798 CUSCUZ DA TERRINHA 2 kg - FD 6":[{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.01},{"n":"MP - FLOCOS DE MILHO FINO (CUSCUZ) KG","c":"MATERIA PRIMA","q":12.0},{"n":"SACO PLASTICO FARDO LISO 20 X 30","c":"EMBALAGEM PRIMARIA","q":6.0}],"21795 FARINHA ROSCA DA TERRINHA 2 Kg - FD 6":[{"n":"MP - FARINHA DE ROSCA KG","c":"MATERIA PRIMA","q":12.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.01},{"n":"SACO PLASTICO FARDO LISO 25 X 35 UNID","c":"EMBALAGEM PRIMARIA","q":6.0},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"21797 FARINHA MANDIOCA CRUA FINA DA TERRINHA 2KG -  FD 6":[{"n":"MP - FARINHA DE MANDIOCA CRUA FINA KG","c":"MATERIA PRIMA","q":12.0},{"n":"SACO PLASTICO FARDO LISO 50 X 75 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.01},{"n":"SACO PLASTICO FARDO LISO 25 X 35 UNID","c":"EMBALAGEM PRIMARIA","q":6.0}],"21793 FUBA MIMOSO DA TERRINHA 2 kg - FD 06":[{"n":"MP - FUBA MIMOSO KG","c":"MATERIA PRIMA","q":12.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.01},{"n":"SACO PLASTICO FARDO LISO 25 X 35 UNID","c":"EMBALAGEM PRIMARIA","q":6.0},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"21785 OREGANO DA TERRINHA 500 G - FD 6":[{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":3.03},{"n":"SACO PLASTICO FARDO LISO 50 X 75 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.01},{"n":"SACO PLASTICO FARDO LISO 25 X 35 UNID","c":"EMBALAGEM PRIMARIA","q":6.0}],"21791 TRIGO PARA KIBE DA TERRINHA 2 kg - FD 06":[{"n":"MP - TRIGO PARA KIBE KG","c":"MATERIA PRIMA","q":12.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.01},{"n":"SACO PLASTICO FARDO LISO 20 X 30","c":"EMBALAGEM PRIMARIA","q":6.0},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"21790 UVA PASSA PRETA DA TERRINHA 1 kg - FD 06":[{"n":"MP - UVA PASSA PRETA SEM SEMENTE KG","c":"MATERIA PRIMA","q":6.1},{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004808},{"n":"SACO PLASTICO FARDO LISO 20 X 30","c":"EMBALAGEM PRIMARIA","q":6.0}],"22516 FARINHA MANDIOCA TORRADA RANCHO 700G - CX 24":[{"n":"MP - FARINHA DE MANDIOCA TORRADA FINA KG","c":"MATERIA PRIMA","q":16.9968},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.008929},{"n":"CAIXA PAPELAO JAPAO 24 X 700GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"SACO POUCH FARINHA DE MANDIOCA TORRADA DO RANCHO 700GR","c":"EMBALAGEM PRIMARIA","q":24.0}],"22515 FUBA MIMOSO RANCHO 700G - CX 24":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.008929},{"n":"CAIXA PAPELAO JAPAO 24 X 700GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"SACO POUCH FUBA MIMOSO DO RANCHO 700GR","c":"EMBALAGEM PRIMARIA","q":24.0},{"n":"MP - FUBA MIMOSO S/ FERRO KG","c":"MATERIA PRIMA","q":16.968}],"11770 LOURO EM FOLHAS COOP 10 G FD 24":[{"n":"MP - LOURO EM FOLHAS INTEIRAS KG","c":"MATERIA PRIMA","q":0.276},{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.006667},{"n":"BOBINA LOURO EM FOLHAS COOP 10G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14769 LOURO EM FOLHA MERCADAO 08 G  - CX 24":[{"n":"MP - LOURO EM FOLHAS INTEIRAS KG","c":"MATERIA PRIMA","q":0.2},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"SACO PLAST MERCADAO LOURO FOLHA 8G","c":"EMBALAGEM PRIMARIA","q":24.0}],"11506 FARINHA MILHO AMARELA COOP 500 G FD 10":[{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - FARINHA DE MILHO AMARELA  KG","c":"MATERIA PRIMA","q":5.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"SACO PLAST FARINHA MILHO AMAR COOP 500G","c":"EMBALAGEM PRIMARIA","q":10.0}],"11607 GRAO DE BICO COOP 500 G FD 12":[{"n":"MP - GRAO DE BICO 9MM KG","c":"MATERIA PRIMA","q":6.1},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA GRAO DE BICO COOP 500 G","c":"EMBALAGEM PRIMARIA","q":0.0504}],"11726 CANELA PO COOP 60G FD 24":[{"n":"SOLAPA CANELA EM PO COOP 60 G","c":"EMBALAGEM TERCIARIA","q":24.0},{"n":"MP - CANELA PO MOIDA KG","c":"MATERIA PRIMA","q":1.476},{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.000833},{"n":"BOBINA LISA LAMINADA ESPECIARIAS 24 CM","c":"EMBALAGEM PRIMARIA","q":0.05448}],"11808 PIMENTA DO REINO EM PO COOP 70 G FD 24":[{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":1.7136},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA PIMENTA DO REINO EM PO DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.06}],"11787 PAPRICA DOCE EM PO COOP 50 G FD 24":[{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SOLAPA PAPRICA DOCE PO 50GR COOP","c":"EMBALAGEM TERCIARIA","q":24.0},{"n":"MP - PAPRICA DOCE EM PO/ MOIDO  KG","c":"MATERIA PRIMA","q":1.248},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA LISA LAMINADA ESPECIARIAS 24 CM","c":"EMBALAGEM PRIMARIA","q":0.05448}],"14701 - ACAFRAO MERCADAO 30 g  - UND CX 24.0":[{"n":"MP - ACAFRAO/CURCUMA MOIDA KG","c":"MATERIA PRIMA","q":0.775309},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA ACAFRAO MERCADAO 30 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14723 CANELA PO MERCADAO 20 g - UND CX 24.0":[{"n":"MP - CANELA PO MOIDA KG","c":"MATERIA PRIMA","q":0.538824},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA CANELA PO MERCADO 20 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14785 PAPRICA DOCE EM PO MERCADAO 15 G - CX 24":[{"n":"MP - PAPRICA DOCE EM PO/ MOIDO  KG","c":"MATERIA PRIMA","q":0.395561},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA PAPRICA DOCE MERCADAO 15 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14788 PAPRICA PICANTE EM PO MERCADAO 15 G - CX 24":[{"n":"MP - PAPRICA PICANTE EM PO/ MOIDO KG","c":"MATERIA PRIMA","q":0.384},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA PAPRICA PICANTE MERCADAO 15 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14806 PIMENTA DO REINO EM PO MERCADAO 20G - CX 24":[{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.512},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA PIMENTA REINO PO MERCADAO 20 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"11710 BICARBONATO DE SODIO COOP 80 G FD 24":[{"n":"MP - BICARBONATO DE SODIO KG","c":"MATERIA PRIMA","q":1.98},{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005556},{"n":"BOBINA BICARBONATO DE SODIO COOP  80 G","c":"EMBALAGEM PRIMARIA","q":0.06}],"11737 COLORIFICO COOP 80 G - FD 24":[{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.06881118881118882},{"n":"SOLAPA COLORIFICO PO 80GR COOP","c":"EMBALAGEM TERCIARIA","q":24.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA LISA LAMINADA ESPECIARIAS 24 CM","c":"EMBALAGEM PRIMARIA","q":0.05448},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":1.8991200000000001},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.06881118881118882},{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.06853146853146853},{"n":"SOLAPA COLORIFICO PO 80GR COOP","c":"EMBALAGEM TERCIARIA","q":24.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA LISA LAMINADA ESPECIARIAS 24 CM","c":"EMBALAGEM PRIMARIA","q":0.05448},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":1.8914000000000002},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.06853146853146853}],"14708 BICARBONATO DE SODIO MERCADAO 20 G - CX 24":[{"n":"MP - BICARBONATO DE SODIO KG","c":"MATERIA PRIMA","q":0.537267},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA BICARBONATO MERCADAO 20 G","c":"EMBALAGEM PRIMARIA","q":0.0564}],"14736 COLORIFICO MERCADAO 70 G  - CX 24":[{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.06013986013986014},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA COLORIFICO MERCADAO 70 G","c":"EMBALAGEM PRIMARIA","q":0.0612},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":1.6598000000000002},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.06013986013986014}],"01750 CRAVO DA INDIA DA TERRINHA 10 G - FD 12":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"MP - CRAVO DA INDIA FLOR KG","c":"MATERIA PRIMA","q":0.1425},{"n":"BOBINA CRAVO DA INDIA DA TERRINHA 10 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"12603 CANJICA BRANCA OBA 500 G CX 12":[{"n":"MP - CANJICA BRANCA KG","c":"MATERIA PRIMA","q":6.1},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST CANJICA BCA OBA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0}],"12605 ERVILHA VERDE PARTIDA OBA 500 G CX 12":[{"n":"MP - ERVILHA PARTIDA KG","c":"MATERIA PRIMA","q":6.0888},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST ERVILHA PARTIDA OBA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"12505 FARINHA MANDIOCA CRUA GROSSA OBA 250 G CX 12":[{"n":"MP - FARINHA DE MANDIOCA CRUA GROSSA KG","c":"MATERIA PRIMA","q":3.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST FAR MAND CRUA GROSSA OBA  250 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"02508 FARINHA ROSCA DA TERRINHA PREMIUM 500G CX 12":[{"n":"MP - FARINHA DE ROSCA KG","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004808},{"n":"SACO PLAST FARINHA ROSCA DA TERRINHA 500 G EXP","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0}],"21706 ALHO DESIDRATADO GRANULADO TERRINHA 1 KG - FD 06":[{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.012821},{"n":"SACO PLASTICO FARDO LISO 20 X 30","c":"EMBALAGEM PRIMARIA","q":6.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0}],"21707 CANELA CASCA DA TERRINHA 500g -  FD 06":[{"n":"MP - CANELA CASCA INTEIRA / QUEBRADA KG","c":"MATERIA PRIMA","q":3.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004808},{"n":"SACO PLASTICO FARDO LISO 25 X 35 UNID","c":"EMBALAGEM PRIMARIA","q":6.0},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"21799 COMINHO EM PO DA TERRINHA 1 kg -  FD 6":[{"n":"MP - COMINHO PO / MOIDO KG","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004808},{"n":"SACO PLASTICO FARDO LISO 20 X 30","c":"EMBALAGEM PRIMARIA","q":6.0},{"n":"CAIXA PAPELAO TAPIOCA LISA UNIVERSAL","c":"EMBALAGEM TERCIARIA","q":1.0}],"21796 FARINHA MILHO AMARELA DA TERRINHA 2 Kg FD 3":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":3.0},{"n":"SACO PLASTICO FARDO LISO 50 X 75 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - FARINHA DE MILHO AMARELA  KG","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.01}],"21792 GRAO DE BICO DA TERRINHA 2 Kg - FD 6":[{"n":"MP - GRAO DE BICO 9MM KG","c":"MATERIA PRIMA","q":12.2},{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.01},{"n":"SACO PLASTICO FARDO LISO 20 X 30","c":"EMBALAGEM PRIMARIA","q":6.0}],"20978 PIMENTA REINO DA TERRINHA 1 kg - FD 6":[{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004808},{"n":"SACO PLASTICO FARDO LISO 20 X 30","c":"EMBALAGEM PRIMARIA","q":6.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0}],"01517 POLVILHO AZEDO DA TERRINHA 500 G - EXP CX 12":[{"n":"MP - POLVILHO AZEDO KG","c":"MATERIA PRIMA","q":6.12},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.006944},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA POLVILHO AZEDO DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.054}],"00014 TAPIOCA DA TERRINHA GRANULADA 5 KG - FD 5":[{"n":"SACO PLASTICO FARDO LISO 50 X 75 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - TAPIOCA GRANULADA TIPO1","c":"MATERIA PRIMA","q":25.0},{"n":"SACO PLASTICO FARDO LISO  35 X 45 UNID","c":"EMBALAGEM PRIMARIA","q":5.0}],"11608 LENTILHA COOP 500 G FD 12":[{"n":"MP - LENTILHA KG","c":"MATERIA PRIMA","q":6.0},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA LENTILHA COOP 500 G","c":"EMBALAGEM PRIMARIA","q":0.0504}],"01605 ERVILHA PARTIDA DA TERRINHA 500 G FD 12":[{"n":"MP - ERVILHA PARTIDA KG","c":"MATERIA PRIMA","q":6.0},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA ERVILHA PARTIDA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072}],"01602 CANJICA AMARELA DA TERRINHA 500G - EXP CX 12":[{"n":"MP - CANJICA AMARELA  KG","c":"MATERIA PRIMA","q":6.1},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA CANJICA AMARELA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.096}],"11746 COMINHO EM PO COOP 70 G FD 24":[{"n":"MP - COMINHO PO / MOIDO KG","c":"MATERIA PRIMA","q":1.704},{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SOLAPA COMINHO PO COOP 70GR","c":"EMBALAGEM TERCIARIA","q":24.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA LISA LAMINADA ESPECIARIAS 24 CM","c":"EMBALAGEM PRIMARIA","q":0.05448}],"11756 CURRY EM PO COOP 60 G FD 24":[{"n":"MP - CURRY KG","c":"MATERIA PRIMA","q":1.488},{"n":"SACO PLASTICO FARDO LISO 27 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SOLAPA CURRY EM PO 60GR COOP","c":"EMBALAGEM TERCIARIA","q":24.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA LISA LAMINADA ESPECIARIAS 24 CM","c":"EMBALAGEM PRIMARIA","q":0.05448}],"09518 MISTURA PAO DE QUEIJO DA TERRINHA 250G - CX 12":[{"n":"MP - MISTURA PAO DE QUEIJO KG AMP 30","c":"MATERIA PRIMA","q":3.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.008333},{"n":"BOBINA MISTURA PAO DE QUEIJO DA TERRINHA 250G","c":"EMBALAGEM PRIMARIA","q":0.096},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"09001 FARINHA DE MANDIOCA CLASSIFICADA CRUA FINA KG - COD 713-2001294":[{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.16},{"n":"09006 FECULA MANDIOCA INDL/REPROC KG","c":"OUTROS","q":1.0},{"n":"SACARIA RAFIA FARINHA 25 KG","c":"OUTROS","q":0.04}],"00503 BOLACHA DA TERRINHA DELICIA 250 g - FD 20":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.010204},{"n":"BOBINA BOLACHA DELICIA DA TERRINHA 250 G","c":"EMBALAGEM PRIMARIA","q":0.15},{"n":"INDL - BOLACHA DA TERRINHA DELICIA 250 g - UND","c":"OUTROS","q":20.0}],"00602 MOLHO CHURRASCO DA TERRINHA 150 ML CX12":[{"n":"00602 MOLHO CHURRASCO DA TERRINHA 150 ML CX12","c":"OUTROS","q":1.0}],"11306 CHA DE MACA COM CANELA COOP 20 G FD 20":[{"n":"MP - CHA DE MACA E CANELA RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.403508},{"n":"CAIXA CARTUCHO CHA MACA C/ CANELA COOP","c":"EMBALAGEM TERCIARIA","q":20.263157},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"INDL - CHA MACA C/ CANELA COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"11304 CHA DE ERVA DOCE COOP 16 G - FD 20":[{"n":"MP - CHA ERVA DOCE / ANIZ RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.332326},{"n":"CAIXA CARTUCHO CHA ERVA DOCE COOP","c":"EMBALAGEM TERCIARIA","q":21.363636},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"INDL - CHA ERVA DOCE  COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"11310 CHA VERDE COOP 16 G FD 20":[{"n":"MP - CHA VERDE RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.32},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"CAIXA CARTUCHO CHA VERDE COOP","c":"EMBALAGEM TERCIARIA","q":20.0},{"n":"INDL - CHA VERDE COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"11307 CHA DE QUENTAO COOP 2O G FD 20":[{"n":"MP - CHA QUENTAO RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.4},{"n":"CAIXA CARTUCHO CHA QUENTAO COOP","c":"EMBALAGEM TERCIARIA","q":20.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001543},{"n":"INDL - CHA QUENTAO COOP UNID","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":20.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":20.0}],"00008 TAPIOCA FORT. DA TERRINHA BETA  240 G - CX 3":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.48992923244420244},{"n":"CAIXA PAPELAO TAPIOCA DA TERRINHA FORTIFICADA","c":"EMBALAGEM TERCIARIA","q":0.125},{"n":"MP - BETA CAROTENO DE CENOURA","c":"MATERIA PRIMA","q":0.0072},{"n":"ETIQUETA TAPIOCA DATERRINHA FORTIFICADA BETA","c":"OUTROS","q":3.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":0.23007076755579747},{"n":"CAIXA CARTUCHO TAPIOCA FORTIFICADA BETA 240GR - INDIVIDUAL","c":"EMBALAGEM TERCIARIA","q":3.0},{"n":"CAIXA DISPLAY TAPIOCA FORTIFICADA BETACAROTENO","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TAPIOCA FORTIFICADA BETA","c":"EMBALAGEM PRIMARIA","q":0.0225},{"n":"FOLDER TAPIOCA DA TERRINHA FORTIFICADAS","c":"OUTROS","q":3.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.016458}],"00009 TAPIOCA FORT. DA TERRINHA FIBRA 240 G - CX 3":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.48992923244420244},{"n":"CAIXA PAPELAO TAPIOCA DA TERRINHA FORTIFICADA","c":"EMBALAGEM TERCIARIA","q":0.125},{"n":"MP - FIBRA DE BROTO DE BAMBU","c":"MATERIA PRIMA","q":0.01728},{"n":"ETIQUETA TAPIOCA DATERRINHA FORTIFICADA FIBRA","c":"OUTROS","q":3.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":0.23007076755579747},{"n":"CAIXA CARTUCHO TAPIOCA FORTIFICADA FIBRA 240GR INDIVIDUAL","c":"EMBALAGEM TERCIARIA","q":3.0},{"n":"CAIXA DISPLAY TAPIOCA FORTIFICADA FIBRA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TAPIOCA FORTIFICADA FIBRA","c":"EMBALAGEM PRIMARIA","q":0.0225},{"n":"FOLDER TAPIOCA DA TERRINHA FORTIFICADAS","c":"OUTROS","q":3.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.016458}],"00010 TAPIOCA FORT. DA TERRINHA VIT D 240 G - CX 3":[{"n":"CAIXA DISPLAY TAPIOCA FORTIFICADA VITAMINA D","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.48992923244420244},{"n":"CAIXA PAPELAO TAPIOCA DA TERRINHA FORTIFICADA","c":"EMBALAGEM TERCIARIA","q":0.125},{"n":"MP - VITAMINA D3 DE COGUMELO COLECALCIFEROL","c":"MATERIA PRIMA","q":0.0072},{"n":"ETIQUETA TAPIOCA DATERRINHA FORTIFICADA VITAMINA D","c":"OUTROS","q":3.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":0.23007076755579747},{"n":"CAIXA CARTUCHO TAPIOCA FORTIFICADA VITAMINA D 240GR  INDIVIDUAL","c":"EMBALAGEM TERCIARIA","q":3.0},{"n":"BOBINA TAPIOCA FORTIFICADA VITAMINA D","c":"EMBALAGEM PRIMARIA","q":0.0225},{"n":"FOLDER TAPIOCA DA TERRINHA FORTIFICADAS","c":"OUTROS","q":3.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.016458}],"MP - SALSA DESIDRATADA  FLOCOS KG":[{"n":"MP - SALSA DESIDRATADA OKKER KG","c":"MATERIA PRIMA","q":1.0}],"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30":[{"n":"LOGISTICA - FILME STRETCH MANUAL 500x0,25","c":"EMBALAGEM QUARTERNARIA","q":1.0}],"01800 PIMENTA CALABRESA FLOC DA TERRINHA 15 G FD12":[{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.192},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001},{"n":"BOBINA PIMENTA CALABRESA EM FLOCOS DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01788 PAPRICA PICANTE EM PO DA TERRINHA 15 G - FD 12":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - PAPRICA PICANTE EM PO/ MOIDO KG","c":"MATERIA PRIMA","q":0.192},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001},{"n":"BOBINA PAPRICA PICANTE EM PO DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01717 CANELA CASCA QUEBRADA DA TERRINHA 10 g  - FD 12":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - CANELA CASCA INTEIRA / QUEBRADA KG","c":"MATERIA PRIMA","q":0.12828},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA CANELA EM CASCA DA TERRINHA 10GR","c":"EMBALAGEM PRIMARIA","q":0.0564}],"01723 CANELA PO DA TERRINHA 20 g  - UND FD 12":[{"n":"MP - CANELA PO MOIDA KG","c":"MATERIA PRIMA","q":0.258},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005},{"n":"BOBINA CANELA PO DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01777 NOZ MOSCADA BOLA DA TERRINHA 08 G  FD 12":[{"n":"MP - NOZ MOSCADA BOLA KG","c":"MATERIA PRIMA","q":0.1152},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001},{"n":"SACO PLAST NOZ MOSCADA BOLA DA TERRINHA 8GR","c":"EMBALAGEM PRIMARIA","q":12.0}],"01745 COMINHO EM PO DA TERRINHA 50 G - FD 12":[{"n":"MP - COMINHO PO / MOIDO KG","c":"MATERIA PRIMA","q":0.612},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA COMINHO EM PO DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.03}],"01701 ACAFRAO DA TERRINHA 30 G  - FD 12":[{"n":"MP - ACAFRAO/CURCUMA MOIDA KG","c":"MATERIA PRIMA","q":0.383},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA ACAFRAO DA TERRINHA 30 G","c":"EMBALAGEM PRIMARIA","q":0.034165},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01769 LOURO EM FOLHA DA TERRINHA 08 g  - FD 12":[{"n":"MP - LOURO EM FOLHAS INTEIRAS KG","c":"MATERIA PRIMA","q":0.1},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA LOURO EM FOLHA DA TERRINHA 8GR","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01782 OREGANO DA TERRINHA 08 G  FD 12":[{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":0.108},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.055556},{"n":"BOBINA OREGANO DA TERRINHA 8 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01702 ALECRIM DA TERRINHA 06 G  - FD 12":[{"n":"MP - ALECRIM KG","c":"MATERIA PRIMA","q":0.077982},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA ALECRIM DA TERRINHA 6 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01715 CAMOMILA DA TERRINHA 06 G  FD 12":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - CAMOMILA FLOR KG","c":"MATERIA PRIMA","q":0.084},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001},{"n":"BOBINA CAMOMILA DA TERRINHA 6 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01736 COLORIFICO DA TERRINHA 70 G  FD 12":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.030209790209790213},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001},{"n":"BOBINA COLORIFICO DA TERRINHA 70 G","c":"EMBALAGEM PRIMARIA","q":0.0306},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":0.8337600000000001},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.030209790209790213},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.0030069930069930068},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001},{"n":"BOBINA COLORIFICO DA TERRINHA 70 G","c":"EMBALAGEM PRIMARIA","q":0.0306},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":0.08299},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.0030069930069930068}],"01708 BICARBONATO DE SODIO DA TERRINHA 20 g - UND FD 12":[{"n":"MP - BICARBONATO DE SODIO KG","c":"MATERIA PRIMA","q":0.264},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005},{"n":"BOBINA BICARBONATO DE SODIO DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01732 CHIMICHURRI DA TERRINHA 20G FD 12":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.000833},{"n":"MP - CHIMICHURRI KG","c":"MATERIA PRIMA","q":0.252},{"n":"BOBINA CHIMICHURRI FLOCOS DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01754 CURRY EM PO DA TERRINHA 15 g - UND FD 12":[{"n":"MP - CURRY KG","c":"MATERIA PRIMA","q":0.198},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005},{"n":"BOBINA CURRY EM PO DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01759 ERVA DOCE DA TERRINHA 15 G FD 12":[{"n":"MP - ERVA DOCE EM GRAO KG","c":"MATERIA PRIMA","q":0.192},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005},{"n":"BOBINA ERVA DOCE DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01804 PIMENTA COM  COMINHO PO DA TERRINHA 50G FD12":[{"n":"MP - PIMENTA COM COMINHO PO / MOIDO KG","c":"MATERIA PRIMA","q":0.624},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA PIMENTA COM COMINHO DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.03}],"01806 PIMENTA DO REINO EM PO DA TERRINHA 20g FD 12":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.255102},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.007813},{"n":"BOBINA PIMENTA DO REINO EM PO DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01813 SALSA DESIDRATADA DA TERRINHA 08 G FD 12":[{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.114},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.007813},{"n":"BOBINA SALSA DESIDRATADA 8 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01818 TEMPERO BAIANO PO DA TERRINHA 50 g - UND FD 12":[{"n":"MP - TEMPERO BAIANO KG","c":"MATERIA PRIMA","q":0.624},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005},{"n":"BOBINA TEMPERO BAIANO E PO DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.0282}],"01822 TEMPERO PARA CHURRASCO DA TERRINHA 40g - UND FD 12":[{"n":"MP - TEMPERO PARA CHURRASCO KG","c":"MATERIA PRIMA","q":0.504},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005},{"n":"BOBINA TEMPERO CHURRASCO EM PO DA TERRINHA 40 G","c":"EMBALAGEM PRIMARIA","q":0.0288}],"00012 TAPIOCA DA TERRINHA GRANULADA 500 G - FD 12":[{"n":"SACO PLASTICO FARDO LISO 50 X 75 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - TAPIOCA GRANULADA TIPO1","c":"MATERIA PRIMA","q":6.06},{"n":"BOBINA TAPIOCA GRANULADA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.053}],"02609 MILHO PIPOCA DA TERRINHA  PREMIUM 500 G CX12":[{"n":"MP - MILHO DE PIPOCA KG","c":"MATERIA PRIMA","q":6.1},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004808},{"n":"SACO PLAST MILHO PIPOCA DA TERRINHA 500G EXP","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0}],"02503 FARINHA MANDIOCA TORRADA DA TERRINHA PREMIUM 500G  - CX 12":[{"n":"MP - FARINHA DE MANDIOCA TORRADA FINA KG","c":"MATERIA PRIMA","q":6.0},{"n":"SACO PLAST FAR MAND TORRADA DA TERRINHA 500 G EXP","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0}],"09003 FECULA MANDIOCA TERRAFEC KG":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001},{"n":"SACO EMBALAGEM FECULA TERRAFEC","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.16},{"n":"SUB - RENDIMENTO FECULA KG","c":"OUTROS","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0005},{"n":"SACO EMBALAGEM FECULA TERRAFEC","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.001},{"n":"SUB - RENDIMENTO FECULA KG","c":"OUTROS","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0005},{"n":"SACO EMBALAGEM FECULA TERRAFEC","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.1},{"n":"SUB - RENDIMENTO FECULA KG","c":"OUTROS","q":1.0}],"00032 TAPIOCA TERRAFEC 1KG - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0176},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA TERRAFEC 1 KG","c":"EMBALAGEM PRIMARIA","q":0.114},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"01308 CHA MATE TOSTADO DA TERRINHA 40 - FD 10":[{"n":"MP - CHA MATE TOSTADO RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.418604},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.002083},{"n":"CAIXA CARTUCHO CHA MATE DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.395348},{"n":"INDL - CHA MATE DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 210 MM","c":"OUTROS","q":10.0}],"01310 CHA VERDE DA TERRINHA 16 G - FD 10":[{"n":"MP - CHA VERDE RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.166667},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA VERDE DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.0},{"n":"INDL - CHA VERDE DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"01307 CHA DE QUENTAO DA TERRINHA 20 G - FD 10":[{"n":"MP - CHA QUENTAO RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.204082},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA QUENTAO DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.05102},{"n":"INDL - CHA QUENTAO DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"01306 CHA DE MACA C/ CANELA DA TERRINHA 20 G-FD 10":[{"n":"MP - CHA DE MACA E CANELA RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.2},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA MACA C/ CANELA DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.148936},{"n":"INDL - CHA MACA C/ CANELA DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"01305 CHA DE HORTELA DA TERRINHA 10 G - FD 10":[{"n":"MP - CHA HORTELA / MENTA PIPERITA RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.106829},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA HORTELA DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.092593},{"n":"INDL - CHA HORTELA DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"01304 CHA DE ERVA DOCE DA TERRINHA 16 G - FD 10":[{"n":"MP - CHA ERVA DOCE / ANIZ RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.166966},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA ERVA DOCE DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.18851},{"n":"INDL - CHA ERVA DOCE DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"01301 CHA DE CAMOMILA DA TERRINHA 10 G - FD 10":[{"n":"MP - CHA CAMOMILA FLOR RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.1},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA CAMOMILA DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.142857},{"n":"INDL - CHA CAMOMILA DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"01300 CHA DE BOLDO DA TERRINHA 10 G - FD 10":[{"n":"MP - CHA BOLDO DO CHILE RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.105263},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA BOLDO DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.167464},{"n":"INDL - CHA BOLDO DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"01302 CHA DE CARQUEJA DA TERRINHA 10 G - FD 10":[{"n":"MP - CHA CARQUEJA RAZURADA PARA SACHE KG","c":"MATERIA PRIMA","q":0.109453},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA CARQUEJA DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.20398},{"n":"INDL - CHA CARQUEJA DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"01303 CHA DE CIDREIRA DA TERRINHA 10 G - FD 10":[{"n":"MP - CHA CAPIM CIDREIRA  RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.1},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"CAIXA CARTUCHO CHA ERVA CIDREIRA DA TERRINHA","c":"EMBALAGEM TERCIARIA","q":10.0},{"n":"INDL - CHA CIDREIRA DA TERRINHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0}],"09002 SAGU MANDIOCA N.88 - 1 TONELADA":[{"n":"09002 SAGU MANDIOCA N.88 KG","c":"OUTROS","q":1.0}],"00045 TAPIOCA PATATI PATATA 560 G - CX 12":[{"n":"CAIXA PAPELAO TAPIOCA DELIOCA WRAP PATATI UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":4.572672836145889},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.1473271638541096},{"n":"BOBINA POUCH PATATI PATATA 560 G","c":"EMBALAGEM PRIMARIA","q":0.144},{"n":"BOBINA TAPIOCA PATATI 80 G / PATATA 80 G / JOAOZINHO 80 G","c":"EMBALAGEM PRIMARIA","q":0.2184},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.153608}],"11112 ALHO TRITURADO OKKER 3 KG - UND":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.010473058685132855},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.6866078683435002},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.1971451786992002},{"n":"BALDE SGF ALHO TRIT OKKER 3.2","c":"OUTROS","q":1.0},{"n":"TAMPA LEITOSA BALDE OKKER 3.2","c":"OUTROS","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.04577385788956668},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.008788580714796802},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0028562887323089607},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0028562887323089607},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.021971451786992006},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.021971451786992006},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0027464314733740007},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0036619086311653346},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.014647634524661338}],"30601 ALHO E CEBOLA OKKER 3 KG - UND":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.006283835211079713},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.4119647210061001},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.23644868377207595},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.2640818423078244},{"n":"BALDE LISO OKKER 3.2","c":"OUTROS","q":1.0},{"n":"TAMPA LEITOSA BALDE OKKER 3.2","c":"OUTROS","q":1.0},{"n":"ETIQ BRANCA  COLUNAS OKKER 120X49","c":"OUTROS","q":2.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.02746431473374001},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.008291642264266284},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0017137732393853766},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0031224036958998717},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.020729105660665714},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.020729105660665714},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0016478588840244006},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.002197145178699201},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.014825568385573211}],"11110 ALHO TRITURADO OKKER 2 KG - UND":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.0069820391234219036},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.45773857889566677},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.4647634524661337},{"n":"BALDE SGF ALHO TRIT OKKER 2.2","c":"OUTROS","q":1.0},{"n":"TAMPA LEITOSA BALDE OKKER 2.2","c":"OUTROS","q":1.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.03051590525971112},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.005859053809864535},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0019041924882059738},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0019041924882059738},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.014647634524661337},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.014647634524661337},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.001830954315582667},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.00244127242077689},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.00976508968310756}],"00304 FAROFA PRONTA DA TERRINHA TRADICIONAL 150 G - FD 24":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.021722},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.1792206181731753},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.01515748845188025},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.014776167987682007},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.03145893829635523},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.002383252901239033},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.009533011604956131},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.0014299517407434198},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.00857971044446052},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0044},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.014299517407434199},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.018303382281515776},{"n":"BOBINA FAROFA PRONTA TRADICIONAL DA TERRINHA 150 G","c":"EMBALAGEM PRIMARIA","q":0.1392},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.057198069629736795},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":3.336554061734646},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.0009533011604956133},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0001525281856792981}],"SACO EMBALAGEM FECULA TERRAFEC":[{"n":"SACO EMBALAGEM FECULA S/ IMPRESSAO","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACOS DE PAPEL KRAFT MIS 1090X780 G80F2V120 FECULA DE MANDIOCA TERRAFEC 25K","c":"EMBALAGEM PRIMARIA","q":1.0}],"01774 MANJERICAO DA TERRINHA 10 G - CX 12":[{"n":"MP - MANJERICAO FLOCOS KG","c":"MATERIA PRIMA","q":0.156},{"n":"SACO PLASTICO FARDO LISO 25 X 30  UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001111},{"n":"BOBINA MANJERICAO DA TERRINHA 10 G.","c":"EMBALAGEM PRIMARIA","q":0.0282}],"09008 FARINHA DE MANDIOCA TORRADA KG":[{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.16},{"n":"09006 FECULA MANDIOCA INDL/REPROC KG","c":"OUTROS","q":1.0},{"n":"SACARIA RAFIA FARINHA 25 KG","c":"OUTROS","q":0.04}],"09014 FECULA MANDIOCA BIG BAG KG":[{"n":"09003 FECULA MANDIOCA TERRAFEC KG","c":"OUTROS","q":1.0},{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.16},{"n":"SUB - RENDIMENTO FECULA KG","c":"OUTROS","q":1.0},{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.05},{"n":"SUB - RENDIMENTO FECULA KG","c":"OUTROS","q":1.001676},{"n":"09003 FECULA MANDIOCA TERRAFEC KG","c":"OUTROS","q":1.0},{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.1},{"n":"SUB - RENDIMENTO FECULA KG","c":"OUTROS","q":1.0}],"00312 FAROFA PRONTA DA TERRINHA APIMENTADA 400 G - CX 20":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.041667},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.39734416561849184},{"n":"BOBINA FAROFA PRONTA APIMENTADA DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.171666},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.03360517145390437},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.03275975833556715},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.06974658226282036},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.008454131183372167},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.021135327958430414},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.019021795162587375},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.019021795162587375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.017},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.03170299193764563},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.0405798296801864},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.1268119677505825},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":7.3973647854506455},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.0021135327958430416},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0003381652473348867}],"14003 TAPIOCA TRADICIONAL SELECT 500 GR - UND FD 24.0":[{"n":"BOBINA PARA FARDOS 90,0 CM 500G LISO","c":"EMBALAGEM PRIMARIA","q":0.048},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA SELECT 500 G","c":"EMBALAGEM PRIMARIA","q":0.1536},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"14004 TAPIOCA TRADICIONAL SELECT 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG LISO","c":"EMBALAGEM PRIMARIA","q":0.043},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0176},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA SELECT 1 KG","c":"EMBALAGEM PRIMARIA","q":0.096},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"14312 FAROFA PRONTA SELECT TRADICIONAL 400 G - FD 24":[{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.4779216484618008},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.040419969205014},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.03940311463381868},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.08389050212361396},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.0063553410699707545},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.025421364279883018},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.003813204641982453},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.022879227851894716},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.020408},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.038132046419824525},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.0488090194173754},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.1525281856792981},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":8.897477497959056},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.002542136427988302},{"n":"BOBINA FARDOS FAROFA PRONTA TRAD.  113,0 CM COM COD. BARRAS","c":"EMBALAGEM PRIMARIA","q":0.05},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0004067418284781283},{"n":"BOBINA FAROFA PRONTA TRADICIONAL SELECT 400G","c":"EMBALAGEM PRIMARIA","q":0.206}],"SACOLA DA TERRINHA RETORNAVEL MEDIA - CX 100":[{"n":"SACOLA DA TERRINHA RETORNAVEL MEDIA - CX 100","c":"EMBALAGEM PRIMARIA","q":1.0}],"SACOLA DA TERRINHA RETORNAVEL MINI - CX 100":[{"n":"SACOLA DA TERRINHA RETORNAVEL MINI - CX 100","c":"EMBALAGEM PRIMARIA","q":1.0}],"01732 CHIMICHURRI DA TERRINHA 20g - UND PC 24.0":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"MP - CHIMICHURRI KG","c":"MATERIA PRIMA","q":0.504},{"n":"BOBINA CHIMICHURRI FLOCOS DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"00302 FAROFA ARTESANAL DA TERRINHA APIMENTADA 300 G  EXP CX 20":[{"n":"00302 FAROFA ARTESANAL DA TERRINHA APIMENTADA 300 G  EXP CX 20","c":"OUTROS","q":1.0}],"01003 PANETTONE ROMANATO SONHO FRUTAS 400 G  - CX 12":[{"n":"01003 PANETTONE ROMANATO SONHO FRUTAS 400 G  - CX 12","c":"OUTROS","q":1.0}],"01004 PANETTONE ROMANATO SONHO GOTAS CHOCOLATE 400 G   - CX 12":[{"n":"01004 PANETTONE ROMANATO SONHO GOTAS CHOCOLATE 400 G   - CX 12","c":"OUTROS","q":1.0}],"00061 TAPIOCA CHAMA 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG LISO","c":"EMBALAGEM PRIMARIA","q":0.043},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224},{"n":"BOBINA TAPIOCA CHAMA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.1152}],"00069 TAPIOCA RANCHO NA MEDIDA  490 G CX 16.0":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":5.334784975503538},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.5052150244964615},{"n":"CAIXA PAPELAO JAPAO 24 X 700GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TAPIOCA DO RANCHO 70G","c":"EMBALAGEM PRIMARIA","q":0.294},{"n":"SACO POUCH TAPIOCA DO RANCHO 490GR","c":"EMBALAGEM PRIMARIA","q":16.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.20481}],"CANJICA BRANCA DA TERRINHA 5 KG - UND":[{"n":"MP - CANJICA BRANCA KG","c":"MATERIA PRIMA","q":5.0},{"n":"SACO PLASTICO FARDO LISO 30 X 40 UNID","c":"EMBALAGEM PRIMARIA","q":1.0}],"30101 ALHO PASTA BISNAGA CEBOLA C/ SALSA OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.006440669221533647},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.4222466709921534},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.10460182022659112},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.093333},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.7695966280812554},{"n":"ETIQ ALHO PASTA CEBOLA E SALSA OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.028149778066143563},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.006740099774570941},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0017565461513273583},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0023797059314006673},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.01685024943642735},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.01685024943642735},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.001688986683968614},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.002251982245291485},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.10501161375290868},{"n":"TAMPA AMARELA BISNAGA OKKER","c":"OUTROS","q":12.0},{"n":"BISNAGA SOPRADO OKKER 200G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":2.0}],"30102 ALHO PASTA BISNAGA ERVAS FINAS OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.0073754057508762134},{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":0.002},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.48352747492632525},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.005333},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.04891050066644451},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.013333},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.7429299224300188},{"n":"ETIQ ALHO PASTA COM ERVAS FINAS OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - LOURO MOIDO OKKER KG","c":"MATERIA PRIMA","q":0.003333},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.03223516499508835},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.006813541049266893},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.002011474295693513},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0023028560017914804},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.01703385262316723},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.01703385262316723},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.001934109899705301},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0025788131996070684},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.10489703153884813},{"n":"TAMPA AMARELA BISNAGA OKKER","c":"OUTROS","q":12.0},{"n":"BISNAGA SOPRADO OKKER 200G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":2.0}],"30103 ALHO PASTA BISNAGA PIMENTA CALABRESA OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.007546706768376244},{"n":"MP - TEMPERO BAIANO KG","c":"MATERIA PRIMA","q":0.069333},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.49475787380089015},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.048},{"n":"MP - CEBOLA DESID GRANULADA KG","c":"MATERIA PRIMA","q":0.03710862212595801},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.7316596846666805},{"n":"ETIQ ALHO PASTA PIMENTA CALABRESA OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.03298385825339268},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.00680662787562107},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0020581927550117033},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.002279265397464219},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.017016569689052678},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.017016569689052678},{"n":"MP - COLORAU  OKKER KG","c":"MATERIA PRIMA","q":0.010667},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.001979031495203561},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0026387086602714144},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.01150228882302501},{"n":"TAMPA AMARELA BISNAGA OKKER","c":"OUTROS","q":12.0},{"n":"BISNAGA SOPRADO OKKER 200G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":2.0}],"30104 ALHO PASTA BISNAGA TEMPERO DE AVES OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.008097812678123142},{"n":"MP - ACAFRAO/CURCUMA MOIDA KG","c":"MATERIA PRIMA","q":0.034667},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.5308880689328983},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.013333},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.6988418205852747},{"n":"ETIQ ALHO PASTA TEMPERO PARA AVES OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.035392537928859893},{"n":"MP - MANJERONA OKKER KG","c":"MATERIA PRIMA","q":0.003333},{"n":"MP - CALDO DE GALINHA KG","c":"MATERIA PRIMA","q":0.013333},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.006795367282341099},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.002208494366760857},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.002208494366760857},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.016988418205852746},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.016988418205852746},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.0021235522757315933},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0028314030343087916},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.10465861213723517},{"n":"TAMPA AMARELA BISNAGA OKKER","c":"OUTROS","q":12.0},{"n":"BISNAGA SOPRADO OKKER 200G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":2.0}],"30105 ALHO PASTA BISNAGA OKKER 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.008657312296105849},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.5675685508810652},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.8162193628194088},{"n":"ETIQ ALHO PASTA BISNAGA OKKER 200G","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.03783790339207102},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.007264877451277635},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.002270274203524261},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0030270322713656815},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.012108129085462726},{"n":"TAMPA AMARELA BISNAGA OKKER","c":"OUTROS","q":12.0},{"n":"BISNAGA SOPRADO OKKER 200G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":2.0}],"11122 ALHO PASTA OKKER 2 KG - CX 6":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.04189223474053142},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":2.7464314733740007},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":8.788580714796801},{"n":"BALDE SGF ALHO PASTA OKKER 2.2","c":"OUTROS","q":6.0},{"n":"TAMPA LEITOSA BALDE OKKER 2.2","c":"OUTROS","q":6.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.1830954315582667},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.03515432285918721},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.011425154929235843},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.011425154929235843},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.08788580714796802},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.08788580714796802},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.010985725893496003},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.014647634524661338},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.05859053809864535},{"n":"CAIXA PAPELAO LISA OKKER 6 X 2 KG","c":"EMBALAGEM TERCIARIA","q":1.0}],"00154 BANANINHA CREMOSA TRADICIONAL DA TERRINHA 30G  - 6DP x 12UN":[{"n":"00154 BANANINHA CREMOSA TRADICIONAL DA TERRINHA 30G  - 6DP x 12UN","c":"OUTROS","q":1.0}],"00155 BANANINHA ZERO DA TERRINHA 22G - 6DP x 12UN":[{"n":"00155 BANANINHA ZERO DA TERRINHA 22G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00155 BANANINHA ZERO DA TERRINHA 22G - UND CX 12.0":[{"n":"00155 BANANINHA ZERO DA TERRINHA 22G - UND CX 12.0","c":"OUTROS","q":1.0}],"00156 BANANINHA COM AMENDOIM DA TERRINHA 25G   - 6DP x 12UN":[{"n":"00156 BANANINHA COM AMENDOIM DA TERRINHA 25G   - 6DP x 12UN","c":"OUTROS","q":1.0}],"00157 GOIABINHA TRADICIONAL DA TERRINHA 30G - 6DP x 12UN":[{"n":"00157 GOIABINHA TRADICIONAL DA TERRINHA 30G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00158 GOIABINHA ZERO DA TERRINHA 22G - 6DP x 12UN":[{"n":"00158 GOIABINHA ZERO DA TERRINHA 22G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00159 COCADA COM ABACAXI ZERO DA TERRINHA 22G - 6DP x 12UN":[{"n":"00159 COCADA COM ABACAXI ZERO DA TERRINHA 22G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00160 COCADA COM CHOCOLATE ZERO DA TERRINHA 25G - 6DP x 12UN":[{"n":"00160 COCADA COM CHOCOLATE ZERO DA TERRINHA 25G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00160 COCADA COM CHOCOLATE ZERO DA TERRINHA 25G - DISPLAY 12":[{"n":"00160 COCADA COM CHOCOLATE ZERO DA TERRINHA 25G - DISPLAY 12","c":"OUTROS","q":1.0}],"00164 WAFER COOKIES CREAM E WHEY PROTEIN ZERO DA TERRINHA 25G - 6DP x 12UN":[{"n":"00164 WAFER COOKIES CREAM E WHEY PROTEIN ZERO DA TERRINHA 25G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00164 WAFER COOKIES E CREAM E WHEY PROTEIN ZERO DA TERRINHA 25G CX 12":[{"n":"00164 WAFER COOKIES E CREAM E WHEY PROTEIN ZERO DA TERRINHA 25G CX 12","c":"OUTROS","q":1.0}],"00165 WAFER DE DOCE LEITE COCO E WHEY PROTEIN ZERO DA TERR.  25G - 6DP x 12":[{"n":"00165 WAFER DE DOCE LEITE COCO E WHEY PROTEIN ZERO DA TERR.  25G - 6DP x 12","c":"OUTROS","q":1.0}],"00165 WAFER DE DOCE DE LEITE C/ COCO E WHEY PROTEIN ZERO DA TERRINHA CX 12":[{"n":"00165 WAFER DE DOCE DE LEITE C/ COCO E WHEY PROTEIN ZERO DA TERRINHA CX 12","c":"OUTROS","q":1.0}],"00161 COCO E PROTEINA DA TERRINHA 40G - 6DP x 12UN":[{"n":"00161 COCO E PROTEINA DA TERRINHA 40G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00161 COCO E PROTEINA DA TERRINHA 40G CX 12":[{"n":"00161 COCO E PROTEINA DA TERRINHA 40G CX 12","c":"OUTROS","q":1.0}],"00163 NUTS COM PROTEINA DA TERRINHA 40G - 6DP x 12UN":[{"n":"00163 NUTS COM PROTEINA DA TERRINHA 40G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00163 NUTS COM PROTEINAS DA TERRINHA 40G CX 12.0":[{"n":"00163 NUTS COM PROTEINAS DA TERRINHA 40G CX 12.0","c":"OUTROS","q":1.0}],"00162 NUTS E FRUITS CRANBERRY ZERO DA TERRINHA 25G - 6DP x 12UN":[{"n":"00162 NUTS E FRUITS CRANBERRY ZERO DA TERRINHA 25G - 6DP x 12UN","c":"OUTROS","q":1.0}],"00254 BATATA PALHA TRADICIONAL  PUBLIC 100 G - CX 20":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.007143},{"n":"BOBINA BATATA PALHA TRADICIONAL PUBLIC 100G","c":"EMBALAGEM PRIMARIA","q":0.178},{"n":"CAIXA PAPELAO BATATA PALHA LISA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"INDL -BATATA PALHA TRADICIONAL PUBLIC 100 g - UND","c":"OUTROS","q":20.0}],"00255 BATATA PALHA EXTRA FINA  PUBLIC 100 g - CX 20":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.007143},{"n":"BOBINA BATATA PALHA EXTRA FINA PUBLIC 100 G","c":"EMBALAGEM PRIMARIA","q":0.178},{"n":"CAIXA PAPELAO BATATA PALHA LISA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"INDL - BATATA PALHA EXTRA FINA PUBLIC 100 g - UND","c":"OUTROS","q":20.0}],"00117 TAPIOCA X 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG LISO","c":"EMBALAGEM PRIMARIA","q":0.043},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0176},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224},{"n":"BOBINA TAPIOCA X 1KG","c":"EMBALAGEM PRIMARIA","q":0.096}],"00118 TAPIOCA X 500 G - FD 24":[{"n":"BOBINA PARA FARDOS 90,0 CM 500G LISO","c":"EMBALAGEM PRIMARIA","q":0.048},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224},{"n":"BOBINA TAPIOCA X 500G","c":"EMBALAGEM PRIMARIA","q":0.1536}],"14007 TAPIOCA NAGUMO 1KG - FD 12":[{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG LISO","c":"EMBALAGEM PRIMARIA","q":0.043},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0176},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224},{"n":"BOBINA TAPIOCA NAGUMO 1KG","c":"EMBALAGEM PRIMARIA","q":0.096}],"00072 TAPIOCA WRAPIOCA 630 G - CX 10":[{"n":"SACO POUCH TAPIOCA WRAPIOCA 630GR - UNID","c":"EMBALAGEM PRIMARIA","q":10.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":4.2868807838867715},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.013119216113228},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.128006},{"n":"BOBINA TAPIOCA WRAPIOCA 90 G","c":"EMBALAGEM PRIMARIA","q":0.175}],"01615 ERVILHA PARTIDA DA TERRINHA 350 G - CX 12":[{"n":"MP - ERVILHA PARTIDA KG","c":"MATERIA PRIMA","q":4.2},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003125},{"n":"BOBINA ERVILHA DA TERRINHA PREMIUM 350 G","c":"EMBALAGEM PRIMARIA","q":0.054},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MENOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"01704 ALHO DESIDRATADO GRANULADO DA TERRINHA 20 G - CX 24":[{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.495049},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA ALHO DESID GRANULADO DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01784 OREGANO DA TERRINHA 100 G - FD 12":[{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":1.212},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA OREGANO DA TERRINHA 100 G","c":"EMBALAGEM PRIMARIA","q":0.06}],"01759 ERVA DOCE DA TERRINHA 15 G - CX 24":[{"n":"MP - ERVA DOCE EM GRAO KG","c":"MATERIA PRIMA","q":0.384},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA ERVA DOCE DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01813 SALSA DESIDRATADA DA TERRINHA 08 G - CX 24":[{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.228},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA SALSA DESIDRATADA 8 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01774 MANJERICAO DA TERRINHA 10 G - CX 24":[{"n":"MP - MANJERICAO FLOCOS KG","c":"MATERIA PRIMA","q":0.264},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA MANJERICAO DA TERRINHA 10 G.","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01825 TEMPERO PARA FRANGO DA TERRINHA 50 G - CX 24":[{"n":"MP - TEMPERO PARA FRANGO E ARROZ KG","c":"MATERIA PRIMA","q":1.24704},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TEMPERO PARA FRANGO DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.0576}],"01822 TEMPERO PARA CHURRASCO DA TERRINHA 40G - CX 24":[{"n":"MP - TEMPERO PARA CHURRASCO KG","c":"MATERIA PRIMA","q":1.008},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA TEMPERO CHURRASCO EM PO DA TERRINHA 40 G","c":"EMBALAGEM PRIMARIA","q":0.0576},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01821 TEMPERO PARA CARNE DA TERRINHA 50 G - CX 24":[{"n":"MP - TEMPERO PARA CARNE COM AMACIANTE KG","c":"MATERIA PRIMA","q":1.23984},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TEMPERO PARA CARNE DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.0576}],"01703 ALHO DESID FLOCOS DA TERRINHA 25 G - CX 24":[{"n":"MP - ALHO DESIDRATADO FLOCOS KG","c":"MATERIA PRIMA","q":0.6},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA ALHO DESID FLOCOS DA TERRINHA 25 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01702 ALECRIM DA TERRINHA 06 G  - CX 24":[{"n":"MP - ALECRIM KG","c":"MATERIA PRIMA","q":0.155963},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA ALECRIM DA TERRINHA 6 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01715 CAMOMILA DA TERRINHA 06 G  - CX 24":[{"n":"MP - CAMOMILA FLOR KG","c":"MATERIA PRIMA","q":0.168},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA CAMOMILA DA TERRINHA 6 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01750 CRAVO DA INDIA DA TERRINHA 10 G - CX 24":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"MP - CRAVO DA INDIA FLOR KG","c":"MATERIA PRIMA","q":0.285},{"n":"BOBINA CRAVO DA INDIA DA TERRINHA 10 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01619 SAGU MANDIOCA DA TERRINHA 400 G - CX 12":[{"n":"MP - SAGU MANDIOCA (TIPO 1) KG","c":"MATERIA PRIMA","q":4.880001},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003846},{"n":"BOBINA SAGU PREMIUM DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.054},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"01517 POLVILHO AZEDO DA TERRINHA 500 G FD 12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"MP - POLVILHO AZEDO KG","c":"MATERIA PRIMA","q":6.12},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"BOBINA POLVILHO AZEDO DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072}],"01777 NOZ MOSCADA BOLA DA TERRINHA 08 G  - CX 24":[{"n":"MP - NOZ MOSCADA BOLA KG","c":"MATERIA PRIMA","q":0.2304},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"SACO PLAST NOZ MOSCADA BOLA DA TERRINHA 8GR","c":"EMBALAGEM PRIMARIA","q":24.0},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"09518 MISTURA PAO DE QUEIJO DA TERRINHA 250G-CX 24":[{"n":"MP - MISTURA PAO DE QUEIJO KG AMP 30","c":"MATERIA PRIMA","q":6.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005495},{"n":"CAIXA PAPELAO LISA OKKER 6 X 2 KG","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA MISTURA PAO DE QUEIJO DA TERRINHA 250G","c":"EMBALAGEM PRIMARIA","q":0.192}],"00931 COCO RALADO DESIDRATADO DA TERRINHA 50 G -  CX 50":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003846},{"n":"MP - COCO RALADO FINO KG","c":"MATERIA PRIMA","q":2.85},{"n":"BOBINA COCO RALADO DA TERRINHA DESIDRATADO 50 G","c":"EMBALAGEM PRIMARIA","q":0.170186},{"n":"CAIXA COCO RALADO","c":"EMBALAGEM TERCIARIA","q":1.0}],"00932 COCO RALADO DESIDRATADO DATERRINHA 100 G - CX 24":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003846},{"n":"MP - COCO RALADO FINO KG","c":"MATERIA PRIMA","q":2.449992},{"n":"BOBINA COCO RALADO DESIDRATADO DA TERRINHA 100 G","c":"EMBALAGEM PRIMARIA","q":0.103593},{"n":"CAIXA COCO RALADO","c":"EMBALAGEM TERCIARIA","q":1.0}],"00933 COCO RALADO UMIDO ADOCADO DA TERRINHA 50 G - CX 50":[{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.0824487866372518},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003846},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":0.1374146443954197},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.002610878243512974},{"n":"MP - COCO RALADO FINO KG","c":"MATERIA PRIMA","q":1.6489757327450363},{"n":"MP - PROPILENOGLICOL 1KG","c":"MATERIA PRIMA","q":0.002610878243512974},{"n":"BOBINA COCO RALADO UMIDO ADOCADO DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.173949},{"n":"CAIXA COCO RALADO","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ACUCAR DE CONFEITEIRO","c":"MATERIA PRIMA","q":0.8244878663725181}],"00934 COCO RALADO UMIDO ADOCADO DA TERRINHA 100 G - CX 24":[{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.07721374093917428},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003846},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":0.12868956823195715},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.0024451017964071857},{"n":"MP - COCO RALADO FINO KG","c":"MATERIA PRIMA","q":1.5442748187834858},{"n":"MP - PROPILENOGLICOL 1KG","c":"MATERIA PRIMA","q":0.0024451017964071857},{"n":"BOBINA COCO RALADO UMIDO ADOCADO DA TERRINHA 100 G","c":"EMBALAGEM PRIMARIA","q":0.104949},{"n":"CAIXA COCO RALADO","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ACUCAR DE CONFEITEIRO","c":"MATERIA PRIMA","q":0.7721374093917429}],"01603 CANJICA BRANCA DA TERRINHA 500 G FD 12":[{"n":"MP - CANJICA BRANCA KG","c":"MATERIA PRIMA","q":6.1},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA CANJICA BRANCA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072},{"n":"MP - CANJICA BRANCA KG","c":"MATERIA PRIMA","q":6.1},{"n":"CANECA ADLIN MOD. 511 COM FURACAO-NATURALe: 234...","c":"OUTROS","q":0.003333},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA CANJICA BRANCA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072}],"01608 LENTILHA DA TERRINHA 500 G FD 12":[{"n":"MP - LENTILHA KG","c":"MATERIA PRIMA","q":6.0},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003125},{"n":"BOBINA LENTILHA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072}],"01604 CANJIQUINHA XEREM DA TERRINHA 500 G FD 12":[{"n":"MP - CANJIQUINHA DE MILHO / MASTER G1 KG","c":"MATERIA PRIMA","q":6.0},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA CANJIQUINHA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072}],"01606 FEIJAO BRANCO DA TERRINHA 500 G FD 12":[{"n":"MP - FEIJAO BRANCO KG","c":"MATERIA PRIMA","q":6.1},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA FEIJAO BRANCO DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.0504}],"01607 GRAO DE BICO DA TERRINHA 500 G FD 12":[{"n":"MP - GRAO DE BICO 9MM KG","c":"MATERIA PRIMA","q":6.1},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA GRAO DE BICO DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072}],"01754 CURRY EM PO DA TERRINHA 15 G - CX 24":[{"n":"MP - CURRY KG","c":"MATERIA PRIMA","q":0.396},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA CURRY EM PO DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01804 PIMENTA COM  COMINHO PO DA TERRINHA 50G - CX 24":[{"n":"MP - PIMENTA COM COMINHO PO / MOIDO KG","c":"MATERIA PRIMA","q":1.248},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA PIMENTA COM COMINHO DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.06},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01734 COENTRO EM PO DA TERRINHA 18 G  - CX 24":[{"n":"MP - COENTRO EM PO/ MOIDO KG","c":"MATERIA PRIMA","q":0.447192},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA COENTRO EM PO DA TERRINHA 18 G","c":"EMBALAGEM PRIMARIA","q":0.0576}],"01708 BICARBONATO DE SODIO DA TERRINHA 20 G -  CX 24":[{"n":"MP - BICARBONATO DE SODIO KG","c":"MATERIA PRIMA","q":0.528},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA BICARBONATO DE SODIO DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"00004 TAPIOCA DA TERRINHA NA MEDIDA 90 G - CX 100":[{"n":"BOBINA TAPIOCA DA TERRINHA 90 G","c":"EMBALAGEM PRIMARIA","q":0.27},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.124115405552531},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.8758845944474687},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.182866}],"00312 FAROFA PRONTA DA TERRINHA APIMENTADA 400 G - FD 24":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.05},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.47681299874219024},{"n":"BOBINA FAROFA PRONTA APIMENTADA DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.206},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.04032620574468524},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.03931171000268058},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.08369589871538445},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.010144957420046601},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.0253623935501165},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.02282615419510485},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.02282615419510485},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.020408},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.03804359032517476},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.048695795616223676},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.15217436130069903},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":8.876837742540776},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.0025362393550116503},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0004057982968018641}],"00502 BOLACHA DA TERRINHA BRASIL 250 G - FD 20":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.010204},{"n":"BOBINA BOLACHA BRASIL DA TERRINHA 250 G","c":"EMBALAGEM PRIMARIA","q":0.15},{"n":"INDL - BOLACHA DA TERRINHA BRASIL 250 g - UND","c":"OUTROS","q":20.0}],"00501 BOLACHA DA TERRINHA AMANTEIGADA 250 G - FD 20":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.010204},{"n":"BOBINA BOLACHA AMANTEIGADA DA TERRINHA 250 G","c":"EMBALAGEM PRIMARIA","q":0.15},{"n":"INDL - BOLACHA DA TERRINHA AMANTEIGADA 250 g - UND","c":"OUTROS","q":20.0}],"00601 MOLHO ALHO DA TERRINHA 150 ML CX 12":[{"n":"00601 MOLHO ALHO DA TERRINHA 150 ML CX 12","c":"OUTROS","q":1.0}],"00604 MOLHO PIMENTA CALABRESA DA TERRINHA 150 CX12":[{"n":"00604 MOLHO PIMENTA CALABRESA DA TERRINHA 150 CX12","c":"OUTROS","q":1.0}],"00605 MOLHO PIMENTA SCORPION DA TERRINHA 150 CX12":[{"n":"00605 MOLHO PIMENTA SCORPION DA TERRINHA 150 CX12","c":"OUTROS","q":1.0}],"00606 MOLHO PIMENTA VERMELHA DA TERRINHA 150  - CX 12":[{"n":"00606 MOLHO PIMENTA VERMELHA DA TERRINHA 150  - CX 12","c":"OUTROS","q":1.0}],"00701 PIMENTA BIQUINHO DA TERRINHA 140 G CX 12":[{"n":"00701 PIMENTA BIQUINHO DA TERRINHA 140 G CX 12","c":"OUTROS","q":1.0}],"00702 PIMENTA MALAGUETA VERM DA TERRINHA 70G CX 12":[{"n":"00702 PIMENTA MALAGUETA VERM DA TERRINHA 70G CX 12","c":"OUTROS","q":1.0}],"00607 MOLHO PIMENTA PREMIUM DA TERRINHA 60 ML CX12":[{"n":"00607 MOLHO PIMENTA PREMIUM DA TERRINHA 60 ML CX12","c":"OUTROS","q":1.0}],"00921 OLEO DE COCO DA TERRINHA EX VIRGEM 200ML - FD 12":[{"n":"00921 OLEO DE COCO DA TERRINHA EX VIRGEM 200ML - FD 12","c":"OUTROS","q":1.0}],"00923 OLEO DE COCO DA TERRINHA SEM SABOR 200ml - UND FD 12.0":[{"n":"00923 OLEO DE COCO DA TERRINHA SEM SABOR 200ml - UND FD 12.0","c":"OUTROS","q":1.0}],"00922 OLEO DE COCO DA TERRINHA EX VIRGEM 500 ML - FD 6":[{"n":"00922 OLEO DE COCO DA TERRINHA EX VIRGEM 500 ML - FD 6","c":"OUTROS","q":1.0}],"00007 TAPIOCA DA TERRINHA TRADICIONAL 240 G - CX 03":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.48992923244420244},{"n":"CAIXA PAPELAO TAPIOCA DA TERRINHA FORTIFICADA","c":"EMBALAGEM TERCIARIA","q":0.125},{"n":"CAIXA CARTUCHO TAPIOCA DA TERRINHA NA MEDIDA 240GR","c":"EMBALAGEM TERCIARIA","q":3.0},{"n":"CAIXA DISPLAY TAPIOCA TRADICIONAL 240GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":0.23007076755579747},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.016458}],"01503 FARINHA MANDIOCA TORRADA DA TERRINHA 500G FD12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.26},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"BOBINA FARINHA DE MANDIOCA TORRADA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072},{"n":"09018 FARINHA DE MANDIOCA TORRADA BIG BAG KG","c":"OUTROS","q":6.348}],"01521 TRIGO PARA KIBE DA TERRINHA 500 G FD 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.002941},{"n":"INDL - TRIGO PARA KIBE DA TERRINHA BOBINA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"BOBINA TRIGO PARA KIBE DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.078}],"01518 POLVILHO DOCE DA TERRINHA 500 G - FD 12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"BOBINA POLVILHO DOCE DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072},{"n":"09014 FECULA MANDIOCA BIG BAG KG","c":"OUTROS","q":6.12}],"12521 TRIGO PARA KIBE OBA 500 G FD 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.002941},{"n":"INDL - TRIGO PARA KIBE OBA 500GR","c":"OUTROS","q":12.0},{"n":"BOBINA TRIGO PARA KIBE OBA 500 G","c":"EMBALAGEM PRIMARIA","q":0.078}],"002439 FECULA MANDIOCA DA TERRINHA 1 KG - FD 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"BOBINA FECULA DE MANDIOCA DA TERRINHA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.096},{"n":"09014 FECULA MANDIOCA BIG BAG KG","c":"OUTROS","q":12.0},{"n":"BOBINA PARA FARDOS FECULA 113,0 CM COM COD. BARRAS","c":"EMBALAGEM PRIMARIA","q":0.04}],"01601 AMENDOIM CRU DA TERRINHA 500 G FD 12":[{"n":"INDL - AMENDOIM CRU DA TERRINHA 500 G","c":"OUTROS","q":12.0},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AMENDOIM CRU RUNNER HPS KILO","c":"MATERIA PRIMA","q":6.0732},{"n":"BOBINA AMENDOIM CRU DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.084}],"01513 FLOCOS DE MILHO ( CUSCUZ ) DA TERRINHA 500 G - FD 30":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.007937},{"n":"INDL - FLOCOS DE MILHO ( CUSCUZ ) DA TERRINHA 500 g","c":"OUTROS","q":30.0},{"n":"BOBINA FLOCOS MILHO (CUSCUZ) DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.15},{"n":"SELO FECHA FACIL 30X60MM DA TERRINHA","c":"OUTROS","q":30.0},{"n":"SACO FARDO PAPEL KRAFT CUSCUZ 100X70X1X120","c":"EMBALAGEM PRIMARIA","q":1.0}],"00104 TAPIOCA DA GOMA 1 KG - CX 10":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.804572672836145},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.195427327163854},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.017686}],"00103 TAPIOCA DA GOMA 500 G - CX 20":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.804572672836145},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.195427327163854},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00102 TAPIOCA DA GOMA 400 G - CX 25":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":6.804572672836145},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.195427327163854},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.02682}],"00620 MOLHO ARABE COM ALHO DA TERRINHA 150 ML - CX 12":[{"n":"00620 MOLHO ARABE COM ALHO DA TERRINHA 150 ML - CX 12","c":"OUTROS","q":1.0}],"00621 MOLHO ARABE COM PIMENTA DA TERRINHA 150 ML - CX 12":[{"n":"00621 MOLHO ARABE COM PIMENTA DA TERRINHA 150 ML - CX 12","c":"OUTROS","q":1.0}],"00622 MOLHO ARABE COM TOMATE DA TERRINHA 150 ML - CX 12":[{"n":"00622 MOLHO ARABE COM TOMATE DA TERRINHA 150 ML - CX 12","c":"OUTROS","q":1.0}],"00600 MOLHO DE PIMENTA CREMOSO DA TERRINHA 150 ML - CX 12":[{"n":"00600 MOLHO DE PIMENTA CREMOSO DA TERRINHA 150 ML - CX 12","c":"OUTROS","q":1.0}],"00608 MOLHO DE ALHO COM PIMENTA DA TERRINHA 150 ML - CX 12":[{"n":"00608 MOLHO DE ALHO COM PIMENTA DA TERRINHA 150 ML - CX 12","c":"OUTROS","q":1.0}],"00609 MOLHO DE PIMENTA CAROLINA REAPER DA TERRINHA 150 ML - CX 12":[{"n":"00609 MOLHO DE PIMENTA CAROLINA REAPER DA TERRINHA 150 ML - CX 12","c":"OUTROS","q":1.0}],"00015 TAPIOCA DA TERRINHA NA MEDIDA 70 G - CX 100":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":4.763200870985302},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.2367991290146976},{"n":"LOGISTICA - FILME STRETCH MANUAL 500x0,25","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"BOBINA TAPIOCA DA TERRINHA 70 G","c":"EMBALAGEM PRIMARIA","q":0.26},{"n":"CAIXA PAPELAO TAPIOCA MARCA PROPRIA","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.182826}],"00304 FAROFA PRONTA DA TERRINHA TRADICIONAL 150 G - FD 80":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.072407},{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.597402060577251},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.0505249615062675},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.04925389329227336},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.10486312765451745},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.007944176337463443},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.03177670534985377},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.0047665058024780665},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.028599034814868397},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.04766505802478067},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.06101127427171925},{"n":"BOBINA FAROFA PRONTA TRADICIONAL DA TERRINHA 150 G","c":"EMBALAGEM PRIMARIA","q":0.464},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.19066023209912267},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":11.12184687244882},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.0031776705349853777},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0005084272855976604}],"31001 ALHO FRITO GRANULADO DA TERRINHA POTE 90 G - UND CX 12.0":[{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LARANJA OKKER P220","c":"OUTROS","q":12.0},{"n":"MP - ALHO FRITO GRANULADO 8-16 MESH F GRANDE","c":"MATERIA PRIMA","q":1.1016},{"n":"ROTULO ALHO FRITO TERRINHA 90G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ AMARELO ESVERDEADO (PMS 585) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"31101 ALHO PASTA DA TERRINHA 400 G - UND CX 12.0":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.01698165104236147},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":1.1133075421128587},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.5625841347611478},{"n":"CAIXA PAPELAO LISA OKKER 12 x 400 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P500","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.07422050280752392},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.014250336539044593},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.004631359375189492},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.004631359375189492},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.03562584134761148},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.03562584134761148},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.004453230168451435},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0059376402246019136},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.023750560898407654},{"n":"ROTULO ALHO PASTA TERRINHA 400G","c":"OUTROS","q":12.0},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"31102 ALHO PASTA DA TERRINHA 800G - UND CX 12.0":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.03363032853487272},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":2.2047855245764456},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":7.055313678644626},{"n":"POTE LISO OKKER P900","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P900","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.14698570163842972},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.028221254714578505},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.009171907782238014},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.009171907782238014},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.07055313678644626},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.07055313678644626},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.008819142098305782},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.011758856131074379},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.047035424524297514},{"n":"ROTULO ALHO PASTA TERRINHA 800G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 X 800 G","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"31002 ALHO FRITO GRANULADO DA TERRINHA POTE 250 G - CX 12":[{"n":"CAIXA PAPELAO LISA OKKER 12 x 400 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":12.0},{"n":"TAMPA LARANJA OKKER P500","c":"OUTROS","q":12.0},{"n":"MP - ALHO FRITO GRANULADO 8-16 MESH F GRANDE","c":"MATERIA PRIMA","q":3.06},{"n":"ROTULO ALHO FRITO TERRINHA 250G","c":"OUTROS","q":12.0},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"31306 ALHO TRITURADO DA TERRINHA 3 KG - CX 6":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.06283835211079714},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":4.119647210061001},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":13.182871072195203},{"n":"BALDE LISO OKKER 3.2","c":"OUTROS","q":6.0},{"n":"TAMPA LEITOSA BALDE OKKER 3.2","c":"OUTROS","q":6.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.2746431473374001},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.05273148428878082},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.017137732393853765},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.017137732393853765},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.13182871072195204},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.13182871072195204},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.016478588840244005},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.02197145178699201},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.08788580714796804},{"n":"ROTULO ALHO TRITURADO TERRINHA 3 KG","c":"OUTROS","q":6.0},{"n":"CAIXA PAPELAO LISA OKKER 6 X 3 KG","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"00700 MOLHO PIMENTA BICO DOCE DEFUMADA  DA TERRINHA 270 G - CX 12":[{"n":"00700 MOLHO PIMENTA BICO DOCE DEFUMADA  DA TERRINHA 270 G - CX 12","c":"OUTROS","q":1.0}],"31104 ALHO PASTA DA TERRINHA 200 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.008657312296105849},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.5675685508810652},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.8162193628194088},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.03783790339207102},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.007264877451277635},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.002270274203524261},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0030270322713656815},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.012108129085462726},{"n":"ROTULO ALHO PASTA TERRINHA 200G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"31302 ALHO TRITURADO DA TERRINHA 400 GR - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.01698165104236147},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":1.1133075421128587},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.5625841347611478},{"n":"CAIXA PAPELAO LISA OKKER 12 x 400 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"POTE LISO P500 LACRE TPA OKKER","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P500","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.07422050280752392},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.014250336539044593},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.004631359375189492},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.004631359375189492},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.03562584134761148},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.03562584134761148},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.004453230168451435},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0059376402246019136},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.023750560898407654},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"ROTULO ALHO TRITURADO TERRINHA 400G","c":"OUTROS","q":12.0}],"00924 OLEO DE COCO DA TERRINHA SEM SABOR 500ML - FD 6":[{"n":"00924 OLEO DE COCO DA TERRINHA SEM SABOR 500ML - FD 6","c":"OUTROS","q":1.0}],"31304 ALHO TRITURADO DA TERRINHA 1,01 KG - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.042162775749784734},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":2.764167990589034},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":8.84533756988491},{"n":"POTE LISO OKKER P1000 P1100","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P1000 E P1100","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.18427786603926896},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.03538135027953964},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.011498938840850383},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.011498938840850383},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.08845337569884909},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.08845337569884909},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.011056671962356136},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.014742229283141518},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.05896891713256607},{"n":"CAIXA PAPELAO LISA OKKER 12 X 1 KG","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0},{"n":"ROTULO ALHO TRITURADO TERRINHA 1,01 KG","c":"OUTROS","q":12.0}],"20001 PIPOCA DE MICROONDAS NATURAL DA TERRINHA 85G CX 24":[{"n":"20001 PIPOCA DE MICROONDAS NATURAL DA TERRINHA 85G CX 24","c":"OUTROS","q":1.0}],"20003 PIPOCA DE MICROONDAS BACON DA TERRINHA 85G CX 24":[{"n":"20003 PIPOCA DE MICROONDAS BACON DA TERRINHA 85G CX 24","c":"OUTROS","q":1.0}],"20005 PIPOCA DE MICROONDAS CARAMELO  DA TERRINHA 85G CX 24":[{"n":"20005 PIPOCA DE MICROONDAS CARAMELO  DA TERRINHA 85G CX 24","c":"OUTROS","q":1.0}],"01311 CHA DE CAMOMILA DA TERRINHA 07 G - FD 10":[{"n":"MP - CHA CAMOMILA FLOR RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.0714},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0},{"n":"BOBINA ENVOLTORIO CHA CAMOMILA 1G DA TERRINHA","c":"EMBALAGEM PRIMARIA","q":0.02},{"n":"CAIXA CARTUCHO CHA CAMOMILA DA TERRINHA C/7 SACHES","c":"EMBALAGEM TERCIARIA","q":10.142857},{"n":"INDL - NOVO CHA DE CAMOMILA DA TERRINHA 07 G - UND","c":"OUTROS","q":10.0}],"01312 CHA DE CIDREIRA DA TERRINHA 07 G - FD 10":[{"n":"MP - CHA CAPIM CIDREIRA  RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.0714},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0},{"n":"BOBINA ENVOLTORIO CHA CAPIM CIDREIRA 1G DA TERRINHA","c":"EMBALAGEM PRIMARIA","q":0.02},{"n":"CAIXA CARTUCHO CHA CAPIM CIDREIRA DA TERRINHA C/7 SACHES","c":"EMBALAGEM TERCIARIA","q":10.120481},{"n":"INDL - NOVO CHA DE CIDREIRA DA TERRINHA 07 G - UND","c":"OUTROS","q":10.0}],"01313 CHA DE HORTELA DA TERRINHA 07 G - FD 10":[{"n":"MP - HORTELA KG","c":"MATERIA PRIMA","q":0.07478},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0},{"n":"BOBINA ENVOLTORIO CHA HORTELA 1G DA TERRINHA","c":"EMBALAGEM PRIMARIA","q":0.02},{"n":"CAIXA CARTUCHO CHA HORTELA DA TERRINHA C/7 SACHES","c":"EMBALAGEM TERCIARIA","q":0.070648},{"n":"INDL - NOVO CHA DE HORTELA DA TERRINHA 07 G - UND","c":"OUTROS","q":10.0}],"01314 CHA DE BOLDO DA TERRINHA 07 G - FD 10":[{"n":"MP - CHA BOLDO DO CHILE RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.073684},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"BOBINA ENVOLTORIO CHA BOLDO 1G DA TERRINHA","c":"EMBALAGEM PRIMARIA","q":0.02},{"n":"CAIXA CARTUCHO CHA BOLDO DA TERRINHA C/7 SACHES","c":"EMBALAGEM TERCIARIA","q":10.016746},{"n":"INDL - NOVO CHA DE BOLDO DA TERRINHA 07 G - UND","c":"OUTROS","q":10.0}],"01315 CHA DE ERVA DOCE DA TERRINHA 11,2 G - FD 10":[{"n":"MP - CHA ERVA DOCE / ANIZ RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.112},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0},{"n":"BOBINA ENVOLTORIO CHA ERVA DOCE 1,6G DA TERRINHA","c":"EMBALAGEM PRIMARIA","q":0.02},{"n":"CAIXA CARTUCHO CHA ERVA DOCE DA TERRINHA C/7 SACHES","c":"EMBALAGEM TERCIARIA","q":10.18851},{"n":"INDL - NOVO CHA DE ERVA DOCE DA TERRINHA 11,2 G - UND","c":"OUTROS","q":10.0}],"01316 CHA VERDE DA TERRINHA 11,2 G - FD 10":[{"n":"MP - CHA VERDE RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.116667},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0},{"n":"BOBINA ENVOLTORIO CHA VERDE 1,6G DA TERRINHA","c":"EMBALAGEM PRIMARIA","q":0.02},{"n":"CAIXA CARTUCHO CHA VERDE DA TERRINHA C/7 SACHES","c":"EMBALAGEM TERCIARIA","q":10.2},{"n":"INDL - NOVO CHA VERDE DA TERRINHA 11,2 G - UND","c":"OUTROS","q":10.0}],"01317 CHA QUENTAO DA TERRINHA 11,2 G -  FD 10":[{"n":"MP - CHA QUENTAO RAZURADO PARA SACHE KG","c":"MATERIA PRIMA","q":0.114286},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00105},{"n":"INSUMO - CHA - PAPEL FILTRO","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - BARBANTE PARA CHA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - COLA","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - PVC LISO 420X20 25X3","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME DE BOPP TRANSPARENTE 150  MM","c":"OUTROS","q":10.0},{"n":"INSUMO - CHA - FILME STRECH","c":"OUTROS","q":0.02},{"n":"INSUMO - CHA - ETIQUETA DIVERSAS","c":"OUTROS","q":10.0},{"n":"BOBINA ENVOLTORIO CHA QUENTAO 1,6G DA TERRINHA","c":"EMBALAGEM PRIMARIA","q":0.028},{"n":"CAIXA CARTUCHO CHA QUENTAO DA TERRINHA C/7 SACHES","c":"EMBALAGEM TERCIARIA","q":10.05102},{"n":"INDL - NOVO CHA QUENTAO DA TERRINHA 11,2 G - UND","c":"OUTROS","q":10.0}],"00931 COCO RALADO DESIDRATADO DA TERRINHA 50 G -  CX 40":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003846},{"n":"MP - COCO RALADO FINO KG","c":"MATERIA PRIMA","q":2.28},{"n":"BOBINA COCO RALADO DA TERRINHA DESIDRATADO 50 G","c":"EMBALAGEM PRIMARIA","q":0.136149},{"n":"CAIXA COCO RALADO","c":"EMBALAGEM TERCIARIA","q":1.0}],"01739 COLORIFICO DA TERRINHA 500 G - FD 12":[{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.21328671328671328},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005208},{"n":"BOBINA COLORIFICO DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.072},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":5.8865},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.21328671328671328}],"00935 COCO FLOCOS UMIDO ADOCADO DA TERRINHA 100 G - CX 24":[{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.07722659943271352},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003846},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":0.12871099905452255},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.0024455089820359286},{"n":"MP - COCO RALADO EM FLOCOS KG","c":"MATERIA PRIMA","q":1.5445319886542705},{"n":"MP - PROPILENOGLICOL 1KG","c":"MATERIA PRIMA","q":0.0024455089820359286},{"n":"BOBINA COCO FLOCOS UMIDO ADOCADO DA TERRINHA 100 G","c":"EMBALAGEM PRIMARIA","q":0.104949},{"n":"CAIXA COCO RALADO","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - ACUCAR DE CONFEITEIRO","c":"MATERIA PRIMA","q":0.7722659943271353}],"01800 PIMENTA CALABRESA FLOC DA TERRINHA 15 G - CX 24":[{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.384},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA PIMENTA CALABRESA EM FLOCOS DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"12515 FUBA MIMOSO OBA 500 g CX 12.0":[{"n":"MP - FUBA MIMOSO KG","c":"MATERIA PRIMA","q":6.0828},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004274},{"n":"SACO PLAST FUBA MIMOSO OBA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO GRAOS E FARINACEO TERRINHA","c":"EMBALAGEM TERCIARIA","q":1.0}],"01520  FLOCAO DE MILHO DA TERRINHA 800G  - FD 12":[{"n":"MP - FLOCAO DE MILHO KG","c":"MATERIA PRIMA","q":9.699996},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.007143},{"n":"BOBINA FLOCAO MILHO DA TERRINHA 800 G","c":"EMBALAGEM PRIMARIA","q":0.12072},{"n":"SACO PLASTICO FARDO LISO 34 X 92 X 0,14 (70 MM SF) UNID","c":"EMBALAGEM PRIMARIA","q":1.0}],"01506 FARINHA MILHO AMARELA DA TERRINHA 500 G FD10":[{"n":"SACO PLASTICO FARDO LISO 50 X 75 UNID","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"MP - FARINHA DE MILHO AMARELA  KG","c":"MATERIA PRIMA","q":5.128206},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.006944},{"n":"BOBINA FARINHA DE MILHO AMARELA 500 G","c":"EMBALAGEM PRIMARIA","q":0.08}],"01602 CANJICA AMARELA DA TERRINHA 500 G - FD 12":[{"n":"MP - CANJICA AMARELA  KG","c":"MATERIA PRIMA","q":6.1},{"n":"MP - SACO PLASTICO FARDO LISO 29 X 55 UNID","c":"MATERIA PRIMA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"BOBINA CANJICA AMARELA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.096}],"01732 CHIMICHURRI DA TERRINHA 20G - CX 24":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"MP - CHIMICHURRI KG","c":"MATERIA PRIMA","q":0.504},{"n":"BOBINA CHIMICHURRI FLOCOS DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"00019 TAPIOCA DA TERRINHA GRANULADA 400 G - CX 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003704},{"n":"MP - TAPIOCA GRANULADA TIPO1","c":"MATERIA PRIMA","q":4.848},{"n":"BOBINA TAPIOCA GRANULADA PREMIUM DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.054},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"01788 PAPRICA PICANTE EM PO DA TERRINHA 15 G  - CX 24":[{"n":"MP - PAPRICA PICANTE EM PO/ MOIDO KG","c":"MATERIA PRIMA","q":0.384},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA PAPRICA PICANTE EM PO DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01743 COLORIFICO DA TERRINHA 1,01 KG - FD 12":[{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.43029391608391615},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.010417},{"n":"BOBINA COLORIFICO DA TERRINHA 1,01 KG","c":"EMBALAGEM PRIMARIA","q":0.121782},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":11.875681790000002},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.43029391608391615},{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.42377622377622376},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.010417},{"n":"BOBINA COLORIFICO DA TERRINHA 1,01 KG","c":"EMBALAGEM PRIMARIA","q":0.121782},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":11.6958},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.42377622377622376}],"01723 CANELA PO DA TERRINHA 20 G  - CX 24":[{"n":"MP - CANELA PO MOIDA KG","c":"MATERIA PRIMA","q":0.516},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA CANELA PO DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0636},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01701 ACAFRAO DA TERRINHA 30 G  - CX 24":[{"n":"MP - ACAFRAO/CURCUMA MOIDA KG","c":"MATERIA PRIMA","q":0.766},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA ACAFRAO DA TERRINHA 30 G","c":"EMBALAGEM PRIMARIA","q":0.06833},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01712 BICARBONATO DE SODIO DA TERRINHA 500 g - CX 6.0":[{"n":"MP - BICARBONATO DE SODIO KG","c":"MATERIA PRIMA","q":3.1},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.002381},{"n":"BOBINA BICARBONATO DE SODIO DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.02976},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01614 CANJICA BRANCA DA TERRINHA 400 G - CX 12":[{"n":"MP - CANJICA BRANCA KG","c":"MATERIA PRIMA","q":4.880001},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003125},{"n":"BOBINA CANJICA BRANCA PREMIUM DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.054},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MENOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"01618 MILHO PIPOCA DA TERRINHA 400 G - CX 12":[{"n":"MP - MILHO DE PIPOCA KG","c":"MATERIA PRIMA","q":4.880001},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003571},{"n":"BOBINA MILHO DE PIPOCA PREMIUM DA TERRINHA 400G","c":"EMBALAGEM PRIMARIA","q":0.054},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MENOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"01616 GRAO DE BICO DA TERRINHA 350 G - CX 12":[{"n":"MP - GRAO DE BICO 9MM KG","c":"MATERIA PRIMA","q":4.27},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003125},{"n":"BOBINA GRAO DE BICO PREMIUM DA TERRINHA 350 G","c":"EMBALAGEM PRIMARIA","q":0.054},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MAIOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"01782 OREGANO DA TERRINHA 08 G  - CX 24":[{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":0.216},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA OREGANO DA TERRINHA 8 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01786 OREGANO DA TERRINHA 200 G - FD 12":[{"n":"MP - OREGANO FLOCOS KG","c":"MATERIA PRIMA","q":2.43312},{"n":"SACO PLASTICO FARDO LISO 40 X 60","c":"EMBALAGEM PRIMARIA","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.006494},{"n":"BOBINA OREGANO DA TERRINHA 200 G","c":"EMBALAGEM PRIMARIA","q":0.11568}],"01818 TEMPERO BAIANO PO DA TERRINHA 50 G - CX 24":[{"n":"MP - TEMPERO BAIANO KG","c":"MATERIA PRIMA","q":1.248},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA TEMPERO BAIANO E PO DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01717 CANELA CASCA QUEBRADA DA TERRINHA 10 G  - CX 24":[{"n":"MP - CANELA CASCA INTEIRA / QUEBRADA KG","c":"MATERIA PRIMA","q":0.25656},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA CANELA EM CASCA DA TERRINHA 10GR","c":"EMBALAGEM PRIMARIA","q":0.0564}],"01617 LENTILHA DA TERRINHA 350 G - CX 12":[{"n":"MP - LENTILHA KG","c":"MATERIA PRIMA","q":4.2},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0025},{"n":"BOBINA LENTILHA PREMIUM DA TERRINHA 350 G","c":"EMBALAGEM PRIMARIA","q":0.054},{"n":"CAIXA PAPELAO GRAOS E FARINACEOS PREMIUM MENOR","c":"EMBALAGEM TERCIARIA","q":1.0}],"01769 LOURO EM FOLHA DA TERRINHA 08 G  - CX 24":[{"n":"MP - LOURO EM FOLHAS INTEIRAS KG","c":"MATERIA PRIMA","q":0.2},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA LOURO EM FOLHA DA TERRINHA 8GR","c":"EMBALAGEM PRIMARIA","q":0.0564}],"01519 FLOCAO DE MILHO DA TERRINHA 400G - FD 24":[{"n":"MP - FLOCAO DE MILHO KG","c":"MATERIA PRIMA","q":9.768},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.008333},{"n":"BOBINA FLOCAO MILHO DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.1992},{"n":"SACO PLASTICO FARDO LISO 34 X 92 X 0,14 (70 MM SF) UNID","c":"EMBALAGEM PRIMARIA","q":1.0}],"01787 PAPRICA DOCE EM PO DA TERRINHA 15 G - CX 24":[{"n":"MP - PAPRICA DOCE EM PO/ MOIDO  KG","c":"MATERIA PRIMA","q":0.408},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA PAPRICA DOCE EM PO DA TERRINHA 15 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01745 COMINHO EM PO DA TERRINHA 50 G  - CX 24":[{"n":"MP - COMINHO PO / MOIDO KG","c":"MATERIA PRIMA","q":1.224},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA COMINHO EM PO DA TERRINHA 50 G","c":"EMBALAGEM PRIMARIA","q":0.06},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01806 PIMENTA DO REINO EM PO DA TERRINHA 20G - CX 24":[{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.5292},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA PIMENTA DO REINO EM PO DA TERRINHA 20 G","c":"EMBALAGEM PRIMARIA","q":0.0564},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01710 BICARBONATO DE SODIO DA TERRINHA 80 G - CX 24":[{"n":"MP - BICARBONATO DE SODIO KG","c":"MATERIA PRIMA","q":1.98},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA BICARBONATO DE SODIO DA TERRINHA 80 G","c":"EMBALAGEM PRIMARIA","q":0.06},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"01736 COLORIFICO DA TERRINHA 70 G  - CX 24":[{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.060419580419580426},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA COLORIFICO DA TERRINHA 70 G","c":"EMBALAGEM PRIMARIA","q":0.0612},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":1.6675200000000001},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.060419580419580426},{"n":"SACO PLASTICO FARDO LISO 60 X 100 UNID","c":"EMBALAGEM PRIMARIA","q":0.06013986013986014},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001724},{"n":"BOBINA COLORIFICO DA TERRINHA 70 G","c":"EMBALAGEM PRIMARIA","q":0.0612},{"n":"CAIXA PAPELAO ESPECIARIAS DA TERRINHA - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP  FUBA MEDIO KG","c":"MATERIA PRIMA","q":1.6598000000000002},{"n":"MP  SUSPENSÃO OLEOSA URUCUM KG","c":"MATERIA PRIMA","q":0.06013986013986014}],"00006 TAPIOCA DELIOCA PREMIUM 560 G - CX 12":[{"n":"BOBINA TAPIOCA DELIOCA 80 G","c":"EMBALAGEM PRIMARIA","q":0.2184},{"n":"CAIXA PAPELAO TAPIOCA DELIOCA WRAP PATATI UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"SACO POUCH TAPIOCA DELIOCA 560GR","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":4.572672836145889},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":2.1473271638541096},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.153608}],"00001 TAPIOCA DA TERRINHA 1 KG - FD 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA PARA FARDOS 78,0 CM 1 KG TAPIOCA DA TERRINHA COM COD. BARRAS","c":"EMBALAGEM PRIMARIA","q":0.033},{"n":"BOBINA TAPIOCA DA TERRINHA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.1152},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"00301 FAROFA ARTESANAL DA TERRINHA TRADICIONAL 300 G - CX 20":[{"n":"BOBINA FAROFA ARTESANAL TRADICIONAL DA TERRINHA 300 G","c":"EMBALAGEM PRIMARIA","q":0.18},{"n":"MP - PREPARO PARA FAROFA ARTESANAL E PRONTA KG (TEMP COMBATE)","c":"MATERIA PRIMA","q":0.2657211086185686},{"n":"CAIXA PAPELAO FAROFA DA TERRINHA 300 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - OLEO DE SOJA 900 ML","c":"MATERIA PRIMA","q":0.8857370287285621},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"MP - PROTEINA TEXT DE SOJA GRAN CARAMELO KG","c":"MATERIA PRIMA","q":0.44286851436428104},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.1660756928866054},{"n":"MP - POLPA MIX DE PIMENTA 1,6 L","c":"MATERIA PRIMA","q":0.011071712859107026},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":1.660756928866054},{"n":"09016 FARINHA DE MANDIOCA CRUA GROSSA BIG BAG Kg","c":"OUTROS","q":1.660756928866054},{"n":"09017 FARINHA DE MANDIOCA CLASSIFICADA CRUA FINA - COD 713-2001294 KG","c":"OUTROS","q":1.1071712859107028},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0017714740574571242}],"00302 FAROFA ARTESANAL DA TERRINHA APIMENTADA 300 G - CX 20":[{"n":"BOBINA FAROFA ARTESANAL APIMENTADA DA TERRINHA 300 G","c":"EMBALAGEM PRIMARIA","q":0.18},{"n":"MP - PREPARO PARA FAROFA ARTESANAL E PRONTA KG (TEMP COMBATE)","c":"MATERIA PRIMA","q":0.26495418139836935},{"n":"CAIXA PAPELAO FAROFA DA TERRINHA 300 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - OLEO DE SOJA 900 ML","c":"MATERIA PRIMA","q":0.883180604661231},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"MP - PROTEINA TEXT DE SOJA GRAN CARAMELO KG","c":"MATERIA PRIMA","q":0.4415903023306155},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.16559636337398081},{"n":"MP - POLPA MIX DE PIMENTA 1,6 L","c":"MATERIA PRIMA","q":0.022079515116530776},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":1.6559636337398083},{"n":"09016 FARINHA DE MANDIOCA CRUA GROSSA BIG BAG Kg","c":"OUTROS","q":1.6559636337398083},{"n":"09017 FARINHA DE MANDIOCA CLASSIFICADA CRUA FINA - COD 713-2001294 KG","c":"OUTROS","q":1.1039757558265388},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0017663612093224619}],"00001 TAPIOCA DA TERRINHA 1 KG - CX 12":[{"n":"CAIXA PAPELAO TAPIOCA DA TERRINHA 12 X 1KG - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA TAPIOCA DA TERRINHA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.1152},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.021224}],"00002 TAPIOCA DA TERRINHA 500 G - CX 24":[{"n":"CAIXA PAPELAO TAPIOCA DA TERRINHA 24 X 500 GR - UNID","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"BOBINA TAPIOCA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.168},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00311 FAROFA PRONTA DA TERRINHA TRADICIONAL 400 G - FD 24":[{"n":"MP - OLEO DE PALMA CRISTALIZADO KG","c":"MATERIA PRIMA","q":0.4779216484618008},{"n":"BOBINA FAROFA PRONTA TRADICIONAL DA TERRINHA 400 G","c":"EMBALAGEM PRIMARIA","q":0.206},{"n":"MP - COLORIFICO PO ESPECIAL KG","c":"MATERIA PRIMA","q":0.040419969205014},{"n":"MP - SAL REFINADO KG","c":"MATERIA PRIMA","q":0.03940311463381868},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.08389050212361396},{"n":"MP - PIMENTA CALABRESA FLOCOS KG","c":"MATERIA PRIMA","q":0.0063553410699707545},{"n":"MP - CEBOLINHA DESIDRATADA KG","c":"MATERIA PRIMA","q":0.025421364279883018},{"n":"MP - PIMENTA REINO PRETA PO/ MOIDA KG","c":"MATERIA PRIMA","q":0.003813204641982453},{"n":"MP - SALSA DESIDRATADA  FLOCOS KG","c":"MATERIA PRIMA","q":0.022879227851894716},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.020408},{"n":"MP - CEBOLA DESID FLOCOS/TIRAS KG","c":"MATERIA PRIMA","q":0.038132046419824525},{"n":"MP - GLUTAMATO MONOSSODICO GRANEL KILO","c":"MATERIA PRIMA","q":0.0488090194173754},{"n":"MP - AROMA DE CARNE KG","c":"MATERIA PRIMA","q":0.1525281856792981},{"n":"09015 FARINHA DE MANDIOCA BIJU BIG BAG Kg","c":"OUTROS","q":8.897477497959056},{"n":"MP - AROMA DE FUMACA EM LIQUIDO","c":"MATERIA PRIMA","q":0.002542136427988302},{"n":"BOBINA FARDOS FAROFA PRONTA TRAD.  113,0 CM COM COD. BARRAS","c":"EMBALAGEM PRIMARIA","q":0.05},{"n":"MP - BHT ONU3077, 9, III","c":"MATERIA PRIMA","q":0.0004067418284781283}],"00002 TAPIOCA DA TERRINHA 500 G - FD 24":[{"n":"BOBINA TAPIOCA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.168},{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":8.165487207403375},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.014667},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":3.834512792596625},{"n":"BOBINA PARA FARDOS 500G TAPIOCA DATERRINHA COM COD. BARRAS","c":"EMBALAGEM PRIMARIA","q":0.028},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.032184}],"00504 BOLACHA DA TERRINHA COQUINHO 250 g - FD 20":[{"n":"00504 BOLACHA DA TERRINHA COQUINHO 250 g - FD 20","c":"OUTROS","q":1.0}],"01515 FUBA MIMOSO DA TERRINHA 500 G FD 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003333},{"n":"INDL - FUBA MIMOSO DA TERRINHA BOBINA 500 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"BOBINA FUBA MIMOSO DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.06}],"01514 FUBA MIMOSO DA TERRINHA 1 KG FD 10":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.004167},{"n":"INDL - FUBA MIMOSO DA TERRINHA BOBINA 1 KG","c":"EMBALAGEM PRIMARIA","q":10.0},{"n":"BOBINA FUBA MIMOSO DA TERRINHA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.072164}],"01508 FARINHA ROSCA DA TERRINHA 500 G - FD 12":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.003704},{"n":"INDL - FARINHA ROSCA DA TERRINHA 500 G","c":"OUTROS","q":12.0},{"n":"BOBINA FARINHA DE ROSCA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.066}],"01502 FARINHA MANDIOCA FINA CRUA DA TERRINHA 500 - FD 12.0":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.055555},{"n":"BOBINA FARINHA DE MANDIOCA CRUA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.096},{"n":"09017 FARINHA DE MANDIOCA CLASSIFICADA CRUA FINA - COD 713-2001294 KG","c":"OUTROS","q":6.0}],"01505 FARINHA MANDIOCA GROSSA CRUA DA TERRINHA 500 GR - FD 12.0":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"BOBINA FARINHA DE MANDIOCA GROSSA DA TERRINHA 500 G","c":"EMBALAGEM PRIMARIA","q":0.096},{"n":"09016 FARINHA DE MANDIOCA CRUA GROSSA BIG BAG Kg","c":"OUTROS","q":6.0}],"01504 FARINHA MANDIOCA GROSSA CRUA DA TERRINHA 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"BOBINA FARINHA DE MANDIOCA GROSSA DA TERRINHA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.12},{"n":"09016 FARINHA DE MANDIOCA CRUA GROSSA BIG BAG Kg","c":"OUTROS","q":12.0}],"01501 FARINHA MANDIOCA FINA CRUA DA TERRINHA 1 KG  FD 12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.005555},{"n":"BOBINA FARINHA DE MANDIOCA CRUA FINA DA TERRINHA 1 KG","c":"EMBALAGEM PRIMARIA","q":0.096},{"n":"09017 FARINHA DE MANDIOCA CLASSIFICADA CRUA FINA - COD 713-2001294 KG","c":"OUTROS","q":12.0}],"31301 ALHO TRITURADO DA TERRINHA 200 G - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":0.008657312296105849},{"n":"MP - ALHO DESIDRATADO GRANULADO KG","c":"MATERIA PRIMA","q":0.5675685508810652},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.8162193628194088},{"n":"POTE LISO OKKER P220","c":"OUTROS","q":12.0},{"n":"TAMPA LEITOSA OKKER P220","c":"OUTROS","q":12.0},{"n":"MP - AMIDO MOD PRE-GELATINIZADO OKKER KG","c":"MATERIA PRIMA","q":0.03783790339207102},{"n":"MP - METABISSULFITO OKKER KG","c":"MATERIA PRIMA","q":0.007264877451277635},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - BENZOATO DE SODIO SC C/ 25 OKKER KG","c":"MATERIA PRIMA","q":0.0023610851716652313},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - ACIDO CITRICO KG","c":"MATERIA PRIMA","q":0.018162193628194087},{"n":"MP - AROMA DE ALHO ID AO NAT OKKER KG","c":"MATERIA PRIMA","q":0.002270274203524261},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.0030270322713656815},{"n":"MP - SAL REFINADO SEM IODO KG","c":"MATERIA PRIMA","q":0.012108129085462726},{"n":"ROTULO ALHO TRITURADO TERRINHA 200G","c":"OUTROS","q":12.0},{"n":"CAIXA PAPELAO LISA OKKER 12 x 200 GR","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"ETIQ ROSA AVERMELHADO (PMS 706) COLUNAS OKKER 120X49","c":"OUTROS","q":1.0}],"00204 BATATA PALHA DA TERRINHA TRADIC 100G - CX20":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.007143},{"n":"BOBINA BATATA PALHA TRADICIONAL DA TERRINHA 100 G","c":"EMBALAGEM PRIMARIA","q":0.178},{"n":"INDL - BATATA PALHA DA TERRINHA TRADICIONAL 100 g - UND","c":"OUTROS","q":20.0},{"n":"CAIXA PAPELAO BATATA PALHA DA TERRINHA 100G - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"00203 BATATA PALHA DA TERRINHA EX FINA 100G CX 20":[{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.007143},{"n":"BOBINA BATATA PALHA EXTRA FINA DA TERRINHA 100 G","c":"EMBALAGEM PRIMARIA","q":0.178},{"n":"INDL - BATATA PALHA DA TERRINHA EX FINA 100G - UND","c":"OUTROS","q":20.0},{"n":"CAIXA PAPELAO BATATA PALHA DA TERRINHA 100G - UNID","c":"EMBALAGEM TERCIARIA","q":1.0}],"000002 FECULA KG":[{"n":"09019 FECULA Q DELICIA Kg","c":"OUTROS","q":1.0},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.001},{"n":"002440 FECULA DE MANDIOCA TIPO B","c":"OUTROS","q":1.5},{"n":"SACO EMBALAGEM FECULA TERRAFEC","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"002440 FECULA DE MANDIOCA TIPO B","c":"OUTROS","q":2.525},{"n":"SACO EMBALAGEM FECULA S/ IMPRESSAO","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"002440 FECULA DE MANDIOCA TIPO B","c":"OUTROS","q":2.149},{"n":"SACO EMBALAGEM FECULA TERRAFEC","c":"EMBALAGEM PRIMARIA","q":0.04},{"n":"MP - LENHA KG","c":"MATERIA PRIMA","q":0.05},{"n":"SUB - RENDIMENTO FECULA KG","c":"OUTROS","q":0.3}],"00018 TAPIOCA DA TERRINHA NA MEDIDA 490 G - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":4.001088731627654},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.0088},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":1.8789112683723461},{"n":"BOBINA TAPIOCA DA TERRINHA 70 G","c":"EMBALAGEM PRIMARIA","q":0.2205},{"n":"SACO POUCH TAPIOCA DA TERRINHA 490GR","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA DE PAPELAO NA MEDIDA 12X490G","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP - DIOXIDO DE CARBONO LIQUIDO REFRIGERADO ONU 21","c":"MATERIA PRIMA","q":0.153608}],"00941 LEITE DE COCO DA TERRINHA 200 ML - FD 24":[{"n":"00941 LEITE DE COCO DA TERRINHA 200 ML - FD 24","c":"OUTROS","q":1.0}],"00942 LEITE DE COCO DA TERRINHA 500 ML - FD 12":[{"n":"00942 LEITE DE COCO DA TERRINHA 500 ML - FD 12","c":"OUTROS","q":1.0}],"01101 WRAP DE TAPIOCA ORIGINAL DA TERRINHA 150 G - CX 12":[{"n":"MP - FECULA DE MANDIOCA Kg","c":"MATERIA PRIMA","q":1.349191616766467},{"n":"MP - ANTI-MOFO CONSTAPI","c":"MATERIA PRIMA","q":0.013493},{"n":"MP - LEITE EM PO INTEGRAL KG","c":"MATERIA PRIMA","q":0.358885},{"n":"MP - AGUA PRODUCAO ML","c":"MATERIA PRIMA","q":0.6335803832335329},{"n":"MP - PROPIONATO DE CALCIO","c":"MATERIA PRIMA","q":0.013493},{"n":"MP - SORBATO DE POTASSIO KG","c":"MATERIA PRIMA","q":0.005506},{"n":"MP - ACIDO LATICO 85% FG OKKER KG","c":"MATERIA PRIMA","q":0.049161},{"n":"MP - GOMA XANTANA MESH (TIPO 200)  KG","c":"MATERIA PRIMA","q":0.006745},{"n":"MP - OVO EM PO  INTEGRAL KG","c":"MATERIA PRIMA","q":0.089047},{"n":"SACO WRAP DE TAPIOCA ORIGINAL DA TERRINHA 150 G","c":"EMBALAGEM PRIMARIA","q":12.0},{"n":"CAIXA PAPELAO WRAP TRADICIONAL","c":"EMBALAGEM TERCIARIA","q":1.0},{"n":"MP  AMACIANTE SOFTEN  F ( MACIEZ SG  ) KG","c":"MATERIA PRIMA","q":0.004479}],"01522 POLVILHO DOCE DA TERRINHA 1 KG - FD 12":[{"n":"BOBINA PARA FARDOS 113,0 CM LISO","c":"EMBALAGEM PRIMARIA","q":0.038004},{"n":"LOGISTICA - FILME STRETCH AUTOMATICO 500x0,30","c":"EMBALAGEM QUARTERNARIA","q":0.00366},{"n":"09014 FECULA MANDIOCA BIG BAG KG","c":"OUTROS","q":12.108},{"n":"BOBINA POLVILHO DOCE DA TERRINHA 1KG","c":"EMBALAGEM PRIMARIA","q":0.096}],"20002 PIPOCA DE MICROONDAS NATURAL C SAL DA TERRINHA 85G CX 24":[{"n":"20002 PIPOCA DE MICROONDAS NATURAL C SAL DA TERRINHA 85G CX 24","c":"OUTROS","q":1.0}],"20004 PIPOCA DE MICROONDAS MANTEIGA CINEMA DA TERRINHA 85G CX 24":[{"n":"20004 PIPOCA DE MICROONDAS MANTEIGA CINEMA DA TERRINHA 85G CX 24","c":"OUTROS","q":1.0}],"01507 FARINHA FLOCADA PANKO DA TERRINHA 200 GR - CX 12.0":[{"n":"01507 FARINHA FLOCADA PANKO DA TERRINHA 200 GR - CX 12.0","c":"OUTROS","q":1.0}],"FA 074200 FARINHA DE MANDIOCA BIG BAG Kg":[{"n":"SUB - MASSA RAIZ KG","c":"OUTROS","q":20.0},{"n":"SUB - MASSA RAIZ KG","c":"OUTROS","q":20.0},{"n":"SUB - MASSA RAIZ KG","c":"OUTROS","q":20.0}]};

// Infere categoria de um insumo pelo nome quando não vem do INSUMOS_MAP
function inferCatInsumo(nome){
  if(!nome) return 'OUTROS';
  const n = nome.toUpperCase().trim();
  if(n.startsWith('MP ') || n.startsWith('MP-') || n.startsWith('MP-')) return 'MATERIA PRIMA';
  if(n.startsWith('BOBINA') || n.startsWith('SACO POUCH') || n.startsWith('SACO PLAST')) return 'EMBALAGEM PRIMARIA';
  if(n.startsWith('CAIXA') || n.startsWith('SOLAPA') || n.startsWith('DISPLAY') || n.startsWith('CARTUCHO')) return 'EMBALAGEM TERCIARIA';
  if(n.startsWith('LOGISTICA') || n.startsWith('FILME STRETCH')) return 'EMBALAGEM QUARTERNARIA';
  if(n.startsWith('SACO PLASTICO') || n.startsWith('SACO FARDO') || n.startsWith('SACARIA')) return 'EMBALAGEM PRIMARIA';
  if(n.startsWith('BALDE') || n.startsWith('BISNAGA') || n.startsWith('POTE') || n.startsWith('TAMPA')) return 'OUTROS';
  if(n.startsWith('ETIQ') || n.startsWith('ROTULO') || n.startsWith('FOLDER') || n.startsWith('INDL')) return 'OUTROS';
  if(n.startsWith('INSUMO')) return 'OUTROS';
  // Se contém indicadores de embalagem no nome
  if(n.includes('EMBALAGEM')) return 'EMBALAGEM PRIMARIA';
  if(n.includes('PAPELAO')) return 'EMBALAGEM TERCIARIA';
  if(n.includes('BOBINA')) return 'EMBALAGEM PRIMARIA';
  // Busca no INSUMOS_MAP para pegar a categoria de qualquer produto que usa este insumo
  for(const prod of Object.values(INSUMOS_MAP)){
    const match = prod.find(x => x.n === nome);
    if(match) return match.c;
  }
  return 'MATERIA PRIMA'; // fallback para MP se não conseguir inferir
}

// Helper: find insumos for a product (match by product code or description)
function getInsumos(prodDesc){
  if(!prodDesc) return [];
  const d=prodDesc.trim();
  // Priority 1: Check fichaTecnicaData (user-edited data) by exact desc match
  if(typeof fichaTecnicaData !== 'undefined'){
    const ftEntry=fichaTecnicaData.find(x=>x.desc && x.desc.trim()===d);
    if(ftEntry && ftEntry.insumos && ftEntry.insumos.length>0){
      return ftEntry.insumos.map(i=>({n:i.insumo, c:inferCatInsumo(i.insumo), q:i.qty}));
    }
    // Also try matching by code prefix
    const codeMatch=d.match(/^(\d{5})/);
    if(codeMatch){
      const code=codeMatch[1];
      const ftByCode=fichaTecnicaData.find(x=>x.desc && x.desc.trim().startsWith(code));
      if(ftByCode && ftByCode.insumos && ftByCode.insumos.length>0){
        return ftByCode.insumos.map(i=>({n:i.insumo, c:inferCatInsumo(i.insumo), q:i.qty}));
      }
    }
  }
  // Priority 2: Exact match in INSUMOS_MAP
  if(INSUMOS_MAP[d]) return INSUMOS_MAP[d];
  // Match by product code (first 5 chars numeric portion)
  const codeMatch=d.match(/^(\d{5})/);
  if(codeMatch){
    const code=codeMatch[1];
    for(const k of Object.keys(INSUMOS_MAP)){
      if(k.startsWith(code)) return INSUMOS_MAP[k];
    }
  }
  // Match by first 25 chars of description (handles minor variations)
  const prefix=d.substring(0,25).toLowerCase().replace(/\s+/g,' ').trim();
  for(const k of Object.keys(INSUMOS_MAP)){
    const kp=k.substring(0,25).toLowerCase().replace(/\s+/g,' ').trim();
    if(prefix===kp || kp.startsWith(prefix.substring(0,18)) || prefix.startsWith(kp.substring(0,18))){
      return INSUMOS_MAP[k];
    }
  }
  return [];
}

// ===== INSUMOS ENGINE =====
// Uses the same buildSchedule from Gantt, then computes insumos per day per product
// Returns: {maquina: {produto: {insumo: {cat, unidade, days:[q0..q6], total}}}}
function buildInsumosSchedule(monday){
  const {schedule,days}=buildSchedule(monday);
  const result={days, byMaq:{}};

  for(const maq of MAQUINAS){
    const entries=schedule[maq];
    if(!entries||!entries.length) continue;
    const maqData=[];

    for(const {rec,segments} of entries){
      const ins=getInsumos(rec.produto);
      if(!ins||!ins.length) continue;

      const insumoRows=[];
      for(const i of ins){
        const dayQtys=Array(7).fill(0);
        for(const seg of segments){
          dayQtys[seg.dayIdx]+=seg.caixasNoDia*i.q;
        }
        insumoRows.push({nome:i.n,cat:i.c,days:dayQtys,total:dayQtys.reduce((a,b)=>a+b,0)});
      }
      if(insumoRows.some(r=>r.total>0)){
        maqData.push({produto:rec.produto,insumos:insumoRows,totalCaixas:rec.qntCaixas});
      }
    }
    if(maqData.length) result.byMaq[maq]=maqData;
  }
  return result;
}

// Returns display unit based on insumo name and category
function getUnit(nome,cat){
  const n=nome.toUpperCase();
  // MP always KG
  if(cat==='MATERIA PRIMA'||n.startsWith('MP ')||n.startsWith('MP-')) return 'KG';
  // Bobinas = KG (roll weight)
  if(n.startsWith('BOBINA')) return 'KG';
  // Caixas = UN
  if(n.includes('CAIXA')||n.includes('SOLAPA')) return 'UN';
  // Sacos/Sacolas = UN
  if(n.startsWith('SACO')||n.includes('SACO PLAST')||n.includes('SACO POUCH')) return 'UN';
  // Logistica/Filme = KG
  if(n.includes('LOGISTICA')||n.includes('FILME STRETCH')) return 'KG';
  return 'UN';
}

function fmtQty(v){
  if(!v||v<0.001) return '—';
  return v>=1000?Math.round(v).toLocaleString('pt-BR'):v>=100?v.toFixed(1):v>=10?v.toFixed(2):v.toFixed(3).replace(/\.?0+$/,'');
}

// ===== INSUMOS POR MÁQUINA =====
let insMaqMonday=null;
function insToday(){insMaqMonday=getWeekMonday(new Date());renderInsumosMaq()}
function insWeek(d){
  if(!insMaqMonday) insMaqMonday=ganttBaseMonday||getWeekMonday(new Date());
  insMaqMonday=new Date(insMaqMonday);
  insMaqMonday.setDate(insMaqMonday.getDate()+d*7);
  renderInsumosMaq();
}
function insGoDate(){
  const v=document.getElementById('ins-goto').value;
  if(v) insMaqMonday=getWeekMonday(new Date(v+'T12:00:00'));
  renderInsumosMaq();
}

const CAT_COLORS={'MATERIA PRIMA':'rgba(0,229,204,.08)','EMBALAGEM PRIMARIA':'rgba(124,106,247,.08)','EMBALAGEM TERCIARIA':'rgba(255,112,67,.08)','EMBALAGEM QUARTERNARIA':'rgba(41,217,132,.08)','OUTROS':'rgba(255,179,0,.08)'};
const CAT_ACCENT={'MATERIA PRIMA':'var(--cyan)','EMBALAGEM PRIMARIA':'var(--purple)','EMBALAGEM TERCIARIA':'var(--orange)','EMBALAGEM QUARTERNARIA':'var(--green)','OUTROS':'var(--warn)'};

function renderInsumosMaq(){
  if(!insMaqMonday) insMaqMonday=ganttBaseMonday||getWeekMonday(new Date());
  const {days,byMaq}=buildInsumosSchedule(insMaqMonday);
  const today=dateStr(new Date());
  const catFilter=document.getElementById('ins-cat-filter').value;

  document.getElementById('ins-week-label').textContent=
    `${fmtDate(days[0])} – ${fmtDate(days[6])} / ${days[0].getFullYear()}`;

  if(!Object.keys(byMaq).length){
    document.getElementById('ins-maq-body').innerHTML=
      '<div class="empty"><div class="ei">📦</div>Nenhuma solicitação ativa com dados de insumos</div>';
    return;
  }

  const CAT_ORDER=['MATERIA PRIMA','EMBALAGEM PRIMARIA','EMBALAGEM TERCIARIA','EMBALAGEM QUARTERNARIA','OUTROS'];

  const dayHead=days.map(d=>{
    const w=hoursOnDay(d)===0;
    const isTod=dateStr(d)===today;
    return `<th style="text-align:right;${w?'color:var(--text4)':''}${isTod?';color:var(--cyan)':''}">${DAY_NAMES[d.getDay()]}<br><span style="font-size:9px;font-weight:400">${fmtDate(d)}</span></th>`;
  }).join('');

  let html=`<div class="ins-maq-section"><div style="overflow-x:auto"><table class="ins-table">
    <thead><tr>
      <th class="col-maq">Máquina</th>
      <th class="col-cat">Categoria</th>
      <th class="col-ins">Insumo</th>
      <th class="col-unid">Unid</th>
      ${dayHead}
      <th style="text-align:right">Total</th>
    </tr></thead><tbody>`;

  let anyRow=false;

  for(const maq of MAQUINAS){
    const maqData=byMaq[maq];
    if(!maqData) continue;

    const byCat={};
    for(const {insumos} of maqData){
      for(const row of insumos){
        if(catFilter && row.cat!==catFilter) continue;
        if(row.total<0.0001) continue;
        if(!byCat[row.cat]) byCat[row.cat]={};
        if(!byCat[row.cat][row.nome]){
          byCat[row.cat][row.nome]={unit:getUnit(row.nome,row.cat),days:Array(7).fill(0),total:0};
        }
        row.days.forEach((v,i)=>{byCat[row.cat][row.nome].days[i]+=v});
        byCat[row.cat][row.nome].total+=row.total;
      }
    }

    const catsPresent=CAT_ORDER.filter(c=>byCat[c]&&Object.keys(byCat[c]).length>0);
    if(!catsPresent.length) continue;
    anyRow=true;

    // Count total data rows (no total rows anymore)
    const totalMaqRows=catsPresent.reduce((a,c)=>a+Object.keys(byCat[c]).length,0);
    let firstRowOfMaq=true;
    let maqRowsLeft=totalMaqRows;

    for(const cat of catsPresent){
      const insEntries=Object.entries(byCat[cat]).sort((a,b)=>b[1].total-a[1].total);
      const accent=CAT_ACCENT[cat]||'var(--text2)';
      const catShort=cat.replace('EMBALAGEM ','Emb. ').replace('MATERIA PRIMA','Mat. Prima');

      for(let ei=0;ei<insEntries.length;ei++){
        const [nome,data]=insEntries[ei];
        html+=`<tr>`;
        // Máquina cell: rowspan over all rows of this machine
        if(firstRowOfMaq){
          html+=`<td class="col-maq" rowspan="${totalMaqRows}" style="vertical-align:middle;border-right:2px solid var(--border2)">${maq}</td>`;
          firstRowOfMaq=false;
        }
        html+=`<td class="col-cat" style="color:${accent}">${catShort}</td>`;
        html+=`<td class="col-ins">${nome}</td>`;
        html+=`<td class="col-unid">${data.unit}</td>`;
        data.days.forEach((v,i)=>{
          const w=hoursOnDay(days[i])===0;
          html+=`<td style="text-align:right${w?';color:var(--text4)':v>0?';color:var(--cyan)':''}">
            ${v>0&&!w?fmtQty(v):'—'}</td>`;
        });
        html+=`<td style="text-align:right;color:var(--text);font-weight:600">${fmtQty(data.total)}</td></tr>`;
      }
    }

    // Separator between machines
    html+=`<tr><td colspan="${4+days.length+1}" style="padding:0;height:6px;background:var(--s2);border-top:2px solid var(--border2)"></td></tr>`;
  }

  html+=`</tbody></table></div></div>`;
  document.getElementById('ins-maq-body').innerHTML=anyRow?html:
    '<div class="empty"><div class="ei">📦</div>Nenhum insumo encontrado com este filtro</div>';
}


// ===== INSUMOS GERAL =====
let insGeralMonday=null;
function insGeralToday(){insGeralMonday=getWeekMonday(new Date());renderInsumosGeral()}
function insGeralWeek(d){
  if(!insGeralMonday) insGeralMonday=getWeekMonday(new Date());
  insGeralMonday=new Date(insGeralMonday);
  insGeralMonday.setDate(insGeralMonday.getDate()+d*7);
  renderInsumosGeral();
}
function insGeralGoDate(){
  const v=document.getElementById('ins-geral-goto').value;
  if(v) insGeralMonday=getWeekMonday(new Date(v+'T12:00:00'));
  renderInsumosGeral();
}

function renderInsumosGeral(){
  if(!insGeralMonday) insGeralMonday=ganttBaseMonday||getWeekMonday(new Date());
  const {days,byMaq}=buildInsumosSchedule(insGeralMonday);
  const today=dateStr(new Date());
  const catFilter=document.getElementById('ins-geral-cat').value;

  document.getElementById('ins-geral-label').textContent=
    `${fmtDate(days[0])} – ${fmtDate(days[6])} / ${days[0].getFullYear()}`;

  const CAT_ORDER=['MATERIA PRIMA','EMBALAGEM PRIMARIA','EMBALAGEM TERCIARIA','EMBALAGEM QUARTERNARIA','OUTROS'];

  // Aggregate: {cat: {insName: {unit, days:[7], total}}}
  const aggCat={};
  for(const maq of MAQUINAS){
    const maqData=byMaq[maq];
    if(!maqData) continue;
    for(const {insumos} of maqData){
      for(const row of insumos){
        if(catFilter && row.cat!==catFilter) continue;
        if(!aggCat[row.cat]) aggCat[row.cat]={};
        if(!aggCat[row.cat][row.nome]){
          aggCat[row.cat][row.nome]={unit:getUnit(row.nome,row.cat),days:Array(7).fill(0),total:0};
        }
        row.days.forEach((v,i)=>{aggCat[row.cat][row.nome].days[i]+=v});
        aggCat[row.cat][row.nome].total+=row.total;
      }
    }
  }

  const catsPresent=CAT_ORDER.filter(c=>aggCat[c]&&Object.keys(aggCat[c]).length>0);

  if(!catsPresent.length){
    document.getElementById('ins-geral-body').innerHTML=
      '<div class="empty"><div class="ei">📦</div>Nenhum insumo calculado para esta semana</div>';
    return;
  }

  const dayHead=days.map(d=>{
    const w=hoursOnDay(d)===0;
    const isTod=dateStr(d)===today;
    return `<th style="text-align:right;${w?'color:var(--text4)':''}${isTod?';color:var(--cyan)':''}">${DAY_NAMES[d.getDay()]}<br><span style="font-size:9px;font-weight:400">${fmtDate(d)}</span></th>`;
  }).join('');

  // Total rows across all cats for the maq rowspan
  const totalDataRows=catsPresent.reduce((a,c)=>a+Object.keys(aggCat[c]).length+1,0)+catsPresent.length;

  let html=`<div class="ins-maq-section"><div style="overflow-x:auto"><table class="ins-table">
    <thead><tr>
      <th class="col-maq" style="min-width:130px">Categoria</th>
      <th class="col-ins">Insumo</th>
      <th class="col-unid">Unid</th>
      ${dayHead}
      <th style="text-align:right">Total</th>
    </tr></thead><tbody>`;

  for(const cat of catsPresent){
    const accent=CAT_ACCENT[cat]||'var(--text2)';
    const insEntries=Object.entries(aggCat[cat]).sort((a,b)=>b[1].total-a[1].total);
    const rowCount=insEntries.length+1; // +1 for total row

    // Category separator row
    html+=`<tr style="background:rgba(31,45,61,.6)">
      <td colspan="${9+days.length}" style="padding:5px 14px;font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:${accent};border-bottom:1px solid rgba(31,45,61,.5)">${cat}</td>
    </tr>`;

    const colTot=Array(7).fill(0);
    let catTotal=0;

    for(const [nome,data] of insEntries){
      const isMP=cat==='MATERIA PRIMA';
      const totalDisplay=isMP?Math.ceil(data.total):data.total;
      html+=`<tr>
        <td class="col-maq" style="font-size:10px;color:${accent};vertical-align:middle">${cat.replace('EMBALAGEM ','Emb. ').replace('MATERIA PRIMA','Mat. Prima')}</td>
        <td class="col-ins">${nome}</td>
        <td class="col-unid">${data.unit}</td>`;
      data.days.forEach((v,i)=>{
        const w=hoursOnDay(days[i])===0;
        colTot[i]+=v;
        html+=`<td style="text-align:right${w?';color:var(--text4)':v>0?';color:var(--cyan)':''}">
          ${v>0&&!w?fmtQty(v):'—'}</td>`;
      });
      html+=`<td style="text-align:right;color:var(--text);font-weight:600">${isMP?totalDisplay.toLocaleString('pt-BR'):fmtQty(data.total)}</td></tr>`;
      catTotal+=data.total;
    }


  }

  html+=`</tbody></table></div></div>`;
  document.getElementById('ins-geral-body').innerHTML=html;
}
function toast(msg,type='ok'){
  const wrap=document.getElementById('toasts');
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  el.innerHTML=`<span>${type==='ok'?'✅':'❌'}</span>${msg}`;
  wrap.appendChild(el);
  setTimeout(()=>el.remove(),3200);
}

// ===== EXPORT FUNCTIONS =====

// --- GANTT XLSX ---
function exportGanttXLSX(){
  if(!ganttBaseMonday){toast('Abra a aba Prog. Visual primeiro','err');return;}
  const {schedule,days}=buildSchedule(ganttBaseMonday);
  const wb=XLSX.utils.book_new();
  const weekLabel=`${fmtDate(days[0])}-${fmtDate(days[6])}-${days[0].getFullYear()}`;

  for(const maq of MAQUINAS){
    const entries=schedule[maq];
    if(!entries||!entries.length) continue;
    const rows=[];
    rows.push(['Produto','Qtd Total (cx)',...days.map(d=>DAY_NAMES[d.getDay()]+' '+fmtDate(d))]);
    const dayTotals=Array(7).fill(0);
    let wkTotal=0;
    for(const {rec,segments} of entries){
      const rowTotals=Array(7).fill(0);
      segments.forEach(s=>{rowTotals[s.dayIdx]+=s.caixasNoDia});
      const rowTotal=rowTotals.reduce((a,b)=>a+b,0);
      rowTotals.forEach((v,i)=>dayTotals[i]+=v);
      wkTotal+=rowTotal;
      rows.push([rec.produto,rowTotal,...rowTotals]);
    }
    rows.push(['TOTAL SEMANA',wkTotal,...dayTotals]);
    const ws=XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb,ws,maq.substring(0,31));
  }
  XLSX.writeFile(wb,`ProgramacaoVisual_${weekLabel}.xlsx`);
  toast('Excel exportado!');
}

// --- GANTT PDF ---
async function exportGanttPDF(){
  if(!ganttBaseMonday){toast('Abra a aba Prog. Visual primeiro','err');return;}
  toast('Gerando PDF, aguarde...','ok');
  const {jsPDF}=window.jspdf;
  const ganttEl=document.getElementById('gantt-table');
  if(!ganttEl||!ganttEl.innerHTML){toast('Nenhum dado para exportar','err');return;}

  try{
    const canvas=await html2canvas(ganttEl,{
      backgroundColor:'#0e1419',
      scale:2,
      useCORS:true,
      allowTaint:true,
      logging:false
    });

    const {days}=buildSchedule(ganttBaseMonday);
    const weekLabel=`Programação Visual · ${fmtDate(days[0])} – ${fmtDate(days[6])} / ${days[0].getFullYear()}`;

    const imgW=canvas.width;
    const imgH=canvas.height;
    const margin=8;
    const pdfW=297;
    const pdfH=210;
    const titleH=10;
    const usableW=pdfW-margin*2;
    const usableH=pdfH-margin*2-titleH;

    // Scale image to fit width
    const scale=usableW/imgW;
    const scaledTotalH=imgH*scale;
    const totalPages=Math.ceil(scaledTotalH/usableH);

    const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});

    for(let p=0;p<totalPages;p++){
      if(p>0) doc.addPage();
      doc.setFontSize(10);doc.setTextColor(50);
      doc.text(weekLabel,margin,margin+5);
      if(totalPages>1){
        doc.setFontSize(8);doc.setTextColor(130);
        doc.text(`Pág ${p+1}/${totalPages}`,pdfW-margin-18,margin+5);
      }
      // Compute source slice in canvas pixels
      const srcYpx=Math.round((p*usableH/scale));
      const sliceHpx=Math.min(Math.round(usableH/scale), imgH-srcYpx);
      if(sliceHpx<=0) break;
      const sliceCanvas=document.createElement('canvas');
      sliceCanvas.width=imgW;
      sliceCanvas.height=sliceHpx;
      sliceCanvas.getContext('2d').drawImage(canvas,0,srcYpx,imgW,sliceHpx,0,0,imgW,sliceHpx);
      const sliceData=sliceCanvas.toDataURL('image/png');
      const sliceHmm=sliceHpx*scale;
      doc.addImage(sliceData,'PNG',margin,margin+titleH,usableW,sliceHmm);
    }

    doc.save(`ProgramacaoVisual_${fmtDate(days[0])}.pdf`);
    toast('PDF exportado como imagem!');
  }catch(e){
    console.error(e);
    toast('Erro ao gerar PDF: '+e.message,'err');
  }
}


// --- INSUMOS MAQ XLSX ---
function exportInsumosMaqXLSX(){
  if(!insMaqMonday){toast('Abra a aba Insumos/Máq. primeiro','err');return;}
  const {days,byMaq}=buildInsumosSchedule(insMaqMonday);
  const wb=XLSX.utils.book_new();
  const weekLabel=`${fmtDate(days[0])}-${fmtDate(days[6])}`;
  const dayHeaders=days.map(d=>DAY_NAMES[d.getDay()]+' '+fmtDate(d));
  const CAT_ORDER=['MATERIA PRIMA','EMBALAGEM PRIMARIA','EMBALAGEM TERCIARIA','EMBALAGEM QUARTERNARIA','OUTROS'];

  // All machines in one sheet
  const rows=[['Máquina','Categoria','Insumo','Unid',...dayHeaders,'Total']];
  for(const maq of MAQUINAS){
    const maqData=byMaq[maq];
    if(!maqData) continue;
    const byCat={};
    for(const {insumos} of maqData){
      for(const row of insumos){
        if(row.total<0.0001) continue;
        if(!byCat[row.cat]) byCat[row.cat]={};
        if(!byCat[row.cat][row.nome]) byCat[row.cat][row.nome]={unit:getUnit(row.nome,row.cat),days:Array(7).fill(0),total:0};
        row.days.forEach((v,i)=>{byCat[row.cat][row.nome].days[i]+=v});
        byCat[row.cat][row.nome].total+=row.total;
      }
    }
    const catsPresent=CAT_ORDER.filter(c=>byCat[c]&&Object.keys(byCat[c]).length>0);
    if(!catsPresent.length) continue;
    for(const cat of catsPresent){
      for(const [nome,data] of Object.entries(byCat[cat]).sort((a,b)=>b[1].total-a[1].total)){
        rows.push([maq,cat,nome,data.unit,...data.days.map(v=>v>0?parseFloat(v.toFixed(3)):0),parseFloat(data.total.toFixed(3))]);
      }
    }
    rows.push([]); // blank row between machines
  }
  const ws=XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb,ws,'Insumos por Máquina');
  XLSX.writeFile(wb,`InsumosMaquina_${weekLabel}.xlsx`);
  toast('Excel exportado!');
}

// --- INSUMOS MAQ PDF ---
function exportInsumosMaqPDF(){
  if(!insMaqMonday){toast('Abra a aba Insumos/Máq. primeiro','err');return;}
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const {days,byMaq}=buildInsumosSchedule(insMaqMonday);
  const weekLabel=`${fmtDate(days[0])} – ${fmtDate(days[6])} / ${days[0].getFullYear()}`;
  const dayHeaders=days.map(d=>DAY_NAMES[d.getDay()]+'\n'+fmtDate(d));
  let firstPage=true;

  for(const maq of MAQUINAS){
    const maqData=byMaq[maq];
    if(!maqData) continue;
    if(!firstPage) doc.addPage();
    firstPage=false;

    doc.setFontSize(13);doc.setTextColor(40);
    doc.text(`Insumos por Máquina — ${maq}`,14,14);
    doc.setFontSize(9);doc.setTextColor(120);
    doc.text(weekLabel,14,20);

    const head=[['Produto','Categoria','Insumo','Unid',...dayHeaders,'Total']];
    const body=[];
    for(const {produto,insumos} of maqData){
      for(const row of insumos){
        body.push([
          produto.substring(0,30),
          row.cat.replace('EMBALAGEM ','Emb.').replace('MATERIA PRIMA','MP'),
          row.nome.substring(0,35),
          getUnit(row.nome,row.cat),
          ...row.days.map(v=>v>0?fmtQty(v):'—'),
          fmtQty(row.total)
        ]);
      }
    }
    doc.autoTable({
      head,body,startY:24,
      styles:{fontSize:6,cellPadding:1.5},
      headStyles:{fillColor:[14,20,25],textColor:[0,229,204],fontSize:6},
      columnStyles:{0:{cellWidth:40},1:{cellWidth:18},2:{cellWidth:50},3:{cellWidth:10}},
      theme:'grid'
    });
  }
  doc.save(`InsumosMaquina_${fmtDate(days[0])}.pdf`);
  toast('PDF exportado!');
}

// --- INSUMOS GERAL XLSX ---
function exportInsumosGeralXLSX(){
  if(!insGeralMonday){toast('Abra a aba Insumos Geral primeiro','err');return;}
  const {days,byMaq}=buildInsumosSchedule(insGeralMonday);
  const wb=XLSX.utils.book_new();
  const weekLabel=`${fmtDate(days[0])}-${fmtDate(days[6])}`;
  const dayHeaders=days.map(d=>DAY_NAMES[d.getDay()]+' '+fmtDate(d));
  const CAT_ORDER=['MATERIA PRIMA','EMBALAGEM PRIMARIA','EMBALAGEM TERCIARIA','EMBALAGEM QUARTERNARIA','OUTROS'];
  const aggCat={};
  for(const maq of MAQUINAS){
    const maqData=byMaq[maq];
    if(!maqData) continue;
    for(const {insumos} of maqData){
      for(const row of insumos){
        if(!aggCat[row.cat]) aggCat[row.cat]={};
        if(!aggCat[row.cat][row.nome]) aggCat[row.cat][row.nome]={unit:getUnit(row.nome,row.cat),days:Array(7).fill(0),total:0};
        row.days.forEach((v,i)=>{aggCat[row.cat][row.nome].days[i]+=v});
        aggCat[row.cat][row.nome].total+=row.total;
      }
    }
  }
  const rows=[['Categoria','Insumo','Unid',...dayHeaders,'Total']];
  for(const cat of CAT_ORDER){
    if(!aggCat[cat]) continue;
    for(const [nome,data] of Object.entries(aggCat[cat]).sort((a,b)=>b[1].total-a[1].total)){
      rows.push([cat,nome,data.unit,...data.days.map(v=>v>0?parseFloat(v.toFixed(3)):0),parseFloat(data.total.toFixed(3))]);
    }
  }
  const ws=XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb,ws,'Insumos Geral');
  XLSX.writeFile(wb,`InsumosGeral_${weekLabel}.xlsx`);
  toast('Excel exportado!');
}

// --- INSUMOS GERAL PDF ---
function exportInsumosGeralPDF(){
  if(!insGeralMonday){toast('Abra a aba Insumos Geral primeiro','err');return;}
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const {days,byMaq}=buildInsumosSchedule(insGeralMonday);
  const weekLabel=`${fmtDate(days[0])} – ${fmtDate(days[6])} / ${days[0].getFullYear()}`;
  const dayHeaders=days.map(d=>DAY_NAMES[d.getDay()]+'\n'+fmtDate(d));
  const CAT_ORDER=['MATERIA PRIMA','EMBALAGEM PRIMARIA','EMBALAGEM TERCIARIA','EMBALAGEM QUARTERNARIA','OUTROS'];
  const aggCat={};
  for(const maq of MAQUINAS){
    const maqData=byMaq[maq];
    if(!maqData) continue;
    for(const {insumos} of maqData){
      for(const row of insumos){
        if(!aggCat[row.cat]) aggCat[row.cat]={};
        if(!aggCat[row.cat][row.nome]) aggCat[row.cat][row.nome]={unit:getUnit(row.nome,row.cat),days:Array(7).fill(0),total:0};
        row.days.forEach((v,i)=>{aggCat[row.cat][row.nome].days[i]+=v});
        aggCat[row.cat][row.nome].total+=row.total;
      }
    }
  }

  doc.setFontSize(14);doc.setTextColor(40);
  doc.text('Insumos Geral',14,14);
  doc.setFontSize(9);doc.setTextColor(120);
  doc.text(weekLabel,14,20);

  const head=[['Categoria','Insumo','Unid',...dayHeaders,'Total']];
  const body=[];
  for(const cat of CAT_ORDER){
    if(!aggCat[cat]) continue;
    for(const [nome,data] of Object.entries(aggCat[cat]).sort((a,b)=>b[1].total-a[1].total)){
      body.push([
        cat.replace('EMBALAGEM ','Emb.').replace('MATERIA PRIMA','MP'),
        nome.substring(0,50),
        data.unit,
        ...data.days.map(v=>v>0?fmtQty(v):'—'),
        fmtQty(data.total)
      ]);
    }
  }
  doc.autoTable({
    head,body,startY:24,
    styles:{fontSize:6,cellPadding:1.5},
    headStyles:{fillColor:[14,20,25],textColor:[0,229,204],fontSize:6},
    columnStyles:{0:{cellWidth:22},1:{cellWidth:65},2:{cellWidth:10}},
    theme:'grid'
  });
  doc.save(`InsumosGeral_${fmtDate(days[0])}.pdf`);
  toast('PDF exportado!');
}

// ===== REORDER MODAL =====
let reorderItems=[]; // {id, maquina, produto, qntCaixas}
let reorderMaq='';
let dragSrc=null;

function openReorderModal(){
  const sel=document.getElementById('reorder-maq-sel');
  sel.innerHTML='<option value="">— Selecione a máquina —</option>';
  MAQUINAS.forEach(m=>{
    const ativos=records.filter(r=>r.maquina===m&&r.status!=='Concluído');
    if(!ativos.length) return;
    const o=document.createElement('option');
    o.value=m; o.textContent=`${m} (${ativos.length} itens)`;
    sel.appendChild(o);
  });
  document.getElementById('reorder-list').innerHTML='<div style="color:var(--text3);font-size:12px;text-align:center;padding:20px">Selecione uma máquina para reordenar</div>';
  document.getElementById('modal-reorder').classList.add('on');
}

function closeReorderModal(){
  document.getElementById('modal-reorder').classList.remove('on');
}

function loadReorderList(maq){
  reorderMaq=maq;
  if(!maq){document.getElementById('reorder-list').innerHTML='';return;}
  reorderItems=records.filter(r=>r.maquina===maq&&r.status!=='Concluído')
    .sort((a,b)=>a.id-b.id)
    .map(r=>({id:r.id,produto:r.produto,qntCaixas:r.qntCaixas,maquina:r.maquina}));
  renderReorderList();
}

function renderReorderList(){
  const el=document.getElementById('reorder-list');
  el.innerHTML=reorderItems.map((item,i)=>`
    <div class="reorder-item" draggable="true" data-idx="${i}"
      ondragstart="riDragStart(event,${i})"
      ondragover="riDragOver(event,${i})"
      ondragend="riDragEnd(event)"
      ondrop="riDrop(event,${i})">
      <span class="ri-drag">⠿</span>
      <span class="ri-num">${i+1}.</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.produto}">${item.produto}</div>
        <div style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace">${item.qntCaixas} cx</div>
      </div>
    </div>`).join('');
}

function riDragStart(e,idx){
  dragSrc=idx;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed='move';
}
function riDragOver(e,idx){
  e.preventDefault();
  e.dataTransfer.dropEffect='move';
  document.querySelectorAll('.reorder-item').forEach((el,i)=>{
    el.classList.toggle('drag-over',i===idx&&idx!==dragSrc);
  });
}
function riDrop(e,idx){
  e.preventDefault();
  if(dragSrc===null||dragSrc===idx) return;
  const moved=reorderItems.splice(dragSrc,1)[0];
  reorderItems.splice(idx,0,moved);
  dragSrc=idx;
  renderReorderList();
}
function riDragEnd(e){
  e.target.classList.remove('dragging');
  document.querySelectorAll('.reorder-item').forEach(el=>el.classList.remove('drag-over'));
  dragSrc=null;
}

async function saveReorder(){
  if(!reorderMaq||!reorderItems.length){closeReorderModal();return;}
  // Update the id/order by assigning a sort key stored as a new field 'sortOrder'
  // We'll reassign record IDs using a sort order field
  const updates=[];
  for(let i=0;i<reorderItems.length;i++){
    const rec=records.find(r=>r.id===reorderItems[i].id);
    if(rec){
      rec.sortOrder=i;
      updates.push(dbPut(rec));
    }
  }
  await Promise.all(updates);
  await reload();
  closeReorderModal();
  renderGantt();
  toast('Ordem de produção atualizada!','ok');
}

// ===== FICHA TÉCNICA =====
let fichaTecnicaData = JSON.parse(JSON.stringify(FICHA_TECNICA)); // working copy (editable)

function initFichaTecnica(){
  // Populate machine filter
  const sel=document.getElementById('ft-maq-filter');
  if(!sel) return;
  const maqs=[...new Set(FICHA_TECNICA.map(p=>p.maquina))].sort();
  maqs.forEach(m=>{
    const o=document.createElement('option');
    o.value=m; o.textContent=m;
    sel.appendChild(o);
  });
}

function loadFichaTecnica(input){
  const file=input.files[0];
  if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const wb=XLSX.read(e.target.result,{type:'array'});
      // Try to find Base_Maquina_Tempo sheet
      const sheetName=wb.SheetNames.find(s=>s.includes('Base_Maquina'))||wb.SheetNames[0];
      const ws=wb.Sheets[sheetName];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      // Try to find Consumo_Insumos sheet
      const insSheet=wb.SheetNames.find(s=>s.includes('Consumo'));
      let insByProd={};
      if(insSheet){
        const wsIns=wb.Sheets[insSheet];
        const insRows=XLSX.utils.sheet_to_json(wsIns,{header:1,defval:''}).slice(1);
        insRows.forEach(r=>{
          const prodDesc=String(r[1]||'').trim();
          const insDesc=String(r[2]||'').trim();
          const qty=parseFloat(r[3])||0;
          if(prodDesc&&insDesc&&qty){
            if(!insByProd[prodDesc]) insByProd[prodDesc]=[];
            insByProd[prodDesc].push({insumo:insDesc,qty});
          }
        });
      }
      fichaTecnicaData=rows.slice(1).filter(r=>r[0]&&r[1]).map(r=>({
        cod:parseInt(r[0])||0,
        desc:String(r[1]).trim(),
        unid:parseInt(r[2])||1,
        pc_min:parseFloat(r[4])||1,
        maquina:String(r[5]||'MANUAL').trim(),
        insumos:insByProd[String(r[1]).trim()]||[]
      }));
      // Refresh machine filter (element may not exist on current view)
      const sel = document.getElementById('ft-maq-filter');
      if (sel) {
        const currentVal = sel.value;
        while (sel.options.length > 1) sel.remove(1);
        [...new Set(fichaTecnicaData.map(p => p.maquina))].sort().forEach(m => {
          const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o);
        });
        sel.value = currentVal;
      }
      if (typeof renderFichaTecnica === 'function') renderFichaTecnica();
      toast(`Ficha técnica atualizada: ${fichaTecnicaData.length} produtos`, 'ok');
    }catch(err){
      toast('Erro ao ler arquivo: '+err.message,'err');
    }
  };
  reader.readAsArrayBuffer(file);
  input.value='';
}

function renderFichaTecnica(){
  const q=(document.getElementById('ft-search')?.value||'').toLowerCase().trim();

  // Deduplicate by desc — one entry per unique product description
  const seen = new Set();
  const deduped = [];
  fichaTecnicaData.forEach(p=>{
    const key = p.desc.trim().toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    deduped.push(p);
  });

  let filtered = deduped.filter(p=>{
    if(!q) return true;
    if(p.desc.toLowerCase().includes(q)) return true;
    if(p.insumos.some(i=>i.insumo.toLowerCase().includes(q))) return true;
    return false;
  });

  const countEl=document.getElementById('ft-count');
  if(countEl) countEl.textContent=filtered.length;

  if(!filtered.length){
    document.getElementById('ft-body').innerHTML='<div class="empty"><div class="ei">🔍</div>Nenhum produto encontrado</div>';
    return;
  }

  const PENCIL_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

  let rows = '';
  filtered.forEach(p=>{
    const insHtml=p.insumos.length
      ? p.insumos.map(i=>`<div style="font-size:10px;color:var(--text2);padding:1px 0;border-bottom:1px solid rgba(31,45,61,.3);white-space:nowrap"><span style="color:var(--text3);font-family:'JetBrains Mono',monospace;font-size:10px;min-width:52px;display:inline-block">${i.qty>0?i.qty.toFixed(i.qty<0.01?6:i.qty<1?4:2):'—'}</span> ${i.insumo}</div>`).join('')
      : '<span style="color:var(--text3);font-size:10px">—</span>';
    const descKey = encodeURIComponent(p.desc.trim());
    rows+=`<tr>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text3);white-space:nowrap">${p.cod}</td>
      <td><div style="font-size:12px;color:var(--text);font-weight:500;line-height:1.4">${p.desc}</div></td>
      <td style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--cyan)">${p.unid}</td>
      <td style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--warn)">${p.pc_min}</td>
      <td style="padding:4px 12px">${insHtml}</td>
      <td style="text-align:center">
        <button class="btn btn-edit" onclick="editFichaByCod(this.dataset.cod)" data-cod="${p.cod}" style="padding:4px 9px" title="Editar">${PENCIL_SVG}</button>
      </td>
    </tr>`;
  });

  const ftDescW = parseInt(localStorage.getItem('ft-desc-width')||'280');
  const html = `
  <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
  <table id="ft-table" style="width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed">
    <colgroup>
      <col style="width:58px">
      <col id="ft-col-desc" style="width:${ftDescW}px;min-width:80px">
      <col style="width:62px">
      <col style="width:66px">
      <col id="ft-col-ins">
      <col style="width:38px">
    </colgroup>
    <thead><tr style="background:var(--s2)">
      <th style="text-align:left;padding:8px 10px;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);white-space:nowrap">Cód.</th>
      <th style="text-align:left;padding:0;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);position:relative;user-select:none">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px">
          <span>Descrição</span>
          <div id="ft-desc-resizer" style="width:6px;height:100%;position:absolute;right:0;top:0;cursor:col-resize;background:transparent;display:flex;align-items:center;justify-content:center" title="Arraste para redimensionar">
            <div style="width:2px;height:14px;background:var(--border);border-radius:1px"></div>
          </div>
        </div>
      </th>
      <th style="text-align:right;padding:8px 8px;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);white-space:nowrap">Unid/Cx</th>
      <th style="text-align:right;padding:8px 8px;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);white-space:nowrap">Pc/Min</th>
      <th style="text-align:left;padding:8px 10px;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Insumos</th>
      <th style="padding:8px 4px"></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  document.getElementById('ft-body').innerHTML=html;

  // Resize logic for description column
  (function(){
    const resizer = document.getElementById('ft-desc-resizer');
    const colDesc = document.getElementById('ft-col-desc');
    if(!resizer || !colDesc) return;
    let startX, startW;
    resizer.addEventListener('mousedown', function(e){
      startX = e.clientX;
      startW = colDesc.offsetWidth;
      resizer.querySelector('div').style.background = 'var(--cyan)';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e){
      const w = Math.max(80, startW + (e.clientX - startX));
      colDesc.style.width = w + 'px';
      localStorage.setItem('ft-desc-width', w);
    }
    function onUp(){
      resizer.querySelector('div').style.background = 'var(--border)';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  })();
}

// ── Ficha Técnica: edit helpers ──

function fteRenderInsumos(insumos){
  return insumos.map((ins,i)=>`
    <div class="fte-ins-row" id="fte-ins-${i}" style="display:grid;grid-template-columns:100px 1fr 32px;gap:6px;margin-bottom:6px;align-items:center">
      <input class="finp fte-qty" type="number" step="any" min="0" value="${ins.qty}" style="font-family:'JetBrains Mono',monospace;font-size:12px;padding:7px 8px" placeholder="Qtd">
      <input class="finp fte-name" value="${ins.insumo.replace(/"/g,'&quot;')}" style="font-size:12px;padding:7px 10px" placeholder="Nome do insumo">
      <button onclick="this.closest('.fte-ins-row').remove()" class="btn btn-danger" style="padding:4px 8px;font-size:14px;min-width:32px;justify-content:center">−</button>
    </div>`).join('');
}

function fteAddRow(){
  const container=document.getElementById('fte-insumos-list');
  const div=document.createElement('div');
  div.className='fte-ins-row';
  div.id='fte-ins-new-'+Date.now();
  div.style='display:grid;grid-template-columns:100px 1fr 32px;gap:6px;margin-bottom:6px;align-items:center';
  div.innerHTML=`
    <input class="finp fte-qty" type="number" step="any" min="0" value="" style="font-family:'JetBrains Mono',monospace;font-size:12px;padding:7px 8px" placeholder="Qtd">
    <input class="finp fte-name" value="" style="font-size:12px;padding:7px 10px" placeholder="Nome do insumo">
    <button onclick="this.closest('.fte-ins-row').remove()" class="btn btn-danger" style="padding:4px 8px;font-size:14px;min-width:32px;justify-content:center">−</button>`;
  container.appendChild(div);
}

// Abre o modal de edição usando cod como chave (robusto mesmo que descrição mude)
function editFichaByCod(cod){
  const codNum = parseInt(cod);
  const p = fichaTecnicaData.find(x=>x.cod===codNum);
  if(!p) return;

  document.getElementById('ft-edit-modal')?.remove();
  const modal=document.createElement('div');
  modal.className='conf-overlay on';
  modal.id='ft-edit-modal';
  modal.style.zIndex = '1100'; // acima da tela de Configurações (z-index ~1000)
  modal.innerHTML=`
    <div class="modal-box" style="max-width:720px">
      <div class="modal-hd">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:8px;flex-shrink:0"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <h2 style="flex:1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.desc}</h2>
        <button class="btn btn-ghost" onclick="document.getElementById('ft-edit-modal').remove()" style="padding:6px 10px">✕</button>
      </div>
      <div class="modal-bd">
        <div class="fg" style="margin-bottom:16px">
          <div class="frow">
            <label class="flbl">Unid/Caixa</label>
            <input class="finp" type="number" id="fte-unid" value="${p.unid}" min="1">
          </div>
          <div class="frow">
            <label class="flbl">Peças/Minuto</label>
            <input class="finp" type="number" id="fte-pcmin" value="${p.pc_min}" min="0.1" step="0.1">
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="flbl" style="font-size:12px;font-weight:600">Insumos <span style="font-size:10px;color:var(--text3);font-weight:400">(quantidade por caixa)</span></div>
          <button onclick="fteAddRow()" class="btn btn-ghost" style="padding:5px 12px;font-size:12px">+ Adicionar</button>
        </div>
        <div style="display:grid;grid-template-columns:100px 1fr 32px;gap:6px;margin-bottom:6px;padding:0 0 4px 0;border-bottom:1px solid var(--border)">
          <div class="flbl" style="font-size:9px">Quantidade</div>
          <div class="flbl" style="font-size:9px">Nome do Insumo</div>
          <div></div>
        </div>
        <div id="fte-insumos-list" style="max-height:360px;overflow-y:auto;padding-right:4px">
          ${fteRenderInsumos(p.insumos)}
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-ghost" onclick="document.getElementById('ft-edit-modal').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="saveFichaByCod(this.dataset.cod)" data-cod="${p.cod}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Salvar
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// Salva usando cod como chave — propaga para TODOS os registros com o mesmo cod (multi-máquina)
async function saveFichaByCod(cod){
  const codNum = parseInt(cod);
  const newUnid = parseInt(document.getElementById('fte-unid').value)||1;
  const newPcMin = parseFloat(document.getElementById('fte-pcmin').value)||1;
  const rows = document.getElementById('fte-insumos-list').querySelectorAll('.fte-ins-row');
  const newInsumos = [];
  rows.forEach(row=>{
    const qty = parseFloat(row.querySelector('.fte-qty').value)||0;
    const name = row.querySelector('.fte-name').value.trim();
    if(name) newInsumos.push({insumo:name, qty});
  });

  // Atualiza TODOS os registros com o mesmo cod na memória
  let count = 0;
  fichaTecnicaData.forEach(p=>{
    if(p.cod===codNum){
      p.unid = newUnid;
      p.pc_min = newPcMin;
      p.insumos = newInsumos.map(i=>({...i}));
      count++;
    }
  });

  document.getElementById('ft-edit-modal').remove();

  // Salva no Firestore (coleção fichaTecnica)
  try {
    const snap = await getDocs(query(collection(firestoreDB, 'fichaTecnica'), where('cod', '==', codNum)));
    // Pega o primeiro registro com esse cod para montar o documento
    const base = fichaTecnicaData.find(p => p.cod === codNum) || {};
    const payload = {
      cod: codNum,
      desc: base.desc || '',
      unid: newUnid,
      pc_min: newPcMin,
      maquina: base.maquina || '',
      insumos: newInsumos,
      atualizadoEm: new Date().toISOString()
    };
    if (!snap.empty) {
      await setDoc(doc(firestoreDB, 'fichaTecnica', snap.docs[0].id), payload);
    } else {
      await addDoc(collection(firestoreDB, 'fichaTecnica'), { ...payload, criadoEm: new Date().toISOString() });
    }
    toast(`Ficha técnica salva! ${count} registro(s) · ${newInsumos.length} insumos.`, 'ok');
  } catch(e) {
    toast('Salvo na memória, mas erro ao gravar no banco: ' + e.message, 'warn');
  }

  renderFichaTecnica();
  if(typeof renderFichaTecnicaCfg === 'function') renderFichaTecnicaCfg();
  if(insMaqMonday) renderInsumosMaq();
  if(insGeralMonday) renderInsumosGeral();
}

// Compatibilidade legada — editFicha(cod) e editFichaByDesc(desc) redirecionam para editFichaByCod
function editFicha(cod){
  editFichaByCod(cod);
}
function editFichaByDesc(desc){
  const p = fichaTecnicaData.find(x=>x.desc.trim()===desc.trim());
  if(p) editFichaByCod(p.cod);
}
// ===== PRODUZIDO =====
const APON_HOURS = [7,8,9,10,11,12,13,14,15,16,17];
let prodBaseMonday = null;
let prodSelectedDate = null; // 'YYYY-MM-DD' or 'semana' for weekly summary

function aponKey(date, recId){ return 'apon_'+date+'_'+recId; }
function aponStorageGet(key){
  try{ const v=localStorage.getItem(key); return v?JSON.parse(v):null; }catch(e){ return null; }
}
function aponStorageSet(key, obj){
  try{ localStorage.setItem(key, JSON.stringify(obj)); return true; }catch(e){ return false; }
}
function aponGetAllKeys(){
  const keys=[];
  try{ for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k&&k.startsWith('apon_')) keys.push(k); } }catch(e){}
  return keys;
}

// Total produzido em dias ANTERIORES a exceptDate (não inclui o próprio dia)
function aponGetPrevTotal(recId, exceptDate){
  let total = 0;
  const suffix = '_' + recId;
  aponGetAllKeys().forEach(function(k){
    if(!k.endsWith(suffix)) return;
    const datePart = k.slice('apon_'.length, k.length - suffix.length);
    if(datePart === exceptDate) return;
    // só contar dias anteriores ao exceptDate
    if(datePart >= exceptDate) return;
    const d = aponStorageGet(k);
    if(d) APON_HOURS.forEach(function(h){ total += parseInt(d[h])||0; });
  });
  return total;
}

// Total produzido em TODOS os dias (incluindo o informado)
function aponGetTotalProduced(recId){
  let total = 0;
  const suffix = '_' + recId;
  aponGetAllKeys().forEach(function(k){
    if(!k.endsWith(suffix)) return;
    const d = aponStorageGet(k);
    if(d) APON_HOURS.forEach(function(h){ total += parseInt(d[h])||0; });
  });
  return total;
}

// Verifica se um produto deve aparecer em determinado dia
// Regras:
//  1. firstSegDate <= dateVal (não aparece antes do primeiro segmento agendado)
//  2. prevTotal < needed (se já concluído, não aparece)
//  3. Tem segmento nesse dia OU está em overflow (não concluiu ainda e passou do dia programado)
//  4. Se sequência bloqueada (produto anterior não terminou), ainda aparece mas bloqueado
function prodShouldShowOnDay(rec, segments, dateVal){
  // FIX BUG 2: usar a data do primeiro segmento como startDate, não dtDesejada/dtSolicitacao
  // Isso evita produtos aparecerem em dias anteriores ao que foram realmente agendados
  const firstSegDate = segments.length > 0 ? segments[0].date : null;
  const fallbackDate = rec.dtDesejada || rec.dtSolicitacao;
  const startDate = firstSegDate || fallbackDate;
  if(!startDate || startDate > dateVal) return false;           // não aparece antes do primeiro segmento
  const hasSeg = segments.some(function(s){ return s.date === dateVal; });
  // Se tem segmento neste dia, sempre mostra (verde se concluído, normal se não)
  if(hasSeg) return true;
  // Se não tem segmento neste dia: só mostra em overflow se ainda não concluiu globalmente
  const globalTotal = aponGetTotalProduced(rec.id);
  const needed = rec.qntCaixas;
  if(globalTotal >= needed) return false;  // concluído: não aparece em dias sem segmento (overflow)
  return true;                             // overflow: ainda não concluiu, continua aparecendo
}

function prodToday(){
  prodBaseMonday = getWeekMonday(new Date());
  prodSelectedDate = dateStr(new Date());
  renderProduzido();
}
function prodWeek(dir){
  if(!prodBaseMonday) prodBaseMonday = getWeekMonday(new Date());
  prodBaseMonday = new Date(prodBaseMonday);
  prodBaseMonday.setDate(prodBaseMonday.getDate() + dir*7);
  const days = getWeekDays(prodBaseMonday);
  const workDays = days.filter(function(d){ return hoursOnDay(d)>0; });
  prodSelectedDate = dateStr(workDays[0] || days[0]);
  renderProduzido();
}
function prodGoDate(){
  const v = document.getElementById('prod-goto').value;
  if(!v) return;
  prodBaseMonday = getWeekMonday(new Date(v+'T12:00:00'));
  prodSelectedDate = v;
  renderProduzido();
}
function prodSelectDay(ds){
  // FIX BUG 3: Salvar dados do dia atual antes de trocar de aba
  // Isso evita perda de dados digitados mas não salvos explicitamente
  if(prodSelectedDate && prodSelectedDate !== 'semana' && prodSelectedDate !== ds){
    const body = document.getElementById('apon-body');
    if(body && body._machineGroups && body._machineGroups.length){
      for(let gi=0;gi<body._machineGroups.length;gi++){
        const items = body._machineGroups[gi].items;
        for(let ii=0;ii<items.length;ii++){
          const rec = items[ii].rec;
          const data = {};
          APON_HOURS.forEach(function(h){
            const inp = document.querySelector('.apon-input[data-rec="'+rec.id+'"][data-hr="'+h+'"]');
            data[h] = inp?(parseInt(inp.value)||0):0;
          });
          aponStorageSet(aponKey(prodSelectedDate, rec.id), data);
        }
      }
    }
  }
  prodSelectedDate = ds;
  renderProdDayTabs();
  renderApontamento();
}
function aponToday(){ prodToday(); }
function aponSaveAll(){ prodSaveAll(); }

function renderProduzido(){
  if(!prodBaseMonday) prodBaseMonday = getWeekMonday(new Date());
  if(!prodSelectedDate) prodSelectedDate = dateStr(new Date());
  const days = getWeekDays(prodBaseMonday);
  const weekDates = days.map(function(d){ return dateStr(d); });
  if(prodSelectedDate === 'producao-dia'){
    renderProdDayTabs();
    renderProducaoDia();
    return;
  }
  if(prodSelectedDate !== 'semana' && !weekDates.includes(prodSelectedDate)){
    const workDays = days.filter(function(d){ return hoursOnDay(d)>0; });
    prodSelectedDate = dateStr(workDays[0] || days[0]);
  }
  const sun = days[6];
  document.getElementById('prod-week-label').textContent =
    fmtDate(days[0]) + ' – ' + fmtDate(sun) + ' / ' + days[0].getFullYear();
  renderProdDayTabs();
  renderApontamento();
}

function renderProdDayTabs(){
  if(!prodBaseMonday) return;
  const days = getWeekDays(prodBaseMonday);
  const today = dateStr(new Date());
  let html = '';

  // Abas de dias úteis (Seg–Sex)
  days.forEach(function(d){
    const ds = dateStr(d);
    if(hoursOnDay(d)===0) return;
    const isSelected = ds === prodSelectedDate;
    const isToday = ds === today;
    const dayName = DAY_NAMES[d.getDay()];
    const count = getProdCountForDay(ds);
    const borderColor = isSelected?'var(--cyan)':isToday?'rgba(0,229,204,.3)':'var(--border)';
    const bg = isSelected?'var(--cyan)':'var(--s1)';
    const color = isSelected?'#000':isToday?'var(--cyan)':'var(--text2)';
    const badgeBg = isSelected?'rgba(0,0,0,.7)':'var(--cyan)';
    const badgeColor = isSelected?'var(--cyan)':'#000';
    const badge = count>0 ? '<span style="position:absolute;top:-6px;right:-6px;background:'+badgeBg+';color:'+badgeColor+';border-radius:10px;font-size:9px;font-weight:700;padding:1px 6px;font-family:\'JetBrains Mono\',monospace;line-height:1.4">'+count+'</span>' : '';
    html += '<button onclick="prodSelectDay(\''+ds+'\')" style="padding:8px 16px;border-radius:8px;cursor:pointer;font-family:\'Space Grotesk\',sans-serif;font-weight:600;font-size:12px;border:1px solid '+borderColor+';background:'+bg+';color:'+color+';transition:all .18s;position:relative;display:inline-flex;flex-direction:column;align-items:center;gap:2px;min-width:76px">'
      + '<span style="font-size:13px">'+dayName+'</span>'
      + '<span style="font-size:10px;opacity:.85">'+fmtDate(d)+'</span>'
      + badge
      + '</button>';
  });

  // Aba "Produção Dia"
  const isPdSelected = prodSelectedDate === 'producao-dia';
  const pdBorder = isPdSelected ? 'var(--orange)' : 'var(--border)';
  const pdBg = isPdSelected ? 'var(--orange)' : 'var(--s1)';
  const pdColor = isPdSelected ? '#000' : 'var(--text2)';
  html += '<button onclick="prodSelectDay(\'producao-dia\')" style="padding:8px 16px;border-radius:8px;cursor:pointer;font-family:Space Grotesk,sans-serif;font-weight:600;font-size:12px;border:1px solid '+pdBorder+';background:'+pdBg+';color:'+pdColor+';transition:all .18s;position:relative;display:inline-flex;flex-direction:column;align-items:center;gap:2px;min-width:100px;margin-left:8px">'
    + '<span style="font-size:13px">&#x1F5C2;</span>'
    + '<span style="font-size:10px">Produ&#231;&#227;o Dia</span>'
    + '</button>';

  // Aba "Total da Semana" ao lado da sexta-feira
  const isWeekSelected = prodSelectedDate === 'semana';
  const weekBorderColor = isWeekSelected?'var(--purple)':'var(--border)';
  const weekBg = isWeekSelected?'var(--purple)':'var(--s1)';
  const weekColor = isWeekSelected?'#fff':'var(--text2)';
  html += '<button onclick="prodSelectDay(\'semana\')" style="padding:8px 16px;border-radius:8px;cursor:pointer;font-family:\'Space Grotesk\',sans-serif;font-weight:600;font-size:12px;border:1px solid '+weekBorderColor+';background:'+weekBg+';color:'+weekColor+';transition:all .18s;position:relative;display:inline-flex;flex-direction:column;align-items:center;gap:2px;min-width:100px;margin-left:8px">'
    + '<span style="font-size:13px">📊</span>'
    + '<span style="font-size:10px">Total da Semana</span>'
    + '</button>';

  const el = document.getElementById('prod-day-tabs');
  if(el) el.innerHTML = html;
}

function getProdCountForDay(dateVal){
  // Conta produtos programados para esta semana que têm quantidades neste dia
  if(!prodBaseMonday) return 0;
  const days = getWeekDays(prodBaseMonday);
  const wStart = dateStr(days[0]);
  const wEnd   = dateStr(days[6]);
  let count = 0;
  records.forEach(function(r){
    const dt = r.dtDesejada || r.dtSolicitacao;
    if(!dt || dt < wStart || dt > wEnd) return;
    const d = aponStorageGet(aponKey(dateVal, r.id));
    if(d){
      let tot = 0;
      APON_HOURS.forEach(function(h){ tot += parseInt(d[h])||0; });
      if(tot > 0) count++;
    }
  });
  return count;
}

// Coleta os itens de um dia para todas as máquinas
function buildDayItems(dateVal){
  const sched = buildSchedule(prodBaseMonday).schedule;
  const machineGroups = [];

  for(let mi=0;mi<MAQUINAS.length;mi++){
    const maq = MAQUINAS[mi];
    const entries = sched[maq]||[];
    if(!entries.length) continue;
    const items = [];

    for(let seqIdx=0; seqIdx<entries.length; seqIdx++){
      const rec = entries[seqIdx].rec;
      const segments = entries[seqIdx].segments;

      if(!prodShouldShowOnDay(rec, segments, dateVal)) continue;

      const prevTotal = aponGetPrevTotal(rec.id, dateVal);
      const needed = rec.qntCaixas;

      // Bloqueio sequencial REMOVIDO: todos os produtos são editáveis independentemente
      let seqBlocked = false;

      const todayData = aponStorageGet(aponKey(dateVal, rec.id)) || {};
      const todayTotal = APON_HOURS.reduce(function(a,h){ return a+(parseInt(todayData[h])||0); }, 0);
      const overallTotal = prevTotal + todayTotal;
      // FIX: usar total de TODOS os dias para saber se está concluído
      // Assim o produto fica verde em qualquer dia após ter sido finalizado
      const globalTotal = aponGetTotalProduced(rec.id);
      const isDone = globalTotal >= needed;

      items.push({
        rec, seqIdx, prevTotal, needed,
        todayData, todayTotal, overallTotal, isDone, seqBlocked
      });
    }
    if(items.length) machineGroups.push({maq, items});
  }
  return machineGroups;
}

function renderApontamento(){
  const dateVal = prodSelectedDate;
  const body = document.getElementById('apon-body');
  if(!dateVal || !prodBaseMonday){
    body.innerHTML='<div class="empty"><div class="ei">📅</div>Selecione uma semana e um dia</div>';
    return;
  }

  // Se a aba "Produção Dia" estiver selecionada
  if(dateVal === 'producao-dia'){
    renderProducaoDia();
    return;
  }
  // Se a aba "Total da Semana" estiver selecionada, renderiza o resumo semanal
  if(dateVal === 'semana'){
    renderWeeklySummary(body);
    return;
  }

  // Filtra somente registros da semana sendo visualizada
  const weekDays = getWeekDays(prodBaseMonday);
  const weekStart = dateStr(weekDays[0]);
  const weekEnd   = dateStr(weekDays[6]);
  function recIsInWeek(r){
    const dt = r.dtDesejada || r.dtSolicitacao;
    return dt && dt >= weekStart && dt <= weekEnd;
  }

  // Monta grupos por máquina usando registros da semana selecionada
  // Filtra pelo que foi definido em "Produção Dia": só mostra produtos atribuídos a este dia
  // (e que não foram finalizados). Se o produto não tiver dia atribuído, não aparece.
  const machineGroups = [];
  for(let mi=0; mi<MAQUINAS.length; mi++){
    const maq = MAQUINAS[mi];
    const recs = records.filter(function(r){
      if(r.maquina !== maq || !recIsInWeek(r)) return false;
      // Respeita atribuição do Produção Dia
      const assigned = pdGetAssign(r.id);
      if(assigned !== dateVal) return false;
      // Oculta finalizados
      if(pdIsFin(r.id)) return false;
      return true;
    });
    if(!recs.length) continue;
    const items = recs.map(function(rec, seqIdx){
      const prevTotal = aponGetPrevTotal(rec.id, dateVal);
      const needed = rec.qntCaixas;
      const todayData = aponStorageGet(aponKey(dateVal, rec.id)) || {};
      let todayTotal = 0;
      APON_HOURS.forEach(function(h){ todayTotal += parseInt(todayData[h])||0; });
      const overallTotal = prevTotal + todayTotal;
      // Usa o total global para isDone: se concluído em qualquer dia, aparece verde em todos os dias
      const globalTotal = aponGetTotalProduced(rec.id);
      const isDone = globalTotal >= needed;
      return { rec: rec, seqIdx: seqIdx, prevTotal: prevTotal, needed: needed,
               todayData: todayData, todayTotal: todayTotal, overallTotal: overallTotal,
               isDone: isDone, seqBlocked: false };
    });
    machineGroups.push({maq: maq, items: items});
  }

  if(!machineGroups.length){
    // Verifica se há produtos na semana mas sem atribuição para este dia
    const weekRecsAll = records.filter(function(r){ return recIsInWeek(r); });
    const hasAnyAssigned = weekRecsAll.some(function(r){ return pdGetAssign(r.id) === dateVal; });
    const hasWeekRecs = weekRecsAll.length > 0;
    let emptyMsg;
    if(!hasWeekRecs){
      emptyMsg = 'Nenhum produto programado para esta semana.';
    } else {
      emptyMsg = 'Nenhum produto atribuído para este dia. Use a aba <strong style="color:var(--orange)">&#x1F5C2; Produ&#231;&#227;o Dia</strong> para arrastar produtos para os dias da semana.';
    }
    body.innerHTML='<div class="empty" style="flex-direction:column;gap:10px"><div class="ei">&#128197;</div><div>'+emptyMsg+'</div></div>';
    body._machineGroups = [];
    body._dateVal = dateVal;
    return;
  }

  const dateLabel = fmtDate(new Date(dateVal+'T12:00:00'));
  const totalProds = machineGroups.reduce(function(a,g){ return a+g.items.length; },0);

  let html = '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:12px">'
    + dateLabel + ' · ' + totalProds + ' produto(s)</div>';

  for(let gi=0;gi<machineGroups.length;gi++){
    const grp = machineGroups[gi];
    const items = grp.items;
    const hdrCols = '<th style="min-width:32px;text-align:center">#</th><th class="col-prod">Produto</th>'
      + APON_HOURS.map(function(h){ return '<th style="min-width:68px">'+String(h).padStart(2,'0')+'h</th>'; }).join('')
      + '<th style="min-width:72px">Total Dia</th><th style="min-width:80px">Acumulado</th><th style="min-width:72px">Solicitado</th><th style="min-width:100px">Progresso</th>';

    // Cabeçalho da seção com nome da máquina + seletor de funcionário
    const maqKey = 'apon_func_'+dateVal+'_'+grp.maq.replace(/\s+/g,'_');
    const savedFunc = localStorage.getItem(maqKey)||'';
    const now = Date.now();
    const activeWorkers = (typeof funcionarios!=='undefined')
      ? funcionarios.filter(function(f){
          return !(f.deactivatedUntil && new Date(f.deactivatedUntil+'T23:59:59').getTime()>=now);
        })
      : [];
    const funcOptions = '<option value="">— Selecionar operador —</option>'
      + activeWorkers.map(function(f){
          return '<option value="'+f.nome.replace(/"/g,'&quot;')+'"'+(savedFunc===f.nome?' selected':'')+'>'+f.nome+(f.cargo?' ('+f.cargo+')':'')+'</option>';
        }).join('');
    const funcSelector = activeWorkers.length
      ? '<div style="display:flex;align-items:center;gap:7px">'
          + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
          + '<select data-maqkey="'+maqKey+'" onchange="aponSaveFunc(this)" style="background:var(--s1);border:1px solid '+(savedFunc?'var(--cyan)':'var(--border)')+';border-radius:6px;color:'+(savedFunc?'var(--cyan)':'var(--text2)')+';font-family:\'Space Grotesk\',sans-serif;font-size:12px;padding:4px 10px;cursor:pointer;max-width:200px;transition:all .2s" id="func-sel-'+gi+'">'+funcOptions+'</select>'
          + '</div>'
      : '<span style="font-size:11px;color:var(--text3);font-style:italic">Nenhum operador — <a href="#" onclick="openSettings();return false" style="color:var(--cyan)">Configurações</a></span>';

    html += '<div class="apon-section" style="margin-bottom:14px">'
      + '<div class="apon-section-header">'
      + '<span class="ins-maq-title">🏭 '+grp.maq+'</span>'
      + '<div style="display:flex;align-items:center;gap:14px">'
      + funcSelector
      + '<span style="font-size:10px;color:var(--text3);font-family:\'JetBrains Mono\',monospace">'+items.length+' produto(s)</span>'
      + '</div>'
      + '</div>'
      + '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table class="apon-table"><thead><tr>'
      + hdrCols + '</tr></thead><tbody>';

    for(let ii=0;ii<items.length;ii++){
      const it = items[ii];
      const pct = it.needed>0 ? Math.min(100, Math.round(it.overallTotal/it.needed*100)) : 0;
      const barColor = it.isDone?'var(--green)':pct>=60?'var(--cyan)':'var(--warn)';
      const rowStyle = it.isDone ? 'background:rgba(41,217,132,.06);border-left:3px solid var(--green)' : '';
      const inputExtra = it.isDone ? 'border-color:rgba(41,217,132,.4)' : '';
      const doneNote = it.isDone
        ? '<div style="font-size:9px;color:var(--green);margin-top:2px;font-weight:700">✓ Concluído</div>'
        : '';

      const inputCells = APON_HOURS.map(function(h){
        const val = it.todayData[h]||'';
        return '<td style="padding:4px 6px"><input class="apon-input" type="number" min="0" data-rec="'+it.rec.id+'" data-hr="'+h+'" value="'+val+'" placeholder="0" oninput="aponRecalcRow('+it.rec.id+')" style="width:62px;'+inputExtra+'"></td>';
      }).join('');

      html += '<tr id="prod-row-'+it.rec.id+'" style="'+rowStyle+'">'
        + '<td style="text-align:center;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text3);font-weight:700;padding:6px 8px">'+(ii+1)+'</td>'
        + '<td class="col-prod" style="padding:6px 12px;min-width:200px;max-width:260px">'
        + '<div style="font-size:11px;font-weight:600;color:'+(it.isDone?'var(--green)':'var(--text)')+'">'+it.rec.produto+'</div>'
        + doneNote
        + '</td>'
        + inputCells
        + '<td style="padding:6px 8px;text-align:center"><span class="apon-total" id="apon-dayqty-'+it.rec.id+'" style="color:var(--cyan)">'+(it.todayTotal||'—')+'</span></td>'
        + '<td style="padding:6px 8px;text-align:center"><span class="apon-total" id="apon-overall-'+it.rec.id+'" style="color:'+(it.isDone?'var(--green)':'var(--text)')+'">'+it.overallTotal+'</span></td>'
        + '<td style="padding:6px 8px;text-align:center"><span class="apon-meta">'+it.needed+'</span></td>'
        + '<td style="padding:6px 8px;min-width:100px">'
        + '<div class="apon-meta" id="apon-pct-'+it.rec.id+'" style="color:'+barColor+';font-weight:700;text-align:center">'+pct+'%</div>'
        + '<div class="apon-progress" style="margin-top:3px"><div class="apon-progress-bar" id="apon-bar-'+it.rec.id+'" style="width:'+pct+'%;background:'+barColor+'"></div></div>'
        + '</td>'
        + '</tr>';
    }
    html += '</tbody></table></div></div>';
  }

  body.innerHTML = html;
  body._machineGroups = machineGroups;
  body._dateVal = dateVal;
}

// Aba "Total da Semana": mostra todos os produtos programados com taxa de produção e status
function aponSaveFunc(sel){
  const key = sel.dataset.maqkey;
  if(sel.value){
    localStorage.setItem(key, sel.value);
    sel.style.borderColor='var(--cyan)';
    sel.style.color='var(--cyan)';
  } else {
    localStorage.removeItem(key);
    sel.style.borderColor='var(--border)';
    sel.style.color='var(--text2)';
  }
}

function aponGetFinalizationDay(recId, needed){
  // Descobre em qual dia a produção acumulada atingiu ou superou needed
  // Retorna a string da data ou null
  const suffix = '_' + recId;
  const keys = aponGetAllKeys().filter(function(k){ return k.endsWith(suffix); });
  const dateParts = keys.map(function(k){
    return k.slice('apon_'.length, k.length - suffix.length);
  }).sort(); // ordenar por data ASC
  let cumulative = 0;
  for(let i=0;i<dateParts.length;i++){
    const d = aponStorageGet('apon_'+dateParts[i]+'_'+recId);
    if(d) APON_HOURS.forEach(function(h){ cumulative += parseInt(d[h])||0; });
    if(cumulative >= needed) return dateParts[i];
  }
  return null;
}


// ============================================================
// PRODUÇÃO DIA — kanban drag-drop por dia da semana
// ============================================================
// Storage keys:
//   pdAssign_<recId>   → 'YYYY-MM-DD'  day assignment for this week
//   pdFin_<recId>      → '1'           product marked as finished

function pdAssignKey(recId){ return 'pd_assign_'+recId; }
function pdFinKey(recId){ return 'pd_fin_'+recId; }

function pdGetAssign(recId){ return localStorage.getItem(pdAssignKey(recId))||null; }
function pdSetAssign(recId, ds){ if(ds) localStorage.setItem(pdAssignKey(recId),ds); else localStorage.removeItem(pdAssignKey(recId)); }

function pdIsFin(recId){ return localStorage.getItem(pdFinKey(recId))==='1'; }
function pdSetFin(recId, v){ if(v) localStorage.setItem(pdFinKey(recId),'1'); else localStorage.removeItem(pdFinKey(recId)); }

function renderProducaoDia(){
  if(!prodBaseMonday){ document.getElementById('apon-body').innerHTML='<div class="empty"><div class="ei">&#128197;</div>Selecione uma semana</div>'; return; }

  const weekDays = getWeekDays(prodBaseMonday);
  const weekStart = dateStr(weekDays[0]);
  const weekEnd   = dateStr(weekDays[6]);
  const workDays  = weekDays.filter(function(d){ return hoursOnDay(d)>0; });

  const weekRecs = records.filter(function(r){
    const dt = r.dtDesejada||r.dtSolicitacao;
    return dt && dt>=weekStart && dt<=weekEnd;
  });

  const finCount = weekRecs.filter(function(r){ return pdIsFin(r.id); }).length;

  let html = '<div>';

  if(finCount>0){
    html += '<div style="background:rgba(251,146,60,.1);border:1px solid var(--orange);border-radius:10px;padding:10px 16px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between">'
      + '<span style="font-size:12px;color:var(--orange)">'+finCount+' produto(s) finalizado(s) e ocultos</span>'
      + '<button onclick="pdRestoreAll()" style="background:var(--orange);color:#000;border:none;border-radius:6px;padding:5px 14px;font-size:12px;font-weight:700;cursor:pointer">&#8617; Restaurar todos</button>'
      + '</div>';
  }

  html += '<div style="display:grid;grid-template-columns:repeat('+workDays.length+',1fr);gap:10px;align-items:start">';

  workDays.forEach(function(d){
    const ds = dateStr(d);
    const dayName = DAY_NAMES[d.getDay()];
    const dateLabel = fmtDate(d);
    const isToday = ds===dateStr(new Date());

    const dayRecs = weekRecs.filter(function(r){
      return pdGetAssign(r.id)===ds && !pdIsFin(r.id);
    });

    const borderColor = isToday?'var(--cyan)':'var(--border)';
    const headerColor = isToday?'var(--cyan)':'var(--text2)';

    html += '<div class="pd-col" data-date="'+ds+'" '
      + 'ondragover="pdDragOver(event)" '
      + 'ondrop="pdDrop(this,event)" '
      + 'ondragleave="pdDragLeave(event)" '
      + 'style="background:var(--s1);border:1px solid '+borderColor+';border-radius:12px;min-height:160px;transition:border-color .2s,background .2s">';

    html += '<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">'
      + '<div>'
      + '<div style="font-weight:700;font-size:13px;color:'+headerColor+'">'+dayName+'</div>'
      + '<div style="font-size:10px;color:var(--text3)">'+dateLabel+'</div>'
      + '</div>'
      + '<span style="background:var(--s2);border:1px solid var(--border);border-radius:10px;font-size:10px;padding:2px 8px;color:var(--text3)">'+dayRecs.length+'</span>'
      + '</div>';

    html += '<div class="pd-cards" style="padding:10px;display:flex;flex-direction:column;gap:7px">';
    dayRecs.forEach(function(r){ html += pdCard(r, ds); });
    html += '</div>';
    html += '</div>';
  });

  html += '</div>';

  const unassigned = weekRecs.filter(function(r){
    const a = pdGetAssign(r.id);
    const isWD = workDays.some(function(wd){ return dateStr(wd)===a; });
    return !pdIsFin(r.id) && (!a || !isWD);
  });

  if(unassigned.length>0){
    html += '<div style="margin-top:16px">'
      + '<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">Sem dia definido &mdash; arraste para um dia</div>'
      + '<div class="pd-col pd-pool" data-date="" '
      + 'ondragover="pdDragOver(event)" ondrop="pdDrop(this,event)" ondragleave="pdDragLeave(event)" '
      + 'style="background:var(--s1);border:1px dashed var(--border);border-radius:12px;padding:10px;display:flex;flex-wrap:wrap;gap:7px;min-height:60px">';
    unassigned.forEach(function(r){ html += pdCard(r, null); });
    html += '</div></div>';
  }

  html += '</div>';
  document.getElementById('apon-body').innerHTML = html;
}

function pdCard(r, ds){
  var finBtn = ds
    ? '<button onclick="pdFinalize('+r.id+')" style="width:100%;margin-top:8px;background:var(--green);color:#000;border:none;border-radius:6px;padding:5px 0;font-size:11px;font-weight:700;cursor:pointer">&#10003; Finalizar produ&#231;&#227;o</button>'
    : '';
  return '<div class="pd-card" draggable="true" id="pd-card-'+r.id+'" data-id="'+r.id+'" '
    + 'ondragstart="pdDragStart(event,'+r.id+')" '
    + 'style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;cursor:grab;user-select:none;transition:box-shadow .15s,opacity .25s,transform .25s">'
    + '<div style="font-size:11px;font-weight:600;color:var(--text);line-height:1.4;margin-bottom:6px">'+r.produto+'</div>'
    + '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px">'
    + '<span style="font-size:10px;color:var(--purple);background:rgba(139,92,246,.12);border-radius:5px;padding:2px 7px">'+r.maquina+'</span>'
    + '<span style="font-size:10px;color:var(--text3)">'+r.qntCaixas+'cx</span>'
    + '</div>'
    + finBtn
    + '</div>';
}

let _pdDragging = null;

function pdDragStart(e, recId){
  _pdDragging = String(recId);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(recId));
  var card = document.getElementById('pd-card-'+recId);
  if(card) card.style.opacity = '0.45';
}

function pdDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.style.background = 'rgba(0,229,204,.08)';
  e.currentTarget.style.borderColor = 'var(--cyan)';
}

function pdDragLeave(e){
  e.currentTarget.style.background = 'var(--s1)';
  e.currentTarget.style.borderColor = '';
}

function pdDrop(col, e){
  e.preventDefault();
  var recId = parseInt(e.dataTransfer.getData('text/plain'));
  var ds = col.dataset.date || '';
  if(recId) pdSetAssign(recId, ds || null);
  _pdDragging = null;
  document.querySelectorAll('.pd-col').forEach(function(c){
    c.style.background = 'var(--s1)';
    c.style.borderColor = '';
  });
  renderProducaoDia();
}

function pdFinalize(recId){
  pdSetFin(recId, true);
  var card = document.getElementById('pd-card-'+recId);
  if(card){ card.style.opacity='0'; card.style.transform='scale(.9)'; }
  setTimeout(function(){ renderProducaoDia(); }, 250);
}

function pdRestoreAll(){
  if(!prodBaseMonday) return;
  var weekDays = getWeekDays(prodBaseMonday);
  var wS=dateStr(weekDays[0]), wE=dateStr(weekDays[6]);
  records.forEach(function(r){
    var dt=r.dtDesejada||r.dtSolicitacao;
    if(dt&&dt>=wS&&dt<=wE) pdSetFin(r.id, false);
  });
  renderProducaoDia();
}


function renderWeeklySummary(body){
  if(!prodBaseMonday){ body.innerHTML=''; return; }
  const days = getWeekDays(prodBaseMonday);
  const workDays = days.filter(function(d){ return hoursOnDay(d)>0; });
  const weekLabel = fmtDate(workDays[0]) + ' – ' + fmtDate(workDays[workDays.length-1]);

  // Filtra somente registros programados para esta semana
  const weekStart = dateStr(days[0]);
  const weekEnd   = dateStr(days[6]);
  const weekRecords = records.filter(function(r){
    const dt = r.dtDesejada || r.dtSolicitacao;
    return dt && dt >= weekStart && dt <= weekEnd;
  });

  if(!weekRecords.length){
    body.innerHTML='<div class="empty"><div class="ei">📊</div>Nenhum produto programado para esta semana.</div>';
    body._machineGroups = null;
    return;
  }

  // Agrupar por máquina
  const machineMap = {};
  weekRecords.forEach(function(rec){
    if(!machineMap[rec.maquina]) machineMap[rec.maquina] = [];
    machineMap[rec.maquina].push(rec);
  });

  let totalNeeded=0, totalProduced=0;
  let allSections = '';

  MAQUINAS.forEach(function(maq){
    const recs = machineMap[maq];
    if(!recs || !recs.length) return;

    let rows = '';
    recs.forEach(function(rec){
      const needed = rec.qntCaixas;
      const produced = aponGetTotalProduced(rec.id);
      totalNeeded += needed;
      totalProduced += produced;

      const pct = needed>0 ? Math.min(100, Math.round(produced/needed*100)) : 0;
      const realPct = needed>0 ? Math.round(produced/needed*100) : 0;
      const isDone = produced >= needed;
      const hasAny = produced > 0;

      // Cores por status
      const pctColor = isDone ? 'var(--green)' : pct>=60 ? 'var(--cyan)' : hasAny ? 'var(--warn)' : 'var(--text3)';

      // Badge de status
      let statusBadge;
      if(isDone){
        statusBadge = '<span style="display:inline-block;font-size:9px;font-weight:700;color:var(--green);background:rgba(41,217,132,.12);border:1px solid rgba(41,217,132,.28);border-radius:10px;padding:2px 9px;white-space:nowrap">✓ Finalizado</span>';
      } else if(hasAny){
        statusBadge = '<span style="display:inline-block;font-size:9px;font-weight:700;color:var(--warn);background:rgba(255,179,0,.12);border:1px solid rgba(255,179,0,.28);border-radius:10px;padding:2px 9px;white-space:nowrap">⚡ Finalizado Parcialmente</span>';
      } else {
        statusBadge = '<span style="display:inline-block;font-size:9px;font-weight:700;color:var(--text3);background:rgba(58,79,99,.18);border:1px solid rgba(58,79,99,.4);border-radius:10px;padding:2px 9px;white-space:nowrap">— Não iniciado</span>';
      }

      // Dia de finalização
      let finDayCell = '<span style="color:var(--text4);font-family:\'JetBrains Mono\',monospace;font-size:11px">—</span>';
      if(isDone){
        const finDay = aponGetFinalizationDay(rec.id, needed);
        if(finDay){
          const finDate = new Date(finDay+'T12:00:00');
          const dayName = DAY_NAMES[finDate.getDay()];
          finDayCell = '<span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--green);font-weight:600">'+dayName+' '+fmtDate(finDate)+'</span>';
        }
      }

      const rowBg = isDone ? 'background:rgba(41,217,132,.05);border-left:3px solid var(--green)' : hasAny ? 'border-left:3px solid rgba(255,179,0,.5)' : '';

      rows += '<tr style="'+rowBg+'">'
        + '<td style="text-align:left;padding:9px 14px;max-width:280px;word-break:break-word;line-height:1.4">'
        +   '<div style="font-size:11px;font-weight:600;color:'+(isDone?'var(--green)':hasAny?'var(--text)':'var(--text2)')+'">'+rec.produto+'</div>'
        + '</td>'
        + '<td style="text-align:center;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text2);padding:9px 10px">'+needed+'</td>'
        + '<td style="text-align:center;font-family:\'JetBrains Mono\',monospace;font-size:12px;font-weight:600;color:'+(isDone?'var(--green)':hasAny?'var(--text)':'var(--text3)')+';padding:9px 10px">'+produced+'</td>'
        + '<td style="text-align:center;padding:9px 10px;min-width:120px">'
        +   '<div style="font-family:\'JetBrains Mono\',monospace;font-size:12px;font-weight:700;color:'+pctColor+'">'+realPct+'%</div>'
        +   '<div class="apon-progress" style="margin-top:4px;min-width:70px"><div class="apon-progress-bar" style="width:'+pct+'%;background:'+pctColor+'"></div></div>'
        + '</td>'
        + '<td style="text-align:center;padding:9px 10px">'+statusBadge+'</td>'
        + '<td style="text-align:center;padding:9px 10px">'+finDayCell+'</td>'
        + '</tr>';
    });

    // Totais da máquina
    const maqNeeded = recs.reduce(function(a,r){ return a+r.qntCaixas; },0);
    const maqProduced = recs.reduce(function(a,r){ return a+aponGetTotalProduced(r.id); },0);
    const maqPct = maqNeeded>0 ? Math.round(maqProduced/maqNeeded*100) : 0;
    const maqColor = maqProduced>=maqNeeded?'var(--green)':maqPct>=60?'var(--cyan)':'var(--warn)';

    allSections += '<div class="apon-section" style="margin-bottom:16px">'
      + '<div class="apon-section-header">'
      + '<span class="ins-maq-title">🏭 '+maq+'</span>'
      + '<span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:'+maqColor+';font-weight:700">'+maqProduced+' / '+maqNeeded+' ('+maqPct+'%)</span>'
      + '</div>'
      + '<div style="overflow-x:auto">'
      + '<table class="apon-table"><thead><tr>'
      + '<th class="col-prod" style="text-align:left;min-width:220px">Produto</th>'
      + '<th style="text-align:center;min-width:80px">Solicitado</th>'
      + '<th style="text-align:center;min-width:80px">Realizado</th>'
      + '<th style="text-align:center;min-width:120px">Taxa / Progresso</th>'
      + '<th style="text-align:center;min-width:160px">Status</th>'
      + '<th style="text-align:center;min-width:130px">Dia Finalizado</th>'
      + '</tr></thead>'
      + '<tbody>'+rows+'</tbody>'
      + '</table></div></div>';
  });

  if(!allSections){
    body.innerHTML='<div class="empty"><div class="ei">📊</div>Nenhum produto cadastrado.</div>';
    body._machineGroups = null;
    return;
  }

  const totalPct = totalNeeded>0 ? Math.round(totalProduced/totalNeeded*100) : 0;
  const totalDone = totalProduced >= totalNeeded;
  const totalColor = totalDone?'var(--green)':totalPct>=60?'var(--cyan)':'var(--warn)';

  let html = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px">'
    + '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">📊 Total da Semana · '+weekLabel+'</div>'
    + '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">'
    +   '<div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;text-align:center">'
    +     '<div style="font-size:9px;color:var(--text3);font-family:\'JetBrains Mono\',monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Solicitado</div>'
    +     '<div style="font-family:\'JetBrains Mono\',monospace;font-size:18px;font-weight:600;color:var(--cyan)">'+totalNeeded+'</div>'
    +   '</div>'
    +   '<div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;text-align:center">'
    +     '<div style="font-size:9px;color:var(--text3);font-family:\'JetBrains Mono\',monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Realizado</div>'
    +     '<div style="font-family:\'JetBrains Mono\',monospace;font-size:18px;font-weight:600;color:'+totalColor+'">'+totalProduced+'</div>'
    +   '</div>'
    +   '<div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;text-align:center">'
    +     '<div style="font-size:9px;color:var(--text3);font-family:\'JetBrains Mono\',monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Taxa Geral</div>'
    +     '<div style="font-family:\'JetBrains Mono\',monospace;font-size:18px;font-weight:600;color:'+totalColor+'">'+totalPct+'%</div>'
    +   '</div>'
    + '</div>'
    + '</div>';

  html += allSections;

  body.innerHTML = html;
  body._machineGroups = null;
  body._dateVal = 'semana';
}

function aponRecalcRow(recId){
  const body = document.getElementById('apon-body');
  if(!body._machineGroups) return;
  let entry = null;
  for(let gi=0;gi<body._machineGroups.length;gi++){
    entry = body._machineGroups[gi].items.find(function(x){ return x.rec.id===recId; });
    if(entry) break;
  }
  if(!entry) return;

  const inputs = document.querySelectorAll('.apon-input[data-rec="'+recId+'"]');
  let dayTotal = 0;
  inputs.forEach(function(inp){ dayTotal += parseInt(inp.value)||0; });

  const dayEl = document.getElementById('apon-dayqty-'+recId);
  if(dayEl) dayEl.textContent = dayTotal||'—';

  const overall = entry.prevTotal + dayTotal;
  const needed = entry.needed;
  const isDone = overall >= needed;
  const pct = Math.min(100, Math.round(overall/needed*100));
  const barColor = isDone?'var(--green)':pct>=60?'var(--cyan)':'var(--warn)';

  const overallEl = document.getElementById('apon-overall-'+recId);
  if(overallEl){ overallEl.textContent=overall; overallEl.style.color=isDone?'var(--green)':'var(--text)'; }
  const pctEl = document.getElementById('apon-pct-'+recId);
  if(pctEl){ pctEl.textContent=pct+'%'; pctEl.style.color=barColor; }
  const barEl = document.getElementById('apon-bar-'+recId);
  if(barEl){ barEl.style.width=pct+'%'; barEl.style.background=barColor; }
  const row = document.getElementById('prod-row-'+recId);
  if(row){
    row.style.background = isDone?'rgba(41,217,132,.06)':'';
    row.style.borderLeft = isDone?'3px solid var(--green)':'';
  }

  // Atualizar nome do produto na linha (cor verde se concluído)
  const prodNameEl = row ? row.querySelector('.col-prod > div:first-child') : null;
  if(prodNameEl) prodNameEl.style.color = isDone ? 'var(--green)' : 'var(--text)';

  // Atualizar nota de conclusão
  const doneNoteId = 'done-note-'+recId;
  let doneNoteEl = document.getElementById(doneNoteId);
  if(isDone && !doneNoteEl && row){
    const prodCell = row.querySelector('.col-prod');
    if(prodCell){
      const note = document.createElement('div');
      note.id = doneNoteId;
      note.style.cssText = 'font-size:9px;color:var(--green);margin-top:2px;font-weight:700';
      note.textContent = '✓ Concluído';
      prodCell.appendChild(note);
    }
  } else if(!isDone && doneNoteEl){
    doneNoteEl.remove();
  }
}

function prodSaveAll(){
  const body = document.getElementById('apon-body');
  const dateVal = body._dateVal || prodSelectedDate;
  if(!dateVal || dateVal==='semana'){ toast('Selecione um dia para salvar','err'); return; }
  if(!body._machineGroups||!body._machineGroups.length){ toast('Nenhum produto para salvar','err'); return; }

  let saved = 0;
  for(let gi=0;gi<body._machineGroups.length;gi++){
    const items = body._machineGroups[gi].items;
    for(let ii=0;ii<items.length;ii++){
      const rec = items[ii].rec;
      const data = {};
      APON_HOURS.forEach(function(h){
        const inp = document.querySelector('.apon-input[data-rec="'+rec.id+'"][data-hr="'+h+'"]');
        data[h] = inp?(parseInt(inp.value)||0):0;
      });
      if(aponStorageSet(aponKey(dateVal,rec.id),data)) saved++;
      else{ toast('Erro ao salvar','err'); return; }
    }
  }
  toast(saved+' produto(s) salvo(s)!','ok');
  renderProdDayTabs();
  renderApontamento();
}


// ====== SETTINGS ======
let funcionarios = JSON.parse(localStorage.getItem('cfg_funcionarios')||'[]');
// DAY_HRS_USER: overrides DAY_HRS when set (index 0=Dom,1=Seg,...6=Sab)
const DEFAULT_DAY_HRS = [0,9,9,9,9,8,0];
let userDayHrs = JSON.parse(localStorage.getItem('cfg_day_hrs')||'null') || [...DEFAULT_DAY_HRS];
// Apply overrides to DAY_HRS at startup
(function applyDayHrs(){
  for(let i=0;i<7;i++) DAY_HRS[i]=userDayHrs[i]||0;
})();

function toggleHdMenu(){
  const dd=document.getElementById('hd-menu-dropdown');
  const btn=document.getElementById('hd-menu-btn');
  if(!dd||!btn) return;
  const isHidden=dd.style.display==='none'||dd.style.display==='';
  // Remove handler pendente para evitar acúmulo
  document.removeEventListener('click',closeHdMenuOutside);
  if(isHidden){
    const rect=btn.getBoundingClientRect();
    dd.style.top=(rect.bottom+4)+'px';
    dd.style.right=(window.innerWidth-rect.right)+'px';
    dd.style.left='auto';
    dd.style.display='block';
    // Dois requestAnimationFrame garantem que o click atual já passou
    requestAnimationFrame(()=>{
      requestAnimationFrame(()=>{
        document.addEventListener('click',closeHdMenuOutside);
      });
    });
  } else {
    dd.style.display='none';
  }
}
function closeHdMenuOutside(e){
  const dd=document.getElementById('hd-menu-dropdown');
  const btn=document.getElementById('hd-menu-btn');
  if(!dd) return;
  // Se clicou no próprio botão, deixa o toggleHdMenu tratar
  if(btn&&(btn===e.target||btn.contains(e.target))) return;
  dd.style.display='none';
  document.removeEventListener('click',closeHdMenuOutside);
}

function openSettings(){
  if(!canAccess('configuracoes')){ toast('Acesso negado: sem permissão para Configurações.','err'); return; }
  const dd=document.getElementById('hd-menu-dropdown')||document.getElementById('topbar-menu');
  if(dd) dd.style.display='none';
  const tm=document.getElementById('topbar-menu');
  if(tm) tm.classList.remove('on');
  const sp=document.getElementById('settings-page');
  sp.style.display='flex';
  renderCadastroMaquinas();
  renderProdutosCfg();
  renderFuncionariosProducao();
  renderJornadaDays();
  // Renderiza config de turnos por máquina
  if(typeof renderTurnosMaquinas === 'function'){
    renderTurnosMaquinas(MAQUINAS);
  }
  // Mostra/oculta abas conforme perfil
  const snavFunc = document.getElementById('snav-funcionarios');
  const snavUsuarios = document.getElementById('snav-usuarios');
  if(snavFunc) snavFunc.style.display = can('funcionarios','visualizar') ? '' : 'none';
  if(snavUsuarios) snavUsuarios.style.display = can('usuarios','visualizar') ? '' : 'none';
  settingsNav('cadastro-maquinas');
  setTimeout(()=>{ if(typeof renderApiSync==='function') renderApiSync(); }, 50);
}
function closeSettings(){
  const sp=document.getElementById('settings-page');
  sp.style.display='none';
}

function toggleSnavGroup(group){
  const submenu = document.getElementById('snav-'+group+'-submenu');
  const chevron = document.getElementById('snav-'+group+'-chevron');
  if (!submenu) return;
  // Usa data-open como fonte da verdade para evitar conflito com display:flex vs display:none
  const isOpen = submenu.dataset.open === 'true';
  if (isOpen) {
    submenu.style.display = 'none';
    submenu.dataset.open = 'false';
    if (chevron) chevron.style.transform = 'rotate(0deg)';
  } else {
    submenu.style.display = 'flex';
    submenu.dataset.open = 'true';
    if (chevron) chevron.style.transform = 'rotate(180deg)';
  }
}

function settingsNav(section){
  // Esconde todos os conteúdos
  document.querySelectorAll('.scontent').forEach(el=>{
    el.style.display='none';
  });
  // Remove active de todos os botões nav (mas NÃO os group-btns de container)
  document.querySelectorAll('.snav-btn').forEach(btn=>{
    btn.classList.remove('snav-active');
    if (!btn.id || !btn.id.endsWith('-group-btn')) {
      btn.style.background='none';
      btn.style.border='1px solid transparent';
      btn.style.color='var(--text2)';
      btn.style.fontSize='';
    }
  });
  // Mostra a seção correta
  const content=document.getElementById('scontent-'+section);
  if(content) content.style.display='flex';
  // Ativa o botão nav correspondente
  const navBtn=document.getElementById('snav-'+section);
  if(navBtn){
    navBtn.classList.add('snav-active');
    navBtn.style.background='rgba(0,212,255,.1)';
    navBtn.style.border='1px solid rgba(0,212,255,.25)';
    navBtn.style.color='var(--cyan)';
  }

  // ── Grupo Máquinas ──
  const maqGroupSections=['cadastro-maquinas','turnos','setup-maquinas'];
  const maqGroupBtn=document.getElementById('snav-maquinas-group-btn');
  const maqSubmenu=document.getElementById('snav-maquinas-submenu');
  const maqChevron=document.getElementById('snav-maquinas-chevron');
  if(maqGroupBtn){
    if(maqGroupSections.includes(section)){
      maqGroupBtn.style.background='rgba(0,212,255,.1)';
      maqGroupBtn.style.border='1px solid rgba(0,212,255,.25)';
      maqGroupBtn.style.color='var(--cyan)';
      // Garante submenu aberto
      if(maqSubmenu){ maqSubmenu.style.display='flex'; maqSubmenu.dataset.open='true'; }
      if(maqChevron) maqChevron.style.transform='rotate(180deg)';
    } else {
      maqGroupBtn.style.background='none';
      maqGroupBtn.style.border='1px solid transparent';
      maqGroupBtn.style.color='var(--text2)';
    }
  }

  // ── Grupo Produtos ──
  const prodGroupSections=['produtos','ficha-tecnica-cfg'];
  const prodGroupBtn=document.getElementById('snav-produtos-group-btn');
  const prodSubmenu=document.getElementById('snav-produtos-submenu');
  const prodChevron=document.getElementById('snav-produtos-chevron');
  if(prodGroupBtn){
    if(prodGroupSections.includes(section)){
      prodGroupBtn.style.background='rgba(0,212,255,.1)';
      prodGroupBtn.style.border='1px solid rgba(0,212,255,.25)';
      prodGroupBtn.style.color='var(--cyan)';
      // Abre submenu de produtos automaticamente
      if(prodSubmenu){ prodSubmenu.style.display='flex'; prodSubmenu.dataset.open='true'; }
      if(prodChevron) prodChevron.style.transform='rotate(180deg)';
    } else {
      prodGroupBtn.style.background='none';
      prodGroupBtn.style.border='1px solid transparent';
      prodGroupBtn.style.color='var(--text2)';
    }
  }

  // ── Renders por seção ──
  if(section==='importacao') setTimeout(()=>{ if(typeof renderApiSync==='function') renderApiSync(); }, 50);
  if(section==='usuarios') setTimeout(()=>renderUsuariosSistema(), 50);
  if(section==='funcionarios') setTimeout(()=>renderFuncionariosProducao(), 50);
  if(section==='turnos') setTimeout(()=>{ if(typeof renderTurnosMaquinas==='function') renderTurnosMaquinas(MAQUINAS); }, 50);
  if(section==='cadastro-maquinas') setTimeout(()=>renderCadastroMaquinas(), 50);
  if(section==='setup-maquinas') setTimeout(()=>renderSetupMaquinas(), 50);
  if(section==='ficha-tecnica-cfg') setTimeout(()=>renderFichaTecnicaCfg(), 50);
  if(section==='produtos') setTimeout(()=>renderProdutosCfg(), 50);
}

function handleImportZip(file){
  if(!file) return;
  if(!file.name.endsWith('.zip')){ toast('Selecione um arquivo .zip','err'); return; }
  const statusEl=document.getElementById('importzip-status');
  statusEl.style.display='block';
  statusEl.innerHTML='<div style="font-size:12px;color:var(--warn)">🔄 Processando arquivo ZIP...</div>';
  const reader=new FileReader();
  reader.onload=async function(e){
    try{
      // Verifica se JSZip está disponível
      if(typeof JSZip==='undefined'){
        statusEl.innerHTML='<div style="font-size:12px;color:var(--red)">❌ Biblioteca JSZip não disponível. Certifique-se que JSZip está incluído no projeto.</div>';
        return;
      }
      const zip=await JSZip.loadAsync(e.target.result);
      const files=Object.keys(zip.files);
      // Procura por arquivo JSON de backup dentro do ZIP
      const jsonFile=files.find(f=>f.endsWith('.json')&&!zip.files[f].dir);
      if(!jsonFile){
        statusEl.innerHTML='<div style="font-size:12px;color:var(--red)">❌ Nenhum arquivo JSON de backup encontrado no ZIP.</div>';
        return;
      }
      const jsonStr=await zip.files[jsonFile].async('string');
      const backup=JSON.parse(jsonStr);
      if(!backup||typeof backup!=='object'){
        statusEl.innerHTML='<div style="font-size:12px;color:var(--red)">❌ Arquivo de backup inválido.</div>';
        return;
      }
      const entries=Object.keys(backup).filter(k=>k!=='exportadoEm');
      statusEl.innerHTML=`<div style="font-size:12px;color:var(--green)">✅ ZIP lido com sucesso!<br>Arquivo: <strong>${jsonFile}</strong><br>Coleções encontradas: ${entries.join(', ')}<br><br><span style="color:var(--text2)">Funcionalidade de restauração completa requer integração com o Firestore.</span></div>`;
      toast('ZIP importado: '+entries.length+' coleções encontradas','ok');
    }catch(err){
      statusEl.innerHTML='<div style="font-size:12px;color:var(--red)">❌ Erro ao processar ZIP: '+err.message+'</div>';
      toast('Erro ao importar ZIP','err');
    }
  };
  reader.readAsArrayBuffer(file);
}


// ── Cadastro: Máquinas (Firestore) ──
async function carregarMaquinasFirestore() {
  try {
    const snap = await getDocs(query(collection(firestoreDB, 'maquinas'), orderBy('nome')));
    MAQUINAS = [];
    window.MAQUINAS_DATA = {};
    if (!snap.empty) {
      snap.docs.forEach(d => {
        const data = d.data();
        if (data.nome) {
          MAQUINAS.push(data.nome);
          window.MAQUINAS_DATA[data.nome] = { ...data, _id: d.id };
        }
      });
      MAQUINAS.sort();
      console.log('[MAQUINAS] Carregadas do Firestore:', MAQUINAS.length);
    } else {
      console.warn('[MAQUINAS] Nenhuma máquina cadastrada no Firestore. Cadastre em Configurações → Máquinas.');
    }
  } catch(e) {
    console.warn('[MAQUINAS] Erro ao carregar do Firestore:', e.message);
    MAQUINAS = [];
    window.MAQUINAS_DATA = {};
  }
}

// Retorna dados completos de uma máquina pelo nome
function getMaquinaData(nome) {
  return (window.MAQUINAS_DATA || {})[nome] || null;
}

// Helper: retorna lista atual de máquinas (sempre do Firestore, nunca estático)
function getAllMaquinas() { return MAQUINAS; }

// Calcula capacidade produtiva de uma máquina
function calcCapacidadeMaquina(pcMin, efic, hTurno, nTurnos) {
  const ef = parseFloat(efic) || 100;
  const ht = parseFloat(hTurno) || 8;
  const nt = parseInt(nTurnos) || 1;
  const fator = ef / 100;
  const porHora = Math.round(pcMin * 60 * fator);
  const porTurno = Math.round(porHora * ht);
  const porDia = porTurno * nt;
  return { porHora, porTurno, porDia };
}

// Retorna pc_min efetivo de uma máquina para um produto específico
function getPcMinMaquinaProduto(nomeMaq, nomeProduto) {
  const maq = getMaquinaData(nomeMaq);
  if (!maq) return null;
  if (maq.produtosCompativeis && nomeProduto) {
    const entry = maq.produtosCompativeis.find(p => p.produto === nomeProduto || nomeProduto.startsWith(p.produto));
    if (entry && entry.velocidade) return parseFloat(entry.velocidade);
  }
  return maq.pcMin ? parseFloat(maq.pcMin) : null;
}

async function salvarMaquinaFirestore(dados) {
  const nomeUp = (dados.nome || '').trim().toUpperCase();
  if (!nomeUp) return;
  const snap = await getDocs(collection(firestoreDB, 'maquinas'));
  const existe = snap.docs.find(d => (d.data().nome||'').toUpperCase() === nomeUp && d.id !== dados._id);
  if (existe) { toast('Máquina já cadastrada!', 'err'); return; }
  const payload = {
    nome: nomeUp,
    codigo: (dados.codigo||'').trim(),
    tipo: (dados.tipo||'').trim(),
    setor: (dados.setor||'').trim(),
    status: dados.status || 'ativa',
    pcMin: parseFloat(dados.pcMin) || 0,
    eficiencia: parseFloat(dados.eficiencia) || 100,
    hTurno: parseFloat(dados.hTurno) || 8,
    nTurnos: parseInt(dados.nTurnos) || 1,
    tempoSetupPadrao: parseFloat(dados.tempoSetupPadrao) || 0,
    produtosCompativeis: dados.produtosCompativeis || [],
    atualizadoEm: new Date().toISOString()
  };
  if (dados._id) {
    await setDoc(doc(firestoreDB, 'maquinas', dados._id), { ...payload, criadoEm: dados.criadoEm || new Date().toISOString() });
    toast('Máquina "' + nomeUp + '" atualizada!', 'ok');
  } else {
    payload.criadoEm = new Date().toISOString();
    await addDoc(collection(firestoreDB, 'maquinas'), payload);
    toast('Máquina "' + nomeUp + '" cadastrada!', 'ok');
  }
  await carregarMaquinasFirestore();
  renderCadastroMaquinas();
}

async function excluirMaquinaFirestore(nome) {
  try {
    const snap = await getDocs(collection(firestoreDB, 'maquinas'));
    const found = snap.docs.find(d => d.data().nome === nome);
    if (found) {
      await deleteDoc(doc(firestoreDB, 'maquinas', found.id));
      await carregarMaquinasFirestore();
      renderCadastroMaquinas();
      toast('Máquina removida!', 'ok');
    }
  } catch(e) { toast('Erro ao remover: ' + e.message, 'err'); }
}

function renderCadastroMaquinas() {
  const tbody = document.getElementById('cadastro-maquinas-lista');
  const empty = document.getElementById('cadastro-maquinas-empty');
  if (!tbody) return;
  if (!MAQUINAS.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = MAQUINAS.map(m => {
    const d = getMaquinaData(m) || {};
    const cap = d.pcMin ? calcCapacidadeMaquina(d.pcMin, d.eficiencia, d.hTurno, d.nTurnos) : null;
    const statusBadge = d.status === 'inativa'
      ? '<span style="background:rgba(255,100,100,.15);color:#ff6b6b;border:1px solid rgba(255,100,100,.3);border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700">INATIVA</span>'
      : '<span style="background:rgba(0,212,100,.12);color:#00d46a;border:1px solid rgba(0,212,100,.3);border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700">ATIVA</span>';
    const capHora = cap ? cap.porHora.toLocaleString('pt-BR') + ' saq' : '<span style="color:var(--text3)">—</span>';
    const capDia = cap ? cap.porDia.toLocaleString('pt-BR') + ' saq' : '<span style="color:var(--text3)">—</span>';
    const tipoSetor = [d.tipo, d.setor].filter(Boolean).join(' / ') || '<span style="color:var(--text3)">—</span>';
    const nProds = Array.isArray(d.produtosCompativeis) ? d.produtosCompativeis.length : 0;
    const prodsBadge = nProds > 0
      ? `<span style="background:rgba(139,92,246,.15);color:var(--purple);border:1px solid rgba(139,92,246,.3);border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700">${nProds} prod.</span>`
      : `<span style="background:rgba(255,179,0,.1);color:var(--warn);border:1px solid rgba(255,179,0,.25);border-radius:4px;padding:2px 6px;font-size:10px">Sem produtos</span>`;
    const rowId = 'maq-detail-' + m.replace(/[^a-zA-Z0-9]/g,'_');
    let detailHtml = '';
    const capTurno = cap ? cap.porTurno.toLocaleString('pt-BR') + ' saq/turno' : '—';
    const setupPadrao = (d.tempoSetupPadrao && parseFloat(d.tempoSetupPadrao) > 0) ? parseFloat(d.tempoSetupPadrao) + ' min' : '—';
    const capSummary = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:8px 14px;background:rgba(0,212,255,.04);border-top:1px solid rgba(0,212,255,.12);font-size:11px;font-family:'JetBrains Mono',monospace">
      <div style="text-align:center"><div style="color:var(--text3);font-size:9px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px">Cap/hora</div><div style="color:var(--cyan);font-weight:700">${cap ? cap.porHora.toLocaleString('pt-BR') + ' saq' : '—'}</div></div>
      <div style="text-align:center"><div style="color:var(--text3);font-size:9px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px">Cap/turno</div><div style="color:var(--cyan);font-weight:700">${cap ? cap.porTurno.toLocaleString('pt-BR') + ' saq' : '—'}</div></div>
      <div style="text-align:center"><div style="color:var(--text3);font-size:9px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px">Cap/dia</div><div style="color:var(--cyan);font-weight:700">${cap ? cap.porDia.toLocaleString('pt-BR') + ' saq' : '—'}</div></div>
    </div>
    <div style="padding:4px 14px 6px;display:flex;gap:16px;font-size:11px;font-family:'JetBrains Mono',monospace;background:rgba(0,212,255,.04);border-bottom:1px solid rgba(0,212,255,.12)">
      <span><span style="color:var(--text3)">Efic:</span> <span style="color:var(--text2)">${d.eficiencia != null ? d.eficiencia + '%' : '—'}</span></span>
      <span><span style="color:var(--text3)">Turnos:</span> <span style="color:var(--text2)">${d.nTurnos || '—'}</span></span>
      <span><span style="color:var(--text3)">Hrs/turno:</span> <span style="color:var(--text2)">${d.hTurno || '—'}</span></span>
      <span><span style="color:var(--text3)">Setup padrão:</span> <span style="color:var(--text2)">${setupPadrao}</span></span>
    </div>`;
    if (nProds > 0) {
      const prodsRows = d.produtosCompativeis.map(p => {
        const vel = p.velocidade != null ? `<span style="color:var(--cyan);font-family:'JetBrains Mono',monospace">${p.velocidade} saq/min</span>` : `<span style="color:var(--text3)">padrão${d.pcMin ? ' (' + d.pcMin + ')' : ''}</span>`;
        return `<div style="display:grid;grid-template-columns:1fr auto;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px">
          <span style="color:var(--text2)">${p.produto}</span>
          <span>${vel}</span>
        </div>`;
      }).join('');
      detailHtml = capSummary + `<div style="padding:8px 14px;background:rgba(139,92,246,.05);border-top:1px solid rgba(139,92,246,.15)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--purple);font-weight:700;margin-bottom:8px;font-family:'JetBrains Mono',monospace">Produtos Compatíveis (${nProds})</div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.07)">
          <span style="font-size:10px;color:var(--text3);font-weight:700">PRODUTO</span>
          <span style="font-size:10px;color:var(--text3);font-weight:700">VELOCIDADE</span>
        </div>
        ${prodsRows}
      </div>`;
    } else {
      detailHtml = capSummary + `<div style="padding:10px 14px;background:rgba(255,179,0,.05);border-top:1px solid rgba(255,179,0,.2);font-size:12px;color:var(--warn)">
        ⚠️ Essa máquina ainda não possui produtos vinculados. Clique em <strong>Editar</strong> → aba <strong>Produtos Compatíveis</strong> para configurar.
      </div>`;
    }
    return `<tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--s2)'" onmouseout="this.style.background=''">
      <td style="padding:10px 14px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text1);font-weight:600">${m}${d.codigo ? `<span style="font-size:10px;color:var(--text3);font-weight:400;margin-left:6px">${d.codigo}</span>` : ''}</td>
      <td style="padding:10px 10px;font-size:12px;color:var(--text2)">${tipoSetor}</td>
      <td style="padding:10px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--warn)">${d.pcMin ? d.pcMin + ' pc/min' : '<span style="color:var(--text3)">—</span>'}</td>
      <td style="padding:10px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--cyan)">${capHora}</td>
      <td style="padding:10px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--cyan)">${capDia}</td>
      <td style="padding:10px 10px;text-align:center">${statusBadge}</td>
      <td style="padding:10px 10px;text-align:right">
        <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
          ${prodsBadge}
          <button class="btn btn-ghost" onclick="toggleMaqDetail('${rowId}')" style="padding:4px 8px;font-size:11px;color:var(--purple)" title="Ver produtos">▾</button>
          <button class="btn btn-ghost" onclick="openEditMaquina('${m.replace(/'/g,"\\'")}');" style="padding:4px 10px;font-size:11px;color:var(--cyan)">✏ Editar</button>
          <button class="btn btn-ghost" onclick="excluirMaquinaFirestore('${m.replace(/'/g,"\\'")}');" style="padding:4px 10px;font-size:11px;color:#ff6b6b">🗑</button>
        </div>
      </td>
    </tr>
    <tr id="${rowId}" style="display:none">
      <td colspan="7" style="padding:0">${detailHtml}</td>
    </tr>`;
  }).join('');
}

function toggleMaqDetail(rowId) {
  const el = document.getElementById(rowId);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}

// Estado do modal de máquina
let _maqProdsCompat = [];

function openAddMaquina() {
  _maqProdsCompat = [];
  document.getElementById('maq-edit-id').value = '';
  document.getElementById('maq-modal-title').textContent = 'Nova Máquina';
  document.getElementById('maq-nome-inp').value = '';
  document.getElementById('maq-cod-inp').value = '';
  document.getElementById('maq-tipo-inp').value = '';
  document.getElementById('maq-setor-inp').value = '';
  document.getElementById('maq-status-inp').value = 'ativa';
  document.getElementById('maq-pcmin-inp').value = '';
  document.getElementById('maq-efic-inp').value = '';
  document.getElementById('maq-hturno-inp').value = '';
  document.getElementById('maq-nturno-inp').value = '';
  const setupInpNew = document.getElementById('maq-setup-inp');
  if (setupInpNew) setupInpNew.value = '';
  document.getElementById('maq-pchora-inp').value = '';
  document.getElementById('maq-pcturno-inp').value = '';
  document.getElementById('maq-pcdia-inp').value = '';
  switchMaqTab('dados');
  populateMaqProdSel();
  renderMaqProdsLista();
  document.getElementById('maq-modal').style.display = 'flex';
  setTimeout(() => { const el = document.getElementById('maq-nome-inp'); if(el) el.focus(); }, 80);
}

function openEditMaquina(nome) {
  const d = getMaquinaData(nome) || {};
  _maqProdsCompat = Array.isArray(d.produtosCompativeis) ? JSON.parse(JSON.stringify(d.produtosCompativeis)) : [];
  document.getElementById('maq-edit-id').value = d._id || '';
  document.getElementById('maq-modal-title').textContent = 'Editar: ' + nome;
  document.getElementById('maq-nome-inp').value = d.nome || nome;
  document.getElementById('maq-cod-inp').value = d.codigo || '';
  document.getElementById('maq-tipo-inp').value = d.tipo || '';
  document.getElementById('maq-setor-inp').value = d.setor || '';
  document.getElementById('maq-status-inp').value = d.status || 'ativa';
  // Usar != null para não confundir 0 com vazio
  document.getElementById('maq-pcmin-inp').value = (d.pcMin != null && d.pcMin !== '') ? d.pcMin : '';
  document.getElementById('maq-efic-inp').value = (d.eficiencia != null && d.eficiencia !== '') ? d.eficiencia : '';
  document.getElementById('maq-hturno-inp').value = (d.hTurno != null && d.hTurno !== '') ? d.hTurno : '';
  document.getElementById('maq-nturno-inp').value = (d.nTurnos != null && d.nTurnos !== '') ? d.nTurnos : '';
  const setupInp = document.getElementById('maq-setup-inp');
  if (setupInp) setupInp.value = (d.tempoSetupPadrao != null && d.tempoSetupPadrao !== '') ? d.tempoSetupPadrao : '';
  calcMaqCapacidade();
  switchMaqTab('dados');
  populateMaqProdSel();
  renderMaqProdsLista();
  document.getElementById('maq-modal').style.display = 'flex';
}

function closeMaqModal() {
  document.getElementById('maq-modal').style.display = 'none';
}

function switchMaqTab(tab) {
  ['dados','cap','prods'].forEach(t => {
    const pane = document.getElementById('maq-pane-' + t);
    const btn = document.getElementById('maq-tab-' + t);
    if (pane) pane.style.display = t === tab ? (t === 'dados' ? 'grid' : 'flex') : 'none';
    if (btn) {
      btn.style.borderBottomColor = t === tab ? 'var(--cyan)' : 'transparent';
      btn.style.color = t === tab ? 'var(--cyan)' : 'var(--text3)';
    }
  });
}

function calcMaqCapacidade() {
  const pcMin = parseFloat(document.getElementById('maq-pcmin-inp').value) || 0;
  const efic = parseFloat(document.getElementById('maq-efic-inp').value) || 100;
  const hTurno = parseFloat(document.getElementById('maq-hturno-inp').value) || 8;
  const nTurnos = parseInt(document.getElementById('maq-nturno-inp').value) || 1;
  if (!pcMin) {
    ['maq-pchora-inp','maq-pcturno-inp','maq-pcdia-inp'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
    return;
  }
  const cap = calcCapacidadeMaquina(pcMin, efic, hTurno, nTurnos);
  const el1 = document.getElementById('maq-pchora-inp');
  const el2 = document.getElementById('maq-pcturno-inp');
  const el3 = document.getElementById('maq-pcdia-inp');
  if(el1) el1.value = cap.porHora.toLocaleString('pt-BR') + ' saq/h';
  if(el2) el2.value = cap.porTurno.toLocaleString('pt-BR') + ' saq/turno';
  if(el3) el3.value = cap.porDia.toLocaleString('pt-BR') + ' saq/dia';
}

function populateMaqProdSel() {
  const sel = document.getElementById('maq-prod-sel');
  if (!sel) return;
  const all = getAllProdutos ? getAllProdutos() : PRODUTOS;
  const unique = [...new Map(all.map(p => [p.descricao, p])).values()];
  sel.innerHTML = '<option value="">— Selecione um produto —</option>' +
    unique.slice(0, 300).map(p => `<option value="${p.descricao}">${p.cod ? p.cod + ' · ' : ''}${p.descricao}</option>`).join('');
}

function addMaqProdCompat() {
  const sel = document.getElementById('maq-prod-sel');
  const vel = document.getElementById('maq-prod-vel');
  const prod = sel ? sel.value : '';
  const velocidade = vel ? parseFloat(vel.value) : 0;
  if (!prod) { toast('Selecione um produto', 'err'); return; }
  const exists = _maqProdsCompat.findIndex(x => x.produto === prod);
  if (exists >= 0) {
    _maqProdsCompat[exists].velocidade = velocidade || null;
  } else {
    _maqProdsCompat.push({ produto: prod, velocidade: velocidade || null });
  }
  if (vel) vel.value = '';
  renderMaqProdsLista();
}

function removeMaqProdCompat(idx) {
  _maqProdsCompat.splice(idx, 1);
  renderMaqProdsLista();
}

function renderMaqProdsLista() {
  const el = document.getElementById('maq-prods-lista');
  if (!el) return;
  if (!_maqProdsCompat.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px 0">Nenhum produto configurado. Usará velocidade padrão para todos.</div>';
    return;
  }
  const pcPadrao = parseFloat((document.getElementById('maq-pcmin-inp')||{}).value) || null;
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:11px">
    <thead><tr style="background:var(--s2)">
      <th style="padding:6px 10px;text-align:left;color:var(--text3)">Produto</th>
      <th style="padding:6px 10px;text-align:right;color:var(--text3)">Velocidade (saq/min)</th>
      <th style="padding:6px 4px;text-align:right;color:var(--text3)"></th>
    </tr></thead>
    <tbody>` +
    _maqProdsCompat.map((p, i) => `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:6px 10px;color:var(--text1)">${p.produto}</td>
      <td style="padding:6px 10px;text-align:right;font-family:'JetBrains Mono',monospace;color:var(--cyan)">${p.velocidade != null ? p.velocidade : `<span style="color:var(--text3)">padrão${pcPadrao ? ' (' + pcPadrao + ')' : ''}</span>`}</td>
      <td style="padding:6px 4px;text-align:right"><button onclick="removeMaqProdCompat(${i})" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:12px">✕</button></td>
    </tr>`).join('') +
    '</tbody></table>';
}

async function saveMaquinaModal() {
  const nome = (document.getElementById('maq-nome-inp').value || '').trim();
  if (!nome) { toast('Informe o nome da máquina', 'err'); return; }

  const pcMinVal = parseFloat(document.getElementById('maq-pcmin-inp').value);
  const hTurnoVal = parseFloat(document.getElementById('maq-hturno-inp').value);
  const nTurnosVal = parseInt(document.getElementById('maq-nturno-inp').value);

  // Avisar sobre campos importantes sem bloquear — máquina pode ser salva sem velocidade,
  // mas o sistema não conseguirá calcular tempo de produção nem programação automática
  const avisos = [];
  if (!pcMinVal || pcMinVal <= 0) avisos.push('Velocidade padrão (saq/min) não informada — programação automática não funcionará para esta máquina.');
  if (!hTurnoVal || hTurnoVal <= 0) avisos.push('Horas por turno não informadas — assumirá 8h.');
  if (!nTurnosVal || nTurnosVal <= 0) avisos.push('Número de turnos não informado — assumirá 1 turno.');

  if (avisos.length) {
    const ok = confirm('⚠️ Atenção:\n\n' + avisos.join('\n') + '\n\nDeseja salvar mesmo assim?');
    if (!ok) { switchMaqTab('cap'); return; }
  }

  const dados = {
    _id: document.getElementById('maq-edit-id').value || null,
    nome,
    codigo: document.getElementById('maq-cod-inp').value || '',
    tipo: document.getElementById('maq-tipo-inp').value || '',
    setor: document.getElementById('maq-setor-inp').value || '',
    status: document.getElementById('maq-status-inp').value || 'ativa',
    pcMin: pcMinVal || 0,
    eficiencia: parseFloat(document.getElementById('maq-efic-inp').value) || 100,
    hTurno: hTurnoVal || 8,
    nTurnos: nTurnosVal || 1,
    tempoSetupPadrao: parseFloat((document.getElementById('maq-setup-inp')||{}).value) || 0,
    produtosCompativeis: _maqProdsCompat,
  };
  await salvarMaquinaFirestore(dados);
  closeMaqModal();
}

async function importarMaquinasExcel(file) {
  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const nomes = rows.flat().map(v => String(v||'').trim().toUpperCase()).filter(v => v && !['MÁQUINA','MAQUINA','NOME','NAME'].includes(v));
    if (!nomes.length) { toast('Nenhuma máquina encontrada!', 'err'); return; }
    const snap = await getDocs(collection(firestoreDB, 'maquinas'));
    const existentes = snap.docs.map(d => (d.data().nome||'').toUpperCase());
    let adicionadas = 0;
    for (const nome of nomes) {
      if (!existentes.includes(nome)) {
        await addDoc(collection(firestoreDB, 'maquinas'), { nome, status: 'ativa', pcMin: 0, eficiencia: 100, hTurno: 8, nTurnos: 1, produtosCompativeis: [], criadoEm: new Date().toISOString() });
        adicionadas++;
      }
    }
    await carregarMaquinasFirestore();
    renderCadastroMaquinas();
    toast(adicionadas + ' máquina(s) importada(s)!', 'ok');
  } catch(e) { toast('Erro ao importar: ' + e.message, 'err'); }
}

// Ficha Técnica no menu Configurações → Produtos
function renderFichaTecnicaCfg() {
  const search = (document.getElementById('ft-cfg-search') || {}).value || '';
  const el = document.getElementById('ft-cfg-list');
  const cnt = document.getElementById('ft-cfg-count');

  // Deduplica por desc (igual ao renderFichaTecnica)
  const seen = new Set();
  const deduped = [];
  fichaTecnicaData.forEach(p => {
    const key = p.desc.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(p);
  });

  if (cnt) cnt.textContent = deduped.length;
  if (!el) return;

  const filtered = search
    ? deduped.filter(p => p.desc.toLowerCase().includes(search.toLowerCase()) || String(p.cod).includes(search))
    : deduped;

  if (!filtered.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:13px">Nenhum produto encontrado.</div>';
    return;
  }

  el.innerHTML = filtered.slice(0, 150).map(p => {
    const safeDesc = p.desc.replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const insCount = (p.insumos||[]).length;
    const insHtml = insCount
      ? p.insumos.map(i => `
          <div style="display:grid;grid-template-columns:90px 1fr;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04);align-items:center">
            <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--cyan)">${i.qty > 0 ? i.qty.toFixed(i.qty < 0.01 ? 6 : i.qty < 1 ? 4 : 2) : '—'}</span>
            <span style="font-size:11px;color:var(--text2)">${i.insumo}</span>
          </div>`).join('')
      : '<div style="font-size:11px;color:var(--text3);padding:6px 0">Nenhum insumo cadastrado</div>';

    return `
    <div style="border-bottom:1px solid var(--border)">
      <div onclick="ftCfgToggle(this)" data-desc="${safeDesc}"
           style="padding:9px 14px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:background .15s"
           onmouseover="this.style.background='var(--s2)'" onmouseout="this.style.background=''">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <svg class="ft-cfg-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0;transition:transform .2s;color:var(--text3)"><polyline points="6 9 12 15 18 9"/></svg>
          <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--cyan);flex-shrink:0">${p.cod}</span>
          <span style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.desc}</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center;flex-shrink:0;margin-left:10px">
          <span style="font-size:11px;color:var(--warn);font-family:'JetBrains Mono',monospace">${p.pc_min} pc/min</span>
          <span style="font-size:10px;background:${insCount?'rgba(0,212,255,.1)':'var(--s2)'};border:1px solid ${insCount?'rgba(0,212,255,.2)':'var(--border)'};color:${insCount?'var(--cyan)':'var(--text3)'};padding:1px 7px;border-radius:20px">${insCount} insumo${insCount!==1?'s':''}</span>
        </div>
      </div>
      <div class="ft-cfg-panel" style="display:none;padding:10px 16px 12px 36px;background:rgba(0,0,0,.15)">
        <div style="margin-bottom:8px">${insHtml}</div>
        <button onclick="event.stopPropagation();editFichaByCod(this.dataset.cod)" data-cod="${p.cod}"
                style="background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.25);border-radius:6px;padding:5px 12px;font-size:11px;color:var(--cyan);cursor:pointer;font-family:'Space Grotesk',sans-serif;display:inline-flex;align-items:center;gap:6px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Editar insumos e quantidades
        </button>
      </div>
    </div>`;
  }).join('');
}

function ftCfgToggle(header) {
  const panel = header.nextElementSibling;
  const chevron = header.querySelector('.ft-cfg-chevron');
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
}


// ── Cadastro: Produtos (Firestore + localStorage) ──
let PRODUTOS_EXTRA = JSON.parse(localStorage.getItem('cfg_produtos') || '[]');
function saveExtraProdutos() { localStorage.setItem('cfg_produtos', JSON.stringify(PRODUTOS_EXTRA)); }

// Retorna todos os produtos: Firestore (PRODUTOS) + extras localStorage (PRODUTOS_EXTRA)
function getAllProdutos() { return [...PRODUTOS, ...PRODUTOS_EXTRA]; }

// Normaliza um documento Firestore de produto para o formato legado {cod, descricao, unid, pc_min, maquina}
function normalizeProdutoFirestore(data) {
  return {
    cod: data.cod || 0,
    descricao: data.nome || data.descricao || '',
    unid: parseInt(data.unid) || 1,
    pc_min: parseFloat(data.velocidadePadrao || data.pc_min) || 0,
    maquina: data.maquinaPadrao || data.maquina || '',
    kg_fd: data.kg_fd || 0,
    categoria: data.categoria || '',
    coberturaDias: data.coberturaDias || 0,
    estoqueMinimo: data.estoqueMinimo || 0,
    ativo: data.ativo !== false
  };
}

// Carrega produtos do Firestore e popula PRODUTOS
async function carregarProdutosFirestore() {
  try {
    const snap = await getDocs(collection(firestoreDB, 'produtos'));
    if (!snap.empty) {
      PRODUTOS = snap.docs
        .map(d => normalizeProdutoFirestore({ ...d.data(), _id: d.id }))
        .filter(p => p.ativo !== false && p.descricao);
      console.log('[PRODUTOS] Carregados do Firestore:', PRODUTOS.length);
    } else {
      console.log('[PRODUTOS] Nenhum produto no Firestore. Use Configurações → Produtos para importar.');
    }
  } catch(e) {
    console.warn('[PRODUTOS] Erro ao carregar do Firestore:', e.message);
  }
  // Recarregar fichaTecnicaData a partir do Firestore
  try {
    const snap2 = await getDocs(collection(firestoreDB, 'fichaTecnica'));
    if (!snap2.empty) {
      const ftArr = snap2.docs.map(d => d.data());
      FICHA_TECNICA = ftArr;
      fichaTecnicaData = JSON.parse(JSON.stringify(ftArr));
    }
  } catch(e) { /* ficha técnica opcional */ }
}

// Salva produto no Firestore e mantém vínculo bidirecional com a máquina
async function salvarProdutoFirestore(dados) {
  const payload = {
    cod: parseInt(dados.cod) || 0,
    nome: (dados.descricao || dados.nome || '').trim(),
    descricao: (dados.descricao || dados.nome || '').trim(),
    unid: parseInt(dados.unid) || 1,
    pc_min: parseFloat(dados.pc_min) || 0,
    velocidadePadrao: parseFloat(dados.pc_min) || 0,
    maquina: dados.maquina || '',
    maquinaPadrao: dados.maquina || '',
    kg_fd: 0,
    categoria: dados.categoria || '',
    coberturaDias: parseInt(dados.coberturaDias) || 0,
    estoqueMinimo: parseFloat(dados.estoqueMinimo) || 0,
    ativo: dados.ativo !== false,
    atualizadoEm: new Date().toISOString()
  };
  try {
    if (dados._id) {
      await setDoc(doc(firestoreDB, 'produtos', dados._id), { ...payload, criadoEm: dados.criadoEm || new Date().toISOString() });
    } else {
      payload.criadoEm = new Date().toISOString();
      await addDoc(collection(firestoreDB, 'produtos'), payload);
    }
    // Vínculo bidirecional: se o produto tem máquina definida, adiciona nos produtosCompativeis da máquina
    if (payload.maquina && payload.nome) {
      await _syncProdutoNaMaquina(payload.maquina, payload.nome, payload.velocidadePadrao);
    }
    await carregarProdutosFirestore();
  } catch(e) {
    toast('Erro ao salvar produto: ' + e.message, 'err');
  }
}

// Garante que um produto está listado nos produtosCompativeis de uma máquina
async function _syncProdutoNaMaquina(nomeMaq, nomeProduto, velocidade) {
  try {
    const snap = await getDocs(query(collection(firestoreDB, 'maquinas'), where('nome', '==', nomeMaq)));
    if (snap.empty) return; // máquina não cadastrada, não força
    const maqDoc = snap.docs[0];
    const maqData = maqDoc.data();
    const prods = Array.isArray(maqData.produtosCompativeis) ? [...maqData.produtosCompativeis] : [];
    const exists = prods.findIndex(p => p.produto === nomeProduto);
    if (exists >= 0) return; // já está vinculado
    prods.push({ produto: nomeProduto, velocidade: velocidade || null });
    await setDoc(doc(firestoreDB, 'maquinas', maqDoc.id), { ...maqData, produtosCompativeis: prods, atualizadoEm: new Date().toISOString() });
    await carregarMaquinasFirestore();
  } catch(e) {
    console.warn('[SYNC] Não foi possível sincronizar produto na máquina:', e.message);
  }
}

function renderProdutosCfg() {
  const filter = (document.getElementById('prod-search-cfg') || {}).value || '';
  const el = document.getElementById('prod-list');
  const cnt = document.getElementById('prod-count');
  const all = getAllProdutos();
  if (cnt) cnt.textContent = all.length;
  if (!el) return;
  const filtered = filter ? all.filter(p => p.descricao.toLowerCase().includes(filter.toLowerCase()) || String(p.cod).includes(filter)) : all;
  if (!filtered.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:13px">Nenhum produto encontrado.</div>';
    return;
  }
  // Agrupa por descrição para listar todas as máquinas de cada produto
  const byDesc = new Map();
  filtered.forEach(p => {
    const key = p.descricao.trim().toLowerCase();
    if (!byDesc.has(key)) byDesc.set(key, { ...p, maquinas: [] });
    byDesc.get(key).maquinas.push(p.maquina);
  });
  const groups = [...byDesc.values()];

  el.innerHTML = groups.slice(0, 200).map(p => {
    const isExtra = PRODUTOS_EXTRA.findIndex(x => x.descricao === p.descricao) >= 0;
    const maqTags = p.maquinas.map(m =>
      `<span style="font-size:10px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);color:var(--cyan);padding:2px 8px;border-radius:20px;white-space:nowrap">${m}</span>`
    ).join('');
    return `
    <div style="padding:9px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--cyan);flex-shrink:0">${p.cod}</span>
          <span style="font-size:12px;color:var(--text)">${p.descricao}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap">
          <span style="font-size:10px;color:var(--warn);font-family:'JetBrains Mono',monospace">${p.pc_min} pc/min</span>
          <span style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace">${p.unid}un/cx</span>
          <span style="color:var(--text3);font-size:10px">·</span>
          ${maqTags}
        </div>
      </div>
      ${isExtra ? `<button onclick="deleteExtraProduto(${p.cod},'${p.maquina.replace(/'/g,"\\'")}','${p.descricao.replace(/'/g,"\\'")}')" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:11px;color:#ff6b6b;cursor:pointer;flex-shrink:0">🗑</button>` : '<span style="font-size:10px;color:var(--text3);flex-shrink:0">padrão</span>'}
    </div>`;
  }).join('');
  if (groups.length > 200) el.innerHTML += `<div style="padding:12px;color:var(--text3);font-size:12px">... e mais ${groups.length - 200} produtos.</div>`;
}

function openAddProduto() {
  const sel = document.getElementById('pm-maq');
  if (sel) sel.innerHTML = MAQUINAS.map(m => `<option value="${m}">${m}</option>`).join('');
  ['pm-cod','pm-desc','pm-unid','pm-pcmin'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('prod-modal').style.display = 'flex';
  setTimeout(() => { const el = document.getElementById('pm-cod'); if(el) el.focus(); }, 80);
}
function closeProdModal() { document.getElementById('prod-modal').style.display = 'none'; }
function saveProdModal() {
  const cod = parseInt(document.getElementById('pm-cod').value);
  const desc = document.getElementById('pm-desc').value.trim();
  const unid = parseInt(document.getElementById('pm-unid').value);
  const pcmin = parseFloat(document.getElementById('pm-pcmin').value);
  const maq = document.getElementById('pm-maq').value;
  if (!cod || !desc || !unid || !pcmin || !maq) { toast('Preencha todos os campos', 'err'); return; }
  const dados = { cod, descricao: desc, unid, kg_fd: 0, pc_min: pcmin, maquina: maq };
  // Salva no Firestore (função assíncrona - não bloqueia)
  salvarProdutoFirestore(dados).then(() => {
    renderProdutosCfg();
    toast('Produto salvo!', 'ok');
  }).catch(() => {
    // Fallback: salva no localStorage para não perder dados
    PRODUTOS_EXTRA.push({ cod, descricao: desc, unid, kg_fd: 0, pc_min: pcmin, maquina: maq });
    saveExtraProdutos();
    renderProdutosCfg();
    toast('Produto adicionado (local)!', 'ok');
  });
  closeProdModal();
}
function deleteExtraProduto(cod, maq, desc) {
  const idx = PRODUTOS_EXTRA.findIndex(p => p.cod === cod && p.maquina === maq && p.descricao === desc);
  if (idx < 0) return;
  PRODUTOS_EXTRA.splice(idx, 1);
  saveExtraProdutos();
  renderProdutosCfg();
  toast('Produto removido', 'ok');
}
function importProdutosExcel(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const wb = XLSX.read(e.target.result, { type: 'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws);
      let added = 0, erros = 0;
      const promises = [];
      rows.forEach(row => {
        const cod = parseInt(row['cod'] || row['Cod'] || row['COD'] || 0);
        const desc = (row['descricao'] || row['nome'] || row['Descricao'] || row['DESCRICAO'] || '').toString().trim();
        const maq = (row['maquina'] || row['maquinaPadrao'] || row['Maquina'] || row['MAQUINA'] || '').toString().trim();
        const pcmin = parseFloat(row['pc_min'] || row['velocidadePadrao'] || row['PcMin'] || row['PC_MIN'] || 0);
        const unid = parseInt(row['unid'] || row['Unid'] || row['UNID'] || 0);
        const categoria = (row['categoria'] || row['Categoria'] || '').toString().trim();
        const coberturaDias = parseInt(row['coberturaDias'] || row['CobDias'] || 0);
        const estoqueMinimo = parseFloat(row['estoqueMinimo'] || row['EstMin'] || 0);
        if (!cod || !desc || !unid) { erros++; return; }
        const dados = { cod, descricao: desc, unid, kg_fd: 0, pc_min: pcmin, maquina: maq, categoria, coberturaDias, estoqueMinimo, ativo: true };
        promises.push(salvarProdutoFirestore(dados));
        added++;
      });
      await Promise.all(promises);
      await carregarProdutosFirestore();
      renderProdutosCfg();
      let msg = added + ' produto(s) importado(s)!';
      if (erros) msg += ' (' + erros + ' linha(s) ignoradas)';
      toast(msg, erros ? 'warn' : 'ok');
    } catch(err) { toast('Erro ao ler Excel: ' + err.message, 'err'); }
    input.value = '';
  };
  reader.readAsBinaryString(file);
}
function downloadProdTemplate(e) {
  e.preventDefault();
  const ws = XLSX.utils.aoa_to_sheet([
    ['cod','descricao','maquina','pc_min','unid','categoria','coberturaDias','estoqueMinimo'],
    [12345,'EXEMPLO PRODUTO 500G - CX 12','ALFATECK 14',28.05,12,'ESPECIARIA',15,100]
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Produtos');
  XLSX.writeFile(wb, 'template_produtos.xlsx');
}

// ── Funcionários ──
const DAY_MS=24*60*60*1000;

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIONÁRIOS DA PRODUÇÃO (cadastro administrativo, sem login)
// ══════════════════════════════════════════════════════════════════════════════
let _funcProd = []; // cache local

async function renderFuncionariosProducao(){
  if(!can('funcionarios','visualizar')){ return; }
  const el=document.getElementById('func-list');
  if(!el) return;
  el.innerHTML='<div style="padding:16px;color:var(--text3);font-size:12px">Carregando...</div>';
  _funcProd = await listarFuncionariosProducao();
  if(!_funcProd.length){
    el.innerHTML='<div style="padding:20px 22px;color:var(--text3);font-size:13px">Nenhum funcionário cadastrado.</div>';
    return;
  }
  const podeEditar = can('funcionarios','editar');
  const podeExcluir = can('funcionarios','excluir');
  const now=Date.now();
  el.innerHTML=_funcProd.map((f,i)=>{
    const isInactive = f.deactivatedUntil && new Date(f.deactivatedUntil).getTime()>now;
    const statusColor=isInactive?'var(--orange)':'var(--green)';
    const statusDot=isInactive?'🟠':'🟢';
    const statusLabel=isInactive?`Ausente até ${f.deactivatedUntil}`:'Ativo';
    const maquinasStr=Array.isArray(f.maquinas)&&f.maquinas.length?f.maquinas.join(', '):'—';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:13px 22px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--cyan),var(--purple));display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#000;flex-shrink:0">${(f.nome||'?').charAt(0).toUpperCase()}</div>
        <div>
          <div style="font-weight:600;font-size:13px;color:var(--text)">${f.nome||'—'}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">${f.setor||''} ${f.funcao?'· '+f.funcao:''} ${f.turno?'· Turno '+f.turno:''}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:1px">🏭 ${maquinasStr}</div>
          <div style="font-size:11px;color:${statusColor};margin-top:2px">${statusDot} ${statusLabel}${isInactive&&f.motivo?' · '+f.motivo:''}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${podeEditar?`<button onclick="openEditFuncProd('${f.id}')" style="background:var(--s2);border:1px solid var(--border);border-radius:7px;padding:6px 11px;font-size:12px;color:var(--text2);font-family:'Space Grotesk',sans-serif;cursor:pointer" title="Editar">✏️</button>`:''}
        ${podeEditar?isInactive
          ?`<button onclick="reativarFuncProd('${f.id}')" style="background:var(--green);color:#000;border:none;border-radius:7px;padding:6px 12px;font-size:12px;font-family:'Space Grotesk',sans-serif;font-weight:600;cursor:pointer">Reativar</button>`
          :`<button onclick="openDesativarFuncProd('${f.id}')" style="background:var(--s2);border:1px solid var(--border);border-radius:7px;padding:6px 12px;font-size:12px;color:var(--text2);font-family:'Space Grotesk',sans-serif;cursor:pointer">Desativar</button>`
        :''}
        ${podeExcluir?`<button onclick="excluirFuncProdUI('${f.id}','${(f.nome||'').replace(/'/g,"\\'")}'" style="background:none;border:1px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;color:var(--red);cursor:pointer" title="Excluir"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>`:''}
      </div>
    </div>`;
  }).join('');
}

function _funcProdFormHTML(f={}){
  const maqOpts=MAQUINAS.map(m=>`<option value="${m}" ${Array.isArray(f.maquinas)&&f.maquinas.includes(m)?'selected':''}>${m}</option>`).join('');
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div style="grid-column:1/-1">
        <label class="flbl">Nome completo *</label>
        <input class="finp" id="fp-nome" value="${f.nome||''}" placeholder="Ex: João Silva" style="width:100%;box-sizing:border-box;margin-top:6px">
      </div>
      <div>
        <label class="flbl">Setor</label>
        <input class="finp" id="fp-setor" value="${f.setor||''}" placeholder="Ex: Embalagem" style="width:100%;box-sizing:border-box;margin-top:6px">
      </div>
      <div>
        <label class="flbl">Função</label>
        <input class="finp" id="fp-funcao" value="${f.funcao||''}" placeholder="Ex: Operador de Máquina" style="width:100%;box-sizing:border-box;margin-top:6px">
      </div>
      <div>
        <label class="flbl">Turno</label>
        <select class="finp" id="fp-turno" style="width:100%;box-sizing:border-box;margin-top:6px">
          <option value="">Não definido</option>
          <option value="1" ${f.turno==='1'?'selected':''}>Turno 1</option>
          <option value="2" ${f.turno==='2'?'selected':''}>Turno 2</option>
          <option value="3" ${f.turno==='3'?'selected':''}>Turno 3</option>
          <option value="Integral" ${f.turno==='Integral'?'selected':''}>Integral</option>
        </select>
      </div>
      <div>
        <label class="flbl">Status</label>
        <select class="finp" id="fp-ativo" style="width:100%;box-sizing:border-box;margin-top:6px">
          <option value="true" ${f.ativo!==false?'selected':''}>Ativo</option>
          <option value="false" ${f.ativo===false?'selected':''}>Inativo</option>
        </select>
      </div>
      <div style="grid-column:1/-1">
        <label class="flbl">Máquinas que pode operar</label>
        <select class="finp" id="fp-maquinas" multiple style="width:100%;box-sizing:border-box;margin-top:6px;height:90px">${maqOpts}</select>
        <div style="font-size:10px;color:var(--text3);margin-top:3px">Segure Ctrl para selecionar várias</div>
      </div>
      <div style="grid-column:1/-1">
        <label class="flbl">Observações</label>
        <textarea class="finp" id="fp-obs" rows="2" placeholder="Informações adicionais..." style="width:100%;box-sizing:border-box;margin-top:6px;resize:vertical">${f.obs||''}</textarea>
      </div>
    </div>`;
}

let _fpEditId=null;
function openAddFuncProd(){
  if(!can('funcionarios','criar')){toast('Sem permissão para criar funcionário.','err');return;}
  _fpEditId=null;
  document.getElementById('func-modal-title').textContent='Novo Funcionário da Produção';
  document.getElementById('func-modal-body').innerHTML=_funcProdFormHTML();
  document.getElementById('func-modal').style.display='flex';
  setTimeout(()=>document.getElementById('fp-nome')?.focus(),80);
}

function openEditFuncProd(id){
  if(!can('funcionarios','editar')){toast('Sem permissão para editar.','err');return;}
  const f=_funcProd.find(x=>x.id===id);
  if(!f) return;
  _fpEditId=id;
  document.getElementById('func-modal-title').textContent='Editar Funcionário';
  document.getElementById('func-modal-body').innerHTML=_funcProdFormHTML(f);
  document.getElementById('func-modal').style.display='flex';
}

function closeFuncModal(){ document.getElementById('func-modal').style.display='none'; }

async function saveFuncModal(){
  const nome=(document.getElementById('fp-nome')?.value||'').trim();
  if(!nome){alert('Informe o nome.');return;}
  const sel=document.getElementById('fp-maquinas');
  const maquinas=sel?Array.from(sel.selectedOptions).map(o=>o.value):[];
  const dados={
    nome,
    setor:(document.getElementById('fp-setor')?.value||'').trim(),
    funcao:(document.getElementById('fp-funcao')?.value||'').trim(),
    turno:(document.getElementById('fp-turno')?.value||'').trim(),
    ativo:document.getElementById('fp-ativo')?.value!=='false',
    maquinas,
    obs:(document.getElementById('fp-obs')?.value||'').trim(),
    atualizadoEm:new Date().toISOString(),
  };
  try{
    await salvarFuncionarioProducao(dados,_fpEditId);
    document.getElementById('func-modal').style.display='none';
    await renderFuncionariosProducao();
    toast('Funcionário '+(dados.nome)+' salvo.','ok');
  }catch(e){alert('Erro ao salvar: '+e.message);}
}

function openDesativarFuncProd(id){
  const f=_funcProd.find(x=>x.id===id);
  if(!f) return;
  const today=new Date().toISOString().slice(0,10);
  document.getElementById('func-deactivate-body').innerHTML=`
    <div style="margin-bottom:16px;font-size:13px;color:var(--text2)">Desativar <strong style="color:var(--text)">${f.nome}</strong>.</div>
    <div class="frow full" style="margin-bottom:14px">
      <label class="flbl">Ausente até (data)</label>
      <input class="finp" type="date" id="deact-until" value="${today}" style="width:100%;box-sizing:border-box">
    </div>
    <div class="frow full">
      <label class="flbl">Motivo</label>
      <input class="finp" id="deact-motivo" placeholder="Ex: Férias, Atestado, Folga..." style="width:100%;box-sizing:border-box">
    </div>`;
  document.getElementById('func-deactivate-modal').style.display='flex';
  document.getElementById('func-deactivate-modal').dataset.funcid=id;
}
function closeFuncDeactivateModal(){ document.getElementById('func-deactivate-modal').style.display='none'; }
async function confirmDeactivate(){
  const id=document.getElementById('func-deactivate-modal').dataset.funcid;
  const until=(document.getElementById('deact-until')?.value||'').trim();
  const motivo=(document.getElementById('deact-motivo')?.value||'').trim();
  if(!until){alert('Informe a data.');return;}
  await salvarFuncionarioProducao({deactivatedUntil:until,motivo},id);
  document.getElementById('func-deactivate-modal').style.display='none';
  await renderFuncionariosProducao();
  toast('Funcionário desativado até '+until+'.','warn');
}
async function reativarFuncProd(id){
  await salvarFuncionarioProducao({deactivatedUntil:null,motivo:''},id);
  await renderFuncionariosProducao();
  toast('Funcionário reativado.','ok');
}
async function excluirFuncProdUI(id,nome){
  if(!confirm('Excluir '+nome+'?')) return;
  await excluirFuncionarioProducao(id);
  await renderFuncionariosProducao();
  toast(nome+' excluído.','ok');
}

// Compatibilidade com código legado
function renderFuncionarios(){ renderFuncionariosProducao(); }
function openAddFuncionario(){ openAddFuncProd(); }
function reactivateFuncionario(){ }
function deleteFuncionario(){ }

// ══════════════════════════════════════════════════════════════════════════════
// USUÁRIOS DO SISTEMA (com login Firebase Auth)
// ══════════════════════════════════════════════════════════════════════════════
let _usuariosSistema = [];

async function renderUsuariosSistema(){
  if(!can('usuarios','visualizar')){ return; }
  const el=document.getElementById('usuarios-list');
  if(!el) return;
  el.innerHTML='<div style="padding:16px;color:var(--text3);font-size:12px">Carregando...</div>';
  _usuariosSistema = await listarUsuariosSistema();
  if(!_usuariosSistema.length){
    el.innerHTML='<div style="padding:20px 22px;color:var(--text3);font-size:13px">Nenhum usuário cadastrado.</div>';
    return;
  }
  const podeEditar=can('usuarios','editar');
  const podeAdmin=can('usuarios','administrar');
  el.innerHTML=_usuariosSistema.map(u=>{
    const tipo=u.tipo||'usuario';
    const badge=perfilBadge(tipo);
    const statusDot=u.ativo?'🟢':'🔴';
    const statusLabel=u.ativo?'Ativo':'Inativo';
    const dtCriado = u.criadoEm ? new Date(u.criadoEm).toLocaleDateString('pt-BR') : '—';
    const dtSenha = u.ultimaAlteracaoSenhaEm ? new Date(u.ultimaAlteracaoSenhaEm).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}) : 'Nunca alterada';
    const dtReset = u.ultimoResetEnviadoEm ? new Date(u.ultimoResetEnviadoEm).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}) : 'Nunca';
    const modLabel = tipo==='admin' ? 'Acesso total' : (() => {
      const perms = u.permissoes||{};
      const ativos = MODULOS.filter(m=>perms[m.key]).map(m=>m.label);
      return ativos.length ? ativos.join(', ') : 'Sem módulos liberados';
    })();
    return `<div style="padding:13px 22px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div style="display:flex;align-items:center;gap:12px;min-width:0">
          <div style="width:36px;height:36px;border-radius:50%;background:${tipo==='admin'?'#e74c3c':'var(--cyan)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:${tipo==='admin'?'#fff':'#000'};flex-shrink:0">${(u.nome||u.email||'?')[0].toUpperCase()}</div>
          <div style="min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap">
              <span style="font-weight:600;font-size:13px;color:var(--text)">${u.nome||'—'}</span>
              ${badge}
            </div>
            <div style="font-size:11px;color:var(--text3)">${u.email||''} ${u.cargo?'· '+u.cargo:''}</div>
            <div style="font-size:11px;color:${u.ativo?'var(--green)':'var(--red)'};margin-top:2px">${statusDot} ${statusLabel} · Criado em ${dtCriado}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:2px">📋 ${modLabel}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:1px">🔑 Senha alterada: ${dtSenha} · Reset enviado: ${dtReset}</div>
          </div>
        </div>
        ${podeEditar?`<div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
          <button onclick="openEditUsuario('${u.uid}')" style="background:var(--s2);border:1px solid var(--border);border-radius:7px;padding:6px 11px;font-size:12px;color:var(--text2);cursor:pointer" title="Editar">✏️</button>
          ${podeAdmin?`<button onclick="adminEnviarResetUI('${u.email}','${(u.nome||'').replace(/'/g,"\'")}')" style="background:rgba(242,101,34,.1);border:1px solid rgba(242,101,34,.3);border-radius:7px;padding:6px 11px;font-size:11px;color:var(--cyan);cursor:pointer" title="Forçar redefinição de senha">🔑 Reset</button>`:''}
          <button onclick="toggleUsuarioAtivo('${u.uid}',${!u.ativo})" style="background:${u.ativo?'var(--s2)':'rgba(46,204,113,.15)'};border:1px solid var(--border);border-radius:7px;padding:6px 12px;font-size:12px;color:${u.ativo?'var(--text2)':'var(--green)'};font-family:'Space Grotesk',sans-serif;cursor:pointer">${u.ativo?'Desativar':'Ativar'}</button>
          ${podeAdmin?`<button onclick="confirmarExcluirUsuario('${u.uid}','${(u.nome||u.email||'').replace(/'/g,"\\'")}')" style="background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.35);border-radius:7px;padding:6px 11px;font-size:12px;color:var(--red);cursor:pointer" title="Excluir usuário">🗑</button>`:''}
        </div>`:''}
      </div>
    </div>`;
  }).join('');
}


function _usuarioFormHTML(u={}){
  const tipo = u.tipo || 'usuario';
  const perms = u.permissoes || {};
  const checkboxes = MODULOS.map(m => `
    <label style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;background:var(--s2);border:1px solid ${perms[m.key]?'var(--cyan)':'var(--border)'};cursor:pointer;transition:border .15s" id="perm-lbl-${m.key}">
      <input type="checkbox" id="perm-${m.key}" ${perms[m.key]?'checked':''} onchange="_togglePermBorder(this,'perm-lbl-${m.key}')" style="accent-color:var(--cyan);width:14px;height:14px">
      <span style="font-size:12px;color:var(--text)">${m.label}</span>
    </label>`).join('');

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>
        <label class="flbl">Nome completo *</label>
        <input class="finp" id="us-nome" value="${u.nome||''}" placeholder="Ex: Maria Santos" style="width:100%;box-sizing:border-box;margin-top:6px">
      </div>
      <div>
        <label class="flbl">Cargo / Função</label>
        <input class="finp" id="us-cargo" value="${u.cargo||''}" placeholder="Ex: Supervisora" style="width:100%;box-sizing:border-box;margin-top:6px">
      </div>
      ${!u.uid?`<div>
        <label class="flbl">E-mail *</label>
        <input class="finp" id="us-email" type="email" value="${u.email||''}" placeholder="maria@empresa.com" style="width:100%;box-sizing:border-box;margin-top:6px">
      </div>
      <div>
        <label class="flbl">Senha *</label>
        <input class="finp" id="us-senha" type="password" placeholder="Mínimo 6 caracteres" style="width:100%;box-sizing:border-box;margin-top:6px">
      </div>`:`<div style="grid-column:1/-1">
        <label class="flbl">E-mail</label>
        <input class="finp" value="${u.email||''}" disabled style="width:100%;box-sizing:border-box;margin-top:6px;opacity:.5">
      </div>`}
      <div style="grid-column:1/-1">
        <label class="flbl">Tipo de Acesso *</label>
        <select class="finp" id="us-tipo" onchange="_togglePermsWrap(this.value)" style="width:100%;box-sizing:border-box;margin-top:6px">
          <option value="usuario" ${tipo!=='admin'?'selected':''}>Usuário — acesso manual por módulo</option>
          <option value="admin" ${tipo==='admin'?'selected':''}>Admin — acesso total automático</option>
        </select>
      </div>
      ${u.uid?`<div style="grid-column:1/-1">
        <label class="flbl">Status</label>
        <select class="finp" id="us-ativo" style="width:100%;box-sizing:border-box;margin-top:6px">
          <option value="true" ${u.ativo!==false?'selected':''}>Ativo</option>
          <option value="false" ${u.ativo===false?'selected':''}>Inativo</option>
        </select>
      </div>`:''}
    </div>
    <div id="us-perms-wrap" style="display:${tipo==='admin'?'none':'block'}">
      <label class="flbl" style="margin-bottom:8px;display:block">Módulos com acesso</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${checkboxes}
      </div>
    </div>`;
}

let _usEditUid=null;

function _togglePermsWrap(val){
  const w=document.getElementById('us-perms-wrap');
  if(w) w.style.display = val==='admin'?'none':'block';
}
function _togglePermBorder(cb, lblId){
  const lbl=document.getElementById(lblId);
  if(lbl) lbl.style.borderColor = cb.checked?'var(--cyan)':'var(--border)';
}
window._togglePermsWrap = _togglePermsWrap;
window._togglePermBorder = _togglePermBorder;

function openAddUsuario(){
  if(!can('usuarios','criar')){toast('Sem permissão para criar usuário.','err');return;}
  _usEditUid=null;
  document.getElementById('usuario-modal-title').textContent='Novo Usuário do Sistema';
  document.getElementById('usuario-modal-body').innerHTML=_usuarioFormHTML();
  document.getElementById('usuario-modal').style.display='flex';
  setTimeout(()=>document.getElementById('us-nome')?.focus(),80);
}

function openEditUsuario(uid){
  if(!can('usuarios','editar')){toast('Sem permissão para editar.','err');return;}
  const u=_usuariosSistema.find(x=>x.uid===uid);
  if(!u) return;
  _usEditUid=uid;
  document.getElementById('usuario-modal-title').textContent='Editar Usuário';
  document.getElementById('usuario-modal-body').innerHTML=_usuarioFormHTML(u);
  document.getElementById('usuario-modal').style.display='flex';
}

function closeUsuarioModal(){ document.getElementById('usuario-modal').style.display='none'; }

async function saveUsuarioModal(){
  const nome=(document.getElementById('us-nome')?.value||'').trim();
  const tipo=document.getElementById('us-tipo')?.value||'usuario';
  const cargo=(document.getElementById('us-cargo')?.value||'').trim();
  if(!nome){alert('Informe o nome.');return;}
  // Coleta permissões manuais (só relevante se tipo=usuario)
  const permissoes={};
  if(tipo!=='admin'){
    MODULOS.forEach(m=>{
      const cb=document.getElementById('perm-'+m.key);
      if(cb) permissoes[m.key]=cb.checked;
    });
  }
  try{
    if(!_usEditUid){
      const email=(document.getElementById('us-email')?.value||'').trim();
      const senha=document.getElementById('us-senha')?.value||'';
      if(!email){alert('Informe o e-mail.');return;}
      if(senha.length<6){alert('Senha deve ter ao menos 6 caracteres.');return;}
      await criarUsuarioSistema({email,senha,nome,tipo,cargo,permissoes});
      toast('Usuário '+nome+' criado com sucesso.','ok');
    } else {
      const ativo=document.getElementById('us-ativo')?.value!=='false';
      await atualizarUsuarioSistema(_usEditUid,{nome,tipo,cargo,ativo,permissoes});
      toast('Usuário '+nome+' atualizado.','ok');
    }
    document.getElementById('usuario-modal').style.display='none';
    await renderUsuariosSistema();
  }catch(e){
    alert('Erro: '+e.message);
  }
}

async function adminEnviarResetUI(email, nome){
  if(!can('usuarios','administrar')){toast('Sem permissão.','err');return;}
  if(!confirm(`Enviar e-mail de redefinição de senha para ${nome||email}?\n\nO usuário receberá um link para criar uma nova senha.`)) return;
  try {
    await adminForcaReset(email);
    toast(`E-mail de redefinição enviado para ${email}.`,'ok');
    await renderUsuariosSistema();
  } catch(e) {
    alert('Erro ao enviar reset: '+(e.message||e));
  }
}

async function toggleUsuarioAtivo(uid,ativo){
  await atualizarUsuarioSistema(uid,{ativo});
  await renderUsuariosSistema();
  toast(ativo?'Usuário ativado.':'Usuário desativado.', ativo?'ok':'warn');
}

async function confirmarExcluirUsuario(uid, nome){
  if(!can('usuarios','administrar')){ toast('Sem permissão para excluir usuário.','err'); return; }
  // Impede excluir a si mesmo
  const { currentUser: cu } = await import('./auth.js');
  if(cu && cu.uid === uid){ toast('Você não pode excluir sua própria conta.','err'); return; }
  if(!confirm(`⚠️ Excluir o usuário "${nome}"?\n\nEsta ação remove o perfil e permissões permanentemente.\nO acesso ao sistema será bloqueado imediatamente.\n\nEsta ação não pode ser desfeita.`)) return;
  try{
    await excluirUsuarioSistema(uid);
    toast(`Usuário "${nome}" excluído com sucesso.`,'ok');
    await renderUsuariosSistema();
  }catch(e){
    alert('Erro ao excluir usuário: '+(e.message||e));
  }
}

// ── Jornada de Trabalho ──
const DAY_LABELS=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

function renderJornadaDays(){
  const container=document.getElementById('jornada-days');
  let html='';
  for(let i=0;i<7;i++){
    const hrs=userDayHrs[i]||0;
    const active=hrs>0;
    const isWknd=(i===0||i===6);
    const dayColor=isWknd?'var(--amber)':'var(--cyan)';
    html+=`<div id="jornada-card-${i}" style="background:var(--s2);border:2px solid ${active?dayColor:'var(--border)'};border-radius:12px;padding:14px 10px;text-align:center;transition:border-color .2s,background .2s;${!active?'opacity:.6':''}">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${active?dayColor:'var(--text3)'};margin-bottom:10px">${DAY_LABELS[i]}${isWknd?'<span style="font-size:8px;display:block;color:var(--text3);margin-top:1px">fim de semana</span>':''}</div>
      <!-- Toggle on/off -->
      <div onclick="toggleJornadaDay(${i})" style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:42px;height:22px;border-radius:11px;background:${active?dayColor:'var(--s3)'};transition:background .2s;margin-bottom:10px;position:relative;flex-shrink:0">
        <div style="position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s;left:${active?'22px':'4px'}"></div>
      </div>
      <br>
      <input type="number" min="0" max="24" step="0.5" value="${hrs}" id="jornada-day-${i}"
        ${!active?'disabled':''}
        style="width:100%;background:var(--s1);border:1px solid var(--border);border-radius:6px;color:${active?'var(--text)':'var(--text3)'};font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:700;padding:8px 4px;text-align:center;box-sizing:border-box;transition:color .2s"
        oninput="updateJornadaStyle(${i},this.value)">
      <div id="jornada-info-${i}" style="font-size:10px;color:var(--text3);margin-top:6px">${active?hrs+'h':'desativado'}</div>
    </div>`;
  }
  container.innerHTML=html;
}

function toggleJornadaDay(i){
  const inp=document.getElementById('jornada-day-'+i);
  const currentHrs=parseFloat(inp.value)||0;
  const nowActive=currentHrs>0;
  if(nowActive){
    // Desativar — zera
    inp.value=0;
  } else {
    // Ativar — restaura padrão ou 8h
    const defaults=[0,9,9,9,9,8,0];
    inp.value=defaults[i]||8;
  }
  updateJornadaStyle(i,inp.value);
}

function updateJornadaStyle(i, val){
  const v=parseFloat(val)||0;
  const active=v>0;
  const isWknd=(i===0||i===6);
  const dayColor=isWknd?'var(--amber)':'var(--cyan)';
  const card=document.getElementById('jornada-card-'+i);
  const inp=document.getElementById('jornada-day-'+i);
  const info=document.getElementById('jornada-info-'+i);
  if(!card) return;
  card.style.borderColor=active?dayColor:'var(--border)';
  card.style.opacity=active?'1':'0.6';
  // toggle knob
  const toggle=card.querySelector('div[onclick]');
  if(toggle){
    toggle.style.background=active?dayColor:'var(--s3)';
    const knob=toggle.querySelector('div');
    if(knob) knob.style.left=active?'22px':'4px';
  }
  // label color
  const lbl=card.querySelector('div:first-child');
  if(lbl) lbl.style.color=active?dayColor:'var(--text3)';
  if(inp) inp.style.color=active?'var(--text)':'var(--text3)';
  if(info) info.textContent=active?v+'h':'desativado';
}

function saveJornada(){
  for(let i=0;i<7;i++){
    const v=parseFloat(document.getElementById('jornada-day-'+i)?.value)||0;
    userDayHrs[i]=v;
    DAY_HRS[i]=v; // applies immediately to scheduling
  }
  localStorage.setItem('cfg_day_hrs',JSON.stringify(userDayHrs));
  renderJornadaDays();
  // Refresh all schedule-dependent views
  if(ganttBaseMonday) renderGantt();
  if(typeof renderProduzido==='function' && prodBaseMonday) renderProduzido();
  if(insMaqMonday) renderInsumosMaq();
  toast('Jornada salva! Gantt e Realizado atualizados.','ok');
}

function resetJornada(){
  if(!confirm('Restaurar jornada padrão (Seg-Qui 9h, Sex 8h, Sáb-Dom 0h)?')) return;
  userDayHrs=[...DEFAULT_DAY_HRS];
  for(let i=0;i<7;i++) DAY_HRS[i]=userDayHrs[i];
  localStorage.removeItem('cfg_day_hrs');
  renderJornadaDays();
  if(ganttBaseMonday) renderGantt();
  toast('Jornada restaurada para o padrão.','ok');
}

// ===== FIREBASE AUTH BOOTSTRAP =====
function buildSidebar(user) {
  const nav = document.getElementById('sb-nav');
  if(!nav) return;

  // Todos os itens com módulo de permissão vinculado
  const allItems = [
    { tab:'dashboard',     icon:'📊', label:'Dashboard',          modulo:'dashboard' },
    { tab:'programacao',   icon:'📋', label:'Programação',        modulo:'programacao' },
    { tab:'maquinas',      icon:'🏭', label:'Máquinas',           modulo:'maquinas' },
    { tab:'gantt',         icon:'📅', label:'Prog. Visual',       modulo:'gantt' },
    { tab:'apontamento',   icon:'✅', label:'Realizado',          modulo:'realizado' },
    { tab:'insumos-maq',   icon:'🧪', label:'Insumos / Máq.',    modulo:'insumos_maq' },
    { tab:'insumos-geral', icon:'📦', label:'Insumos Geral',     modulo:'insumos_geral' },
    { tab:'calculos',      icon:'🤖', label:'Prog. Automática',  modulo:'calculos' },
    { tab:'projecao',      icon:'📈', label:'Projeção de Vendas',modulo:'projecao' },
    { tab:'ficha-tecnica', icon:'📄', label:'Ficha Técnica',     modulo:'ficha_tecnica' },
    { tab:'api-sync',      icon:'🔌', label:'Importação/API',    modulo:'importacao' },
    { tab:'funcionarios',  icon:'👷', label:'Funcionários',      modulo:'funcionarios' },
    { tab:'usuarios',      icon:'👥', label:'Usuários',          modulo:'usuarios' },
  ];

  // Filtra apenas os que o perfil pode visualizar
  const items = allItems.filter(it => canAccess(it.modulo));

  nav.innerHTML = items.map(it => `
    <div class="sb-item" id="sb-${it.tab}" onclick="switchTabSidebar('${it.tab}')">
      <span class="sb-icon">${it.icon}</span>
      <span class="sb-lbl">${it.label}</span>
    </div>
  `).join('');
}

function switchTabSidebar(name) {
  // Mapa de aba → módulo de permissão
  const moduloMap = {
    'dashboard':'dashboard','programacao':'programacao','maquinas':'maquinas',
    'gantt':'gantt','apontamento':'realizado','insumos-maq':'insumos_maq',
    'insumos-geral':'insumos_geral','calculos':'calculos','prog-auto':'calculos',
    'projecao':'projecao','ficha-tecnica':'ficha_tecnica','api-sync':'importacao'
  };
  const modulo = moduloMap[name];
  if (modulo && !canAccess(modulo)) {
    toast('Acesso negado: sem permissão para este módulo.','err');
    return;
  }
  // Update all panels
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
  // Cada aba abre seu próprio painel (prog-auto → panel-prog-auto)
  const panelId = name;
  const panel = document.getElementById('panel-' + panelId);
  if(panel) panel.classList.add('on');
  // Update sidebar active state
  document.querySelectorAll('.sb-item[id^="sb-"]').forEach(el => el.classList.remove('active'));
  const sbItem = document.getElementById('sb-' + name);
  if(sbItem) sbItem.classList.add('active');
  // Update topbar tab buttons (.tab-btn.on)
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('on'));
  // Match by tab name embedded in onclick attribute
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const oc = btn.getAttribute('onclick') || '';
    if(oc.includes("'" + name + "'") || oc.includes('"' + name + '"')) btn.classList.add('on');
  });
  // Update breadcrumb
  const bc = document.getElementById('tb-bc');
  const labels = {
    'dashboard':'Dashboard','programacao':'Programação','maquinas':'Máquinas',
    'gantt':'Prog. Visual','apontamento':'Realizado','insumos-maq':'Insumos / Máq.',
    'insumos-geral':'Insumos Geral','ficha-tecnica':'Ficha Técnica',
    'api-sync':'Importação/API','calculos':'Prog. Automática','projecao':'Projeção de Vendas'
  };
  if(bc) bc.innerHTML = `<span>PROGPROD MES</span> <span style="opacity:.4">/</span> <span class="cur">${labels[name]||name}</span>`;
  // Tab-specific renders
  if(name==='programacao') renderTable();
  if(name==='maquinas') renderMaquinas();
  if(name==='gantt') renderGantt();
  if(name==='apontamento'){ if(!prodBaseMonday) prodToday(); else renderProduzido(); }
  if(name==='insumos-maq') renderInsumosMaq();
  if(name==='insumos-geral') renderInsumosGeral();
  if(name==='ficha-tecnica') renderFichaTecnica();
  if(name==='api-sync') renderApiSync();
  if(name==='calculos'||name==='prog-auto') renderCalculos();
  if(name==='projecao') renderProjecao();
}

// Keep old switchTab for backward compatibility (called from tab buttons if any)
function switchTab(name, btn) { switchTabSidebar(name); }

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if(sb) sb.classList.toggle('col');
}

function toggleTopbarMenu() {
  const menu = document.getElementById('topbar-menu');
  if(menu) menu.classList.toggle('on');
}

// ===== LOGIN HANDLING =====
function handleLogin() {
  const email = document.getElementById('lf-email').value.trim();
  const pass  = document.getElementById('lf-pass').value;
  const btn   = document.getElementById('lf-btn');
  const errEl = document.getElementById('lf-error');
  errEl.className = 'lf-error';
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  login(email, pass)
    .catch(err => {
      btn.disabled = false;
      btn.textContent = 'Entrar';
      errEl.className = 'lf-error on';
      if(err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
        errEl.textContent = 'Email ou senha incorretos.';
      } else {
        errEl.textContent = 'Erro: ' + err.message;
      }
    });
}

// ===== ESQUECI MINHA SENHA =====
function openForgotPassword() {
  const modal = document.getElementById('forgot-modal');
  if (!modal) return;
  // Pré-preenche com o e-mail digitado no login, se houver
  const emailLogin = (document.getElementById('lf-email')?.value||'').trim();
  const input = document.getElementById('forgot-email');
  if (input && emailLogin) input.value = emailLogin;
  document.getElementById('forgot-result').className = 'forgot-result';
  document.getElementById('forgot-result').textContent = '';
  document.getElementById('forgot-send-btn').disabled = false;
  document.getElementById('forgot-send-btn').textContent = 'Enviar link';
  modal.style.display = 'flex';
  setTimeout(()=> input?.focus(), 80);
}

function closeForgotModal() {
  document.getElementById('forgot-modal').style.display = 'none';
}

async function submitForgotPassword() {
  const email = (document.getElementById('forgot-email')?.value||'').trim();
  const resultEl = document.getElementById('forgot-result');
  const btn = document.getElementById('forgot-send-btn');
  resultEl.className = 'forgot-result';
  resultEl.textContent = '';
  if (!email) {
    resultEl.className = 'forgot-result err';
    resultEl.textContent = 'Informe o e-mail cadastrado.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  try {
    await enviarResetSenha(email);
    resultEl.className = 'forgot-result ok';
    resultEl.innerHTML = `✅ <strong>E-mail enviado!</strong><br>
      Verifique a caixa de entrada de <strong>${email}</strong>.<br>
      Clique no link recebido para redefinir sua senha.<br>
      <span style="font-size:11px;opacity:.7">Não recebeu? Verifique a pasta de spam.</span>`;
    btn.textContent = 'Enviado ✓';
    btn.style.background = '#2ecc71';
    btn.style.color = '#000';
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Enviar link';
    resultEl.className = 'forgot-result err';
    if (e.code === 'sistema/email-nao-encontrado') {
      resultEl.textContent = '❌ E-mail não encontrado no sistema. Verifique se digitou corretamente.';
    } else if (e.code === 'auth/invalid-email') {
      resultEl.textContent = '❌ Formato de e-mail inválido.';
    } else if (e.code === 'auth/too-many-requests') {
      resultEl.textContent = '⚠️ Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    } else {
      resultEl.textContent = '❌ Erro ao enviar: ' + (e.message || 'tente novamente.');
    }
  }
}


document.addEventListener('DOMContentLoaded', () => {
  // Limpa credenciais da URL (email, senha, token, etc.)
  if (window.location.search || window.location.hash.includes('=')) {
    const clean = window.location.pathname;
    window.history.replaceState({}, document.title, clean);
  }

  const lsMsg = document.getElementById('ls-msg');
  const loadingScreen = document.getElementById('loading-screen');
  const loginScreen = document.getElementById('login-screen');
  const appDiv = document.getElementById('app');
  const loginBtn = document.getElementById('lf-btn');

  // Enable login button
  if(loginBtn) {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Entrar';
  }

  // Enter key on login form
  const passInput = document.getElementById('lf-pass');
  if(passInput) {
    passInput.addEventListener('keydown', e => { if(e.key === 'Enter') handleLogin(); });
  }
  const emailInput = document.getElementById('lf-email');
  if(emailInput) {
    emailInput.addEventListener('keydown', e => { if(e.key === 'Enter') handleLogin(); });
  }

  function onLoggedIn(user) {
    // Update sidebar user info
    const avEl = document.getElementById('sb-avatar');
    const unEl = document.getElementById('sb-uname');
    const urEl = document.getElementById('sb-urole');
    if(avEl) avEl.textContent = (user.nome||user.email||'?')[0].toUpperCase();
    if(unEl) unEl.textContent = user.nome || user.email;
    // Badge de perfil colorido
    if(urEl) urEl.innerHTML = perfilBadge(user.tipo || 'usuario');
    // Avatar color baseado no perfil
    if(avEl) {
      avEl.style.background = user.tipo==='admin' ? '#e74c3c' : 'var(--cyan)';
      avEl.style.color = user.tipo==='admin' ? '#fff' : '#000';
    }
    // Show app
    if(loadingScreen) loadingScreen.style.display = 'none';
    if(loginScreen) loginScreen.style.display = 'none';
    if(appDiv) appDiv.hidden = false;
    buildSidebar(user);
    appInit().then(() => {
      impLoadFromStorage();
      projLoadManual();
      switchTabSidebar('dashboard');
    });
  }

  function onLoggedOut() {
    if(loadingScreen) loadingScreen.style.display = 'none';
    if(loginScreen) loginScreen.style.display = 'flex';
    if(appDiv) appDiv.hidden = true;
  }

  initAuth(onLoggedIn, onLoggedOut);
});

// Expose globals for onclick handlers
window.switchTab = switchTab;
window.switchTabSidebar = switchTabSidebar;

// ===================================================================
// ===== IMPORTAÇÃO / API ============================================
// ===================================================================

// In-memory stores (persisted to localStorage)
let estoqueData       = [];   // [{cod, produto, estoque}]
let projecaoData      = [];   // [{cod, produto, venda_m1, venda_m2, venda_m3}]
let importHistorico   = [];   // [{ts, tipo, qtd, nome}]
let insumosEstoqueData= [];   // [{insumo, quantidade, unidade}] — estoque de MP/insumos (MRP)

function impLoadFromStorage(){
  try{ estoqueData        = JSON.parse(localStorage.getItem('imp_estoque')||'[]'); }catch(e){ estoqueData=[]; }
  try{ projecaoData       = JSON.parse(localStorage.getItem('imp_projecao')||'[]'); }catch(e){ projecaoData=[]; }
  try{ importHistorico    = JSON.parse(localStorage.getItem('imp_historico')||'[]'); }catch(e){ importHistorico=[]; }
  try{ insumosEstoqueData = JSON.parse(localStorage.getItem('imp_insumos_estoque')||'[]'); }catch(e){ insumosEstoqueData=[]; }
}
function impSaveEstoque()  { localStorage.setItem('imp_estoque',         JSON.stringify(estoqueData)); }
function impSaveProjecao() { localStorage.setItem('imp_projecao',        JSON.stringify(projecaoData)); }
function impSaveHistorico(){ localStorage.setItem('imp_historico',       JSON.stringify(importHistorico)); }
function impSaveInsumosEstoque(){ localStorage.setItem('imp_insumos_estoque', JSON.stringify(insumosEstoqueData)); }

// Retorna o estoque disponível de um insumo (busca por nome normalizado)
function getEstoqueInsumo(nomeInsumo){
  const norm = s => (s||'').toUpperCase().trim().replace(/\s+/g,' ');
  const ni = norm(nomeInsumo);
  const found = insumosEstoqueData.find(x => norm(x.insumo) === ni)
             || insumosEstoqueData.find(x => norm(x.insumo).includes(ni.substring(0,20)) || ni.includes(norm(x.insumo).substring(0,20)));
  return found ? (found.quantidade||0) : null; // null = não encontrado
}

function impAddHistorico(tipo, qtd, nome){
  importHistorico.unshift({ ts: new Date().toISOString(), tipo, qtd, nome });
  if(importHistorico.length > 50) importHistorico = importHistorico.slice(0, 50);
  impSaveHistorico();
}

function renderImportacao(){
  impLoadFromStorage();
  document.getElementById('imp-stat-estoque').textContent = estoqueData.length;
  document.getElementById('imp-stat-proj').textContent    = projecaoData.length;
  document.getElementById('imp-stat-hist').textContent    = importHistorico.length;
  const insStat = document.getElementById('imp-stat-insumos');
  if(insStat) insStat.textContent = insumosEstoqueData.length;
  const lastSync = importHistorico[0];
  document.getElementById('imp-stat-sync').textContent = lastSync
    ? new Date(lastSync.ts).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})
    : '—';
  const insStat2 = document.getElementById('imp-insumos-stat');
  if(insStat2 && insumosEstoqueData.length){
    insStat2.textContent = `✅ ${insumosEstoqueData.length} insumos no estoque`;
    insStat2.style.color = 'var(--green)';
  }
  renderHistoricoImportacao();
}

function renderHistoricoImportacao(){
  const el = document.getElementById('imp-historico-list');
  if(!el) return;
  if(!importHistorico.length){
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text3);font-size:13px">Nenhuma importação registrada ainda</div>';
    return;
  }
  el.innerHTML = importHistorico.map(h=>{
    const icon = h.tipo==='estoque'?'📦':h.tipo==='projecao'?'📈':h.tipo==='api'?'🔌':'📋';
    const typeLabel = h.tipo==='estoque'?'Estoque':h.tipo==='projecao'?'Projeção':h.tipo==='api'?'API Sync':'Importação';
    const dt = new Date(h.ts).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});
    return `<div class="imp-log-item">
      <span>${icon} <strong style="color:var(--text)">${typeLabel}</strong> — ${h.nome||'arquivo importado'}</span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text3)">${h.qtd} registros · ${dt}</span>
    </div>`;
  }).join('');
}

function limparHistoricoImportacao(){
  if(!confirm('Limpar todo o histórico de importações?')) return;
  importHistorico = [];
  impSaveHistorico();
  renderImportacao();
}

function importEstoque(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const wb = XLSX.read(e.target.result, {type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''}).slice(1);
      estoqueData = rows.filter(r => r[0]||r[1]).map(r => ({
        cod: String(r[0]).trim(),
        produto: String(r[1]||'').trim(),
        estoque: parseFloat(r[2])||0
      })).filter(x => x.produto || x.cod);
      impSaveEstoque();
      impAddHistorico('estoque', estoqueData.length, file.name);
      const prev = document.getElementById('imp-estoque-preview');
      prev.innerHTML = `<div style="margin-bottom:6px;font-size:11px;color:var(--green)">✅ ${estoqueData.length} registros importados</div>`
        + `<table style="width:100%;border-collapse:collapse;font-size:11px">`
        + `<thead><tr><th style="text-align:left;padding:3px 6px;color:var(--text3)">Código</th><th style="text-align:left;padding:3px 6px;color:var(--text3)">Produto</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">Estoque</th></tr></thead>`
        + `<tbody>${estoqueData.slice(0,8).map(r=>`<tr><td style="padding:3px 6px;color:var(--text2)">${r.cod}</td><td style="padding:3px 6px;color:var(--text)">${r.produto.substring(0,35)}</td><td style="padding:3px 6px;text-align:right;color:var(--cyan)">${r.estoque}</td></tr>`).join('')}</tbody>`
        + (estoqueData.length>8?`<tfoot><tr><td colspan="3" style="padding:3px 6px;color:var(--text3);font-style:italic">... e mais ${estoqueData.length-8} itens</td></tr></tfoot>`:'')
        + `</table>`;
      renderImportacao();
      toast(`Estoque importado: ${estoqueData.length} produtos`, 'ok');
    }catch(err){ toast('Erro ao importar estoque: '+err.message,'err'); }
  };
  reader.readAsArrayBuffer(file);
  input.value='';
}

function importProjecao(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const wb = XLSX.read(e.target.result, {type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''}).slice(1);
      projecaoData = rows.filter(r => r[0]||r[1]).map(r => ({
        cod: String(r[0]).trim(),
        produto: String(r[1]||'').trim(),
        venda_m1: parseFloat(r[2])||0,
        venda_m2: parseFloat(r[3])||0,
        venda_m3: parseFloat(r[4])||0
      })).filter(x => x.produto || x.cod);
      impSaveProjecao();
      impAddHistorico('projecao', projecaoData.length, file.name);
      const prev = document.getElementById('imp-proj-preview');
      prev.innerHTML = `<div style="margin-bottom:6px;font-size:11px;color:var(--green)">✅ ${projecaoData.length} registros importados</div>`
        + `<table style="width:100%;border-collapse:collapse;font-size:11px">`
        + `<thead><tr><th style="text-align:left;padding:3px 6px;color:var(--text3)">Produto</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">M1</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">M2</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">M3</th></tr></thead>`
        + `<tbody>${projecaoData.slice(0,6).map(r=>`<tr><td style="padding:3px 6px;color:var(--text)">${r.produto.substring(0,30)}</td><td style="padding:3px 6px;text-align:right;color:var(--text2)">${r.venda_m1}</td><td style="padding:3px 6px;text-align:right;color:var(--text2)">${r.venda_m2}</td><td style="padding:3px 6px;text-align:right;color:var(--text2)">${r.venda_m3}</td></tr>`).join('')}</tbody>`
        + (projecaoData.length>6?`<tfoot><tr><td colspan="4" style="padding:3px 6px;color:var(--text3);font-style:italic">... e mais ${projecaoData.length-6} itens</td></tr></tfoot>`:'')
        + `</table>`;
      renderImportacao();
      toast(`Projeção importada: ${projecaoData.length} produtos`, 'ok');
    }catch(err){ toast('Erro ao importar projeção: '+err.message,'err'); }
  };
  reader.readAsArrayBuffer(file);
  input.value='';
}

// ===================================================================
// ===== IMPORTAÇÃO DE ESTOQUE DE INSUMOS (MRP) ======================
// ===================================================================

function importEstoqueInsumos(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const wb = XLSX.read(e.target.result, {type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});

      // Detecta cabeçalho — tenta encontrar colunas por nome
      const header = (rows[0]||[]).map(h => String(h).toLowerCase().trim());
      let colInsumo = 0, colQtd = 1, colUnid = 2;
      header.forEach((h,i) => {
        if(/insumo|material|descri|nome|mp/.test(h)) colInsumo = i;
        else if(/qtd|quant|estoque|saldo|stkqtd/.test(h)) colQtd = i;
        else if(/unid|un\b|medida/.test(h)) colUnid = i;
      });

      const dataRows = rows.slice(1).filter(r => r[colInsumo]);
      const norm = s => (s||'').toUpperCase().trim().replace(/\s+/g,' ');

      // Merge: se insumo já existe, atualiza; senão adiciona
      dataRows.forEach(r => {
        const insumoNome = String(r[colInsumo]||'').trim();
        const qtd = parseFloat(String(r[colQtd]||'').replace(',','.'))||0;
        const unid = String(r[colUnid]||'').trim() || 'UN';
        if(!insumoNome) return;
        const idx = insumosEstoqueData.findIndex(x => norm(x.insumo) === norm(insumoNome));
        if(idx >= 0){
          insumosEstoqueData[idx].quantidade = qtd;
          insumosEstoqueData[idx].unidade = unid;
        } else {
          insumosEstoqueData.push({ insumo: insumoNome, quantidade: qtd, unidade: unid });
        }
      });

      impSaveInsumosEstoque();
      impAddHistorico('insumos', insumosEstoqueData.length, file.name);

      const prev = document.getElementById('imp-insumos-preview');
      if(prev){
        prev.innerHTML = `<div style="margin-bottom:6px;font-size:11px;color:var(--green)">✅ ${dataRows.length} registros processados · ${insumosEstoqueData.length} insumos no estoque</div>`
          + `<table style="width:100%;border-collapse:collapse;font-size:11px">`
          + `<thead><tr><th style="text-align:left;padding:3px 6px;color:var(--text3)">Insumo</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">Quantidade</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">Un.</th></tr></thead>`
          + `<tbody>${insumosEstoqueData.slice(0,8).map(r=>`<tr><td style="padding:3px 6px;color:var(--text)">${r.insumo.substring(0,40)}</td><td style="padding:3px 6px;text-align:right;color:var(--green);font-family:'JetBrains Mono',monospace">${r.quantidade.toLocaleString('pt-BR',{maximumFractionDigits:3})}</td><td style="padding:3px 6px;text-align:right;color:var(--text3)">${r.unidade}</td></tr>`).join('')}</tbody>`
          + (insumosEstoqueData.length>8?`<tfoot><tr><td colspan="3" style="padding:3px 6px;color:var(--text3);font-style:italic">... e mais ${insumosEstoqueData.length-8} itens</td></tr></tfoot>`:'')
          + `</table>`;
      }
      renderImportacao();
      renderSaldoInsumos();
      toast(`Insumos importados: ${insumosEstoqueData.length} itens`, 'ok');
    }catch(err){ toast('Erro ao importar insumos: '+err.message,'err'); }
  };
  reader.readAsArrayBuffer(file);
  input.value='';
}

// Calcula consumo total de insumos com base na programação ativa (registros do Gantt)
// Retorna lista de insumos para um produto: [{n: nomeInsumo, q: qtdPorCaixa}]
function findInsumosProduto(nomeProd, codProd){
  const norm = s => (s||'').toUpperCase().trim().replace(/\s+/g,' ');
  const src = (typeof fichaTecnicaData !== 'undefined' ? fichaTecnicaData : FICHA_TECNICA) || [];
  // 1) por código exato
  let ft = src.find(x => x.cod && String(x.cod) === String(codProd));
  // 2) por descrição exata
  if(!ft && nomeProd) ft = src.find(x => norm(x.desc) === norm(nomeProd));
  // 3) por descrição parcial
  if(!ft && nomeProd) ft = src.find(x => norm(nomeProd).includes(norm(x.desc).substring(0,18)) || norm(x.desc).includes(norm(nomeProd).substring(0,18)));
  if(!ft || !ft.insumos || !ft.insumos.length) return [];
  return ft.insumos.map(i => ({ n: i.insumo, q: i.qty || 0 }));
}

function calcConsumoInsumosPorProgramacao(){
  // Para cada registro programado (status Pendente/Em Andamento), soma o consumo de insumos
  const consumoMap = {}; // { nomeInsumo: { total, unidade } }
  records.forEach(rec => {
    if(rec.status === 'Concluído') return;
    const insumos = findInsumosProduto(rec.produto, rec.prodCod);
    if(!insumos || !insumos.length) return;
    const qntCaixas = rec.qntCaixas || 0;
    insumos.forEach(ins => {
      const consumoPorCx = ins.q || 0;
      const consumoTotal = consumoPorCx * qntCaixas;
      if(!consumoMap[ins.n]) consumoMap[ins.n] = { total: 0, unidade: 'UN' };
      consumoMap[ins.n].total += consumoTotal;
    });
  });
  return consumoMap;
}

// Calcula consumo de insumos para um único registro programado
function calcConsumoInsumosRegistro(rec){
  const insumos = findInsumosProduto(rec.produto, rec.prodCod);
  if(!insumos || !insumos.length) return [];
  const qntCaixas = rec.qntCaixas || 0;
  impLoadFromStorage();
  return insumos.map(ins => {
    const consumoNecessario = (ins.q || 0) * qntCaixas;
    const estoqueAtual = getEstoqueInsumo(ins.n);
    const saldoFinal = estoqueAtual != null ? estoqueAtual - consumoNecessario : null;
    return {
      nome: ins.n,
      consumoNecessario: parseFloat(consumoNecessario.toFixed(4)),
      estoqueAtual,
      saldoFinal,
      falta: saldoFinal != null && saldoFinal < 0
    };
  }).filter(i => i.consumoNecessario > 0);
}

// Calcula consumo de insumos para uma sugestão da programação automática
function calcConsumoInsumosPA(sug){
  const fichaTec = FICHA_TECNICA.find(f => String(f.cod)===String(sug.cod) || f.desc===sug.prod)
                || (typeof fichaTecnicaData !== 'undefined' ? fichaTecnicaData.find(f => String(f.cod)===String(sug.cod) || f.desc===sug.prod) : null);
  if(!fichaTec || !fichaTec.insumos || !fichaTec.insumos.length) return [];
  const qntCaixas = sug.cxAlocadas || 0;
  impLoadFromStorage();
  return fichaTec.insumos.map(ins => {
    const consumoNecessario = (ins.qty || 0) * qntCaixas;
    const estoqueAtual = getEstoqueInsumo(ins.insumo);
    const saldoFinal = estoqueAtual != null ? estoqueAtual - consumoNecessario : null;
    return {
      nome: ins.insumo,
      consumoNecessario: parseFloat(consumoNecessario.toFixed(4)),
      estoqueAtual,
      saldoFinal,
      falta: saldoFinal != null && saldoFinal < 0
    };
  }).filter(i => i.consumoNecessario > 0);
}

function renderSaldoInsumos(){
  impLoadFromStorage();
  const el = document.getElementById('imp-saldo-insumos');
  if(!el) return;

  if(!insumosEstoqueData.length){
    el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3)">Importe o estoque de insumos acima para ver o saldo MRP.</div>';
    return;
  }

  // Calcula consumo comprometido pela programação ativa
  const consumoMap = calcConsumoInsumosPorProgramacao();

  // Monta tabela
  const rows = insumosEstoqueData.map(ins => {
    const consumo = consumoMap[ins.insumo]?.total || 0;
    // Busca consumo por match parcial também
    let consumoFinal = consumo;
    if(!consumo){
      const norm = s => (s||'').toUpperCase().trim();
      const ni = norm(ins.insumo);
      for(const [k,v] of Object.entries(consumoMap)){
        if(norm(k).includes(ni.substring(0,20)) || ni.includes(norm(k).substring(0,20))){
          consumoFinal += v.total;
        }
      }
    }
    const saldo = ins.quantidade - consumoFinal;
    const status = saldo < 0 ? 'deficit' : saldo < ins.quantidade * 0.15 ? 'baixo' : 'ok';
    return { ins, consumoFinal, saldo, status };
  }).sort((a,b) => {
    const order = { deficit:0, baixo:1, ok:2 };
    return (order[a.status]||2) - (order[b.status]||2);
  });

  const deficits = rows.filter(r => r.status==='deficit').length;
  const baixos   = rows.filter(r => r.status==='baixo').length;

  let html = '';
  if(deficits || baixos){
    html += `<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      ${deficits?`<span style="background:rgba(255,71,87,.15);border:1px solid rgba(255,71,87,.4);color:var(--red);padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700">⚠️ ${deficits} insumo(s) em déficit</span>`:''}
      ${baixos?`<span style="background:rgba(255,179,0,.12);border:1px solid rgba(255,179,0,.35);color:var(--warn);padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700">🟡 ${baixos} insumo(s) com estoque baixo</span>`:''}
    </div>`;
  }

  html += `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:11px">
    <thead><tr style="background:var(--s2);border-bottom:1px solid var(--border)">
      <th style="padding:8px 10px;text-align:left;color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.8px">Insumo</th>
      <th style="padding:8px 10px;text-align:right;color:var(--text3);font-size:10px">Un.</th>
      <th style="padding:8px 10px;text-align:right;color:var(--cyan);font-size:10px">Estoque Atual</th>
      <th style="padding:8px 10px;text-align:right;color:var(--warn);font-size:10px">Consumo Programado</th>
      <th style="padding:8px 10px;text-align:right;color:var(--text3);font-size:10px">Saldo Final</th>
      <th style="padding:8px 10px;text-align:center;color:var(--text3);font-size:10px">Status</th>
    </tr></thead><tbody>`;

  rows.forEach(({ins, consumoFinal, saldo, status}, idx) => {
    const bg = idx%2===1 ? 'background:rgba(255,255,255,.01)' : '';
    const saldoColor = status==='deficit' ? 'var(--red)' : status==='baixo' ? 'var(--warn)' : 'var(--green)';
    const badge = status==='deficit'
      ? `<span style="background:rgba(255,71,87,.2);color:var(--red);padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700">Déficit</span>`
      : status==='baixo'
      ? `<span style="background:rgba(255,179,0,.15);color:var(--warn);padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700">Baixo</span>`
      : `<span style="background:rgba(46,201,122,.1);color:var(--green);padding:2px 7px;border-radius:4px;font-size:10px">OK</span>`;
    html += `<tr style="${bg}${status==='deficit'?';background:rgba(255,71,87,.04)':''}">
      <td style="padding:7px 10px;color:var(--text);font-size:11px;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${ins.insumo}">${ins.insumo}</td>
      <td style="padding:7px 10px;text-align:right;color:var(--text3);font-size:10px;font-family:'JetBrains Mono',monospace">${ins.unidade}</td>
      <td style="padding:7px 10px;text-align:right;color:var(--cyan);font-family:'JetBrains Mono',monospace;font-weight:600">${ins.quantidade.toLocaleString('pt-BR',{maximumFractionDigits:3})}</td>
      <td style="padding:7px 10px;text-align:right;color:${consumoFinal>0?'var(--warn)':'var(--text3)'};font-family:'JetBrains Mono',monospace">${consumoFinal>0?consumoFinal.toLocaleString('pt-BR',{maximumFractionDigits:3}):'—'}</td>
      <td style="padding:7px 10px;text-align:right;color:${saldoColor};font-family:'JetBrains Mono',monospace;font-weight:700">${saldo.toLocaleString('pt-BR',{maximumFractionDigits:3})}</td>
      <td style="padding:7px 10px;text-align:center">${badge}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

function exportSaldoInsumosXLSX(){
  impLoadFromStorage();
  if(!insumosEstoqueData.length){ toast('Importe o estoque de insumos primeiro','err'); return; }
  const consumoMap = calcConsumoInsumosPorProgramacao();
  const data = [['Insumo','Unidade','Estoque Atual','Consumo Programado','Saldo Final','Status']];
  insumosEstoqueData.forEach(ins => {
    let consumoFinal = consumoMap[ins.insumo]?.total || 0;
    const saldo = ins.quantidade - consumoFinal;
    const status = saldo < 0 ? 'Déficit' : saldo < ins.quantidade*0.15 ? 'Baixo' : 'OK';
    data.push([ins.insumo, ins.unidade, ins.quantidade, consumoFinal, saldo, status]);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Saldo Insumos');
  XLSX.writeFile(wb, `saldo_insumos_${dateStr(new Date())}.xlsx`);
  toast('Excel exportado!','ok');
}

function apiTestarConexao(){
  const url = document.getElementById('api-url').value.trim();
  const status = document.getElementById('api-status');
  const result = document.getElementById('api-result');
  if(!url){ toast('Informe a URL da API','err'); return; }
  status.textContent = '🔄 Testando conexão...';
  status.style.color = 'var(--warn)';
  result.innerHTML = '';
  fetch(url, { method:'GET', headers: buildApiHeaders() })
    .then(r => {
      if(r.ok){
        status.textContent = `✅ Conexão OK — status ${r.status}`;
        status.style.color = 'var(--green)';
        result.innerHTML = `<div style="background:rgba(41,217,132,.08);border:1px solid rgba(41,217,132,.25);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--green)">Conexão estabelecida com sucesso. Status HTTP ${r.status}.</div>`;
        toast('Conexão OK!','ok');
      } else {
        status.textContent = `⚠️ Erro HTTP ${r.status}`;
        status.style.color = 'var(--warn)';
        result.innerHTML = `<div style="background:rgba(255,179,0,.08);border:1px solid rgba(255,179,0,.25);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn)">Conexão realizada mas o servidor retornou HTTP ${r.status}.</div>`;
      }
    }).catch(err => {
      status.textContent = '❌ Falha na conexão';
      status.style.color = 'var(--red)';
      result.innerHTML = `<div style="background:rgba(255,71,87,.08);border:1px solid rgba(255,71,87,.25);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--red)">Erro: ${err.message}</div>`;
      toast('Falha na conexão','err');
    });
}

function buildApiHeaders(){
  const token = document.getElementById('api-token').value.trim();
  const headers = {'Content-Type':'application/json','Accept':'application/json'};
  if(token) headers['Authorization'] = token.startsWith('Bearer ') ? token : 'Bearer '+token;
  return headers;
}

function apiSincronizar(){
  const url = document.getElementById('api-url').value.trim();
  const endpoint = document.getElementById('api-endpoint').value;
  const mapCod  = document.getElementById('api-map-cod').value.trim()||'codigo';
  const mapProd = document.getElementById('api-map-prod').value.trim()||'descricao';
  const mapEstq = document.getElementById('api-map-estq').value.trim()||'estoque';
  const mapVenda= document.getElementById('api-map-venda').value.trim()||'venda_media';
  if(!url){ toast('Informe a URL da API','err'); return; }
  const status = document.getElementById('api-status');
  status.textContent = '🔄 Sincronizando...';
  status.style.color = 'var(--warn)';
  fetch(url, { method:'GET', headers: buildApiHeaders() })
    .then(r => r.json())
    .then(data => {
      const arr = Array.isArray(data) ? data : (data.data||data.items||data.result||[]);
      if(endpoint === 'estoque' || endpoint === 'ambos'){
        estoqueData = arr.map(r=>({ cod:String(r[mapCod]||''), produto:String(r[mapProd]||''), estoque:parseFloat(r[mapEstq])||0 })).filter(x=>x.produto);
        impSaveEstoque();
        impAddHistorico('api', estoqueData.length, url);
      }
      if(endpoint === 'projecao' || endpoint === 'ambos'){
        projecaoData = arr.map(r=>({ cod:String(r[mapCod]||''), produto:String(r[mapProd]||''), venda_m1:parseFloat(r[mapVenda])||0, venda_m2:parseFloat(r[mapVenda])||0, venda_m3:parseFloat(r[mapVenda])||0 })).filter(x=>x.produto);
        impSaveProjecao();
      }
      status.textContent = `✅ Sincronizado — ${arr.length} registros`;
      status.style.color = 'var(--green)';
      renderImportacao();
      toast(`Sincronização concluída: ${arr.length} registros`,'ok');
    })
    .catch(err => {
      status.textContent = '❌ Erro na sincronização';
      status.style.color = 'var(--red)';
      toast('Erro na sincronização: '+err.message,'err');
    });
}

function renderApiSync(){
  renderImportacao();
  // Também atualiza o wrap dentro de Configurações se estiver aberto
  const wrap = document.getElementById('settings-importacao-wrap');
  const src  = document.getElementById('panel-importacao');
  if(wrap && src) wrap.innerHTML = src.innerHTML;
}

// ===================================================================
// ===== PROJEÇÃO DE VENDAS ==========================================
// ===================================================================

let projecaoCalculada = [];
let projecaoManual    = {};

function projLoadManual(){
  try{ projecaoManual = JSON.parse(localStorage.getItem('proj_manual')||'{}'); }catch(e){ projecaoManual={}; }
}
function projSaveManual(){ localStorage.setItem('proj_manual', JSON.stringify(projecaoManual)); }

function getEstoqueProduto(prodNome, prodCod){
  const norm = s => (s||'').toUpperCase().trim().replace(/\s+/g,' ');
  const np = norm(prodNome);
  const nc = String(prodCod||'').trim();
  let found = estoqueData.find(x => x.cod && x.cod === nc);
  if(!found) found = estoqueData.find(x => norm(x.produto) === np);
  if(!found && np.length > 6) found = estoqueData.find(x => norm(x.produto).includes(np.substring(0,18)) || np.includes(norm(x.produto).substring(0,18)));
  return found ? found.estoque : null;
}

function calcularProjecao(){
  impLoadFromStorage();
  projLoadManual();
  const metodo  = document.getElementById('proj-metodo')?.value || 'media_simples';
  const meses   = parseInt(document.getElementById('proj-meses')?.value||'3');
  const fator   = parseFloat(document.getElementById('proj-fator')?.value||'1');

  const allProds = [];
  const seen = new Set();
  projecaoData.forEach(p => {
    const key = (p.cod||p.produto).toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    allProds.push(p);
  });
  getAllProdutos().forEach(p => {
    const key = String(p.cod).toLowerCase();
    if(!seen.has(key)){
      seen.add(key);
      allProds.push({ cod:String(p.cod), produto:p.descricao, venda_m1:0, venda_m2:0, venda_m3:0, _fromFicha:true });
    }
  });

  projecaoCalculada = allProds.map(p => {
    const vals = [p.venda_m1||0, p.venda_m2||0, p.venda_m3||0].slice(0, meses);
    let mediaCalc;
    if(metodo === 'media_ponderada'){
      const pesos = vals.map((_,i) => i+1);
      const soma  = vals.reduce((a,v,i)=>a+v*pesos[i],0);
      const somaPesos = pesos.reduce((a,b)=>a+b,0);
      mediaCalc = somaPesos > 0 ? soma/somaPesos : 0;
    } else {
      mediaCalc = vals.length > 0 ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
    }
    const projMensal = mediaCalc * fator;
    const projSemanal = projMensal / 4.33;
    const manualKey = p.cod || p.produto;
    const projFinal = projecaoManual[manualKey] != null ? projecaoManual[manualKey] : projSemanal;
    const estoqueBruto = getEstoqueProduto(p.produto, p.cod);
    const prodFicha = getAllProdutos().find(x => String(x.cod) === String(p.cod) || x.descricao === p.produto);
    const unidPorCxProj = prodFicha ? (prodFicha.unid || 1) : 1;
    let estoque = estoqueBruto;
    if(estoque != null && projSemanal > 0 && estoque > projSemanal * unidPorCxProj * 0.5){
      estoque = estoque / unidPorCxProj;
    }
    const coberturaAtual = estoque != null && projSemanal > 0 ? (estoque / projSemanal * 7) : null;
    return {
      cod: p.cod,
      produto: p.produto,
      maquina: prodFicha ? prodFicha.maquina : '—',
      venda_m1: p.venda_m1||0,
      venda_m2: p.venda_m2||0,
      venda_m3: p.venda_m3||0,
      mediaCalc: parseFloat(mediaCalc.toFixed(2)),
      projMensal: parseFloat(projMensal.toFixed(2)),
      projSemanal: parseFloat(projSemanal.toFixed(2)),
      projFinal: parseFloat(projFinal.toFixed(2)),
      estoque: estoque,
      coberturaAtual: coberturaAtual != null ? parseFloat(coberturaAtual.toFixed(1)) : null,
      risco: coberturaAtual != null ? (coberturaAtual <= 3 ? 'critico' : coberturaAtual <= 7 ? 'alto' : coberturaAtual <= 14 ? 'medio' : 'ok') : 'nd',
      isManual: projecaoManual[manualKey] != null
    };
  }).filter(p => !p._fromFicha || p.estoque != null || p.projSemanal > 0);

  renderProjecaoTabela();
  renderProjecaoStats();
}

function renderProjecaoStats(){
  const total = projecaoCalculada.length;
  const riscos = projecaoCalculada.filter(p => p.risco === 'critico' || p.risco === 'alto').length;
  const comCob = projecaoCalculada.filter(p => p.coberturaAtual != null);
  const cobMedia = comCob.length > 0 ? (comCob.reduce((a,p)=>a+p.coberturaAtual,0)/comCob.length).toFixed(1) : '—';
  const demandaSem = projecaoCalculada.reduce((a,p)=>a+p.projFinal,0).toFixed(0);
  const meses = parseInt(document.getElementById('proj-meses')?.value||'3');
  document.getElementById('proj-stat-total').textContent = total;
  document.getElementById('proj-stat-risco').textContent = riscos;
  document.getElementById('proj-stat-cob').textContent   = cobMedia !== '—' ? cobMedia+'d' : '—';
  document.getElementById('proj-stat-demanda').textContent = Number(demandaSem).toLocaleString('pt-BR');
  document.getElementById('proj-stat-meses').textContent  = meses;
  const alertEl = document.getElementById('proj-alerta');
  const criticos = projecaoCalculada.filter(p => p.risco === 'critico');
  if(criticos.length){
    alertEl.innerHTML = `<div style="background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);border-radius:8px;padding:10px 16px;margin-bottom:4px;font-size:12px;color:var(--red)">
      ⚠️ <strong>${criticos.length} produto(s) com risco crítico de ruptura</strong> — cobertura ≤ 3 dias: ${criticos.slice(0,3).map(p=>p.produto.substring(0,25)).join(', ')}${criticos.length>3?' + mais...':''}
    </div>`;
  } else { alertEl.innerHTML = ''; }
}

function renderProjecaoTabela(){
  const q = (document.getElementById('proj-search')?.value||'').toLowerCase();
  let data = projecaoCalculada.filter(p => !q || p.produto.toLowerCase().includes(q) || (p.maquina||'').toLowerCase().includes(q));
  const el = document.getElementById('proj-body');
  if(!el) return;
  if(!data.length){
    el.innerHTML = `<div class="empty"><div class="ei">📈</div>Nenhuma projeção disponível. Importe dados na aba Importação/API primeiro, ou clique em Recalcular.</div>`;
    return;
  }
  const riskOrder = {critico:0,alto:1,medio:2,ok:3,nd:4};
  data = [...data].sort((a,b) => (riskOrder[a.risco]||4) - (riskOrder[b.risco]||4));
  const projProdW = parseInt(localStorage.getItem('proj-prod-width')||'200');
  el.innerHTML = `
  <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
  <table id="proj-table" style="width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed">
    <colgroup>
      <col id="proj-col-prod" style="width:${projProdW}px;min-width:80px">
      <col style="width:90px">
      <col style="width:48px"><col style="width:48px"><col style="width:48px">
      <col style="width:56px">
      <col style="width:62px">
      <col style="width:62px">
      <col style="width:68px">
      <col style="width:56px">
      <col style="width:72px">
      <col style="width:64px">
    </colgroup>
    <thead><tr style="background:var(--s2)">
      <th style="text-align:left;padding:0;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);position:relative;user-select:none">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px">
          <span>Produto</span>
          <div id="proj-prod-resizer" style="width:6px;height:100%;position:absolute;right:0;top:0;cursor:col-resize;background:transparent;display:flex;align-items:center;justify-content:center" title="Arraste para redimensionar">
            <div style="width:2px;height:14px;background:var(--border);border-radius:1px"></div>
          </div>
        </div>
      </th>
      <th style="text-align:left;padding:8px 6px;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Máquina</th>
      <th style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">M1</th>
      <th style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">M2</th>
      <th style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">M3</th>
      <th style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Média</th>
      <th style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Proj/Mês</th>
      <th style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Proj/Sem</th>
      <th style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Estoque</th>
      <th style="padding:8px 4px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Cob.</th>
      <th style="padding:8px 4px;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Risco</th>
      <th style="padding:8px 4px;font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3)">Manual</th>
    </tr></thead>
    <tbody>${data.map(p=>{
      const riskLabel = {critico:'🔴 Crítico',alto:'🟠 Alto',medio:'🟡 Médio',ok:'🟢 OK',nd:'—'}[p.risco]||'—';
      const riskCls = {critico:'risk-critico',alto:'risk-alto',medio:'risk-medio',ok:'risk-ok',nd:''}[p.risco]||'';
      const cobStr = p.coberturaAtual != null ? p.coberturaAtual+'d' : '—';
      const cobColor = p.risco==='critico'?'var(--red)':p.risco==='alto'?'var(--warn)':p.risco==='medio'?'var(--cyan)':'var(--green)';
      const estqStr = p.estoque != null ? p.estoque.toLocaleString('pt-BR') : '—';
      const maqShort = (p.maquina||'—').length > 12 ? (p.maquina||'').slice(0,12)+'…' : (p.maquina||'—');
      return `<tr style="border-bottom:1px solid rgba(31,45,61,.5)">
        <td style="padding:7px 10px;font-size:11px;font-weight:500;color:var(--text);line-height:1.3">${p.produto}${p.isManual?'<span style="color:var(--warn);font-size:9px;margin-left:4px">✏️</span>':''}</td>
        <td style="padding:7px 6px"><span style="background:rgba(129,140,248,.12);color:var(--purple);border:1px solid rgba(129,140,248,.28);border-radius:4px;padding:2px 5px;font-family:'JetBrains Mono',monospace;font-size:9px;white-space:nowrap" title="${p.maquina}">${maqShort}</span></td>
        <td style="padding:7px 6px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2)">${p.venda_m1||'—'}</td>
        <td style="padding:7px 6px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2)">${p.venda_m2||'—'}</td>
        <td style="padding:7px 6px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2)">${p.venda_m3||'—'}</td>
        <td style="padding:7px 6px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text)">${p.mediaCalc}</td>
        <td style="padding:7px 6px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--cyan)">${p.projMensal}</td>
        <td style="padding:7px 6px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--cyan);font-weight:700">${p.projFinal}</td>
        <td style="padding:7px 6px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text)">${estqStr}</td>
        <td style="padding:7px 6px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:${cobColor}">${cobStr}</td>
        <td style="padding:7px 6px"><span class="risk-tag ${riskCls}" style="font-size:9px;padding:2px 5px">${riskLabel}</span></td>
        <td style="padding:7px 6px"><input type="number" min="0" step="0.1" value="${p.isManual?p.projFinal:''}" placeholder="${p.projSemanal.toFixed(1)}"
          style="background:var(--s2);border:1px solid var(--border);color:var(--text);padding:3px 5px;border-radius:5px;font-family:'JetBrains Mono',monospace;font-size:10px;width:60px;text-align:right"
          onchange="projSetManual(${JSON.stringify(p.cod||p.produto)},this.value)"></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
  // Resize logic for product column
  (function(){
    const resizer = document.getElementById('proj-prod-resizer');
    const colProd = document.getElementById('proj-col-prod');
    if(!resizer || !colProd) return;
    let startX, startW;
    resizer.addEventListener('mousedown', function(e){
      startX = e.clientX;
      startW = colProd.offsetWidth;
      resizer.querySelector('div').style.background = 'var(--cyan)';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e){
      const w = Math.max(80, startW + (e.clientX - startX));
      colProd.style.width = w + 'px';
      localStorage.setItem('proj-prod-width', w);
    }
    function onUp(){
      resizer.querySelector('div').style.background = 'var(--border)';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  })();
}

function projSetManual(key, val){
  projLoadManual();
  const v = parseFloat(val);
  if(!isNaN(v) && v >= 0){ projecaoManual[key] = v; }
  else { delete projecaoManual[key]; }
  projSaveManual();
  calcularProjecao();
}

function exportProjecaoXLSX(){
  if(!projecaoCalculada.length){ toast('Calcule a projeção primeiro','err'); return; }
  const wb = XLSX.utils.book_new();
  const rows = [['Produto','Máquina','Venda M1','Venda M2','Venda M3','Média','Proj.Mensal','Proj.Semanal','Estoque Atual','Cobertura (dias)','Risco']];
  projecaoCalculada.forEach(p => rows.push([p.produto,p.maquina,p.venda_m1,p.venda_m2,p.venda_m3,p.mediaCalc,p.projMensal,p.projFinal,p.estoque??'',p.coberturaAtual??'',p.risco]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Projecao');
  XLSX.writeFile(wb, 'ProjecaoVendas.xlsx');
  toast('Excel exportado!','ok');
}

function abrirModalNovoItemProjecao(){
  const modal = document.createElement('div');
  modal.className = 'overlay on';
  modal.id = 'modal-proj-manual';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:500px">
      <div class="modal-hd"><h2>+ Adicionar Produto à Projeção</h2><button class="btn btn-ghost" onclick="document.getElementById('modal-proj-manual').remove()" style="padding:6px 10px">✕</button></div>
      <div class="modal-bd">
        <div class="fg">
          <div class="frow full"><label class="flbl">Produto *</label><input class="finp" id="pm-prod" placeholder="Nome do produto"></div>
          <div class="frow"><label class="flbl">Código</label><input class="finp" id="pm-cod" placeholder="Código"></div>
          <div class="frow"><label class="flbl">Venda M1 (cx)</label><input type="number" class="finp" id="pm-m1" value="0"></div>
          <div class="frow"><label class="flbl">Venda M2 (cx)</label><input type="number" class="finp" id="pm-m2" value="0"></div>
          <div class="frow"><label class="flbl">Venda M3 (cx)</label><input type="number" class="finp" id="pm-m3" value="0"></div>
          <div class="frow"><label class="flbl">Estoque Atual (cx)</label><input type="number" class="finp" id="pm-estq" value="0"></div>
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-proj-manual').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="salvarItemProjecaoManual()">💾 Salvar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function salvarItemProjecaoManual(){
  const prod = document.getElementById('pm-prod').value.trim();
  if(!prod){ toast('Informe o nome do produto','err'); return; }
  const cod   = document.getElementById('pm-cod').value.trim();
  const m1    = parseFloat(document.getElementById('pm-m1').value)||0;
  const m2    = parseFloat(document.getElementById('pm-m2').value)||0;
  const m3    = parseFloat(document.getElementById('pm-m3').value)||0;
  const estq  = parseFloat(document.getElementById('pm-estq').value)||0;
  impLoadFromStorage();
  const existing = projecaoData.findIndex(x => x.produto === prod || x.cod === cod);
  if(existing >= 0) projecaoData[existing] = {cod,produto:prod,venda_m1:m1,venda_m2:m2,venda_m3:m3};
  else projecaoData.push({cod,produto:prod,venda_m1:m1,venda_m2:m2,venda_m3:m3});
  impSaveProjecao();
  if(estq > 0){
    const ei = estoqueData.findIndex(x => x.produto === prod || x.cod === cod);
    if(ei >= 0) estoqueData[ei] = {cod,produto:prod,estoque:estq};
    else estoqueData.push({cod,produto:prod,estoque:estq});
    impSaveEstoque();
  }
  document.getElementById('modal-proj-manual')?.remove();
  calcularProjecao();
  toast('Produto adicionado à projeção!','ok');
}

function renderProjecao(){ calcularProjecao(); }

// ===================================================================
// ===== PROGRAMAÇÃO AUTOMÁTICA ======================================
// ===================================================================

let paResultados = [];

function hoursOnMachineDay(machine, d){
  const mhrs = machineHours[machine];
  if(mhrs && Array.isArray(mhrs)){
    const v = mhrs[d.getDay()];
    if(v != null) return v;
  }
  return hoursOnDay(d);
}

function weekHrsForMachine(machine, monday){
  return getWeekDays(monday).reduce((a,d) => a + hoursOnMachineDay(machine, d), 0);
}

function paPopulaSemanas(){
  const sel = document.getElementById('pa-semana-sel');
  if(!sel) return;
  const val = sel.value;
  while(sel.options.length > 1) sel.remove(1);
  const today = new Date();
  for(let i=0; i<8; i++){
    const mon = getWeekMonday(new Date(today.getTime() + i*7*86400000));
    const sun = new Date(mon); sun.setDate(mon.getDate()+6);
    const opt = document.createElement('option');
    opt.value = dateStr(mon);
    opt.textContent = `${fmtDate(mon)} – ${fmtDate(sun)} / ${mon.getFullYear()}`;
    sel.appendChild(opt);
  }
  if(val) sel.value = val;
  const maqSel = document.getElementById('pa-maq-filter');
  if(maqSel){
    while(maqSel.options.length > 1) maqSel.remove(1);
    MAQUINAS.forEach(m => {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      maqSel.appendChild(o);
    });
  }
}

function pa_onSemanaChange(){ if(paResultados.length) renderProgAutomaticaResultado(); }

function gerarProgAutomarica(){
  // Validação: precisa de máquinas e produtos reais do Firestore
  if (!MAQUINAS.length) {
    const alertEl2 = document.getElementById('pa-alerta');
    if(alertEl2) alertEl2.innerHTML = '<div style="background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--red)">'
      + '⛔ <strong>Nenhuma máquina cadastrada no Firestore.</strong> Cadastre máquinas em <strong>Configurações → Máquinas</strong> antes de gerar a programação.</div>';
    document.getElementById('pa-body').innerHTML = '';
    return;
  }
  if (!getAllProdutos().length) {
    const alertEl2 = document.getElementById('pa-alerta');
    if(alertEl2) alertEl2.innerHTML = '<div style="background:rgba(255,179,0,.1);border:1px solid rgba(255,179,0,.3);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--warn)">'
      + '⚠️ <strong>Nenhum produto cadastrado.</strong> Importe produtos em <strong>Configurações → Produtos → Excel</strong> antes de gerar.</div>';
    document.getElementById('pa-body').innerHTML = '';
    return;
  }
  impLoadFromStorage();
  projLoadManual();
  if(!projecaoCalculada.length) calcularProjecao();

  const cobMin   = parseFloat(document.getElementById('pa-cobertura-min')?.value||'5');
  const cobAlvo  = parseFloat(document.getElementById('pa-cobertura-alvo')?.value||'15');
  const riscoLim = parseFloat(document.getElementById('pa-risco-critico')?.value||'3');
  const maxPctMaq= parseFloat(document.getElementById('pa-max-pct-maq')?.value||'60') / 100;

  const semanaSel = document.getElementById('pa-semana-sel')?.value;
  const monday = semanaSel ? new Date(semanaSel+'T12:00:00') : getWeekMonday(new Date());
  const days = getWeekDays(monday);

  // Avisos de configuração
  const alertEl = document.getElementById('pa-alerta');
  const maqSemProdutos = MAQUINAS.filter(m => {
    const d = getMaquinaData(m);
    return !d || !Array.isArray(d.produtosCompativeis) || d.produtosCompativeis.length === 0;
  });

  if (!projecaoCalculada.length) {
    if(alertEl) alertEl.innerHTML = '<div style="background:rgba(255,179,0,.1);border:1px solid rgba(255,179,0,.3);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">⚠️ <strong>Dados insuficientes:</strong> Nenhuma projeção de vendas encontrada. Importe o estoque e projeção na aba <strong>Importação/API</strong>.</div>';
    document.getElementById('pa-body').innerHTML = '';
    paResultados = [];
    renderProgAutomaticaStats();
    return;
  }

  if(alertEl) {
    let alertHtml = '';
    if (maqSemProdutos.length > 0) {
      alertHtml += '<div style="background:rgba(255,179,0,.08);border:1px solid rgba(255,179,0,.25);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">⚠️ <strong>Máquinas sem produtos vinculados:</strong> ' + maqSemProdutos.join(', ') + '. Configure em <strong>Configurações → Máquinas</strong> → Produtos Compatíveis.</div>';
    }
    alertEl.innerHTML = alertHtml;
  }

  const candidates = [];
  const prodSemMaquina = [];
  projecaoCalculada.forEach(proj => {
    const allProds = getAllProdutos();
    const ficha = allProds.find(p => String(p.cod)===String(proj.cod) || p.descricao===proj.produto);

    let maqNome = ficha ? ficha.maquina : null;
    let fichaUnid = ficha ? (ficha.unid || 1) : 1;
    let fichaPcMin = ficha ? (ficha.pc_min || 0) : 0;

    if (!maqNome) {
      // Tenta encontrar qual maquina tem este produto nos compativeis
      const maqDataBusca = Object.values(window.MAQUINAS_DATA || {}).find(m =>
        Array.isArray(m.produtosCompativeis) &&
        m.produtosCompativeis.some(p => p.produto === proj.produto || (proj.produto && proj.produto.startsWith(p.produto)))
      );
      if (maqDataBusca) {
        maqNome = maqDataBusca.nome;
        const entry = maqDataBusca.produtosCompativeis.find(p => p.produto === proj.produto || (proj.produto && proj.produto.startsWith(p.produto)));
        fichaPcMin = (entry && entry.velocidade) ? parseFloat(entry.velocidade) : (parseFloat(maqDataBusca.pcMin) || 0);
      } else {
        prodSemMaquina.push(proj.produto);
        return;
      }
    }

    // Buscar velocidade real da maquina no cadastro Firestore
    const maqData = getMaquinaData(maqNome);
    let pc_min = fichaPcMin; // 3: fallback catalogo
    if (maqData) {
      // 1: velocidade especifica do produto na maquina
      const prodEntry = Array.isArray(maqData.produtosCompativeis)
        ? maqData.produtosCompativeis.find(p => p.produto === proj.produto || (proj.produto && proj.produto.startsWith(p.produto)) || p.produto === (ficha && ficha.descricao))
        : null;
      if (prodEntry && prodEntry.velocidade != null && prodEntry.velocidade > 0) {
        pc_min = parseFloat(prodEntry.velocidade);
      } else if (maqData.pcMin && parseFloat(maqData.pcMin) > 0) {
        pc_min = parseFloat(maqData.pcMin); // 2: velocidade padrao da maquina
      }
      // 3: fichaPcMin (ja definido acima) - fallback
    }
    if (!pc_min || pc_min <= 0) {
      console.warn('[PA] Maquina sem velocidade:', maqNome, '| produto:', proj.produto);
    }

    const demandaDiaria = proj.projFinal / 7;
    const unidPorCx = fichaUnid;
    const estoqueRaw = proj.estoque ?? 0;
    const estoqueCaixas = unidPorCx > 1 ? estoqueRaw / unidPorCx : estoqueRaw;
    const estoque = estoqueCaixas;
    const cobAtual = demandaDiaria > 0 ? estoque / demandaDiaria : 999;
    const prioridade = calcPrioridade(cobAtual, demandaDiaria, riscoLim, cobMin);
    const estqAlvo = demandaDiaria * cobAlvo;
    const qntCaixasNecessario = Math.max(0, Math.ceil((estqAlvo - estoque)));
    if(qntCaixasNecessario <= 0 && cobAtual > cobAlvo) return;
    const unidTotal = qntCaixasNecessario * unidPorCx;
    const tempoMin  = pc_min > 0 ? unidTotal / pc_min : 0;
    const tempoHrs  = tempoMin / 60;
    const cobProjetada = demandaDiaria > 0 ? parseFloat(((estoque + qntCaixasNecessario) / demandaDiaria).toFixed(1)) : 999;
    candidates.push({
      prod: proj.produto,
      cod: proj.cod,
      maquina: maqNome,
      pc_min,
      unid: unidPorCx,
      estoque,
      cobAtual: parseFloat(cobAtual.toFixed(1)),
      demandaDiaria: parseFloat(demandaDiaria.toFixed(2)),
      demandaSemanal: parseFloat(proj.projFinal.toFixed(2)),
      qntCaixasSugerida: qntCaixasNecessario,
      tempoHrs: parseFloat(tempoHrs.toFixed(2)),
      prioridade,
      cobProjetada,
      risco: cobAtual <= riscoLim ? 'critico' : cobAtual <= cobMin ? 'alto' : cobAtual <= cobMin*2 ? 'medio' : 'ok',
      motivo: buildMotivo(cobAtual, demandaDiaria, riscoLim, cobMin, cobAlvo),
      // flags de diagnóstico
      velocidadeOrigem: maqData ? ((() => {
        const e = Array.isArray(maqData.produtosCompativeis) ? maqData.produtosCompativeis.find(p => p.produto === proj.produto || p.produto === (ficha && ficha.descricao)) : null;
        return e && e.velocidade ? 'produto' : (maqData.pcMin ? 'maquina' : 'catalogo');
      })()) : 'catalogo'
    });
  });

  // Alertas de produtos sem maquina / maquinas sem velocidade
  if (alertEl) {
    let alertHtml = alertEl.innerHTML || '';
    if (prodSemMaquina.length > 0) {
      alertHtml += '<div style="background:rgba(255,71,87,.08);border:1px solid rgba(255,71,87,.3);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--red);margin-bottom:8px">'
        + '\u26D4 <strong>Produtos sem maquina compativel cadastrada:</strong> '
        + prodSemMaquina.slice(0,5).join(', ')
        + (prodSemMaquina.length > 5 ? ' e mais ' + (prodSemMaquina.length-5) : '')
        + '. Vincule em <strong>Configuracoes > Maquinas > Produtos Compativeis</strong>.</div>';
    }
    const maqSemVel = Object.values(window.MAQUINAS_DATA || {}).filter(m => !(m.pcMin > 0));
    if (maqSemVel.length > 0) {
      alertHtml += '<div style="background:rgba(255,179,0,.08);border:1px solid rgba(255,179,0,.25);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">'
        + '\u26A0\uFE0F <strong>Maquinas sem velocidade configurada:</strong> '
        + maqSemVel.map(m => m.nome).join(', ')
        + '. Configure em <strong>Configuracoes > Maquinas > Capacidade</strong>.</div>';
    }
    alertEl.innerHTML = alertHtml;
  }

  if(!candidates.length){
    document.getElementById('pa-body').innerHTML = '<div class="empty"><div class="ei">✅</div>Nenhum produto precisa de produção urgente com os parâmetros atuais.<br><small style="color:var(--text3)">Verifique se importou estoque e projeção na aba Importação/API</small></div>';
    paResultados = [];
    renderProgAutomaticaStats();
    return;
  }

  const byMaq = {};
  candidates.forEach(c => {
    if(!byMaq[c.maquina]) byMaq[c.maquina] = [];
    byMaq[c.maquina].push(c);
  });

  paResultados = [];

  for(const maq of Object.keys(byMaq)){
    const items = byMaq[maq].sort((a,b) => b.prioridade - a.prioridade);
    const maqData2 = getMaquinaData(maq);

    // Calcular capacidade semanal real respeitando hTurno, nTurnos e eficiência
    let maqWeekHrs = weekHrsForMachine(maq, monday);
    if (!maqWeekHrs || maqWeekHrs <= 0) {
      if (maqData2 && parseFloat(maqData2.hTurno) > 0 && parseInt(maqData2.nTurnos) > 0) {
        const hTurno = parseFloat(maqData2.hTurno);
        const nTurnos = parseInt(maqData2.nTurnos);
        const diasUteis = days.length || 5;
        maqWeekHrs = hTurno * nTurnos * diasUteis;
      } else {
        maqWeekHrs = 44; // fallback padrão (8h × 1 turno × 5 dias + 1 hora extra)
      }
    }
    // Aplicar eficiência da máquina na capacidade disponível
    const efic = (maqData2 && parseFloat(maqData2.eficiencia) > 0) ? parseFloat(maqData2.eficiencia) / 100 : 1;
    const maqCapacidadeEfetiva = maqWeekHrs * efic;

    const maqWorkDays = days.filter(d => hoursOnMachineDay(maq,d) > 0);
    let maqHrsRestantes = maqCapacidadeEfetiva;
    items.forEach(item => {
      const maxHrsItem = maqHrsRestantes * maxPctMaq;
      const hrsAlocar  = Math.min(item.tempoHrs, maxHrsItem);
      const pctUsado   = maqCapacidadeEfetiva > 0 ? (hrsAlocar / maqCapacidadeEfetiva * 100) : 0;
      const cxAlocar   = item.pc_min > 0 && item.unid > 0
        ? Math.floor(hrsAlocar * 60 * item.pc_min / item.unid)
        : item.qntCaixasSugerida;
      maqHrsRestantes -= hrsAlocar;
      const diasDist = distribuirPorDia(cxAlocar, maqWorkDays, item);
      const cobProjetadaReal = item.demandaDiaria > 0
        ? parseFloat(((item.estoque + cxAlocar) / item.demandaDiaria).toFixed(1))
        : 999;

      // Validação de insumos
      const fichaTec = FICHA_TECNICA.find(f => String(f.cod)===String(item.cod) || f.desc===item.prod)
                    || (typeof fichaTecnicaData!=='undefined' ? fichaTecnicaData.find(f => String(f.cod)===String(item.cod) || f.desc===item.prod) : null);
      let insumosStatus = [];
      let temFichasTecnica = !!(fichaTec && fichaTec.insumos && fichaTec.insumos.length);
      let insumosOk = true;
      let insumosFaltando = [];
      if(temFichasTecnica && insumosEstoqueData.length > 0){
        insumosStatus = fichaTec.insumos.map(ins => {
          const consumo = (ins.qty||0) * cxAlocar;
          const estoqueAtual = getEstoqueInsumo(ins.insumo);
          const saldo = estoqueAtual != null ? estoqueAtual - consumo : null;
          const falta = saldo != null && saldo < 0;
          if(falta){ insumosOk = false; insumosFaltando.push({ nome: ins.insumo, consumo, estoqueAtual, saldo, deficit: Math.abs(saldo) }); }
          return { nome: ins.insumo, consumo, estoqueAtual, saldo, falta };
        }).filter(i => i.consumo > 0);
      }

      paResultados.push({
        ...item,
        hrsAlocadas: parseFloat(hrsAlocar.toFixed(2)),
        cxAlocadas: cxAlocar,
        pctMaquina: parseFloat(pctUsado.toFixed(1)),
        cobProjetada: cobProjetadaReal,
        diasDist,
        insumosStatus,
        insumosOk,
        insumosFaltando,
        temFichasTecnica
      });
    });
  }

  renderProgAutomaticaResultado();
  renderProgAutomaticaStats();
  document.getElementById('pa-apply-btn').style.display = paResultados.length ? 'flex' : 'none';
  toast('Programação gerada: ' + paResultados.length + ' sugestões', 'ok');
}

function calcPrioridade(cobAtual, demandaDiaria, riscoLim, cobMin){
  const urgency = Math.max(0, cobMin - cobAtual + 1);
  const demand  = Math.min(demandaDiaria * 7, 999);
  return urgency * 100 + demand;
}

function buildMotivo(cobAtual, demandaDiaria, riscoLim, cobMin, cobAlvo){
  if(cobAtual <= riscoLim) return `🔴 Ruptura em ${cobAtual.toFixed(1)}d — produção urgente`;
  if(cobAtual <= cobMin)   return `🟠 Abaixo do mínimo (${cobMin}d) — cobertura atual ${cobAtual.toFixed(1)}d`;
  if(cobAtual <= cobMin*2) return `🟡 Cobertura baixa (${cobAtual.toFixed(1)}d) — repor para ${cobAlvo}d`;
  return `🟢 Preventivo — repor estoque para ${cobAlvo} dias`;
}

function distribuirPorDia(qntCaixas, workDays, item){
  if(!workDays.length || !qntCaixas) return [];
  const maq = item.maquina;
  const totalHrs = workDays.reduce((a,d) => a + hoursOnMachineDay(maq, d), 0);
  let restante = qntCaixas;
  const dist = workDays.map((d, i) => {
    const dayHrs = hoursOnMachineDay(maq, d);
    const frac = totalHrs > 0 ? dayHrs / totalHrs : 1/workDays.length;
    const cx   = i === workDays.length-1 ? restante : Math.round(qntCaixas * frac);
    restante -= cx;
    return { date: dateStr(d), dayName: DAY_NAMES[d.getDay()], cx: Math.max(0,cx), hrs: dayHrs };
  });
  return dist.filter(d => d.cx > 0);
}

function renderProgAutomaticaStats(){
  const riscos    = paResultados.filter(p => p.risco==='critico'||p.risco==='alto').length;
  const totalHrs  = paResultados.reduce((a,p)=>a+p.hrsAlocadas,0);
  const maqsEnvol = new Set(paResultados.map(p=>p.maquina)).size;
  document.getElementById('pa-stat-risco').textContent      = riscos;
  document.getElementById('pa-stat-sugestoes').textContent  = paResultados.length;
  document.getElementById('pa-stat-maq').textContent        = maqsEnvol;
  document.getElementById('pa-stat-hrs').textContent        = fmtHrs(totalHrs);
  const sel = document.getElementById('pa-semana-sel');
  const sval = sel ? sel.value : '';
  const mon = sval ? new Date(sval+'T12:00:00') : getWeekMonday(new Date());
  const sun = new Date(mon); sun.setDate(mon.getDate()+6);
  document.getElementById('pa-stat-semana').textContent = fmtDate(mon)+' – '+fmtDate(sun);
}

function renderProgAutomaticaResultado(){
  const el = document.getElementById('pa-body');
  if(!el) return;
  const maqFilter = document.getElementById('pa-maq-filter')?.value || '';
  let data = maqFilter ? paResultados.filter(p => p.maquina === maqFilter) : paResultados;
  if(!data.length){
    el.innerHTML = `<div class="empty"><div class="ei">🤖</div>Clique em "Gerar Programação Automática" para calcular sugestões de produção.</div>`;
    return;
  }
  const byMaq = {};
  data.forEach(p => { if(!byMaq[p.maquina]) byMaq[p.maquina]=[]; byMaq[p.maquina].push(p); });
  let html = '';
  for(const maq of MAQUINAS){
    const items = byMaq[maq];
    if(!items || !items.length) continue;
    const maqHrs  = items.reduce((a,p)=>a+p.hrsAlocadas,0);
    const maqCox  = items.reduce((a,p)=>a+p.cxAlocadas,0);
    const maqCrit = items.filter(p=>p.risco==='critico').length;
    const maqSemInsumo = items.filter(p=>!p.insumosOk).length;
    const semanaSel = document.getElementById('pa-semana-sel')?.value;
    const monday = semanaSel ? new Date(semanaSel+'T12:00:00') : getWeekMonday(new Date());
    const maqWeekHrs = weekHrsForMachine(maq, monday);
    const pctTotal = maqWeekHrs > 0 ? Math.min(100,(maqHrs/maqWeekHrs*100)).toFixed(1) : 0;
    html += `<div class="pa-card">
      <div class="pa-card-header">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="ins-maq-title">🏭 ${maq}</span>
          ${maqCrit>0?`<span class="risk-tag risk-critico">🔴 ${maqCrit} crítico(s)</span>`:''}
          ${maqSemInsumo>0?`<span style="background:rgba(255,71,87,.18);color:var(--red);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">⚠️ ${maqSemInsumo} sem insumo</span>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2)">
          <span>${maqCox} cx · ${fmtHrs(maqHrs)} · ${pctTotal}% da semana</span>
          <div class="cov-bar-track" style="width:80px"><div class="cov-bar-fill" style="width:${pctTotal}%;background:${parseFloat(pctTotal)>85?'var(--red)':parseFloat(pctTotal)>65?'var(--warn)':'var(--cyan)'}"></div></div>
        </div>
      </div>
      <div class="pa-card-body" style="overflow-x:auto">
        <table class="pa-suggest-tbl">
          <thead><tr>
            <th style="min-width:240px">Produto</th>
            <th>Motivo / Risco</th>
            <th>Estoque Atual</th>
            <th>Cob. Atual</th>
            <th>Demanda Sem.</th>
            <th>Qtd Sugerida</th>
            <th>Tempo</th>
            <th>% Máquina</th>
            <th>Cob. Pós-Prod.</th>
            <th>Insumos</th>
            <th>Distribuição na Semana</th>
          </tr></thead>
          <tbody>${items.map((p,pi)=>{
            const cobColor = p.risco==='critico'?'var(--red)':p.risco==='alto'?'var(--warn)':p.risco==='medio'?'var(--cyan)':'var(--green)';
            const cobProjStr = p.cobProjetada < 900 ? p.cobProjetada+'d' : '∞';
            const dayPills = (p.diasDist||[]).map(d=>`<span class="pa-day-pill">${d.dayName} ${d.cx}cx</span>`).join('');
            const rowBg = !p.insumosOk ? 'background:rgba(255,71,87,.06);' : '';
            const rowBorder = !p.insumosOk ? 'border-left:3px solid var(--red);' : '';

            // Badge de insumos
            let insBadge = '';
            if(!p.temFichasTecnica){
              insBadge = `<span style="background:rgba(255,179,0,.12);color:var(--warn);padding:2px 6px;border-radius:4px;font-size:10px">Sem ficha</span>`;
            } else if(!insumosEstoqueData.length){
              insBadge = `<span style="background:rgba(255,255,255,.06);color:var(--text3);padding:2px 6px;border-radius:4px;font-size:10px">Sem estoque MP</span>`;
            } else if(!p.insumosOk){
              insBadge = `<span style="cursor:pointer;background:rgba(255,71,87,.2);color:var(--red);padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700" onclick="paToggleInsumos('pa-ins-${maq}-${pi}')">⚠️ Falta insumo ▾</span>`;
            } else {
              insBadge = `<span style="cursor:pointer;background:rgba(46,201,122,.1);color:var(--green);padding:2px 7px;border-radius:4px;font-size:10px" onclick="paToggleInsumos('pa-ins-${maq}-${pi}')">✅ OK ▾</span>`;
            }

            // Detalhes de insumos (colapsável)
            let insDetail = '';
            if(p.insumosStatus && p.insumosStatus.length){
              insDetail = `<tr id="pa-ins-${maq}-${pi}" style="display:none">
                <td colspan="11" style="padding:0">
                  <div style="background:var(--s2);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:10px 16px">
                    <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px;font-weight:700">Consumo de Insumos — ${p.prod}</div>
                    <table style="width:100%;border-collapse:collapse;font-size:11px">
                      <thead><tr style="background:rgba(255,255,255,.03)">
                        <th style="padding:5px 8px;text-align:left;color:var(--text3);font-size:10px">Insumo</th>
                        <th style="padding:5px 8px;text-align:right;color:var(--warn);font-size:10px">Necessário</th>
                        <th style="padding:5px 8px;text-align:right;color:var(--cyan);font-size:10px">Estoque Atual</th>
                        <th style="padding:5px 8px;text-align:right;color:var(--text3);font-size:10px">Saldo Final</th>
                      </tr></thead>
                      <tbody>${p.insumosStatus.map(ins => {
                        const sc = ins.falta ? 'var(--red)' : 'var(--green)';
                        const rowBg2 = ins.falta ? 'background:rgba(255,71,87,.07)' : '';
                        const estoqueStr = ins.estoqueAtual != null ? ins.estoqueAtual.toLocaleString('pt-BR',{maximumFractionDigits:3}) : '—';
                        const saldoStr = ins.saldo != null ? ins.saldo.toLocaleString('pt-BR',{maximumFractionDigits:3}) : '—';
                        return `<tr style="${rowBg2}">
                          <td style="padding:5px 8px;color:var(--text)">${ins.nome}</td>
                          <td style="padding:5px 8px;text-align:right;color:var(--warn);font-family:'JetBrains Mono',monospace">${ins.consumo.toLocaleString('pt-BR',{maximumFractionDigits:3})}</td>
                          <td style="padding:5px 8px;text-align:right;color:var(--cyan);font-family:'JetBrains Mono',monospace">${estoqueStr}</td>
                          <td style="padding:5px 8px;text-align:right;color:${sc};font-family:'JetBrains Mono',monospace;font-weight:700">${saldoStr}${ins.falta?' ⚠️':''}</td>
                        </tr>`;
                      }).join('')}</tbody>
                    </table>
                    ${p.insumosFaltando && p.insumosFaltando.length ? `
                    <div style="margin-top:8px;padding:8px 10px;background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);border-radius:6px;font-size:11px">
                      <div style="color:var(--red);font-weight:700;margin-bottom:4px">⛔ Insumos insuficientes para produzir ${p.cxAlocadas} cx:</div>
                      ${p.insumosFaltando.map(f=>`<div style="color:var(--red);padding:2px 0"><strong>${f.nome}</strong>: necessário ${f.consumo.toLocaleString('pt-BR',{maximumFractionDigits:3})} / estoque ${f.estoqueAtual!=null?f.estoqueAtual.toLocaleString('pt-BR',{maximumFractionDigits:3}):'—'} / <strong>déficit ${f.deficit.toLocaleString('pt-BR',{maximumFractionDigits:3})}</strong></div>`).join('')}
                    </div>`:'' }
                  </div>
                </td>
              </tr>`;
            }

            return `<tr style="${rowBg}${rowBorder}">
              <td><div style="font-weight:600;font-size:12px">${p.prod}</div><div style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace">Cód: ${p.cod||'—'}</div></td>
              <td style="max-width:200px;white-space:normal;line-height:1.5;font-size:11px">${p.motivo}</td>
              <td>${p.estoque != null ? p.estoque.toLocaleString('pt-BR') : '—'}</td>
              <td style="color:${cobColor};font-weight:700">${p.cobAtual}d</td>
              <td>${p.demandaSemanal}</td>
              <td style="color:var(--cyan);font-weight:700;font-size:13px">${p.cxAlocadas} cx</td>
              <td>${fmtHrs(p.hrsAlocadas)}</td>
              <td><span style="color:${p.pctMaquina>50?'var(--warn)':'var(--text2)'}">${p.pctMaquina}%</span><div class="cov-bar-track" style="margin-top:3px"><div class="cov-bar-fill" style="width:${Math.min(100,p.pctMaquina)}%;background:${p.pctMaquina>50?'var(--warn)':'var(--cyan)'}"></div></div></td>
              <td style="color:var(--green);font-weight:700">${cobProjStr}</td>
              <td>${insBadge}</td>
              <td style="white-space:normal">${dayPills||'—'}</td>
            </tr>${insDetail}`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

function paToggleInsumos(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}

function progToggleInsumos(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}

async function aplicarProgAutomaticaNoGantt(){
  if(!paResultados.length){ toast('Gere a programação automática primeiro','err'); return; }
  if(!confirm(`Aplicar ${paResultados.length} sugestões na programação?\n\nIsso criará novas solicitações para os produtos sugeridos.`)) return;
  const semanaSel = document.getElementById('pa-semana-sel')?.value;
  const monday    = semanaSel ? new Date(semanaSel+'T12:00:00') : getWeekMonday(new Date());
  let criados = 0;
  for(const sug of paResultados){
    if(!sug.cxAlocadas) continue;
    // Busca no catálogo real; se não achar, usa os dados já calculados na sugestão
    const ficha = getAllProdutos().find(p => String(p.cod)===String(sug.cod) || p.descricao===sug.prod);
    const pcMinUsar = (ficha && ficha.pc_min) || sug.pc_min || 0;
    const unidUsar  = (ficha && ficha.unid)   || sug.unid   || 1;
    const startDate = sug.diasDist && sug.diasDist.length > 0 ? sug.diasDist[0].date : dateStr(monday);
    const obj = {
      produto: sug.prod,
      prodCod: parseInt(sug.cod)||0,
      maquina: sug.maquina,
      pcMin: pcMinUsar,
      unidPorCx: unidUsar,
      qntCaixas: sug.cxAlocadas,
      qntUnid: sug.cxAlocadas * unidUsar,
      status: 'Pendente',
      dtSolicitacao: startDate,
      dtDesejada: startDate,
      obs: `Gerado automaticamente — ${sug.motivo.replace(/<[^>]*>/g,'')}`,
      updatedAt: new Date().toISOString()
    };
    await dbPut(obj);
    criados++;
  }
  await reload();
  switchTabSidebar('gantt');
  renderGantt();
  toast(`✅ ${criados} solicitações criadas na programação!`,'ok');
}

function simularCenario(){
  toast('Simulação: ajuste os parâmetros acima e clique em "Gerar Programação Automática" para ver o impacto.','ok');
}

function renderCalculos(){
  paPopulaSemanas();
  const alertEl = document.getElementById('pa-alerta');
  if (!alertEl) return;
  const temProjecao = (typeof projecaoCalculada !== 'undefined') && projecaoCalculada.length > 0;
  const temMaquinas = MAQUINAS.length > 0;
  const temProdutos = getAllProdutos().length > 0;
  let html = '';

  if (!temMaquinas) {
    html += '<div style="background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--red);margin-bottom:8px">'
      + '⛔ <strong>Nenhuma máquina cadastrada.</strong> Cadastre máquinas em <strong>Configurações → Máquinas</strong> para poder gerar a programação automática.'
      + '</div>';
  }
  if (!temProdutos) {
    html += '<div style="background:rgba(255,179,0,.1);border:1px solid rgba(255,179,0,.3);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">'
      + '⚠️ <strong>Nenhum produto cadastrado.</strong> Importe produtos em <strong>Configurações → Produtos → Excel</strong>.'
      + '</div>';
  }
  if (!temProjecao) {
    html += '<div style="background:rgba(255,179,0,.08);border:1px solid rgba(255,179,0,.25);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">'
      + '⚠️ <strong>Projeção de vendas não carregada.</strong> Importe estoque e projeção na aba <strong>Importação/API</strong>.'
      + '</div>';
  }
  if (temMaquinas && temProdutos) {
    // Verificar máquinas sem produtos vinculados
    const maqSemProdutos = MAQUINAS.filter(m => {
      const d = getMaquinaData(m);
      return !d || !Array.isArray(d.produtosCompativeis) || d.produtosCompativeis.length === 0;
    });
    if (maqSemProdutos.length > 0) {
      html += '<div style="background:rgba(0,212,255,.07);border:1px solid rgba(0,212,255,.2);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--cyan);margin-bottom:8px">'
        + 'ℹ️ <strong>Máquinas sem produtos vinculados:</strong> ' + maqSemProdutos.join(', ')
        + '. Vincule em <strong>Configurações → Máquinas → Produtos Compatíveis</strong>.'
        + '</div>';
    }
    // Verificar máquinas sem velocidade
    const maqSemVel = MAQUINAS.filter(m => {
      const d = getMaquinaData(m);
      return !d || !(parseFloat(d.pcMin) > 0);
    });
    if (maqSemVel.length > 0) {
      html += '<div style="background:rgba(255,179,0,.07);border:1px solid rgba(255,179,0,.2);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">'
        + '⚠️ <strong>Máquinas sem velocidade configurada:</strong> ' + maqSemVel.join(', ')
        + '. Configure em <strong>Configurações → Máquinas → Capacidade</strong>.'
        + '</div>';
    }
  }
  alertEl.innerHTML = html;
}

// init
(function paInit(){
  impLoadFromStorage();
  projLoadManual();
})();

window.toggleSidebar = toggleSidebar;
window.toggleTopbarMenu = toggleTopbarMenu;
window.handleLogin = handleLogin;
window.logout = () => import('./auth.js').then(m => m.logout());


// ===== WINDOW EXPORTS (onclick handlers) =====
window.clearFilters = clearFilters;
window.clearMaq = clearMaq;
window.clearProd = clearProd;
window.clearSearchQuery = clearSearchQuery;
window.clearStatus = clearStatus;
window.closeConf = closeConf;
window.closeForm = closeForm;
window.closeFuncDeactivateModal = closeFuncDeactivateModal;
window.closeFuncModal = closeFuncModal;
window.closeReorderModal = closeReorderModal;
window.closeSettings = closeSettings;
window.settingsNav = settingsNav;
window.toggleSnavGroup = toggleSnavGroup;
window.handleImportZip = handleImportZip;
window.confirmClearAll = confirmClearAll;
window.confirmDeactivate = confirmDeactivate;
window.doDelete = doDelete;
window.exportGanttPDF = exportGanttPDF;
window.exportGanttXLSX = exportGanttXLSX;
window.exportInsumosGeralPDF = exportInsumosGeralPDF;
window.exportInsumosGeralXLSX = exportInsumosGeralXLSX;
window.exportInsumosMaqPDF = exportInsumosMaqPDF;
window.exportInsumosMaqXLSX = exportInsumosMaqXLSX;
window.fteAddRow = fteAddRow;
window.ganttToday = ganttToday;
window.ganttWeek = ganttWeek;
window.ganttGoDate = ganttGoDate;
window.insGeralToday = insGeralToday;
window.insWeek = insWeek;
window.insGoDate = insGoDate;
window.insToday = insToday;
window.openAddFuncionario = openAddFuncionario;
window.openAddFuncProd = openAddFuncProd;
window.openEditFuncProd = openEditFuncProd;
window.openDesativarFuncProd = openDesativarFuncProd;
window.reativarFuncProd = reativarFuncProd;
window.excluirFuncProdUI = excluirFuncProdUI;
window.openForgotPassword = openForgotPassword;
window.closeForgotModal = closeForgotModal;
window.submitForgotPassword = submitForgotPassword;
window.adminEnviarResetUI = adminEnviarResetUI;
// Usuários do sistema
window.openAddUsuario = openAddUsuario;
window.openEditUsuario = openEditUsuario;
window.closeUsuarioModal = closeUsuarioModal;
window.saveUsuarioModal = saveUsuarioModal;
window.toggleUsuarioAtivo = toggleUsuarioAtivo;
window.renderUsuariosSistema = renderUsuariosSistema;
window.confirmarExcluirUsuario = confirmarExcluirUsuario;
window.openReorderModal = openReorderModal;
window.openSettings = openSettings;
window.carregarMaquinasFirestore = carregarMaquinasFirestore;
window.getMaquinaData = getMaquinaData;
window.getAllMaquinas = getAllMaquinas;
window.carregarSetupFirestore = carregarSetupFirestore;
window.salvarSetupFirestore = salvarSetupFirestore;
window.getSetupMin = getSetupMin;
window.calcCapacidadeMaquina = calcCapacidadeMaquina;
window.getPcMinMaquinaProduto = getPcMinMaquinaProduto;
window.carregarProdutosFirestore = carregarProdutosFirestore;
window.salvarProdutoFirestore = salvarProdutoFirestore;
window.getAllProdutos = getAllProdutos;

// ===== TELA DE GESTÃO DE SETUP (Configurações → Tempos de Setup) =====
let _setupRegistros = [];

async function recarregarSetup() {
  await carregarSetupFirestore();
  renderSetupMaquinas();
  toast('Setup recarregado!', 'ok');
}

async function renderSetupMaquinas() {
  try {
    const snap = await getDocs(collection(firestoreDB, 'setup_maquinas'));
    _setupRegistros = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) {
    _setupRegistros = [];
    toast('Erro ao carregar setup: ' + e.message, 'err');
    return;
  }
  const maqSel = document.getElementById('setup-filter-maq');
  if (maqSel) {
    const cv = maqSel.value;
    maqSel.innerHTML = '<option value="">Todas as máquinas</option>'
      + MAQUINAS.map(m => `<option value="${m}"${m === cv ? ' selected' : ''}>${m}</option>`).join('');
  }
  const filterMaq = (maqSel && maqSel.value) || '';
  const lista = filterMaq ? _setupRegistros.filter(r => r.maquina === filterMaq) : _setupRegistros;
  const tbody = document.getElementById('setup-lista');
  const empty = document.getElementById('setup-empty');
  const cnt   = document.getElementById('setup-count');
  if (cnt) cnt.textContent = _setupRegistros.length;
  if (!lista.length) {
    if (tbody) tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  const sorted = [...lista].sort((a,b) =>
    (a.maquina||'').localeCompare(b.maquina||'') ||
    (a.produto_origem||'').localeCompare(b.produto_origem||'') ||
    (a.produto_destino||'').localeCompare(b.produto_destino||''));
  if (tbody) tbody.innerHTML = sorted.map(r => {
    const tc = (r.tempo_setup === 0) ? 'var(--text3)' : (r.tempo_setup > 30) ? 'var(--red)' : (r.tempo_setup > 15) ? 'var(--warn)' : 'var(--cyan)';
    return `<tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--s2)'" onmouseout="this.style.background=''">
      <td style="padding:9px 14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--purple);font-weight:600">${r.maquina||'—'}</td>
      <td style="padding:9px 10px;font-size:12px;color:var(--text2)">${r.produto_origem||'—'}</td>
      <td style="padding:9px 10px;font-size:12px;color:var(--text2)">${r.produto_destino||'—'}</td>
      <td style="padding:9px 10px;text-align:center;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;color:${tc}">${r.tempo_setup ?? '—'} min</td>
      <td style="padding:9px 10px;text-align:right">
        <div style="display:flex;gap:5px;justify-content:flex-end">
          <button onclick="openEditSetup('${r.id}')" class="btn btn-ghost" style="padding:3px 9px;font-size:11px;color:var(--cyan)">✏</button>
          <button onclick="excluirSetup('${r.id}')" class="btn btn-ghost" style="padding:3px 9px;font-size:11px;color:#ff6b6b">🗑</button>
        </div>
      </td></tr>`;
  }).join('');
}

function _populateSetupSelects(maqVal, origemVal, destinoVal) {
  const maqInp  = document.getElementById('setup-maq-inp');
  const oriSel  = document.getElementById('setup-origem-inp');
  const destSel = document.getElementById('setup-destino-inp');
  if (!maqInp || !oriSel || !destSel) return;
  maqInp.innerHTML = '<option value="">— Selecione a máquina —</option>'
    + MAQUINAS.map(m => `<option value="${m}"${m === maqVal ? ' selected' : ''}>${m}</option>`).join('');
  const maqAtual = maqInp.value || maqVal;
  const maqData = getMaquinaData(maqAtual);
  let prods = [];
  if (maqData && Array.isArray(maqData.produtosCompativeis) && maqData.produtosCompativeis.length) {
    prods = maqData.produtosCompativeis.map(p => p.produto);
  } else if (maqAtual) {
    prods = getAllProdutos().filter(p => p.maquina === maqAtual).map(p => p.descricao);
  } else {
    prods = [...new Set(getAllProdutos().map(p => p.descricao))].sort();
  }
  const opts = (sel) => prods.length
    ? prods.map(p => `<option value="${p}"${p === sel ? ' selected' : ''}>${p}</option>`).join('')
    : '<option value="">— nenhum produto compatível —</option>';
  oriSel.innerHTML  = '<option value="">— Produto origem —</option>'  + opts(origemVal);
  destSel.innerHTML = '<option value="">— Produto destino —</option>' + opts(destinoVal);
}

function openAddSetup() {
  document.getElementById('setup-edit-id').value = '';
  document.getElementById('setup-modal-title').textContent = 'Novo Tempo de Setup';
  document.getElementById('setup-tempo-inp').value = '';
  const alertEl = document.getElementById('setup-modal-alert');
  if (alertEl) alertEl.style.display = 'none';
  _populateSetupSelects('', '', '');
  const maqInp = document.getElementById('setup-maq-inp');
  if (maqInp) maqInp.onchange = () => _populateSetupSelects(maqInp.value, '', '');
  document.getElementById('setup-modal').style.display = 'flex';
}

function openEditSetup(id) {
  const r = _setupRegistros.find(x => x.id === id);
  if (!r) return;
  document.getElementById('setup-edit-id').value = id;
  document.getElementById('setup-modal-title').textContent = 'Editar Setup';
  document.getElementById('setup-tempo-inp').value = r.tempo_setup ?? '';
  const alertEl = document.getElementById('setup-modal-alert');
  if (alertEl) alertEl.style.display = 'none';
  _populateSetupSelects(r.maquina, r.produto_origem, r.produto_destino);
  const maqInp = document.getElementById('setup-maq-inp');
  if (maqInp) maqInp.onchange = () => _populateSetupSelects(maqInp.value, '', '');
  document.getElementById('setup-modal').style.display = 'flex';
}

function closeSetupModal() { document.getElementById('setup-modal').style.display = 'none'; }

async function saveSetupModal() {
  const editId  = document.getElementById('setup-edit-id').value;
  const maquina = document.getElementById('setup-maq-inp').value;
  const origem  = document.getElementById('setup-origem-inp').value;
  const destino = document.getElementById('setup-destino-inp').value;
  const tempo   = document.getElementById('setup-tempo-inp').value;
  const alertEl = document.getElementById('setup-modal-alert');
  const erros = [];
  if (!maquina)  erros.push('Selecione a máquina.');
  if (!origem)   erros.push('Selecione o produto origem.');
  if (!destino)  erros.push('Selecione o produto destino.');
  if (origem && destino && origem === destino) erros.push('Origem e destino não podem ser iguais.');
  if (tempo === '' || isNaN(parseInt(tempo)) || parseInt(tempo) < 0) erros.push('Informe um tempo válido (0 ou mais minutos).');
  if (maquina && !MAQUINAS.includes(maquina)) erros.push('Máquina "' + maquina + '" não está cadastrada.');
  if (erros.length) {
    if (alertEl) { alertEl.textContent = erros.join(' '); alertEl.style.display = 'block'; }
    return;
  }
  if (alertEl) alertEl.style.display = 'none';
  try {
    const payload = { maquina, produto_origem: origem, produto_destino: destino, tempo_setup: parseInt(tempo), atualizadoEm: new Date().toISOString() };
    if (editId) {
      await setDoc(doc(firestoreDB, 'setup_maquinas', editId), payload);
      toast('Setup atualizado!', 'ok');
    } else {
      payload.criadoEm = new Date().toISOString();
      await addDoc(collection(firestoreDB, 'setup_maquinas'), payload);
      toast('Setup cadastrado!', 'ok');
    }
    await carregarSetupFirestore();
    closeSetupModal();
    renderSetupMaquinas();
  } catch(e) {
    if (alertEl) { alertEl.textContent = 'Erro ao salvar: ' + e.message; alertEl.style.display = 'block'; }
  }
}

async function excluirSetup(id) {
  if (!confirm('Remover este tempo de setup?')) return;
  try {
    await deleteDoc(doc(firestoreDB, 'setup_maquinas', id));
    await carregarSetupFirestore();
    renderSetupMaquinas();
    toast('Setup removido.', 'ok');
  } catch(e) { toast('Erro ao remover: ' + e.message, 'err'); }
}

window.renderSetupMaquinas = renderSetupMaquinas;
window.openAddSetup = openAddSetup;
window.openEditSetup = openEditSetup;
window.closeSetupModal = closeSetupModal;
window.saveSetupModal = saveSetupModal;
window.excluirSetup = excluirSetup;
window.recarregarSetup = recarregarSetup;

window.renderCadastroMaquinas = renderCadastroMaquinas;
window.openAddMaquina = openAddMaquina;
window.openEditMaquina = openEditMaquina;
window.closeMaqModal = closeMaqModal;
window.switchMaqTab = switchMaqTab;
window.calcMaqCapacidade = calcMaqCapacidade;
window.addMaqProdCompat = addMaqProdCompat;
window.removeMaqProdCompat = removeMaqProdCompat;
window.saveMaquinaModal = saveMaquinaModal;
window.excluirMaquinaFirestore = excluirMaquinaFirestore;
window.toggleMaqDetail = toggleMaqDetail;
window.toggleMaqCardDetail = toggleMaqCardDetail;
window.renderFichaTecnicaCfg = renderFichaTecnicaCfg;
window.ftCfgToggle = ftCfgToggle;
window.importFichaTecnicaExcel = loadFichaTecnica;
window.loadFichaTecnica = loadFichaTecnica;
window.excluirMaquinaFirestore = excluirMaquinaFirestore;
window.renderCadastroMaquinas = renderCadastroMaquinas;
window.openAddMaquina = openAddMaquina;
window.closeMaqModal = closeMaqModal;
window.saveMaquinaModal = saveMaquinaModal;
window.importarMaquinasExcel = importarMaquinasExcel;
window.renderProdutosCfg = renderProdutosCfg;
// window.prodCfgToggle = prodCfgToggle; // função removida
window.openAddProduto = openAddProduto;
window.closeProdModal = closeProdModal;
window.saveProdModal = saveProdModal;
window.deleteExtraProduto = deleteExtraProduto;
window.importProdutosExcel = importProdutosExcel;
window.downloadProdTemplate = downloadProdTemplate;
window.pdRestoreAll = pdRestoreAll;
window.prodSaveAll = prodSaveAll;
window.prodToday = prodToday;
window.prodSelectDay = prodSelectDay;
window.prodWeek = prodWeek;
window.prodGoDate = prodGoDate;
window.aponToday = aponToday;
window.aponSaveAll = aponSaveAll;
window.resetJornada = resetJornada;
window.toggleJornadaDay = toggleJornadaDay;
window.updateJornadaStyle = updateJornadaStyle;
window.saveForm = saveForm;
window.saveFuncModal = saveFuncModal;
window.saveJornada = saveJornada;
window.saveReorder = saveReorder;
window.tableWeekReset = tableWeekReset;
window.tableWeekNav = tableWeekNav;
window.toggleHdMenu = toggleHdMenu;
window.toggleTopbarMenu = toggleTopbarMenu;
window.goPg = goPg;
window.editRec = editRec;
window.askDel = askDel;
window.openForm = openForm;
window.onMaqChange = onMaqChange;
window.onACInput = onACInput;
window.closeAC = closeAC;
window.calcInfo = calcInfo;
window.renderMrpPanel = renderMrpPanel;
window.pickProdGrid = pickProdGrid;
window.setProdSelected = setProdSelected;
window.clearProd = clearProd;
window.showProdStep = showProdStep;
window.setMaqView = setMaqView;
window.filterMaqWeek = filterMaqWeek;
window.ganttSetWeek = ganttSetWeek;
window.aponSaveFunc = aponSaveFunc;
window.aponRecalcRow = aponRecalcRow;
window.pdFinalize = pdFinalize;
window.editFichaByCod = editFichaByCod;
window.saveFichaByCod = saveFichaByCod;
window.editFichaByDesc = editFichaByDesc;  // compat legado
window.reactivateFuncionario = reactivateFuncionario;
window.openDeactivate = openDesativarFuncProd;
window.deleteFuncionario = deleteFuncionario;
window.updateJornadaStyle = updateJornadaStyle;
window.updateHeader = updateHeader;
window.renderDashboard = renderDashboard;
window.renderTable = renderTable;
window.reload = reload;
window.loadReorderList = loadReorderList;

// ===== API SYNC EXPORTS =====
window.renderApiSync = renderApiSync;
window.apiTestarConexao = apiTestarConexao;
window.apiSincronizar = apiSincronizar;
window.importEstoque = importEstoque;
window.importProjecao = importProjecao;
window.importEstoqueInsumos = importEstoqueInsumos;
window.renderSaldoInsumos = renderSaldoInsumos;
window.exportSaldoInsumosXLSX = exportSaldoInsumosXLSX;
window.limparHistoricoImportacao = limparHistoricoImportacao;


window.renderApiSync = renderApiSync;
window.apiTestarConexao = apiTestarConexao;
window.apiSincronizar = apiSincronizar;
window.importEstoque = importEstoque;
window.importProjecao = importProjecao;
window.limparHistoricoImportacao = limparHistoricoImportacao;

window.renderProjecao = renderProjecao;
window.calcularProjecao = calcularProjecao;
window.renderProjecaoTabela = renderProjecaoTabela;
window.exportProjecaoXLSX = exportProjecaoXLSX;
window.abrirModalNovoItemProjecao = abrirModalNovoItemProjecao;
window.salvarItemProjecaoManual = salvarItemProjecaoManual;
window.projSetManual = projSetManual;

window.renderCalculos = renderCalculos;
window.gerarProgAutomarica = gerarProgAutomarica;
window.renderProgAutomaticaResultado = renderProgAutomaticaResultado;
window.aplicarProgAutomaticaNoGantt = aplicarProgAutomaticaNoGantt;
window.simularCenario = simularCenario;
window.pa_onSemanaChange = pa_onSemanaChange;
window.paToggleInsumos = paToggleInsumos;
window.progToggleInsumos = progToggleInsumos;
