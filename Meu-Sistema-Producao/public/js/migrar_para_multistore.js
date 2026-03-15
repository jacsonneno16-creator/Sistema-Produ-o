// ============================================================
// SCRIPT DE MIGRAÇÃO — Dados globais → lojas/loja_matriz
// Roda UMA VEZ no console do navegador (F12) enquanto logado.
// Cole o código, pressione Enter e aguarde.
// ============================================================

(async function migrarParaMultistore() {
  if (typeof firestoreDB === 'undefined') {
    console.error('❌ Abra o sistema e faça login antes de rodar este script.');
    return;
  }
  const { collection, getDocs, addDoc, setDoc, doc, deleteDoc } =
    await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");

  const LOJA_ID = 'loja_matriz';
  const LOJA_NOME = 'Loja Matriz';

  // Coleções a migrar (raiz → lojas/loja_matriz/X)
  const COLECOES = ['registros','maquinas','produtos','fichaTecnica',
                    'setup_maquinas','insumos','fichas','configuracoes',
                    'apontamentos','programacao_producao'];

  console.log(`🚀 Iniciando migração para lojas/${LOJA_ID}...`);

  // 1. Criar documento da loja
  await setDoc(doc(firestoreDB, 'lojas', LOJA_ID), {
    nome: LOJA_NOME,
    criadoEm: new Date().toISOString(),
    ativo: true
  });
  console.log(`✅ Loja "${LOJA_NOME}" criada (ID: ${LOJA_ID})`);

  // 2. Migrar cada coleção
  let totalDocs = 0;
  for (const colNome of COLECOES) {
    try {
      const snap = await getDocs(collection(firestoreDB, colNome));
      if (snap.empty) {
        console.log(`  ⏭ ${colNome}: vazia, pulando`);
        continue;
      }
      let count = 0;
      for (const d of snap.docs) {
        await setDoc(
          doc(firestoreDB, 'lojas', LOJA_ID, colNome, d.id),
          d.data()
        );
        count++;
      }
      totalDocs += count;
      console.log(`  ✅ ${colNome}: ${count} documentos migrados`);
    } catch(e) {
      console.warn(`  ⚠️ ${colNome}: ${e.message}`);
    }
  }

  console.log(`\n🎉 Migração concluída! ${totalDocs} documentos movidos para lojas/${LOJA_ID}`);
  console.log('👉 Agora recarregue a página (F5). O sistema irá pedir para selecionar a loja.');
  console.log('👉 Selecione "Loja Matriz" e tudo funcionará normalmente.');
  console.log('\n⚠️  Os dados originais NÃO foram removidos das coleções globais.');
  console.log('    Quando tudo estiver funcionando, você pode removê-los manualmente no console do Firebase.');
})();
