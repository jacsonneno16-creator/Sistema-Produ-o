import * as db from './db.js';

function normalizarTexto(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function pick(obj, aliases) {
  const keys = Object.keys(obj || {});
  for (const a of aliases) {
    const alvo = normalizarTexto(a);
    const achou = keys.find(k => normalizarTexto(k) === alvo);
    if (achou) return obj[achou];
  }
  return undefined;
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function agruparSomandoPorProduto(linhas, campoProduto, campoValor) {
  const mapa = new Map();

  linhas.forEach(l => {
    const produto = String(l[campoProduto] || '').trim();
    const valor = num(l[campoValor]);

    if (!produto) return;

    if (!mapa.has(produto)) {
      mapa.set(produto, { produto, valor: 0 });
    }

    mapa.get(produto).valor += valor;
  });

  return [...mapa.values()];
}

function lerWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        resolve(wb);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function sheetJson(wb, nomePreferido = null) {
  let nome = nomePreferido;
  if (!nome || !wb.SheetNames.includes(nome)) {
    nome = wb.SheetNames[0];
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[nome], { defval: '' });
}

/* =========================================================
   BASE MÁQUINA x PRODUTO
========================================================= */
export async function importarBaseMaquinaProduto(file) {
  const wb = await lerWorkbook(file);

  const nomeSheet =
    wb.SheetNames.find(n => normalizarTexto(n) === 'base_maquina_tempo') ||
    wb.SheetNames.find(n => normalizarTexto(n).includes('base_maquina_tempo')) ||
    wb.SheetNames.find(n => normalizarTexto(n).includes('maquina')) ||
    wb.SheetNames[0];

  const rows = sheetJson(wb, nomeSheet);

  const base = rows.map(r => {
    const codigo = num(pick(r, ['Cód.', 'Cod.', 'Código', 'Codigo', 'COD']));
    const produto = String(
      pick(r, ['Descrição', 'DESCRICAO', 'DESCRIÇÃO', 'Produto']) || ''
    ).trim();

    const unidPorCx = num(
      pick(r, ['UNID', 'UNID/CX', 'UN/CX', 'Unid'])
    );

    const kgFd = num(
      pick(r, ['KG/FD', 'KG FD', 'KG_FD'])
    );

    const pcMin = num(
      pick(r, ['PC/MIN', 'PC_MIN', 'Pecas/Min', 'Peças/Min'])
    );

    const maquina = String(
      pick(r, ['Maquina22', 'Maquina', 'MÁQUINA', 'MAQUINA']) || ''
    ).trim();

    return {
      codigo,
      produto,
      unidPorCx,
      kgFd,
      pcMin,
      maquina,
      bruto: r
    };
  }).filter(r => r.produto && r.maquina);

  const baseUnica = [...new Map(base.map(r => [`${normalizarTexto(r.maquina)}__${normalizarTexto(r.produto)}`, r])).values()];

  const maquinasUnicas = [...new Set(baseUnica.map(r => r.maquina).filter(Boolean))];

  for (const nome of maquinasUnicas) {
    await db.upsertMaquinaByNome(nome, {
      nome,
      horasDia: 9,
      ativa: true
    });
  }

  await db.setConfig('baseMaquinaProduto', {
    linhas: baseUnica,
    totalLinhas: baseUnica.length,
    totalMaquinas: maquinasUnicas.length,
    sheetUsada: nomeSheet,
    atualizadoEmTexto: new Date().toISOString()
  });

  return {
    totalLinhas: baseUnica.length,
    totalMaquinas: maquinasUnicas.length,
    sheetUsada: nomeSheet
  };
}
/* =========================================================
   ESTOQUE
   - Filtra apenas produtos com cadastro em 'produtos'
   - Separa automaticamente por loja ativa
========================================================= */
export async function importarEstoque(file, lojaId = null) {
  const wb = await lerWorkbook(file);

  const ws = wb.Sheets[wb.SheetNames[0]];

  const rows = XLSX.utils.sheet_to_json(ws, {
    defval: '',
    range: 22
  });

  const linhas = rows.map(r => ({
    produto: String(pick(r, ['Produto']) || '').trim(),
    estoque: num(
      pick(r, [
        'Quantidade Endereçada',
        'Quantidade Enderecada',
        'Qtd Endereçada',
        'Qtd Enderecada'
      ])
    )
  })).filter(r => r.produto);

  // Carrega produtos cadastrados para filtrar
  const produtosCadastrados = await db.getProdutos();
  const normP = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const nomesValidos  = new Set(produtosCadastrados.map(p => normP(p.nome || p.descricao || '')));
  const lojaAtiva = lojaId || (typeof getLojaAtiva === 'function' ? getLojaAtiva() : null) || 'sem_loja';

  const agrupado = agruparSomandoPorProduto(linhas, 'produto', 'estoque')
    .map(x => ({ produto: x.produto, estoque: x.valor }));

  // Filtra só produtos cadastrados
  const filtrado  = agrupado.filter(x => nomesValidos.has(normP(x.produto)));
  const ignorados = agrupado.length - filtrado.length;

  // Adiciona lojaId em cada linha
  const linhasComLoja = filtrado.map(x => ({ ...x, lojaId: lojaAtiva }));

  await db.setConfig('estoqueImportado', {
    linhas:          linhasComLoja,
    totalLinhas:     linhasComLoja.length,
    totalIgnorados:  ignorados,
    lojaId:          lojaAtiva,
    atualizadoEmTexto: new Date().toISOString()
  });

  return {
    totalLinhas:    linhasComLoja.length,
    totalIgnorados: ignorados,
    lojaId:         lojaAtiva
  };
}

/* =========================================================
   PEDIDOS
========================================================= */
export async function importarPedidos(file) {
  const wb = await lerWorkbook(file);
  const rows = sheetJson(wb);

  const dados = rows.map(r => ({
    produto: String(pick(r, ['Produto', 'PRODUTO']) || '').trim(),
    quantidade: num(pick(r, ['Pedidos', 'QTD'])),
    bruto: r
  })).filter(r => r.produto);

  await db.setConfig('pedidosImportados', {
    linhas: dados,
    totalLinhas: dados.length,
    atualizadoEmTexto: new Date().toISOString()
  });

  return { totalLinhas: dados.length };
}

/* =========================================================
   ESCADINHA
   - Filtra apenas produtos com cadastro em 'produtos'
   - Separa automaticamente por loja ativa
========================================================= */
export async function importarEscadinha(file, lojaId = null) {
  const wb = await lerWorkbook(file);
  const rows = sheetJson(wb);

  const todos = rows.map(r => ({
    produto: String(pick(r, ['Produto', 'PRODUTO', 'Descrição']) || '').trim(),
    jan: num(pick(r, ['JAN'])),
    fev: num(pick(r, ['FEV'])),
    mar: num(pick(r, ['MAR'])),
    abr: num(pick(r, ['ABR'])),
    bruto: r
  })).filter(r => r.produto);

  // Carrega produtos cadastrados para filtrar
  const produtosCadastrados = await db.getProdutos();
  const normP = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const nomesValidos  = new Set(produtosCadastrados.map(p => normP(p.nome || p.descricao || '')));
  const lojaAtiva = lojaId || (typeof getLojaAtiva === 'function' ? getLojaAtiva() : null) || 'sem_loja';

  // Filtra só produtos cadastrados
  const dados     = todos.filter(x => nomesValidos.has(normP(x.produto)));
  const ignorados = todos.length - dados.length;

  // Adiciona lojaId em cada linha
  const dadosComLoja = dados.map(x => ({ ...x, lojaId: lojaAtiva }));

  await db.setConfig('escadinha', {
    linhas:          dadosComLoja,
    totalLinhas:     dadosComLoja.length,
    totalIgnorados:  ignorados,
    lojaId:          lojaAtiva,
    atualizadoEmTexto: new Date().toISOString()
  });

  return {
    totalLinhas:    dadosComLoja.length,
    totalIgnorados: ignorados,
    lojaId:         lojaAtiva
  };
}