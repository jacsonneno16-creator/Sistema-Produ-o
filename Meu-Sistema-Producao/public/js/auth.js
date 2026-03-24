import { auth, db, firebaseConfig } from "./firebase-config.js";

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  confirmPasswordReset,
  verifyPasswordResetCode,
  checkActionCode,
  getAuth
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import {
  doc, getDoc, setDoc, collection,
  getDocs, updateDoc, deleteDoc,
  query, orderBy, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// FIX: cache de usuarios — evita getDocs repetido na mesma sessão (TTL 5 min)
let _usuariosCache = null, _usuariosCacheTs = 0;
const _USUARIOS_TTL = 5 * 60 * 1000;
async function _getUsuariosCache() {
  const t = Date.now();
  if (_usuariosCache && t - _usuariosCacheTs < _USUARIOS_TTL) return _usuariosCache;
  const snap = await getDocs(collection(db, "usuarios"));
  _usuariosCache = snap.docs;
  _usuariosCacheTs = t;
  return _usuariosCache;
}
function _invalidarUsuariosCache() { _usuariosCache = null; _usuariosCacheTs = 0; }

// ─────────────────────────────────────────────────────────────────────────────
// MÓDULOS DO SISTEMA
// ─────────────────────────────────────────────────────────────────────────────
export const MODULOS = [
  { key:"dashboard",     label:"Dashboard" },
  { key:"programacao",   label:"Programação" },
  { key:"maquinas",      label:"Máquinas" },
  { key:"gantt",         label:"Prog. Visual" },
  { key:"realizado",     label:"Realizado" },
  { key:"insumos_maq",   label:"Insumos / Máq." },
  { key:"insumos_geral", label:"Insumos Geral" },
  { key:"calculos",      label:"Prog. Automática" },
  { key:"projecao",      label:"Projeção de Vendas" },
  { key:"ficha_tecnica", label:"Ficha Técnica" },
  { key:"importacao",    label:"Importação / API" },
  { key:"configuracoes", label:"Configurações" },
  { key:"funcionarios",  label:"Funcionários" },
  { key:"usuarios",      label:"Usuários do Sistema" },
  { key:"relatorios",    label:"Relatórios" },
];

// Estado global
export let currentUser = null;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE PERMISSÃO
// Admin tem acesso total automático.
// Usuário comum acessa apenas os módulos marcados em permissoes[modulo]=true
// ─────────────────────────────────────────────────────────────────────────────
export function can(modulo, acao="visualizar") {
  if (!currentUser || !currentUser.ativo) return false;
  if (currentUser.tipo === "admin") return true;
  const perms = currentUser.permissoes || {};
  const modPerm = perms[modulo];
  if (!modPerm) return false;
  // Formato novo: objeto com ações { visualizar: true, editar: true, ... }
  if (typeof modPerm === "object") return modPerm[acao] === true;
  // Formato legado: true/false (acesso total ao módulo)
  return modPerm === true;
}

export function canAccess(modulo) { return can(modulo, "visualizar"); }

export function perfilBadge(tipo) {
  if (tipo === "admin") {
    return `<span style="background:#e74c3c;color:#fff;font-size:10px;font-weight:700;padding:2px 9px;border-radius:20px;letter-spacing:.5px;text-transform:uppercase">Admin</span>`;
  }
  return `<span style="background:#3498db;color:#fff;font-size:10px;font-weight:700;padding:2px 9px;border-radius:20px;letter-spacing:.5px;text-transform:uppercase">Usuário</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN / LOGOUT
// ─────────────────────────────────────────────────────────────────────────────
export function login(email, senha) { return signInWithEmailAndPassword(auth, email, senha); }
export function logout() { return signOut(auth); }

// ─────────────────────────────────────────────────────────────────────────────
// RECUPERAÇÃO DE SENHA
// A senha NUNCA é salva no Firestore. Todo o fluxo passa pelo Firebase Auth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envia e-mail de redefinição de senha.
 * Registra no Firestore apenas a data do envio (sem senha).
 */
export async function enviarResetSenha(email) {
  // continueUrl: redireciona para o próprio sistema após clicar no link
  const continueUrl = window.location.origin + window.location.pathname;
  // Envia o e-mail primeiro — sem consultar Firestore (usuário não está autenticado)
  await sendPasswordResetEmail(auth, email, { url: continueUrl });
  // Tenta registrar a data do disparo no Firestore (opcional — falha silenciosa se sem permissão)
  try {
    const snap = await getDocs(collection(db, "usuarios"));
    const userDoc = snap.docs.find(d => (d.data().email || "").toLowerCase() === email.toLowerCase());
    if (userDoc) {
      await updateDoc(doc(db, "usuarios", userDoc.id), {
        ultimoResetEnviadoEm: new Date().toISOString(),
      });
    }
  } catch (_) {
    // Sem permissão de leitura sem autenticação — ignora silenciosamente
  }
}

/**
 * Verifica se um oobCode (link de reset) é válido.
 * Retorna o e-mail associado ao código.
 */
export async function verificarCodigoReset(oobCode) {
  return await verifyPasswordResetCode(auth, oobCode);
}

/**
 * Confirma a nova senha usando o oobCode do link de reset.
 * Atualiza no Firestore apenas metadados (sem senha).
 */
export async function confirmarNovaSenha(oobCode, novaSenha) {
  // Verifica o código antes de confirmar
  const email = await verifyPasswordResetCode(auth, oobCode);
  await confirmPasswordReset(auth, oobCode, novaSenha);
  // Atualiza metadados no Firestore — APENAS datas, sem senha
  // FIX: usa cache em vez de getDocs direto
  const snap = { docs: await _getUsuariosCache() };
  const userDoc = snap.docs.find(d => (d.data().email || "").toLowerCase() === email.toLowerCase());
  if (userDoc) {
    await updateDoc(doc(db, "usuarios", userDoc.id), {
      ultimaAlteracaoSenhaEm: new Date().toISOString(),
      ultimoResetEnviadoEm: userDoc.data().ultimoResetEnviadoEm || null,
    });
  }
  return email;
}

// ─────────────────────────────────────────────────────────────────────────────
// USUÁRIOS DO SISTEMA
// IMPORTANTE: a senha vai APENAS para o Firebase Auth — nunca para o Firestore
// ─────────────────────────────────────────────────────────────────────────────
export async function criarUsuarioSistema({ email, senha, nome, tipo, cargo, permissoes }) {
  const appSecundario = initializeApp(firebaseConfig, "criacao_" + Date.now());
  const authSecundario = getAuth(appSecundario);
  let uid = null;
  try {
    // 1. Cria no Auth secundário (não afeta o auth principal)
    const cred = await createUserWithEmailAndPassword(authSecundario, email, senha);
    uid = cred.user.uid;

    // 2. Salva no Firestore IMEDIATAMENTE com auth principal ainda logado
    const dados = {
      nome, email,
      tipo: tipo || "usuario",
      permissoes: tipo === "admin" ? {} : (permissoes || {}),
      cargo: cargo || "",
      ativo: true,
      criadoEm: new Date().toISOString(),
      ultimaAlteracaoSenhaEm: null,
      ultimoResetEnviadoEm: null,
    };
    _invalidarUsuariosCache();
  await setDoc(doc(db, "usuarios", uid), dados);
    return { uid, ...dados };
  } catch(e) {
    throw e;
  } finally {
    try { await signOut(authSecundario); } catch(_) {}
    try { await appSecundario.delete(); } catch(_) {}
  }
}

export async function listarUsuariosSistema() {
  // FIX: usa cache (5 min) em vez de getDocs direto
  const snap = { docs: await _getUsuariosCache() };
  // Retorna dados — nunca haverá campo senha, mas filtramos por garantia
  return snap.docs.map(d => {
    const data = d.data();
    // Remove qualquer campo de senha que possa existir por erro histórico
    delete data.senha;
    delete data.password;
    delete data.pass;
    return { uid: d.id, ...data };
  });
}

export async function atualizarUsuarioSistema(uid, dados) {
  // Garante que nenhum campo de senha passe para o Firestore
  const seguro = { ...dados };
  delete seguro.senha;
  delete seguro.password;
  delete seguro.pass;
  _invalidarUsuariosCache();
  await updateDoc(doc(db, "usuarios", uid), seguro);
}

/**
 * Exclui o registro do usuário no Firestore.
 * Nota: a conta no Firebase Auth só pode ser excluída via Admin SDK (backend).
 * Esta função remove o perfil/permissões — o usuário não conseguirá mais logar
 * pois o sistema não encontrará seu registro no Firestore.
 */
export async function excluirUsuarioSistema(uid) {
  _invalidarUsuariosCache();
  await deleteDoc(doc(db, "usuarios", uid));
}

/**
 * Admin força reset de senha: envia e-mail de redefinição para o usuário.
 * Não define a senha diretamente — o usuário recebe o link.
 */
export async function adminForcaReset(email) {
  await sendPasswordResetEmail(auth, email);
  // FIX: usa cache em vez de getDocs direto
  const snap = { docs: await _getUsuariosCache() };
  const userDoc = snap.docs.find(d => (d.data().email || "").toLowerCase() === email.toLowerCase());
  if (userDoc) {
    await updateDoc(doc(db, "usuarios", userDoc.id), {
      ultimoResetEnviadoEm: new Date().toISOString(),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIONÁRIOS DA PRODUÇÃO (sem login)
// ─────────────────────────────────────────────────────────────────────────────
export async function listarFuncionariosProducao() {
  try {
    const snap = await getDocs(collection(db, "funcionarios_producao"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) { console.error("listarFuncionariosProducao:", e); return []; }
}

export async function salvarFuncionarioProducao(dados, id=null) {
  if (id) {
    await updateDoc(doc(db, "funcionarios_producao", id), dados);
    return id;
  } else {
    const ref = await addDoc(collection(db, "funcionarios_producao"), dados);
    return ref.id;
  }
}

export async function excluirFuncionarioProducao(id) {
  await deleteDoc(doc(db, "funcionarios_producao", id));
}

// ─────────────────────────────────────────────────────────────────────────────
// initAuth
// ─────────────────────────────────────────────────────────────────────────────
export function initAuth(onLogado, onDeslogado) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { currentUser = null; if (typeof onDeslogado==="function") onDeslogado(); return; }
    try {
      const snap = await getDoc(doc(db, "usuarios", user.uid));
      if (!snap.exists()) { alert("Usuário não cadastrado no sistema."); await signOut(auth); return; }
      const dados = snap.data();
      delete dados.senha; delete dados.password; delete dados.pass;
      if (!dados.ativo) { alert("Usuário desativado. Contate o administrador."); await signOut(auth); return; }
      // Migração retroativa: perfil/nivel antigos → tipo novo (salva no Firestore)
      if (!dados.tipo || dados.tipo === "usuario_sistema") {
        const perfilAdmin = ["gerente", "admin"];
        dados.tipo = perfilAdmin.includes(dados.perfil || dados.nivel) ? "admin" : "usuario";
        // Persiste a migração para não precisar recalcular a cada login
        try {
          await updateDoc(doc(db, "usuarios", user.uid), { tipo: dados.tipo });
        } catch(_) {}
      }
      currentUser = { uid: user.uid, email: user.email, ...dados };
      if (typeof onLogado === "function") onLogado(currentUser);
    } catch(e) {
      console.error("ERRO FIRESTORE:", e);
      alert("Erro ao validar usuário (veja F12 > Console).");
      await signOut(auth);
    }
  });
}
