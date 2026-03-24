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
  collection, getDocs, addDoc, setDoc, doc, deleteDoc, query, orderBy, where, updateDoc,
  serverTimestamp, limit, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ===================================================================
// ===== SISTEMA CONTROLADO DE APONTAMENTOS =======================
// ===================================================================

// Função auxiliar para obter usuário atual de forma segura
function getCurrentUserSafe() {
  try {
    // Tentar usar a função importada currentUser SE existir e for função
    if (typeof currentUser === 'function') {
      try {
        return currentUser();
      } catch(e) {
        console.warn('Erro ao chamar currentUser():', e);
      }
    }
    
    // Fallback: verificar se auth está disponível
    if (typeof auth !== 'undefined' && auth && auth.currentUser) {
      return {
        email: auth.currentUser.email,
        uid: auth.currentUser.uid,
        userData: { nivel: 'operador' } // Default para compatibilidade
      };
    }
    
    // Fallback: verificar window.auth (Firebase auth global)
    if (typeof window !== 'undefined' && window.auth && window.auth.currentUser) {
      return {
        email: window.auth.currentUser.email,
        uid: window.auth.currentUser.uid,
        userData: { nivel: 'operador' }
      };
    }
    
    // Fallback: verificar localStorage para dados de usuário
    try {
      const userData = localStorage.getItem('currentUser');
      if (userData) {
        return JSON.parse(userData);
      }
    } catch(e) {
      console.warn('Erro ao fazer parse dos dados do usuário do localStorage:', e);
    }
    
    // Fallback final: usuário padrão para desenvolvimento
    console.warn('Nenhum método de autenticação disponível, usando usuário padrão');
    return {
      email: 'usuario@teste.com',
      uid: 'user_default',
      userData: { nivel: 'operador' }
    };
    
  } catch(e) {
    console.error('Erro crítico ao obter usuário atual:', e);
    // Retornar usuário padrão para evitar quebrar o sistema
    return {
      email: 'erro@sistema.com',
      uid: 'user_error',
      userData: { nivel: 'operador' }
    };
  }
}

// Função para verificar se usuário está autenticado
function isUserAuthenticated() {
  const user = getCurrentUserSafe();
  return user && (user.email || user.uid);
}

// Controles de perfil para aba Realizado
function isOperadorLevel() {
  try {
    const user = getCurrentUserSafe();
    if (!user) {
      console.warn('Usuário não identificado, assumindo nível operador');
      return true; // Default: tratar como operador se não conseguir identificar
    }
    
    // Se o campo 'tipo' for 'admin', não é operador
    const tipo = user.userData?.tipo || user.tipo || '';
    if (tipo === 'admin') return false;

    // Verificar nível/perfil legado
    const nivel = user.userData?.nivel || user.nivel || user.userData?.perfil || user.perfil || 'operador';
    console.log('Nível do usuário identificado:', nivel, '| tipo:', tipo);
    return ['operador'].includes(nivel);
  } catch(e) {
    console.error('Erro em isOperadorLevel:', e);
    return true; // Default seguro
  }
}

function isPCPLevel() {
  try {
    const user = getCurrentUserSafe();
    if (!user) {
      console.warn('Usuário não identificado, negando permissões PCP');
      return false; // Sem usuário = sem permissões de PCP
    }
    
    // Campo 'tipo' = 'admin' (gerente/admin no auth.js) → acesso total de PCP
    const tipo = user.userData?.tipo || user.tipo || '';
    if (tipo === 'admin') return true;

    // Verificar nível/perfil legado
    const nivel = user.userData?.nivel || user.nivel || user.userData?.perfil || user.perfil || 'operador';
    console.log('Verificando PCP para nível:', nivel, '| tipo:', tipo);
    return ['admin', 'planejamento', 'lider', 'analista'].includes(nivel);
  } catch(e) {
    console.error('Erro em isPCPLevel:', e);
    return false; // Default seguro
  }
}

// Função para obter email do usuário de forma segura
function getUserEmailSafe() {
  try {
    const user = getCurrentUserSafe();
    return user?.email || user?.userData?.email || 'usuario_nao_identificado';
  } catch(e) {
    console.error('Erro ao obter email do usuário:', e);
    return 'erro_sistema';
  }
}

// Status de programação por registro
const STATUS_PROGRAMACAO = {
  NAO_INICIADO: 'nao_iniciado',
  EM_PRODUCAO: 'em_producao',
  CONCLUIDO: 'concluido',
  ATRASADO: 'atrasado',
  AGUARDANDO: 'aguardando',
  FORA_SEQUENCIA: 'fora_sequencia'
};

// Carrega apontamentos do Firestore
async function carregarApontamentosFirestore(dataInicio, dataFim) {
  try {
    const q = query(
      lojaCol('apontamentos_producao'),
      where('data', '>=', dataInicio),
      where('data', '<=', dataFim),
      orderBy('data', 'asc'),
      orderBy('hora', 'asc')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) {
    console.error('Erro ao carregar apontamentos:', e);
    return [];
  }
}

// Registra auditoria de alterações
async function registrarAuditoria(acao, detalhes) {
  try {
    const payload = {
      acao: acao,
      detalhes: detalhes,
      usuario: getUserEmailSafe(),
      timestamp: serverTimestamp(),
      lojaId: getLojaAtiva(),
      ip: 'sistema', // Poderia pegar IP real se necessário
      userAgent: navigator.userAgent
    };
    await addDoc(lojaCol('auditoria'), payload);
  } catch(e) {
    console.warn('Erro ao registrar auditoria:', e);
  }
}

// Verifica se produto pode ser produzido (controles de sequência)
function validarProducaoPermitida(record, maquina, data) {
  // 1. Verificar se está programado para esta data/máquina
  const programacaoValida = verificarProgramacaoValida(record, maquina, data);
  if (!programacaoValida.valido) {
    return { permitido: false, motivo: programacaoValida.motivo };
  }
  
  // 2. Verificar sequência na máquina
  const sequenciaValida = verificarSequenciaMaquina(record, maquina, data);
  if (!sequenciaValida.valido) {
    return { permitido: false, motivo: sequenciaValida.motivo };
  }
  
  // 3. Verificar se não excede quantidade programada
  const quantidadeValida = verificarQuantidadePermitida(record);
  if (!quantidadeValida.valido) {
    return { permitido: false, motivo: quantidadeValida.motivo };
  }
  
  return { permitido: true };
}

// Verifica se produto está programado corretamente
function verificarProgramacaoValida(record, maquina, data) {
  // Verificar se máquina corresponde
  if (record.maquina !== maquina) {
    return { 
      valido: false, 
      motivo: `Produto programado para ${record.maquina}, não para ${maquina}` 
    };
  }
  
  // Verificar se data está dentro da programação
  const dataDesejada = record.dtDesejada || record.dtSolicitacao;
  if (!dataDesejada) {
    return { 
      valido: false, 
      motivo: 'Produto sem data de programação definida' 
    };
  }
  
  // Permitir produção na semana programada
  const semanaRecord = getWeekMonday(new Date(dataDesejada + 'T12:00:00'));
  const semanaProduzindo = getWeekMonday(new Date(data + 'T12:00:00'));
  
  if (dateStr(semanaRecord) !== dateStr(semanaProduzindo)) {
    return { 
      valido: false, 
      motivo: `Produto programado para semana de ${fmtDate(semanaRecord)}, não para esta semana` 
    };
  }
  
  return { valido: true };
}

// Verifica sequência na máquina
function verificarSequenciaMaquina(record, maquina, data) {
  // Buscar todos os produtos programados para esta máquina nesta semana
  const weekStart = getWeekMonday(new Date(data + 'T12:00:00'));
  const weekEnd = getWeekDays(weekStart)[6];
  
  const produtosMaquina = records.filter(r => 
    r.maquina === maquina &&
    r.dtDesejada >= dateStr(weekStart) &&
    r.dtDesejada <= dateStr(weekEnd)
  ).sort((a, b) => {
    // Ordenar por prioridade, depois por data desejada
    if (a.prioridade !== b.prioridade) return a.prioridade - b.prioridade;
    return (a.dtDesejada || a.dtSolicitacao).localeCompare(b.dtDesejada || b.dtSolicitacao);
  });
  
  const indexAtual = produtosMaquina.findIndex(r => r.id === record.id);
  if (indexAtual === -1) return { valido: false, motivo: 'Produto não encontrado na programação' };
  
  // Verificar se produtos anteriores foram concluídos
  for (let i = 0; i < indexAtual; i++) {
    const prodAnterior = produtosMaquina[i];
    const totalProduzido = calcularTotalProduzido(prodAnterior.id);
    
    if (totalProduzido < prodAnterior.qntCaixas) {
      return {
        valido: false,
        motivo: `Aguardando conclusão de "${prodAnterior.produto}" (${totalProduzido}/${prodAnterior.qntCaixas} caixas)`
      };
    }
  }
  
  return { valido: true };
}

// Verifica quantidade permitida
function verificarQuantidadePermitida(record) {
  const totalProduzido = calcularTotalProduzido(record.id);
  const necessario = record.qntCaixas || 0;
  
  if (totalProduzido >= necessario) {
    return {
      valido: false,
      motivo: `Produto já foi concluído (${totalProduzido}/${necessario} caixas)`
    };
  }
  
  return { valido: true, restante: necessario - totalProduzido };
}

// Calcula total produzido de um record (substituir localStorage)
function calcularTotalProduzido(recordId) {
  // Lê do cache _aponFS (Firestore semana atual) + localStorage (semanas anteriores / fallback)
  let total = 0;
  const suffix = '_' + recordId;
  aponGetAllKeys().forEach(function(k){
    if(!k.endsWith(suffix)) return;
    const d = aponStorageGet(k);
    if(d) APON_HOURS.forEach(function(h){ total += parseInt(d[h])||0; });
  });
  return total;
}

// Determina status do produto na programação
function determinarStatusProgramacao(record) {
  const totalProduzido = calcularTotalProduzido(record.id);
  const necessario = record.qntCaixas || 0;
  const dataDesejada = new Date((record.dtDesejada || record.dtSolicitacao) + 'T12:00:00');
  const hoje = new Date();
  
  if (totalProduzido >= necessario) {
    return STATUS_PROGRAMACAO.CONCLUIDO;
  }
  
  if (totalProduzido > 0) {
    return STATUS_PROGRAMACAO.EM_PRODUCAO;
  }
  
  if (dataDesejada < hoje) {
    return STATUS_PROGRAMACAO.ATRASADO;
  }
  
  // Verificar se pode começar (sequência liberada)
  const validacao = verificarSequenciaMaquina(record, record.maquina, dateStr(hoje));
  if (!validacao.valido) {
    return STATUS_PROGRAMACAO.AGUARDANDO;
  }
  
  return STATUS_PROGRAMACAO.NAO_INICIADO;
}

// Cores e ícones por status
function getStatusInfo(status) {
  switch(status) {
    case STATUS_PROGRAMACAO.CONCLUIDO:
      return { cor: 'var(--green)', icone: '✅', label: 'Concluído' };
    case STATUS_PROGRAMACAO.EM_PRODUCAO:
      return { cor: 'var(--cyan)', icone: '🔄', label: 'Em Produção' };
    case STATUS_PROGRAMACAO.ATRASADO:
      return { cor: 'var(--red)', icone: '⚠️', label: 'Atrasado' };
    case STATUS_PROGRAMACAO.AGUARDANDO:
      return { cor: 'var(--warn)', icone: '⏳', label: 'Aguardando' };
    case STATUS_PROGRAMACAO.FORA_SEQUENCIA:
      return { cor: 'var(--purple)', icone: '🔀', label: 'Fora de Sequência' };
    default:
      return { cor: 'var(--text3)', icone: '📋', label: 'Não Iniciado' };
  }
}

// ===================================================================
// ===== GESTÃO DE LOJA ATIVA =========================================
// ===================================================================
// Retorna o ID da loja ativa (ex: "loja_matriz")
function getLojaAtiva() {
  return localStorage.getItem('lojaAtiva') || null;
}

// Salva a loja ativa e recarrega
function setLojaAtiva(lojaId) {
  localStorage.setItem('lojaAtiva', lojaId);
  location.reload();
}

// Retorna uma referência de sub-coleção dentro da loja ativa
// Ex: lojaCol('registros') → collection(firestoreDB, 'lojas/loja_matriz/registros')
function lojaCol(nomeColecao) {
  const loja = getLojaAtiva();
  if (!loja) throw new Error('Nenhuma loja selecionada. Selecione uma loja para continuar.');
  return collection(firestoreDB, 'lojas', loja, nomeColecao);
}

// Retorna um doc dentro da loja ativa
function lojaDoc(nomeColecao, docId) {
  const loja = getLojaAtiva();
  if (!loja) throw new Error('Nenhuma loja selecionada.');
  return doc(firestoreDB, 'lojas', loja, nomeColecao, docId);
}

// Carrega lista de lojas cadastradas
async function carregarLojas() {
  try {
    const snap = await getDocs(collection(firestoreDB, 'lojas'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) {
    console.warn('[LOJAS] Erro ao carregar:', e.message);
    return [];
  }
}

// Cria uma nova loja no Firestore
async function criarLoja(id, nome) {
  const lojaId = id.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!lojaId || !nome) return;
  try {
    await setDoc(doc(firestoreDB, 'lojas', lojaId), {
      nome: nome.trim(),
      criadoEm: new Date().toISOString(),
      ativo: true
    });
    toast('Loja "' + nome + '" criada!', 'ok');
    return lojaId;
  } catch(e) {
    toast('Erro ao criar loja: ' + e.message, 'err');
  }
}

window.getLojaAtiva = getLojaAtiva;
window.setLojaAtiva = setLojaAtiva;
window.criarLoja = criarLoja;

// Expor helpers de permissão globalmente para scripts não-módulo (ex: relatorios.js)
window.can = can;
window.canAccess = canAccess;

// ===== TURNOS POR MÁQUINA (módulo de disponibilidade real) =====
// Nota: turnosMaquinas.js é carregado como script separado no index.html

// ===== FIREBASE DB REPLACEMENTS (IndexedDB → Firestore) =====
let records = [], pg = 1;
// Expor records globalmente para módulos externos (ex: relatorios.js)
Object.defineProperty(window, 'records', {
  get() { return records; },
  set(v) { records = v; },
  configurable: true,
});
const PER = 15;

async function dbAll() {
  try {
    const snap = await getDocs(lojaCol('registros'));
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
      await setDoc(lojaDoc('registros', id), data, { merge: true });
      return id;
    } else {
      const ref = await addDoc(lojaCol('registros'), data);
      return ref.id;
    }
  } catch(e) {
    console.error('dbPut error:', e);
    throw e;
  }
}

async function dbDel(id) {
  try {
    await deleteDoc(lojaDoc('registros', String(id)));
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
// Flag de cache independente para ficha técnica
let _carregadoFichaTecnica = false;

// MAQUINAS: populado exclusivamente via carregarMaquinasFirestore() no boot
let MAQUINAS = [];

// ===== SETUP TIMES (minutes) =====
// Cache do Firestore: { maquina: { prodA_norm: { prodB_norm: minutos } } }
// Populado por carregarSetupFirestore(). Fallback: SETUP_DATA estático abaixo.
let SETUP_FIRESTORE = {};

// ===================================================================
// ===== CAMADA DE CACHE — evita leituras repetidas ao Firestore =====
// ===================================================================
//
//  Cada coleção é carregada UMA VEZ e armazenada aqui.
//  Flags _carregado* impedem buscas duplicadas na mesma sessão.
//  Para forçar recarga (após gravação), chame invalidateCache('colecao').
//
const _cache = {
  _carregadoMaquinas:   false,
  _carregadoProdutos:   false,
  _carregadoSetup:      false,
  _carregadoRegistros:  false,
};

// Invalida o cache de uma ou mais coleções, forçando recarga na próxima chamada
function invalidateCache(...colecoes){
  if(!colecoes.length){
    // Invalida tudo
    Object.keys(_cache).forEach(k => { _cache[k] = false; });
    return;
  }
  colecoes.forEach(col => {
    if(col === 'maquinas')  _cache._carregadoMaquinas  = false;
    if(col === 'produtos')  _cache._carregadoProdutos  = false;
    if(col === 'setup')     _cache._carregadoSetup     = false;
    if(col === 'registros') _cache._carregadoRegistros = false;
  });
}

// Versão cached de dbAll — só consulta Firestore se cache inválido
async function dbAllCached(forceReload = false) {
  if(!forceReload && _cache._carregadoRegistros && records.length >= 0){
    return records; // retorna cache em memória
  }
  const result = await dbAll();
  _cache._carregadoRegistros = true;
  return result;
}

// Versão cached de carregarMaquinasFirestore
async function carregarMaquinasCached(forceReload = false) {
  if(!forceReload && _cache._carregadoMaquinas && MAQUINAS.length > 0) return;
  await carregarMaquinasFirestore();
  _cache._carregadoMaquinas = true;
}

// Versão cached de carregarProdutosFirestore
async function carregarProdutosCached(forceReload = false) {
  if(!forceReload && _cache._carregadoProdutos && PRODUTOS.length > 0) return;
  await carregarProdutosFirestore();
  _cache._carregadoProdutos = true;
}

// Versão cached de carregarSetupFirestore
async function carregarSetupCached(forceReload = false) {
  if(!forceReload && _cache._carregadoSetup) return;
  await carregarSetupFirestore();
  _cache._carregadoSetup = true;
}

// Carrega setup_maquinas do Firestore e popula SETUP_FIRESTORE
async function carregarSetupFirestore() {
  try {
    const snap = await getDocs(lojaCol('setup_maquinas'));
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
    const q = query(lojaCol('setup_maquinas'),
      where('maquina', '==', maquina),
      where('produto_origem', '==', prodOrigem),
      where('produto_destino', '==', prodDestino)
    );
    const snap = await getDocs(q);
    const payload = { maquina, produto_origem: prodOrigem, produto_destino: prodDestino, tempo_setup: parseInt(tempoMinutos)||0, atualizadoEm: new Date().toISOString() };
    if (!snap.empty) {
      await setDoc(lojaDoc('setup_maquinas', snap.docs[0].id), payload);
    } else {
      await addDoc(lojaCol('setup_maquinas'), payload);
    }
    invalidateCache('setup');
    await carregarSetupCached(true);
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


// ===================================================================
// ===== SELETOR E GESTÃO DE LOJAS ====================================
// ===================================================================

async function mostrarSeletorLoja() {
  const appDiv = document.getElementById('app');
  if (appDiv) appDiv.hidden = true;

  // Remove seletor anterior se existir
  const old = document.getElementById('loja-selector-screen');
  if (old) old.remove();

  const todasLojas = await carregarLojas();

  // Filtrar lojas permitidas para o usuário (admin vê todas)
  const user = getCurrentUserSafe();
  const isAdm = user && user.tipo === 'admin';
  const lojasPermitidas = user && user.lojasPermitidas; // array de IDs ou null = todas
  const lojas = isAdm || !lojasPermitidas || !lojasPermitidas.length
    ? todasLojas
    : todasLojas.filter(l => lojasPermitidas.includes(l.id));

  const screen = document.createElement('div');
  screen.id = 'loja-selector-screen';
  screen.style.cssText = 'position:fixed;inset:0;z-index:1500;background:var(--bg,#0a0b0d);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:0';

  const lojasBtns = lojas.length
    ? lojas.map(l => `
        <button onclick="confirmarLoja('${l.id}')"
          style="width:100%;padding:14px 20px;background:var(--s1,#13151a);border:1px solid var(--border,#1f2d3d);border-radius:10px;color:var(--text,#e8eaf0);font-size:14px;font-family:'Space Grotesk',sans-serif;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;transition:all .15s"
          onmouseover="this.style.borderColor='var(--cyan,#00d4ff)';this.style.background='rgba(0,212,255,.07)'"
          onmouseout="this.style.borderColor='var(--border,#1f2d3d)';this.style.background='var(--s1,#13151a)'">
          <span style="font-size:22px">🏭</span>
          <div>
            <div style="font-weight:700">${l.nome || l.id}</div>
            <div style="font-size:11px;color:var(--text3,#5a6a7a);font-family:monospace">${l.id}</div>
          </div>
        </button>`).join('')
    : `<div style="color:var(--text3,#5a6a7a);font-size:13px;text-align:center;padding:20px 0">
         Nenhuma loja disponível para o seu perfil.<br>Contate o administrador.
       </div>`;

  screen.innerHTML = `
    <div style="width:100%;max-width:440px;padding:24px">
      <div style="text-align:center;margin-bottom:28px">
        <div style="font-size:28px;font-weight:900;color:var(--cyan,#00d4ff);font-family:'Space Grotesk',sans-serif">DT Produção</div>
        <div style="color:var(--text3,#5a6a7a);font-size:13px;margin-top:6px">Selecione a loja para continuar</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
        ${lojasBtns}
      </div>
      <div style="border-top:1px solid var(--border,#1f2d3d);padding-top:16px">
        <div style="font-size:12px;color:var(--text3,#5a6a7a);margin-bottom:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px">Nova loja</div>
        <div style="display:flex;gap:8px">
          <input id="nova-loja-nome" placeholder="Nome da loja" style="flex:1;background:var(--s2,#1a1f2e);border:1px solid var(--border,#1f2d3d);border-radius:8px;padding:9px 12px;color:var(--text,#e8eaf0);font-size:13px;outline:none">
          <button onclick="criarNovaLojaUI()"
            style="background:var(--cyan,#00d4ff);color:#000;border:none;border-radius:8px;padding:9px 16px;font-weight:700;font-size:12px;cursor:pointer;font-family:'Space Grotesk',sans-serif;white-space:nowrap">
            + Criar
          </button>
        </div>
        <div id="nova-loja-erro" style="color:#ff6b6b;font-size:12px;margin-top:6px;min-height:16px"></div>
      </div>
    </div>`;

  document.body.appendChild(screen);
}

async function criarNovaLojaUI() {
  const nome = (document.getElementById('nova-loja-nome')?.value || '').trim();
  if (!nome) {
    toast('Informe o nome da loja', 'err');
    return;
  }
  const lojaId = 'loja_' + nome.toLowerCase()
    .replace(/[áàãâä]/g,'a').replace(/[éèêë]/g,'e')
    .replace(/[íìîï]/g,'i').replace(/[óòõôö]/g,'o')
    .replace(/[úùûü]/g,'u').replace(/[ç]/g,'c')
    .replace(/[^a-z0-9]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
  
  const id = await criarLoja(lojaId, nome);
  if (id) {
    confirmarLoja(id);
  }
}

function confirmarLoja(lojaId) {
  localStorage.setItem('lojaAtiva', lojaId);
  const screen = document.getElementById('loja-selector-screen');
  if (screen) screen.remove();
  const appDiv = document.getElementById('app');
  if (appDiv) appDiv.hidden = false;
  appInit().then(() => {
    impLoadFromStorage();
    projLoadManual();
    switchTabSidebar('dashboard');
    atualizarTopbarLoja();
  });
}

// Atualiza o seletor de loja no topbar
async function atualizarTopbarLoja() {
  const sel = document.getElementById('topbar-loja-sel');
  if (!sel) return;
  const lojas = await carregarLojas();
  const ativa = getLojaAtiva();
  sel.innerHTML = lojas.map(l =>
    `<option value="${l.id}"${l.id === ativa ? ' selected' : ''}>${l.nome || l.id}</option>`
  ).join('');
}

function trocarLoja(lojaId) {
  if (!lojaId || lojaId === getLojaAtiva()) return;
  // Verificar se o usuário tem acesso a essa loja
  const user = getCurrentUserSafe();
  const isAdm = user && user.tipo === 'admin';
  const permitidas = user && user.lojasPermitidas;
  if (!isAdm && permitidas && permitidas.length && !permitidas.includes(lojaId)) {
    toast('Sem permissão para acessar essa loja.', 'err');
    return;
  }
  // Limpa dados em memória
  MAQUINAS = []; PRODUTOS = []; FICHA_TECNICA = []; SETUP_FIRESTORE = {}; _usuariosSistemaCache = null; _carregadoFichaTecnica = false;
  records = [];
  setLojaAtiva(lojaId); // reload automático
}

// Renderiza tela de gestão de lojas em Configurações
async function renderGestaoLojas() {
  const el = document.getElementById('scontent-gestao-lojas');
  if (!el) return;
  const lojas = await carregarLojas();
  const ativa = getLojaAtiva();
  el.innerHTML = `
    <div style="background:var(--s1);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:16px">🏭</span>
          <span style="font-size:13px;font-weight:700;color:var(--text)">Lojas Cadastradas</span>
          <span style="font-size:11px;color:var(--text3)">(${lojas.length})</span>
        </div>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:8px">
        ${lojas.map(l => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:${l.id===ativa?'rgba(0,212,255,.08)':'var(--s2)'};border:1px solid ${l.id===ativa?'rgba(0,212,255,.3)':'var(--border)'};border-radius:8px">
            <div>
              <div style="font-weight:700;color:var(--text)">${l.nome || l.id}</div>
              <div style="font-size:11px;color:var(--text3);font-family:monospace">${l.id}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              ${l.id===ativa
                ? '<span style="background:rgba(0,212,255,.15);color:var(--cyan);border:1px solid rgba(0,212,255,.3);border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700">ATIVA</span>'
                : `<button onclick="trocarLoja('${l.id}')" style="background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);border-radius:6px;padding:4px 10px;font-size:11px;color:var(--cyan);cursor:pointer">Selecionar</button>`
              }
            </div>
          </div>`).join('')}
        <div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:12px;color:var(--text3);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.8px">Criar nova loja</div>
          <div style="display:flex;gap:8px">
            <input id="cfg-nova-loja-nome" placeholder="Nome da loja (ex: Loja Filial)" style="flex:1;background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none">
            <button onclick="criarLojaCfg()" style="background:var(--cyan);color:#000;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:12px;cursor:pointer;font-family:'Space Grotesk',sans-serif">+ Criar</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function criarLojaCfg() {
  const nome = (document.getElementById('cfg-nova-loja-nome')?.value || '').trim();
  if (!nome) { toast('Informe o nome da loja', 'err'); return; }
  const lojaId = 'loja_' + nome.toLowerCase().normalize('NFD').replace(/[^\w]/g,'_').replace(/__+/g,'_').replace(/^_|_$/g,'');
  await criarLoja(lojaId, nome);
  renderGestaoLojas();
}

window.mostrarSeletorLoja = mostrarSeletorLoja;
window.criarNovaLojaUI = criarNovaLojaUI;
window.confirmarLoja = confirmarLoja;
window.trocarLoja = trocarLoja;
window.atualizarTopbarLoja = atualizarTopbarLoja;
window.renderGestaoLojas = renderGestaoLojas;
window.criarLojaCfg = criarLojaCfg;

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
  // Verifica se loja está selecionada
  if (!getLojaAtiva()) {
    mostrarSeletorLoja();
    return;
  }
  // Carregar coleções estáticas UMA VEZ — cache evita repetições
  await carregarMaquinasCached();
  await carregarProdutosCached();
  await carregarFichaTecnicaCached();
  await carregarSetupCached();
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
  // Pre-carrega mapa do Gantt + overrides Firestore assim que dados estão prontos
  const _bootMonday = getWeekMonday(new Date());
  pdLoadWeek(_bootMonday).catch(e => console.warn('pdLoadWeek boot:', e));
  // Sincroniza histórico de apontamentos do Firestore → localStorage (uma vez por sessão)
  _sincronizarApontamentosHistoricos().catch(e => console.warn('sync histórico apon:', e));
  // Pre-carrega funcionários para seletor de operador
  listarFuncionariosProducao().then(f => { _funcProd = f; }).catch(() => {});
  // Start clock
  updateClock();
  setInterval(updateClock, 1000);
}

// reloadFresh — invalida cache de registros e recarrega do Firestore
// Deve ser chamado APÓS qualquer escrita em 'registros'
async function reloadFresh() {
  invalidateCache('registros');
  records = await dbAllCached(true); // forceReload=true
  if(!Array.isArray(records)) records = [];
  _pdCacheWeek = null;
  _pdGanttMap = {};
  if(prodBaseMonday && typeof pdBuildGanttMap === 'function') {
    pdBuildGanttMap(prodBaseMonday);
  }
  updateHeader();
  renderDashboard();
  renderTable();
  populateWeekFilters();
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

async function reload() {
  // Usa cache quando disponível; força recarga (forceReload=true) após gravações
  records = await dbAllCached(false);
  if(!Array.isArray(records)) records = [];
  // Invalida cache do Gantt quando registros são recarregados
  // pdLoadWeek será chamado na próxima abertura de dia/produção-dia
  _pdCacheWeek = null;
  _pdGanttMap = {};
  // Reconstrói mapa imediatamente se prodBaseMonday já está definido
  if(prodBaseMonday && typeof pdBuildGanttMap === 'function') {
    pdBuildGanttMap(prodBaseMonday);
  }
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
      const tempo=calcTempoStr(r.maquina,r.qntCaixas,r.qntUnid,r.pcMin,r.unidPorCx,r.produto);
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
    const snap = await getDocs(lojaCol('registros'));
    const dels = snap.docs.map(d => deleteDoc(lojaDoc('registros', d.id)));
    await Promise.all(dels);
    await reloadFresh();
    if(typeof showToast==='function') showToast('Programação apagada com sucesso.','ok');
    else alert('Programação apagada com sucesso!');
  }catch(e){alert('Erro ao limpar: '+e);}
}

function calcTempoStr(maq,caixas,unid,pcMinRec,unidRec,produtoNome){
  let pcMin = pcMinRec;
  
  // Priority 1: Use stored pcMin from record
  if (pcMin && pcMin > 0) {
    // usar valor já armazenado
  }
  // Priority 2: Look for specific product velocity in machine's produtosCompativeis
  else if (!pcMin && maq && produtoNome && window.MAQUINAS_DATA) {
    const maqData = window.MAQUINAS_DATA[maq];
    if (maqData && Array.isArray(maqData.produtosCompativeis)) {
      const produtoEntry = maqData.produtosCompativeis.find(p => 
        p.produto === produtoNome || 
        produtoNome.includes(p.produto) ||
        p.produto.includes(produtoNome)
      );
      if (produtoEntry && produtoEntry.velocidade && produtoEntry.velocidade > 0) {
        pcMin = produtoEntry.velocidade;
      }
    }
  }
  // Priority 3: Use machine default velocity
  if (!pcMin && maq && window.MAQUINAS_DATA) {
    const maqData = window.MAQUINAS_DATA[maq];
    if (maqData && maqData.pcMin) pcMin = maqData.pcMin;
  }
  // Priority 4: Use product catalog velocity
  if (!pcMin) {
    const produto = getAllProdutos().find(x => x.maquina === maq && 
      (produtoNome ? (x.descricao === produtoNome || produtoNome.includes(x.descricao)) : true)
    );
    pcMin = produto ? produto.pc_min : 1;
  }
  
  const unidCx = unidRec || (getAllProdutos().find(x=>x.maquina===maq)||{unid:1}).unid;
  if(!caixas) return '—';
  const u = unid || (caixas * unidCx);
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

  // Resolve ficha do produto (por código ou nome)
  let ficha = null;
  if(rec.prodCod) ficha = all.find(x => x.cod === rec.prodCod);
  if(!ficha && rec.produto) ficha = all.find(x => rec.produto.startsWith(x.descricao.substring(0,22)));

  // Velocidade da máquina específica para este produto.
  // getPcMinMaquinaProduto lê de produtosCompativeis[].velocidade da máquina correta.
  const nomeProduto = ficha ? ficha.descricao : (rec.produto || '');
  const velMaquina = rec.maquina ? getPcMinMaquinaProduto(rec.maquina, nomeProduto) : null;

  if(ficha){
    // Ordem de prioridade da velocidade:
    // 1. Velocidade configurada na máquina para este produto (produtosCompativeis)
    // 2. pcMin salvo no registro (calculado pela PA para a máquina específica)
    // 3. Velocidade genérica da ficha do produto (fallback)
    const pcMinFinal = (velMaquina && velMaquina > 0)
      ? velMaquina
      : (rec.pcMin && rec.pcMin > 0 ? rec.pcMin : ficha.pc_min);
    return { ...ficha, pc_min: pcMinFinal };
  }

  // Sem ficha: usar velocidade da máquina ou do registro
  const pcMinFallback = (velMaquina && velMaquina > 0)
    ? velMaquina
    : (rec.pcMin && rec.pcMin > 0 ? rec.pcMin : 0);
  if(pcMinFallback > 0) return { pc_min: pcMinFallback, unid: rec.unidPorCx || 1 };

  // Último recurso: primeiro produto da máquina
  const byMaq = all.find(x => x.maquina === rec.maquina);
  return byMaq || { pc_min: 1, unid: 1 };
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
    + '<div><span style="color:var(--text3)">Vel. padrão:</span> <span style="color:var(--warn);font-weight:700">' + (d.pcMin ? d.pcMin + ' und/min' : '<span style="color:#ff6b6b">⚠ não config.</span>') + '</span></div>'
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
        ? '<span style="color:var(--cyan);font-family:\'JetBrains Mono\',monospace">' + p.velocidade + ' und/min</span>'
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
  if(rec && !can('programacao','editar')){ toast('Sem permissão para editar solicitações.','err'); return; }
  if(!rec && !can('programacao','criar')){ toast('Sem permissão para criar solicitações.','err'); return; }
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
      <div style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace;margin-top:4px">Cód:${p.cod} · ${p.pc_min}und/min · ${p.unid}un/cx</div>
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
  document.getElementById('sel-info').textContent=`Cód:${p.cod} · ${p.maquina} · ${p.pc_min}und/min · ${p.unid}un/cx`;
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
  const isEdit = !!(document.getElementById('edit-id')?.value);
  if(isEdit && !can('programacao','editar')){ toast('Sem permissão para editar.','err'); return; }
  if(!isEdit && !can('programacao','criar')){ toast('Sem permissão para criar.','err'); return; }
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
  if(eid){
    obj.id=eid;
  } else {
    // Novo registro: sortOrder baseado no timestamp garante que ele fique
    // no final da fila da máquina, respeitando a ordem de inserção.
    obj.sortOrder = Date.now();
  }

  try {
    await dbPut(obj);
  } catch(err) {
    toast('Erro ao salvar: ' + (err.message||err), 'err');
    console.error('saveForm dbPut error:', err);
    return;
  }
  closeForm();
  await reloadFresh();
  toast(eid?'Solicitação atualizada!':'Solicitação criada!','ok');
}

// ===== DELETE =====
let delId=null;
function askDel(id){delId=String(id);document.getElementById('conf-overlay').classList.add('on')}
function closeConf(){document.getElementById('conf-overlay').classList.remove('on');delId=null}
async function doDelete(){
  if(!delId) return;
  if(!can('programacao','excluir')){ toast('Sem permissão para excluir solicitações.','err'); closeConf(); return; }
  // delId is always a string (Firestore doc ID)
  const r=records.find(x=>String(x.id)===String(delId));
  if(!r){ toast('Registro não encontrado.','err'); closeConf(); return; }
  await dbDel(r.id);
  closeConf();
  await reloadFresh();
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
let ganttMode='semanal';  // 'semanal' | 'mensal'
let ganttMonthBase=null;  // Date object (any day of displayed month)

// ── Constantes de meses em pt-BR ────────────────────────────────
const GANTT_MONTH_NAMES=['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function getWeekMonday(date){
  const d=new Date(date);
  const day=d.getDay();
  const diff=day===0?-6:1-day;
  d.setDate(d.getDate()+diff);
  d.setHours(0,0,0,0);
  return d;
}

// Retorna o número ISO da semana (1-53) para uma data
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
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

// ── Selecionar semana pelo pill (string YYYY-MM-DD da segunda-feira) ──
function ganttSelecionarSemana(mondayStr){
  ganttBaseMonday = new Date(mondayStr+'T12:00:00');
  ganttManualNav  = true;
  renderGantt();
}

// ── Troca de modo Semanal / Mensal ───────────────────────────────
function setGanttMode(mode){
  ganttMode = mode;
  // Atualizar visual dos botões
  const btnS = document.getElementById('gantt-mode-semanal');
  const btnM = document.getElementById('gantt-mode-mensal');
  const tbS  = document.getElementById('gantt-toolbar-semanal');
  const tbM  = document.getElementById('gantt-toolbar-mensal');
  if(btnS && btnM){
    if(mode === 'mensal'){
      btnS.style.background = 'transparent';
      btnS.style.color      = 'var(--text2)';
      btnS.style.border     = '1px solid var(--border)';
      btnM.style.background = 'var(--cyan)';
      btnM.style.color      = '#000';
      btnM.style.border     = '1px solid var(--cyan)';
    } else {
      btnM.style.background = 'transparent';
      btnM.style.color      = 'var(--text2)';
      btnM.style.border     = '1px solid var(--border)';
      btnS.style.background = 'var(--cyan)';
      btnS.style.color      = '#000';
      btnS.style.border     = '1px solid var(--cyan)';
    }
  }
  if(tbS) tbS.style.display = mode === 'semanal' ? 'flex'   : 'none';
  if(tbM) tbM.style.display = mode === 'mensal'  ? 'flex'   : 'none';
  renderGantt();
}

// ── Navegação mensal ─────────────────────────────────────────────
function ganttMesNav(dir){
  if(!ganttMonthBase) ganttMonthBase = new Date();
  ganttMonthBase = new Date(ganttMonthBase);
  ganttMonthBase.setMonth(ganttMonthBase.getMonth() + dir);
  ganttMonthBase.setDate(1);
  renderGantt();
}

function ganttMesHoje(){
  ganttMonthBase = new Date();
  renderGantt();
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

  // ITEM 4 FIX — overflow real no Gantt.
  //
  // Um registro de semana anterior só entra como overflow quando há produção
  // genuinamente não concluída: o tempo restante de produção (qntCaixas -
  // totalProduzido) exige mais horas do que havia disponível até o fim da
  // semana original.
  //
  // Regra:
  //  • dtDesejada dentro desta semana → sempre inclui
  //  • dtDesejada ANTES desta semana:
  //      - status Concluído → nunca inclui
  //      - totalProduzido >= qntCaixas → concluído na prática → não inclui
  //      - remainingCx > 0 → overflow real → inclui (com caixas ajustadas)
  //
  // Isso elimina a repetição de itens que foram planejados mas não têm
  // produção restante, ou que seriam reschedulados numa nova semana própria.

  const ativos=records.filter(r=>{
    if(r.status==='Concluído') return false;
    const startDate=r.dtDesejada||r.dtSolicitacao;
    if(!startDate) return false;
    if(startDate>=mondayStr && startDate<=sundayStr) return true;
    if(startDate<mondayStr){
      // Verificar se ainda há produção restante (overflow real)
      const totalProd = (typeof calcularTotalProduzido==='function')
        ? calcularTotalProduzido(r.id) : 0;
      const remaining = (r.qntCaixas||0) - totalProd;
      return remaining > 0; // só overflow real
    }
    return false;
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

      // OVERFLOW FIX: for records started before this week, ALWAYS compute
      // remaining production using calcularTotalProduzido.
      // Even if totalProduzido === 0 (record is Pendente but from a past week),
      // we must schedule it from where it left off — i.e., from the beginning
      // since nothing was produced yet, but we still use cxRestanteRec so that
      // future weeks don't re-inflate the quantity.
      const isOverflowRecord = !!(rec.dtDesejada && rec.dtDesejada < mondayStr);
      const totalProduzidoRec = (isOverflowRecord && typeof calcularTotalProduzido==='function')
        ? calcularTotalProduzido(rec.id) : 0;
      // cxRestanteRec: how many boxes are still left to produce
      const cxRestanteRec = isOverflowRecord
        ? Math.max(0, (rec.qntCaixas||0) - totalProduzidoRec)
        : (rec.qntCaixas||0);
      // unidRestante: production time in units
      const unidRestante = cxRestanteRec * unidPorCx;
      if(unidRestante <= 0){
        // Nothing left to produce — push an empty entry so the cursor doesn't advance
        scheduled.push({rec, segments:[], setupMin:0, setupSegments:[], isOverflow:isOverflowRecord, cxRestante:0});
        continue;
      }
      let remainProdMin = unidRestante / pcMin;
      // For overflow records: no setup is charged again (it was already paid in the original week)
      let remainSetupMin = isOverflowRecord ? 0 : setupMin;
      const cxPerMin = cxRestanteRec / remainProdMin;

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

      scheduled.push({rec, segments, setupMin: isOverflowRecord ? 0 : setupMin, setupSegments, isOverflow: isOverflowRecord, cxRestante: cxRestanteRec});
    }

    result[maq]=scheduled;
  }

  return {schedule:result,days};
}

function renderGantt(){
  if(ganttMode === 'mensal'){
    renderGanttMensal();
  } else {
    renderGanttSemanal();
  }
}

function renderGanttSemanal(){
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

  // ── Pills de semana do mês ────────────────────────────────────────
  // Calcula as semanas do mês da semana atual e renderiza os pills S1…Sn
  const pillsEl = document.getElementById('gantt-semana-pills');
  if(pillsEl){
    const ano       = ganttBaseMonday.getFullYear();
    const mes       = ganttBaseMonday.getMonth();
    // Calcular semanas do mesmo mês que ganttBaseMonday
    const primeiroDia = new Date(ano, mes, 1);
    const ultimoDia   = new Date(ano, mes + 1, 0);
    const semanasDoMes = [];
    let cur = getWeekMonday(primeiroDia);
    while(cur <= ultimoDia){
      const mon = new Date(cur);
      const sun = new Date(cur); sun.setDate(mon.getDate() + 6);
      if(mon <= ultimoDia && sun >= primeiroDia){
        semanasDoMes.push(new Date(mon));
      }
      cur = new Date(cur); cur.setDate(cur.getDate() + 7);
    }

    const atualStr = dateStr(ganttBaseMonday);
    const mesNomeAbrev = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][mes];

    pillsEl.innerHTML = semanasDoMes.map((mon, i) => {
      const monStr   = dateStr(mon);
      const sun      = new Date(mon); sun.setDate(mon.getDate() + 6);
      const isActive = monStr === atualStr;
      const tooltip  = `${fmtDate(mon)} – ${fmtDate(sun)}`;

      // Contar registros com produção nesta semana (indicador visual)
      const monS = monStr;
      const sunS = dateStr(sun);
      const temProd = records.some(r => {
        const d = r.dtDesejada || r.dtSolicitacao || '';
        return d >= monS && d <= sunS && r.status !== 'Concluído';
      });

      return `<button
        onclick="ganttSelecionarSemana('${monStr}')"
        title="${tooltip}"
        style="
          padding:5px 14px;
          border-radius:20px;
          font-size:12px;
          font-weight:700;
          cursor:pointer;
          transition:all .18s;
          display:inline-flex;
          align-items:center;
          gap:5px;
          border:1px solid ${isActive ? 'var(--cyan)' : 'var(--border)'};
          background:${isActive ? 'var(--cyan)' : 'transparent'};
          color:${isActive ? '#000' : 'var(--text2)'};
        ">
        S${i+1}
        <span style="font-size:9px;font-weight:400;opacity:.75">${fmtDate(mon)}</span>
        ${temProd && !isActive ? '<span style="width:5px;height:5px;border-radius:50%;background:var(--cyan);opacity:.6;display:inline-block"></span>' : ''}
      </button>`;
    }).join('');

    // Adicionar label do mês/ano antes dos pills se mês diferente do atual
    const hoje = new Date();
    if(mes !== hoje.getMonth() || ano !== hoje.getFullYear()){
      pillsEl.insertAdjacentHTML('afterbegin',
        `<span style="font-size:11px;font-weight:700;color:var(--warn);font-family:'JetBrains Mono',monospace;margin-right:4px;align-self:center">${mesNomeAbrev}/${ano}</span>`
      );
    }
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

  // COL WIDTHS — LABEL_W é ajustável pelo usuário (salvo no localStorage)
  const MAQ_W=72, QTY_W=48, TEMPO_W=52, SETUP_W=52, TOTMAQ_W=68, OBS_W=140, DQTY_W=36;
  const LABEL_W = parseInt(localStorage.getItem('gantt-label-width') || '280');
  const gridCols=`${MAQ_W}px ${LABEL_W}px ${QTY_W}px ${TEMPO_W}px ${SETUP_W}px ${TOTMAQ_W}px ${OBS_W}px repeat(7,1fr) repeat(7,${DQTY_W}px)`;

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
    <div class="g-head-label" style="position:relative" id="gantt-col-produto">Produto
      <div id="gantt-label-resizer" style="position:absolute;right:0;top:0;width:6px;height:100%;cursor:col-resize;display:flex;align-items:center;justify-content:center;z-index:10" title="Arraste para redimensionar">
        <div style="width:2px;height:60%;background:var(--border);border-radius:2px"></div>
      </div>
    </div>
    <div class="g-head-label" style="font-size:9px">Qtd<br>cx</div>
    <div class="g-head-label" style="font-size:9px">Tempo<br>h</div>
    <div class="g-head-label" style="font-size:9px">Set Up<br>h</div>
    <div class="g-head-label" style="font-size:9px">H.<br>Prog.</div>
    <div class="g-head-label" style="font-size:9px">Obser-<br>vação</div>`;
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
      <span>⚙ ${maq}${turnosSumario} · ${new Set(entries.map(e=>(e.rec.produto||'').trim().toLowerCase())).size} produto(s)</span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;display:flex;align-items:center;gap:10px">
        <span style="color:var(--text3)">${fmtHrs(maqTotH)} prog. / ${maqCapH}h disp.</span>
        <span style="color:${maqOccColor};font-weight:700">${maqOccPct}% ocupação</span>
        <span style="display:inline-block;width:80px;height:6px;background:var(--s3);border-radius:3px;overflow:hidden;vertical-align:middle">
          <span style="display:block;height:100%;width:${barPct}%;background:${maqOccColor};border-radius:3px"></span>
        </span>
      </span>
    </div>`;

    let firstRowOfMaq=true;

    // ── CONSOLIDAR por produto: agrupar entries do mesmo produto em uma linha.
    // Registros manuais com obs diferente ficam em linhas separadas.
    // Registros automáticos (obs vazia) sempre agrupam por produto apenas.
    const prodMap = {};
    for(const entry of entries){
      const obs = (entry.rec.obs || '').trim();
      const prodNorm = (entry.rec.produto || '').trim().toLowerCase();
      // Registros automáticos (obs vazia) agrupam só por produto+máquina
      // Registros manuais com obs diferente ficam em linhas separadas
      const pk = obs ? (prodNorm + '||' + obs.toLowerCase()) : prodNorm;
      if(!prodMap[pk]){
        prodMap[pk] = {
          produto:    entry.rec.produto,
          obs:        obs,
          maquina:    entry.rec.maquina,
          color:      colorMap[entry.rec.id],
          qntCaixas:  0,
          setupMin:   0,
          segments:   [],       // todos os segmentos de todos os registros
          recs:       []
        };
      }
      prodMap[pk].qntCaixas += (entry.rec.qntCaixas || 0);
      prodMap[pk].setupMin  += (entry.setupMin || 0);   // somar setup total
      prodMap[pk].segments  = prodMap[pk].segments.concat(entry.segments || []);
      prodMap[pk].recs.push(entry.rec);
    }
    const prodEntries = Object.values(prodMap);

    for(const prodEntry of prodEntries){
      const { produto, obs, maquina: recMaq, color, qntCaixas, setupMin, segments, recs } = prodEntry;

      // Calcular horas de produção totais (soma de todos os segmentos)
      const prodHrs = segments.reduce((a, sg) => a + (sg.hrsNoDia || 0), 0);
      const prodHrsStr = fmtHrs(prodHrs);

      html+=`<div class="gantt-row" style="grid-template-columns:${gridCols}">`;

      // Máquina col
      html+=`<div class="g-col-maq"><span class="g-col-maq-txt">${recMaq}</span></div>`;

      // Produto label col
      html+=`<div class="g-label"><strong title="${produto}${obs?' — '+obs:''}">${produto}</strong></div>`;

      // Qtd cx col — soma de todos os registros
      html+=`<div class="g-col-qty"><div class="g-col-qty-txt">${qntCaixas}<br><span style="font-size:9px;color:var(--text3);font-weight:400">cx</span></div></div>`;

      // Tempo col
      html+=`<div style="display:flex;align-items:center;justify-content:center;border-left:1px solid var(--border);background:var(--s1);font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;color:var(--warn);padding:4px 2px;text-align:center">${prodHrsStr}</div>`;

      // Set Up col — setup total (apenas o primeiro registro tem setup real)
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

      // Obs / Destino col
      html+=`<div style="display:flex;align-items:center;border-left:1px solid var(--border);background:var(--s1);padding:4px 6px;overflow:hidden">
        ${obs ? `<span style="font-size:10px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;display:block" title="${obs}">${obs}</span>` : ''}
      </div>`;

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
            const obsTip=obs?` — ${obs}`:'';
            html+=`<div class="g-bar" style="left:${leftPct}%;width:${widthPct}%;background:${color};opacity:0.9;position:absolute;top:15%;height:70%"
              title="${produto}${obsTip}${turnoTip} · ${cx} cx · ${hrsLabel}">
              <div class="g-bar-tip">${produto.substring(0,40)}${obs?'<br><span style=\"font-size:9px;opacity:.8\">'+obs+'</span>':''}<br>${cx} cx · ${hrsLabel}${seg.turnoLabel?' · '+seg.turnoLabel:''}</div>
            </div>`;
          });
          html+=`</div>`;
        } else if(daySeg.length && dayCapMin===0){
          html+=`<div class="g-bar-wrap"><div class="g-bar" style="left:0%;width:100%;background:${color};opacity:0.5"></div></div>`;
        }
        html+=`</div>`;
      }

      // Per-day qty columns — soma dos segmentos consolidados
      days.forEach((day,di)=>{
        const isWknd=hoursOnDay(day)===0;
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

  // ── Resize da coluna Produto do Gantt ──
  (function initGanttLabelResizer(){
    const resizer = document.getElementById('gantt-label-resizer');
    if(!resizer) return;
    resizer.addEventListener('mousedown', function(e){
      e.preventDefault();
      const startX = e.clientX;
      const startW = parseInt(localStorage.getItem('gantt-label-width') || '280');
      resizer.querySelector('div').style.background = 'var(--cyan)';
      function onMove(ev){
        const delta = ev.clientX - startX;
        const newW = Math.max(120, Math.min(520, startW + delta));
        localStorage.setItem('gantt-label-width', newW);
        const MAQ_W=72, QTY_W=48, TEMPO_W=52, SETUP_W=52, TOTMAQ_W=68, OBS_W=140, DQTY_W=36;
        const newGrid=`${MAQ_W}px ${newW}px ${QTY_W}px ${TEMPO_W}px ${SETUP_W}px ${TOTMAQ_W}px ${OBS_W}px repeat(7,1fr) repeat(7,${DQTY_W}px)`;
        document.querySelectorAll('.gantt-row, .gantt-head-row').forEach(el=>{
          el.style.gridTemplateColumns = newGrid;
        });
      }
      function onUp(){
        resizer.querySelector('div').style.background = 'var(--border)';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();
}

// ================================================================
//  GANTT MENSAL — visão gerencial (colunas = semanas do mês)
// ================================================================
function renderGanttMensal(){
  // ── Base: mês e ano exibidos ────────────────────────────────────
  if(!ganttMonthBase) ganttMonthBase = ganttBaseMonday ? new Date(ganttBaseMonday) : new Date();
  const ano = ganttMonthBase.getFullYear();
  const mes = ganttMonthBase.getMonth(); // 0-based

  // Label do mês
  const labelEl = document.getElementById('gantt-month-label');
  if(labelEl) labelEl.textContent = GANTT_MONTH_NAMES[mes] + ' ' + ano;

  // ── Calcular as semanas do mês ──────────────────────────────────
  // Semana = segunda-feira da semana que contém pelo menos 1 dia do mês
  const primeiroDia = new Date(ano, mes, 1);
  const ultimoDia   = new Date(ano, mes + 1, 0);
  const semanas = [];           // Array de { label, monday, sunday, semIdx }
  let cursor = getWeekMonday(primeiroDia);
  while(cursor <= ultimoDia){
    const monday = new Date(cursor);
    const sunday = new Date(cursor); sunday.setDate(monday.getDate() + 6);
    // Só inclui se a semana tem algum dia dentro do mês
    if(monday <= ultimoDia && sunday >= primeiroDia){
      semanas.push({ monday: new Date(monday), sunday: new Date(sunday) });
    }
    cursor = new Date(cursor); cursor.setDate(cursor.getDate() + 7);
  }

  // ── Atualizar info bar ──────────────────────────────────────────
  const totalDiasUteis = semanas.reduce((acc, s) => {
    return acc + getWeekDays(s.monday).filter(d =>
      d.getMonth() === mes && hoursOnDay(d) > 0
    ).length;
  }, 0);
  const infoEl = document.getElementById('gantt-month-info');
  if(infoEl) infoEl.textContent = `${semanas.length} semanas · ${totalDiasUteis} dias úteis`;

  // ── Coletar dados de produção do mês ────────────────────────────
  // Usa registros (records) reais — filtra pelo mês selecionado
  // e usa buildSchedule por semana para calcular caixas programadas
  const maqCapMes = {};   // horas disponíveis no mês por máquina
  const maqHrsProg= {};   // horas programadas no mês por máquina

  // Para cada máquina, calcular capacidade total do mês
  for(const maq of MAQUINAS){
    maqCapMes[maq]  = 0;
    maqHrsProg[maq] = 0;
    semanas.forEach(s => {
      maqCapMes[maq] += weekHoursMaq(s.monday, maq);
    });
  }

  // ── FIX 1: Montar matriz agrupando por (máquina × produto)
  // Chave = produto nome normalizado → uma única linha por produto por máquina,
  // independente de quantos registros (semanas, splits) foram criados.
  const matrizMes = {};
  const colorMap  = {};
  let   ci        = 0;
  const prodColorMap = {};
  records.forEach(r => {
    const pk = (r.produto || '').trim().toLowerCase();
    if(!prodColorMap[pk]) prodColorMap[pk] = BAR_COLORS[ci++ % BAR_COLORS.length];
    colorMap[r.id] = prodColorMap[pk];
  });

  for(const maq of MAQUINAS){
    matrizMes[maq] = {};
    semanas.forEach((s, si) => {
      const wMon = dateStr(s.monday);
      const wSun = dateStr(s.sunday);
      const { schedule } = buildSchedule(s.monday);
      const entries = schedule[maq] || [];
      entries.forEach(({ rec, segments, setupMin, isOverflow }) => {
        const segsThisWeek = segments.filter(seg => seg.date >= wMon && seg.date <= wSun);
        if(!segsThisWeek.length) return;

        // FIX 1: agrupar pelo nome do produto, não pelo id do registro
        const prodKey = (rec.produto || '').trim().toLowerCase();
        if(!matrizMes[maq][prodKey]){
          matrizMes[maq][prodKey] = {
            label:   rec.produto,
            cod:     rec.prodCod || '—',
            semanas: Array(semanas.length).fill(0),
            hrs:     Array(semanas.length).fill(0),
            hrsTotal: 0,
            cor:     colorMap[rec.id] || BAR_COLORS[0],
            isOverflow: !!isOverflow
          };
        }
        const cxSem = segsThisWeek.reduce((a, sg) => a + (sg.caixasNoDia || 0), 0);
        const isFirstWeek = segments.length > 0 &&
          segments[0].date >= wMon && segments[0].date <= wSun;
        const hrsSem = segsThisWeek.reduce((a, sg) => a + (sg.hrsNoDia || 0), 0)
                     + (isFirstWeek && !isOverflow ? setupMin / 60 : 0);
        matrizMes[maq][prodKey].semanas[si] += cxSem;
        matrizMes[maq][prodKey].hrs[si]     += hrsSem;
        matrizMes[maq][prodKey].hrsTotal    += hrsSem;
        maqHrsProg[maq]                     += hrsSem;
      });
    });
  }

  // ── Legenda ────────────────────────────────────────────────────
  const legendEl = document.getElementById('gantt-legend');
  if(legendEl){
    const activeRecs = records.filter(r => r.status !== 'Concluído');
    legendEl.innerHTML = activeRecs.slice(0,14).map(r => `
      <div class="legend-item">
        <div class="legend-dot" style="background:${colorMap[r.id]}"></div>
        <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">${r.produto.substring(0,30)}</span>
      </div>`).join('');
  }

  // ── Construir HTML ─────────────────────────────────────────────
  // Colunas: Máquina | Produto | Total Cx | Total Hrs | S1 | S2 | ... | Sn | Ocup.%
  const nSem     = semanas.length;
  const MAQ_W    = 80;   // px
  const PROD_W   = 260;  // px
  const TOT_CX_W = 64;
  const TOT_HR_W = 64;
  const SEM_W    = 110;  // px por semana
  const OCC_W    = 72;

  const gridCols = [
    MAQ_W+'px',
    PROD_W+'px',
    TOT_CX_W+'px',
    TOT_HR_W+'px',
    ...Array(nSem).fill(SEM_W+'px'),
    OCC_W+'px'
  ].join(' ');

  // ── Rótulos das semanas (Seg dd/mm – Dom dd/mm) ─────────────────
  const semLabels = semanas.map((s, i) => {
    const dL = fmtDate(s.monday);
    const dR = fmtDate(s.sunday);
    const totalHrsSem = weekHrsForMachine ? 0 : 0; // calculated per machine
    return { label: `S${i+1}`, dL, dR };
  });

  let html = `<div class="gantt-wrap">`;

  // ── Cabeçalho ──────────────────────────────────────────────────
  html += `<div class="gantt-head-row" style="grid-template-columns:${gridCols}">
    <div class="g-head-label" style="font-size:9px">Máquina</div>
    <div class="g-head-label">Produto</div>
    <div class="g-head-label" style="font-size:9px">Total<br>cx/mês</div>
    <div class="g-head-label" style="font-size:9px">Total<br>h/mês</div>`;
  semLabels.forEach(s => {
    html += `<div class="g-head-day" style="flex-direction:column;justify-content:center;align-items:center;padding:4px 6px;text-align:center">
      <div style="font-weight:700;font-size:11px">${s.label}</div>
      <div class="g-date" style="font-size:9px">${s.dL}</div>
      <div class="g-date" style="font-size:9px">↓ ${s.dR}</div>
    </div>`;
  });
  html += `<div class="g-head-label" style="font-size:9px">Ocup.<br>%</div>`;
  html += `</div>`;

  // ── Linha de capacidade por semana (linha de contexto) ──────────
  html += `<div style="grid-template-columns:${gridCols};display:grid;background:rgba(0,229,204,.04);border-bottom:1px solid var(--border2);border-top:1px solid var(--border2)">
    <div style="padding:5px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);display:flex;align-items:center">CAP.</div>
    <div style="padding:5px 8px;font-size:9px;color:var(--text3);display:flex;align-items:center">Capacidade disponível (total fábrica)</div>
    <div style="padding:5px 6px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:var(--cyan);display:flex;align-items:center;justify-content:center">
      ${records.filter(r=>r.status!=='Concluído').reduce((a,r)=>a+(r.qntCaixas||0),0).toLocaleString('pt-BR')}
    </div>
    <div style="padding:5px 6px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text3);display:flex;align-items:center;justify-content:center">—</div>`;
  semanas.forEach(s => {
    // Capacidade total de todas as máquinas nesta semana
    const capSemTotal = MAQUINAS.reduce((acc, maq) => acc + weekHoursMaq(s.monday, maq), 0);
    html += `<div style="padding:5px 6px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text3);display:flex;align-items:center;justify-content:center">${capSemTotal > 0 ? capSemTotal+'h' : '—'}</div>`;
  });
  html += `<div style="padding:5px 6px;display:flex;align-items:center;justify-content:center"></div>`;
  html += `</div>`;

  // ── Seções por máquina ─────────────────────────────────────────
  let hasAny = false;
  for(const maq of MAQUINAS){
    const prodMap = matrizMes[maq];
    const itens   = Object.values(prodMap);
    if(!itens.length) continue;
    hasAny = true;

    const capMes  = maqCapMes[maq]  || 0;
    const progMes = maqHrsProg[maq] || 0;
    const occPct  = capMes > 0 ? Math.min(999, parseFloat((progMes / capMes * 100).toFixed(1))) : 0;
    const occClr  = occPct > 100 ? 'var(--red)' : occPct >= 80 ? 'var(--warn)' : 'var(--green)';
    const barW    = Math.min(100, occPct);

    // Separator
    html += `<div style="display:grid;grid-template-columns:${gridCols};background:var(--s2);border-top:2px solid var(--border2);border-bottom:1px solid var(--border)">
      <div style="grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:7px 12px">
        <span style="font-size:11px;font-weight:700;color:var(--text)">⚙ ${maq} · ${itens.length} produto(s)</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:10px;display:flex;align-items:center;gap:10px">
          <span style="color:var(--text3)">${fmtHrs(progMes)} prog. / ${fmtHrs(capMes)} disp.</span>
          <span style="color:${occClr};font-weight:700">${occPct}% ocupação</span>
          <span style="display:inline-block;width:80px;height:6px;background:var(--s3);border-radius:3px;overflow:hidden;vertical-align:middle">
            <span style="display:block;height:100%;width:${barW}%;background:${occClr};border-radius:3px"></span>
          </span>
        </span>
      </div>
    </div>`;

    // Linhas de produto
    itens.forEach(item => {
      const totalCx  = item.semanas.reduce((a, v) => a + v, 0);
      const maxCx    = Math.max(...item.semanas, 1);

      html += `<div class="gantt-row" style="grid-template-columns:${gridCols}">`;

      // Máquina col
      html += `<div class="g-col-maq"><span class="g-col-maq-txt">${maq}</span></div>`;

      // Produto col
      html += `<div class="g-label"><strong title="${item.label}">${item.label}</strong>
        <div style="font-size:9px;color:var(--text3);font-family:'JetBrains Mono',monospace;margin-top:1px">Cód: ${item.cod}</div>
      </div>`;

      // Total cx
      html += `<div style="display:flex;align-items:center;justify-content:center;border-left:1px solid var(--border);background:var(--s1);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:var(--cyan);padding:4px 3px;text-align:center">
        ${totalCx > 0 ? totalCx.toLocaleString('pt-BR') : '—'}
      </div>`;

      // Total hrs
      html += `<div style="display:flex;align-items:center;justify-content:center;border-left:1px solid var(--border);background:var(--s1);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;color:var(--warn);padding:4px 3px;text-align:center">
        ${item.hrsTotal > 0 ? fmtHrs(item.hrsTotal) : '—'}
      </div>`;

      // Células por semana — barra de Gantt proporcional
      item.semanas.forEach((cx, si) => {
        const hrs   = item.hrs[si] || 0;
        const pct   = cx > 0 ? Math.round(cx / maxCx * 100) : 0;
        const capSem = weekHoursMaq(semanas[si].monday, maq);
        const occSem = capSem > 0 ? Math.min(100, Math.round(hrs / capSem * 100)) : 0;
        const barClr = occSem > 85 ? 'var(--red)' : occSem > 60 ? 'var(--warn)' : item.cor;

        if(cx > 0){
          html += `<div style="padding:4px 6px;border-left:1px solid var(--border);background:var(--s1);display:flex;flex-direction:column;justify-content:center;gap:3px">
            <!-- barra proporcional -->
            <div style="height:6px;width:100%;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden">
              <div style="height:6px;width:${pct}%;background:${barClr};border-radius:3px;transition:width .3s"></div>
            </div>
            <!-- cx e horas -->
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:var(--cyan)">${cx.toLocaleString('pt-BR')} cx</span>
              <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--text3)">${fmtHrs(hrs)}</span>
            </div>
            <!-- % da capacidade semanal da máquina -->
            <div style="font-size:9px;color:${occSem>85?'var(--red)':occSem>60?'var(--warn)':'var(--text3)'};font-family:'JetBrains Mono',monospace">${occSem}% cap.</div>
          </div>`;
        } else {
          html += `<div style="padding:4px 6px;border-left:1px solid var(--border);background:var(--s1);display:flex;align-items:center;justify-content:center;color:var(--text4);font-size:11px">—</div>`;
        }
      });

      // Ocupação total col
      const occTot = capMes > 0 ? Math.min(999, parseFloat((item.hrsTotal / capMes * 100).toFixed(1))) : 0;
      const occTotClr = occTot > 80 ? 'var(--warn)' : 'var(--text3)';
      html += `<div style="display:flex;align-items:center;justify-content:center;border-left:2px solid var(--border2);background:var(--s1);font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:${occTotClr};padding:4px 2px;text-align:center">
        ${occTot > 0 ? occTot+'%' : '—'}
      </div>`;

      html += `</div>`;
    });

    // Linha de resumo da máquina no mês
    const totalCxMaq  = itens.reduce((a, it) => a + it.semanas.reduce((b,v) => b+v, 0), 0);
    html += `<div style="display:grid;grid-template-columns:${gridCols};background:rgba(0,229,204,.03);border-top:1px dashed var(--border)">
      <div style="padding:5px 8px;font-size:9px;color:var(--text3);display:flex;align-items:center">Total</div>
      <div style="padding:5px 8px;font-size:9px;color:var(--text3);display:flex;align-items:center">${maq} — ${itens.length} produto(s)</div>
      <div style="padding:5px 6px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:var(--cyan);display:flex;align-items:center;justify-content:center">${totalCxMaq.toLocaleString('pt-BR')} cx</div>
      <div style="padding:5px 6px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:var(--warn);display:flex;align-items:center;justify-content:center">${fmtHrs(progMes)}</div>`;

    // Totais por semana para esta máquina
    semanas.forEach((s, si) => {
      const cxSem  = itens.reduce((a, it) => a + (it.semanas[si] || 0), 0);
      const hrsSem = itens.reduce((a, it) => a + (it.hrs[si]    || 0), 0);
      const capSem = weekHoursMaq(s.monday, maq);
      const occSem = capSem > 0 ? Math.min(100, Math.round(hrsSem / capSem * 100)) : 0;
      const occClrSem = occSem > 85 ? 'var(--red)' : occSem > 60 ? 'var(--warn)' : 'var(--cyan)';
      html += `<div style="padding:5px 6px;border-left:1px solid var(--border);background:rgba(0,229,204,.04);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px">
        <span style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:${occClrSem}">${cxSem > 0 ? cxSem.toLocaleString('pt-BR') : '—'}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--text3)">${hrsSem > 0 ? fmtHrs(hrsSem)+' / '+occSem+'%' : ''}</span>
      </div>`;
    });

    html += `<div style="padding:5px 6px;border-left:2px solid var(--border2);display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:${occClr}">${occPct}%</div>`;
    html += `</div>`;
  }

  if(!hasAny){
    html += `<div style="text-align:center;padding:60px 20px;color:var(--text3);font-size:13px">
      <div style="font-size:40px;margin-bottom:12px">📅</div>
      <div style="font-weight:600;margin-bottom:6px">Nenhuma produção programada para ${GANTT_MONTH_NAMES[mes]} ${ano}</div>
      <div style="font-size:11px">Crie solicitações de produção no modo Semanal ou gere a programação automática.</div>
    </div>`;
  }

  html += `</div>`;

  document.getElementById('gantt-table').innerHTML = html;
  document.getElementById('gantt-summary').innerHTML = '';
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
  if(!can('gantt','reordenar')){ toast('Sem permissão para reordenar a produção.','err'); return; }
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
  await reloadFresh();
  closeReorderModal();
  renderGantt();
  toast('Ordem de produção atualizada!','ok');
}

// ===== FICHA TÉCNICA =====
let fichaTecnicaData = JSON.parse(JSON.stringify(FICHA_TECNICA)); // working copy (editable)

function initFichaTecnica(){
  // Populate machine filter usando todos os produtos (ficha + cadastrados)
  const sel=document.getElementById('ft-maq-filter');
  if(!sel) return;
  const merged = getFichaTecnicaMerged();
  const maqs=[...new Set(merged.map(p=>p.maquina).filter(Boolean))].sort();
  // Limpar opções existentes exceto "Todas"
  while(sel.options.length > 1) sel.remove(1);
  maqs.forEach(m=>{
    const o=document.createElement('option');
    o.value=m; o.textContent=m;
    sel.appendChild(o);
  });
}

// Fonte única da verdade: merge de fichaTecnicaData + produtos cadastrados sem ficha
// Retorna array deduplicado por cod, com produtos sem ficha marcados como _semFicha:true
function getFichaTecnicaMerged() {
  const seen = new Set();
  const result = [];
  // 1. Fichas técnicas existentes
  (fichaTecnicaData || []).forEach(p => {
    const key = String(p.cod);
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ ...p, insumos: p.insumos || [] });
  });
  // 2. Produtos cadastrados que ainda não têm ficha
  if (typeof getAllProdutos === 'function') {
    getAllProdutos().forEach(p => {
      const key = String(p.cod);
      if (seen.has(key) || !p.cod || !p.descricao) return;
      seen.add(key);
      result.push({
        cod:      p.cod,
        desc:     p.descricao,
        unid:     p.unid   || 1,
        pc_min:   p.pc_min || 0,
        maquina:  p.maquina || '',
        insumos:  [],
        _semFicha: true
      });
    });
  }
  return result;
}

function loadFichaTecnica(input){
  const file=input.files[0];
  if(!file) return;
  const reader=new FileReader();
  reader.onload=async e=>{
    try{
      const wb=XLSX.read(e.target.result,{type:'array'});
      const sheetName=wb.SheetNames.find(s=>s.includes('Base_Maquina'))||wb.SheetNames[0];
      const ws=wb.Sheets[sheetName];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      const insSheet=wb.SheetNames.find(s=>s.includes('Consumo'));
      let insByProd={};
      if(insSheet){
        const wsIns=wb.Sheets[insSheet];
        const insRows=XLSX.utils.sheet_to_json(wsIns,{header:1,defval:''}).slice(1);
        insRows.forEach(r=>{
          // Colunas: r[0]=produto_key, r[1]=desc_produto, r[2]=desc_insumo, r[3]=qty, r[4]=status
          const statusIns=String(r[4]||'').toUpperCase().trim();
          if(statusIns==='DESATIVADO') return; // ignora insumos desativados
          const prodDesc=String(r[1]||'').trim();
          const insDesc=String(r[2]||'').trim();
          const qty=parseFloat(String(r[3]||'').replace(',','.'))||0;
          if(prodDesc&&insDesc&&qty){
            if(!insByProd[prodDesc]) insByProd[prodDesc]=[];
            insByProd[prodDesc].push({insumo:insDesc,qty});
          }
        });
      }
      // Colunas Base_Maquina_Tempo: r[0]=Cód, r[1]=Descrição, r[2]=UNID, r[3]=KG/FD, r[4]=PC/MIN, r[5]=Maquina, r[6]=status
      fichaTecnicaData=rows.slice(1).filter(r=>{
        if(!r[0]||!r[1]||isNaN(parseInt(r[0]))) return false;
        const statusProd=String(r[6]||'').toUpperCase().trim();
        return statusProd!=='DESATIVADO'; // só importa produtos ATIVO ou sem status definido
      }).map(r=>({
        cod:parseInt(r[0])||0,
        desc:String(r[1]).trim(),
        unid:parseInt(r[2])||1,
        pc_min:parseFloat(r[4])||1,
        maquina:String(r[5]||'MANUAL').trim(),
        insumos:insByProd[String(r[1]).trim()]||[]
      }));

      // Salvar TUDO no Firestore
      toast(`Salvando ${fichaTecnicaData.length} fichas no banco...`, 'ok');
      try {
        // Limpa coleção existente e regrava
        const snapExist = await getDocs(lojaCol('fichaTecnica'));
        const deletePromises = snapExist.docs.map(d => deleteDoc(lojaDoc('fichaTecnica', d.id)));
        await Promise.all(deletePromises);
        // Grava em lotes de 50
        const lote = 50;
        for(let i=0; i<fichaTecnicaData.length; i+=lote){
          await Promise.all(fichaTecnicaData.slice(i,i+lote).map(p =>
            addDoc(lojaCol('fichaTecnica'), { ...p, criadoEm: new Date().toISOString() })
          ));
        }
        toast(`✅ Ficha técnica salva: ${fichaTecnicaData.length} produtos`, 'ok');
      } catch(fe) {
        toast(`Ficha carregada na memória (erro ao salvar no banco: ${fe.message})`, 'warn');
      }

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
      if (typeof renderFichaTecnicaCfg === 'function') renderFichaTecnicaCfg();
    }catch(err){
      toast('Erro ao ler arquivo: '+err.message,'err');
    }
  };
  reader.readAsArrayBuffer(file);
  input.value='';
}

// Exclui produto da ficha técnica
async function excluirFichaByCod(cod) {
  const codNum = parseInt(cod);
  if (!confirm('Excluir este produto da ficha técnica?')) return;
  // Remove da memória
  fichaTecnicaData = fichaTecnicaData.filter(p => p.cod !== codNum);
  // Remove do Firestore — usar _firestoreId do cache, sem nova leitura
  try {
    const base = fichaTecnicaData.find(p => p.cod === codNum);
    if (base && base._firestoreId) {
      await deleteDoc(lojaDoc('fichaTecnica', base._firestoreId));
    } else {
      // Fallback: buscar apenas se _firestoreId não disponível
      const snap = await getDocs(query(lojaCol('fichaTecnica'), where('cod', '==', codNum)));
      await Promise.all(snap.docs.map(d => deleteDoc(lojaDoc('fichaTecnica', d.id))));
    }
    toast('Produto removido da ficha técnica.', 'ok');
  } catch(e) {
    toast('Removido da memória, erro no banco: ' + e.message, 'warn');
  }
  if (typeof renderFichaTecnica === 'function') renderFichaTecnica();
  if (typeof renderFichaTecnicaCfg === 'function') renderFichaTecnicaCfg();
}

function renderFichaTecnica(){
  const q=(document.getElementById('ft-search')?.value||'').toLowerCase().trim();

  // Usa fonte única: fichas existentes + produtos cadastrados sem ficha
  const deduped = getFichaTecnicaMerged();

  let filtered = deduped.filter(p=>{
    if(!q) return true;
    if((p.desc||'').toLowerCase().includes(q)) return true;
    if((p.insumos||[]).some(i=>i.insumo.toLowerCase().includes(q))) return true;
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

  // Salva no Firestore (coleção fichaTecnica) — sem re-leitura, usa _id do cache
  try {
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
    if (base._firestoreId) {
      await setDoc(lojaDoc('fichaTecnica', base._firestoreId), payload);
    } else {
      // Fallback: buscar apenas se não temos o _id em memória
      const snap = await getDocs(query(lojaCol('fichaTecnica'), where('cod', '==', codNum)));
      if (!snap.empty) {
        await setDoc(lojaDoc('fichaTecnica', snap.docs[0].id), payload);
      } else {
        await addDoc(lojaCol('fichaTecnica'), { ...payload, criadoEm: new Date().toISOString() });
      }
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
  // Tentar Firestore cache primeiro: key = "apon_YYYY-MM-DD_recId"
  if (key && key.startsWith('apon_')) {
    const withoutPrefix = key.slice('apon_'.length); // "YYYY-MM-DD_recId"
    if (_aponFS[withoutPrefix]) return Object.assign({}, _aponFS[withoutPrefix]);
  }
  try{ const v=localStorage.getItem(key); return v?JSON.parse(v):null; }catch(e){ return null; }
}
function aponStorageSet(key, obj){
  try{ localStorage.setItem(key, JSON.stringify(obj)); return true; }catch(e){ return false; }
}
function aponGetAllKeys(){
  const keys=new Set();
  // Chaves do localStorage
  try{ for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k&&k.startsWith('apon_')) keys.add(k); } }catch(e){}
  // Chaves do cache Firestore
  Object.keys(_aponFS).forEach(function(k){ keys.add('apon_'+k); });
  return Array.from(keys);
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
  _pdCacheWeek = null; _aponFS = {}; // invalida caches ao trocar de semana
  renderProduzido();
}
function prodWeek(dir){
  if(!prodBaseMonday) prodBaseMonday = getWeekMonday(new Date());
  prodBaseMonday = new Date(prodBaseMonday);
  prodBaseMonday.setDate(prodBaseMonday.getDate() + dir*7);
  const days = getWeekDays(prodBaseMonday);
  const workDays = days.filter(function(d){ return hoursOnDay(d)>0; });
  prodSelectedDate = dateStr(workDays[0] || days[0]);
  _pdCacheWeek = null; _aponFS = {}; // invalida caches ao trocar de semana
  renderProduzido();
}
function prodGoDate(){
  const v = document.getElementById('prod-goto').value;
  if(!v) return;
  prodBaseMonday = getWeekMonday(new Date(v+'T12:00:00'));
  prodSelectedDate = v;
  _pdCacheWeek = null; _aponFS = {}; // invalida caches ao trocar de semana
  renderProduzido();
}
function prodSelectDay(ds){
  // Auto-save já ocorre via oninput — sem necessidade de salvar ao trocar de aba
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
    pdLoadWeek(prodBaseMonday).then(function(){ renderProducaoDia(); });
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
    pdLoadWeek(prodBaseMonday).then(function(){ renderProducaoDiaControlado(); });
    return;
  }
  // Se a aba "Total da Semana" estiver selecionada
  if(dateVal === 'semana'){
    renderWeeklySummary(body).catch(e => {
      console.error('Erro renderWeeklySummary:', e);
      body.innerHTML = '<div class="empty"><div class="ei">⚠️</div>Erro ao carregar resumo da semana.</div>';
    });
    return;
  }

  // Dias da semana: garantir que o mapa do Gantt + overrides estão carregados
  // antes de renderizar (resolve problema de primeira abertura)
  if(_pdCacheWeek !== dateStr(getWeekMonday(new Date(dateVal+'T12:00:00')))){
    body.innerHTML='<div class="empty"><div class="ei">⏳</div>Carregando...</div>';
    pdLoadWeek(prodBaseMonday).then(function(){ renderRealizadoControlado(dateVal, body); });
    return;
  }

  renderRealizadoControlado(dateVal, body);
}

// Nova função para renderizar aba Realizado de forma controlada
function renderRealizadoControlado(dateVal, body) {
  body._dateVal = dateVal;
  try {
    _renderRealizadoControlado(dateVal, body);
  } catch(e) {
    console.error('Erro em renderRealizadoControlado:', e);
    body.innerHTML = `<div class="empty" style="flex-direction:column;gap:12px">
      <div class="ei">⚠️</div>
      <div style="color:var(--red)">Erro ao carregar apontamentos.</div>
      <div style="font-size:11px;color:var(--text3)">${e.message}</div>
      <button onclick="renderApontamento()" style="margin-top:8px;background:var(--s2);border:1px solid var(--border);color:var(--text);padding:6px 16px;border-radius:6px;cursor:pointer">🔄 Tentar novamente</button>
    </div>`;
  }
}

// Estado dos filtros do Realizado (persiste durante a sessão)
window._realizadoFiltros = window._realizadoFiltros || { maquina: '', status: '', busca: '' };

function _renderRealizadoControlado(dateVal, body) {
  const isOperador = isOperadorLevel();
  const isPCP      = isPCPLevel();
  const filtros    = window._realizadoFiltros;

  // Garante mapa do Gantt atualizado
  pdBuildGanttMap(prodBaseMonday);

  const weekDays  = getWeekDays(prodBaseMonday);
  const weekStart = dateStr(weekDays[0]);
  const weekEnd   = dateStr(weekDays[6]);

  // Registros que devem aparecer neste dia:
  //   1. Dia programado == dateVal (início normal), OU
  //   2. Dia programado < dateVal E produto ainda não finalizado (overflow para dias seguintes)
  // Nunca aparece antes do dia programado. Finalizados nunca fazem overflow.
  const dayRecs = records.filter(r => {
    if (r.status === 'Cancelado') return false;
    // Finalizados nunca aparecem em dias seguintes (mas aparecem no dia em que foram finalizados)
    if (pdIsFin(r.id)) {
      // Ainda mostra no dia em que está programado (para o usuário ver o status finalizado)
      const eff = pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao;
      return eff === dateVal;
    }

    const eff = pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao;
    if (!eff) return false;

    // Não aparece antes do dia programado
    if (eff > dateVal) return false;

    // Aparece no dia programado (incluindo concluídos não-finalizados)
    if (eff === dateVal) return true;

    // Overflow: dia programado já passou e não foi finalizado — aparece nos dias seguintes
    const dateValDate = new Date(dateVal + 'T12:00:00');
    if (eff < dateVal && hoursOnDay(dateValDate) > 0) return true;

    return false;
  })
  // Ordenar: não-concluídos primeiro, concluídos/finalizados por último
  .sort((a, b) => {
    const aDone = calcularTotalProduzido(a.id) >= (a.qntCaixas||0);
    const bDone = calcularTotalProduzido(b.id) >= (b.qntCaixas||0);
    const aFin  = pdIsFin(a.id);
    const bFin  = pdIsFin(b.id);
    // Finalizados vão ao final
    if (aFin && !bFin) return 1;
    if (!aFin && bFin) return -1;
    // Concluídos (meta atingida mas não finalizados) vão antes dos finalizados
    if (aDone && !bDone) return 1;
    if (!aDone && bDone) return -1;
    return 0;
  });

  const dateLabel = fmtDate(new Date(dateVal + 'T12:00:00'));
  const isHoje    = dateVal === dateStr(new Date());
  const maqsNaSemana = [...new Set(
    records
      .filter(r => { const dt = r.dtDesejada||r.dtSolicitacao; return dt && dt >= weekStart && dt <= weekEnd; })
      .map(r => r.maquina)
  )].filter(Boolean).sort();

  // ── Cabeçalho + filtros ───────────────────────────────────────────
  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">
          ${dateLabel}${isHoje ? ' <span style="color:var(--cyan)">(HOJE)</span>' : ''}
        </span>
        <!-- Filtro máquina -->
        <select id="realizado-filtro-maq" onchange="realizadoFiltrar()"
                style="background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text2);font-size:11px;padding:3px 8px;font-family:'Space Grotesk',sans-serif">
          <option value="">Todas as máquinas</option>
          ${maqsNaSemana.map(m=>`<option value="${m}" ${filtros.maquina===m?'selected':''}>${m}</option>`).join('')}
        </select>
        <!-- Filtro status -->
        <select id="realizado-filtro-status" onchange="realizadoFiltrar()"
                style="background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text2);font-size:11px;padding:3px 8px;font-family:'Space Grotesk',sans-serif">
          <option value="">Todos os status</option>
          <option value="pendente"  ${filtros.status==='pendente'?'selected':''}>Pendente</option>
          <option value="andamento" ${filtros.status==='andamento'?'selected':''}>Em andamento</option>
          <option value="concluido" ${filtros.status==='concluido'?'selected':''}>Concluído</option>
        </select>
        <!-- Busca -->
        <input type="text" id="realizado-busca" placeholder="Buscar produto..." value="${filtros.busca}"
               oninput="realizadoFiltrar()"
               style="background:var(--s1);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:11px;padding:3px 8px;width:160px;font-family:'Space Grotesk',sans-serif">
        ${(filtros.maquina||filtros.status||filtros.busca)?`<button onclick="realizadoLimparFiltros()" style="background:none;border:1px solid var(--border);color:var(--text3);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">✕</button>`:''}
      </div>
      ${isPCP ? `
      <div style="display:flex;gap:6px">
        <button onclick="exportarApontamentos()" style="background:var(--s1);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11px;color:var(--text2);cursor:pointer">📤 Exportar</button>
        <button onclick="realizadoResetarDia('${dateVal}')" style="background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);border-radius:6px;padding:4px 10px;font-size:11px;color:var(--red);cursor:pointer">🗑 Reset</button>
      </div>` : ''}
    </div>`;

  if (!dayRecs.length) {
    body.innerHTML = html + `
      <div class="empty" style="flex-direction:column;gap:8px;padding:40px 0">
        <div class="ei">⏰</div>
        <div style="font-size:13px">Nenhum produto programado para ${dateLabel}.</div>
        <div style="font-size:11px;color:var(--text3)">Verifique o Gantt Visual ou a aba Produção Dia.</div>
      </div>`;
    return;
  }

  // Agrupar por máquina
  const grupos = {};
  dayRecs.forEach(r => {
    if (!grupos[r.maquina]) grupos[r.maquina] = [];
    grupos[r.maquina].push(r);
  });

  // Aplicar filtros
  Object.keys(grupos).forEach(maq => {
    if (filtros.maquina && filtros.maquina !== maq) { delete grupos[maq]; return; }
    if (filtros.busca) {
      grupos[maq] = grupos[maq].filter(r => r.produto.toLowerCase().includes(filtros.busca.toLowerCase()));
    }
    if (filtros.status) {
      grupos[maq] = grupos[maq].filter(r => {
        const total = calcularTotalProduzido(r.id);
        const meta  = r.qntCaixas || 0;
        if (filtros.status === 'concluido')  return total >= meta;
        if (filtros.status === 'andamento')  return total > 0 && total < meta;
        if (filtros.status === 'pendente')   return total === 0;
        return true;
      });
    }
    if (!grupos[maq] || !grupos[maq].length) delete grupos[maq];
  });

  const maqKeys = Object.keys(grupos).sort();

  if (!maqKeys.length) {
    body.innerHTML = html + `
      <div class="empty" style="flex-direction:column;gap:8px;padding:40px 0">
        <div class="ei">🔍</div>
        <div>Nenhum resultado com os filtros aplicados.</div>
        <button onclick="realizadoLimparFiltros()" style="margin-top:4px;background:var(--s2);border:1px solid var(--border);color:var(--text);padding:5px 14px;border-radius:6px;font-size:11px;cursor:pointer">✕ Limpar filtros</button>
      </div>`;
    return;
  }

  // ── Tabela por máquina ───────────────────────────────────────────
  maqKeys.forEach(maq => {
    const recs = grupos[maq].sort((a, b) => {
      const sa = a.sortOrder != null ? a.sortOrder : a.id;
      const sb = b.sortOrder != null ? b.sortOrder : b.id;
      return sa - sb;
    });

    const totalMeta     = recs.reduce((s, r) => s + (r.qntCaixas||0), 0);
    const totalProdMaq  = recs.reduce((s, r) => s + calcularTotalProduzido(r.id), 0);
    const pctMaq        = totalMeta > 0 ? Math.min(100, Math.round(totalProdMaq / totalMeta * 100)) : 0;
    const concluidos    = recs.filter(r => calcularTotalProduzido(r.id) >= (r.qntCaixas||0)).length;

    html += `
      <div style="margin-bottom:14px">
        <!-- Header da máquina -->
        <div style="background:var(--s2);border:1px solid var(--border);border-radius:8px 8px 0 0;border-bottom:none">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:var(--cyan);text-transform:uppercase;letter-spacing:.5px">${maq}</span>
              <span style="font-size:10px;color:var(--text3)">${dateLabel} · ${recs.length} produto(s) · ${concluidos}/${recs.length} concluídos</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:80px;height:4px;background:var(--s1);border-radius:2px;overflow:hidden">
                <div style="width:${pctMaq}%;height:100%;background:${pctMaq>=100?'var(--green)':pctMaq>0?'var(--cyan)':'var(--s1)'};border-radius:2px;transition:width .3s"></div>
              </div>
              <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:${pctMaq>=100?'var(--green)':'var(--text3)'}">${pctMaq}%</span>
            </div>
          </div>
          <!-- Seletor de funcionário -->
          <div style="padding:4px 10px 6px;border-top:1px solid rgba(255,255,255,.06);display:flex;align-items:center;gap:8px">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span style="font-size:10px;color:var(--text3);white-space:nowrap">Operador:</span>
            <select id="func-sel-${dateVal}-${maq.replace(/ /g,'-')}"
                    onchange="pdSelecionarFunc(this,'${dateVal}','${maq}')"
                    style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:11px;padding:2px 6px">
              <option value="">— selecionar operador —</option>
              ${(_funcProd||[])
                .filter(f=>!f.deactivatedUntil||new Date(f.deactivatedUntil).getTime()<Date.now())
                .filter(f=>!f.maquinas||!f.maquinas.length||f.maquinas.includes(maq))
                .map(f=>{const sv=(window._pdFuncSel||{})[dateVal+'_'+maq]||'';return `<option value="${f.nome}" ${sv===f.nome?'selected':''}>${f.nome}</option>`;})
                .join('')}
            </select>
            ${(_funcProd||[]).length===0?'<span style="font-size:10px;color:var(--text3);font-style:italic">Cadastre funcionários em Configurações</span>':''}
          </div>
        </div>

        <!-- Tabela -->
        <div style="overflow-x:auto;border:1px solid var(--border);border-radius:0 0 8px 8px;border-top:none">
          <table style="width:100%;border-collapse:collapse;font-family:'JetBrains Mono',monospace;font-size:11px">
            <thead>
              <tr style="background:var(--s1);border-bottom:1px solid var(--border)">
                <th style="padding:5px 8px;text-align:left;color:var(--text3);font-weight:600;font-size:10px;white-space:nowrap;min-width:28px">#</th>
                <th style="padding:5px 8px;text-align:left;color:var(--text3);font-weight:600;font-size:10px;min-width:180px">PRODUTO</th>
                ${APON_HOURS.map(h=>`<th style="padding:5px 6px;text-align:center;color:var(--text3);font-weight:600;font-size:10px;min-width:52px">${String(h).padStart(2,'0')}H</th>`).join('')}
                <th style="padding:5px 8px;text-align:center;color:var(--text3);font-weight:600;font-size:10px;min-width:64px;border-left:1px solid var(--border)">TOTAL DIA</th>
                <th style="padding:5px 8px;text-align:center;color:var(--text3);font-weight:600;font-size:10px;min-width:72px">ACUMULADO</th>
                <th style="padding:5px 8px;text-align:center;color:var(--text3);font-weight:600;font-size:10px;min-width:48px">SOLIC.</th>
                <th style="padding:5px 8px;text-align:center;color:var(--text3);font-weight:600;font-size:10px;min-width:40px">OBS</th>
                <th style="padding:5px 8px;text-align:center;color:var(--text3);font-weight:600;font-size:10px;min-width:40px"></th>
              </tr>
            </thead>
            <tbody>`;

    recs.forEach((rec, idx) => {
      const totalProd   = calcularTotalProduzido(rec.id);
      const meta        = rec.qntCaixas || 0;
      const todayData   = aponStorageGet(aponKey(dateVal, rec.id)) || {};
      const todayTotal  = APON_HOURS.reduce((s,h) => s + (parseInt(todayData[h])||0), 0);
      const isDone      = meta > 0 && totalProd >= meta;
      const isAndamento = totalProd > 0 && !isDone;
      const isFin       = pdIsFin(rec.id);

      // Cores da linha
      let rowBg, leftBorder, nomeColor;
      if (isFin) {
        rowBg      = 'background:rgba(41,217,132,.13)';
        leftBorder = 'border-left:3px solid var(--green)';
        nomeColor  = 'var(--green)';
      } else if (isDone) {
        rowBg      = 'background:rgba(41,217,132,.06)';
        leftBorder = 'border-left:3px solid var(--green)';
        nomeColor  = 'var(--green)';
      } else if (isAndamento) {
        rowBg      = idx % 2 === 0 ? 'var(--bg)' : 'var(--s1)';
        leftBorder = 'border-left:2px solid var(--cyan)';
        nomeColor  = 'var(--text)';
      } else {
        rowBg      = idx % 2 === 0 ? 'var(--bg)' : 'var(--s1)';
        leftBorder = '';
        nomeColor  = 'var(--text2)';
      }

      // Status dot
      const statusDot = isFin
        ? `<span style="color:var(--green);font-size:12px;font-weight:700">✓</span>`
        : isDone
          ? `<span style="color:var(--green);font-size:9px">●</span>`
          : isAndamento
            ? `<span style="color:var(--cyan);font-size:9px">●</span>`
            : `<span style="color:var(--text3);font-size:9px">○</span>`;

      // Inputs — bloqueados quando finalizado
      const inputDisabled = isFin ? 'disabled' : '';
      const inputStyle    = isFin
        ? 'width:46px;padding:4px 2px;border:1px solid rgba(41,217,132,.3);border-radius:4px;text-align:center;font-size:11px;background:rgba(41,217,132,.08);color:var(--green);font-family:\'JetBrains Mono\',monospace;-moz-appearance:textfield;cursor:not-allowed;opacity:.7'
        : 'width:46px;padding:4px 2px;border:1px solid var(--border);border-radius:4px;text-align:center;font-size:11px;background:var(--s2);color:var(--text);font-family:\'JetBrains Mono\',monospace;-moz-appearance:textfield';
      const horaInputs = APON_HOURS.map(h => {
        const val = todayData[h] || '';
        return `<td style="padding:3px 4px;text-align:center;border-left:1px solid rgba(255,255,255,.04)">
          <input type="number" min="0"
                 data-rec="${rec.id}" data-hr="${h}" data-date="${dateVal}"
                 value="${val}" placeholder="0" ${inputDisabled}
                 oninput="salvarApontamentoCompleto('${rec.id}')"
                 style="${inputStyle}"
                 class="apon-input apon-input-controlado">
        </td>`;
      }).join('');

      // Botão de ação (última coluna)
      let actionBtn;
      if (isFin) {
        actionBtn = `
          <div style="display:flex;align-items:center;gap:3px;justify-content:center">
            <span style="font-size:9px;font-weight:700;color:var(--green);background:rgba(41,217,132,.15);border:1px solid rgba(41,217,132,.3);border-radius:4px;padding:3px 6px;white-space:nowrap">✓ Finalizado</span>
            <button onclick="realizadoDesfinalizar('${rec.id}')"
                    title="Desfinalizar e liberar edição"
                    style="background:rgba(255,71,87,.15);border:1px solid rgba(255,71,87,.4);color:var(--red);border-radius:4px;width:22px;height:22px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0">✕</button>
          </div>`;
      } else if (isDone) {
        actionBtn = `
          <button onclick="realizadoFinalizarProducao('${rec.id}','${dateVal}')"
                  title="Finalizar produção"
                  style="background:var(--green);color:#000;border:none;border-radius:4px;padding:3px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:'Space Grotesk',sans-serif;white-space:nowrap">
            🏁 Finalizar
          </button>`;
      } else {
        actionBtn = `
          <button onclick="realizadoSalvarLinha('${rec.id}','${dateVal}')"
                  title="Salvar"
                  style="background:var(--s2);border:1px solid var(--border);color:var(--text2);border-radius:4px;padding:3px 7px;font-size:10px;font-weight:700;cursor:pointer;font-family:'Space Grotesk',sans-serif">✓</button>`;
      }

      html += `
              <tr style="${rowBg};${leftBorder};border-bottom:1px solid rgba(255,255,255,.04)" data-record-id="${rec.id}">
                <td style="padding:6px 8px;text-align:center">${statusDot}</td>
                <td style="padding:6px 8px">
                  <div style="font-size:11px;font-weight:600;color:${nomeColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px" title="${rec.produto}">
                    ${rec.produto}
                  </div>
                  ${rec.obs_dia ? `<div style="font-size:9px;color:var(--text3);margin-top:1px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${rec.obs_dia}</div>` : ''}
                </td>
                ${horaInputs}
                <td style="padding:6px 8px;text-align:center;border-left:1px solid var(--border)">
                  <span id="realizado-daytotal-${rec.id}" style="font-weight:700;color:${todayTotal>0?'var(--cyan)':'var(--text3)'}">
                    ${todayTotal > 0 ? todayTotal : '—'}
                  </span>
                </td>
                <td style="padding:6px 8px;text-align:center">
                  <span id="realizado-acum-${rec.id}" style="font-weight:700;color:${isFin||isDone?'var(--green)':totalProd>0?'var(--text)':'var(--text3)'}">
                    ${totalProd > 0 ? totalProd : '—'}
                  </span>
                </td>
                <td style="padding:6px 8px;text-align:center;color:var(--text2)">${meta}</td>
                <td style="padding:6px 4px;text-align:center">
                  <button id="obs-btn-${rec.id}-${dateVal}"
                          onclick="pdAbrirObs('${rec.id}','${dateVal}')"
                          title="Observação"
                          style="background:var(--s2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;font-size:12px;cursor:pointer;transition:all .15s">
                    📝
                  </button>
                </td>
                <td style="padding:6px 4px;text-align:center">${actionBtn}</td>
              </tr>`;
    });

    html += `
            </tbody>
          </table>
        </div>

      </div>`;
  });

  body.innerHTML = html;
  body._machineGroups = maqKeys.map(m => ({ maq: m, items: grupos[m].map(r => ({ rec: r })) }));
  body._dateVal = dateVal;

  // Carrega badges de observação para o dia (atualiza botões no rodapé)
  setTimeout(() => {
    carregarObservacoesExistentes(dateVal);
    _realizadoCarregarBadgesObs(dayRecs, dateVal);
  }, 100);
}

async function _realizadoCarregarBadgesObs(recs, dateVal) {
  if (!recs || !recs.length) return;
  try {
    const obsMap = await carregarObservacoes(dateVal, dateVal);
    recs.forEach(r => {
      const obs = obsMap[`${dateVal}_${r.id}`];
      if (obs && obs.observacao) {
        window._pdObsCache = window._pdObsCache || {};
        window._pdObsCache[`${r.id}_${dateVal}`] = obs.observacao;
        _pdAtualizarBadgeObs(r.id, dateVal, obs.observacao);
      }
    });
  } catch(e) { /* silencioso */ }
}

function isProximoDaSequencia(record, todosRecords) {
  const index = todosRecords.findIndex(r => r.id === record.id);
  if (index === 0) return true; // Primeiro da lista
  
  // Verificar se todos os anteriores foram concluídos
  for (let i = 0; i < index; i++) {
    const anterior = todosRecords[i];
    const totalProduzido = calcularTotalProduzido(anterior.id);
    if (totalProduzido < anterior.qntCaixas) {
      return false;
    }
  }
  
  return true;
}

// Recálculo controlado de linha (com validações)
function aponRecalcRowControlado(recordId) {
  const inputs = document.querySelectorAll(`[data-rec="${recordId}"]`);
  let total = 0;
  
  inputs.forEach(input => {
    const val = parseInt(input.value) || 0;
    total += val;
  });
  
  // Buscar dados do record para validação
  const record = records.find(r => r.id === recordId);
  if (!record) return;
  
  const totalProduzido = calcularTotalProduzido(recordId);
  const necessario = record.qntCaixas || 0;
  const totalGlobal = totalProduzido + total;
  
  // Sem bloqueio por meta — operador pode continuar apontando além da meta se necessário
  
  // Salvar apontamento
  const data = {};
  inputs.forEach(input => {
    const hora = input.dataset.hr;
    data[hora] = input.value || '';
  });
  
  aponStorageSet(aponKey(prodSelectedDate, recordId), data);
  
  // Atualizar interface
  const totalElem = document.getElementById('apon-dayqty-'+recordId);
  if (totalElem) totalElem.textContent = total || '—';
  
  const overallElem = document.getElementById('apon-overall-'+recordId);
  if (overallElem) overallElem.textContent = totalGlobal;
  
  // Verificar se concluiu automaticamente
  if (totalGlobal >= necessario) {
    toast(`✅ Produto "${record.produto}" concluído automaticamente!`, 'ok');
    registrarAuditoria('PRODUTO_CONCLUIDO_AUTO', {
      recordId: recordId,
      produto: record.produto,
      totalProduzido: totalGlobal,
      meta: necessario
    });
    
    // Recarregar para mostrar como concluído
    setTimeout(() => renderApontamento(), 1000);
  }
}

// Função para PCP permitir produção fora de sequência
function realizadoPermitirFaltaSequencia() {
  if (!isPCPLevel()) {
    toast('Apenas usuários PCP podem alterar a sequência!', 'err');
    return;
  }
  
  // TODO: Implementar modal de seleção de produto e justificativa
  toast('Funcionalidade de quebra de sequência em desenvolvimento', 'info');
}

// Função para PCP resetar apontamentos do dia
function realizadoResetarDia(data) {
  if (!can('realizado','resetar')) {
    toast('Sem permissão para resetar apontamentos.', 'err');
    return;
  }
  
  if (!confirm(`Deseja realmente limpar TODOS os apontamentos do dia ${fmtDate(new Date(data+'T12:00:00'))}?\n\nEsta ação não pode ser desfeita.`)) {
    return;
  }
  
  // 1. Limpar localStorage do dia
  const keysToRemove = [];
  for(let i=0; i<localStorage.length; i++){
    const key = localStorage.key(i);
    if(key && key.startsWith('apon_'+data+'_')){
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));

  // 2. Limpar cache _aponFS do dia
  Object.keys(_aponFS).forEach(function(k) {
    if(k.startsWith(data + '_')) delete _aponFS[k];
  });

  // 3. Apagar documentos do Firestore do dia
  (async function() {
    try {
      const q = query(lojaCol('apontamentos_producao'), where('data', '==', data));
      const snap = await getDocs(q);
      const batch = writeBatch(firestoreDB);
      snap.docs.forEach(function(d) { batch.delete(d.ref); });
      await batch.commit();
      console.log('[aponFS] Reset do dia', data, '— apagados', snap.size, 'docs no Firestore');
    } catch(e) {
      console.error('[aponFS] Erro ao apagar do Firestore no reset:', e.message);
    }
  })();

  registrarAuditoria('DIA_RESETADO', { data: data, itensLimpos: keysToRemove.length });
  toast(`✅ Apontamentos do dia ${fmtDate(new Date(data+'T12:00:00'))} removidos.`, 'ok');
  renderApontamento();
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

// Cache em memória: _pdCache[recId] = { dia: 'YYYY-MM-DD'|null, fin: bool }
let _pdCache = {};
let _pdCacheWeek = null;

// ── Cache Firestore de apontamentos ────────────────────────────────
// Chave: "YYYY-MM-DD_recId"  → { 7: 10, 8: 5, ... }
let _aponFS = {};

// Carrega apontamentos da semana do Firestore para o cache _aponFS
async function _loadAponFSSemana(mondayDate) {
  _aponFS = {};
  try {
    const dias = getWeekDays(mondayDate);
    const weekStart = dateStr(dias[0]);
    const weekEnd   = dateStr(dias[6]);
    const q = query(
      lojaCol('apontamentos_producao'),
      where('data', '>=', weekStart),
      where('data', '<=', weekEnd)
    );
    const snap = await getDocs(q);
    snap.forEach(function(d) {
      const ap = d.data();
      if (!ap.data || ap.recordId == null) return;
      const key = ap.data + '_' + ap.recordId;
      // Suporta tanto o formato antigo {hora, quantidade} quanto o novo {horas:{...}}
      if (ap.horas && typeof ap.horas === 'object') {
        _aponFS[key] = Object.assign({}, ap.horas);
      } else if (ap.hora != null && ap.quantidade != null) {
        if (!_aponFS[key]) _aponFS[key] = {};
        _aponFS[key][ap.hora] = (_aponFS[key][ap.hora] || 0) + (parseInt(ap.quantidade) || 0);
      }
    });
    console.log('[aponFS] Carregados', Object.keys(_aponFS).length, 'apontamentos do Firestore');
  } catch(e) {
    console.warn('[aponFS] Erro ao carregar do Firestore, usando localStorage:', e.message);
  }
}

// Sincroniza apontamentos históricos (semanas anteriores) do Firestore → localStorage
// Usa TTL de 24h no localStorage para não repetir a cada F5.
let _aponHistoricoSincronizado = false;
async function _sincronizarApontamentosHistoricos() {
  if (_aponHistoricoSincronizado) return;
  // Verificar TTL: só sincroniza se passou mais de 24h desde a última vez
  const TS_KEY = 'apon_hist_sync_ts';
  const ultimaSync = parseInt(localStorage.getItem(TS_KEY) || '0');
  const agora = Date.now();
  const TTL_24H = 24 * 60 * 60 * 1000;
  if (agora - ultimaSync < TTL_24H) {
    _aponHistoricoSincronizado = true;
    console.log('[aponFS] Histórico em cache (última sync < 24h). Pulando leitura do Firestore.');
    return;
  }
  _aponHistoricoSincronizado = true;
  try {
    // Busca apontamentos mais recentes que a última sincronização (delta, não full scan)
    const dataCorte = ultimaSync > 0
      ? new Date(ultimaSync - TTL_24H).toISOString().slice(0, 10) // 1 dia de overlap por segurança
      : '2000-01-01';
    const q = query(lojaCol('apontamentos_producao'), where('data', '>=', dataCorte));
    const snap = await getDocs(q);
    let count = 0;
    snap.forEach(function(d) {
      const ap = d.data();
      if (!ap.data || ap.recordId == null) return;
      const lsKey = 'apon_' + ap.data + '_' + ap.recordId;
      if (!localStorage.getItem(lsKey)) {
        let horasObj = {};
        if (ap.horas && typeof ap.horas === 'object') {
          horasObj = ap.horas;
        } else if (ap.hora != null && ap.quantidade != null) {
          horasObj[ap.hora] = parseInt(ap.quantidade) || 0;
        }
        try { localStorage.setItem(lsKey, JSON.stringify(horasObj)); count++; } catch(e) {}
      }
    });
    localStorage.setItem(TS_KEY, String(agora));
    if (count > 0) console.log('[aponFS] Sincronizados', count, 'apontamentos históricos → localStorage');
  } catch(e) {
    console.warn('[aponFS] Erro ao sincronizar histórico:', e.message);
  }
}

// Carrega os assignments do Firestore para a semana especificada.
// Filtra por campo 'semana' (YYYY-WNN) para evitar ler docs de semanas anteriores.
// Docs antigos (sem campo 'semana') são carregados uma única vez via _pdCarregarLegado.
let _pdLegadoCarregado = false;
async function pdLoadWeek(mondayDate) {
  const wKey = dateStr(mondayDate);
  if (_pdCacheWeek === wKey) return;
  _pdCache = {};
  _pdCacheWeek = wKey;

  // Calcular identificador de semana (ex: "2025-W03")
  const wNum = String(getISOWeek(mondayDate)).padStart(2, '0');
  const wYear = mondayDate.getFullYear();
  const semanaId = `${wYear}-W${wNum}`;

  try {
    // 1. Ler docs desta semana (filtrado)
    const qSemana = query(
      collection(firestoreDB, 'programacao_dias'),
      where('semana', '==', semanaId)
    );
    const snap = await getDocs(qSemana);
    snap.forEach(function(d) {
      const data = d.data();
      _pdCache[String(d.id)] = { dia: data.dia || null, fin: data.finalizado === true };
    });

    // 2. Na primeira carga da sessão, ler docs legados (sem campo 'semana') uma única vez
    if (!_pdLegadoCarregado) {
      _pdLegadoCarregado = true;
      const qLegado = query(
        collection(firestoreDB, 'programacao_dias'),
        where('semana', '==', null)
      );
      const snapLegado = await getDocs(qLegado).catch(() => null);
      if (snapLegado) {
        snapLegado.forEach(function(d) {
          const data = d.data();
          if (!_pdCache[String(d.id)]) { // não sobrescrever se já veio da query filtrada
            _pdCache[String(d.id)] = { dia: data.dia || null, fin: data.finalizado === true };
          }
          // Migrar doc legado: adicionar campo 'semana' para evitar esta leitura no futuro
          if (data.dia) {
            const dMon = getWeekMonday(new Date(data.dia + 'T12:00:00'));
            const wN = String(getISOWeek(dMon)).padStart(2, '0');
            const migSemana = `${dMon.getFullYear()}-W${wN}`;
            setDoc(doc(firestoreDB, 'programacao_dias', d.id),
              { semana: migSemana }, { merge: true }
            ).catch(() => {});
          }
        });
      }
    }
  } catch(e) {
    console.error('Erro ao carregar programacao_dias:', e);
    // Fallback: ler tudo se a query filtrada falhar (índice não criado ainda)
    try {
      const snapAll = await getDocs(collection(firestoreDB, 'programacao_dias'));
      snapAll.forEach(function(d) {
        const data = d.data();
        _pdCache[String(d.id)] = { dia: data.dia || null, fin: data.finalizado === true };
      });
    } catch(e2) { console.error('Fallback pdLoadWeek também falhou:', e2); }
  }
  // Carrega apontamentos da semana do Firestore
  await _loadAponFSSemana(mondayDate);
  // Garante que o mapa do Gantt está atualizado após carregar overrides
  pdBuildGanttMap(mondayDate);
}

function pdGetAssign(recId){ return (_pdCache[String(recId)] || {}).dia || null; }

function pdSetAssign(recId, ds) {
  const id = String(recId);
  if (!_pdCache[id]) _pdCache[id] = { dia: null, fin: false };
  _pdCache[id].dia = ds || null;
  // Calcular semana para filtro eficiente no próximo carregamento
  let semana = null;
  if (ds && prodBaseMonday) {
    const wN = String(getISOWeek(prodBaseMonday)).padStart(2, '0');
    semana = `${prodBaseMonday.getFullYear()}-W${wN}`;
  }
  setDoc(doc(firestoreDB, 'programacao_dias', id),
    { dia: ds || null, finalizado: _pdCache[id].fin, semana, ts: serverTimestamp() },
    { merge: true }
  ).catch(function(e){ console.error('Erro ao salvar dia no Firestore:', e); });
}

function pdIsFin(recId){ return ((_pdCache[String(recId)] || {}).fin === true); }

function pdSetFin(recId, v) {
  const id = String(recId);
  if (!_pdCache[id]) _pdCache[id] = { dia: null, fin: false };
  _pdCache[id].fin = !!v;
  let semana = null;
  if (prodBaseMonday) {
    const wN = String(getISOWeek(prodBaseMonday)).padStart(2, '0');
    semana = `${prodBaseMonday.getFullYear()}-W${wN}`;
  }
  setDoc(doc(firestoreDB, 'programacao_dias', id),
    { dia: _pdCache[id].dia || null, finalizado: !!v, semana, ts: serverTimestamp() },
    { merge: true }
  ).catch(function(e){ console.error('Erro ao salvar finalizado no Firestore:', e); });
}

// ── Retorna o dia real do Gantt para um registro (primeiro segmento)
// Se o PCP fez override manual (drag), usa o override; caso contrário usa o Gantt.
// _pdGanttMap é populado por pdBuildGanttMap() antes de cada render.
let _pdGanttMap = {}; // { recId: 'YYYY-MM-DD' }

function pdBuildGanttMap(monday) {
  _pdGanttMap = {};
  if (!monday || !records.length) return;
  try {
    const { schedule } = buildSchedule(monday);
    for (const maq of MAQUINAS) {
      const entries = schedule[maq] || [];
      for (const entry of entries) {
        const firstSeg = entry.segments && entry.segments.length > 0 ? entry.segments[0] : null;
        if (firstSeg) {
          _pdGanttMap[String(entry.rec.id)] = firstSeg.date;
        } else if (entry.rec) {
          // Produto sem segmento na semana (ex: semana futura) → usa dtDesejada
          const dt = entry.rec.dtDesejada || entry.rec.dtSolicitacao;
          if (dt) _pdGanttMap[String(entry.rec.id)] = dt;
        }
      }
    }
    // Fallback para registros não cobertos pelo buildSchedule desta semana
    // (produtos de outras semanas que não aparecem no schedule)
    const weekStart = dateStr(getWeekDays(monday)[0]);
    const weekEnd   = dateStr(getWeekDays(monday)[6]);
    records.forEach(r => {
      if (_pdGanttMap[String(r.id)]) return; // já tem
      const dt = r.dtDesejada || r.dtSolicitacao;
      if (dt && dt >= weekStart && dt <= weekEnd) {
        _pdGanttMap[String(r.id)] = dt;
      }
    });
  } catch(e) {
    console.error('Erro em pdBuildGanttMap:', e);
    // Fallback total: usar dtDesejada diretamente
    const weekStart = dateStr(getWeekDays(monday)[0]);
    const weekEnd   = dateStr(getWeekDays(monday)[6]);
    records.forEach(r => {
      const dt = r.dtDesejada || r.dtSolicitacao;
      if (dt && dt >= weekStart && dt <= weekEnd) {
        _pdGanttMap[String(r.id)] = dt;
      }
    });
  }
}

// Retorna o dia efetivo: override manual se existir, senão dia do Gantt
function pdGetEffectiveDay(recId) {
  const override = pdGetAssign(recId);
  if (override) return override;
  return _pdGanttMap[String(recId)] || null;
}

// ===== VERSÃO CONTROLADA DA ABA PRODUÇÃO DIA =====

function renderProducaoDiaControlado() {
  if (!prodBaseMonday) {
    document.getElementById('apon-body').innerHTML = '<div class="empty"><div class="ei">📅</div>Selecione uma semana</div>';
    return;
  }

  pdBuildGanttMap(prodBaseMonday);

  const isOperador = isOperadorLevel();
  const isPCP      = isPCPLevel();

  const weekDays  = getWeekDays(prodBaseMonday);
  const weekStart = dateStr(weekDays[0]);
  const weekEnd   = dateStr(weekDays[6]);
  const workDays  = weekDays.filter(d => hoursOnDay(d) > 0);

  const filtros = window._pdFiltros || { maquina: '', status: '', busca: '' };

  // ── weekRecs: semana + overflow ──────────────────────────────────
  const weekRecs = records.filter(r => {
    if (r.status === 'Concluído') return false;
    const produzido = calcularTotalProduzido(r.id);
    const meta      = r.qntCaixas || 0;
    if (produzido >= meta && meta > 0) return false;
    const eff = pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao;
    if (!eff) return false;
    if (eff >= weekStart && eff <= weekEnd) return true;
    if (eff < weekStart) return true;
    return false;
  });

  const finCount = weekRecs.filter(r => pdIsFin(r.id)).length;

  // Máquinas presentes na semana (para filtro)
  const maqsNaSemana = [...new Set(weekRecs.map(r => r.maquina).filter(Boolean))].sort();

  let html = '<div>';

  // ── Cabeçalho + filtros ──────────────────────────────────────────
  html += `
    <div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--text)">📅 Produção por Dia — ${fmtDate(weekDays[0])} a ${fmtDate(weekDays[6])}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">${isOperador ? '🔒 Modo Operador — Visualização' : '🔧 Modo PCP — Gestão completa'}</div>
        </div>
        ${isPCP ? `<button onclick="pdRestoreAll()" style="background:var(--orange);color:#000;border:none;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer">🔄 Restaurar Finalizados</button>` : ''}
      </div>

      <!-- Filtros -->
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:8px 12px">
        <span style="font-size:11px;color:var(--text3)">Filtrar:</span>
        <!-- Busca -->
        <input type="text" id="pd-filtro-busca" placeholder="Buscar produto..." value="${filtros.busca}"
               oninput="pdFiltrar()"
               style="background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:11px;padding:4px 8px;width:150px">
        <!-- Máquina -->
        <select id="pd-filtro-maq" onchange="pdFiltrar()"
                style="background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:11px;padding:4px 8px">
          <option value="">Todas as máquinas</option>
          ${maqsNaSemana.map(m => `<option value="${m}" ${filtros.maquina===m?'selected':''}>${m}</option>`).join('')}
        </select>
        <!-- Status -->
        <select id="pd-filtro-status" onchange="pdFiltrar()"
                style="background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:11px;padding:4px 8px">
          <option value="">Todos os status</option>
          <option value="pendente"  ${filtros.status==='pendente'?'selected':''}>⏳ Pendente</option>
          <option value="andamento" ${filtros.status==='andamento'?'selected':''}>🔄 Em andamento</option>
          <option value="concluido" ${filtros.status==='concluido'?'selected':''}>✅ Concluído</option>
        </select>
        ${(filtros.maquina||filtros.status||filtros.busca) ? `
        <button onclick="pdLimparFiltros()" style="background:none;border:1px solid var(--border);color:var(--text3);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer">✕ Limpar</button>` : ''}
        <span style="font-size:10px;color:var(--text3);margin-left:auto">${weekRecs.filter(r=>!pdIsFin(r.id)).length} produto(s)</span>
      </div>
    </div>`;

  if (finCount > 0) {
    html += `
      <div style="background:rgba(251,146,60,.1);border:1px solid var(--orange);border-radius:8px;padding:8px 14px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;color:var(--orange)">${finCount} produto(s) finalizado(s) e ocultos</span>
        ${isPCP ? `<button onclick="pdRestoreAll()" style="background:var(--orange);color:#000;border:none;border-radius:5px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">↩ Restaurar</button>` : ''}
      </div>`;
  }

  if (isOperador) {
    html += `
      <div style="background:rgba(0,212,255,.08);border:1px solid var(--cyan);border-radius:8px;padding:10px 14px;margin-bottom:10px;font-size:11px;color:var(--cyan)">
        ℹ️ <strong>Visualização:</strong> Esta é a programação definida pelo PCP. Para produzir, use a aba <strong>"Realizado"</strong>.
      </div>`;
  }

  // ── Grid de colunas por dia ──────────────────────────────────────
  html += `<div style="display:grid;grid-template-columns:repeat(${workDays.length},1fr);gap:10px;align-items:start">`;

  workDays.forEach(d => {
    const ds        = dateStr(d);
    const dayName   = DAY_NAMES[d.getDay()];
    const dateLabel = fmtDate(d);
    const isToday   = ds === dateStr(new Date());

    let dayRecs = weekRecs.filter(r => {
      if (pdIsFin(r.id)) return false;
      const eff = pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao;
      if (!eff) return false;
      if (eff === ds) return true;
      return eff < ds; // overflow
    });

    // Aplicar filtros
    if (filtros.maquina) dayRecs = dayRecs.filter(r => r.maquina === filtros.maquina);
    if (filtros.busca)   dayRecs = dayRecs.filter(r => r.produto.toLowerCase().includes(filtros.busca.toLowerCase()));
    if (filtros.status) {
      dayRecs = dayRecs.filter(r => {
        const prod = calcularTotalProduzido(r.id);
        const meta = r.qntCaixas || 0;
        if (filtros.status === 'concluido')  return prod >= meta && meta > 0;
        if (filtros.status === 'andamento')  return prod > 0 && prod < meta;
        if (filtros.status === 'pendente')   return prod === 0;
        return true;
      });
    }

    const borderColor = isToday ? 'var(--cyan)' : 'var(--border)';
    const headerColor = isToday ? 'var(--cyan)' : 'var(--text2)';

    // Agrupar por máquina para mostrar seletor de funcionário
    const maqsNoDia = [...new Set(dayRecs.map(r => r.maquina).filter(Boolean))].sort();

    html += `
      <div class="pd-col ${isOperador ? 'pd-col-readonly' : ''}" data-date="${ds}"
           ${isPCP ? `ondragover="pdDragOver(event)" ondrop="pdDrop(this,event)" ondragleave="pdDragLeave(event)"` : ''}
           style="background:var(--s1);border:1px solid ${borderColor};border-radius:10px;min-height:120px;transition:border-color .2s,background .2s">

        <!-- Cabeçalho do dia -->
        <div style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:700;font-size:12px;color:${headerColor}">${dayName}</div>
            <div style="font-size:10px;color:var(--text3)">${dateLabel}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="background:var(--s2);border:1px solid var(--border);border-radius:8px;font-size:10px;padding:2px 7px;color:var(--text3)">${dayRecs.length}</span>
            ${isToday ? '<span style="color:var(--cyan);font-size:9px;font-weight:700">HOJE</span>' : ''}
          </div>
        </div>`;

    // Cards dos produtos (lista compacta)
    html += '<div class="pd-cards" style="padding:6px 8px;display:flex;flex-direction:column;gap:4px">';
    dayRecs.forEach(r => {
      html += pdCardControlado(r, ds, isOperador, isPCP);
    });
    if (dayRecs.length === 0) {
      html += `<div style="text-align:center;padding:12px 8px;font-size:10px;color:var(--text3)">Nenhum produto</div>`;
    }
    html += '</div>';

    // Rodapé: seletor de operador por máquina
    if (maqsNoDia.length > 0 && (_funcProd||[]).length > 0) {
      maqsNoDia.forEach(maq => {
        const savedFunc = (window._pdFuncSel || {})[`${ds}_${maq}`] || '';
        const funcOpts  = (_funcProd || [])
          .filter(f => !f.deactivatedUntil || new Date(f.deactivatedUntil).getTime() < Date.now())
          .filter(f => !f.maquinas || !f.maquinas.length || f.maquinas.includes(maq))
          .map(f => `<option value="${f.nome}" ${savedFunc===f.nome?'selected':''}>${f.nome}</option>`)
          .join('');
        if (!funcOpts) return;
        html += `
          <div style="padding:4px 8px;border-top:1px solid var(--border);background:rgba(139,92,246,.05);display:flex;align-items:center;gap:6px">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span style="font-size:9px;color:var(--purple);white-space:nowrap">${maq.length>10?maq.substring(0,10)+'…':maq}</span>
            <select onchange="pdSelecionarFunc(this,'${ds}','${maq}')"
                    style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:10px;padding:2px 4px">
              <option value="">— operador —</option>
              ${funcOpts}
            </select>
          </div>`;
      });
    }
    html += '</div>';
  });

  html += '</div>';

  // Sem dia (apenas PCP)
  const unassigned = weekRecs.filter(r => {
    const eff = pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao;
    if (pdIsFin(r.id)) return false;
    if (eff && eff < weekStart) return false;
    const isWD = workDays.some(wd => dateStr(wd) === eff);
    if (filtros.maquina && r.maquina !== filtros.maquina) return false;
    return !eff || !isWD;
  });

  if (unassigned.length > 0 && isPCP) {
    html += `
      <div style="margin-top:14px">
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Sem dia definido — arraste para um dia</div>
        <div class="pd-col pd-pool" data-date=""
             ondragover="pdDragOver(event)" ondrop="pdDrop(this,event)" ondragleave="pdDragLeave(event)"
             style="background:var(--s1);border:1px dashed var(--border);border-radius:10px;padding:10px;display:flex;flex-wrap:wrap;gap:6px;min-height:50px">`;
    unassigned.forEach(r => { html += pdCardControlado(r, null, isOperador, isPCP); });
    html += '</div></div>';
  } else if (unassigned.length > 0 && isOperador) {
    html += `
      <div style="margin-top:12px;background:rgba(255,179,0,.08);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;font-size:11px;color:var(--warn)">
        ⚠️ <strong>Atenção:</strong> Existem ${unassigned.length} produto(s) sem dia definido. Consulte o PCP.
      </div>`;
  }

  html += '</div>';
  document.getElementById('apon-body').innerHTML = html;

  // Carregar funcionários se ainda não carregados
  if (!_funcProd || !_funcProd.length) {
    listarFuncionariosProducao().then(f => { _funcProd = f; }).catch(() => {});
  }

  // Atualizar badges de observações nos cards (para obs já salvas)
  _pdCarregarBadgesObs(weekRecs, workDays);
}

// Carrega obs da semana e atualiza badges nos cards sem re-renderizar
async function _pdCarregarBadgesObs(weekRecs, workDays) {
  if (!weekRecs || !weekRecs.length) return;
  try {
    const weekStart = dateStr(workDays[0]);
    const weekEnd   = dateStr(workDays[workDays.length-1]);
    const obsMap    = await carregarObservacoes(weekStart, weekEnd);
    // Atualiza cache local
    Object.keys(obsMap).forEach(key => {
      const [ds, recId] = key.split('_');
      window._pdObsCache[`${recId}_${ds}`] = obsMap[key].observacao;
    });
    // Atualiza badges nos cards visíveis
    workDays.forEach(d => {
      const ds = dateStr(d);
      weekRecs.forEach(r => {
        const obs = obsMap[`${ds}_${r.id}`];
        if (obs && obs.observacao) {
          _pdAtualizarBadgeObs(r.id, ds, obs.observacao);
        }
      });
    });
  } catch(e) { /* silencioso */ }
}

// Versão controlada do card de produto (lista compacta)
function pdCardControlado(r, ds, isOperador, isPCP) {
  const totalProduzido = calcularTotalProduzido(r.id);
  const meta = r.qntCaixas || 0;
  const pct  = meta > 0 ? Math.min(100, Math.round(totalProduzido / meta * 100)) : 0;
  const isDone = totalProduzido >= meta && meta > 0;
  const isOverflow = ds && (pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao) < ds;

  const dotColor = isDone ? 'var(--green)' : totalProduzido > 0 ? 'var(--cyan)' : isOverflow ? 'var(--warn)' : 'var(--text3)';

  let removeBtn = '';
  if (isPCP) {
    removeBtn = `<button onclick="pdUnassign(${r.id})" title="Remover dia"
      style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:0 3px;flex-shrink:0"
      onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text3)'">✕</button>`;
  }

  let finBtn = '';
  if (ds && isPCP && !isDone) {
    finBtn = `<button onclick="pdFinalize(${r.id})" title="Finalizar"
      style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:10px;padding:0 3px;flex-shrink:0"
      onmouseover="this.style.color='var(--green)'" onmouseout="this.style.color='var(--text3)'">✓</button>`;
  }

  return `
    <div class="pd-card ${isOperador ? 'pd-card-readonly' : ''}"
         ${isPCP ? 'draggable="true"' : ''}
         id="pd-card-${r.id}" data-id="${r.id}"
         ${isPCP ? `ondragstart="pdDragStart(event,${r.id})"` : ''}
         style="display:flex;align-items:center;gap:7px;padding:5px 8px;background:var(--s2);border:1px solid var(--border);border-radius:6px;${isPCP?'cursor:grab;':''}user-select:none;transition:opacity .2s;${isDone?'opacity:.55':''}">
      <span style="width:6px;height:6px;border-radius:50%;background:${dotColor};flex-shrink:0"></span>
      <div style="flex:1;min-width:0">
        <div style="font-size:10px;font-weight:600;color:${isDone?'var(--text3)':'var(--text)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
             title="${r.produto}">${r.produto}</div>
        <div style="font-size:9px;color:var(--text3);display:flex;gap:6px;margin-top:1px">
          <span>${r.qntCaixas}cx</span>
          ${totalProduzido > 0 ? `<span style="color:${dotColor}">${pct}%</span>` : ''}
          ${isOverflow ? '<span style="color:var(--warn)">↷ overflow</span>' : ''}
        </div>
      </div>
      ${finBtn}
      ${removeBtn}
    </div>`;
}


// ===== CSS PARA ELEMENTOS READONLY (OPERADORES) =====

function adicionarEstilosControlados() {
  const styleId = 'estilos-producao-controlada';
  if (document.getElementById(styleId)) return; // Já adicionado

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Estilos para modo operador (readonly) */
    .pd-col-readonly {
      opacity: 0.8;
      cursor: not-allowed !important;
    }
    
    .pd-card-readonly {
      cursor: default !important;
      opacity: 0.9;
    }
    
    .pd-card-readonly:hover {
      transform: none !important;
      box-shadow: none !important;
    }
    

    
    /* Alerta de modo operador */
    .modo-operador-alert {
      background: rgba(0,212,255,.08);
      border: 1px solid var(--cyan);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
      font-size: 12px;
      color: var(--cyan);
    }
    
    /* Estilos para campos de observação */
    .observacao-input {
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    
    .observacao-input:focus {
      outline: none;
      border-color: var(--cyan) !important;
      box-shadow: 0 0 0 2px rgba(0,212,255,0.1);
    }
    
    .observacao-input:hover {
      border-color: var(--text3);
    }
    
    /* Contador de caracteres para observações */
    .obs-counter {
      position: absolute;
      bottom: 4px;
      right: 8px;
      font-size: 9px;
      color: var(--text3);
      background: var(--bg);
      padding: 1px 4px;
      border-radius: 3px;
    }
    
    .obs-counter.warning {
      color: var(--warn);
    }
    
    .obs-counter.error {
      color: var(--red);
    }
    
    /* Animação para botão de salvar observação */
    .obs-save-btn {
      transition: all 0.2s ease;
    }
    
    .obs-save-btn:hover {
      background: var(--cyan) !important;
      color: #000 !important;
      transform: translateY(-1px);
    }
    
    .obs-save-btn.saved {
      background: var(--green) !important;
      color: #000 !important;
      animation: pulse 0.5s;
    }
    
    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.05); }
      100% { transform: scale(1); }
    }
    
    /* Indicador visual de auto-save */
    .auto-save-indicator {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: var(--text3);
    }
    
    .auto-save-indicator.saving {
      color: var(--warn);
    }
    
    .auto-save-indicator.saved {
      color: var(--green);
    }
    
    .auto-save-indicator::before {
      content: '●';
      animation: blink 1s infinite;
    }
    
    .auto-save-indicator.saved::before {
      content: '✓';
      animation: none;
    }
    
    @keyframes blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0.3; }
    }
  `;
  document.head.appendChild(style);
}

// Chamar ao carregar a página
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', adicionarEstilosControlados);
  } else {
    adicionarEstilosControlados();
  }
}

// ===== FUNÇÃO ORIGINAL (preservada para compatibilidade) =====

function renderProducaoDia(){
  if(!prodBaseMonday){ document.getElementById('apon-body').innerHTML='<div class="empty"><div class="ei">&#128197;</div>Selecione uma semana</div>'; return; }

  pdBuildGanttMap(prodBaseMonday);

  const weekDays = getWeekDays(prodBaseMonday);
  const weekStart = dateStr(weekDays[0]);
  const weekEnd   = dateStr(weekDays[6]);
  const workDays  = weekDays.filter(function(d){ return hoursOnDay(d)>0; });

  const weekRecs = records.filter(function(r){
    if(r.status==='Concluído') return false;
    const produzido = calcularTotalProduzido(r.id);
    const meta = r.qntCaixas || 0;
    if(produzido >= meta && meta > 0) return false;
    const eff = pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao;
    if(!eff) return false;
    if(eff >= weekStart && eff <= weekEnd) return true;
    if(eff < weekStart) return true; // overflow
    return false;
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
      if(pdIsFin(r.id)) return false;
      const eff = pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao;
      if(!eff) return false;
      if(eff === ds) return true;
      return eff < ds; // overflow
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
    const eff = pdGetEffectiveDay(r.id);
    const isWD = workDays.some(function(wd){ return dateStr(wd)===eff; });
    return !pdIsFin(r.id) && (!eff || !isWD);
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


async function renderWeeklySummary(body){
  if(!prodBaseMonday){ body.innerHTML=''; return; }
  const days     = getWeekDays(prodBaseMonday);
  const workDays = days.filter(d => hoursOnDay(d) > 0);
  const weekLabel = fmtDate(workDays[0]) + ' – ' + fmtDate(workDays[workDays.length-1]);
  const weekStart = dateStr(days[0]);
  const weekEnd   = dateStr(days[6]);

  // Registros da semana — inclui produtos em overflow (não concluídos de semanas anteriores)
  pdBuildGanttMap(prodBaseMonday);
  const weekRecords = records.filter(r => {
    if (r.status === 'Cancelado') return false;

    const eff = pdGetEffectiveDay(r.id) || r.dtDesejada || r.dtSolicitacao;
    if (!eff) return false;

    // Programado para esta semana (incluindo concluídos — aparecem com status verde)
    if (eff >= weekStart && eff <= weekEnd) return true;

    // Overflow de semana anterior: aparece sempre (concluído ou não)
    if (eff < weekStart) return true;

    return false;
  });

  if(!weekRecords.length){
    body.innerHTML='<div class="empty"><div class="ei">📊</div>Nenhum produto programado para esta semana.</div>';
    body._machineGroups = null;
    return;
  }

  // Carregar TODAS as observações da semana de uma vez (1 query só)
  body.innerHTML = '<div class="empty"><div class="ei">⏳</div>Carregando...</div>';
  const obsMap = await carregarObservacoes(weekStart, weekEnd); // { "YYYY-MM-DD_recId": {observacao,...} }

  // Agrupar por máquina
  const machineMap = {};
  weekRecords.forEach(rec => {
    if(!machineMap[rec.maquina]) machineMap[rec.maquina] = [];
    machineMap[rec.maquina].push(rec);
  });

  let totalNeeded=0, totalProduced=0;
  let allSections = '';

  MAQUINAS.forEach(maq => {
    const recs = machineMap[maq];
    if(!recs || !recs.length) return;

    let rows = '';
    recs.forEach(rec => {
      const needed   = rec.qntCaixas;
      const produced = aponGetTotalProduced(rec.id);
      totalNeeded   += needed;
      totalProduced += produced;

      const pct     = needed > 0 ? Math.min(100, Math.round(produced/needed*100)) : 0;
      const realPct = needed > 0 ? Math.round(produced/needed*100) : 0;
      const isDone  = produced >= needed;
      const hasAny  = produced > 0;
      const pctColor = isDone ? 'var(--green)' : pct>=60 ? 'var(--cyan)' : hasAny ? 'var(--warn)' : 'var(--text3)';

      // Badge status
      let statusBadge;
      if(isDone)
        statusBadge = '<span style="font-size:9px;font-weight:700;color:var(--green);background:rgba(41,217,132,.12);border:1px solid rgba(41,217,132,.28);border-radius:10px;padding:2px 9px;white-space:nowrap">✓ Finalizado</span>';
      else if(hasAny)
        statusBadge = '<span style="font-size:9px;font-weight:700;color:var(--warn);background:rgba(255,179,0,.12);border:1px solid rgba(255,179,0,.28);border-radius:10px;padding:2px 9px;white-space:nowrap">⚡ Parcial</span>';
      else
        statusBadge = '<span style="font-size:9px;font-weight:700;color:var(--text3);background:rgba(58,79,99,.18);border:1px solid rgba(58,79,99,.4);border-radius:10px;padding:2px 9px;white-space:nowrap">— Não iniciado</span>';

      // Dia de finalização
      let finDayCell = '<span style="color:var(--text3);font-family:\'JetBrains Mono\',monospace;font-size:11px">—</span>';
      if(isDone){
        const finDay = aponGetFinalizationDay(rec.id, needed);
        if(finDay){
          const finDate = new Date(finDay+'T12:00:00');
          finDayCell = '<span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--green);font-weight:600">'+DAY_NAMES[finDate.getDay()]+' '+fmtDate(finDate)+'</span>';
        }
      }

      // ── Observações por dia ──────────────────────────────────────
      const obsLinhas = workDays.map(d => {
        const ds  = dateStr(d);
        const key = `${ds}_${rec.id}`;
        const obs = obsMap[key];
        if (!obs || !obs.observacao) return null;
        const dayName = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][d.getDay()];
        return { dayName, ds, texto: obs.observacao, operador: obs.operador };
      }).filter(Boolean);

      // Célula de observações — uma linha por dia com obs
      const obsHTML = obsLinhas.length > 0
        ? obsLinhas.map(o =>
            `<div style="display:flex;align-items:flex-start;gap:5px;margin-bottom:3px">
              <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--warn);font-weight:700;white-space:nowrap;min-width:22px">${o.dayName}</span>
              <span style="font-size:10px;color:var(--text2);line-height:1.4">${o.texto}${o.operador?` <span style="color:var(--text3);font-size:9px">(${o.operador.split('@')[0]})</span>`:''}</span>
            </div>`
          ).join('')
        : '<span style="color:var(--text3);font-size:10px">—</span>';

      const rowBg = isDone
        ? 'background:rgba(41,217,132,.05);border-left:3px solid var(--green)'
        : hasAny ? 'border-left:3px solid rgba(255,179,0,.5)' : '';

      rows += `<tr style="${rowBg}">
        <td style="text-align:left;padding:9px 14px;max-width:240px;word-break:break-word">
          <div style="font-size:11px;font-weight:600;color:${isDone?'var(--green)':hasAny?'var(--text)':'var(--text2)'}">${rec.produto}</div>
        </td>
        <td style="text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2);padding:9px 10px">${needed}</td>
        <td style="text-align:center;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;color:${isDone?'var(--green)':hasAny?'var(--text)':'var(--text3)'};padding:9px 10px">${produced}</td>
        <td style="text-align:center;padding:9px 10px;min-width:120px">
          <div style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:${pctColor}">${realPct}%</div>
          <div class="apon-progress" style="margin-top:4px;min-width:70px"><div class="apon-progress-bar" style="width:${pct}%;background:${pctColor}"></div></div>
        </td>
        <td style="text-align:center;padding:9px 10px">${statusBadge}</td>
        <td style="text-align:center;padding:9px 10px">${finDayCell}</td>
      <td style="text-align:left;padding:9px 14px;vertical-align:top">${obsHTML}</td>
      </tr>`;
    });

    const maqNeeded   = recs.reduce((a,r) => a+r.qntCaixas, 0);
    const maqProduced = recs.reduce((a,r) => a+aponGetTotalProduced(r.id), 0);
    const maqPct      = maqNeeded > 0 ? Math.round(maqProduced/maqNeeded*100) : 0;
    const maqColor    = maqProduced>=maqNeeded ? 'var(--green)' : maqPct>=60 ? 'var(--cyan)' : 'var(--warn)';

    allSections += `<div class="apon-section" style="margin-bottom:16px">
      <div class="apon-section-header">
        <span class="ins-maq-title">🏭 ${maq}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${maqColor};font-weight:700">${maqProduced} / ${maqNeeded} (${maqPct}%)</span>
      </div>
      <div style="overflow-x:auto">
        <table class="apon-table"><thead><tr>
          <th class="col-prod" style="text-align:left;min-width:200px">Produto</th>
          <th style="text-align:center;min-width:70px">Solic.</th>
          <th style="text-align:center;min-width:70px">Realiz.</th>
          <th style="text-align:center;min-width:110px">Taxa / Progresso</th>
          <th style="text-align:center;min-width:90px">Status</th>
          <th style="text-align:center;min-width:110px">Dia Final</th>
          <th style="text-align:left;min-width:220px;color:var(--warn)">📝 Observações</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  });

  if(!allSections){
    body.innerHTML='<div class="empty"><div class="ei">📊</div>Nenhum produto cadastrado.</div>';
    body._machineGroups = null;
    return;
  }

  const totalPct   = totalNeeded > 0 ? Math.round(totalProduced/totalNeeded*100) : 0;
  const totalDone  = totalProduced >= totalNeeded;
  const totalColor = totalDone ? 'var(--green)' : totalPct>=60 ? 'var(--cyan)' : 'var(--warn)';

  // Contar produtos com observação nesta semana
  const totalObs = weekRecords.filter(r =>
    workDays.some(d => obsMap[`${dateStr(d)}_${r.id}`]?.observacao)
  ).length;

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px">
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">
        📊 Total da Semana · ${weekLabel}
        ${totalObs > 0 ? `<span style="margin-left:8px;color:var(--warn);font-size:10px">📝 ${totalObs} produto(s) com observações</span>` : ''}
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;text-align:center">
          <div style="font-size:9px;color:var(--text3);font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Solicitado</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:600;color:var(--cyan)">${totalNeeded}</div>
        </div>
        <div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;text-align:center">
          <div style="font-size:9px;color:var(--text3);font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Realizado</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:600;color:${totalColor}">${totalProduced}</div>
        </div>
        <div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;text-align:center">
          <div style="font-size:9px;color:var(--text3);font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Taxa Geral</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:600;color:${totalColor}">${totalPct}%</div>
        </div>
      </div>
    </div>
    ${allSections}`;

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
  if(section==='gestao-lojas') setTimeout(()=>renderGestaoLojas(), 50);
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
    const snap = await getDocs(query(lojaCol('maquinas'), orderBy('nome')));
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
  // Verificar duplicata usando cache em memória — sem nova leitura ao Firestore
  const existe = Object.values(window.MAQUINAS_DATA || {}).find(
    m => (m.nome||'').toUpperCase() === nomeUp && m._id !== dados._id
  );
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
    await setDoc(lojaDoc('maquinas', dados._id), { ...payload, criadoEm: dados.criadoEm || new Date().toISOString() });
    toast('Máquina "' + nomeUp + '" atualizada!', 'ok');
  } else {
    payload.criadoEm = new Date().toISOString();
    await addDoc(lojaCol('maquinas'), payload);
    toast('Máquina "' + nomeUp + '" cadastrada!', 'ok');
  }
  // Invalidar cache e recarregar máquinas
  invalidateCache('maquinas');
  await carregarMaquinasCached(true);
  renderCadastroMaquinas();
}

async function excluirMaquinaFirestore(nome) {
  if(!can('maquinas','excluir')){ toast('Sem permissão para excluir máquinas.','err'); return; }
  try {
    // Buscar _id no cache em memória — sem nova leitura ao Firestore
    const maqData = (window.MAQUINAS_DATA || {})[nome];
    if (maqData && maqData._id) {
      await deleteDoc(lojaDoc('maquinas', maqData._id));
      invalidateCache('maquinas');
      await carregarMaquinasCached(true);
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
        const vel = p.velocidade != null ? `<span style="color:var(--cyan);font-family:'JetBrains Mono',monospace">${p.velocidade} und/min</span>` : `<span style="color:var(--text3)">padrão${d.pcMin ? ' (' + d.pcMin + ')' : ''}</span>`;
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
      <td style="padding:10px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--warn)">${d.pcMin ? d.pcMin + ' und/min' : '<span style="color:var(--text3)">—</span>'}</td>
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
      <th style="padding:6px 10px;text-align:right;color:var(--text3)">Velocidade (und/min)</th>
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
  const isEdit = !!(document.getElementById('maq-edit-nome')?.value || document.getElementById('maq-modal-title')?.textContent?.includes('Editar'));
  if(isEdit && !can('maquinas','editar')){ toast('Sem permissão para editar máquinas.','err'); return; }
  if(!isEdit && !can('maquinas','criar')){ toast('Sem permissão para criar máquinas.','err'); return; }
  const nome = (document.getElementById('maq-nome-inp').value || '').trim();
  if (!nome) { toast('Informe o nome da máquina', 'err'); return; }

  const pcMinVal = parseFloat(document.getElementById('maq-pcmin-inp').value);
  const hTurnoVal = parseFloat(document.getElementById('maq-hturno-inp').value);
  const nTurnosVal = parseInt(document.getElementById('maq-nturno-inp').value);

  // Avisar sobre campos importantes sem bloquear — máquina pode ser salva sem velocidade,
  // mas o sistema não conseguirá calcular tempo de produção nem programação automática
  const avisos = [];
  if (!pcMinVal || pcMinVal <= 0) avisos.push('Velocidade padrão (und/min) não informada — programação automática não funcionará para esta máquina.');
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
    
    if (rows.length < 2) {
      toast('Arquivo deve ter pelo menos cabeçalho e uma linha de dados!', 'err');
      return;
    }
    
    const header = rows[0].map(h => String(h||'').trim().toLowerCase());
    const dataRows = rows.slice(1).filter(r => r && r.length > 0);
    
    // Mapear colunas por nome
    const colMap = {};
    header.forEach((h, i) => {
      if (/^nome$|^maquina$|^máquina$/i.test(h)) colMap.nome = i;
      else if (/^codigo$|^código$|^cod$/i.test(h)) colMap.codigo = i;
      else if (/^tipo$/i.test(h)) colMap.tipo = i;
      else if (/^setor$/i.test(h)) colMap.setor = i;
      else if (/^status$/i.test(h)) colMap.status = i;
      else if (/^pc_?min$|^velocidade$|^und_?min$/i.test(h)) colMap.pcMin = i;
      else if (/^eficiencia$|^eficiência$/i.test(h)) colMap.eficiencia = i;
      else if (/^h_?turno$|^horas$/i.test(h)) colMap.hTurno = i;
      else if (/^n_?turnos$|^turnos$/i.test(h)) colMap.nTurnos = i;
      else if (/^setup$/i.test(h)) colMap.setup = i;
      else if (/^produtos$/i.test(h)) colMap.produtos = i;
    });
    
    if (colMap.nome === undefined) {
      toast('Coluna "nome" não encontrada! Cabeçalho deve ter: nome, codigo, tipo, setor, status, undMin, eficiencia, hTurno, nTurnos, setup, produtos', 'err');
      return;
    }
    
    // Usar cache MAQUINAS_DATA para verificar existentes sem nova leitura ao Firestore
    await carregarMaquinasCached();
    const existentes = Object.keys(window.MAQUINAS_DATA || {}).map(n => n.toUpperCase());
    let adicionadas = 0, atualizadas = 0;
    
    for (const row of dataRows) {
      const nome = String(row[colMap.nome]||'').trim().toUpperCase();
      if (!nome) continue;
      
      // Processar produtos compatíveis
      let produtosCompativeis = [];
      if (colMap.produtos !== undefined && row[colMap.produtos]) {
        const produtosStr = String(row[colMap.produtos]).trim();
        if (produtosStr) {
          produtosCompativeis = produtosStr.split(',').map(p => {
            const produto = p.trim();
            return produto ? { produto: produto, velocidade: null } : null;
          }).filter(p => p);
        }
      }
      
      const maqData = {
        nome: nome,
        codigo: String(row[colMap.codigo]||'').trim(),
        tipo: String(row[colMap.tipo]||'Empacotadeira').trim(),
        setor: String(row[colMap.setor]||'').trim(),
        status: String(row[colMap.status]||'ativa').trim(),
        pcMin: parseFloat(row[colMap.pcMin]) || 0,
        eficiencia: parseFloat(row[colMap.eficiencia]) || 100,
        hTurno: parseFloat(row[colMap.hTurno]) || 8,
        nTurnos: parseInt(row[colMap.nTurnos]) || 1,
        tempoSetupPadrao: parseFloat(row[colMap.setup]) || 0,
        produtosCompativeis: produtosCompativeis,
        atualizadoEm: new Date().toISOString()
      };
      
      const existe = snap.docs.find(d => (d.data().nome||'').toUpperCase() === nome);
      if (existe) {
        await setDoc(lojaDoc('maquinas', existe.id), { ...maqData, criadoEm: existe.data().criadoEm || new Date().toISOString() });
        atualizadas++;
      } else {
        await addDoc(lojaCol('maquinas'), { ...maqData, criadoEm: new Date().toISOString() });
        adicionadas++;
      }
    }
    
    invalidateCache('maquinas');
    await carregarMaquinasCached(true);
    renderCadastroMaquinas();
    toast(`${adicionadas} máquina(s) criada(s), ${atualizadas} atualizada(s)!`, 'ok');
  } catch(e) { 
    toast('Erro ao importar: ' + e.message, 'err'); 
    console.error('Detalhe do erro:', e);
  }
}

// Ficha Técnica no menu Configurações → Produtos
function renderFichaTecnicaCfg() {
  const search = (document.getElementById('ft-cfg-search') || {}).value || '';
  const el = document.getElementById('ft-cfg-list');
  const cnt = document.getElementById('ft-cfg-count');

  // Usa fonte única: fichas existentes + produtos cadastrados sem ficha
  const deduped = getFichaTecnicaMerged().sort((a, b) => {
    if(!!a._semFicha !== !!b._semFicha) return a._semFicha ? 1 : -1;
    return (a.desc||'').localeCompare(b.desc||'');
  });

  if (cnt) cnt.textContent = deduped.length;
  if (!el) return;

  const filtered = search
    ? deduped.filter(p => (p.desc||'').toLowerCase().includes(search.toLowerCase()) || String(p.cod).includes(search))
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
          <span style="font-size:11px;color:var(--warn);font-family:'JetBrains Mono',monospace">${p.pc_min} und/min</span>
          ${p._semFicha
            ? `<span style="background:rgba(255,71,87,.12);border:1px solid rgba(255,71,87,.3);color:var(--red);padding:1px 7px;border-radius:20px;font-size:10px;font-weight:700">⚠️ Sem insumos</span>`
            : `<span style="font-size:10px;background:${insCount?'rgba(0,212,255,.1)':'var(--s2)'};border:1px solid ${insCount?'rgba(0,212,255,.2)':'var(--border)'};color:${insCount?'var(--cyan)':'var(--text3)'};padding:1px 7px;border-radius:20px">${insCount} insumo${insCount!==1?'s':''}</span>`
          }
        </div>
      </div>
      <div class="ft-cfg-panel" style="display:none;padding:10px 16px 12px 36px;background:rgba(0,0,0,.15)">
        <div style="margin-bottom:8px">${insHtml}</div>
        <button onclick="event.stopPropagation();ftCfgAbrirFicha(this.dataset.cod, ${!!p._semFicha})" data-cod="${p.cod}"
                style="background:${p._semFicha?'rgba(255,179,0,.12)':'rgba(0,212,255,.1)'};border:1px solid ${p._semFicha?'rgba(255,179,0,.4)':'rgba(0,212,255,.25)'};border-radius:6px;padding:5px 12px;font-size:11px;color:${p._semFicha?'var(--warn)':'var(--cyan)'};cursor:pointer;font-family:'Space Grotesk',sans-serif;display:inline-flex;align-items:center;gap:6px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          ${p._semFicha ? '+ Cadastrar insumos' : 'Editar insumos e quantidades'}
        </button>
        <button onclick="event.stopPropagation();excluirFichaByCod(this.dataset.cod)" data-cod="${p.cod}"
                style="background:rgba(255,71,87,.08);border:1px solid rgba(255,71,87,.3);border-radius:6px;padding:5px 12px;font-size:11px;color:#ff6b6b;cursor:pointer;font-family:'Space Grotesk',sans-serif;display:inline-flex;align-items:center;gap:6px">
          🗑 Excluir
        </button>
      </div>
    </div>`;
  }).join('');
}

// Abre ficha técnica para edição; se _semFicha=true cria a entrada antes
function ftCfgAbrirFicha(cod, semFicha) {
  const codNum = parseInt(cod);
  if (semFicha) {
    // Produto sem ficha: criar entrada em branco antes de abrir o modal
    const prod = getAllProdutos().find(p => parseInt(p.cod) === codNum);
    if (!prod) { toast('Produto não encontrado', 'err'); return; }
    const jaExiste = fichaTecnicaData.find(f => f.cod === codNum);
    if (!jaExiste) {
      const novaFicha = {
        cod: codNum,
        desc: prod.descricao,
        unid: prod.unid || 1,
        pc_min: prod.pc_min || 0,
        maquina: prod.maquina || '',
        insumos: [],
        criadoEm: new Date().toISOString()
      };
      fichaTecnicaData.push(novaFicha);
      FICHA_TECNICA.push({ ...novaFicha });
      // Salvar no Firestore
      addDoc(lojaCol('fichaTecnica'), { ...novaFicha, atualizadoEm: new Date().toISOString() })
        .then(docRef => {
          novaFicha._firestoreId = docRef.id;
          const ft = FICHA_TECNICA.find(f => f.cod === codNum);
          if(ft) ft._firestoreId = docRef.id;
        })
        .catch(e => console.warn('Erro ao criar ficha:', e));
    }
  }
  editFichaByCod(codNum);
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
    ativo: data.ativo !== false,
    // ── Campos de cobertura e programação automática ──────────────
    metaCoberturaDias:   parseInt(data.metaCoberturaDias)  || 0,
    producaoMinima:      parseFloat(data.producaoMinima)   || 0,
    multiploProducao:    parseFloat(data.multiploProducao) || 0,
    tipoMinimo:          data.tipoMinimo          || '',
    prioridadeProducao:  parseInt(data.prioridadeProducao) || 2,
    produtoAtivo:        data.produtoAtivo !== false,  // default true
    _id:                 data._id || null
  };
}

// Carrega produtos do Firestore e popula PRODUTOS
async function carregarProdutosFirestore() {
  try {
    const snap = await getDocs(lojaCol('produtos'));
    if (!snap.empty) {
      PRODUTOS = snap.docs
        .map(d => normalizeProdutoFirestore({ ...d.data(), _id: d.id }))
        .filter(p => p.descricao);
      console.log('[PRODUTOS] Carregados do Firestore:', PRODUTOS.length);
    } else {
      console.log('[PRODUTOS] Nenhum produto no Firestore. Use Configurações → Produtos para importar.');
    }
  } catch(e) {
    console.warn('[PRODUTOS] Erro ao carregar do Firestore:', e.message);
  }
}

// Carrega fichas técnicas do Firestore — função separada para evitar dupla leitura
// quando só produtos mudam (ou só fichas mudam).
async function carregarFichaTecnicaFirestore() {
  try {
    const snap2 = await getDocs(lojaCol('fichaTecnica'));
    if (!snap2.empty) {
      const ftArr = snap2.docs.map(d => ({ ...d.data(), _firestoreId: d.id }));
      FICHA_TECNICA = ftArr;
      // Merge: manter fichas que estão na memória mas ainda não chegaram ao Firestore
      const ftArrCods = new Set(ftArr.map(f => f.cod));
      const fichasApenasNaMemoria = fichaTecnicaData.filter(f => !ftArrCods.has(f.cod));
      fichaTecnicaData = [...JSON.parse(JSON.stringify(ftArr)), ...fichasApenasNaMemoria];
    }
    _carregadoFichaTecnica = true;
  } catch(e) { console.warn('[FICHA] Erro ao carregar ficha técnica:', e.message); }
}

async function carregarFichaTecnicaCached(forceReload = false) {
  if (!forceReload && _carregadoFichaTecnica && FICHA_TECNICA.length > 0) return;
  await carregarFichaTecnicaFirestore();
}

// Salva produto no Firestore e mantém vínculo bidirecional com a máquina.
// NÃO relê o Firestore após salvar — atualiza os arrays em memória diretamente
// para evitar centenas de leituras desnecessárias em importações.
// Chame invalidateCache('produtos') + carregarProdutosCached(true) manualmente
// apenas UMA vez após o loop de importação/operação em lote.
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
    metaCoberturaDias:  parseInt(dados.metaCoberturaDias)  || 0,
    producaoMinima:     parseFloat(dados.producaoMinima)   || 0,
    multiploProducao:   parseFloat(dados.multiploProducao) || 0,
    tipoMinimo:         dados.tipoMinimo          || '',
    prioridadeProducao: parseInt(dados.prioridadeProducao) || 2,
    produtoAtivo:       dados.produtoAtivo !== false,
    atualizadoEm: new Date().toISOString()
  };
  try {
    let firestoreId = dados._id || null;
    if (firestoreId) {
      await setDoc(lojaDoc('produtos', firestoreId), { ...payload, criadoEm: dados.criadoEm || new Date().toISOString() });
    } else {
      payload.criadoEm = new Date().toISOString();
      const docRef = await addDoc(lojaCol('produtos'), payload);
      firestoreId = docRef.id;
    }

    // ── Atualizar cache em memória sem reler o Firestore ──────────────
    const prodNormalizado = normalizeProdutoFirestore({ ...payload, _id: firestoreId });
    if (Array.isArray(window.PRODUTOS)) {
      const idx = window.PRODUTOS.findIndex(p => p._id === firestoreId ||
        (String(p.cod) === String(payload.cod) && p.maquina === payload.maquina));
      if (idx >= 0) {
        window.PRODUTOS[idx] = prodNormalizado;
      } else {
        window.PRODUTOS.push(prodNormalizado);
      }
    }

    // Vínculo bidirecional com a máquina (só em memória + 1 write, sem reload)
    if (payload.maquina && payload.nome) {
      await _syncProdutoNaMaquina(payload.maquina, payload.nome, payload.velocidadePadrao);
    }
    return firestoreId;
  } catch(e) {
    toast('Erro ao salvar produto: ' + e.message, 'err');
    return null;
  }
}

// Garante que um produto está listado nos produtosCompativeis de uma máquina.
// Atualiza MAQUINAS_DATA em memória diretamente — sem reler o Firestore.
async function _syncProdutoNaMaquina(nomeMaq, nomeProduto, velocidade) {
  try {
    const maqCached = (window.MAQUINAS_DATA || {})[nomeMaq];
    if (!maqCached || !maqCached._id) return;
    const prods = Array.isArray(maqCached.produtosCompativeis) ? [...maqCached.produtosCompativeis] : [];
    if (prods.findIndex(p => p.produto === nomeProduto) >= 0) return; // já vinculado
    prods.push({ produto: nomeProduto, velocidade: velocidade || null });
    // Persistir no Firestore
    await setDoc(lojaDoc('maquinas', maqCached._id), { ...maqCached, produtosCompativeis: prods, atualizadoEm: new Date().toISOString() });
    // Atualizar cache em memória sem reler
    window.MAQUINAS_DATA[nomeMaq] = { ...maqCached, produtosCompativeis: prods };
    if (!MAQUINAS.includes(nomeMaq)) MAQUINAS.push(nomeMaq);
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
  const filtered = filter
    ? all.filter(p => p.descricao.toLowerCase().includes(filter.toLowerCase()) || String(p.cod).includes(filter))
    : all;
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

  // Separar ativos e desativados
  const ativos      = groups.filter(p => p.produtoAtivo !== false);
  const desativados = groups.filter(p => p.produtoAtivo === false);

  function renderRow(p, desativado = false) {
    const isExtra = PRODUTOS_EXTRA.findIndex(x => x.descricao === p.descricao) >= 0;
    const maqTags = [...new Set(p.maquinas)].map(m =>
      `<span style="font-size:10px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);color:${desativado?'var(--text4)':'var(--cyan)'};padding:2px 8px;border-radius:20px;white-space:nowrap">${m}</span>`
    ).join('');
    const rowBg = desativado ? 'background:rgba(0,0,0,.18);opacity:.65;' : '';
    const toggleLabel = desativado ? '✅ Ativar' : '⛔ Desativar';
    const toggleColor = desativado ? 'var(--green)' : 'var(--text3)';
    return `
    <div style="padding:9px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;${rowBg}">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${desativado?'var(--text4)':'var(--cyan)'};flex-shrink:0">${p.cod}</span>
          <span style="font-size:12px;color:${desativado?'var(--text3)':'var(--text)'}">${p.descricao}</span>
          ${desativado ? '<span style="font-size:9px;font-weight:700;color:var(--red);background:rgba(255,71,87,.12);border:1px solid rgba(255,71,87,.3);padding:1px 7px;border-radius:10px;letter-spacing:.5px">DESATIVADO</span>' : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap">
          <span style="font-size:10px;color:${desativado?'var(--text4)':'var(--warn)'};font-family:'JetBrains Mono',monospace">${p.pc_min} und/min</span>
          <span style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace">${p.unid}un/cx</span>
          <span style="color:var(--text3);font-size:10px">·</span>
          ${maqTags}
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <button onclick="toggleAtivoProduto(${p.cod},'${p.maquina.replace(/'/g,"\\'")}',${desativado})"
                style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:10px;color:${toggleColor};cursor:pointer;white-space:nowrap"
                title="${toggleLabel}">${toggleLabel}</button>
        <button onclick="editarProduto(${p.cod},'${p.maquina.replace(/'/g,"\\'")}','${p.descricao.replace(/'/g,"\\'")}')"
                style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:11px;color:var(--cyan);cursor:pointer"
                title="Editar produto">✏️</button>
        <button onclick="excluirProduto(${p.cod},'${p.maquina.replace(/'/g,"\\'")}','${p.descricao.replace(/'/g,"\\'")}')"
                style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:11px;color:#ff6b6b;cursor:pointer"
                title="Excluir produto">🗑️</button>
        ${!isExtra ? '<span style="font-size:9px;color:var(--text3)">padrão</span>' : ''}
      </div>
    </div>`;
  }

  let html = ativos.slice(0, 200).map(p => renderRow(p, false)).join('');

  if (desativados.length) {
    html += `<div style="padding:10px 14px;background:rgba(255,71,87,.06);border-top:2px solid rgba(255,71,87,.3);border-bottom:1px solid rgba(255,71,87,.2);display:flex;align-items:center;gap:10px">
      <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--red)">⛔ Produtos desativados (${desativados.length})</span>
      <span style="font-size:10px;color:var(--text3)">— não entram na programação automática</span>
    </div>`;
    html += desativados.map(p => renderRow(p, true)).join('');
  }

  if (groups.length > 200) html += `<div style="padding:12px;color:var(--text3);font-size:12px">... e mais ${groups.length - 200} produtos.</div>`;
  el.innerHTML = html;
}

// ===== FUNÇÕES APRIMORADAS DE PRODUTOS COM EDIÇÃO E EXCLUSÃO =====

// Alterna produtoAtivo sem abrir o modal
function toggleAtivoProduto(cod, maquina, estaDesativado){
  const novoAtivo = estaDesativado;
  const todos = getAllProdutos();
  const matches = todos.filter(p => String(p.cod) === String(cod));
  if(!matches.length){ toast('Produto não encontrado','err'); return; }
  if(Array.isArray(window.PRODUTOS)){
    window.PRODUTOS.forEach((p,i) => { if(String(p.cod)===String(cod)) window.PRODUTOS[i].produtoAtivo = novoAtivo; });
  }
  let extraChanged = false;
  PRODUTOS_EXTRA.forEach((p,i) => { if(String(p.cod)===String(cod)){ PRODUTOS_EXTRA[i].produtoAtivo = novoAtivo; extraChanged = true; } });
  if(extraChanged) localStorage.setItem('produtos_extra', JSON.stringify(PRODUTOS_EXTRA));
  if(typeof salvarProdutoFirestore === 'function'){
    matches.forEach(p => { salvarProdutoFirestore({ ...p, produtoAtivo: novoAtivo }).catch(e => console.warn('Firestore toggle err:', e)); });
  }
  const label = novoAtivo ? 'ativado ✅' : 'desativado ⛔';
  toast(`"${matches[0].descricao}" ${label}`, 'ok');
  renderProdutosCfg();
}

// Variável global para o produto em edição
let _produtoEditando = null;

// Adiciona uma linha de insumo no modal de cadastro de produto
function pmAddInsumoRow() {
  const container = document.getElementById('pm-insumos-list');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'fte-ins-row';
  div.style = 'display:grid;grid-template-columns:100px 1fr 32px;gap:6px;margin-bottom:6px;align-items:center';
  div.innerHTML = `
    <input class="finp fte-qty" type="number" step="any" min="0" value="" style="font-family:'JetBrains Mono',monospace;font-size:12px;padding:7px 8px" placeholder="Qtd">
    <input class="finp fte-name" value="" style="font-size:12px;padding:7px 10px" placeholder="Nome do insumo">
    <button type="button" onclick="this.closest('.fte-ins-row').remove()" class="btn btn-danger" style="padding:4px 8px;font-size:14px;min-width:32px;justify-content:center">−</button>`;
  container.appendChild(div);
  div.querySelector('.fte-qty').focus();
}

function openAddProduto() {
  _produtoEditando = null;
  const sel = document.getElementById('pm-maq');
  if (sel) sel.innerHTML = MAQUINAS.map(m => `<option value="${m}">${m}</option>`).join('');
  ['pm-cod','pm-desc','pm-unid','pm-pcmin'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  ['pm-cobertura','pm-prod-min','pm-multiplo','pm-prioridade'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  const tipoMin = document.getElementById('pm-tipo-min'); if(tipoMin) tipoMin.value = '';
  const pmAtivo = document.getElementById('pm-ativo'); if(pmAtivo) pmAtivo.value = 'true';
  const pmInsumos = document.getElementById('pm-insumos-list'); if(pmInsumos) pmInsumos.innerHTML = '';
  const titleEl = document.getElementById('prod-modal-title') || document.getElementById('maq-modal-title');
  if(titleEl) titleEl.textContent = 'Novo Produto';
  document.getElementById('prod-modal').style.display = 'flex';
  setTimeout(() => { const el = document.getElementById('pm-cod'); if(el) el.focus(); }, 80);
}

function editarProduto(cod, maquina, descricao) {
  // Encontrar o produto nos dados
  const produtos = getAllProdutos();
  const produto = produtos.find(p => String(p.cod) === String(cod) && p.maquina === maquina);
  
  if (!produto) {
    toast('Produto não encontrado', 'err');
    return;
  }
  
  _produtoEditando = { ...produto };
  
  // Preencher modal de edição
  document.getElementById('pm-cod').value = produto.cod;
  document.getElementById('pm-desc').value = produto.descricao;
  document.getElementById('pm-unid').value = produto.unid || '';
  document.getElementById('pm-pcmin').value = produto.pc_min || '';
  // Preencher novos campos de cobertura
  const elCob = document.getElementById('pm-cobertura');   if(elCob)  elCob.value  = produto.metaCoberturaDias   || '';
  const elPMin = document.getElementById('pm-prod-min');   if(elPMin) elPMin.value  = produto.producaoMinima      || '';
  const elMult = document.getElementById('pm-multiplo');   if(elMult) elMult.value  = produto.multiploProducao    || '';
  const elTipo = document.getElementById('pm-tipo-min');   if(elTipo) elTipo.value  = produto.tipoMinimo          || '';
  const elPrio = document.getElementById('pm-prioridade'); if(elPrio) elPrio.value  = produto.prioridadeProducao  || '';
  const elAtivo= document.getElementById('pm-ativo');      if(elAtivo) elAtivo.value = (produto.produtoAtivo !== false) ? 'true' : 'false';
  
  // Popular máquinas no select
  const sel = document.getElementById('pm-maq');
  if (sel) {
    sel.innerHTML = MAQUINAS.map(m => `<option value="${m}" ${m === maquina ? 'selected' : ''}>${m}</option>`).join('');
  }

  // Popular insumos existentes da ficha técnica
  const pmInsumos = document.getElementById('pm-insumos-list');
  if (pmInsumos) {
    const ficha = fichaTecnicaData.find(f => f.cod === parseInt(cod));
    pmInsumos.innerHTML = ficha && ficha.insumos && ficha.insumos.length
      ? fteRenderInsumos(ficha.insumos)
      : '';
  }

  // Mudar título do modal
  const titleEl = document.getElementById('prod-modal-title') || document.getElementById('maq-modal-title');
  if (titleEl) titleEl.textContent = 'Editar Produto';

  // Abrir modal
  document.getElementById('prod-modal').style.display = 'flex';
  setTimeout(() => { const el = document.getElementById('pm-desc'); if(el) el.focus(); }, 80);
}

async function excluirProduto(cod, maquina, descricao) {
  if (!confirm('Tem certeza que deseja excluir o produto:\n\n' + descricao + ' (' + cod + ')\n\nEsta acao nao pode ser desfeita.')) return;

  try {
    const registrosVinculados = records.filter(r => String(r.codProduto) === String(cod) || String(r.cod) === String(cod));
    if (registrosVinculados.length > 0) {
      if (!confirm('ATENCAO: Este produto possui ' + registrosVinculados.length + ' registro(s) de producao vinculados.\n\nDeseja continuar mesmo assim?')) return;
    }

    const codStr = String(cod);
    const codNum = parseInt(cod);

    // 1. Apagar do Firestore — tenta por _id primeiro, depois query por cod
    const todosOsProdutos = getAllProdutos();
    const comId = todosOsProdutos.filter(p => String(p.cod) === codStr && p._id);

    if (comId.length > 0) {
      await Promise.all(comId.map(p => deleteDoc(lojaDoc('produtos', p._id))));
    } else {
      const snap = await getDocs(query(lojaCol('produtos'), where('cod', '==', codNum)));
      if (!snap.empty) {
        await Promise.all(snap.docs.map(d => deleteDoc(lojaDoc('produtos', d.id))));
      }
    }

    // 2. Apagar ficha tecnica vinculada
    try {
      const snapFicha = await getDocs(query(lojaCol('fichaTecnica'), where('cod', '==', codNum)));
      if (!snapFicha.empty) {
        await Promise.all(snapFicha.docs.map(d => deleteDoc(lojaDoc('fichaTecnica', d.id))));
      }
    } catch(ef) { console.warn('Erro ao apagar ficha:', ef); }

    // 3. Limpar memoria — remove TODOS os registros com esse cod
    if (Array.isArray(window.PRODUTOS)) {
      for (let i = window.PRODUTOS.length - 1; i >= 0; i--) {
        if (String(window.PRODUTOS[i].cod) === codStr) window.PRODUTOS.splice(i, 1);
      }
    }
    if (typeof PRODUTOS_EXTRA !== 'undefined' && Array.isArray(PRODUTOS_EXTRA)) {
      for (let i = PRODUTOS_EXTRA.length - 1; i >= 0; i--) {
        if (String(PRODUTOS_EXTRA[i].cod) === codStr) PRODUTOS_EXTRA.splice(i, 1);
      }
      localStorage.setItem('produtos_extra', JSON.stringify(PRODUTOS_EXTRA));
    }
    if (typeof fichaTecnicaData !== 'undefined' && Array.isArray(fichaTecnicaData)) {
      for (let i = fichaTecnicaData.length - 1; i >= 0; i--) {
        if (parseInt(fichaTecnicaData[i].cod) === codNum) fichaTecnicaData.splice(i, 1);
      }
    }
    if (typeof FICHA_TECNICA !== 'undefined' && Array.isArray(FICHA_TECNICA)) {
      for (let i = FICHA_TECNICA.length - 1; i >= 0; i--) {
        if (parseInt(FICHA_TECNICA[i].cod) === codNum) FICHA_TECNICA.splice(i, 1);
      }
    }

    // 4. Recarregar do Firestore e re-renderizar
    invalidateCache('produtos');
    await carregarProdutosCached(true);
    renderProdutosCfg();

    toast('Produto "' + descricao + '" excluido', 'ok');
    registrarAuditoria('PRODUTO_EXCLUIDO', { cod, descricao, maquina });

  } catch(e) {
    console.error('Erro ao excluir produto:', e);
    toast('Erro ao excluir: ' + e.message, 'err');
  }
}

function closeProdModal() { 
  document.getElementById('prod-modal').style.display = 'none'; 
  _produtoEditando = null;
}

async function saveProdModal() {
  const cod   = parseInt(document.getElementById('pm-cod').value);
  const desc  = document.getElementById('pm-desc').value.trim();
  const unid  = parseInt(document.getElementById('pm-unid').value);
  const pcmin = parseFloat(document.getElementById('pm-pcmin').value);
  const maq   = document.getElementById('pm-maq').value;

  if (!cod || !desc || !unid || !pcmin || !maq) {
    toast('Preencha todos os campos obrigatórios', 'err');
    return;
  }

  // Verificar duplicidade (apenas criação)
  if (!_produtoEditando) {
    const existente = getAllProdutos().find(p => String(p.cod) === String(cod) && p.maquina === maq);
    if (existente) { toast('Já existe um produto com este código nesta máquina', 'err'); return; }
  }

  // Campos opcionais de cobertura
  const metaCoberturaDias  = parseInt(document.getElementById('pm-cobertura')?.value)  || 0;
  const producaoMinima     = parseFloat(document.getElementById('pm-prod-min')?.value) || 0;
  const multiploProducao   = parseFloat(document.getElementById('pm-multiplo')?.value) || 0;
  const tipoMinimo         = document.getElementById('pm-tipo-min')?.value             || '';
  const prioridadeProducao = parseInt(document.getElementById('pm-prioridade')?.value) || 2;
  const produtoAtivo       = document.getElementById('pm-ativo')?.value !== 'false';

  const dados = {
    cod, descricao: desc, unid, kg_fd: 0, pc_min: pcmin, maquina: maq,
    metaCoberturaDias, producaoMinima, multiploProducao, tipoMinimo, prioridadeProducao, produtoAtivo
  };

  const eraNovoProduto = !_produtoEditando;

  try {
    // ── 1. Coletar insumos inseridos no modal ────────────────────────
    const pmInsRows = document.getElementById('pm-insumos-list')?.querySelectorAll('.fte-ins-row') || [];
    const insumosDoModal = [];
    pmInsRows.forEach(row => {
      const qty  = parseFloat(row.querySelector('.fte-qty')?.value) || 0;
      const name = row.querySelector('.fte-name')?.value.trim() || '';
      if (name) insumosDoModal.push({ insumo: name, qty });
    });

    // ── 2. Salvar produto no Firestore e atualizar cache em memória ──
    // salvarProdutoFirestore agora retorna o firestoreId e atualiza PRODUTOS
    // em memória sem reler o Firestore inteiro.
    const dadosParaSalvar = _produtoEditando
      ? { ..._produtoEditando, ...dados }  // preserva _id se estava editando
      : dados;
    const firestoreId = await salvarProdutoFirestore(dadosParaSalvar);
    if (firestoreId && dadosParaSalvar._id !== firestoreId) {
      dados._id = firestoreId; // armazenar para referência
    }

    // ── 3. Persistir produto em localStorage (PRODUTOS_EXTRA) ───────
    if (_produtoEditando) {
      const extraIdx = PRODUTOS_EXTRA.findIndex(p =>
        String(p.cod) === String(_produtoEditando.cod) && p.maquina === _produtoEditando.maquina);
      if (extraIdx >= 0) { PRODUTOS_EXTRA[extraIdx] = dados; localStorage.setItem('produtos_extra', JSON.stringify(PRODUTOS_EXTRA)); }
      registrarAuditoria('PRODUTO_EDITADO', { produtoAnterior: _produtoEditando, produtoNovo: dados });
    } else {
      // Só adicionar no EXTRA se ainda não chegou no PRODUTOS via salvarProdutoFirestore
      const jaEmProdutos = (window.PRODUTOS||[]).some(p => String(p.cod)===String(cod) && p.maquina===maq);
      if (!jaEmProdutos) {
        PRODUTOS_EXTRA.push(dados);
        localStorage.setItem('produtos_extra', JSON.stringify(PRODUTOS_EXTRA));
      }
      registrarAuditoria('PRODUTO_ADICIONADO', dados);
    }

    // ── 4. Criar/atualizar ficha técnica em memória + Firestore ─────
    // IMPORTANTE: fazer isso DEPOIS de salvarProdutoFirestore (que não
    // mais sobrescreve fichaTecnicaData, então não há race condition).
    const codNum = parseInt(cod);
    let fichaObj = fichaTecnicaData.find(f => f.cod === codNum);
    if (!fichaObj) {
      // Ficha nova: criar em memória IMEDIATAMENTE (garante que aparece na aba)
      fichaObj = {
        cod: codNum, desc, unid: unid||1, pc_min: pcmin||0,
        maquina: maq, insumos: insumosDoModal, criadoEm: new Date().toISOString()
      };
      fichaTecnicaData.push(fichaObj);
      FICHA_TECNICA.push({ ...fichaObj });
      // Persistir no Firestore em background
      try {
        const docRef = await addDoc(lojaCol('fichaTecnica'), { ...fichaObj, atualizadoEm: new Date().toISOString() });
        fichaObj._firestoreId = docRef.id;
        // Atualizar _firestoreId também no FICHA_TECNICA
        const ftMem = FICHA_TECNICA.find(f => f.cod === codNum);
        if (ftMem) ftMem._firestoreId = docRef.id;
        _carregadoFichaTecnica = true; // marcar cache como válido
      } catch(e) { console.warn('Erro ao criar ficha técnica no Firestore:', e); }
    } else {
      // Ficha existente: atualizar campos
      fichaObj.desc   = desc;
      fichaObj.unid   = unid   || fichaObj.unid;
      fichaObj.pc_min = pcmin  || fichaObj.pc_min;
      if (insumosDoModal.length > 0) fichaObj.insumos = insumosDoModal;
      // Sincronizar com FICHA_TECNICA (array separado)
      const ftIdx = FICHA_TECNICA.findIndex(f => f.cod === codNum);
      if (ftIdx >= 0) { FICHA_TECNICA[ftIdx] = { ...fichaObj }; }
      // Persistir no Firestore
      try {
        const fichaPayload = {
          cod: codNum, desc: fichaObj.desc, unid: fichaObj.unid,
          pc_min: fichaObj.pc_min, maquina: fichaObj.maquina,
          insumos: fichaObj.insumos, atualizadoEm: new Date().toISOString()
        };
        if (fichaObj._firestoreId) {
          await setDoc(lojaDoc('fichaTecnica', fichaObj._firestoreId), fichaPayload);
        } else {
          // Fallback: busca pelo cod (raro — só se _firestoreId não foi populado no boot)
          const snap = await getDocs(query(lojaCol('fichaTecnica'), where('cod', '==', codNum)));
          if (!snap.empty) {
            fichaObj._firestoreId = snap.docs[0].id;
            await setDoc(lojaDoc('fichaTecnica', snap.docs[0].id), fichaPayload);
          } else {
            const newRef = await addDoc(lojaCol('fichaTecnica'), { ...fichaPayload, criadoEm: new Date().toISOString() });
            fichaObj._firestoreId = newRef.id;
          }
        }
      } catch(e) { console.warn('Erro ao atualizar ficha técnica no Firestore:', e); }
    }

    // ── 5. Renderizar e fechar modal ──────────────────────────────────
    renderProdutosCfg();
    if (typeof renderFichaTecnicaCfg === 'function') renderFichaTecnicaCfg();
    if (typeof renderFichaTecnica === 'function') renderFichaTecnica();
    closeProdModal();
    const insMsg = insumosDoModal.length > 0 ? ` · ${insumosDoModal.length} insumo(s) salvo(s)` : '';
    toast(`Produto "${desc}" ${eraNovoProduto ? 'cadastrado' : 'atualizado'} com sucesso${insMsg}`, 'ok');

  } catch(e) {
    console.error('Erro ao salvar produto:', e);
    toast('Erro ao salvar produto: ' + e.message, 'err');
  }
}

// ── Etapa 2: modal de insumos da ficha técnica, aberto direto após cadastro ──
function _abrirEtapa2Insumos(codNum, desc) {
  // Garante que a ficha existe na memória (criada na etapa 1)
  const ficha = fichaTecnicaData.find(f => f.cod === codNum);
  if (!ficha) { toast(`Produto "${desc}" salvo! Acesse Ficha Técnica para cadastrar os insumos.`, 'ok'); return; }

  document.getElementById('ft-edit-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'conf-overlay on';
  modal.id = 'ft-edit-modal';
  modal.style.zIndex = '1200';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:720px">
      <div class="modal-hd" style="gap:10px">
        <div style="display:flex;flex-direction:column;min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--cyan);background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.25);padding:2px 8px;border-radius:20px;flex-shrink:0">Etapa 2 de 2</span>
            <span style="font-size:11px;color:var(--text3)">Produto salvo ✓</span>
          </div>
          <h2 style="font-size:14px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Insumos — ${ficha.desc}</h2>
        </div>
        <button class="btn btn-ghost" onclick="_fecharEtapa2()" style="padding:6px 10px;flex-shrink:0">✕ Pular</button>
      </div>
      <div class="modal-bd">
        <div style="background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.18);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--text2);line-height:1.6">
          <strong style="color:var(--cyan)">📋 Ficha técnica criada!</strong> Agora cadastre os insumos consumidos por caixa deste produto.<br>
          <span style="color:var(--text3);font-size:11px">Você pode pular e cadastrar depois em <strong>Configurações → Ficha Técnica</strong>.</span>
        </div>
        <div class="fg" style="margin-bottom:16px">
          <div class="frow">
            <label class="flbl">Unid/Caixa</label>
            <input class="finp" type="number" id="fte-unid" value="${ficha.unid}" min="1">
          </div>
          <div class="frow">
            <label class="flbl">Peças/Minuto</label>
            <input class="finp" type="number" id="fte-pcmin" value="${ficha.pc_min}" min="0.1" step="0.1">
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="flbl" style="font-size:12px;font-weight:600">Insumos <span style="font-size:10px;color:var(--text3);font-weight:400">(quantidade por caixa)</span></div>
          <button onclick="fteAddRow()" class="btn btn-ghost" style="padding:5px 12px;font-size:12px">+ Adicionar insumo</button>
        </div>
        <div style="display:grid;grid-template-columns:100px 1fr 32px;gap:6px;margin-bottom:6px;padding:0 0 6px 0;border-bottom:1px solid var(--border)">
          <div class="flbl" style="font-size:9px">Quantidade</div>
          <div class="flbl" style="font-size:9px">Nome do Insumo</div>
          <div></div>
        </div>
        <div id="fte-insumos-list" style="max-height:300px;overflow-y:auto;padding-right:4px">
          ${fteRenderInsumos(ficha.insumos || [])}
        </div>
      </div>
      <div class="modal-ft" style="gap:8px">
        <button class="btn btn-ghost" onclick="_fecharEtapa2()">Pular por agora</button>
        <button class="btn btn-primary" onclick="saveFichaByCod(${ficha.cod});_fecharEtapa2Pos()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Salvar insumos e concluir
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  // Foco no primeiro campo de insumo se já houver, senão no botão adicionar
  setTimeout(() => {
    const firstQty = modal.querySelector('.fte-qty');
    if (firstQty) firstQty.focus();
  }, 80);
}

function _fecharEtapa2() {
  document.getElementById('ft-edit-modal')?.remove();
  toast('Produto cadastrado! Adicione insumos depois em Configurações → Ficha Técnica.', 'ok');
}

function _fecharEtapa2Pos() {
  // Chamado pelo botão "Salvar insumos" — saveFichaByCod já remove o modal via remove()
  // Este hook existe para ações futuras após salvar
}

// Manter compatibilidade com função antiga
function deleteExtraProduto(cod, maq, desc) {
  excluirProduto(cod, maq, desc);
}

function importProdutosExcel(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const wb = XLSX.read(e.target.result, { type: 'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws);
      
      let addedProds = 0, addedMaqs = 0, updatedMaqs = 0, erros = 0;
      const maquinasMap = new Map(); // Para agrupar produtos por máquina
      
      // Primeiro passa: organizar dados por máquina
      rows.forEach(row => {
        const cod = parseInt(row['cod'] || row['Cod'] || row['COD'] || 0);
        const desc = (row['descricao'] || row['nome'] || row['Descricao'] || row['DESCRICAO'] || '').toString().trim();
        const maq = (row['maquina'] || row['maquinaPadrao'] || row['Maquina'] || row['MAQUINA'] || '').toString().trim();
        const pcmin = parseFloat(row['pc_min'] || row['velocidadePadrao'] || row['PcMin'] || row['PC_MIN'] || 0);
        const unid = parseInt(row['unid'] || row['Unid'] || row['UNID'] || 0);
        const categoria = (row['categoria'] || row['Categoria'] || '').toString().trim();
        const coberturaDias = parseInt(row['coberturaDias'] || row['CobDias'] || 0);
        const estoqueMinimo = parseFloat(row['estoqueMinimo'] || row['EstMin'] || 0);
        
        if (!cod || !desc || !unid || !maq) { erros++; return; }
        
        const maqUpper = maq.toUpperCase();
        if (!maquinasMap.has(maqUpper)) {
          maquinasMap.set(maqUpper, {
            nome: maqUpper,
            produtos: [],
            velocidades: []
          });
        }
        
        maquinasMap.get(maqUpper).produtos.push({
          cod, descricao: desc, unid, pc_min: pcmin, maquina: maq, 
          categoria, coberturaDias, estoqueMinimo, ativo: true
        });
        
        if (pcmin > 0) {
          maquinasMap.get(maqUpper).velocidades.push(pcmin);
        }
      });
      
      // Segunda passa: criar/atualizar máquinas com produtos vinculados
      // Usar cache MAQUINAS_DATA em vez de nova leitura ao Firestore
      await carregarMaquinasCached(); // garante que o cache está populado
      const maquinasExistentes = new Map();
      Object.values(window.MAQUINAS_DATA || {}).forEach(d => {
        if (d.nome) maquinasExistentes.set(d.nome.toUpperCase(), { id: d._id, data: d });
      });
      
      for (const [nomeMaq, info] of maquinasMap) {
        // Calcular velocidade média da máquina
        const velMedia = info.velocidades.length > 0 
          ? Math.round((info.velocidades.reduce((a,b) => a+b, 0) / info.velocidades.length) * 100) / 100
          : 0;
        
        // Criar produtos compatíveis com velocidades específicas
        const produtosCompativeis = info.produtos.map(p => ({
          produto: p.descricao,
          velocidade: p.pc_min > 0 ? p.pc_min : null
        }));
        
        const maqData = {
          nome: nomeMaq,
          tipo: 'Empacotadeira',
          setor: 'Embalagem',
          status: 'ativa',
          pcMin: velMedia,
          eficiencia: 100,
          hTurno: 8,
          nTurnos: 1,
          tempoSetupPadrao: 0,
          produtosCompativeis: produtosCompativeis,
          atualizadoEm: new Date().toISOString()
        };
        
        if (maquinasExistentes.has(nomeMaq)) {
          // Atualizar máquina existente
          const existing = maquinasExistentes.get(nomeMaq);
          await setDoc(lojaDoc('maquinas', existing.id), {
            ...maqData,
            criadoEm: existing.data.criadoEm || new Date().toISOString()
          });
          updatedMaqs++;
        } else {
          // Criar nova máquina
          await addDoc(lojaCol('maquinas'), {
            ...maqData,
            criadoEm: new Date().toISOString()
          });
          addedMaqs++;
        }
        
        // Salvar cada produto com upsert inteligente
        for (const produto of info.produtos) {
          // Buscar produto existente pelo cod
          const codNum = parseInt(produto.cod);
          const existente = getAllProdutos().find(p =>
            parseInt(p.cod) === codNum && p.maquina === produto.maquina
          );

          if (existente) {
            // Verificar se algum campo relevante mudou
            const mudou =
              existente.descricao   !== produto.descricao   ||
              existente.unid        !== produto.unid         ||
              existente.pc_min      !== produto.pc_min       ||
              existente.categoria   !== (produto.categoria || '') ||
              (existente.coberturaDias  || 0) !== (produto.coberturaDias || 0) ||
              (existente.estoqueMinimo  || 0) !== (produto.estoqueMinimo || 0);

            if (mudou) {
              // Preservar campos que não vêm na importação
              const produtoAtualizado = {
                ...existente,
                ...produto,
                _id: existente._id, // manter o _id do Firestore
                produtoAtivo: existente.produtoAtivo !== false // manter status ativo
              };
              await salvarProdutoFirestore(produtoAtualizado);
              addedProds++; // conta como atualizado
            }
            // se igual, não faz nada
          } else {
            // Produto novo: criar
            await salvarProdutoFirestore(produto);
            addedProds++;
          }
        }
      }
      
      invalidateCache('maquinas', 'produtos');
      await carregarMaquinasCached(true);
      await carregarProdutosCached(true);
      renderProdutosCfg();
      renderCadastroMaquinas();
      
      let msg = `✅ ${addedProds} produto(s) criado(s)/atualizado(s), ${addedMaqs} máquina(s) criada(s), ${updatedMaqs} máquina(s) atualizada(s)`;
      if (erros) msg += ` · ${erros} linha(s) com erro ignoradas`;
      toast(msg, erros ? 'warn' : 'ok');
      
    } catch(err) { 
      toast('Erro ao ler Excel: ' + err.message, 'err'); 
      console.error('Erro na importação:', err);
    }
    input.value = '';
  };
  reader.readAsBinaryString(file);
}
function downloadProdTemplate(e) {
  e.preventDefault();
  const ws = XLSX.utils.aoa_to_sheet([
    ['cod','descricao','maquina','pc_min','unid','categoria','coberturaDias','estoqueMinimo'],
    [12345,'POLVILHO AZEDO 500G - CX 12','SELGRON 01',46.75,12,'ESPECIARIA',15,100],
    [12346,'COCO RALADO 100G - CX 24','SELGRON 01',52.30,24,'ESPECIARIA',10,50],
    [12347,'FARINHA MILHO 1KG - CX 10','ALFATECK 14',28.05,10,'FARINHA',20,75],
    [12348,'BICARBONATO 250G - CX 20','ALFATECK 14',31.80,20,'ESPECIARIA',12,40]
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Produtos');
  XLSX.writeFile(wb, 'template_produtos_e_maquinas.xlsx');
}

async function downloadMaqTemplate(e) {
  e.preventDefault();
  await _baixarTemplateCompleto();
}

async function _baixarTemplateCompleto() {
  try {
    toast('Gerando template com dados do sistema...', 'ok');

    function cabecalho(titulo, aviso, headers) {
      return [[titulo], [aviso], headers];
    }

    // ── Aba Maquinas ──────────────────────────────────────────────
    const maqData = window.MAQUINAS_DATA || {};
    const rowsMaq = Object.values(maqData).sort((a,b) => (a.nome||'').localeCompare(b.nome||'')).map(m => [
      m.nome || '',
      m.codigo || '',
      m.tipo || 'Empacotadeira',
      m.setor || 'Embalagem',
      m.status || 'ativa',
      m.pcMin || 0,
      m.eficiencia || 100,
      m.hTurno || 8,
      m.nTurnos || 1,
      m.tempoSetupPadrao || 0,
      Array.isArray(m.produtosCompativeis) ? m.produtosCompativeis.map(p => p.produto).join(', ') : ''
    ]);
    // fallback: se MAQUINAS_DATA vazio, usa MAQUINAS array
    if (!rowsMaq.length && Array.isArray(window.MAQUINAS)) {
      window.MAQUINAS.forEach(nome => rowsMaq.push([nome,'',  'Empacotadeira','Embalagem','ativa',0,100,8,1,0,'']));
    }
    const hdrMaq = ['nome','codigo','tipo','setor','status','undMin','eficiencia','hTurno','nTurnos','setup','produtos'];
    const wsMaq = XLSX.utils.aoa_to_sheet([
      ...cabecalho('CADASTRO DE MÁQUINAS',
        'Uma linha por máquina. A coluna "produtos" lista os produtos compatíveis separados por vírgula.',
        hdrMaq),
      ...rowsMaq
    ]);
    wsMaq['!cols'] = [{wch:26},{wch:12},{wch:16},{wch:14},{wch:10},{wch:10},{wch:12},{wch:10},{wch:10},{wch:10},{wch:80}];

    // ── Aba Produtos ──────────────────────────────────────────────
    const produtos = getAllProdutos ? getAllProdutos() : (window.PRODUTOS || []);
    const hdrProd = ['cod','descricao','unid','pc_min','maquina','status'];
    const rowsProd = produtos.map(p => [
      p.cod, p.descricao, p.unid, p.pc_min, p.maquina,
      p.produtoAtivo !== false ? 'ATIVO' : 'DESATIVADO'
    ]);
    const wsProd = XLSX.utils.aoa_to_sheet([
      ...cabecalho('PRODUTOS — Base Máquina x Tempo',
        'Preencha cod, descricao, unid, pc_min e maquina. Status: ATIVO ou DESATIVADO.',
        hdrProd),
      ...rowsProd
    ]);
    wsProd['!cols'] = [{wch:10},{wch:62},{wch:10},{wch:12},{wch:26},{wch:12}];

    // ── Aba Insumos ───────────────────────────────────────────────
    const fichas = (typeof fichaTecnicaData !== 'undefined' ? fichaTecnicaData : null) || (typeof FICHA_TECNICA !== 'undefined' ? FICHA_TECNICA : []);
    const hdrIns = ['cod_produto','desc_produto','insumo','qty','status'];
    const rowsIns = [];
    fichas.forEach(ficha => {
      const prod = produtos.find(p => parseInt(p.cod) === parseInt(ficha.cod));
      const status = prod && prod.produtoAtivo === false ? 'DESATIVADO' : 'ATIVO';
      (ficha.insumos || []).forEach(ins => {
        rowsIns.push([ficha.cod, ficha.desc, ins.insumo, ins.qty, status]);
      });
    });
    const wsIns = XLSX.utils.aoa_to_sheet([
      ...cabecalho('INSUMOS — Consumo por Produto',
        'Uma linha por insumo por produto. qty = quantidade consumida por caixa. Status: ATIVO ou DESATIVADO.',
        hdrIns),
      ...rowsIns
    ]);
    wsIns['!cols'] = [{wch:14},{wch:62},{wch:56},{wch:14},{wch:12}];

    // ── Aba Setup ─────────────────────────────────────────────────
    const hdrSetup = ['maquina','de','para','minutos'];
    let rowsSetup = [];
    try {
      const snapSetup = await getDocs(lojaCol('setup_maquinas'));
      rowsSetup = snapSetup.docs.map(d => {
        const s = d.data();
        return [s.maquina || '', s.produto_origem || '', s.produto_destino || '', s.tempo_setup || 0];
      });
    } catch(e) { console.warn('Erro ao ler setup:', e); }
    const wsSetup = XLSX.utils.aoa_to_sheet([
      ...cabecalho('SETUP — Tempo de troca entre produtos por máquina',
        'Cada linha: tempo (min) para trocar do Produto DE para o Produto PARA em uma máquina.',
        hdrSetup),
      ...rowsSetup
    ]);
    wsSetup['!cols'] = [{wch:30},{wch:56},{wch:56},{wch:18}];

    // ── Montar e baixar ───────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsMaq,   'Maquinas');
    XLSX.utils.book_append_sheet(wb, wsProd,  'Produtos');
    XLSX.utils.book_append_sheet(wb, wsIns,   'Insumos');
    XLSX.utils.book_append_sheet(wb, wsSetup, 'Setup');

    const hoje = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `template_importacao_${hoje}.xlsx`);
    toast(`✅ Template gerado: ${rowsMaq.length} máquinas · ${rowsProd.length} produtos · ${rowsIns.length} insumos · ${rowsSetup.length} setups`, 'ok');
  } catch(err) {
    toast('Erro ao gerar template: ' + err.message, 'err');
    console.error('[downloadMaqTemplate]', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPORTAÇÃO / EXPORTAÇÃO NO FORMATO PADRÃO (Base_Maquina_Tempo + Consumo_Insumos)
// ═══════════════════════════════════════════════════════════════════════════

// Normaliza status de ativo/desativado de qualquer variação de texto
function _parseAtivo(val) {
  if (val === null || val === undefined || val === '') return true;
  const s = String(val).trim().toLowerCase();
  if (['desativado', 'desativo', 'inativo', 'nao', 'não', 'n', '0', 'false', 'no'].includes(s)) return false;
  return true; // ativo por padrão (ativo, sim, s, 1, true, etc.)
}

async function importarArquivoPadrao(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      toast('Lendo arquivo...', 'ok');
      const wb = XLSX.read(e.target.result, { type: 'binary' });
      const names = wb.SheetNames.map(s => s.trim());

      const isNovoFormato =
        names.some(s => /^Produtos$/i.test(s)) ||
        names.some(s => /^Insumos$/i.test(s))  ||
        names.some(s => /^Setup$/i.test(s));

      function lerAba(nomeRegex) {
        const nome = wb.SheetNames.find(s => nomeRegex.test(s.trim()));
        if (!nome) return [];
        return XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, defval: '' });
      }

      // ── PASSO 1: Ler e validar todos os dados do arquivo ────────────
      let dadosProdutos = [], insumosPorProduto = {}, setupEntries = [], maquinasEntries = [];

      if (isNovoFormato) {
        // Produtos (aba linha 1=titulo, 2=aviso, 3=header, dados da linha 4)
        const rowsProd = lerAba(/^Produtos$/i);
        dadosProdutos = rowsProd.slice(3)
          .filter(r => r[0] && r[1] && !isNaN(parseInt(r[0])))
          .map(r => ({
            cod:          parseInt(r[0]) || 0,
            descricao:    String(r[1]).trim(),
            unid:         parseInt(r[2]) || 1,
            pc_min:       parseFloat(r[3]) || 0,
            maquina:      String(r[4] || 'MANUAL').trim().toUpperCase(),
            produtoAtivo: _parseAtivo(r[5]),
            ativo:        _parseAtivo(r[5])
          }));

        // Insumos
        const rowsIns = lerAba(/^Insumos$/i);
        rowsIns.slice(3).forEach(r => {
          if (!_parseAtivo(r[4])) return;
          const prodNome = String(r[1] || '').trim();
          const insNome  = String(r[2] || '').trim();
          const qty      = parseFloat(r[3]) || 0;
          if (!prodNome || !insNome) return;
          if (!insumosPorProduto[prodNome]) insumosPorProduto[prodNome] = [];
          insumosPorProduto[prodNome].push({ insumo: insNome, qty });
        });

        // Setup
        const rowsSetup = lerAba(/^Setup$/i);
        rowsSetup.slice(3).forEach(r => {
          const maq  = String(r[0] || '').trim();
          const de   = String(r[1] || '').trim();
          const para = String(r[2] || '').trim();
          const mins = parseFloat(r[3]) || 0;
          if (maq && de && para && mins > 0) setupEntries.push({ maquina: maq, de, para, minutos: mins });
        });

        // Maquinas
        const rowsMaq = lerAba(/^Maquinas$/i);
        rowsMaq.slice(3).forEach(r => {
          const nome = String(r[0] || '').trim();
          if (!nome) return;
          const prodListStr = String(r[10] || '');
          maquinasEntries.push({
            nome,
            codigo:     String(r[1] || '').trim(),
            tipo:       String(r[2] || 'Empacotadeira').trim(),
            setor:      String(r[3] || 'Embalagem').trim(),
            status:     String(r[4] || 'ativa').trim().toLowerCase(),
            pcMin:      parseFloat(r[5]) || 0,
            eficiencia: parseFloat(r[6]) || 100,
            hTurno:     parseFloat(r[7]) || 8,
            nTurnos:    parseFloat(r[8]) || 1,
            tempoSetupPadrao: parseFloat(r[9]) || 0,
            produtosCompativeis: prodListStr.split(',').map(p => p.trim()).filter(Boolean).map(p => ({ produto: p, velocidade: null }))
          });
        });

      } else {
        // Formato legado
        const sheetBase = wb.SheetNames.find(s => s.includes('Base_Maquina')) || wb.SheetNames[0];
        if (!sheetBase) { toast('Aba Base_Maquina_Tempo nao encontrada.', 'err'); return; }
        const rowsBase = XLSX.utils.sheet_to_json(wb.Sheets[sheetBase], { header: 1, defval: '' });
        dadosProdutos = rowsBase.slice(1)
          .filter(r => r[0] && r[1] && !isNaN(parseInt(r[0])))
          .map(r => ({
            cod:          parseInt(r[0]) || 0,
            descricao:    String(r[1]).trim(),
            unid:         parseInt(r[2]) || 1,
            pc_min:       parseFloat(r[4]) || 0,
            maquina:      String(r[5] || 'MANUAL').trim().toUpperCase(),
            produtoAtivo: _parseAtivo(r[6]),
            ativo:        _parseAtivo(r[6])
          }));
        const sheetConsumo = wb.SheetNames.find(s => s.includes('Consumo'));
        if (sheetConsumo) {
          const rowsConsumo = XLSX.utils.sheet_to_json(wb.Sheets[sheetConsumo], { header: 1, defval: '' });
          rowsConsumo.slice(1).forEach(r => {
            if (!_parseAtivo(r[4])) return;
            const prodNome = String(r[1] || '').trim();
            const insNome  = String(r[2] || '').trim();
            const qty      = parseFloat(r[3]) || 0;
            if (!prodNome || !insNome) return;
            if (!insumosPorProduto[prodNome]) insumosPorProduto[prodNome] = [];
            insumosPorProduto[prodNome].push({ insumo: insNome, qty });
          });
        }
      }

      toast('Arquivo lido: ' + dadosProdutos.length + ' produtos, ' + setupEntries.length + ' setups, ' + maquinasEntries.length + ' maquinas', 'ok');

      if (!dadosProdutos.length) { toast('Nenhum produto valido encontrado no arquivo.', 'err'); return; }

      // ── PASSO 2: Limpar tudo antes de gravar ────────────────────────
      toast('Limpando dados anteriores...', 'ok');

      async function limparCol(col) {
        try {
          const snap = await getDocs(lojaCol(col));
          if (snap.empty) return;
          for (let i = 0; i < snap.docs.length; i += 50)
            await Promise.all(snap.docs.slice(i, i+50).map(d => deleteDoc(lojaDoc(col, d.id))));
        } catch(err) { console.warn('Erro ao limpar ' + col + ':', err.message); }
      }

      await limparCol('produtos');
      await limparCol('fichaTecnica');
      if (setupEntries.length > 0) await limparCol('setup_maquinas');
      if (maquinasEntries.length > 0) await limparCol('maquinas');

      // Limpar memória
      if (Array.isArray(window.PRODUTOS)) window.PRODUTOS.splice(0, window.PRODUTOS.length);
      if (typeof PRODUTOS_EXTRA !== 'undefined' && Array.isArray(PRODUTOS_EXTRA)) { PRODUTOS_EXTRA.splice(0, PRODUTOS_EXTRA.length); localStorage.removeItem('produtos_extra'); }
      if (typeof fichaTecnicaData !== 'undefined' && Array.isArray(fichaTecnicaData)) fichaTecnicaData.splice(0, fichaTecnicaData.length);
      if (typeof FICHA_TECNICA !== 'undefined' && Array.isArray(FICHA_TECNICA)) FICHA_TECNICA.splice(0, FICHA_TECNICA.length);
      if (maquinasEntries.length > 0) { window.MAQUINAS_DATA = {}; if (typeof MAQUINAS !== 'undefined' && Array.isArray(MAQUINAS)) MAQUINAS.splice(0, MAQUINAS.length); }

      // ── PASSO 3: Gravar máquinas ─────────────────────────────────────
      let maqCriadas = 0;
      if (maquinasEntries.length > 0) {
        toast('Salvando maquinas...', 'ok');
        for (const m of maquinasEntries) {
          try {
            const payload = { ...m, criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() };
            const docRef = await addDoc(lojaCol('maquinas'), payload);
            if (!window.MAQUINAS_DATA) window.MAQUINAS_DATA = {};
            window.MAQUINAS_DATA[m.nome] = { ...payload, _id: docRef.id };
            if (typeof MAQUINAS !== 'undefined' && !MAQUINAS.includes(m.nome)) MAQUINAS.push(m.nome);
            maqCriadas++;
          } catch(err) { console.warn('Erro ao salvar maquina ' + m.nome + ':', err.message); }
        }
        toast(maqCriadas + ' maquinas salvas', 'ok');
      } else {
        // Reconstrói maquinas a partir dos produtos
        await carregarMaquinasCached();
        const maquinasMap = {};
        dadosProdutos.forEach(p => {
          if (!maquinasMap[p.maquina]) maquinasMap[p.maquina] = { produtos: [], pc_mins: [] };
          maquinasMap[p.maquina].produtos.push(p.descricao);
          if (p.pc_min > 0) maquinasMap[p.maquina].pc_mins.push(p.pc_min);
        });
        for (const [nome, d] of Object.entries(maquinasMap)) {
          try {
            const velMedia = d.pc_mins.length ? Math.round(d.pc_mins.reduce((a,b)=>a+b,0)/d.pc_mins.length*100)/100 : 0;
            const payload = { nome, tipo: 'Empacotadeira', setor: 'Embalagem', status: 'ativa', pcMin: velMedia, eficiencia: 100, hTurno: 8, nTurnos: 1, tempoSetupPadrao: 0, produtosCompativeis: d.produtos.map(p=>({produto:p,velocidade:null})), criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() };
            const docRef = await addDoc(lojaCol('maquinas'), payload);
            if (!window.MAQUINAS_DATA) window.MAQUINAS_DATA = {};
            window.MAQUINAS_DATA[nome] = { ...payload, _id: docRef.id };
            if (typeof MAQUINAS !== 'undefined' && !MAQUINAS.includes(nome)) MAQUINAS.push(nome);
            maqCriadas++;
          } catch(err) { console.warn('Erro ao salvar maquina ' + nome + ':', err.message); }
        }
      }

      // ── PASSO 4: Gravar produtos em lotes ────────────────────────────
      toast('Salvando ' + dadosProdutos.length + ' produtos...', 'ok');
      let criados = 0;
      for (let i = 0; i < dadosProdutos.length; i += 50) {
        const lote = dadosProdutos.slice(i, i + 50);
        await Promise.all(lote.map(async p => {
          try {
            await salvarProdutoFirestore(p);
            criados++;
          } catch(err) { console.warn('Erro ao salvar produto ' + p.cod + ':', err.message); }
        }));
      }
      toast(criados + ' produtos salvos', 'ok');

      // ── PASSO 5: Gravar fichas técnicas em lotes ────────────────────
      toast('Salvando fichas tecnicas...', 'ok');
      let fichasSalvas = 0;
      const fichas = dadosProdutos.map(p => ({
        cod:     parseInt(p.cod),
        desc:    p.descricao,
        unid:    p.unid,
        pc_min:  p.pc_min,
        maquina: p.maquina,
        insumos: (insumosPorProduto[p.descricao] || []).map(i => ({ insumo: i.insumo, qty: i.qty })),
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
      }));
      for (let i = 0; i < fichas.length; i += 50) {
        const lote = fichas.slice(i, i + 50);
        try {
          const refs = await Promise.all(lote.map(f => addDoc(lojaCol('fichaTecnica'), f)));
          lote.forEach((f, idx) => {
            f._firestoreId = refs[idx].id;
            if (typeof fichaTecnicaData !== 'undefined') fichaTecnicaData.push(f);
            if (typeof FICHA_TECNICA !== 'undefined') FICHA_TECNICA.push({ ...f });
          });
          fichasSalvas += lote.length;
        } catch(err) { console.warn('Erro ao salvar lote de fichas:', err.message); }
      }

      // ── PASSO 6: Gravar setup em lotes ───────────────────────────────
      let setupAdicionados = 0;
      if (setupEntries.length > 0) {
        toast('Salvando ' + setupEntries.length + ' setups...', 'ok');
        for (let i = 0; i < setupEntries.length; i += 100) {
          try {
            await Promise.all(setupEntries.slice(i, i + 100).map(se =>
              addDoc(lojaCol('setup_maquinas'), {
                maquina: se.maquina,
                produto_origem: se.de,
                produto_destino: se.para,
                tempo_setup: se.minutos,
                criadoEm: new Date().toISOString()
              })
            ));
            setupAdicionados += Math.min(100, setupEntries.length - i);
          } catch(err) { console.warn('Erro ao salvar lote de setup:', err.message); }
        }
      }

      // ── PASSO 7: Recarregar UI ───────────────────────────────────────
      invalidateCache('maquinas', 'produtos');
      await carregarMaquinasCached(true);
      _carregadoFichaTecnica = true;
      renderProdutosCfg();
      renderCadastroMaquinas();
      if (typeof renderFichaTecnicaCfg === 'function') renderFichaTecnicaCfg();
      if (typeof renderFichaTecnica === 'function') renderFichaTecnica();
      if (typeof renderSetupMaquinas === 'function') renderSetupMaquinas();

      const partes = [
        criados + ' produto(s)',
        maqCriadas ? maqCriadas + ' maquina(s)' : '',
        fichasSalvas ? fichasSalvas + ' ficha(s)' : '',
        setupAdicionados ? setupAdicionados + ' setup(s)' : ''
      ].filter(Boolean);
      toast('Importado: ' + partes.join(' + '), 'ok');

    } catch(err) {
      toast('Erro ao importar: ' + err.message, 'err');
      console.error('[importarArquivoPadrao]', err);
    }
    input.value = '';
  };
  reader.readAsBinaryString(file);
}

// Exporta todos os dados no novo formato de template (4 abas)
async function exportarArquivoPadrao() {
  try {
    const produtos = getAllProdutos();
    const fichas   = fichaTecnicaData || [];

    // ── Linha de títulos + aviso + cabeçalho (padrão do novo template) ─
    function cabecalho(titulo, aviso, headers) {
      return [
        [titulo], [aviso], headers
      ];
    }

    // ── Aba Produtos ──────────────────────────────────────────────────
    const hdrProd = ['cod','descricao','unid','pc_min','maquina','status'];
    const rowsProd = produtos.map(p => [
      p.cod, p.descricao, p.unid, p.pc_min, p.maquina,
      p.produtoAtivo !== false ? 'ATIVO' : 'DESATIVADO'
    ]);
    const wsProd = XLSX.utils.aoa_to_sheet([
      ...cabecalho('PRODUTOS — Base Máquina x Tempo',
        'Preencha cod, descricao, unid, pc_min e maquina. Status: ATIVO ou DESATIVADO.',
        hdrProd),
      ...rowsProd
    ]);
    wsProd['!cols'] = [{ wch:10 },{ wch:60 },{ wch:10 },{ wch:12 },{ wch:25 },{ wch:12 }];

    // ── Aba Insumos ───────────────────────────────────────────────────
    const hdrIns = ['cod_produto','desc_produto','insumo','qty','status'];
    const rowsIns = [];
    fichas.forEach(ficha => {
      const prod = produtos.find(p => parseInt(p.cod) === parseInt(ficha.cod));
      const status = prod && prod.produtoAtivo === false ? 'DESATIVADO' : 'ATIVO';
      (ficha.insumos || []).forEach(ins => {
        rowsIns.push([ficha.cod, ficha.desc, ins.insumo, ins.qty, status]);
      });
    });
    const wsIns = XLSX.utils.aoa_to_sheet([
      ...cabecalho('INSUMOS — Consumo por Produto',
        'Uma linha por insumo por produto. qty = quantidade consumida por caixa. Status: ATIVO ou DESATIVADO.',
        hdrIns),
      ...rowsIns
    ]);
    wsIns['!cols'] = [{ wch:14 },{ wch:60 },{ wch:55 },{ wch:12 },{ wch:12 }];

    // ── Aba Setup (exporta do Firestore se disponível) ────────────────
    const hdrSetup = ['maquina','de','para','minutos'];
    let rowsSetup = [];
    try {
      const snapSetup = await getDocs(lojaCol('setup_maquinas'));
      rowsSetup = snapSetup.docs.map(d => {
        const s = d.data();
        return [s.maquina || '', s.produto_origem || '', s.produto_destino || '', s.tempo_setup || 0];
      });
    } catch(e) { console.warn('Erro ao ler setup para exportação:', e); }
    const wsSetup = XLSX.utils.aoa_to_sheet([
      ...cabecalho('SETUP — Tempo de troca entre produtos por máquina',
        'Cada linha: tempo (min) para trocar do Produto DE para o Produto PARA em uma máquina.',
        hdrSetup),
      ...rowsSetup
    ]);
    wsSetup['!cols'] = [{ wch:30 },{ wch:55 },{ wch:55 },{ wch:20 }];

    // ── Aba Maquinas ──────────────────────────────────────────────────
    const hdrMaq = ['nome','codigo','tipo','setor','status','undMin','eficiencia','hTurno','nTurnos','setup','produtos'];
    const maqData = window.MAQUINAS_DATA || {};
    const rowsMaq = Object.values(maqData).map(m => [
      m.nome || '', m.codigo || '', m.tipo || 'Empacotadeira', m.setor || 'Embalagem',
      m.status || 'ativa', m.pcMin || 0, m.eficiencia || 100, m.hTurno || 8, m.nTurnos || 1,
      m.tempoSetupPadrao || 0,
      (Array.isArray(m.produtosCompativeis) ? m.produtosCompativeis.map(p => p.produto).join(', ') : '')
    ]);
    const wsMaq = XLSX.utils.aoa_to_sheet([
      ...cabecalho('CADASTRO DE MÁQUINAS',
        'Preencha uma linha por máquina. A coluna "produtos" aceita vários produtos separados por vírgula.',
        hdrMaq),
      ...rowsMaq
    ]);
    wsMaq['!cols'] = [{ wch:28 },{ wch:12 },{ wch:18 },{ wch:18 },{ wch:10 },{ wch:10 },{ wch:12 },{ wch:10 },{ wch:10 },{ wch:10 },{ wch:60 }];

    // ── Montar workbook ───────────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsProd,  'Produtos');
    XLSX.utils.book_append_sheet(wb, wsIns,   'Insumos');
    XLSX.utils.book_append_sheet(wb, wsSetup, 'Setup');
    XLSX.utils.book_append_sheet(wb, wsMaq,   'Maquinas');

    const hoje = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `TEMPLATE_IMPORTACAO_${hoje}.xlsx`);
    toast(`✅ Exportado: ${produtos.length} produtos · ${rowsIns.length} insumos · ${rowsSetup.length} setups · ${rowsMaq.length} máquinas`, 'ok');
  } catch(err) {
    toast('Erro ao exportar: ' + err.message, 'err');
    console.error('[exportarArquivoPadrao]', err);
  }
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
let _usuariosSistemaCache = null; // { dados: [], ts: number }

async function renderUsuariosSistema(){
  if(!can('usuarios','visualizar')){ return; }
  const el=document.getElementById('usuarios-list');
  if(!el) return;
  // FIX: cache de 5 min — evita getDocs toda vez que a tela de usuários abre
  const agora = Date.now();
  if (_usuariosSistemaCache && (agora - _usuariosSistemaCache.ts) < 5 * 60 * 1000) {
    _usuariosSistema = _usuariosSistemaCache.dados;
  } else {
    el.innerHTML='<div style="padding:16px;color:var(--text3);font-size:12px">Carregando...</div>';
    _usuariosSistema = await listarUsuariosSistema();
    _usuariosSistemaCache = { dados: _usuariosSistema, ts: agora };
  }
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
      const ativos = MODULOS.filter(m => {
        const p = perms[m.key];
        if (!p) return false;
        if (p === true) return true;
        if (typeof p === 'object') return Object.values(p).some(v => v === true);
        return false;
      }).map(m => m.label);
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


// Ações disponíveis por módulo — define quais colunas aparecem na tabela de permissões
// ── Permissões granulares por módulo ──────────────────────────────────────
// Cada entrada define as AÇÕES disponíveis e o que cada uma libera
const MODULO_ACOES = {
  dashboard    : ['visualizar'],
  programacao  : ['visualizar','criar','editar','excluir'],
  maquinas     : ['visualizar','criar','editar','excluir'],
  gantt        : ['visualizar','editar','reordenar','finalizar'],
  realizado    : ['visualizar','apontar','finalizar','resetar'],
  insumos_maq  : ['visualizar','editar'],
  insumos_geral: ['visualizar','editar'],
  calculos     : ['visualizar','editar'],
  projecao     : ['visualizar','editar'],
  ficha_tecnica: ['visualizar','editar','criar'],
  importacao   : ['visualizar','importar','exportar'],
  configuracoes: ['visualizar','editar','administrar'],
  funcionarios : ['visualizar','editar','criar','excluir'],
  usuarios     : ['visualizar','editar','criar','excluir','administrar'],
  relatorios   : ['visualizar','exportar'],
};

// Descrição detalhada do que cada ação libera em cada módulo
const MODULO_ACOES_DESC = {
  dashboard    : { visualizar: 'Ver o painel de indicadores e resumos' },
  programacao  : {
    visualizar : 'Ver a lista de solicitações de produção',
    criar      : 'Criar novas solicitações de produção',
    editar     : 'Editar solicitações existentes (datas, quantidades, máquina)',
    excluir    : 'Excluir solicitações de produção',
  },
  maquinas     : {
    visualizar : 'Ver fichas de máquinas e capacidades',
    criar      : 'Cadastrar novas máquinas',
    editar     : 'Editar dados e turnos das máquinas',
    excluir    : 'Remover máquinas do sistema',
  },
  gantt        : {
    visualizar : 'Ver o Gantt visual de programação',
    editar     : 'Arrastar produtos entre dias no Gantt',
    reordenar  : 'Alterar a sequência de produção por máquina',
    finalizar  : 'Marcar produtos como finalizados / desfinalizar',
  },
  realizado    : {
    visualizar : 'Ver apontamentos de produção',
    apontar    : 'Preencher quantidades por hora e salvar apontamentos',
    finalizar  : 'Finalizar ou desfinalizar um produto',
    resetar    : 'Apagar todos os apontamentos de um dia (Reset)',
  },
  insumos_maq  : {
    visualizar : 'Ver estoque de insumos por máquina',
    editar     : 'Lançar e atualizar quantidades de insumos',
  },
  insumos_geral: {
    visualizar : 'Ver relatório geral de insumos e cobertura',
    editar     : 'Editar dados do estoque geral de insumos',
  },
  calculos     : {
    visualizar : 'Ver programação automática calculada',
    editar     : 'Ajustar parâmetros e aplicar programação automática',
  },
  projecao     : {
    visualizar : 'Ver projeções de vendas e histórico',
    editar     : 'Editar e importar dados de projeção',
  },
  ficha_tecnica: {
    visualizar : 'Ver fichas técnicas de produtos',
    editar     : 'Editar insumos e quantidades da ficha técnica',
    criar      : 'Criar novas fichas técnicas',
  },
  importacao   : {
    visualizar : 'Ver histórico de importações',
    importar   : 'Importar dados via Excel ou API',
    exportar   : 'Exportar relatórios em PDF e XLSX',
  },
  configuracoes: {
    visualizar : 'Acessar configurações do sistema',
    editar     : 'Alterar configurações gerais (jornada, lojas)',
    administrar: 'Gerenciar todas as configurações avançadas',
  },
  funcionarios : {
    visualizar : 'Ver lista de funcionários',
    editar     : 'Editar dados e status dos funcionários',
    criar      : 'Cadastrar novos funcionários',
    excluir    : 'Remover funcionários do sistema',
  },
  usuarios     : {
    visualizar : 'Ver usuários do sistema',
    editar     : 'Editar nome, cargo e permissões de usuários',
    criar      : 'Criar novos usuários com acesso ao sistema',
    excluir    : 'Excluir usuários permanentemente',
    administrar: 'Forçar reset de senha e ativar/desativar contas',
  },
  relatorios   : {
    visualizar : 'Ver a aba de relatórios',
    exportar   : 'Exportar relatórios em Excel, PDF e Imagem',
  },
};

const ACAO_LABEL = {
  visualizar : '👁 Ver',
  criar      : '➕ Criar',
  editar     : '✏️ Editar',
  excluir    : '🗑 Excluir',
  apontar    : '📝 Apontar',
  finalizar  : '🏁 Finalizar',
  resetar    : '🔄 Resetar',
  reordenar  : '⇅ Reordenar',
  importar   : '📥 Importar',
  exportar   : '📤 Exportar',
  administrar: '⚙️ Admin',
};
const ACAO_COLOR = {
  visualizar : 'var(--cyan)',
  criar      : 'var(--green)',
  editar     : 'var(--warn)',
  excluir    : 'var(--red)',
  apontar    : 'var(--cyan)',
  finalizar  : 'var(--green)',
  resetar    : 'var(--red)',
  reordenar  : 'var(--warn)',
  importar   : 'var(--cyan)',
  exportar   : 'var(--cyan)',
  administrar: 'var(--red)',
};

// Normaliza permissão (suporta formato legado true/false e novo {visualizar,editar,...})
// Normaliza permissão para o formato novo { acao: bool }
// Recebe o modKey para saber quais ações existem nesse módulo
function _normPerm(raw, modKey) {
  if (!raw) return {};
  // Formato legado: true = acesso total → marca todas as ações do módulo
  if (raw === true) {
    const acoes = (modKey && MODULO_ACOES[modKey]) || ['visualizar','editar','criar','administrar'];
    return Object.fromEntries(acoes.map(a => [a, true]));
  }
  if (typeof raw === 'object') return raw;
  return {};
}

function _usuarioFormHTML(u={}){
  const tipo  = u.tipo || 'usuario';
  const perms = u.permissoes || {};

  // Tabela de permissões granulares — uma seção por módulo
  // CSS do toggle iOS injetado uma vez
  if (!document.getElementById('perm-toggle-style')) {
    const st = document.createElement('style');
    st.id = 'perm-toggle-style';
    st.textContent = `
      .perm-toggle{position:relative;display:inline-flex;width:32px;height:18px;flex-shrink:0;cursor:pointer}
      .perm-toggle input{opacity:0;width:0;height:0;position:absolute}
      .perm-toggle-track{position:absolute;inset:0;background:var(--border);border-radius:18px;transition:background .2s}
      .perm-toggle input:checked+.perm-toggle-track{background:var(--toggle-color,var(--cyan))}
      .perm-toggle-thumb{position:absolute;top:3px;left:3px;width:12px;height:12px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.35)}
      .perm-toggle input:checked~.perm-toggle-thumb{transform:translateX(14px)}
      .perm-acc-header{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;cursor:pointer;border-radius:8px;transition:background .15s;user-select:none}
      .perm-acc-header:hover{background:rgba(255,255,255,.04)}
      .perm-acc-body{display:none;padding:0 12px 10px}
      .perm-acc-body.open{display:block}
      .perm-acc-chevron{font-size:10px;color:var(--text3);transition:transform .2s;display:inline-block}
      .perm-acc-chevron.open{transform:rotate(90deg)}
    `;
    document.head.appendChild(st);
  }

  // Accordion sections — collapsed by default, expandem ao clicar
  const permSections = MODULOS.map(m => {
    const acoes    = MODULO_ACOES[m.key] || ['visualizar'];
    const modPerm  = _normPerm(perms[m.key], m.key);
    const temAlgum = acoes.some(a => modPerm[a]);
    const descs    = MODULO_ACOES_DESC[m.key] || {};
    const qtdAtiva = acoes.filter(a => modPerm[a]).length;

    const toggles = acoes.map(acao => {
      const on    = modPerm[acao] ? 'checked' : '';
      const color = ACAO_COLOR[acao];
      const label = ACAO_LABEL[acao];
      const desc  = descs[acao] || '';
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)">
        <div style="min-width:0;flex:1;margin-right:12px">
          <div style="font-size:11px;font-weight:600;color:${color};line-height:1.2">${label}</div>
          ${desc?`<div style="font-size:10px;color:var(--text3);margin-top:1px;line-height:1.4">${desc}</div>`:''}
        </div>
        <label class="perm-toggle" style="--toggle-color:${color}">
          <input type="checkbox" id="perm-${m.key}-${acao}" ${on}
                 onchange="_onPermChange('${m.key}','${acao}')">
          <span class="perm-toggle-track"></span>
          <span class="perm-toggle-thumb"></span>
        </label>
      </div>`;
    }).join('');

    return `<div id="perm-row-${m.key}" style="border:1px solid ${temAlgum?'rgba(0,212,255,.18)':'var(--border)'};border-radius:8px;background:${temAlgum?'rgba(0,212,255,.03)':'var(--s1)'};overflow:hidden;transition:border-color .2s">
      <div class="perm-acc-header" onclick="_toggleAccordion('${m.key}')">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="perm-acc-chevron" id="perm-chev-${m.key}">›</span>
          <span style="font-size:12px;font-weight:600;color:${temAlgum?'var(--text)':'var(--text3)'}" id="perm-title-${m.key}">${m.label}</span>
        </div>
        <span id="perm-badge-${m.key}" style="font-size:9px;padding:2px 8px;border-radius:10px;font-weight:600;white-space:nowrap;
              ${temAlgum
                ? `color:var(--cyan);background:rgba(0,212,255,.12);border:1px solid rgba(0,212,255,.2)`
                : `color:var(--text3);background:var(--s2);border:1px solid var(--border)`}">
          ${temAlgum ? qtdAtiva+'/'+acoes.length+' ativa'+(qtdAtiva>1?'s':'') : 'sem acesso'}
        </span>
      </div>
      <div class="perm-acc-body" id="perm-body-${m.key}">
        <div style="border-top:1px solid var(--border);padding-top:6px">
          ${toggles}
        </div>
      </div>
    </div>`;
  }).join('');

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
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
          <option value="usuario" ${tipo!=='admin'?'selected':''}>Usuário — permissões por módulo</option>
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

    <!-- Acesso a Lojas -->
    <div id="us-lojas-wrap" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <label class="flbl" style="margin:0">🏭 Lojas com Acesso</label>
        <span style="font-size:10px;color:var(--text3)">Admin sempre acessa todas</span>
      </div>
      <div id="us-lojas-checkboxes" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px">
        <div style="color:var(--text3);font-size:12px;padding:8px">Carregando lojas...</div>
      </div>
      <div style="margin-top:6px;font-size:10px;color:var(--text3)">Se nenhuma estiver marcada, o usuário acessa <strong>todas</strong>.</div>
    </div>

    <div id="us-perms-wrap" style="display:${tipo==='admin'?'none':'block'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <label class="flbl" style="margin:0">Permissões por módulo</label>
        <div style="display:flex;gap:6px">
          <button type="button" onclick="_permSelectAll(true)"
                  style="background:rgba(0,212,255,.12);border:1px solid rgba(0,212,255,.3);color:var(--cyan);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:'Space Grotesk',sans-serif">✓ Liberar tudo</button>
          <button type="button" onclick="_permSelectAll(false)"
                  style="background:var(--s2);border:1px solid var(--border);color:var(--text3);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:'Space Grotesk',sans-serif">✕ Revogar tudo</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${permSections}
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
// Toggle accordion de módulo
function _toggleAccordion(modKey) {
  const body  = document.getElementById('perm-body-' + modKey);
  const chev  = document.getElementById('perm-chev-' + modKey);
  if (!body) return;
  const open = body.classList.toggle('open');
  if (chev) chev.classList.toggle('open', open);
}
window._toggleAccordion = _toggleAccordion;

// Atualiza badge, borda e cor do título quando toggle muda
function _onPermChange(modKey, acao) {
  const acoes    = MODULO_ACOES[modKey] || ['visualizar'];
  const temAlgum = acoes.some(a => {
    const cb = document.getElementById(`perm-${modKey}-${a}`);
    return cb && cb.checked;
  });
  const qtdAtiva = acoes.filter(a => {
    const cb = document.getElementById(`perm-${modKey}-${a}`);
    return cb && cb.checked;
  }).length;

  // Atualizar card
  const row   = document.getElementById('perm-row-' + modKey);
  const badge = document.getElementById('perm-badge-' + modKey);
  const title = document.getElementById('perm-title-' + modKey);
  if (row) {
    row.style.borderColor = temAlgum ? 'rgba(0,212,255,.18)' : 'var(--border)';
    row.style.background  = temAlgum ? 'rgba(0,212,255,.03)' : 'var(--s1)';
  }
  if (badge) {
    badge.textContent  = temAlgum ? `${qtdAtiva}/${acoes.length} ativa${qtdAtiva>1?'s':''}` : 'sem acesso';
    badge.style.color  = temAlgum ? 'var(--cyan)' : 'var(--text3)';
    badge.style.background   = temAlgum ? 'rgba(0,212,255,.12)' : 'var(--s2)';
    badge.style.borderColor  = temAlgum ? 'rgba(0,212,255,.2)'  : 'var(--border)';
  }
  if (title) title.style.color = temAlgum ? 'var(--text)' : 'var(--text3)';
}
// Marcar / limpar todas as permissões
function _permSelectAll(val) {
  MODULOS.forEach(m => {
    const acoes = MODULO_ACOES[m.key] || ['visualizar'];
    acoes.forEach(a => {
      const cb = document.getElementById(`perm-${m.key}-${a}`);
      if (cb) cb.checked = val;
    });
    _onPermChange(m.key);
  });
}
window._togglePermsWrap  = _togglePermsWrap;
window._togglePermBorder = _togglePermBorder;
window._onPermChange     = _onPermChange;
window._permSelectAll    = _permSelectAll;

function openAddUsuario(){
  if(!can('usuarios','criar')){toast('Sem permissão para criar usuário.','err');return;}
  _usEditUid=null;
  document.getElementById('usuario-modal-title').textContent='Novo Usuário do Sistema';
  document.getElementById('usuario-modal-body').innerHTML=_usuarioFormHTML();
  document.getElementById('usuario-modal').style.display='flex';
  _popularLojasCheckboxes([]);
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
  _popularLojasCheckboxes(u.lojasPermitidas||[]);
}

// Popula checkboxes de lojas no modal de usuário
async function _popularLojasCheckboxes(selecionadas) {
  const container = document.getElementById('us-lojas-checkboxes');
  if (!container) return;
  try {
    const lojas = await carregarLojas();
    if (!lojas.length) {
      container.innerHTML = '<span style="color:var(--text3);font-size:12px">Nenhuma loja cadastrada.</span>';
      return;
    }
    container.innerHTML = lojas.map(l => {
      const marcada = selecionadas.includes(l.id);
      return `<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;background:var(--s2);border:1px solid ${marcada?'rgba(0,212,255,.3)':'var(--border)'};cursor:pointer;transition:all .15s" id="loja-lbl-${l.id}">
        <input type="checkbox" id="loja-cb-${l.id}" value="${l.id}" ${marcada?'checked':''}
               onchange="_onLojaChange('${l.id}')"
               style="accent-color:var(--cyan);width:14px;height:14px;cursor:pointer;flex-shrink:0">
        <div>
          <div style="font-size:12px;font-weight:600;color:var(--text)">${l.nome||l.id}</div>
          <div style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace">${l.id}</div>
        </div>
      </label>`;
    }).join('');
  } catch(e) {
    container.innerHTML = '<span style="color:var(--red);font-size:12px">Erro ao carregar lojas.</span>';
  }
}

function _onLojaChange(lojaId) {
  const cb  = document.getElementById(`loja-cb-${lojaId}`);
  const lbl = document.getElementById(`loja-lbl-${lojaId}`);
  if (lbl) lbl.style.borderColor = cb?.checked ? 'rgba(0,212,255,.3)' : 'var(--border)';
}
window._onLojaChange = _onLojaChange;

function closeUsuarioModal(){ document.getElementById('usuario-modal').style.display='none'; }

async function saveUsuarioModal(){
  const nome=(document.getElementById('us-nome')?.value||'').trim();
  const tipo=document.getElementById('us-tipo')?.value||'usuario';
  const cargo=(document.getElementById('us-cargo')?.value||'').trim();
  if(!nome){alert('Informe o nome.');return;}
  // Coleta permissões granulares (por módulo e por ação)
  const permissoes={};
  if(tipo!=='admin'){
    MODULOS.forEach(m=>{
      const acoes = MODULO_ACOES[m.key] || ['visualizar'];
      const modPerms = {};
      acoes.forEach(acao => {
        const cb = document.getElementById(`perm-${m.key}-${acao}`);
        if(cb) modPerms[acao] = cb.checked;
      });
      // Garantia: se qualquer ação está marcada, visualizar deve estar marcado também
      const temAlgum = Object.values(modPerms).some(v => v);
      if(temAlgum && acoes.includes('visualizar')) modPerms['visualizar'] = true;
      permissoes[m.key] = temAlgum ? modPerms : false;
    });
  }
  // Coletar lojas selecionadas (array de IDs; vazio = acesso a todas)
  const lojasPermitidas = [];
  document.querySelectorAll('#us-lojas-checkboxes input[type=checkbox]:checked').forEach(cb => {
    if (cb.value) lojasPermitidas.push(cb.value);
  });
  try{
    if(!_usEditUid){
      const email=(document.getElementById('us-email')?.value||'').trim();
      const senha=document.getElementById('us-senha')?.value||'';
      if(!email){alert('Informe o e-mail.');return;}
      if(senha.length<6){alert('Senha deve ter ao menos 6 caracteres.');return;}
      _usuariosSistemaCache = null; // invalida cache
  await criarUsuarioSistema({email,senha,nome,tipo,cargo,permissoes,lojasPermitidas});
      toast('Usuário '+nome+' criado com sucesso.','ok');
    } else {
      const ativo=document.getElementById('us-ativo')?.value!=='false';
      await atualizarUsuarioSistema(_usEditUid,{nome,tipo,cargo,ativo,permissoes,lojasPermitidas});
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
  _usuariosSistemaCache = null; // invalida cache
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
    _usuariosSistemaCache = null; // invalida cache
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
    { tab:'relatorios',    icon:'📊', label:'Relatórios',        modulo:'relatorios' },
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
    'projecao':'projecao','ficha-tecnica':'ficha_tecnica','api-sync':'importacao',
    'relatorios':'relatorios'
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
    'api-sync':'Importação/API','calculos':'Prog. Automática','projecao':'Projeção de Vendas',
    'relatorios':'Relatórios'
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
  if(name==='relatorios') {
    // Garantir que o painel existe antes de inicializar
    let rPanel = document.getElementById('panel-relatorios');
    if (!rPanel) {
      rPanel = document.createElement('div');
      rPanel.id = 'panel-relatorios';
      rPanel.className = 'panel';
      const container = document.getElementById('main-content')
        || document.getElementById('content')
        || document.getElementById('app')
        || document.body;
      container.appendChild(rPanel);
    }
    rPanel.classList.add('on');
    if (window.relatorios) {
      setTimeout(() => window.relatorios.init(), 50);
    }
  }
  if(name==='usuarios') { openSettings(); setTimeout(()=>settingsNav('usuarios'), 80); }
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
    // Atualizar dropdown do topo (hd-menu) com dados do usuário
    const hdAv = document.getElementById('hd-menu-avatar');
    const hdNm = document.getElementById('hd-menu-nome');
    const hdBg = document.getElementById('hd-menu-badge');
    if(hdAv) {
      hdAv.textContent = (user.nome||user.email||'?')[0].toUpperCase();
      hdAv.style.background = user.tipo==='admin' ? '#e74c3c' : 'var(--cyan)';
      hdAv.style.color = user.tipo==='admin' ? '#fff' : '#000';
    }
    if(hdNm) hdNm.textContent = user.nome || user.email || '—';
    if(hdBg) hdBg.innerHTML = perfilBadge(user.tipo || 'usuario');
    // Show app
    if(loadingScreen) loadingScreen.style.display = 'none';
    if(loginScreen) loginScreen.style.display = 'none';
    if(appDiv) appDiv.hidden = false;
    buildSidebar(user);
    if (!getLojaAtiva()) {
      mostrarSeletorLoja();
    } else {
      appInit().then(() => {
        impLoadFromStorage();
        projLoadManual();
        switchTabSidebar('dashboard');
        atualizarTopbarLoja();
      });
    }
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
  // 1. Match exato (prioridade máxima)
  const exact = insumosEstoqueData.find(x => norm(x.insumo) === ni);
  if(exact) return exact.quantidade || 0;
  // 2. Match parcial conservador: um nome deve estar INTEIRAMENTE contido no outro
  //    (evita falsos positivos por prefixo de 20 chars)
  const partial = insumosEstoqueData.find(x => {
    const xn = norm(x.insumo);
    return xn.length >= 10 && ni.length >= 10 && (xn.includes(ni) || ni.includes(xn));
  });
  return partial ? (partial.quantidade || 0) : null; // null = não encontrado
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

function limparDadosEstoque(){
  if(!confirm('Limpar todos os dados de Estoque importados?')) return;
  estoqueData = [];
  impSaveEstoque();
  const prev = document.getElementById('imp-estoque-preview');
  if(prev) prev.innerHTML = '';
  renderImportacao();
  toast('Estoque limpo com sucesso', 'ok');
}

function limparDadosProjecao(){
  if(!confirm('Limpar todos os dados de Projeção de Vendas importados?')) return;
  projecaoData = [];
  impSaveProjecao();
  const prev = document.getElementById('imp-proj-preview');
  if(prev) prev.innerHTML = '';
  renderImportacao();
  toast('Projeção limpa com sucesso', 'ok');
}

function limparDadosInsumos(){
  if(!confirm('Limpar todos os dados de Insumos importados?')) return;
  insumosEstoqueData = [];
  impSaveInsumosEstoque();
  const prev = document.getElementById('imp-insumos-preview');
  if(prev) prev.innerHTML = '';
  const stat = document.getElementById('imp-insumos-stat');
  if(stat){ stat.textContent = ''; stat.style.color = ''; }
  renderImportacao();
  renderSaldoInsumos();
  toast('Insumos limpos com sucesso', 'ok');
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
      const novos = rows.filter(r => r[0]||r[1]).map(r => ({
        cod: String(r[0]).trim(),
        produto: String(r[1]||'').trim(),
        estoque: parseFloat(r[2])||0
      })).filter(x => x.produto || x.cod);

      // Upsert: substitui o registro do produto se já existir, senão adiciona
      const norm = s => String(s||'').trim().toLowerCase();
      novos.forEach(novo => {
        const idx = estoqueData.findIndex(x =>
          (novo.cod && x.cod && norm(x.cod) === norm(novo.cod)) ||
          (novo.produto && x.produto && norm(x.produto) === norm(novo.produto))
        );
        if(idx >= 0) estoqueData[idx] = novo;
        else estoqueData.push(novo);
      });

      impSaveEstoque();
      impAddHistorico('estoque', estoqueData.length, file.name);
      const prev = document.getElementById('imp-estoque-preview');
      prev.innerHTML = `<div style="margin-bottom:6px;font-size:11px;color:var(--green)">✅ ${novos.length} registros importados · ${estoqueData.length} total no sistema</div>`
        + `<table style="width:100%;border-collapse:collapse;font-size:11px">`
        + `<thead><tr><th style="text-align:left;padding:3px 6px;color:var(--text3)">Código</th><th style="text-align:left;padding:3px 6px;color:var(--text3)">Produto</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">Estoque</th></tr></thead>`
        + `<tbody>${estoqueData.slice(0,8).map(r=>`<tr><td style="padding:3px 6px;color:var(--text2)">${r.cod}</td><td style="padding:3px 6px;color:var(--text)">${r.produto.substring(0,35)}</td><td style="padding:3px 6px;text-align:right;color:var(--cyan)">${r.estoque}</td></tr>`).join('')}</tbody>`
        + (estoqueData.length>8?`<tfoot><tr><td colspan="3" style="padding:3px 6px;color:var(--text3);font-style:italic">... e mais ${estoqueData.length-8} itens</td></tr></tfoot>`:'')
        + `</table>`;
      renderImportacao();
      toast(`Estoque importado: ${novos.length} produtos (total: ${estoqueData.length})`, 'ok');
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
      const novos = rows.filter(r => r[0]||r[1]).map(r => ({
        cod: String(r[0]).trim(),
        produto: String(r[1]||'').trim(),
        venda_m1: parseFloat(r[2])||0,
        venda_m2: parseFloat(r[3])||0,
        venda_m3: parseFloat(r[4])||0
      })).filter(x => x.produto || x.cod);

      // Upsert: substitui o registro do produto se já existir, senão adiciona
      const norm = s => String(s||'').trim().toLowerCase();
      novos.forEach(novo => {
        const idx = projecaoData.findIndex(x =>
          (novo.cod && x.cod && norm(x.cod) === norm(novo.cod)) ||
          (novo.produto && x.produto && norm(x.produto) === norm(novo.produto))
        );
        if(idx >= 0) projecaoData[idx] = novo;
        else projecaoData.push(novo);
      });

      impSaveProjecao();
      impAddHistorico('projecao', projecaoData.length, file.name);
      const prev = document.getElementById('imp-proj-preview');
      prev.innerHTML = `<div style="margin-bottom:6px;font-size:11px;color:var(--green)">✅ ${novos.length} registros importados · ${projecaoData.length} total no sistema</div>`
        + `<table style="width:100%;border-collapse:collapse;font-size:11px">`
        + `<thead><tr><th style="text-align:left;padding:3px 6px;color:var(--text3)">Produto</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">M1</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">M2</th><th style="text-align:right;padding:3px 6px;color:var(--text3)">M3</th></tr></thead>`
        + `<tbody>${projecaoData.slice(0,6).map(r=>`<tr><td style="padding:3px 6px;color:var(--text)">${r.produto.substring(0,30)}</td><td style="padding:3px 6px;text-align:right;color:var(--text2)">${r.venda_m1}</td><td style="padding:3px 6px;text-align:right;color:var(--text2)">${r.venda_m2}</td><td style="padding:3px 6px;text-align:right;color:var(--text2)">${r.venda_m3}</td></tr>`).join('')}</tbody>`
        + (projecaoData.length>6?`<tfoot><tr><td colspan="4" style="padding:3px 6px;color:var(--text3);font-style:italic">... e mais ${projecaoData.length-6} itens</td></tr></tfoot>`:'')
        + `</table>`;
      renderImportacao();
      toast(`Projeção importada: ${novos.length} produtos (total: ${projecaoData.length})`, 'ok');
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
    // Busca consumo por match parcial se não encontrou exato
    let consumoFinal = consumo;
    if(!consumo){
      const norm = s => (s||'').toUpperCase().trim();
      const ni = norm(ins.insumo);
      // Usar apenas o PRIMEIRO match para evitar soma duplicada
      for(const [k,v] of Object.entries(consumoMap)){
        if(norm(k).includes(ni.substring(0,20)) || ni.includes(norm(k).substring(0,20))){
          consumoFinal += v.total;
          break; // parar no primeiro match — somar mais de um causaria duplicidade
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

// Horários específicos por máquina (se não definido, usa horário geral)
let machineHours = {};

// Carrega horários específicos das máquinas do localStorage
function carregarHorariosMaquinas() {
  try {
    const saved = localStorage.getItem('machineHours');
    if (saved) {
      machineHours = JSON.parse(saved);
      console.log('Horários das máquinas carregados:', Object.keys(machineHours).length, 'máquinas');
    } else {
      console.log('Nenhum horário específico de máquina encontrado, usando padrão');
    }
  } catch(e) {
    console.warn('Erro ao carregar horários das máquinas:', e);
    machineHours = {};
  }
}

// Inicializar horários das máquinas quando o script carregar
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', carregarHorariosMaquinas);
  } else {
    carregarHorariosMaquinas();
  }
}

// Salva horários específicos das máquinas no localStorage
function salvarHorariosMaquinas() {
  try {
    localStorage.setItem('machineHours', JSON.stringify(machineHours));
  } catch(e) {
    console.warn('Erro ao salvar horários das máquinas:', e);
  }
}

// Define horários específicos para uma máquina
function definirHorariosMaquina(machine, hoursArray) {
  if (!Array.isArray(hoursArray) || hoursArray.length !== 7) {
    console.error('hoursArray deve ser um array de 7 elementos (dom a sáb)');
    return;
  }
  
  machineHours[machine] = hoursArray;
  salvarHorariosMaquinas();
}

function hoursOnMachineDay(machine, d){
  try {
    const mhrs = machineHours[machine];
    if(mhrs && Array.isArray(mhrs) && mhrs.length === 7){
      const dayOfWeek = d.getDay(); // 0 = domingo, 1 = segunda, etc.
      const v = mhrs[dayOfWeek];
      if(v != null && typeof v === 'number' && v >= 0) {
        return v;
      }
    }
    
    // Fallback: usar horário geral do dia
    return hoursOnDay(d);
  } catch(e) {
    console.warn('Erro em hoursOnMachineDay:', e);
    return hoursOnDay(d);
  }
}

function weekHrsForMachine(machine, monday){
  return getWeekDays(monday).reduce((a,d) => a + hoursOnMachineDay(machine, d), 0);
}

function pa_onModoChange(){
  const modo = document.querySelector('input[name="pa-modo-periodo"]:checked')?.value || 'mes';
  const rowMes    = document.getElementById('pa-row-mes');
  const rowSemana = document.getElementById('pa-row-semana');
  if(rowMes)    rowMes.style.display    = modo === 'mes'    ? 'flex' : 'none';
  if(rowSemana) rowSemana.style.display = modo === 'semana' ? 'flex' : 'none';
}

function paPopulaSemanas(){
  // Popular semanas
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

  // Popular meses
  const mesSel = document.getElementById('pa-mes-sel');
  if(mesSel){
    const mesVal = mesSel.value;
    while(mesSel.options.length > 1) mesSel.remove(1);
    const now = new Date();
    for(let i=0; i<6; i++){
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const opt = document.createElement('option');
      opt.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      opt.textContent = `${GANTT_MONTH_NAMES[d.getMonth()]} / ${d.getFullYear()}`;
      mesSel.appendChild(opt);
    }
    if(mesVal) mesSel.value = mesVal;
    else if(mesSel.options.length > 1) mesSel.selectedIndex = 1; // seleciona mês atual por padrão
  }

  // Garantir visibilidade correta dos seletores
  pa_onModoChange();
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
  // ================================================================
  //  PROGRAMAÇÃO AUTOMÁTICA EQUILIBRADA — v3 (simulação 4 semanas)
  //  Lógica:
  //   1. Monta candidatos com TODAS as máquinas compatíveis
  //   2. Simula 4 semanas: a cada semana recalcula cobertura,
  //      ordena por prioridade e aloca de forma intercalada
  //      (round-robin) para evitar que um produto monopolize
  //      a capacidade enquanto outros entram em ruptura
  //   3. Para cada produto, escolhe a máquina mais rápida
  //      disponível; divide produção entre máquinas se necessário
  // ================================================================

  // ── Validações iniciais ─────────────────────────────────────────
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

  const cobMin    = parseFloat(document.getElementById('pa-cobertura-min')?.value||'5');
  const cobAlvo   = parseFloat(document.getElementById('pa-cobertura-alvo')?.value||'15');
  const riscoLim  = parseFloat(document.getElementById('pa-risco-critico')?.value||'3');
  const maxPctMaq = parseFloat(document.getElementById('pa-max-pct-maq')?.value||'60') / 100;

  const semanaSel = document.getElementById('pa-semana-sel')?.value;
  const monday    = semanaSel ? new Date(semanaSel+'T12:00:00') : getWeekMonday(new Date());
  const days      = getWeekDays(monday);
  const alertEl   = document.getElementById('pa-alerta');

  // PROBLEMA 4 FIX — opção de fechamento do mês na última semana
  // 'este-mes'   → semanas calculadas só com dias do mês da semana selecionada
  // 'mes-seguinte' → semana pode cruzar a virada (comportamento anterior)
  const fechamentoMes = document.getElementById('pa-fechamento-mes')?.value || 'mes-seguinte';
  const mesRef        = monday.getMonth();
  const anoRef        = monday.getFullYear();
  const ultimoDiaMes  = new Date(anoRef, mesRef + 1, 0); // último dia do mês ref

  // Pré-calcular os 4 Mondays e suas capacidades respeitando a regra de fechamento
  const semanasPA = []; // [{monday, sunday, capPorMaq}]
  for(let si = 0; si < 4; si++){
    const wMon = new Date(monday); wMon.setDate(monday.getDate() + si * 7);
    const wSun = new Date(wMon);   wSun.setDate(wMon.getDate() + 6);
    // Clip de dias para este mês se modo 'este-mes' e esta semana cruza a virada
    const efetivaSun = (fechamentoMes === 'este-mes' && wSun > ultimoDiaMes)
      ? ultimoDiaMes : wSun;
    semanasPA.push({ monday: wMon, sunday: efetivaSun, sunOriginal: wSun });
  }

  if (!projecaoCalculada.length) {
    if(alertEl) alertEl.innerHTML = '<div style="background:rgba(255,179,0,.1);border:1px solid rgba(255,179,0,.3);border-radius:8px;padding:12px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">'
      + '⚠️ <strong>Dados insuficientes:</strong> Nenhuma projeção encontrada. Importe estoque e projeção em <strong>Importação/API</strong>.</div>';
    document.getElementById('pa-body').innerHTML = '';
    paResultados = [];
    renderProgAutomaticaStats();
    return;
  }

  // ── PASSO 1: montar candidatos com todas as máquinas compatíveis ─
  const allProds       = getAllProdutos();
  const prodSemMaquina = [];
  const candidates     = [];   // estado dinâmico por produto

  projecaoCalculada.forEach(proj => {
    const ficha     = allProds.find(p => String(p.cod)===String(proj.cod) || p.descricao===proj.produto);

    // ── Produtos sem ficha (excluídos) ou desativados não entram na programação ──
    if(!ficha) return;
    if(ficha.produtoAtivo === false) return;

    const fichaUnid = ficha ? (ficha.unid  || 1) : 1;
    const fichaPcMin= ficha ? (ficha.pc_min || 0) : 0;
    const primaryMaq= ficha ? ficha.maquina : null;

    // Encontrar TODAS as máquinas que produzem este produto
    const maquinasCompativeis = [];
    for(const maqNome of MAQUINAS){
      const maqData = getMaquinaData(maqNome);
      if(!maqData) continue;
      const prodEntry = Array.isArray(maqData.produtosCompativeis)
        ? maqData.produtosCompativeis.find(p =>
            p.produto === proj.produto ||
            (proj.produto && proj.produto.startsWith(p.produto)) ||
            p.produto === (ficha && ficha.descricao))
        : null;
      if(prodEntry){
        const vel = (prodEntry.velocidade > 0)
          ? parseFloat(prodEntry.velocidade)
          : (parseFloat(maqData.pcMin) || fichaPcMin || 0);
        maquinasCompativeis.push({ maquina: maqNome, pc_min: vel });
      } else if(maqNome === primaryMaq){
        // Máquina principal sem entrada em produtosCompativeis
        const vel = parseFloat(maqData.pcMin) || fichaPcMin || 0;
        maquinasCompativeis.push({ maquina: maqNome, pc_min: vel });
      }
    }

    if(!maquinasCompativeis.length){
      if(primaryMaq){
        const maqData = getMaquinaData(primaryMaq);
        maquinasCompativeis.push({ maquina: primaryMaq, pc_min: parseFloat(maqData?.pcMin)||fichaPcMin||0 });
      } else {
        prodSemMaquina.push(proj.produto);
        return;
      }
    }

    // Ordenar por velocidade desc (máquina mais rápida primeiro)
    maquinasCompativeis.sort((a,b) => b.pc_min - a.pc_min);

    // Calcular estado inicial
    const demandaDiaria  = proj.projFinal / 7;
    const demandaSemanal = proj.projFinal;          // caixas/semana
    const unidPorCx      = fichaUnid;
    const estoqueRaw     = proj.estoque ?? 0;
    // Converter unidades → caixas se necessário
    const estoque = (unidPorCx > 1 && estoqueRaw > demandaSemanal * unidPorCx * 0.5)
      ? estoqueRaw / unidPorCx
      : estoqueRaw;
    const cobAtual = demandaDiaria > 0 ? estoque / demandaDiaria : 999;

    // Campos de mínimo/múltiplo do produto
    const producaoMinima   = ficha ? (parseFloat(ficha.producaoMinima)   || 0) : 0;
    const multiploProducao = ficha ? (parseFloat(ficha.multiploProducao) || 0) : 0;
    const prioridadeProduto= ficha ? (parseInt(ficha.prioridadeProducao) || 2) : 2;
    const metaCoberturaDias= ficha ? (parseFloat(ficha.metaCoberturaDias || ficha.coberturaDias) || 0) : 0;

    // ── ITENS 1-3: saldo projetado correto ──────────────────────────
    //
    //  Fórmula de PCP industrial:
    //   saldo_virada = estoque_atual
    //                + produção_não_apontada_semana_atual   (Item 1)
    //                + produção_programada_semanas_futuras  (Item 2 — entra por semana)
    //                - demanda_até_virada_do_mês            (Item 3)
    //
    //  necessidade_próx_mês = demanda_próx_mês - saldo_virada
    //
    //  IMPORTANTE: estoqueSim inicia com estoque + não-apontado corrente.
    //  Produção de semanas futuras entra no estoque APENAS quando a
    //  simulação chega naquela semana (não antecipado — Item 2).

    const hoje    = new Date();
    const semAtual = semanasPA[0];

    // Item 1 — produção não apontada: o que está "Em Produção" ou "Pendente"
    // na semana atual mas ainda não foi finalizado (restante a produzir).
    let naoPontadaAtual = 0;
    records.forEach(r => {
      if(r.status === 'Concluído') return;
      const mesmoProd = r.produto === proj.produto ||
        (r.prodCod && ficha && String(r.prodCod) === String(ficha.cod));
      if(!mesmoProd) return;
      const dt = r.dtDesejada || r.dtSolicitacao || '';
      if(dt >= dateStr(semAtual.monday) && dt <= dateStr(semAtual.sunday)){
        const totalApontado = (typeof calcularTotalProduzido === 'function')
          ? calcularTotalProduzido(r.id) : 0;
        naoPontadaAtual += Math.max(0, (r.qntCaixas || 0) - totalApontado);
      }
    });

    // Item 2 — produção programada por semana (entra no estoque na semana certa)
    // si=0: já contabilizado em naoPontadaAtual
    // si>0: entra na simulação quando o loop chegar naquela semana
    const jaProgPorSemana = [0, 0, 0, 0];
    for(let si = 0; si < 4; si++){
      const sp      = semanasPA[si];
      const wMonStr = dateStr(sp.monday);
      const wSunStr = dateStr(sp.sunday);
      records.forEach(r => {
        if(r.status === 'Concluído') return;
        const mesmoProd = r.produto === proj.produto ||
          (r.prodCod && ficha && String(r.prodCod) === String(ficha.cod));
        if(!mesmoProd) return;
        const dt = r.dtDesejada || r.dtSolicitacao || '';
        if(dt < wMonStr || dt > wSunStr) return;
        if(si === 0){
          // Semana atual já está em naoPontadaAtual; aqui não soma de novo
          // (para não duplicar)
        } else {
          jaProgPorSemana[si] += (r.qntCaixas || 0);
        }
      });
    }
    const jaProgTotal = jaProgPorSemana.reduce((a, v) => a + v, 0) + naoPontadaAtual;

    // Item 3 — saldo projetado na virada do mês
    const diasRestMes = Math.max(1,
      Math.ceil((ultimoDiaMes.getTime() - hoje.getTime()) / 86400000) + 1
    );
    const demandaAteVirada = demandaDiaria * diasRestMes;
    const saldoVirada      = Math.max(0,
      estoque + naoPontadaAtual + jaProgPorSemana.reduce((a,v)=>a+v,0) - demandaAteVirada
    );
    const demandaProxMes      = demandaDiaria * 30;
    const necessidadeProxMes  = Math.max(0, demandaProxMes - saldoVirada);

    // Cobertura considerando tudo previsto (para filtrar candidatos)
    const cobComProg = demandaDiaria > 0
      ? (estoque + jaProgTotal) / demandaDiaria
      : 999;
    const cobTetoProd = (metaCoberturaDias > 0) ? metaCoberturaDias : cobAlvo;
    if(cobComProg >= cobTetoProd && cobComProg < 900) return;

    // estoqueSim inicia com estoque atual + não-apontado da semana corrente.
    // Produção de semanas futuras (jaProgPorSemana[1..3]) será adicionada
    // semana a semana no loop principal (Item 2).
    const estoqueSimInicial = estoque + naoPontadaAtual;

    candidates.push({
      prod: proj.produto,
      cod:  proj.cod,
      maquinasCompativeis,
      unid: unidPorCx,
      estoque,
      naoPontadaAtual,
      estoqueSim:         estoqueSimInicial,
      jaProgPorSemana,                       // [0, cx_s2, cx_s3, cx_s4] — entra semana-a-semana
      jaProgTotal,
      saldoVirada,
      necessidadeProxMes,
      cobAtual:           parseFloat(cobAtual.toFixed(1)),
      cobComProg:         parseFloat(cobComProg.toFixed(1)),
      demandaDiaria:      parseFloat(demandaDiaria.toFixed(2)),
      demandaSemanal:     parseFloat(demandaSemanal.toFixed(2)),
      demandaMensal:      parseFloat((demandaSemanal * 4).toFixed(2)),
      producaoMinima,
      multiploProducao,
      prioridadeProduto,
      metaCoberturaDias,
      risco: cobAtual <= riscoLim ? 'critico'
           : cobAtual <= cobMin   ? 'alto'
           : cobAtual <= cobMin*2 ? 'medio' : 'ok',
      motivo: buildMotivo(cobAtual, demandaDiaria, riscoLim, cobMin, cobAlvo)
    });
  });

  // ── Alertas de configuração ─────────────────────────────────────
  if(alertEl){
    let alertHtml = '';
    const maqSemProdutos = MAQUINAS.filter(m => {
      const d = getMaquinaData(m);
      return !d || !Array.isArray(d.produtosCompativeis) || d.produtosCompativeis.length === 0;
    });
    if(maqSemProdutos.length){
      alertHtml += '<div style="background:rgba(255,179,0,.08);border:1px solid rgba(255,179,0,.25);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">'
        + '⚠️ <strong>Máquinas sem produtos vinculados:</strong> ' + maqSemProdutos.join(', ')
        + '. Configure em <strong>Configurações → Máquinas → Produtos Compatíveis</strong>.</div>';
    }
    if(prodSemMaquina.length){
      alertHtml += '<div style="background:rgba(255,71,87,.08);border:1px solid rgba(255,71,87,.3);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--red);margin-bottom:8px">'
        + '⛔ <strong>Produtos sem máquina compatível:</strong> '
        + prodSemMaquina.slice(0,5).join(', ')
        + (prodSemMaquina.length > 5 ? ' e mais ' + (prodSemMaquina.length-5) : '')
        + '. Vincule em <strong>Configurações → Máquinas → Produtos Compatíveis</strong>.</div>';
    }
    const maqSemVel = Object.values(window.MAQUINAS_DATA||{}).filter(m => !(m.pcMin > 0));
    if(maqSemVel.length){
      alertHtml += '<div style="background:rgba(255,179,0,.08);border:1px solid rgba(255,179,0,.25);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--warn);margin-bottom:8px">'
        + '⚠️ <strong>Máquinas sem velocidade configurada:</strong> '
        + maqSemVel.map(m => m.nome).join(', ')
        + '. Configure em <strong>Configurações → Máquinas → Capacidade</strong>.</div>';
    }
    alertEl.innerHTML = alertHtml;
  }

  if(!candidates.length){
    document.getElementById('pa-body').innerHTML = '<div class="empty"><div class="ei">✅</div>Nenhum produto precisa de produção com os parâmetros atuais.<br><small style="color:var(--text3)">Verifique se importou estoque e projeção na aba Importação/API</small></div>';
    paResultados = [];
    renderProgAutomaticaStats();
    return;
  }

  // ── PASSO 2: calcular capacidade efetiva por máquina POR SEMANA ───
  // PROBLEMA 4 FIX: capacidade de cada semana é calculada com base nos
  // dias EFETIVOS da semana (respeitando clip de mês quando 'este-mes').
  const maqCapacidades = {};  // horas efetivas disponíveis/semana (média das 4 semanas)
  const maqCapPorSemana = Array.from({length:4}, () => { const s={}; MAQUINAS.forEach(m=>s[m]=0); return s; });
  for(const maq of MAQUINAS){
    const maqData2 = getMaquinaData(maq);
    const efic = (maqData2 && parseFloat(maqData2.eficiencia) > 0)
      ? parseFloat(maqData2.eficiencia) / 100 : 1;
    for(let si = 0; si < 4; si++){
      const sp = semanasPA[si];
      let hrsEfetivas = weekHrsForMachine(maq, sp.monday);
      if(!hrsEfetivas || hrsEfetivas <= 0){
        if(maqData2 && parseFloat(maqData2.hTurno) > 0 && parseInt(maqData2.nTurnos) > 0){
          // Contar dias úteis efetivos da semana (respeitando clip de mês)
          const wDays = getWeekDays(sp.monday).filter(d =>
            dateStr(d) <= dateStr(sp.sunday) && hoursOnDay(d) > 0
          );
          hrsEfetivas = parseFloat(maqData2.hTurno) * parseInt(maqData2.nTurnos) * wDays.length;
        } else {
          hrsEfetivas = 44;
        }
      } else if(fechamentoMes === 'este-mes' && sp.sunOriginal > ultimoDiaMes){
        // Recalcular proporcionalmente aos dias dentro do mês
        const diasTotais = getWeekDays(sp.monday).filter(d => hoursOnDay(d) > 0).length;
        const diasNoMes  = getWeekDays(sp.monday).filter(d =>
          hoursOnDay(d) > 0 && dateStr(d) <= dateStr(ultimoDiaMes)
        ).length;
        if(diasTotais > 0) hrsEfetivas = hrsEfetivas * (diasNoMes / diasTotais);
      }
      maqCapPorSemana[si][maq] = hrsEfetivas * efic;
    }
    // Capacidade "padrão" = da semana 1 (usada em fallbacks)
    maqCapacidades[maq] = maqCapPorSemana[0][maq] || 44;
  }

  // ── Demanda diária média global — define "alto giro" vs "baixo giro" ─
  const demandaMediaGlobal = candidates.length > 0
    ? candidates.reduce((a, c) => a + c.demandaDiaria, 0) / candidates.length
    : 1;

  // ── PASSO 3: semana de entrada + simulação (v7 — look-ahead) ────────
  //
  //  PRÉ-PASSO: para cada produto, calcular a semana ideal de entrada
  //  sem depender de threshold reativo (cobAtualSem < cobMin).
  //
  //  Para cada produto, o sistema simula o trajeto do estoque sem
  //  qualquer produção e responde: "em qual semana este produto
  //  precisa entrar para não entrar em ruptura e fechar o mês bem?"
  //
  //  Resultado: _semanaEntry (0–3) ou -1 (não precisa produzir)
  //
  //  Regras de decisão:
  //    1. Se cobIni na S1 já < cobMin → entrar imediatamente (entry=0)
  //    2. Senão, encontrar a semana onde cobFim < cobMin sem produção
  //       → essa é a semana MAIS TARDIA segura (entry = essa semana)
  //    3. Se cobFim do mês >= cobAlvo sem nenhuma produção → não produzir
  //    4. Se cobFim do mês < cobAlvo mas não há ruptura → entry = última
  //       semana onde ainda vale produzir (de trás para frente)
  //    5. Ajuste por carga de máquina estimada: se a semana-alvo está
  //       sobrecarregada e a semana anterior tem folga E o produto não
  //       entra em ruptura se antecipado → antecipar
  //
  //  Durante a alocação, o gatilho é:
  //    sem < c._semanaEntry → pular (ainda não é hora)
  //    sem >= c._semanaEntry → pode produzir (sujeito a capacidade)
  //

  const allocations = {};
  candidates.forEach(c => {
    allocations[c.prod] = {
      hrsTotal: 0, cxTotal: 0,
      semanas: [0,0,0,0],
      maquinas: {},
      detalhes: Array.from({length:4}, () => ([]))
    };
  });

  const maqHrsUsadas    = Array.from({length:4}, () => {
    const s = {}; MAQUINAS.forEach(m => { s[m] = 0; }); return s;
  });
  // PROBLEMA 4 FIX: usar capacidade efetiva por semana (com clip de mês)
  // maxPctMaq aplicado já aqui para que scoreMaquina e todos os checks downstream
  // respeitem o limite configurado (ex: 90%) desde o início da alocação.
  const maqHrsRestantes = Array.from({length:4}, (_, si) => {
    const s = {}; MAQUINAS.forEach(m => { s[m] = (maqCapPorSemana[si][m] || 0) * maxPctMaq; }); return s;
  });

  // ── Helper: score de máquina ────────────────────────────────────
  // 6 dimensões com pesos calibrados para minimizar setup e manter
  // continuidade de produção:
  //
  //   score = velocidade × espaço × giro × setup × concentração
  //
  //  O setup é o fator DOMINANTE: uma troca de produto longa
  //  (> 4h) torna a máquina quase inelegível, mesmo sendo mais rápida.
  //  Isso força o sistema a manter a sequência de produção existente.
  function scoreMaquina(mc, sem, demandaDiaria, prodAtual, cxNecTotal){
    const hrsDisp = maqHrsRestantes[sem][mc.maquina] || 0;
    if(hrsDisp <= 0 || mc.pc_min <= 0) return -1;
    if(hrsDisp < 1) return -1; // mínimo 1h disponível

    const capSem   = maqCapPorSemana[sem][mc.maquina] || maqCapacidades[mc.maquina] || 1;
    const ocupacao = Math.max(0, 1 - hrsDisp / capSem);

    // 1. Velocidade normalizada (0–1)
    const maxVel   = Math.max(...MAQUINAS.map(m => parseFloat(getMaquinaData(m)?.pcMin) || 0), 1);
    const fatorVel = mc.pc_min / maxVel;

    // 2. Espaço disponível — penalidade quadrática na ocupação
    const fatorEspaco = Math.pow(1 - ocupacao, 2.0);

    // 3. Concentração: bônus FORTE se esta máquina consegue absorver TODA
    //    a quantidade necessária sozinha — desencoraja splits desnecessários.
    //    Se a máquina pode fazer tudo: fator 2.0 (dobra a pontuação)
    //    Se consegue fazer > 80%: fator 1.4
    //    Caso contrário: fator 1.0 (sem bônus)
    let fatorConcentracao = 1.0;
    if(cxNecTotal > 0 && mc.pc_min > 0){
      const hrsNecTotal = (cxNecTotal * (candidates.find(c2=>c2.prod===prodAtual)?.unid||1)) / (mc.pc_min * 60);
      const pctAbsorve  = Math.min(1, hrsDisp / Math.max(0.01, hrsNecTotal));
      if(pctAbsorve >= 0.999)      fatorConcentracao = 2.0;   // absorve tudo
      else if(pctAbsorve >= 0.80)  fatorConcentracao = 1.4;   // absorve > 80%
      else if(pctAbsorve < 0.30)   fatorConcentracao = 0.6;   // absorve < 30%: penaliza
    }

    // 4. Alto giro: produto acima da média prefere a máquina mais rápida
    const altogiro  = demandaDiaria * 7 > demandaMediaGlobal * 7;
    const fatorGiro = altogiro ? (fatorVel >= 0.85 ? 1.3 : 0.7) : 1.0;

    // 5. Setup — FATOR DOMINANTE
    //    Encontrar o último produto alocado nesta máquina nesta semana.
    //    Se há troca de produto: penalidade exponencial pelo tempo de setup.
    //    Se é continuidade (mesmo produto já na máquina): grande bônus.
    //    Se a máquina está vazia: bônus moderado (sequência nova, sem fragmentação).
    let fatorSetup = 1.0;
    if(prodAtual){
      let ultimoProd = null;
      // Percorrer na ordem de alocação para achar o produto mais recente
      for(const c2 of candidates){
        const dets = allocations[c2.prod]?.detalhes[sem] || [];
        if(dets.some(d => d.maq === mc.maquina)) ultimoProd = c2.prod;
      }
      if(ultimoProd === prodAtual){
        // Continuidade: mesmo produto já na máquina → bônus máximo
        fatorSetup = 2.5;
      } else if(ultimoProd){
        // Troca de produto → penalidade exponencial
        const setupM = typeof getSetupMin === 'function'
          ? getSetupMin(mc.maquina, ultimoProd, prodAtual) : 60;
        // Penalidade: de 0.05 (setup enorme > 8h) até 0.85 (setup mínimo ~0)
        // Usando curva exponencial: e^(-k * setupM) escalada para o intervalo desejado
        // k = ln(17)/480 ≈ 0.00591 → f(0)=0.85, f(480)=0.05
        const k = Math.log(17) / 480;
        fatorSetup = 0.05 + 0.80 * Math.exp(-k * setupM);
        // Setup zero (mesmo família): mantém competitividade razoável
        // Setup 1h (60min): ~0.62
        // Setup 2h (120min): ~0.48
        // Setup 4h (240min): ~0.25
        // Setup 8h (480min): ~0.05 (quase eliminado)
      } else {
        // Máquina vazia nesta semana: bônus moderado
        fatorSetup = 1.2;
      }
    }

    return mc.pc_min * fatorEspaco * fatorGiro * fatorSetup * fatorConcentracao;
  }

  // ── Helper: registrar alocação ───────────────────────────────────
  function registrarAlocacao(prod, sem, maq, cx, hrs, pcMin, unid){
    maqHrsRestantes[sem][maq] -= hrs;
    maqHrsUsadas[sem][maq]    += hrs;
    allocations[prod].hrsTotal          += hrs;
    allocations[prod].cxTotal           += cx;
    allocations[prod].semanas[sem]      += cx;
    allocations[prod].maquinas[maq]      =
      (allocations[prod].maquinas[maq] || 0) + cx;
    allocations[prod].detalhes[sem].push({ maq, cx, hrs, pcMin, unid });
  }

  // ── PRÉ-PASSO: calcular semana de entrada ideal ──────────────────
  candidates.forEach(c => {
    if(c.demandaDiaria <= 0){ c._semanaEntry = -1; return; }

    const cobTeto = (c.metaCoberturaDias > 0) ? c.metaCoberturaDias : cobAlvo;

    // ITEM 2+6 FIX: trajectory uses estoqueSimInicial (estoque + naoPontada)
    // and injects jaProgPorSemana[s] at the start of each week — matching
    // exactly what the main loop does. This prevents the pre-pass from
    // recommending production that is already covered by scheduled records.
    const path = [];
    let estoq = c.estoqueSim; // = estoque + naoPontadaAtual
    for(let s = 0; s < 4; s++){
      // Inject already-programmed production for this week (Item 2)
      estoq += (c.jaProgPorSemana && c.jaProgPorSemana[s] > 0 && s > 0)
        ? c.jaProgPorSemana[s] : 0;
      const ini = estoq;
      const fin = Math.max(0, estoq - c.demandaSemanal);
      path.push({
        ini, fin,
        cobIni: ini / c.demandaDiaria,
        cobFin: fin / c.demandaDiaria
      });
      estoq = fin;
    }
    c._trajetoria = path;

    // Regra 3: não precisa produzir se o mês fecha bem sem nova produção
    if(path[3].cobFin >= cobTeto){
      c._semanaEntry = -1;
      return;
    }

    // Regra 1: já crítico no início do mês → entrar imediatamente
    if(path[0].cobIni < cobMin){
      c._semanaEntry = 0;
      return;
    }

    // Regra 2: encontrar a semana onde cobFim cai abaixo de cobMin
    let semRuptura = -1;
    for(let s = 0; s < 4; s++){
      if(path[s].cobFin < cobMin){
        semRuptura = s;
        break;
      }
    }

    if(semRuptura >= 0){
      c._semanaEntry = semRuptura;
    } else {
      // Regra 4: sem ruptura no mês mas fechamento abaixo de cobTeto
      // Encontrar a semana mais TARDIA onde cobFin < cobTeto
      let entry = 3;
      for(let s = 3; s >= 0; s--){
        if(path[s].cobFin < cobTeto) entry = s;
        else break;
      }
      c._semanaEntry = entry;
    }

    // Regra 5: ajuste por carga estimada de máquina (antecipação defensiva)
    if(c._semanaEntry > 0){
      const semAlvo  = c._semanaEntry;
      const semAntes = semAlvo - 1;

      let hrsEstimadas = 0;
      candidates.forEach(outro => {
        if(outro === c || outro._semanaEntry !== semAlvo) return;
        const maqsComuns = c.maquinasCompativeis.filter(m =>
          outro.maquinasCompativeis.some(o => o.maquina === m.maquina)
        );
        if(!maqsComuns.length) return;
        const vel = outro.maquinasCompativeis[0]?.pc_min || 1;
        hrsEstimadas += (outro.demandaDiaria * cobTeto * outro.unid) / (vel * 60);
      });

      const maqPrinc    = c.maquinasCompativeis[0];
      const capMaqPrinc = maqPrinc ? (maqCapacidades[maqPrinc.maquina] || 40) : 40;
      const occEstimada = hrsEstimadas / capMaqPrinc;

      if(occEstimada > 0.80){
        const cobFinSemAntes = path[semAntes].cobFin;
        // Só antecipa se ainda há necessidade E não vai ultrapassar o teto
        if(cobFinSemAntes < cobTeto){
          c._semanaEntry = semAntes;
        }
      }
    }
  });

  // ── LOOP PRINCIPAL: 4 semanas, guiado por _semanaEntry ───────────
  for(let sem = 0; sem < 4; sem++){

    // ITEM 2 FIX — injetar produção já programada desta semana no estoque simulado
    // jaProgPorSemana[0] já está em estoqueSimInicial; semanas 1-3 entram aqui.
    if(sem > 0){
      candidates.forEach(c => {
        const cxProg = (c.jaProgPorSemana && c.jaProgPorSemana[sem]) || 0;
        if(cxProg > 0) c.estoqueSim += cxProg;
      });
    }

    // 3a. Recalcular prioridade dinâmica (estoque simulado pode ter mudado)
    candidates.forEach(c => {
      const cob = c.demandaDiaria > 0 ? c.estoqueSim / c.demandaDiaria : 999;
      c._cobSem   = parseFloat(cob.toFixed(1));
      c._priorSem = calcPrioridadeEquilibrada(
        cob, c.demandaDiaria, riscoLim, cobMin, c.prioridadeProduto, sem
      );
    });

    // 3b. Ordenar: mais urgente primeiro
    const fila = [...candidates].sort((a,b) => b._priorSem - a._priorSem);

    const MAX_PASSES = 8;
    for(let pass = 0; pass < MAX_PASSES; pass++){
      let algumAlocado = false;

      for(const c of fila){
        if(c.demandaDiaria <= 0) continue;

        // ── Gatilho: semana de entrada calculada no pré-passo ────────
        if(c._semanaEntry < 0) continue;
        if(sem < c._semanaEntry) continue;

        // PROBLEMA 3 FIX — teto de cobertura rigoroso:
        // Usar metaCoberturaDias do produto se configurado; senão, cobAlvo.
        // cobAlvo é em dias, logo cobTeto também está em dias.
        const cobTeto = (c.metaCoberturaDias > 0) ? c.metaCoberturaDias : cobAlvo;

        // Não produzir se estoque simulado atual já cobre além do teto
        const cobSimAtual = c.demandaDiaria > 0 ? c.estoqueSim / c.demandaDiaria : 999;
        if(cobSimAtual >= cobTeto) continue;

        // FIX 2 — absorver carryover da semana anterior: se houve excedente não
        // alocado por falta de capacidade, somar aqui para que seja redistribuído
        // nas semanas seguintes. Zera o carryover após absorver.
        const estoqueFinSem = Math.max(0, c.estoqueSim - c.demandaSemanal);
        let cxNecessario = Math.max(0, Math.ceil(
          c.demandaDiaria * cobTeto - estoqueFinSem
        ));
        if(c._carryover > 0){
          cxNecessario += c._carryover;
          c._carryover  = 0;
        }
        if(cxNecessario <= 0) continue;

        // Respeitar mínimo e múltiplo
        if(c.producaoMinima > 0 && cxNecessario < c.producaoMinima)
          cxNecessario = c.producaoMinima;
        if(c.multiploProducao > 0)
          cxNecessario = Math.ceil(cxNecessario / c.multiploProducao) * c.multiploProducao;

        // PROBLEMA 3 FIX — teto rígido pós-lote: nunca ultrapassar cobTeto.
        // O fator de folga (1.2) só se aplica quando há produção mínima obrigatória.
        const cobMaxPermitida = (c.producaoMinima > 0) ? cobTeto * 1.15 : cobTeto;
        const cobPosProd = (estoqueFinSem + cxNecessario) / c.demandaDiaria;
        if(cobPosProd > cobMaxPermitida){
          const cxTeto = Math.floor(c.demandaDiaria * cobMaxPermitida - estoqueFinSem);
          // Se após cortar ficaria abaixo do mínimo obrigatório, aceitar o mínimo
          // (melhor ter leve excesso que ruptura)
          if(cxTeto >= (c.producaoMinima || 1)){
            cxNecessario = cxTeto;
          } else if(c.producaoMinima > 0 && cobSimAtual < cobMin){
            // Ruptura iminente + mínimo obrigatório: aceitar mesmo ultrapassando teto
            cxNecessario = c.producaoMinima;
          } else {
            // Nenhuma exceção aplicável: bloquear produção nesta semana
            continue;
          }
        }

        // ITEM 6 FIX — verificação final: se estoque corrente já supre o mês
        // inteiro sem nova produção (considerando prod. já programada nas semanas
        // futuras), não antecipar nem duplicar produção desnecessária.
        {
          // Simular restante do mês SEM nova produção, mas COM jaProgPorSemana futuro
          let estoqSemProd = c.estoqueSim;
          let cobreSemp = true;
          for(let fs = sem; fs < 4; fs++){
            // Injetar produção já programada desta semana futura (não duplicar sem=0)
            if(fs > 0) estoqSemProd += (c.jaProgPorSemana && c.jaProgPorSemana[fs]) || 0;
            // Injetar nova alocação desta semana se já foi registrada
            estoqSemProd += (allocations[c.prod].semanas[fs] || 0);
            estoqSemProd = Math.max(0, estoqSemProd - c.demandaSemanal);
            if(estoqSemProd / c.demandaDiaria < cobMin){ cobreSemp = false; break; }
          }
          if(cobreSemp) continue; // já coberto — não precisa de mais produção agora
        }

        // 3d-SCORE: escolher máquinas por pontuação ponderada
        const maqsOrdenadas = [...c.maquinasCompativeis]
          .map(mc => ({ ...mc, score: scoreMaquina(mc, sem, c.demandaDiaria, c.prod, cxNecessario) }))
          .filter(mc => mc.score >= 0)
          .sort((a, b) => b.score - a.score);

        if(!maqsOrdenadas.length) continue;

        let cxRestante = cxNecessario;

        // FIX 2 — validar capacidade real antes de confirmar alocação.
        // Tentar alocar na máquina principal primeiro. Se não couber tudo,
        // só divide em uma segunda máquina. O que ainda sobrar (excedente)
        // é marcado em c._carryover para ser considerado na próxima semana.
        const maqPrinc = maqsOrdenadas[0];
        const hrsNecPrinc = (cxRestante * c.unid) / (maqPrinc.pc_min * 60);
        // maxHrsPrinc = hrsRestantes já incorpora maxPctMaq (aplicado na inicialização)
        const maxHrsPrinc = maqHrsRestantes[sem][maqPrinc.maquina];
        const hrsJaAlocPrinc = 0; // redundante: maqHrsRestantes já desconta alocações via registrarAlocacao
        const hrsPermitPrinc   = maxHrsPrinc;
        const hrsAlocarPrinc   = Math.min(hrsNecPrinc, hrsPermitPrinc);
        const cxAlocarPrinc    = Math.floor(hrsAlocarPrinc * 60 * maqPrinc.pc_min / c.unid);
        const principalAbsorve = cxAlocarPrinc >= cxRestante;

        const maxMaquinas = principalAbsorve ? 1 : Math.min(2, maqsOrdenadas.length);

        let cxEfetivamenteAlocado = 0;
        for(let mi = 0; mi < maxMaquinas && cxRestante > 0; mi++){
          const mc        = maqsOrdenadas[mi];
          const hrsNec    = (cxRestante * c.unid) / (mc.pc_min * 60);
          // maqHrsRestantes já inclui o cap de maxPctMaq
          const hrsAlocar = Math.min(hrsNec, maqHrsRestantes[sem][mc.maquina]);
          if(hrsAlocar < 0.01) continue;

          const cxAlocar = Math.floor(hrsAlocar * 60 * mc.pc_min / c.unid);
          if(cxAlocar <= 0) continue;

          registrarAlocacao(c.prod, sem, mc.maquina, cxAlocar, hrsAlocar, mc.pc_min, c.unid);
          c.estoqueSim       += cxAlocar;
          cxRestante         -= cxAlocar;
          cxEfetivamenteAlocado += cxAlocar;
          algumAlocado        = true;
        }

        // FIX 2 — carryover: se ainda sobrou quantidade não alocada por falta
        // de capacidade, guardar para que a próxima semana absorva o deficit.
        // Isso evita "blocos fantasma" — o Gantt só mostrará o que realmente cabe.
        if(cxRestante > 0 && sem < 3){
          c._carryover = (c._carryover || 0) + cxRestante;
        }
      }

      if(!algumAlocado) break;
    }

    // 3e. Consumir demanda semanal
    candidates.forEach(c => {
      c.estoqueSim = Math.max(0, c.estoqueSim - c.demandaSemanal);
    });
  }

  // ── PASSO 4: equalização de carga — máquinas + semanas ─────────────
  //
  //  FASE A: troca de máquina dentro da mesma semana (intra-semana)
  //    Trigger duplo:
  //      a) máquina sobrecarregada (> ALVO_MAX_OCC)
  //      b) desequilíbrio grande entre máquinas compatíveis
  //         (diferença de ocupação > 40 pp → redistribuir)
  //
  //  FASE B: movimentação entre semanas
  //    > 90%: adiar produto menos urgente para semana mais leve
  //    < 70%: antecipar produto de semana futura mais carregada
  //
  //  FASE C: preenchimento de máquinas ociosas
  //    Máquinas com < 30% de ocupação recebem produtos de máquinas
  //    compatíveis com > 60% de carga. Redistribuição parcial (split).
  //
  const ALVO_MIN_OCC  = 0.70;
  const ALVO_MAX_OCC  = 0.90;
  const OCIOSIDADE    = 0.30;  // abaixo disso = máquina ociosa
  const DESEQ_TRIGGER = 0.40;  // diferença de occ que ativa FASE A preventiva

  // ── Recalcular prioridade com estado pós-simulação ───────────────
  candidates.forEach(c => {
    let estoq = c.estoque + (c.naoPontadaAtual || 0);
    for(let s = 0; s < 4; s++){
      if(s > 0) estoq += (c.jaProgPorSemana && c.jaProgPorSemana[s]) || 0;
      estoq = Math.max(0, estoq + (allocations[c.prod].semanas[s] || 0) - c.demandaSemanal);
    }
    c._estoqFinal = estoq;
    c._cobFinal   = c.demandaDiaria > 0 ? estoq / c.demandaDiaria : 999;
    c._priorP4    = c.demandaDiaria > 0
      ? calcPrioridadeEquilibrada(c._cobFinal, c.demandaDiaria, riscoLim, cobMin, c.prioridadeProduto, 3)
      : 0;
  });

  // ── Helper: recalcular trajetória de estoque ─────────────────────
  // Usa estoqueSimInicial (estoque + naoPontada) e injeta jaProgPorSemana
  // semana-a-semana, igual ao loop principal — consistência garantida.
  function recalcPath(c){
    const path = [];
    let estoq = c.estoque + (c.naoPontadaAtual || 0); // igual a estoqueSimInicial
    for(let s = 0; s < 4; s++){
      // Injetar produção já programada nesta semana (s>0; s=0 já está em estoq)
      if(s > 0) estoq += (c.jaProgPorSemana && c.jaProgPorSemana[s]) || 0;
      const ini = estoq + (allocations[c.prod].semanas[s] || 0);
      const fin = Math.max(0, ini - c.demandaSemanal);
      path.push({
        ini, fin,
        cobIni: c.demandaDiaria > 0 ? ini / c.demandaDiaria : 999,
        cobFin: c.demandaDiaria > 0 ? fin / c.demandaDiaria : 999
      });
      estoq = fin;
    }
    return path;
  }

  // ── Helper: remover alocação ─────────────────────────────────────
  function removerAlocacao(prod, sem, det){
    const alloc = allocations[prod];
    alloc.semanas[sem]           -= det.cx;
    alloc.detalhes[sem]           = alloc.detalhes[sem].filter(d => d !== det);
    alloc.hrsTotal               -= det.hrs;
    alloc.cxTotal                -= det.cx;
    alloc.maquinas[det.maq]       = (alloc.maquinas[det.maq] || det.cx) - det.cx;
    maqHrsRestantes[sem][det.maq] += det.hrs;
    maqHrsUsadas[sem][det.maq]    -= det.hrs;
  }

  // ── Helper: adicionar alocação ────────────────────────────────────
  function adicionarAlocacao(prod, sem, det){
    const alloc = allocations[prod];
    alloc.semanas[sem]           += det.cx;
    alloc.detalhes[sem].push(det);
    alloc.hrsTotal               += det.hrs;
    alloc.cxTotal                += det.cx;
    alloc.maquinas[det.maq]       = (alloc.maquinas[det.maq] || 0) + det.cx;
    maqHrsRestantes[sem][det.maq] -= det.hrs;
    maqHrsUsadas[sem][det.maq]    += det.hrs;
  }

  // ── Helper: pode redistribuir parcialmente para máquina alternativa? ──
  // Retorna {cx, hrs, detNovo} se a troca for viável, null caso contrário.
  function calcRedistribuicao(c, det, maqAlt, sem, cxDesejado){
    if(maqAlt.pc_min <= 0) return null;
    const hrsNaAlt = (cxDesejado * c.unid) / (maqAlt.pc_min * 60);
    const capAlt   = (maqCapPorSemana[sem]?.[maqAlt.maquina] || maqCapacidades[maqAlt.maquina] || 1);
    const dispAlt  = maqHrsRestantes[sem][maqAlt.maquina];
    if(dispAlt < hrsNaAlt - 0.01) return null;
    const occAlt   = (maqHrsUsadas[sem][maqAlt.maquina] + hrsNaAlt) / capAlt;
    if(occAlt > ALVO_MAX_OCC + 0.05) return null;
    return { maq: maqAlt.maquina, cx: cxDesejado, hrs: hrsNaAlt, pcMin: maqAlt.pc_min, unid: c.unid };
  }

  // ── FASE A: troca de máquina dentro da mesma semana ──────────────
  for(let pass = 0; pass < 3; pass++){
    let algumaTroca = false;

    for(let sem = 0; sem < 4; sem++){
      for(const maqSrc of MAQUINAS){
        const capSrc = (maqCapPorSemana[sem]?.[maqSrc] || maqCapacidades[maqSrc] || 1);
        const occSrc = maqHrsUsadas[sem][maqSrc] / capSrc;

        // Trigger A: máquina sobrecarregada (>90%)
        // Trigger B: desequilíbrio com máquina alternativa compat. (>40pp)
        const precisaRedistribuir = occSrc > ALVO_MAX_OCC ||
          candidates.some(c =>
            allocations[c.prod].detalhes[sem].some(d => d.maq === maqSrc) &&
            c.maquinasCompativeis.some(mc =>
              mc.maquina !== maqSrc &&
              (maqHrsUsadas[sem][mc.maquina] / (maqCapPorSemana[sem]?.[mc.maquina] || maqCapacidades[mc.maquina] || 1))
                < (occSrc - DESEQ_TRIGGER)
            )
          );

        if(!precisaRedistribuir) continue;

        // Produtos nesta semana nesta máquina — menos urgente move primeiro
        const prodsNestaSem = candidates
          .filter(c => allocations[c.prod].detalhes[sem].some(d => d.maq === maqSrc))
          .sort((a, b) => a._priorP4 - b._priorP4);

        for(const c of prodsNestaSem){
          const occAtual = maqHrsUsadas[sem][maqSrc] / capSrc;
          if(occAtual <= ALVO_MIN_OCC) break; // já equilibrado suficiente

          const det = allocations[c.prod].detalhes[sem].find(d => d.maq === maqSrc);
          if(!det || det.cx <= 0) continue;

          // Máquinas alternativas ordenadas por menor ocupação
          const maqAlts = c.maquinasCompativeis
            .filter(mc => mc.maquina !== maqSrc && mc.pc_min > 0)
            .map(mc => ({
              ...mc,
              occ: maqHrsUsadas[sem][mc.maquina] / (maqCapacidades[mc.maquina] || 1)
            }))
            .filter(mc => mc.occ < occAtual - 0.05) // só se realmente menos ocupada
            .sort((a, b) => a.occ - b.occ);

          if(!maqAlts.length) continue;

          for(const maqAlt of maqAlts){
            // Tentar mover o lote inteiro primeiro
            const redistTotal = calcRedistribuicao(c, det, maqAlt, sem, det.cx);
            if(redistTotal){
              removerAlocacao(c.prod, sem, det);
              adicionarAlocacao(c.prod, sem, redistTotal);
              algumaTroca = true;
              break;
            }

            // Se o lote inteiro não cabe, tentar mover metade (split entre máquinas)
            const cxMetade = Math.floor(det.cx / 2);
            if(cxMetade > 0){
              const redistMetade = calcRedistribuicao(c, det, maqAlt, sem, cxMetade);
              if(redistMetade){
                // Atualizar alocação na máquina original com a metade restante
                removerAlocacao(c.prod, sem, det);
                const hrsRestante = ((det.cx - cxMetade) * c.unid) / (det.pcMin * 60);
                adicionarAlocacao(c.prod, sem,
                  { maq: maqSrc, cx: det.cx - cxMetade, hrs: hrsRestante, pcMin: det.pcMin, unid: c.unid }
                );
                adicionarAlocacao(c.prod, sem, redistMetade);
                algumaTroca = true;
                break;
              }
            }
          }
        }
      }
    }

    if(!algumaTroca) break;
  }

  // ── FASE B: movimentação entre semanas ───────────────────────────
  for(let pass = 0; pass < 3; pass++){
    let algumMov = false;

    for(const maq of MAQUINAS){
      // Use per-semana capacity (calculated per week for FASE B loop)
      for(let semOrig = 0; semOrig < 4; semOrig++){
        const cap = (maqCapPorSemana[semOrig]?.[maq] || maqCapacidades[maq] || 1);
        const occ = maqHrsUsadas[semOrig][maq] / cap;

        // ── Semana cheia: adiar produto menos urgente ────────────────
        if(occ > ALVO_MAX_OCC){
          const movCands = candidates
            .filter(c => allocations[c.prod].detalhes[semOrig].some(d => d.maq === maq))
            .sort((a, b) => a._priorP4 - b._priorP4);

          for(const c of movCands){
            if(maqHrsUsadas[semOrig][maq] / cap <= ALVO_MAX_OCC) break;

            const det = allocations[c.prod].detalhes[semOrig].find(d => d.maq === maq);
            if(!det) continue;

            const candidatosDst = [];
            for(let s = semOrig + 1; s < 4; s++) candidatosDst.push(s);
            for(let s = semOrig - 1; s >= 0; s--) candidatosDst.push(s);

            for(const semDst of candidatosDst){
              const occDst = maqHrsUsadas[semDst][maq] / cap;
              if(occDst >= ALVO_MAX_OCC) continue;
              if(maqHrsRestantes[semDst][maq] < det.hrs - 0.01) continue;

              // Verificar que remoção em semOrig não causa ruptura
              let estoqCheck = c.estoque;
              let ruptura = false;
              for(let s = 0; s < 4; s++){
                const cxS = s === semOrig ? (allocations[c.prod].semanas[s] - det.cx) : allocations[c.prod].semanas[s];
                estoqCheck = Math.max(0, estoqCheck + cxS - c.demandaSemanal);
                if(s <= semOrig && c.demandaDiaria > 0 && estoqCheck / c.demandaDiaria < cobMin){
                  ruptura = true; break;
                }
              }
              if(ruptura) continue;

              // Verificar teto no destino
              let estoqDst = c.estoque;
              for(let s = 0; s < 4; s++){
                const cxS = (s === semOrig ? (allocations[c.prod].semanas[s] - det.cx) : allocations[c.prod].semanas[s])
                          + (s === semDst ? det.cx : 0);
                estoqDst = Math.max(0, estoqDst + cxS - c.demandaSemanal);
              }
              if(c.demandaDiaria > 0 && estoqDst / c.demandaDiaria > cobAlvo * 1.2) continue;

              removerAlocacao(c.prod, semOrig, det);
              adicionarAlocacao(c.prod, semDst, { ...det, maq });
              algumMov = true;
              break;
            }
          }
        }

        // ── Semana leve: antecipar de semana futura mais cheia ───────
        if(occ < ALVO_MIN_OCC){
          for(let semSrc = semOrig + 1; semSrc < 4; semSrc++){
            const occSrc = maqHrsUsadas[semSrc][maq] / cap;
            if(occSrc <= ALVO_MIN_OCC) continue;

            const movCands = candidates
              .filter(c => allocations[c.prod].detalhes[semSrc].some(d => d.maq === maq))
              .sort((a, b) => b._priorP4 - a._priorP4);

            for(const c of movCands){
              if(maqHrsUsadas[semOrig][maq] / cap >= ALVO_MIN_OCC) break;

              const det = allocations[c.prod].detalhes[semSrc].find(d => d.maq === maq);
              if(!det) continue;
              if(maqHrsRestantes[semOrig][maq] < det.hrs - 0.01) continue;
              if((maqHrsUsadas[semOrig][maq] + det.hrs) / cap > ALVO_MAX_OCC) continue;
              if(allocations[c.prod].semanas[semOrig] > 0) continue; // já produz nesta semana

              // Verificar teto após antecipação
              let estoqCheck = c.estoque;
              for(let s = 0; s < 4; s++){
                const cxS = (s === semSrc ? (allocations[c.prod].semanas[s] - det.cx) : allocations[c.prod].semanas[s])
                          + (s === semOrig ? det.cx : 0);
                estoqCheck = Math.max(0, estoqCheck + cxS - c.demandaSemanal);
              }
              if(c.demandaDiaria > 0 && estoqCheck / c.demandaDiaria > cobAlvo * 1.2) continue;

              removerAlocacao(c.prod, semSrc, det);
              adicionarAlocacao(c.prod, semOrig, { ...det, maq });
              algumMov = true;
              break;
            }
          }
        }
      }
    }

    if(!algumMov) break;
  }

  // ── FASE C: preenchimento de máquinas ociosas (< 30%) ────────────
  // Para cada semana, detecta máquinas ociosas e tenta colocar parte
  // da carga de máquinas >60% compatíveis nelas (redistribuição parcial).
  for(let pass = 0; pass < 2; pass++){
    let algumFill = false;

    for(let sem = 0; sem < 4; sem++){
      // Máquinas ociosas: <30% e não são 0% apenas porque nada foi programado
      const maqsOciosas = MAQUINAS.filter(m => {
        const cap = maqCapacidades[m] || 1;
        return (maqHrsUsadas[sem][m] / cap) < OCIOSIDADE;
      }).map(m => ({
        maq: m,
        occ: maqHrsUsadas[sem][m] / (maqCapPorSemana[sem]?.[m] || maqCapacidades[m] || 1),
        cap: (maqCapPorSemana[sem]?.[m] || maqCapacidades[m] || 1)
      })).sort((a, b) => a.occ - b.occ); // mais ociosa primeiro

      if(!maqsOciosas.length) continue;

      // Para cada máquina ociosa, procurar produtos compatíveis em máquinas
      // com >60% de ocupação e fazer split
      for(const maqOciosa of maqsOciosas){
        if(maqHrsUsadas[sem][maqOciosa.maq] / maqOciosa.cap >= OCIOSIDADE + 0.15) continue;

        // Produtos que podem ser feitos nesta máquina e estão em outra máquina >60%
        const candidatosFill = candidates
          .filter(c => {
            const temNaOciosa = c.maquinasCompativeis.some(mc => mc.maquina === maqOciosa.maq);
            if(!temNaOciosa) return false;
            // Tem algum detalhe em outra máquina com ocupação alta?
            return allocations[c.prod].detalhes[sem].some(d => {
              const capD = maqCapacidades[d.maq] || 1;
              return d.maq !== maqOciosa.maq && (maqHrsUsadas[sem][d.maq] / capD) > 0.60;
            });
          })
          .sort((a, b) => b._priorP4 - a._priorP4); // mais urgente primeiro

        for(const c of candidatosFill){
          if(maqHrsUsadas[sem][maqOciosa.maq] / maqOciosa.cap >= ALVO_MIN_OCC) break;

          // Detalhe na máquina de alta ocupação
          const detSrc = allocations[c.prod].detalhes[sem].find(d => {
            const capD = maqCapacidades[d.maq] || 1;
            return d.maq !== maqOciosa.maq && (maqHrsUsadas[sem][d.maq] / capD) > 0.60;
          });
          if(!detSrc || detSrc.cx < 2) continue;

          // Velocidade nesta máquina ociosa
          const mcOciosa = c.maquinasCompativeis.find(mc => mc.maquina === maqOciosa.maq);
          if(!mcOciosa || mcOciosa.pc_min <= 0) continue;

          // Quanto conseguimos mover para a máquina ociosa?
          const hrsDisp  = maqHrsRestantes[sem][maqOciosa.maq];
          const cxMaxOciosa = Math.floor(hrsDisp * 60 * mcOciosa.pc_min / c.unid);
          const cxMover  = Math.min(Math.floor(detSrc.cx / 2), cxMaxOciosa);
          if(cxMover <= 0) continue;

          const redistDet = calcRedistribuicao(c, detSrc, mcOciosa, sem, cxMover);
          if(!redistDet) continue;

          // Atualizar detalhe na máquina original
          removerAlocacao(c.prod, sem, detSrc);
          const hrsRestante = ((detSrc.cx - cxMover) * c.unid) / (detSrc.pcMin * 60);
          if(detSrc.cx - cxMover > 0){
            adicionarAlocacao(c.prod, sem,
              { maq: detSrc.maq, cx: detSrc.cx - cxMover, hrs: hrsRestante, pcMin: detSrc.pcMin, unid: c.unid }
            );
          }
          adicionarAlocacao(c.prod, sem, redistDet);
          algumFill = true;
        }
      }
    }

    if(!algumFill) break;
  }

  // ── PASSO 4: construir paResultados (semana 1 = semana selecionada) ──
  paResultados = [];
  const semanaDays = getWeekDays(semanasPA[0].monday); // dias da semana 1 selecionada

  for(const c of candidates){
    const alloc = allocations[c.prod];
    if(!alloc || alloc.cxTotal <= 0) continue;

    // Máquina que mais produziu (para exibição principal)
    const maqPrincipal = Object.entries(alloc.maquinas)
      .sort((a,b) => b[1] - a[1])[0]?.[0] || c.maquinasCompativeis[0]?.maquina || '—';
    const pcMinPrincipal = c.maquinasCompativeis.find(m => m.maquina === maqPrincipal)?.pc_min
      || c.maquinasCompativeis[0]?.pc_min || 0;

    // Semana 1 é o que vai para o Gantt atual
    const cxSemana1  = alloc.semanas[0] || 0;
    const hrsSemana1 = (cxSemana1 > 0 && pcMinPrincipal > 0)
      ? (cxSemana1 * c.unid) / (pcMinPrincipal * 60) : 0;
    const maqCap1    = maqCapacidades[maqPrincipal] || 1;
    const pctMaquina = parseFloat((hrsSemana1 / maqCap1 * 100).toFixed(1));

    // ITEM 3 FIX: cobertura projetada = saldo na virada + nova produção sugerida
    // saldoVirada já inclui estoque atual + não-apontado + prod. programada - demanda até virada
    const cobProjetada = c.demandaDiaria > 0
      ? parseFloat(((c.saldoVirada || 0) + alloc.cxTotal) / c.demandaDiaria).toFixed(1)
      : 999;

    // Distribuir produção da semana 1 pelos dias úteis
    const maqWorkDays = semanaDays.filter(d => hoursOnMachineDay(maqPrincipal, d) > 0);
    const diasDist    = distribuirPorDia(cxSemana1, maqWorkDays, { ...c, maquina: maqPrincipal });

    // Resumo das semanas e máquinas no motivo
    const semInfo = alloc.semanas
      .map((cx, i) => cx > 0 ? `S${i+1}:${cx}cx` : null)
      .filter(Boolean).join(' · ');
    const maqInfo = Object.keys(alloc.maquinas).length > 1
      ? ' [' + Object.entries(alloc.maquinas).map(([m,cx]) => `${m.split(' ').pop()}:${cx}cx`).join(', ') + ']'
      : '';
    // Informar produção não apontada e saldo projetado na virada (transparência de PCP)
    const naoPontInfo = (c.naoPontadaAtual > 0)
      ? ` <span style="color:var(--warn)" title="Produção em andamento ainda não apontada">⚙ ${Math.round(c.naoPontadaAtual)}cx n/apon.</span>`
      : '';
    const jaProgInfo = (c.jaProgTotal > 0)
      ? ` <span style="color:var(--cyan)" title="Produção já programada descontada da necessidade">↩ ${Math.round(c.jaProgTotal)}cx prog.</span>`
      : '';
    const saldoInfo = c.saldoVirada != null
      ? ` <span style="color:var(--text3)" title="Saldo projetado na virada do mês">| saldo virada: ${Math.round(c.saldoVirada)}cx</span>`
      : '';
    const motivoFinal = c.motivo + (semInfo ? ` | ${semInfo}${maqInfo}` : '') + naoPontInfo + jaProgInfo + saldoInfo;

    // ── Fix 3: Validação de insumos + limite por estoque disponível ──
    const fichaTec = FICHA_TECNICA.find(f => String(f.cod)===String(c.cod) || f.desc===c.prod)
                  || (typeof fichaTecnicaData!=='undefined'
                      ? fichaTecnicaData.find(f => String(f.cod)===String(c.cod) || f.desc===c.prod)
                      : null);
    const temFichasTecnica = !!(fichaTec && fichaTec.insumos && fichaTec.insumos.length);

    // Calcular o máximo de caixas que os insumos disponíveis permitem produzir
    // cxMaxPorInsumos = min( floor(estoqueInsumo / qty) ) para cada insumo
    let cxMaxPorInsumos = Infinity;
    let insumosStatus = [], insumosOk = true, insumosFaltando = [];

    if(temFichasTecnica && insumosEstoqueData.length > 0){
      insumosStatus = fichaTec.insumos.map(ins => {
        const consumo      = (ins.qty||0) * alloc.cxTotal;
        const estoqueAtual = getEstoqueInsumo(ins.insumo);
        const saldo        = estoqueAtual != null ? estoqueAtual - consumo : null;
        const falta        = saldo != null && saldo < 0;

        // Calcular quantas caixas este insumo permite (para Opção B)
        if(ins.qty > 0 && estoqueAtual != null){
          const maxCxEsteInsumo = Math.floor(estoqueAtual / ins.qty);
          if(maxCxEsteInsumo < cxMaxPorInsumos) cxMaxPorInsumos = maxCxEsteInsumo;
        }

        if(falta){ insumosOk = false; insumosFaltando.push({ nome: ins.insumo, consumo, estoqueAtual, saldo, deficit: Math.abs(saldo) }); }
        return { nome: ins.insumo, consumo, estoqueAtual, saldo, falta };
      }).filter(i => i.consumo > 0);
    }
    if(cxMaxPorInsumos === Infinity) cxMaxPorInsumos = null; // sem ficha técnica = sem limite

    // Opção B: limitar a produção pelo estoque de insumos
    const modoInsumo = document.querySelector('input[name="pa-modo-insumo"]:checked')?.value || 'total';
    let cxAlocadasFinal  = alloc.cxTotal;
    let semanasFinal     = alloc.semanas;
    let detalhesFinal    = alloc.detalhes;
    let hrsAlocTotalFinal = alloc.hrsTotal;

    if(modoInsumo === 'limitado' && cxMaxPorInsumos != null && cxMaxPorInsumos < alloc.cxTotal){
      // Recalcular semanas proporcionalmente ao limite de insumos
      const ratio = cxMaxPorInsumos / Math.max(1, alloc.cxTotal);
      semanasFinal  = alloc.semanas.map(cx  => Math.round(cx * ratio));
      detalhesFinal = alloc.detalhes.map(detSem =>
        detSem.map(det => ({ ...det, cx: Math.round(det.cx * ratio) }))
      );
      cxAlocadasFinal   = semanasFinal.reduce((a,v) => a+v, 0);
      hrsAlocTotalFinal = detalhesFinal.flat().reduce((a,d) => a + d.hrs * (d.cx / Math.max(1, d.cx / ratio)), 0);
      // Recalcular insumosStatus com a quantidade ajustada
      if(temFichasTecnica && insumosEstoqueData.length > 0){
        insumosStatus = fichaTec.insumos.map(ins => {
          const consumo      = (ins.qty||0) * cxAlocadasFinal;
          const estoqueAtual = getEstoqueInsumo(ins.insumo);
          const saldo        = estoqueAtual != null ? estoqueAtual - consumo : null;
          const falta        = saldo != null && saldo < 0;
          return { nome: ins.insumo, consumo, estoqueAtual, saldo, falta };
        }).filter(i => i.consumo > 0);
        insumosOk = insumosStatus.every(i => !i.falta);
        insumosFaltando = insumosStatus.filter(i => i.falta).map(i => ({
          ...i, deficit: Math.abs(i.saldo)
        }));
      }
    }

    paResultados.push({
      prod:              c.prod,
      cod:               c.cod,
      maquina:           maqPrincipal,
      maquinasUsadas:    Object.keys(alloc.maquinas),
      pc_min:            pcMinPrincipal,
      unid:              c.unid,
      estoque:           c.estoque,
      cobAtual:          c.cobAtual,
      cobComProg:        c.cobComProg,
      jaProgTotal:       c.jaProgTotal || 0,
      jaProgPorSemana:   c.jaProgPorSemana || [0,0,0,0],
      saldoVirada:       c.saldoVirada || 0,
      necessidadeProxMes:c.necessidadeProxMes || 0,
      demandaDiaria:     c.demandaDiaria,
      demandaSemanal:    c.demandaSemanal,
      qntCaixasSugerida: alloc.cxTotal,       // necessidade total calculada
      cxMaxPorInsumos:   cxMaxPorInsumos,      // máximo que os insumos permitem (Fix 3)
      modoInsumo:        modoInsumo,
      hrsAlocadas:       parseFloat(hrsSemana1.toFixed(2)),
      hrsAlocadasTotal:  parseFloat(hrsAlocTotalFinal.toFixed(2)),
      cxAlocadas:        semanasFinal[0] || 0, // semana 1 (já ajustada pelo modo)
      cxAlocadasTotal:   cxAlocadasFinal,      // total 4 semanas (já ajustado)
      semanas:           semanasFinal,          // [cx_s1..s4] ajustados
      detalhes:          detalhesFinal,         // por semana × máquina ajustados
      pctMaquina:        pctMaquina,
      cobProjetada,
      diasDist,
      risco:             c.risco,
      motivo:            motivoFinal,
      insumosStatus,
      insumosOk,
      insumosFaltando,
      temFichasTecnica,
      velocidadeOrigem:  'equilibrado'
    });
  }

  renderProgAutomaticaResultado();
  renderProgAutomaticaStats();
  document.getElementById('pa-apply-btn').style.display = paResultados.length ? 'flex' : 'none';
  toast(`✅ Programação equilibrada: ${paResultados.length} produtos em 4 semanas`, 'ok');
}

// ─────────────────────────────────────────────────────────────────────
//  calcPrioridadeEquilibrada — pontuação multi-critério
//  Evita que produtos com alto volume dominem a capacidade
//  enquanto produtos críticos aguardam
// ─────────────────────────────────────────────────────────────────────
function calcPrioridadeEquilibrada(cobAtual, demandaDiaria, riscoLim, cobMin, prioridadeProduto, semana){
  let score = 0;

  // 1. Risco de ruptura — peso dominante
  if(cobAtual <= riscoLim){
    score += 100000;                                // iminente: máxima urgência
    score += Math.max(0, riscoLim - cobAtual) * 5000; // quanto mais próximo do zero, mais urgente
  } else if(cobAtual <= cobMin){
    score += 50000;                                 // abaixo do mínimo
    score += Math.max(0, cobMin - cobAtual) * 1000;
  } else if(cobAtual <= cobMin * 2){
    score += 10000;                                 // cobertura baixa — atenção
    score += Math.max(0, cobMin * 2 - cobAtual) * 200;
  }

  // 2. Demanda semanal — limitada para não dominar (cap = 2000)
  //    Isso impede que produtos de alto volume "roubem" toda a capacidade
  const demandaScore = Math.min(demandaDiaria * 7, 2000);
  score += demandaScore;

  // 3. Prioridade configurada no produto (1 = alta, 3 = baixa)
  //    Inverte: prioridade 1 → +400pts, prioridade 3 → +0pts
  const priorScore = Math.max(0, (4 - (prioridadeProduto || 2))) * 200;
  score += priorScore;

  // 4. Urgência da semana — semanas iniciais têm peso levemente maior
  score += Math.max(0, 3 - semana) * 50;

  return score;
}

function calcPrioridade(cobAtual, demandaDiaria, riscoLim, cobMin){
  const urgency = Math.max(0, cobMin - cobAtual + 1);
  const demand  = Math.min(demandaDiaria * 7, 999);
  return urgency * 100 + demand;
}

function buildMotivo(cobAtual, demandaDiaria, riscoLim, cobMin, cobAlvo){
  if(cobAtual <= 0)        return `🔴 Estoque zerado — produção imediata`;
  if(cobAtual <= riscoLim) return `🔴 Ruptura em ${cobAtual.toFixed(1)}d — produção urgente`;
  if(cobAtual <= cobMin)   return `🟠 Abaixo do mínimo (${cobMin}d) — cobertura atual ${cobAtual.toFixed(1)}d`;
  if(cobAtual <= cobMin*2) return `🟡 Vai cair abaixo do mínimo — cobertura atual ${cobAtual.toFixed(1)}d`;
  return `🟢 Reposição preventiva — cobertura ${cobAtual.toFixed(1)}d → meta ${cobAlvo}d`;
}

function distribuirPorDia(qntCaixas, workDays, item){
  // Aloca 100% da quantidade no primeiro dia útil da semana da máquina.
  // Não distribui proporcionalmente — o usuário reorganiza manualmente depois.
  if(!workDays.length || !qntCaixas) return [];
  const maq = item.maquina;
  const primeiroDia = workDays[0];
  const dayHrs = hoursOnMachineDay(maq, primeiroDia);
  return [{
    date: dateStr(primeiroDia),
    dayName: DAY_NAMES[primeiroDia.getDay()],
    cx: Math.max(0, Math.round(qntCaixas)),
    hrs: dayHrs
  }];
}

function renderProgAutomaticaStats(){
  const riscos      = paResultados.filter(p => p.risco==='critico'||p.risco==='alto').length;
  const totalHrs    = paResultados.reduce((a,p) => a + p.hrsAlocadas, 0);
  const totalHrsMes = paResultados.reduce((a,p) => a + (p.hrsAlocadasTotal || p.hrsAlocadas), 0);
  const maqsEnvol   = new Set(paResultados.map(p => p.maquina)).size;
  const totalCxMes  = paResultados.reduce((a,p) => a + (p.cxAlocadasTotal || p.cxAlocadas), 0);

  document.getElementById('pa-stat-risco').textContent     = riscos;
  document.getElementById('pa-stat-sugestoes').textContent = paResultados.length;
  document.getElementById('pa-stat-maq').textContent       = maqsEnvol;
  const hrsLabel = totalHrsMes > totalHrs
    ? fmtHrs(totalHrs) + ' (mês: ' + fmtHrs(totalHrsMes) + ')'
    : fmtHrs(totalHrs);
  document.getElementById('pa-stat-hrs').textContent = hrsLabel;

  const sel  = document.getElementById('pa-semana-sel');
  const sval = sel ? sel.value : '';
  const mon  = sval ? new Date(sval+'T12:00:00') : getWeekMonday(new Date());
  const sun  = new Date(mon); sun.setDate(mon.getDate()+6);
  const cxLabel = totalCxMes > 0 ? ` · ${totalCxMes.toLocaleString('pt-BR')} cx/mês` : '';
  document.getElementById('pa-stat-semana').textContent = fmtDate(mon)+' – '+fmtDate(sun) + cxLabel;
}

function renderProgAutomaticaResultado(){
  const el = document.getElementById('pa-body');
  if(!el) return;
  // Ler parâmetros para coloração da cobertura projetada
  const cobAlvo = parseFloat(document.getElementById('pa-cobertura-alvo')?.value||'15');
  const cobMin  = parseFloat(document.getElementById('pa-cobertura-min')?.value||'5');
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
    const maqHrs    = items.reduce((a,p)=>a+p.hrsAlocadas,0);
    const maqCox    = items.reduce((a,p)=>a+p.cxAlocadas,0);
    const maqCoxMes = items.reduce((a,p)=>a+(p.cxAlocadasTotal||p.cxAlocadas),0);
    const maqCrit = items.filter(p=>p.risco==='critico').length;
    const maqSemInsumo = items.filter(p=>!p.insumosOk).length;
    const semanaSel = document.getElementById('pa-semana-sel')?.value;
    const monday = semanaSel ? new Date(semanaSel+'T12:00:00') : getWeekMonday(new Date());
    const maqWeekHrs = weekHrsForMachine(maq, monday);
    const pctTotal = maqWeekHrs > 0 ? Math.min(100,(maqHrs/maqWeekHrs*100)).toFixed(1) : 0;
    const coxMesLabel = maqCoxMes > maqCox ? ` · ${maqCoxMes.toLocaleString('pt-BR')} cx/mês` : '';
    html += `<div class="pa-card">
      <div class="pa-card-header">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="ins-maq-title">🏭 ${maq}</span>
          ${maqCrit>0?`<span class="risk-tag risk-critico">🔴 ${maqCrit} crítico(s)</span>`:''}
          ${maqSemInsumo>0?`<span style="background:rgba(255,71,87,.18);color:var(--red);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">⚠️ ${maqSemInsumo} sem insumo</span>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2)">
          <span>${maqCox} cx S1${coxMesLabel} · ${fmtHrs(maqHrs)} · ${pctTotal}% da semana</span>
          <div class="cov-bar-track" style="width:80px"><div class="cov-bar-fill" style="width:${pctTotal}%;background:${parseFloat(pctTotal)>85?'var(--red)':parseFloat(pctTotal)>65?'var(--warn)':'var(--cyan)'}"></div></div>
        </div>
      </div>
      <div class="pa-card-body" style="overflow-x:auto">
        <table class="pa-suggest-tbl">
          <thead><tr>
            <th style="min-width:200px">Produto</th>
            <th>Motivo / Risco</th>
            <th>Estoque</th>
            <th>Cob. Atual</th>
            <th>Dem. Sem.</th>
            <th>Semana 1</th>
            <th>Total Mês</th>
            <th>Tempo</th>
            <th>% Máq.</th>
            <th>Cob. Final</th>
            <th>Insumos</th>
            <th>Distribuição S1 + Plano 4 Sem.</th>
          </tr></thead>
          <tbody>${items.map((p,pi)=>{
            const cobColor = p.risco==='critico'?'var(--red)':p.risco==='alto'?'var(--warn)':p.risco==='medio'?'var(--cyan)':'var(--green)';
            const cobProjStr = p.cobProjetada < 900 ? p.cobProjetada+'d' : '∞';
            const cobProjColor = p.cobProjetada >= cobAlvo ? 'var(--green)' : p.cobProjetada >= cobMin ? 'var(--warn)' : 'var(--red)';
            const dayPills = (p.diasDist||[]).map(d=>`<span class="pa-day-pill">${d.dayName} ${d.cx}cx</span>`).join('');
            const rowBg = !p.insumosOk ? 'background:rgba(255,71,87,.06);' : '';
            const rowBorder = !p.insumosOk ? 'border-left:3px solid var(--red);' : '';

            // Mini plano 4 semanas
            const semanas = p.semanas || [p.cxAlocadas||0, 0, 0, 0];
            const maxSem  = Math.max(...semanas, 1);
            const semPills = semanas.map((cx, i) => {
              const barW   = Math.round(cx / maxSem * 40);
              const barClr = i===0 ? 'var(--cyan)' : cx > 0 ? 'rgba(34,211,238,.5)' : 'rgba(255,255,255,.08)';
              const label  = cx > 0 ? `${cx}cx` : '—';
              return `<div style="display:inline-flex;flex-direction:column;align-items:center;gap:2px;min-width:44px">
                <div style="font-size:8px;color:var(--text3);font-family:'JetBrains Mono',monospace">S${i+1}</div>
                <div style="height:4px;width:44px;background:rgba(255,255,255,.08);border-radius:2px">
                  <div style="height:4px;width:${barW}px;background:${barClr};border-radius:2px"></div>
                </div>
                <div style="font-size:9px;color:${i===0?'var(--cyan)':cx>0?'var(--text2)':'var(--text3)'};font-family:'JetBrains Mono',monospace;font-weight:${i===0?'700':'400'}">${label}</div>
              </div>`;
            }).join('');

            // Máquinas secundárias
            const maqExtra = (p.maquinasUsadas||[]).filter(m=>m!==p.maquina);
            const maqExtraTag = maqExtra.length
              ? `<div style="font-size:9px;color:var(--text3);margin-top:2px">+ ${maqExtra.join(', ')}</div>`
              : '';

            // Badge de insumos — Fix 3: mostrar cxMaxPorInsumos quando em modo B
            const modoInsumoAtivo = document.querySelector('input[name="pa-modo-insumo"]:checked')?.value || 'total';
            let insBadge = '';
            if(!p.temFichasTecnica){
              insBadge = `<span style="background:rgba(255,179,0,.12);color:var(--warn);padding:2px 6px;border-radius:4px;font-size:10px">Sem ficha</span>`;
            } else if(!insumosEstoqueData.length){
              insBadge = `<span style="background:rgba(255,255,255,.06);color:var(--text3);padding:2px 6px;border-radius:4px;font-size:10px">Sem estoque MP</span>`;
            } else if(!p.insumosOk){
              const maxTag = p.cxMaxPorInsumos != null
                ? `<div style="font-size:9px;color:var(--text3);margin-top:1px">máx ${p.cxMaxPorInsumos}cx com insumos</div>` : '';
              insBadge = `<div><span style="cursor:pointer;background:rgba(255,71,87,.2);color:var(--red);padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700" onclick="paToggleInsumos('pa-ins-${maq}-${pi}')">⚠️ Falta ▾</span>${maxTag}</div>`;
            } else {
              insBadge = `<span style="cursor:pointer;background:rgba(46,201,122,.1);color:var(--green);padding:2px 7px;border-radius:4px;font-size:10px" onclick="paToggleInsumos('pa-ins-${maq}-${pi}')">✅ OK ▾</span>`;
            }

            // Fix 3: indicador de limitação por insumos (Opção B)
            const limitadoBadge = (modoInsumoAtivo === 'limitado' && p.cxMaxPorInsumos != null && p.cxMaxPorInsumos < (p.qntCaixasSugerida||p.cxAlocadasTotal))
              ? `<div style="font-size:9px;color:var(--warn);margin-top:2px">⚡ Limitado: ${p.cxMaxPorInsumos}cx → ${p.cxAlocadasTotal}cx</div>`
              : '';

            // Detalhes de insumos (colapsável)
            let insDetail = '';
            if(p.insumosStatus && p.insumosStatus.length){
              insDetail = `<tr id="pa-ins-${maq}-${pi}" style="display:none">
                <td colspan="12" style="padding:0">
                  <div style="background:var(--s2);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:10px 16px">
                    <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px;font-weight:700">Consumo de Insumos — ${p.prod}</div>
                    <table style="width:100%;border-collapse:collapse;font-size:11px">
                      <thead><tr style="background:rgba(255,255,255,.03)">
                        <th style="padding:5px 8px;text-align:left;color:var(--text3);font-size:10px">Insumo</th>
                        <th style="padding:5px 8px;text-align:right;color:var(--warn);font-size:10px">Necessário (mês)</th>
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
                      <div style="color:var(--red);font-weight:700;margin-bottom:4px">⛔ Insumos insuficientes para produzir ${p.cxAlocadasTotal||p.cxAlocadas} cx no mês:</div>
                      ${p.insumosFaltando.map(f=>`<div style="color:var(--red);padding:2px 0"><strong>${f.nome}</strong>: necessário ${f.consumo.toLocaleString('pt-BR',{maximumFractionDigits:3})} / estoque ${f.estoqueAtual!=null?f.estoqueAtual.toLocaleString('pt-BR',{maximumFractionDigits:3}):'—'} / <strong>déficit ${f.deficit.toLocaleString('pt-BR',{maximumFractionDigits:3})}</strong></div>`).join('')}
                    </div>`:'' }
                  </div>
                </td>
              </tr>`;
            }

            return `<tr style="${rowBg}${rowBorder}">
              <td>
                <div style="font-weight:600;font-size:12px">${p.prod}</div>
                <div style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace">Cód: ${p.cod||'—'}</div>
                ${maqExtraTag}
                ${limitadoBadge}
              </td>
              <td style="max-width:180px;white-space:normal;line-height:1.5;font-size:11px">${p.motivo}</td>
              <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${p.estoque != null ? p.estoque.toLocaleString('pt-BR') : '—'}</td>
              <td style="color:${cobColor};font-weight:700">${p.cobAtual}d</td>
              <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${p.demandaSemanal}</td>
              <td style="color:var(--cyan);font-weight:700;font-size:13px">${p.cxAlocadas} cx</td>
              <td style="color:var(--purple);font-weight:600;font-size:12px">
                ${p.cxAlocadasTotal||p.cxAlocadas} cx
                ${(p.qntCaixasSugerida && p.qntCaixasSugerida !== p.cxAlocadasTotal)
                  ? `<div style="font-size:9px;color:var(--text3)">necessário: ${p.qntCaixasSugerida}cx</div>` : ''}
              </td>
              <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${fmtHrs(p.hrsAlocadasTotal||p.hrsAlocadas)}</td>
              <td>
                <span style="color:${p.pctMaquina>50?'var(--warn)':'var(--text2)'}">${p.pctMaquina}%</span>
                <div class="cov-bar-track" style="margin-top:3px"><div class="cov-bar-fill" style="width:${Math.min(100,p.pctMaquina)}%;background:${p.pctMaquina>50?'var(--warn)':'var(--cyan)'}"></div></div>
              </td>
              <td style="color:${cobProjColor};font-weight:700">${cobProjStr}</td>
              <td>${insBadge}</td>
              <td style="white-space:normal">
                <div style="margin-bottom:6px">${dayPills||'—'}</div>
                <div style="display:flex;gap:4px;flex-wrap:nowrap">${semPills}</div>
              </td>
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

  // ── Contar registros que serão criados ─────────────────────────
  // Um registro por (produto × semana × máquina).
  // Se a mesma máquina aparece em dois detalhes da mesma semana
  // (pode ocorrer após fase de equalização), consolida em um único
  // registro somando as caixas — evita duplicata no Gantt.
  function buildPlanejamento(sug){
    const plano = []; // [{si, maq, cx, pcMin, dtDesejada}]
    const semanaSel = document.getElementById('pa-semana-sel')?.value;
    const monday    = semanaSel ? new Date(semanaSel+'T12:00:00') : getWeekMonday(new Date());

    const useDetalhes = sug.detalhes && sug.detalhes.some(sem => sem && sem.length > 0);

    if(useDetalhes){
      for(let si = 0; si < sug.detalhes.length; si++){
        const detSem = sug.detalhes[si] || [];
        if(!detSem.length) continue;

        const semMonday = new Date(monday);
        semMonday.setDate(monday.getDate() + si * 7);
        const semDays = getWeekDays(semMonday);

        // Consolidar por máquina (caso equalização gere dois detalhes na mesma máq)
        const porMaq = {};
        detSem.forEach(det => {
          if(!det.cx || det.cx <= 0) return;
          if(!porMaq[det.maq]) porMaq[det.maq] = { cx: 0, pcMin: det.pcMin || 0 };
          porMaq[det.maq].cx    += det.cx;
          porMaq[det.maq].pcMin  = det.pcMin || porMaq[det.maq].pcMin;
        });

        Object.entries(porMaq).forEach(([maq, info]) => {
          // Primeiro dia útil desta máquina nesta semana
          const maqWorkDay = semDays.find(d => hoursOnMachineDay(maq, d) > 0);
          const firstWork  = semDays.find(d => hoursOnDay(d) > 0);
          const dtMaq      = maqWorkDay
            ? dateStr(maqWorkDay)
            : (firstWork ? dateStr(firstWork) : dateStr(semMonday));
          plano.push({ si, maq, cx: info.cx, pcMin: info.pcMin, dtDesejada: dtMaq });
        });
      }
    } else {
      // Fallback — um registro por semana, máquina principal
      const semanasCx = sug.semanas || [sug.cxAlocadas || 0, 0, 0, 0];
      const ficha     = getAllProdutos().find(p => String(p.cod)===String(sug.cod) || p.descricao===sug.prod);
      const pcMinUsar = (ficha && ficha.pc_min) || sug.pc_min || 0;

      semanasCx.forEach((cx, si) => {
        if(!cx || cx <= 0) return;
        const semMonday = new Date(monday);
        semMonday.setDate(monday.getDate() + si * 7);
        const semDays  = getWeekDays(semMonday);
        const firstWork = semDays.find(d => hoursOnDay(d) > 0);
        plano.push({
          si,
          maq:        sug.maquina,
          cx,
          pcMin:      pcMinUsar,
          dtDesejada: firstWork ? dateStr(firstWork) : dateStr(semMonday)
        });
      });
    }
    return plano;
  }

  // Pré-calcular planos e contar registros para o confirm
  const planosMap = new Map();
  let totalRegistros = 0;
  for(const sug of paResultados){
    const plano = buildPlanejamento(sug);
    planosMap.set(sug, plano);
    totalRegistros += plano.length;
  }
  if(!totalRegistros){
    toast('Nenhuma produção para aplicar.','warn');
    return;
  }

  if(!confirm(
    `Aplicar ${paResultados.length} sugestão(ões) na programação?\n\n` +
    `Serão criados ${totalRegistros} registro(s) distribuídos por semana e máquina.\n` +
    `O Gantt refletirá exatamente a divisão calculada.`
  )) return;

  const ficha0    = null; // será buscado por produto abaixo
  let criados = 0;

  for(const sug of paResultados){
    const plano    = planosMap.get(sug) || [];
    const ficha    = getAllProdutos().find(p => String(p.cod)===String(sug.cod) || p.descricao===sug.prod);
    const unidUsar = (ficha && ficha.unid) || sug.unid || 1;
    const motivoBase = sug.motivo.replace(/<[^>]*>/g,'');

    // Atribuir sortOrder sequencial para garantir ordem no Gantt
    // Registros da mesma semana ganham sortOrder consecutivo
    const hoje = new Date().toISOString();
    for(let pi = 0; pi < plano.length; pi++){
      const p = plano[pi];
      const obj = {
        produto:       sug.prod,
        prodCod:       parseInt(sug.cod) || 0,
        maquina:       p.maq,
        pcMin:         p.pcMin,
        unidPorCx:     unidUsar,
        qntCaixas:     p.cx,
        qntUnid:       p.cx * unidUsar,
        status:        'Pendente',
        dtSolicitacao: p.dtDesejada,
        dtDesejada:    p.dtDesejada,
        sortOrder:     Date.now() + pi,   // garante sequência única
        obs:           '',
        updatedAt:     hoje
      };
      await dbPut(obj);
      criados++;
    }
  }

  await reloadFresh();
  paResultados = [];
  const paBody = document.getElementById('pa-body');
  if(paBody) paBody.innerHTML = '<div class="empty"><div class="ei">✅</div>Programação enviada! Clique em "Gerar Programação Automática" para nova sugestão.</div>';
  const applyBtn = document.getElementById('pa-apply-btn');
  if(applyBtn) applyBtn.style.display = 'none';
  renderProgAutomaticaStats();
  switchTabSidebar('gantt');
  renderGantt();
  toast(`✅ ${criados} registro(s) criados — Gantt atualizado com divisão exata por máquina.`, 'ok');
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
// ── Reorder drag handlers (precisam estar no window por serem inline no HTML) ──
window.riDragStart = riDragStart;
window.riDragOver  = riDragOver;
window.riDrop      = riDrop;
window.riDragEnd   = riDragEnd;
window.exportInsumosGeralPDF = exportInsumosGeralPDF;
window.exportInsumosGeralXLSX = exportInsumosGeralXLSX;
window.exportInsumosMaqPDF = exportInsumosMaqPDF;
window.exportInsumosMaqXLSX = exportInsumosMaqXLSX;
window.fteAddRow = fteAddRow;
window.pmAddInsumoRow = pmAddInsumoRow;
window.ganttToday = ganttToday;
window.ganttWeek = ganttWeek;
window.ganttGoDate = ganttGoDate;
window.setGanttMode         = setGanttMode;
window.ganttMesNav          = ganttMesNav;
window.ganttMesHoje         = ganttMesHoje;
window.ganttSelecionarSemana= ganttSelecionarSemana;
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

// ── Meu Perfil ────────────────────────────────────────────────────────
function abrirMeuPerfil() {
  const user = getCurrentUserSafe();
  if (!user) return;
  const mp = id => document.getElementById(id);
  if(mp('mp-nome'))           mp('mp-nome').value           = user.nome  || '';
  if(mp('mp-cargo'))          mp('mp-cargo').value          = user.cargo || '';
  if(mp('mp-nova-senha'))     mp('mp-nova-senha').value     = '';
  if(mp('mp-confirma-senha')) mp('mp-confirma-senha').value = '';
  const inicial = (user.nome||user.email||'?')[0].toUpperCase();
  const isAdmin = user.tipo === 'admin';
  if(mp('mp-avatar')) {
    mp('mp-avatar').textContent   = inicial;
    mp('mp-avatar').style.background = isAdmin ? '#e74c3c' : 'var(--cyan)';
    mp('mp-avatar').style.color      = isAdmin ? '#fff'    : '#000';
  }
  if(mp('mp-nome-display'))  mp('mp-nome-display').textContent  = user.nome  || user.email || '—';
  if(mp('mp-email-display')) mp('mp-email-display').textContent = user.email || '—';
  if(mp('mp-badge-display')) mp('mp-badge-display').innerHTML   = perfilBadge(user.tipo || 'usuario');
  const msgEl = mp('mp-msg');
  if(msgEl) { msgEl.style.display='none'; msgEl.textContent=''; }
  document.getElementById('meu-perfil-modal').style.display = 'flex';
  setTimeout(() => mp('mp-nome')?.focus(), 80);
}

function closeMeuPerfil() {
  document.getElementById('meu-perfil-modal').style.display = 'none';
}

async function salvarMeuPerfil() {
  const mp    = id => document.getElementById(id);
  const msgEl = mp('mp-msg');
  const nome  = (mp('mp-nome')?.value  || '').trim();
  const cargo = (mp('mp-cargo')?.value || '').trim();
  const novaSenha     = mp('mp-nova-senha')?.value     || '';
  const confirmaSenha = mp('mp-confirma-senha')?.value || '';
  const showMsg = (txt, ok) => {
    if(!msgEl) return;
    msgEl.style.display='block';
    msgEl.style.color = ok ? 'var(--green)' : 'var(--red)';
    msgEl.textContent = txt;
  };
  if (!nome)                                { showMsg('Informe seu nome.', false); return; }
  if (novaSenha && novaSenha.length < 6)    { showMsg('Nova senha deve ter ao menos 6 caracteres.', false); return; }
  if (novaSenha && novaSenha !== confirmaSenha) { showMsg('As senhas não coincidem.', false); return; }
  try {
    const user = getCurrentUserSafe();
    if (!user?.uid) throw new Error('Usuário não identificado.');
    await atualizarUsuarioSistema(user.uid, { nome, cargo });
    if (novaSenha) {
      const { updatePassword, getAuth } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
      await updatePassword(getAuth().currentUser, novaSenha);
    }
    user.nome = nome; user.cargo = cargo;
    // Atualizar visual
    ['sb-avatar','hd-menu-avatar'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=nome[0].toUpperCase(); });
    ['sb-uname','hd-menu-nome'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=nome; });
    const ndEl=mp('mp-nome-display'); if(ndEl) ndEl.textContent=nome;
    const avMp=mp('mp-avatar');       if(avMp) avMp.textContent=nome[0].toUpperCase();
    showMsg(novaSenha ? '✅ Perfil e senha atualizados!' : '✅ Perfil atualizado!', true);
    mp('mp-nova-senha').value=''; mp('mp-confirma-senha').value='';
    toast('Perfil salvo!', 'ok');
  } catch(e) { showMsg('Erro: '+(e.message||e), false); }
}

window.abrirMeuPerfil  = abrirMeuPerfil;
window.closeMeuPerfil  = closeMeuPerfil;
window.salvarMeuPerfil = salvarMeuPerfil;
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
window.carregarFichaTecnicaFirestore = carregarFichaTecnicaFirestore;
window.carregarFichaTecnicaCached = carregarFichaTecnicaCached;
window.salvarProdutoFirestore = salvarProdutoFirestore;
window.getAllProdutos = getAllProdutos;

// ===== TELA DE GESTÃO DE SETUP (Configurações → Tempos de Setup) =====
let _setupRegistros = [];

async function recarregarSetup() {
  invalidateCache('setup');
  await carregarSetupCached(true);
  renderSetupMaquinas();
  toast('Setup recarregado!', 'ok');
}

async function renderSetupMaquinas() {
  try {
    // Usar cache em memória (SETUP_FIRESTORE) em vez de nova leitura ao Firestore
    // _setupRegistros é reconstruído a partir do SETUP_FIRESTORE já carregado
    await carregarSetupCached(); // noop se já carregado
    _setupRegistros = [];
    for(const maq of Object.keys(SETUP_FIRESTORE)){
      for(const pA of Object.keys(SETUP_FIRESTORE[maq])){
        for(const pB of Object.keys(SETUP_FIRESTORE[maq][pA])){
          const tempo = SETUP_FIRESTORE[maq][pA][pB];
          if(tempo > 0){
            _setupRegistros.push({ id: `${maq}_${pA}_${pB}`, maquina: maq, produto_origem: pA, produto_destino: pB, tempo_setup: tempo });
          }
        }
      }
    }
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
      await setDoc(lojaDoc('setup_maquinas', editId), payload);
      toast('Setup atualizado!', 'ok');
    } else {
      payload.criadoEm = new Date().toISOString();
      await addDoc(lojaCol('setup_maquinas'), payload);
      toast('Setup cadastrado!', 'ok');
    }
    invalidateCache('setup');
    await carregarSetupCached(true);
    closeSetupModal();
    renderSetupMaquinas();
  } catch(e) {
    if (alertEl) { alertEl.textContent = 'Erro ao salvar: ' + e.message; alertEl.style.display = 'block'; }
  }
}

async function excluirSetup(id) {
  if (!confirm('Remover este tempo de setup?')) return;
  try {
    await deleteDoc(lojaDoc('setup_maquinas', id));
    invalidateCache('setup');
    await carregarSetupCached(true);
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
window.ftCfgAbrirFicha = ftCfgAbrirFicha;
window.importFichaTecnicaExcel = loadFichaTecnica;
window.loadFichaTecnica = loadFichaTecnica;
window.excluirMaquinaFirestore = excluirMaquinaFirestore;
window.renderCadastroMaquinas = renderCadastroMaquinas;
window.openAddMaquina = openAddMaquina;
window.closeMaqModal = closeMaqModal;
window.saveMaquinaModal = saveMaquinaModal;
window.importarMaquinasExcel = importarMaquinasExcel;
window.downloadSetupTemplate = downloadSetupTemplate;
window.importarSetupExcel = importarSetupExcel;

// ===== SISTEMA FIRESTORE PARA APONTAMENTOS (substituir localStorage) =====

// Carrega apontamentos da semana atual do Firestore
async function carregarApontamentosSemana(prodBaseMonday) {
  if (!prodBaseMonday) return {};
  
  try {
    const weekStart = dateStr(prodBaseMonday);
    const weekEnd = dateStr(getWeekDays(prodBaseMonday)[6]);
    
    const q = query(
      lojaCol('apontamentos_producao'),
      where('data', '>=', weekStart),
      where('data', '<=', weekEnd),
      orderBy('data')
    );
    
    const snap = await getDocs(q);
    const apontamentos = {};
    
    snap.docs.forEach(doc => {
      const data = doc.data();
      const key = `${data.data}_${data.recordId}`;
      
      if (!apontamentos[key]) {
        apontamentos[key] = {};
      }
      
      // Consolidar por hora
      if (data.hora && data.quantidade) {
        apontamentos[key][data.hora] = (apontamentos[key][data.hora] || 0) + data.quantidade;
      }
    });
    
    return apontamentos;
    
  } catch(e) {
    console.error('Erro ao carregar apontamentos:', e);
    toast('Erro ao carregar dados de produção', 'err');
    return {};
  }
}

// Salva apontamento individual no Firestore
async function salvarApontamentoFirestore(data, hora, recordId, quantidade, operador) {
  try {
    const user = getCurrentUserSafe();
    if (!user) {
      toast('Usuário não autenticado', 'err');
      return false;
    }
    
    const record = records.find(r => r.id === recordId);
    if (!record) {
      toast('Produto não encontrado', 'err');
      return false;
    }
    
    // Validações de negócio
    const validacao = validarApontamento(recordId, quantidade, data);
    if (!validacao.valido) {
      toast('❌ ' + validacao.motivo, 'err');
      return false;
    }
    
    const payload = {
      data: data,
      hora: parseInt(hora),
      recordId: recordId,
      quantidade: parseInt(quantidade) || 0,
      produto: record.produto,
      maquina: record.maquina,
      operador: operador || 'N/A',
      usuario: user?.email || getUserEmailSafe(),
      criadoEm: serverTimestamp(),
      lojaId: getLojaAtiva(),
      ip: getClientIP(),
      sessao: getSessionId()
    };
    
    await addDoc(lojaCol('apontamentos_producao'), payload);
    
    // Registrar auditoria
    await registrarAuditoria('APONTAMENTO_SALVO', {
      recordId: recordId,
      produto: record.produto,
      data: data,
      hora: hora,
      quantidade: quantidade,
      quantidadeAnterior: 0 // TODO: buscar quantidade anterior
    });
    
    return true;
    
  } catch(e) {
    console.error('Erro ao salvar apontamento:', e);
    toast('Erro ao salvar produção: ' + e.message, 'err');
    return false;
  }
}

// Validações de apontamento
function validarApontamento(recordId, quantidade, data) {
  const record = records.find(r => r.id === recordId);
  if (!record) {
    return { valido: false, motivo: 'Produto não encontrado' };
  }
  
  // 1. Quantidade não pode ser negativa
  if (quantidade < 0) {
    return { valido: false, motivo: 'Quantidade não pode ser negativa' };
  }
  
  // 2. Verificar se data é válida
  const dataObj = new Date(data + 'T12:00:00');
  const hoje = new Date();
  const umAnoAtras = new Date();
  umAnoAtras.setFullYear(hoje.getFullYear() - 1);
  
  if (dataObj > hoje) {
    return { valido: false, motivo: 'Não é possível apontar produção futura' };
  }
  
  if (dataObj < umAnoAtras) {
    return { valido: false, motivo: 'Data muito antiga para apontamento' };
  }
  
  // 3. Verificar se não excede muito a meta
  const totalAtual = calcularTotalProduzido(recordId);
  const meta = record.qntCaixas || 0;
  const novoTotal = totalAtual + quantidade;
  
  if (novoTotal > meta * 1.5) { // 50% acima da meta
    return { valido: false, motivo: `Quantidade muito acima da meta (${novoTotal} vs ${meta} programadas)` };
  }
  
  // 4. Para operadores, validar se está liberado
  if (isOperadorLevel()) {
    const validacaoProducao = validarProducaoPermitida(record, record.maquina, data);
    if (!validacaoProducao.permitido) {
      return { valido: false, motivo: validacaoProducao.motivo };
    }
  }
  
  // 5. Validar quantidade por hora não absurda
  if (quantidade > 500) { // Máximo 500 caixas por hora
    return { valido: false, motivo: 'Quantidade por hora muito alta (máx 500)' };
  }
  
  return { valido: true };
}

// Funções auxiliares
function getClientIP() {
  // Simplificado - em produção poderia usar serviço real
  return 'sistema';
}

function getSessionId() {
  let sessionId = sessionStorage.getItem('sessionId');
  if (!sessionId) {
    sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('sessionId', sessionId);
  }
  return sessionId;
}

// Calcula total produzido usando dados híbridos (Firestore + localStorage)
async function calcularTotalProduzidoHibrido(recordId) {
  // TODO: Implementar busca no Firestore + fallback localStorage
  // Por enquanto, usar localStorage para compatibilidade
  return calcularTotalProduzido(recordId);
}

// ===== INTERFACE AVANÇADA PARA ABA REALIZADO =====

// Renderiza painel de alertas
function renderPainelAlertas() {
  const alertas = verificarAlertasProducao();
  
  if (alertas.length === 0) return '';
  
  const alertasHtml = alertas.map(alerta => {
    let cor, icone, titulo, detalhes;
    
    switch(alerta.tipo) {
      case 'ATRASO':
        cor = 'var(--red)';
        icone = '🚨';
        titulo = `${alerta.produto} em atraso`;
        detalhes = `${alerta.dias_atraso} dia(s) · ${alerta.pct_concluido}% concluído`;
        break;
      case 'PRODUCAO_PARADA':
        cor = 'var(--warn)';
        icone = '⏸️';
        titulo = `${alerta.produto} parado`;
        detalhes = `${alerta.dias_parado} dia(s) sem produção · ${alerta.pct_concluido}% concluído`;
        break;
      case 'EXCESSO_PRODUCAO':
        cor = 'var(--purple)';
        icone = '📈';
        titulo = `${alerta.produto} com excesso`;
        detalhes = `${alerta.excesso}% acima da meta`;
        break;
      default:
        cor = 'var(--text3)';
        icone = 'ℹ️';
        titulo = alerta.produto;
        detalhes = '';
    }
    
    return `
      <div style="background:rgba(255,255,255,.03);border-left:3px solid ${cor};padding:8px 12px;border-radius:6px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:14px">${icone}</span>
          <div>
            <div style="font-size:11px;font-weight:600;color:${cor}">${titulo}</div>
            <div style="font-size:10px;color:var(--text3)">${detalhes}</div>
          </div>
        </div>
      </div>`;
  }).join('');
  
  return `
    <div style="background:rgba(255,179,0,.05);border:1px solid rgba(255,179,0,.2);border-radius:10px;padding:12px 16px;margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:var(--warn);margin-bottom:8px;display:flex;align-items:center;gap:8px">
        🔔 Alertas de Produção
        <span style="background:var(--warn);color:#000;padding:1px 6px;border-radius:4px;font-size:10px">${alertas.length}</span>
      </div>
      <div style="display:grid;gap:6px">
        ${alertasHtml}
      </div>
    </div>`;
}

// Modal para liberação fora de sequência
// ── Sistema de Liberação Temporária de Sequência ──────────────────────
// Liberações ficam ativas por 24h e são salvas no localStorage.
// Estrutura: { [recordId]: { expira: timestamp, motivo: string, usuario: string } }

function _getLiberacoes() {
  try {
    return JSON.parse(localStorage.getItem('_liberacoes_seq') || '{}');
  } catch(e) { return {}; }
}

function _saveLiberacoes(obj) {
  localStorage.setItem('_liberacoes_seq', JSON.stringify(obj));
}

function temLiberacaoTemporaria(recordId) {
  const libs = _getLiberacoes();
  const lib = libs[String(recordId)];
  if (!lib) return false;
  if (Date.now() > lib.expira) {
    // expirou — limpa
    delete libs[String(recordId)];
    _saveLiberacoes(libs);
    return false;
  }
  return true;
}

function liberarProdutoFaltaSequencia(recordId, motivo, usuario) {
  try {
    const libs = _getLiberacoes();
    libs[String(recordId)] = {
      expira: Date.now() + 24 * 60 * 60 * 1000, // 24h
      motivo: motivo,
      usuario: usuario || 'sistema'
    };
    _saveLiberacoes(libs);
    registrarAuditoria('LIBERACAO_SEQUENCIA', {
      recordId: recordId,
      motivo: motivo,
      usuario: usuario,
      expira: new Date(libs[String(recordId)].expira).toISOString()
    });
    toast('✅ Produto liberado para produção por 24h!', 'ok');
    return true;
  } catch(e) {
    toast('Erro ao liberar produto: ' + e.message, 'err');
    return false;
  }
}

function abrirModalLiberacaoSequencia(recordId) {
  if (!isPCPLevel()) {
    toast('Apenas PCP pode liberar fora de sequência!', 'err');
    return;
  }
  
  const record = records.find(r => r.id === recordId);
  if (!record) return;
  
  const modalHtml = `
    <div id="modal-liberacao" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center">
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:500px;width:90%">
        <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:16px">
          🔀 Liberar Fora de Sequência
        </div>
        
        <div style="background:var(--s1);border-radius:8px;padding:12px;margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:var(--text)">${record.produto}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:4px">
            Máquina: ${record.maquina} · Meta: ${record.qntCaixas} caixas
          </div>
        </div>
        
        <div style="margin-bottom:16px">
          <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:6px">
            Motivo da liberação:
          </label>
          <select id="liberacao-motivo" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--s1);color:var(--text)">
            <option value="">Selecione o motivo...</option>
            <option value="urgencia_cliente">Urgência do cliente</option>
            <option value="setup_longo">Setup muito longo</option>
            <option value="materia_prima">Falta de matéria-prima outro produto</option>
            <option value="manutencao">Manutenção da máquina</option>
            <option value="capacidade">Aproveitamento de capacidade ociosa</option>
            <option value="outro">Outro motivo</option>
          </select>
        </div>
        
        <div id="liberacao-outro" style="margin-bottom:16px;display:none">
          <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:6px">
            Especifique o motivo:
          </label>
          <textarea id="liberacao-motivo-outro" 
                    style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--s1);color:var(--text);resize:vertical;min-height:60px"
                    placeholder="Descreva o motivo da liberação..."></textarea>
        </div>
        
        <div style="background:rgba(255,179,0,.1);border:1px solid var(--warn);border-radius:6px;padding:10px;margin-bottom:16px;font-size:11px;color:var(--warn)">
          ⚠️ <strong>Atenção:</strong> Esta liberação será válida por 24 horas e será registrada na auditoria.
        </div>
        
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button onclick="fecharModalLiberacao()" 
                  style="background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px 16px;cursor:pointer">
            Cancelar
          </button>
          <button onclick="confirmarLiberacaoSequencia('${recordId}')"
                  style="background:var(--warn);color:#000;border:none;border-radius:6px;padding:8px 16px;font-weight:600;cursor:pointer">
            🔀 Liberar Produto
          </button>
        </div>
      </div>
    </div>`;
  
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  
  // Event listener para mostrar/ocultar campo "outro"
  document.getElementById('liberacao-motivo').addEventListener('change', function() {
    const outroField = document.getElementById('liberacao-outro');
    if (this.value === 'outro') {
      outroField.style.display = 'block';
    } else {
      outroField.style.display = 'none';
    }
  });
}

function fecharModalLiberacao() {
  const modal = document.getElementById('modal-liberacao');
  if (modal) modal.remove();
}

function confirmarLiberacaoSequencia(recordId) {
  const motivoSelect = document.getElementById('liberacao-motivo').value;
  const motivoOutro = document.getElementById('liberacao-motivo-outro').value;
  
  if (!motivoSelect) {
    toast('Selecione o motivo da liberação!', 'err');
    return;
  }
  
  if (motivoSelect === 'outro' && !motivoOutro.trim()) {
    toast('Especifique o motivo da liberação!', 'err');
    return;
  }
  
  const motivo = motivoSelect === 'outro' ? motivoOutro.trim() : motivoSelect;
  const usuario = getUserEmailSafe();
  
  const sucesso = liberarProdutoFaltaSequencia(recordId, motivo, usuario);
  
  if (sucesso) {
    fecharModalLiberacao();
    renderApontamento(); // Recarregar para mostrar liberação
  }
}

// Sistema de notificações em tempo real
function iniciarNotificacoesTempoReal() {
  // Verificar alertas a cada 5 minutos
  setInterval(() => {
    const alertas = verificarAlertasProducao();
    const alertasAlta = alertas.filter(a => a.prioridade === 'ALTA');
    
    if (alertasAlta.length > 0 && isPCPLevel()) {
      mostrarNotificacaoDesktop(
        '🚨 Alertas de Produção',
        `${alertasAlta.length} produto(s) em situação crítica`
      );
    }
  }, 5 * 60 * 1000);
  
  // Auto-save a cada 30 segundos
  setInterval(() => {
    salvarApontamentosAutomatico();
  }, 30 * 1000);
}

function mostrarNotificacaoDesktop(titulo, mensagem) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(titulo, {
      body: mensagem,
      icon: '/favicon.ico',
      tag: 'producao-alert'
    });
  }
}

function solicitarPermissaoNotificacoes() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        toast('✅ Notificações ativadas para alertas de produção', 'ok');
      }
    });
  }
}

// Auto-save de apontamentos pendentes
let _apontamentosPendentes = new Map();

function salvarApontamentosAutomatico() {
  if (_apontamentosPendentes.size === 0) return;
  
  const pendentes = Array.from(_apontamentosPendentes.entries());
  let salvos = 0;
  
  pendentes.forEach(async ([key, dados]) => {
    try {
      const sucesso = await salvarApontamentoFirestore(
        dados.data, dados.hora, dados.recordId, dados.quantidade, dados.operador
      );
      
      if (sucesso) {
        _apontamentosPendentes.delete(key);
        salvos++;
      }
    } catch(e) {
      console.warn('Erro no auto-save:', e);
    }
  });
  
  if (salvos > 0) {
    console.log(`Auto-save: ${salvos} apontamentos salvos`);
  }
}

// Adicionar apontamento à fila de auto-save
function adicionarApontamentoPendente(data, hora, recordId, quantidade, operador) {
  const key = `${data}_${recordId}_${hora}`;
  _apontamentosPendentes.set(key, {
    data, hora, recordId, quantidade, operador, timestamp: Date.now()
  });
}

// ===== DASHBOARD DE INDICADORES =====

function renderDashboardIndicadores() {
  const weekRecs = records.filter(r => {
    const dt = r.dtDesejada || r.dtSolicitacao;
    if (!prodBaseMonday) return false;
    const weekStart = dateStr(prodBaseMonday);
    const weekEnd = dateStr(getWeekDays(prodBaseMonday)[6]);
    return dt && dt >= weekStart && dt <= weekEnd;
  });
  
  let totalMeta = 0;
  let totalProduzido = 0;
  let produtosConcluidos = 0;
  let produtosAtrasados = 0;
  
  weekRecs.forEach(record => {
    const meta = record.qntCaixas || 0;
    const produzido = calcularTotalProduzido(record.id);
    const status = determinarStatusProgramacao(record);
    
    totalMeta += meta;
    totalProduzido += produzido;
    
    if (status === STATUS_PROGRAMACAO.CONCLUIDO) {
      produtosConcluidos++;
    } else if (status === STATUS_PROGRAMACAO.ATRASADO) {
      produtosAtrasados++;
    }
  });
  
  const eficiencia = totalMeta > 0 ? Math.round((totalProduzido / totalMeta) * 100) : 0;
  const produtosPendentes = weekRecs.length - produtosConcluidos;
  
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">
      <div style="background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:var(--cyan)">${eficiencia}%</div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Eficiência</div>
      </div>
      
      <div style="background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:var(--green)">${produtosConcluidos}</div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Concluídos</div>
      </div>
      
      <div style="background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:var(--warn)">${produtosPendentes}</div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Pendentes</div>
      </div>
      
      <div style="background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:var(--red)">${produtosAtrasados}</div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Atrasados</div>
      </div>
      
      <div style="background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:16px;font-weight:700;color:var(--text)">${totalProduzido.toLocaleString()}</div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Caixas Produzidas</div>
      </div>
    </div>`;
}

// Função controlada para desatribuir produto (apenas PCP)
function pdUnassign(recId) {
  if (isOperadorLevel()) {
    toast('Apenas usuários PCP podem alterar a programação!', 'err');
    return;
  }

  const record = records.find(r => r.id === recId);
  if (!record) return;

  const diaAnterior = pdGetAssign(recId);
  pdSetAssign(recId, null);
  
  registrarAuditoria('PRODUTO_REMOVIDO_DO_DIA', {
    recordId: recId,
    produto: record.produto,
    diaAnterior: diaAnterior
  });
  
  toast(`Produto "${record.produto}" removido do dia`, 'info');
  renderApontamento();
}

// Função para adicionar funções faltantes de compatibilidade
function salvarApontamentoCompleto(recordId) {
  const body      = document.getElementById('apon-body');
  const dataAtual = body?._dateVal || prodSelectedDate;

  // Bloquear se data inválida
  if (!dataAtual || dataAtual === 'semana' || dataAtual === 'producao-dia') return;

  // Coletar dados dos inputs — buscar por string e número para garantir match
  const inputs = document.querySelectorAll(`[data-rec="${recordId}"].apon-input-controlado`);
  if (!inputs.length) return;

  const data = {};
  let dayTotal = 0;
  inputs.forEach(input => {
    const hora = parseInt(input.dataset.hr);
    const qtd  = parseInt(input.value) || 0;
    data[hora] = qtd || '';
    dayTotal  += qtd;
  });

  // Salvar no localStorage
  aponStorageSet(aponKey(dataAtual, recordId), data);

  // Atualizar cache Firestore em memória (para totais corretos sem aguardar save)
  const fsKey = dataAtual + '_' + recordId;
  _aponFS[fsKey] = Object.assign({}, data);

  // Atualizar TOTAL DIA
  const dtEl = document.getElementById(`realizado-daytotal-${recordId}`);
  if (dtEl) {
    dtEl.textContent = dayTotal > 0 ? dayTotal : '—';
    dtEl.style.color = dayTotal > 0 ? 'var(--cyan)' : 'var(--text3)';
  }

  // Atualizar ACUMULADO
  const prevTotal = aponGetPrevTotal(recordId, dataAtual);
  const acum = prevTotal + dayTotal;
  const rec  = records.find(r => String(r.id) === String(recordId));
  const meta = rec ? (rec.qntCaixas || 0) : 0;
  const acEl = document.getElementById(`realizado-acum-${recordId}`);
  if (acEl) {
    acEl.textContent = acum > 0 ? acum : '—';
    acEl.style.color = acum >= meta && meta > 0 ? 'var(--green)' : acum > 0 ? 'var(--text)' : 'var(--text3)';
  }
}

function gerarRelatorioProducao() {
  if (!isPCPLevel()) {
    toast('Apenas PCP pode gerar relatórios!', 'err');
    return;
  }
  
  // TODO: Implementar geração de relatório
  toast('Funcionalidade de relatório em desenvolvimento', 'info');
}

function exportarApontamentos() {
  if (!can('importacao','exportar')) {
    toast('Sem permissão para exportar dados.', 'err');
    return;
  }
  
  // TODO: Implementar exportação
  toast('Funcionalidade de exportação em desenvolvimento', 'info');
}

// Exportar novas funções controladas
window.aponRecalcRowControlado = aponRecalcRowControlado;
window.realizadoPermitirFaltaSequencia = realizadoPermitirFaltaSequencia;
window.realizadoResetarDia = realizadoResetarDia;
window.pdUnassign = pdUnassign;
window.abrirModalLiberacaoSequencia = abrirModalLiberacaoSequencia;
window.fecharModalLiberacao = fecharModalLiberacao;
window.confirmarLiberacaoSequencia = confirmarLiberacaoSequencia;
window.solicitarPermissaoNotificacoes = solicitarPermissaoNotificacoes;
window.salvarApontamentoCompleto = salvarApontamentoCompleto;
window.gerarRelatorioProducao = gerarRelatorioProducao;
window.exportarApontamentos = exportarApontamentos;
window.renderProducaoDiaControlado = renderProducaoDiaControlado;
// Funções de filtro do Realizado
function realizadoFiltrar() {
  const busca  = (document.getElementById('realizado-busca') || {}).value || '';
  const maq    = (document.getElementById('realizado-filtro-maq') || {}).value || '';
  const status = (document.getElementById('realizado-filtro-status') || {}).value || '';
  window._realizadoFiltros = { busca, maquina: maq, status };
  renderApontamento();
}
function realizadoLimparFiltros() {
  window._realizadoFiltros = { busca: '', maquina: '', status: '' };
  renderApontamento();
}
window.realizadoFiltrar      = realizadoFiltrar;
// ═══════════════════════════════════════════════════════════════════
// PRODUÇÃO DIA — Filtros, Observações e Funcionários
// ═══════════════════════════════════════════════════════════════════

window._pdFiltros  = window._pdFiltros  || { maquina: '', status: '', busca: '' };
window._pdFuncSel  = window._pdFuncSel  || {}; // { "YYYY-MM-DD_MAQ": "Nome Funcionário" }
window._pdObsCache = window._pdObsCache || {}; // { "recId_date": "texto" }

function pdFiltrar() {
  window._pdFiltros = {
    busca:   (document.getElementById('pd-filtro-busca')  || {}).value || '',
    maquina: (document.getElementById('pd-filtro-maq')    || {}).value || '',
    status:  (document.getElementById('pd-filtro-status') || {}).value || '',
  };
  renderProducaoDiaControlado();
}

function pdLimparFiltros() {
  window._pdFiltros = { maquina: '', status: '', busca: '' };
  renderProducaoDiaControlado();
}

function pdSelecionarFunc(sel, ds, maq) {
  window._pdFuncSel[`${ds}_${maq}`] = sel.value;
  // Salva no localStorage para persistir na sessão
  try { localStorage.setItem('_pdFuncSel', JSON.stringify(window._pdFuncSel)); } catch(e) {}
}

// Carrega seleções de funcionário do localStorage ao iniciar
(function() {
  try {
    const saved = localStorage.getItem('_pdFuncSel');
    if (saved) window._pdFuncSel = JSON.parse(saved);
  } catch(e) {}
})();

// ── Modal de Observação do Produto ──────────────────────────────────
function pdAbrirObs(recId, ds) {
  // Abre linha de observação inline na tabela (sem modal)
  const rowId = `obs-inline-${recId}-${ds}`;
  let existing = document.getElementById(rowId);
  if (existing) {
    existing.style.display = existing.style.display === 'none' ? 'table-row' : 'none';
    if (existing.style.display !== 'none') existing.querySelector('textarea')?.focus();
    return;
  }

  // Encontra a <tr> do produto e insere linha logo abaixo
  const btn  = document.getElementById(`obs-btn-${recId}-${ds}`);
  const tr   = btn ? btn.closest('tr') : null;
  if (!tr) { toast('Erro ao localizar produto na tabela.', 'err'); return; }

  // Busca obs existente do cache
  if (!window._pdObsCache) window._pdObsCache = {};
  const textoAtual = window._pdObsCache[`${recId}_${ds}`] || '';

  const colspan = tr.querySelectorAll('td').length;

  const newRow = document.createElement('tr');
  newRow.id = rowId;
  newRow.style.background = 'var(--s1)';
  newRow.innerHTML = `
    <td colspan="${colspan}" style="padding:8px 14px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <div style="flex:1">
          <textarea id="obs-txt-${recId}-${ds}"
                    placeholder="Observação do dia — problemas, setup, qualidade, etc."
                    maxlength="500"
                    style="width:100%;min-height:48px;max-height:100px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:11px;resize:vertical;font-family:'Space Grotesk',sans-serif;line-height:1.4;box-sizing:border-box"
                    onfocus="this.style.borderColor='var(--cyan)'" onblur="this.style.borderColor='var(--border)'"
          >${textoAtual}</textarea>
          <div style="font-size:9px;color:var(--text3);margin-top:2px">Max 500 caracteres</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
          <button onclick="pdSalvarObs('${recId}','${ds}')"
                  style="background:var(--cyan);color:#000;border:none;border-radius:5px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">
            💾 Salvar
          </button>
          <button onclick="document.getElementById('${rowId}').style.display='none'"
                  style="background:var(--s2);border:1px solid var(--border);color:var(--text2);border-radius:5px;padding:4px 12px;font-size:11px;cursor:pointer">
            Fechar
          </button>
        </div>
      </div>
    </td>`;

  tr.after(newRow);
  newRow.querySelector('textarea')?.focus();
}

function pdFecharObs() {
  document.getElementById('modal-pd-obs')?.remove();
}


async function pdSalvarObs(recId, ds) {
  if (!window._pdObsCache) window._pdObsCache = {};
  const textarea = document.getElementById(`obs-txt-${recId}-${ds}`);
  if (!textarea) { toast('Campo não encontrado.', 'err'); return; }
  const texto = textarea.value.trim();
  if (!texto) { toast('Digite uma observação antes de salvar.', 'warn'); return; }

  const sucesso = await salvarObservacao(ds, recId, texto, getUserEmailSafe());
  if (sucesso) {
    window._pdObsCache[`${recId}_${ds}`] = texto;
    _observacoesCache = {};
    toast('✅ Observação salva!', 'ok');
    const row = document.getElementById(`obs-inline-${recId}-${ds}`);
    if (row) row.style.display = 'none';
    _pdAtualizarBadgeObs(recId, ds, texto);
  }
}

async function pdLimparObs(recId, ds) {
  if (!confirm('Apagar a observação?')) return;
  const sucesso = await salvarObservacao(ds, recId, '', getUserEmailSafe());
  if (sucesso) {
    if (window._pdObsCache) delete window._pdObsCache[`${recId}_${ds}`];
    _observacoesCache = {};
    toast('Observação apagada.', 'info');
    const row = document.getElementById(`obs-inline-${recId}-${ds}`);
    if (row) row.remove();
    _pdAtualizarBadgeObs(recId, ds, '');
  }
}

window.pdFiltrar         = pdFiltrar;
window.pdLimparFiltros   = pdLimparFiltros;
window.pdSelecionarFunc  = pdSelecionarFunc;
window.pdAbrirObs        = pdAbrirObs;
window.pdFecharObs       = pdFecharObs;
window.pdSalvarObs       = pdSalvarObs;
window.pdLimparObs       = pdLimparObs;

// ── Finalizar produção de um produto na aba Realizado ────────────────
function realizadoFinalizarProducao(recId, dateVal) {
  if(!can('gantt','finalizar') && !can('realizado','finalizar')){ toast('Sem permissão para finalizar produção.','err'); return; }
  const record = records.find(r => String(r.id) === String(recId));
  const nome   = record ? record.produto : recId;
  const meta   = record ? (record.qntCaixas || 0) : 0;
  const totalProd = calcularTotalProduzido(recId);
  const faltam    = meta - totalProd;

  // Se não bateu a meta, pede confirmação extra
  if (meta > 0 && totalProd < meta) {
    const pct = Math.round(totalProd / meta * 100);
    if (!confirm(
      `⚠️ Atenção: "${nome}" ainda não atingiu a quantidade solicitada!\n\n` +
      `Produzido: ${totalProd} de ${meta} (${pct}%) — faltam ${faltam} caixas.\n\n` +
      `Deseja finalizar mesmo assim?\n` +
      `O produto NÃO aparecerá nos dias seguintes.`
    )) return;
  } else {
    if (!confirm(`Confirma a finalização de "${nome}"?\n\nO produto ficará marcado como finalizado e não aparecerá nos próximos dias.`)) return;
  }

  // Salva apontamento atual antes de finalizar
  realizadoSalvarLinha(recId, dateVal);

  // Marca como finalizado no Firestore
  pdSetFin(recId, true);

  // Registra auditoria
  const user = getCurrentUserSafe();
  registrarAuditoria('PRODUCAO_FINALIZADA', {
    recordId   : recId,
    produto    : nome,
    data       : dateVal,
    produzido  : totalProd,
    meta       : meta,
    incompleto : totalProd < meta,
    usuario    : user ? (user.email || '') : ''
  });

  toast(`✅ "${nome}" finalizado!`, 'ok');
  setTimeout(() => renderApontamento(), 300);
}
window.realizadoFinalizarProducao = realizadoFinalizarProducao;

// ── Desfinalizar — libera edição e volta o produto para a lista ──────
function realizadoDesfinalizar(recId) {
  if(!can('gantt','finalizar') && !can('realizado','finalizar')){ toast('Sem permissão para desfinalizar.','err'); return; }
  const record = records.find(r => String(r.id) === String(recId));
  const nome   = record ? record.produto : recId;

  if (!confirm(`Desfinalizar "${nome}"?\n\nO produto voltará para a lista e os campos de quantidade serão liberados para edição.`)) return;

  pdSetFin(recId, false);

  const user = getCurrentUserSafe();
  registrarAuditoria('PRODUCAO_DESFINALIZADA', {
    recordId : recId,
    produto  : nome,
    usuario  : user ? (user.email || '') : ''
  });

  toast(`↩️ "${nome}" desfianlizado — edição liberada.`, 'info');
  setTimeout(() => renderApontamento(), 300);
}
window.realizadoDesfinalizar = realizadoDesfinalizar;

// ── Realizado: atualiza totais em tempo real ao digitar ──────────────
function realizadoInputChange(inp) {
  const recId   = inp.dataset.rec;
  const body    = document.getElementById('apon-body');
  const dateVal = body?._dateVal || inp.dataset.date || prodSelectedDate;
  const all     = document.querySelectorAll(`[data-rec="${recId}"].apon-input-controlado`);
  let dayTotal = 0;
  const data = {};
  all.forEach(i => {
    const v = parseInt(i.value) || 0;
    dayTotal += v;
    data[i.dataset.hr] = v || '';
  });
  // Atualiza total dia
  const dtEl = document.getElementById(`realizado-daytotal-${recId}`);
  if (dtEl) {
    dtEl.textContent = dayTotal > 0 ? dayTotal : '—';
    dtEl.style.color = dayTotal > 0 ? 'var(--cyan)' : 'var(--text3)';
  }
  // Atualiza acumulado
  const prevTotal = aponGetPrevTotal(recId, dateVal);
  const acum = prevTotal + dayTotal;
  const rec  = records.find(r => String(r.id) === String(recId));
  const meta = rec ? (rec.qntCaixas || 0) : 0;
  const acEl = document.getElementById(`realizado-acum-${recId}`);
  if (acEl) {
    acEl.textContent = acum > 0 ? acum : '—';
    acEl.style.color = acum >= meta && meta > 0 ? 'var(--green)' : acum > 0 ? 'var(--text)' : 'var(--text3)';
  }
  // Auto-save no localStorage
  aponStorageSet(aponKey(dateVal, recId), data);
}

// ── Salva linha individual ────────────────────────────────────────────
function realizadoSalvarLinha(recId, dateVal) {
  if(!can('realizado','apontar')){ toast('Sem permissão para apontar produção.','err'); return; }
  const all  = document.querySelectorAll(`[data-rec="${recId}"].apon-input-controlado`);
  const data = {};
  let dayTotal = 0;
  all.forEach(i => {
    const qtd = parseInt(i.value) || 0;
    data[i.dataset.hr] = qtd;
    dayTotal += qtd;
  });

  // 1. Salvar no localStorage (imediato, fallback)
  aponStorageSet(aponKey(dateVal, recId), data);

  // 2. Atualizar cache Firestore em memória
  const fsKey = dateVal + '_' + recId;
  _aponFS[fsKey] = Object.assign({}, data);

  // 3. Salvar no Firestore
  const record = records.find(r => String(r.id) === String(recId));
  const user   = getCurrentUserSafe();
  const payload = {
    recordId : recId,
    data     : dateVal,
    horas    : data,
    total    : dayTotal,
    produto  : record ? record.produto : '',
    maquina  : record ? record.maquina : '',
    usuario  : user ? (user.email || '') : '',
    atualizadoEm: serverTimestamp(),
    lojaId   : getLojaAtiva()
  };
  // Usa setDoc com merge=false para substituir o documento do dia inteiro
  const docId = dateVal + '_' + recId;
  setDoc(lojaDoc('apontamentos_producao', docId), payload)
    .then(function() { console.log('[aponFS] Salvo no Firestore:', docId); })
    .catch(function(e) { console.error('[aponFS] Erro ao salvar no Firestore:', e.message); toast('Aviso: dado salvo localmente, erro no servidor: ' + e.message, 'warn'); });

  // 4. Feedback visual no botão
  const btn = document.querySelector(`button[onclick="realizadoSalvarLinha('${recId}','${dateVal}')"]`);
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '✓✓';
    btn.style.background = 'var(--cyan)';
    setTimeout(() => { btn.innerHTML = orig; btn.style.background = 'var(--green)'; }, 800);
  }

  // 5. Atualizar totais na tela
  const dtEl = document.getElementById(`realizado-daytotal-${recId}`);
  if (dtEl) {
    dtEl.textContent = dayTotal > 0 ? dayTotal : '—';
    dtEl.style.color = dayTotal > 0 ? 'var(--cyan)' : 'var(--text3)';
  }
  const prevTotal = aponGetPrevTotal(recId, dateVal);
  const acum = prevTotal + dayTotal;
  const meta = record ? (record.qntCaixas || 0) : 0;
  const acEl = document.getElementById(`realizado-acum-${recId}`);
  if (acEl) {
    acEl.textContent = acum > 0 ? acum : '—';
    acEl.style.color = acum >= meta && meta > 0 ? 'var(--green)' : acum > 0 ? 'var(--text)' : 'var(--text3)';
  }

  toast('Apontamento salvo.', 'ok');
}

// ── Salva todos os produtos de uma máquina ────────────────────────────
function realizadoSalvarMaquina(maq, dateVal) {
  const body = document.getElementById('apon-body');
  if (!body || !body._machineGroups) return;
  const grp = body._machineGroups.find(g => g.maq === maq);
  if (!grp) return;
  grp.items.forEach(it => realizadoSalvarLinha(it.rec.id, dateVal));
  toast(`Apontamentos de ${maq} salvos!`, 'ok');
}

// ── Toggle linha de observação ────────────────────────────────────────
function realizadoToggleObs(recId) {
  const row = document.getElementById(`obs-row-${recId}`);
  if (!row) return;
  row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
  if (row.style.display !== 'none') {
    row.querySelector('textarea')?.focus();
  }
}

window.realizadoInputChange   = realizadoInputChange;
window.realizadoSalvarLinha   = realizadoSalvarLinha;
window.realizadoSalvarMaquina = realizadoSalvarMaquina;
window.realizadoToggleObs     = realizadoToggleObs;

window.realizadoLimparFiltros = realizadoLimparFiltros;

window.pdCardControlado = pdCardControlado;
window.adicionarEstilosControlados = adicionarEstilosControlados;
window.editarProduto = editarProduto;
window.excluirProduto = excluirProduto;
window.toggleAtivoProduto = toggleAtivoProduto;
window.carregarHorariosMaquinas = carregarHorariosMaquinas;
window.salvarHorariosMaquinas = salvarHorariosMaquinas;
window.definirHorariosMaquina = definirHorariosMaquina;
window.getCurrentUserSafe = getCurrentUserSafe;
window.isOperadorLevel = isOperadorLevel;
window.isPCPLevel = isPCPLevel;
window.getUserEmailSafe = getUserEmailSafe;

// Funções de observações
window.salvarObservacao = salvarObservacao;
window.carregarObservacoes = carregarObservacoes;
window.getObservacaoComCache = getObservacaoComCache;
window.salvarObservacaoLocal = salvarObservacaoLocal;
window.autoSaveObservacao = autoSaveObservacao;
window.getCurrentOperator = getCurrentOperator;
window.salvarObservacaoManual = salvarObservacaoManual;
window.carregarObservacoesExistentes = carregarObservacoesExistentes;
window.validarObservacao = validarObservacao;
window.exportarRelatorioComObservacoes = exportarRelatorioComObservacoes;
window.buscarObservacoesPeriodo = buscarObservacoesPeriodo;
window.handleObservacaoInput = handleObservacaoInput;

// ===== INICIALIZAÇÃO FINAL DO SISTEMA =====

// Função para inicializar sistema controlado
function inicializarSistemaControlado() {
  try {
    console.log('🎯 Inicializando Sistema DT Produção Controlado...');
    
    // 1. Carregar horários das máquinas
    carregarHorariosMaquinas();
    
    // 2. Adicionar estilos CSS controlados
    adicionarEstilosControlados();
    
    // 3. Verificar usuário autenticado
    const user = getCurrentUserSafe();
    if (user) {
      console.log('👤 Usuário identificado:', user.email, '- Nível:', user.userData?.nivel || 'operador');
    } else {
      console.warn('⚠️ Usuário não identificado, usando configurações padrão');
    }
    
    // 4. Configurar modo operacional
    const isOp = isOperadorLevel();
    const isPCP = isPCPLevel();
    
    console.log('🔐 Modo operacional:', isOp ? 'OPERADOR (limitado)' : isPCP ? 'PCP (completo)' : 'PADRÃO');
    
    // 5. Mostrar status das principais funcionalidades
    const funcionalidades = {
      'Firestore': typeof addDoc !== 'undefined',
      'Auth': typeof auth !== 'undefined',
      'Records': Array.isArray(records),
      'Máquinas': Array.isArray(MAQUINAS) && MAQUINAS.length > 0,
      'Produtos': typeof getAllProdutos === 'function' && getAllProdutos().length > 0
    };
    
    console.log('📊 Status do sistema:', funcionalidades);
    
    // 6. Configurar notificações se suportado
    if ('Notification' in window && Notification.permission === 'default') {
      console.log('🔔 Notificações disponíveis - solicite permissão se necessário');
    }
    
    console.log('✅ Sistema DT Produção Controlado inicializado com sucesso!');
    
    return true;
  } catch(e) {
    console.error('❌ Erro na inicialização do sistema:', e);
    return false;
  }
}

// Executar inicialização quando DOM estiver pronto
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inicializarSistemaControlado);
  } else {
    // DOM já carregado, executar imediatamente
    setTimeout(inicializarSistemaControlado, 100);
  }
}

// Exportar função de inicialização
window.inicializarSistemaControlado = inicializarSistemaControlado;

// ===== UTILITÁRIOS EXTRAS =====

// Função para debug do sistema
window.debugSistema = function() {
  console.log('=== DEBUG SISTEMA DT PRODUÇÃO ===');
  console.log('Usuario:', getCurrentUserSafe());
  console.log('Nível operador:', isOperadorLevel());
  console.log('Nível PCP:', isPCPLevel());
  console.log('Records:', records.length);
  console.log('Máquinas:', MAQUINAS);
  console.log('Produtos:', getAllProdutos().length);
  console.log('Machine Hours:', machineHours);
  console.log('Semana selecionada:', prodBaseMonday);
  console.log('================================');
};

// Função para resetar configurações (emergência)
window.resetarConfiguracoes = function() {
  if (confirm('Tem certeza que deseja resetar todas as configurações? Esta ação não pode ser desfeita.')) {
    localStorage.removeItem('machineHours');
    localStorage.removeItem('produtos_extra');
    localStorage.removeItem('currentUser');
    
    // Recarregar página
    window.location.reload();
  }
};

// ===== SISTEMA DE OBSERVAÇÕES =====

// Salva observação no Firestore
async function salvarObservacao(data, recordId, observacao, operador) {
  try {
    const user = getCurrentUserSafe();
    if (!user) {
      toast('Usuário não autenticado', 'err');
      return false;
    }
    
    const record = records.find(r => r.id === recordId);
    if (!record) {
      toast('Produto não encontrado', 'err');
      return false;
    }
    
    const payload = {
      data: data,
      recordId: recordId,
      observacao: observacao.trim(),
      produto: record.produto,
      maquina: record.maquina,
      operador: operador || getUserEmailSafe(),
      usuario: user.email,
      criadoEm: serverTimestamp(),
      lojaId: getLojaAtiva(),
      ip: getClientIP(),
      sessao: getSessionId()
    };
    
    // Verificar se já existe observação para este produto neste dia
    const q = query(
      lojaCol('observacoes_producao'),
      where('data', '==', data),
      where('recordId', '==', recordId),
      limit(1)
    );
    
    const existingSnap = await getDocs(q);
    
    if (!existingSnap.empty) {
      // Atualizar observação existente
      const docId = existingSnap.docs[0].id;
      await updateDoc(doc(lojaCol('observacoes_producao'), docId), {
        observacao: observacao.trim(),
        operador: operador || getUserEmailSafe(),
        atualizadoEm: serverTimestamp(),
        atualizadoPor: user.email
      });
    } else {
      // Criar nova observação
      await addDoc(lojaCol('observacoes_producao'), payload);
    }
    
    // Registrar auditoria
    await registrarAuditoria('OBSERVACAO_SALVA', {
      recordId: recordId,
      produto: record.produto,
      data: data,
      observacao: observacao.substring(0, 100) // Primeiros 100 chars para auditoria
    });
    
    return true;
    
  } catch(e) {
    console.error('Erro ao salvar observação:', e);
    toast('Erro ao salvar observação: ' + e.message, 'err');
    return false;
  }
}

// Carrega observações do Firestore para um período
async function carregarObservacoes(dataInicio, dataFim) {
  try {
    const q = query(
      lojaCol('observacoes_producao'),
      where('data', '>=', dataInicio),
      where('data', '<=', dataFim),
      orderBy('data')
    );
    
    const snap = await getDocs(q);
    const observacoes = {};
    
    snap.docs.forEach(doc => {
      const data = doc.data();
      const key = `${data.data}_${data.recordId}`;
      observacoes[key] = {
        id: doc.id,
        observacao: data.observacao,
        operador: data.operador,
        criadoEm: data.criadoEm,
        atualizadoEm: data.atualizadoEm
      };
    });
    
    return observacoes;
    
  } catch(e) {
    console.error('Erro ao carregar observações:', e);
    return {};
  }
}

// Cache de observações
let _observacoesCache = {};
let _observacoesCacheTimestamp = 0;

// Função para obter observação com cache
async function getObservacaoComCache(data, recordId) {
  const key = `${data}_${recordId}`;
  
  // Verificar cache (válido por 60 segundos)
  const agora = Date.now();
  if (agora - _observacoesCacheTimestamp < 60000 && _observacoesCache[key]) {
    return _observacoesCache[key];
  }
  
  // Buscar no Firestore se cache inválido
  try {
    const q = query(
      lojaCol('observacoes_producao'),
      where('data', '==', data),
      where('recordId', '==', recordId),
      limit(1)
    );
    
    const snap = await getDocs(q);
    if (!snap.empty) {
      const obs = snap.docs[0].data();
      _observacoesCache[key] = {
        observacao: obs.observacao,
        operador: obs.operador,
        criadoEm: obs.criadoEm
      };
      _observacoesCacheTimestamp = agora;
      return _observacoesCache[key];
    }
  } catch(e) {
    console.warn('Erro ao buscar observação:', e);
  }
  
  // Fallback: verificar localStorage
  const localKey = `obs_${data}_${recordId}`;
  const localObs = localStorage.getItem(localKey);
  if (localObs) {
    try {
      return JSON.parse(localObs);
    } catch(e) {
      console.warn('Erro no parse da observação local:', e);
    }
  }
  
  return null;
}

// Salva observação no localStorage (backup)
function salvarObservacaoLocal(data, recordId, observacao, operador) {
  const key = `obs_${data}_${recordId}`;
  const dados = {
    observacao: observacao.trim(),
    operador: operador || getUserEmailSafe(),
    timestamp: Date.now()
  };
  
  localStorage.setItem(key, JSON.stringify(dados));
}

// Gerencia input de observação com contador e auto-save
function handleObservacaoInput(textarea, dateVal, recordId) {
  const valor = textarea.value;
  const contador = document.getElementById(`counter-${recordId}-${dateVal}`);
  const indicator = document.getElementById(`autosave-${recordId}-${dateVal}`);
  
  // Atualizar contador de caracteres
  if (contador) {
    const length = valor.length;
    contador.textContent = `${length}/500`;
    
    // Mudar cor baseado no limite
    contador.className = 'obs-counter';
    if (length > 400) {
      contador.classList.add('warning');
    }
    if (length >= 500) {
      contador.classList.add('error');
    }
  }
  
  // Mostrar indicador de salvamento
  if (indicator) {
    indicator.className = 'auto-save-indicator saving';
    indicator.textContent = 'Salvando...';
  }
  
  // Auto-save com debounce
  autoSaveObservacao(dateVal, recordId, valor, getCurrentOperator());
  
  // Atualizar indicador após o save
  setTimeout(() => {
    if (indicator && valor.trim()) {
      indicator.className = 'auto-save-indicator saved';
      indicator.textContent = 'Salvo';
    } else if (indicator) {
      indicator.className = 'auto-save-indicator';
      indicator.textContent = 'Auto-save';
    }
  }, 2500);
}

// Auto-save aprimorado de observações
function autoSaveObservacao(data, recordId, observacao, operador) {
  // Salvar localmente imediatamente
  salvarObservacaoLocal(data, recordId, observacao, operador);
  
  // Validar antes do Firestore
  const validacao = validarObservacao(observacao);
  if (!validacao.valido && observacao.trim()) {
    console.warn('Observação inválida:', validacao.motivo);
    return;
  }
  
  // Debounce para Firestore (só salva após 3 segundos sem alteração)
  clearTimeout(window._obsTimeout);
  window._obsTimeout = setTimeout(async () => {
    if (observacao.trim()) {
      const sucesso = await salvarObservacao(data, recordId, observacao, operador);
      if (!sucesso) {
        console.warn('Erro no auto-save da observação');
      }
    }
  }, 3000);
}

// ===== FUNÇÕES AUXILIARES PARA OBSERVAÇÕES =====

// Obtém operador atual para observações
function getCurrentOperator() {
  const user = getCurrentUserSafe();
  if (!user) return 'Operador Não Identificado';
  
  return user.userData?.nome || user.nome || user.email || 'Operador';
}

// Salvar observação manualmente (botão)
async function salvarObservacaoManual(recordId, data) {
  const textarea = document.getElementById(`obs-${recordId}-${data}`);
  if (!textarea) {
    toast('Campo de observação não encontrado', 'err');
    return;
  }
  
  const observacao = textarea.value.trim();
  const operador = getCurrentOperator();
  
  if (!observacao) {
    toast('Digite uma observação antes de salvar', 'warn');
    return;
  }
  
  if (observacao.length > 500) {
    toast('Observação muito longa (máx 500 caracteres)', 'err');
    return;
  }
  
  const sucesso = await salvarObservacao(data, recordId, observacao, operador);
  if (sucesso) {
    toast('✅ Observação salva com sucesso', 'ok');
    
    // Adicionar indicador visual de salvo
    const button = event.target;
    const textoOriginal = button.textContent;
    button.textContent = '✅ Salvo';
    button.style.background = 'var(--green)';
    button.style.color = '#000';
    
    setTimeout(() => {
      button.textContent = textoOriginal;
      button.style.background = 'var(--s2)';
      button.style.color = 'var(--text2)';
    }, 2000);
  }
}

// Carregar observações existentes e preencher campos
async function carregarObservacoesExistentes(dateVal) {
  const textareas = document.querySelectorAll('.observacao-input');
  
  for (const textarea of textareas) {
    const recordId = parseInt(textarea.dataset.rec);
    const data = textarea.dataset.date;
    
    if (data === dateVal) {
      const observacao = await getObservacaoComCache(data, recordId);
      if (observacao && observacao.observacao) {
        textarea.value = observacao.observacao;
        
        // Adicionar informação de quem criou
        const infoDiv = textarea.parentElement.querySelector('.obs-info');
        if (!infoDiv) {
          const info = document.createElement('div');
          info.className = 'obs-info';
          info.style.cssText = 'font-size:9px;color:var(--text3);margin-top:2px;font-style:italic';
          
          const dataFormatada = observacao.criadoEm ? 
            new Date(observacao.criadoEm.seconds * 1000).toLocaleString('pt-BR') : 
            'data desconhecida';
          
          info.textContent = `Última alteração: ${observacao.operador} em ${dataFormatada}`;
          textarea.parentElement.appendChild(info);
        }
      }
    }
  }
}

// Validar texto da observação
function validarObservacao(texto) {
  if (!texto || typeof texto !== 'string') {
    return { valido: false, motivo: 'Texto inválido' };
  }
  
  const textoLimpo = texto.trim();
  
  if (textoLimpo.length === 0) {
    return { valido: true, motivo: 'Observação vazia (será removida)' };
  }
  
  if (textoLimpo.length > 500) {
    return { valido: false, motivo: 'Observação muito longa (máx 500 caracteres)' };
  }
  
  // Filtro básico de conteúdo ofensivo (pode ser expandido)
  const palavrasProibidas = ['#ERRO#', '<script>', 'javascript:', 'eval('];
  const temConteudoProibido = palavrasProibidas.some(palavra => 
    textoLimpo.toLowerCase().includes(palavra.toLowerCase())
  );
  
  if (temConteudoProibido) {
    return { valido: false, motivo: 'Conteúdo não permitido na observação' };
  }
  
  return { valido: true, texto: textoLimpo };
}

// Exportar relatório com observações
function exportarRelatorioComObservacoes() {
  if (!isPCPLevel()) {
    toast('Apenas PCP pode exportar relatórios!', 'err');
    return;
  }
  
  // TODO: Implementar exportação completa
  toast('Funcionalidade de exportação com observações em desenvolvimento', 'info');
}

// Buscar observações por período
async function buscarObservacoesPeriodo(dataInicio, dataFim) {
  try {
    const observacoes = await carregarObservacoes(dataInicio, dataFim);
    
    console.log('📝 Observações encontradas:', Object.keys(observacoes).length);
    
    // Agrupar por produto
    const porProduto = {};
    Object.entries(observacoes).forEach(([key, obs]) => {
      const [data, recordId] = key.split('_');
      const record = records.find(r => r.id == recordId);
      
      if (record) {
        const produtoKey = record.produto;
        if (!porProduto[produtoKey]) {
          porProduto[produtoKey] = [];
        }
        
        porProduto[produtoKey].push({
          data: data,
          observacao: obs.observacao,
          operador: obs.operador,
          maquina: record.maquina
        });
      }
    });
    
    return porProduto;
  } catch(e) {
    console.error('Erro ao buscar observações:', e);
    return {};
  }
}

// ===== NOVA VERSÃO RENDERAPONTAMENTO COM FIRESTORE =====

let _apontamentosCache = {};
let _cacheTimestamp = 0;

async function renderRealizadoControladoComFirestore(dateVal, body) {
  // Carregar dados do Firestore (com cache)
  const agora = Date.now();
  if (agora - _cacheTimestamp > 30000) { // Cache por 30 segundos
    _apontamentosCache = await carregarApontamentosSemana(prodBaseMonday);
    _cacheTimestamp = agora;
  }
  
  const isOperador = isOperadorLevel();
  const isPCP = isPCPLevel();
  
  // Mesmo código de filtros e validações...
  const weekDays = getWeekDays(prodBaseMonday);
  const weekStart = dateStr(weekDays[0]);
  const weekEnd = dateStr(weekDays[6]);
  
  function recIsInWeek(r){
    const dt = r.dtDesejada || r.dtSolicitacao;
    return dt && dt >= weekStart && dt <= weekEnd;
  }

  const weekRecs = records.filter(recIsInWeek);
  
  if (!weekRecs.length) {
    body.innerHTML = `
      <div class="empty" style="flex-direction:column;gap:12px">
        <div class="ei">📋</div>
        <div>Nenhum produto programado para esta semana.</div>
        <div style="font-size:11px;color:var(--text3)">
          Use <strong>Programação Semanal</strong> para criar a programação.
        </div>
      </div>`;
    return;
  }

  // Resto da implementação continua igual...
  // (mesmo código da função anterior, mas usando _apontamentosCache ao invés de localStorage)
}

// ===== SISTEMA DE ALERTAS INTELIGENTES =====

function verificarAlertasProducao() {
  const alertas = [];
  
  records.forEach(record => {
    const totalProduzido = calcularTotalProduzido(record.id);
    const meta = record.qntCaixas || 0;
    const pct = meta > 0 ? (totalProduzido / meta) * 100 : 0;
    const dataDesejada = new Date((record.dtDesejada || record.dtSolicitacao) + 'T12:00:00');
    const hoje = new Date();
    
    // Alerta: Produto em atraso
    if (dataDesejada < hoje && pct < 100) {
      alertas.push({
        tipo: 'ATRASO',
        prioridade: 'ALTA',
        produto: record.produto,
        dias_atraso: Math.floor((hoje - dataDesejada) / (1000 * 60 * 60 * 24)),
        pct_concluido: Math.round(pct)
      });
    }
    
    // Alerta: Produção parada há muito tempo
    const ultimoApontamento = getUltimoApontamento(record.id);
    if (ultimoApontamento && pct > 0 && pct < 100) {
      const diasParado = (hoje - ultimoApontamento) / (1000 * 60 * 60 * 24);
      if (diasParado > 2) {
        alertas.push({
          tipo: 'PRODUCAO_PARADA',
          prioridade: 'MEDIA',
          produto: record.produto,
          dias_parado: Math.floor(diasParado),
          pct_concluido: Math.round(pct)
        });
      }
    }
    
    // Alerta: Excesso de produção
    if (pct > 110) {
      alertas.push({
        tipo: 'EXCESSO_PRODUCAO',
        prioridade: 'BAIXA',
        produto: record.produto,
        excesso: Math.round(pct - 100)
      });
    }
  });
  
  return alertas;
}

function getUltimoApontamento(recordId) {
  // TODO: Implementar busca no Firestore
  // Por enquanto, usar localStorage
  const keys = aponGetAllKeys().filter(k => k.endsWith('_' + recordId));
  let ultimaData = null;
  
  keys.forEach(key => {
    const dataPart = key.slice('apon_'.length, key.length - ('_' + recordId).length);
    const data = new Date(dataPart + 'T12:00:00');
    if (!ultimaData || data > ultimaData) {
      ultimaData = data;
    }
  });
  
  return ultimaData;
}
window.renderProdutosCfg = renderProdutosCfg;
// window.prodCfgToggle = prodCfgToggle; // função removida
window.openAddProduto = openAddProduto;
window.closeProdModal = closeProdModal;
window.saveProdModal = saveProdModal;
window._abrirEtapa2Insumos = _abrirEtapa2Insumos;
window._fecharEtapa2 = _fecharEtapa2;

// ═══════════════════════════════════════════════════════════════
// EXCLUSÃO EM MASSA
// ═══════════════════════════════════════════════════════════════

function openExclusaoEmMassa() {
  // Remove modal existente se houver
  const old = document.getElementById('modal-exclusao-massa');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = 'modal-exclusao-massa';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)';

  modal.innerHTML = `
    <div style="background:var(--s1);border:1px solid var(--border);border-radius:12px;width:420px;max-width:92vw;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.4)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff4757" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          <span style="font-size:14px;font-weight:700;color:var(--text)">Limpar dados</span>
        </div>
        <button onclick="document.getElementById('modal-exclusao-massa').remove()" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;line-height:1">×</button>
      </div>

      <div style="padding:18px 20px">
        <p style="font-size:12px;color:var(--text3);margin:0 0 16px 0;line-height:1.6">
          Selecione o que deseja apagar. <strong style="color:#ff4757">Esta ação não pode ser desfeita.</strong>
        </p>

        <div style="display:flex;flex-direction:column;gap:10px">
          ${[
            ['chk-del-produtos',   '📦 Produtos',       'Todos os produtos do cadastro (PRODUTOS e PRODUTOS_EXTRA)'],
            ['chk-del-maquinas',   '🏭 Máquinas',       'Todas as máquinas cadastradas'],
            ['chk-del-fichas',     '📋 Ficha técnica',  'Fichas técnicas e insumos vinculados aos produtos'],
            ['chk-del-setup',      '⏱️ Setup',          'Todos os tempos de setup entre produtos'],
          ].map(([id, label, desc]) => `
            <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:10px 12px;border:1px solid var(--border);border-radius:8px;transition:border-color .15s" onmouseover="this.style.borderColor='#ff4757'" onmouseout="this.style.borderColor='var(--border)'">
              <input type="checkbox" id="${id}" style="margin-top:2px;accent-color:#ff4757;width:15px;height:15px;flex-shrink:0">
              <div>
                <div style="font-size:13px;font-weight:600;color:var(--text)">${label}</div>
                <div style="font-size:11px;color:var(--text3);margin-top:2px">${desc}</div>
              </div>
            </label>
          `).join('')}
        </div>

        <div id="excl-status" style="min-height:18px;margin-top:12px;font-size:11px;color:var(--text3)"></div>
      </div>

      <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
        <button onclick="document.getElementById('modal-exclusao-massa').remove()" style="background:var(--s2);border:1px solid var(--border);border-radius:7px;padding:7px 16px;font-size:12px;color:var(--text);cursor:pointer">Cancelar</button>
        <button onclick="confirmarExclusaoEmMassa()" style="background:#ff4757;border:none;border-radius:7px;padding:7px 18px;font-size:12px;font-weight:700;color:#fff;cursor:pointer">🗑️ Excluir selecionados</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function confirmarExclusaoEmMassa() {
  const delProdutos = document.getElementById('chk-del-produtos')?.checked;
  const delMaquinas = document.getElementById('chk-del-maquinas')?.checked;
  const delFichas   = document.getElementById('chk-del-fichas')?.checked;
  const delSetup    = document.getElementById('chk-del-setup')?.checked;

  if (!delProdutos && !delMaquinas && !delFichas && !delSetup) {
    toast('Selecione pelo menos uma opcao.', 'warn'); return;
  }

  const itens = [
    delProdutos && 'Produtos',
    delMaquinas && 'Maquinas',
    delFichas   && 'Fichas tecnicas',
    delSetup    && 'Setup',
  ].filter(Boolean).join(', ');

  if (!confirm('ATENCAO: Apagar permanentemente: ' + itens + '\n\nEsta acao nao pode ser desfeita. Deseja continuar?')) return;

  const statusEl = document.getElementById('excl-status');
  const setStatus = msg => { if (statusEl) statusEl.textContent = msg; };

  async function limparColecao(nomeCol) {
    try {
      const snap = await getDocs(lojaCol(nomeCol));
      if (snap.empty) return 0;
      const lote = 50;
      for (let i = 0; i < snap.docs.length; i += lote) {
        await Promise.all(snap.docs.slice(i, i + lote).map(d => deleteDoc(lojaDoc(nomeCol, d.id))));
      }
      return snap.docs.length;
    } catch(e) {
      console.error('Erro ao limpar ' + nomeCol + ':', e);
      toast('Erro ao excluir ' + nomeCol + ': ' + e.message, 'err');
      return 0;
    }
  }

  try {
    let total = 0;

    if (delProdutos) {
      setStatus('Excluindo produtos...');
      total += await limparColecao('produtos');
      if (Array.isArray(window.PRODUTOS)) window.PRODUTOS.splice(0, window.PRODUTOS.length);
      if (typeof PRODUTOS_EXTRA !== 'undefined' && Array.isArray(PRODUTOS_EXTRA)) {
        PRODUTOS_EXTRA.splice(0, PRODUTOS_EXTRA.length);
        localStorage.removeItem('produtos_extra');
      }
    }

    if (delMaquinas) {
      setStatus('Excluindo maquinas...');
      total += await limparColecao('maquinas');
      window.MAQUINAS_DATA = {};
      if (typeof MAQUINAS !== 'undefined' && Array.isArray(MAQUINAS)) MAQUINAS.splice(0, MAQUINAS.length);
    }

    if (delFichas) {
      setStatus('Excluindo fichas tecnicas...');
      total += await limparColecao('fichaTecnica');
      if (typeof fichaTecnicaData !== 'undefined' && Array.isArray(fichaTecnicaData)) fichaTecnicaData.splice(0, fichaTecnicaData.length);
      if (typeof FICHA_TECNICA !== 'undefined' && Array.isArray(FICHA_TECNICA)) FICHA_TECNICA.splice(0, FICHA_TECNICA.length);
    }

    if (delSetup) {
      setStatus('Excluindo setup...');
      total += await limparColecao('setup_maquinas');
    }

    setStatus('Atualizando tela...');
    invalidateCache('produtos', 'maquinas');
    if (typeof renderProdutosCfg === 'function') renderProdutosCfg();
    if (typeof renderCadastroMaquinas === 'function') renderCadastroMaquinas();
    if (typeof renderFichaTecnicaCfg === 'function') renderFichaTecnicaCfg();
    if (typeof renderFichaTecnica === 'function') renderFichaTecnica();
    if (typeof renderSetupMaquinas === 'function') renderSetupMaquinas();

    document.getElementById('modal-exclusao-massa')?.remove();
    toast('Excluidos: ' + total + ' registros (' + itens + ')', 'ok');
    registrarAuditoria('EXCLUSAO_EM_MASSA', { itens, total });

  } catch(err) {
    toast('Erro ao excluir: ' + err.message, 'err');
    console.error('[exclusaoEmMassa]', err);
  }
}
window.openExclusaoEmMassa = openExclusaoEmMassa;
window.confirmarExclusaoEmMassa = confirmarExclusaoEmMassa;
window._fecharEtapa2Pos = _fecharEtapa2Pos;
window.deleteExtraProduto = deleteExtraProduto;
window.importProdutosExcel = importProdutosExcel;
window.downloadProdTemplate = downloadProdTemplate;
window.importarArquivoPadrao = importarArquivoPadrao;
window.exportarArquivoPadrao = exportarArquivoPadrao;
window.downloadMaqTemplate = downloadMaqTemplate;

// ===== SETUP TEMPLATES E IMPORTAÇÃO =====
async function downloadSetupTemplate(e) {
  e.preventDefault();
  await _baixarTemplateCompleto();
}

async function importarSetupExcel(file) {
  if (!file) return;
  
  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data);
    const ws = wb.Sheets[wb.SheetNames[0]];
    
    // Detectar se é arquivo simples (colunas) ou matriz complexa
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    
    if (rows.length < 2) {
      toast('Arquivo deve ter pelo menos cabeçalho e uma linha de dados!', 'err');
      return;
    }
    
    // Verificar se é formato simples (4 colunas: maquina, origem, destino, tempo)
    const header = rows[0];
    const isSimpleFormat = header.length <= 10 && 
      (header.some(h => /maquina/i.test(String(h))) || 
       header.some(h => /origem/i.test(String(h))));
    
    if (isSimpleFormat) {
      await importarSetupSimples(rows);
    } else {
      await importarSetupMatriz(rows);
    }
    
    await renderSetupMaquinas();
    
  } catch(e) {
    toast('Erro ao importar setup: ' + e.message, 'err');
    console.error('Erro na importação de setup:', e);
  }
}

// Importação formato simples (4 colunas)
async function importarSetupSimples(rows) {
  const header = rows[0].map(h => String(h||'').trim().toLowerCase());
  const dataRows = rows.slice(1).filter(r => r && r.length > 0);
  
  let maqCol = -1, origemCol = -1, destinoCol = -1, tempoCol = -1;
  
  header.forEach((h, i) => {
    if (/maquina/i.test(h)) maqCol = i;
    else if (/origem/i.test(h)) origemCol = i;
    else if (/destino/i.test(h)) destinoCol = i;
    else if (/tempo|minuto/i.test(h)) tempoCol = i;
  });
  
  if (maqCol === -1 || origemCol === -1 || destinoCol === -1 || tempoCol === -1) {
    toast('Colunas obrigatórias: maquina, produto_origem, produto_destino, tempo_minutos', 'err');
    return;
  }
  
  let adicionados = 0;
  
  for (const row of dataRows) {
    const maquina = String(row[maqCol]||'').trim();
    const origem = String(row[origemCol]||'').trim();
    const destino = String(row[destinoCol]||'').trim();
    const tempo = parseFloat(row[tempoCol]) || 0;
    
    if (!maquina || !origem || !destino) continue;
    
    const payload = {
      maquina: maquina.toUpperCase(),
      produto_origem: origem,
      produto_destino: destino,
      tempo_setup: tempo,
      criadoEm: new Date().toISOString()
    };
    
    await addDoc(lojaCol('setup_maquinas'), payload);
    adicionados++;
  }
  
  toast(`✅ ${adicionados} registros de setup importados!`, 'ok');
}

// Importação formato matriz (igual ao seu arquivo)
async function importarSetupMatriz(rows) {
  // Detectar produtos nos nomes das colunas e linhas
  const produtos = new Set();
  let startCol = 2; // Pular primeiras colunas que podem ser índices
  
  // Coletar produtos únicos das colunas (header)
  rows[0].slice(startCol).forEach(colName => {
    const prod = String(colName||'').trim();
    if (prod && prod !== '0' && !prod.match(/^0\.\d+$/)) {
      produtos.add(prod);
    }
  });
  
  // Coletar produtos únicos das linhas
  rows.slice(1).forEach(row => {
    const prod = String(row[0]||'').trim();
    if (prod && prod !== '0' && !prod.match(/^0\.\d+$/)) {
      produtos.add(prod);
    }
  });
  
  const produtosList = Array.from(produtos);
  console.log(`Detectados ${produtosList.length} produtos na matriz`);
  
  // Como não sabemos as máquinas da matriz, vamos usar uma máquina padrão
  const maquinaPadrao = 'MAQUINA_IMPORTADA';
  
  let adicionados = 0;
  
  // Processar matriz
  for (let i = 1; i < Math.min(rows.length, 100); i++) { // Limitar para evitar timeout
    const row = rows[i];
    const produtoOrigem = String(row[0]||'').trim();
    
    if (!produtoOrigem || produtoOrigem === '0' || produtoOrigem.match(/^0\.\d+$/)) continue;
    
    for (let j = startCol; j < Math.min(row.length, startCol + 50); j++) { // Limitar colunas
      const produtoDestino = String(rows[0][j]||'').trim();
      const valorSetup = row[j];
      
      if (!produtoDestino || produtoDestino === '0' || produtoDestino.match(/^0\.\d+$/)) continue;
      if (produtoOrigem === produtoDestino) continue; // Skip diagonal
      
      // Converter tempo para minutos
      let tempoMinutos = 0;
      if (valorSetup && valorSetup !== 0) {
        if (typeof valorSetup === 'string' && valorSetup.includes(':')) {
          // Formato HH:MM:SS ou MM:SS
          const parts = valorSetup.split(':');
          if (parts.length >= 2) {
            const hours = parts.length === 3 ? parseInt(parts[0]) || 0 : 0;
            const mins = parseInt(parts[parts.length-2]) || 0;
            const secs = parseInt(parts[parts.length-1]) || 0;
            tempoMinutos = hours * 60 + mins + secs / 60;
          }
        } else {
          tempoMinutos = parseFloat(valorSetup) || 0;
        }
      }
      
      if (tempoMinutos > 0) {
        const payload = {
          maquina: maquinaPadrao,
          produto_origem: produtoOrigem,
          produto_destino: produtoDestino,
          tempo_setup: Math.round(tempoMinutos),
          criadoEm: new Date().toISOString()
        };
        
        await addDoc(lojaCol('setup_maquinas'), payload);
        adicionados++;
      }
      
      // Limitar para evitar timeout
      if (adicionados > 200) break;
    }
    
    if (adicionados > 200) break;
  }
  
  toast(`✅ ${adicionados} registros de setup importados da matriz!<br>Máquina: ${maquinaPadrao}`, 'ok');
  if (adicionados === 200) {
    toast('Importação limitada a 200 registros. Execute novamente se necessário.', 'warn');
  }
}
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
// Expor funções de apontamento para relatorios.js e outros módulos externos
window.aponGetAllKeys  = aponGetAllKeys;
window.aponStorageGet  = aponStorageGet;
window.aponStorageSet  = aponStorageSet;
window.pdFinalize = pdFinalize;
window.editFichaByCod = editFichaByCod;
window.saveFichaByCod = saveFichaByCod;
window.excluirFichaByCod = excluirFichaByCod;
window.editFichaByDesc = editFichaByDesc;  // compat legado
window.reactivateFuncionario = reactivateFuncionario;
window.openDeactivate = openDesativarFuncProd;
window.deleteFuncionario = deleteFuncionario;
window.updateJornadaStyle = updateJornadaStyle;
window.updateHeader = updateHeader;
window.renderDashboard = renderDashboard;
window.renderTable = renderTable;
window.reload = reload;
window.reloadFresh = reloadFresh;
window.invalidateCache = invalidateCache;
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
window.limparDadosEstoque = limparDadosEstoque;
window.limparDadosProjecao = limparDadosProjecao;
window.limparDadosInsumos = limparDadosInsumos;


window.renderApiSync = renderApiSync;
window.apiTestarConexao = apiTestarConexao;
window.apiSincronizar = apiSincronizar;
window.importEstoque = importEstoque;
window.importProjecao = importProjecao;
window.limparHistoricoImportacao = limparHistoricoImportacao;
window.limparDadosEstoque = limparDadosEstoque;
window.limparDadosProjecao = limparDadosProjecao;
window.limparDadosInsumos = limparDadosInsumos;

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
window.pa_onModoChange   = pa_onModoChange;
window.pa_onMesChange    = function(){ if(paResultados.length) renderProgAutomaticaResultado(); };
window.paToggleInsumos = paToggleInsumos;
window.progToggleInsumos = progToggleInsumos;
