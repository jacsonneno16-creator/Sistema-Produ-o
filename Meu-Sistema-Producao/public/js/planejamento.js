// MOTOR DE PLANEJAMENTO AUTOMÁTICO

export function gerarPlanejamento({
  estoque,
  pedidos,
  escadinha,
  maquinas,
  produtos,
  jornada,
  diasNoMes    // dias úteis/calendário do período (default 30)
}) {

  const diasPeriodo = (diasNoMes && diasNoMes > 0) ? diasNoMes : 30;
  const planejamento = [];

  // Ordenar por prioridade de produção (menor número = maior prioridade)
  const produtosOrdenados = [...produtos].sort((a, b) =>
    (a.prioridadeProducao || 2) - (b.prioridadeProducao || 2)
  );

  produtosOrdenados.forEach(prod => {

    const cod  = prod.codigo || prod.cod;
    const nome = prod.produto || prod.descricao;

    const estoqueAtual    = estoque[cod]   || 0;
    const pedidosAbertos  = pedidos[cod]   || 0;
    const previsaoMes     = escadinha[cod] || 0;  // previsão total do mês

    // Parâmetros produtivos do cadastro
    const metaDias         = prod.metaCoberturaDias  || 0;
    const producaoMinima   = prod.producaoMinima      || 0;
    const multiploProducao = prod.multiploProducao    || 0;
    const tipoMinimo       = prod.tipoMinimo          || '';
    // Fallback legado: estoque mínimo absoluto quando metaCoberturaDias não está configurado
    const estoqueMinLegado = prod.estoque_min || prod.estoqueMinimo || 0;

    // ─────────────────────────────────────────────────────────────────────
    // PASSO 1 — Consumo médio diário
    //   consumoMedioDia = previsaoVendaMes / diasDoMes
    // ─────────────────────────────────────────────────────────────────────
    const consumoMedioDia = previsaoMes > 0 ? previsaoMes / diasPeriodo : 0;

    // ─────────────────────────────────────────────────────────────────────
    // PASSO 2 — Cobertura atual em dias
    //   coberturaAtual = estoqueAtual / consumoMedioDia
    // ─────────────────────────────────────────────────────────────────────
    const coberturaAtual = (consumoMedioDia > 0)
      ? estoqueAtual / consumoMedioDia
      : (estoqueAtual > 0 ? Infinity : 0);

    // ─────────────────────────────────────────────────────────────────────
    // PASSO 3 — Estoque alvo (meta de cobertura no final do mês)
    //   estoqueMeta = consumoMedioDia × metaCoberturaDias
    //   Fallback: estoqueMinLegado para produtos sem metaCoberturaDias.
    // ─────────────────────────────────────────────────────────────────────
    const estoqueMeta = (metaDias > 0 && consumoMedioDia > 0)
      ? consumoMedioDia * metaDias
      : estoqueMinLegado;

    // ─────────────────────────────────────────────────────────────────────
    // PASSO 4 — Necessidade total de produção no mês
    //   necessidadeMes = (previsaoVendaMes + estoqueMeta) - estoqueAtual
    //   Pedidos em aberto entram como demanda adicional além da previsão.
    //   Resultado negativo → zero (produto já coberto).
    // ─────────────────────────────────────────────────────────────────────
    const necessidadeBruta = Math.max(
      0,
      (previsaoMes + pedidosAbertos + estoqueMeta) - estoqueAtual
    );

    if (necessidadeBruta <= 0) return;

    const maquinasProduto = maquinas.filter(m =>
      m.produtos && m.produtos.includes(cod)
    );

    if (!maquinasProduto.length) return;

    // ─────────────────────────────────────────────────────────────────────
    // PASSO 5 — Aplicar mínimo e múltiplo de produção
    // ─────────────────────────────────────────────────────────────────────
    let quantidade = necessidadeBruta;

    // 5a. Verificar produção mínima
    if (producaoMinima > 0 && quantidade < producaoMinima) {
      quantidade = producaoMinima;
    }

    // 5b. Aplicar múltiplo de produção (arredondar para cima)
    if (tipoMinimo === 'multiplo' && multiploProducao > 0) {
      quantidade = Math.ceil(quantidade / multiploProducao) * multiploProducao;

    } else if (tipoMinimo === 'palete' && producaoMinima > 0) {
      // Palete: unidades por palete definidas em producaoMinima
      quantidade = Math.ceil(quantidade / producaoMinima) * producaoMinima;

    } else if (tipoMinimo === 'fixo') {
      // Fixo: mínimo já aplicado acima; apenas arredonda para inteiro
      quantidade = Math.ceil(quantidade);

    } else {
      // Sem tipo configurado: arredonda para cima; aplica múltiplo se existir
      quantidade = Math.ceil(quantidade);
      if (multiploProducao > 0) {
        quantidade = Math.ceil(quantidade / multiploProducao) * multiploProducao;
      }
    }

    const pcMin    = prod.pc_min || 1;
    const tempoMin = quantidade / pcMin;

    planejamento.push({
      produto:          nome,
      codigo:           cod,
      quantidade:       quantidade,
      quantidade_bruta: Math.ceil(necessidadeBruta),
      estoqueMeta:      Math.ceil(estoqueMeta),
      coberturaAtual:   coberturaAtual === Infinity ? null : +coberturaAtual.toFixed(1),
      metaCoberturaDias: metaDias,
      consumoMedioDia:  +consumoMedioDia.toFixed(2),
      tipoMinimo:       tipoMinimo,
      prioridade:       prod.prioridadeProducao || 2,
      tempo_min:        tempoMin,
      maquinas:         maquinasProduto.map(m => m.nome)
    });

  });

  return distribuirMaquinas(planejamento, maquinas, jornada);

}

function distribuirMaquinas(lista, maquinas, jornada) {

  const resultado = [];

  lista.forEach(item => {

    const maquina = maquinas.find(m =>
      item.maquinas.includes(m.nome)
    );

    if (!maquina) return;

    const horasDia   = jornada[maquina.nome] || 8;
    const minutosDia = horasDia * 60;
    const dias       = Math.ceil(item.tempo_min / minutosDia);

    resultado.push({
      produto:           item.produto,
      codigo:            item.codigo,
      maquina:           maquina.nome,
      quantidade:        item.quantidade,
      quantidade_bruta:  item.quantidade_bruta,
      estoqueMeta:       item.estoqueMeta,
      coberturaAtual:    item.coberturaAtual,
      metaCoberturaDias: item.metaCoberturaDias,
      consumoMedioDia:   item.consumoMedioDia,
      tipoMinimo:        item.tipoMinimo,
      prioridade:        item.prioridade,
      tempo_total_min:   item.tempo_min,
      dias_producao:     dias
    });

  });

  return resultado;

}
