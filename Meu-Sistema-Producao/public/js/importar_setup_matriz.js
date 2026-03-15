// ============================================================
// SCRIPT DE IMPORTAÇÃO — Setup extraído de SET_UP.xlsx
// Roda no console do navegador (F12) enquanto logado.
// Limpe os dados atuais primeiro se necessário.
// ============================================================

(async function importarSetupMatriz() {
  if (typeof firestoreDB === 'undefined') {
    console.error('❌ Abra o sistema e faça login antes de rodar este script.');
    return;
  }
  
  const { addDoc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
  
  console.log('🚀 Importando 19 registros de setup...');
  
  const setupData = [
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO COOP 80 G",
    "produto_destino": "COLORIFICO DA TERRINHA 1,01 KG",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO COOP 80 G",
    "produto_destino": "COLORIFICO DA TERRINHA 500 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO COOP 80 G",
    "produto_destino": "COLORIFICO DA TERRINHA 70 G",
    "tempo_setup": 5,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO COOP 80 G",
    "produto_destino": "COLORIFICO MERCADAO 70 G",
    "tempo_setup": 5,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 1,01 KG",
    "produto_destino": "COLORIFICO COOP 80 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 1,01 KG",
    "produto_destino": "COLORIFICO DA TERRINHA 500 G",
    "tempo_setup": 10,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 1,01 KG",
    "produto_destino": "COLORIFICO DA TERRINHA 70 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 1,01 KG",
    "produto_destino": "COLORIFICO MERCADAO 70 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 500 G",
    "produto_destino": "COLORIFICO COOP 80 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 500 G",
    "produto_destino": "COLORIFICO DA TERRINHA 1,01 KG",
    "tempo_setup": 10,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 500 G",
    "produto_destino": "COLORIFICO DA TERRINHA 70 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 500 G",
    "produto_destino": "COLORIFICO MERCADAO 70 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 70 G",
    "produto_destino": "COLORIFICO COOP 80 G",
    "tempo_setup": 5,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 70 G",
    "produto_destino": "COLORIFICO DA TERRINHA 1,01 KG",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO DA TERRINHA 70 G",
    "produto_destino": "COLORIFICO DA TERRINHA 500 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO MERCADAO 70 G",
    "produto_destino": "COLORIFICO COOP 80 G",
    "tempo_setup": 5,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO MERCADAO 70 G",
    "produto_destino": "COLORIFICO DA TERRINHA 1,01 KG",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO MERCADAO 70 G",
    "produto_destino": "COLORIFICO DA TERRINHA 500 G",
    "tempo_setup": 35,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  },
  {
    "maquina": "SELGRON_01",
    "produto_origem": "COLORIFICO MERCADAO 70 G",
    "produto_destino": "COLORIFICO DA TERRINHA 70 G",
    "tempo_setup": 5,
    "criadoEm": "2024-01-01T00:00:00.000Z"
  }
];
  
  let importados = 0;
  let erros = 0;
  
  for (const record of setupData) {
    try {
      await addDoc(lojaCol('setup_maquinas'), record);
      importados++;
      if (importados % 20 === 0) console.log(`Importados: ${importados}/${setupData.length}`);
    } catch(e) {
      console.warn('Erro ao importar:', e.message);
      erros++;
    }
  }
  
  console.log(`\n🎉 Importação concluída!`);
  console.log(`✅ ${importados} registros importados`);
  if (erros > 0) console.log(`❌ ${erros} erros`);
  console.log('👉 Recarregue a tela (F5) e vá em Configurações → Setup de Máquinas.');
  
  console.log('\n📊 Resumo por máquina:');
  const por_maquina = setupData.reduce((acc, r) => {
    acc[r.maquina] = (acc[r.maquina] || 0) + 1;
    return acc;
  }, {});
  Object.entries(por_maquina).forEach(([maq, count]) => console.log(`  ${maq}: ${count} registros`));
})();