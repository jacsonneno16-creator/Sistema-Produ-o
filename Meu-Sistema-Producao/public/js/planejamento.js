// ============================================================
// MOTOR DE PLANEJAMENTO AUTOMÁTICO — v5 (insumos + controle manual)
// ============================================================
//
// REGRA FUNDAMENTAL (nunca violar):
//   O sistema JAMAIS recalcula ignorando o que já foi programado.
//   Toda produção já programada é tratada como estoque futuro garantido.
//
// LÓGICA DE COBERTURA (faixa 30-45 dias):
//   30 = mínimo   |   38 = alvo ideal   |   45 = teto absoluto
//
// LÓGICA DE INSUMOS:
//   Para cada produto, o motor calcula DUAS quantidades:
//     - qtd_necessaria : o que o estoque/cobertura exige
//     - qtd_possivel   : limitado pelo insumo disponível
//   O usuário escolhe qual usar — e o motor recalcula tudo com esse valor.
//
// CONTROLE MANUAL:
//   O usuário pode sobrescrever, produto a produto:
//     - quantidade    : total a produzir (ex: usar qtd_possivel)
//     - semanaFixa    : forçar a produção para uma semana específica (1..N)
//   Após qualquer mudança, chamar gerarPlanejamento() de novo com
//   os overrides em `decisoesUsuario` — o motor reprocessa tudo.
//
// LÓGICA DE PRODUÇÃO ESTRATÉGICA (não-linear):
//   1. Ordenar por SCORE DE RISCO: consumo × gap até mínimo
//   2. Concentrar produção nas primeiras semanas (não distribuir igual)
//   3. Produtos críticos sobem estoque rápido, sem diluir em semanas
//   4. Banco de capacidade por máquina por semana — críticos até 80%
//
// ============================================================

// ── CONSTANTES DE FAIXA DE COBERTURA ─────────────────────────────────────────
const COBERTURA_MIN    = 30;
const COBERTURA_IDEAL  = 38;
const COBERTURA_ALERTA = 35;
const COBERTURA_MAX    = 45;

// ── CONSTANTES DE CAPACIDADE ──────────────────────────────────────────────────
const FRAC_CRITICO_POR_SEMANA = 0.80;
const FRAC_NORMAL_POR_SEMANA  = 0.50;

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================

/**
 * @param {Object}  params
 * @param {Object}  params.estoque            — { cod: quantidade_atual }
 * @param {Object}  params.pedidos            — { cod: pedidos_abertos }
 * @param {Object}  params.escadinha          — { cod: previsao_mes }
 * @param {Array}   params.maquinas           — [{ nome, produtos:[cod], pc_min }]
 * @param {Array}   params.produtos           — [{ codigo|cod, produto|descricao, ... }]
 * @param {Object}  params.jornada            — { nomeMaquina: horas_por_dia }
 * @param {Number}  params.diasNoMes          — dias úteis (default 30)
 * @param {Object}  [params.insumos]          — { cod: { disponivel, unidade?, chegadaSemana? } }
 *                                               disponivel  = qtd de insumo em estoque
 *                                               chegadaSemana = semana prevista p/ chegada
 * @param {Object}  [params.consumoInsumo]    — { cod: fator }
 *                                               fator = unidades de insumo por caixa produzida
 * @param {Object}  [params.jaProgSemanas]    — { cod: [cx_s1, cx_s2, cx_s3, cx_s4] }
 * @param {Number}  [params.numSemanas]       — semanas a simular (default 4)
 * @param {Object}  [params.decisoesUsuario]  — { cod: { quantidade?, semanaFixa? } }
 *                                               Sobrescritas manuais do usuário.
 *                                               quantidade  = total a produzir (override)
 *                                               semanaFixa  = 1..N — forçar para essa semana
 *
 * @returns {Array} lista de itens planejados (ver campos abaixo)
 *
 * Após qualquer mudança manual, chame gerarPlanejamento() novamente
 * com decisoesUsuario atualizado — o motor redistribui tudo do zero.
 */
export function gerarPlanejamento({
  estoque,
  pedidos,
  escadinha,
  maquinas,
  produtos,
  jornada,
  diasNoMes,
  insumos          = {},
  consumoInsumo    = {},
  jaProgSemanas    = {},
  numSemanas       = 4,
  decisoesUsuario  = {}
}) {

  const diasPeriodo = (diasNoMes && diasNoMes > 0) ? diasNoMes : 30;
  const nSemanas    = Math.max(1, Math.min(numSemanas, 8));
  const diasPorSem  = diasPeriodo / nSemanas;

  // ── FASE 1: PRÉ-CALCULAR dados e necessidades ─────────────────────────────────
  const candidatos = [];

  produtos.forEach(prod => {
    const cod  = prod.codigo || prod.cod;
    const nome = prod.produto || prod.descricao;

    const estoqueAtual   = estoque[cod]   || 0;
    const pedidosAbertos = pedidos[cod]   || 0;
    const previsaoMes    = escadinha[cod] || 0;

    const cobMin   = prod.coberturaMin    || COBERTURA_MIN;
    const cobMax   = prod.coberturaMax    || COBERTURA_MAX;
    const cobAlvo  = prod.coberturaIdeal  || COBERTURA_IDEAL;
    const cobAlert = prod.coberturaAlerta || COBERTURA_ALERTA;

    const producaoMinima   = prod.producaoMinima   || 0;
    const multiploProducao = prod.multiploProducao || 0;
    const tipoMinimo       = prod.tipoMinimo       || '';
    const estoqueMinLeg    = prod.estoque_min || prod.estoqueMinimo || 0;
    const pcMin            = prod.pc_min || 1;

    const consumoDia = previsaoMes > 0 ? previsaoMes / diasPeriodo : 0;
    const consumoSem = consumoDia * diasPorSem;

    const cobAtual = consumoDia > 0
      ? estoqueAtual / consumoDia
      : (estoqueAtual > 0 ? Infinity : 0);

    const estoqueAlvo = consumoDia > 0 ? consumoDia * cobAlvo : estoqueMinLeg;
    const estoqueTeto = consumoDia > 0 ? consumoDia * cobMax  : Infinity;

    const progExist  = jaProgSemanas[cod] || Array(nSemanas).fill(0);
    const totalProg  = progExist.reduce((a, v) => a + v, 0);

    // Cobertura projetada com tudo já programado
    let estProjFim = estoqueAtual;
    for (let s = 0; s < nSemanas; s++) {
      estProjFim += (progExist[s] || 0);
      estProjFim  = Math.max(0, estProjFim - consumoSem);
    }
    const cobProjFim = consumoDia > 0
      ? estProjFim / consumoDia
      : (estProjFim > 0 ? Infinity : 0);

    if (cobProjFim >= cobMax) return; // já coberto — skip

    // Prioridade por faixa
    let prioridadeFaixa;
    if      (cobAtual < cobMin)   prioridadeFaixa = 'alta';
    else if (cobAtual < cobAlert) prioridadeFaixa = 'media';
    else                          prioridadeFaixa = 'baixa';

    // Score de risco
    const cobAtualNum  = cobAtual === Infinity ? cobMax : cobAtual;
    const scoreRisco   = consumoDia * (cobMin - cobAtualNum);

    // Necessidade simulada semana a semana
    let estBase = estoqueAtual;
    let necAcum = 0;
    for (let s = 0; s < nSemanas; s++) {
      estBase += (progExist[s] || 0);
      estBase  = Math.max(0, estBase - consumoSem - (s === 0 ? pedidosAbertos : 0));
      if (s === nSemanas - 1) {
        const def = estoqueAlvo - estBase;
        if (def > 0) necAcum = def;
      }
    }

    // Necessidade bruta
    const necBruta = Math.max(
      0,
      necAcum > 0
        ? necAcum
        : (previsaoMes + pedidosAbertos + estoqueAlvo) - estoqueAtual - totalProg
    );
    if (necBruta <= 0) return;

    // Limitar pelo teto de faixa (45d)
    let necFinal = necBruta;
    if (consumoDia > 0) {
      const perm = Math.max(0, estoqueTeto - estoqueAtual - totalProg);
      necFinal   = Math.min(necBruta, perm);
    }
    if (necFinal <= 0) return;

    // ── CÁLCULO DE INSUMOS ────────────────────────────────────────────────────
    //
    // qtd_necessaria = o que o estoque exige (baseado em cobertura)
    // qtd_possivel   = limitado pelo insumo disponível neste momento
    //
    // Se há insumo com chegada prevista em semana X → qtd_possivel pode ser
    // maior a partir daquela semana (o motor usa chegadaSemana para isso).
    //
    const fatorInsumo   = consumoInsumo[cod] || 0;  // unidades de insumo por caixa
    const insumoInfo    = insumos[cod] || null;

    let qtdNecessaria = aplicarMinimoEMultiplo(necFinal, producaoMinima, multiploProducao, tipoMinimo);
    let qtdPossivel   = qtdNecessaria; // sem restrição de insumo por padrão
    let temInsumoFalta = false;
    let insumoDisponivel  = null;
    let insumoChegaSemana = null;

    if (fatorInsumo > 0 && insumoInfo) {
      insumoDisponivel  = insumoInfo.disponivel || 0;
      insumoChegaSemana = insumoInfo.chegadaSemana || null;

      // Caixas possíveis com insumo atual
      const cxPossivel = Math.floor(insumoDisponivel / fatorInsumo);

      if (cxPossivel < qtdNecessaria) {
        temInsumoFalta = true;
        qtdPossivel    = aplicarMinimoEMultiplo(
          Math.min(cxPossivel, necFinal),
          producaoMinima, multiploProducao, tipoMinimo
        );
        // Se qtdPossivel ficar negativa ou zero por arredondamento, zerar
        if (qtdPossivel < 0) qtdPossivel = 0;
      }
    }

    // ── DECISÃO: INSUMO AUTOMÁTICO + OVERRIDE MANUAL ──────────────────────────
    //
    // Ordem de prioridade das decisões:
    //
    //   1. Usuário definiu quantidade/semana manualmente → respeitar sempre
    //   2. Insumo ok (sem falta) → produzir qtdNecessaria, semana automática
    //   3. Falta insumo + chegada prevista → programar qtdNecessaria na semana
    //      de chegada AUTOMATICAMENTE (sem pedir decisão ao usuário)
    //   4. Falta insumo + sem chegada + tem estoque parcial → produzir
    //      qtdPossivel agora, semana automática
    //   5. Falta insumo + sem chegada + sem estoque → BLOQUEAR (não programar)
    //
    const decisao      = decisoesUsuario[cod] || {};
    const temOverride  = decisao.quantidade != null || decisao.semanaFixa != null;

    let qtdFinal;
    let semanaFixa;
    let bloqueadoPorInsumo = false;
    let semanaAutoInsumo   = null; // semana determinada automaticamente pelo insumo

    if (temOverride) {
      // ── Caso 1: usuário decidiu manualmente ─────────────────────────────────
      qtdFinal   = decisao.quantidade != null ? decisao.quantidade : qtdNecessaria;
      semanaFixa = decisao.semanaFixa != null ? decisao.semanaFixa : null;

    } else if (!temInsumoFalta) {
      // ── Caso 2: insumo ok — produção normal ─────────────────────────────────
      qtdFinal   = qtdNecessaria;
      semanaFixa = null;

    } else if (insumoChegaSemana != null) {
      // ── Caso 3: falta insumo mas tem chegada prevista ────────────────────────
      // Programar automaticamente para a semana de chegada.
      // Produz o necessário total (insumo chegará antes da produção começar).
      qtdFinal        = qtdNecessaria;
      semanaFixa      = insumoChegaSemana;
      semanaAutoInsumo = insumoChegaSemana;

    } else if (qtdPossivel > 0) {
      // ── Caso 4: falta insumo, sem chegada, mas tem estoque parcial ───────────
      // Produzir apenas o possível com o insumo disponível.
      qtdFinal   = qtdPossivel;
      semanaFixa = null;

    } else {
      // ── Caso 5: sem insumo e sem chegada → BLOQUEAR ──────────────────────────
      // Não gerar ordem de produção — produto marcado como bloqueado.
      // Aparece no resultado com quantidade = 0 e status 'bloqueado'
      // para que a UI possa exibir o alerta ao usuário.
      bloqueadoPorInsumo = true;
      qtdFinal   = 0;
      semanaFixa = null;
    }

    // Garantir que não ultrapasse o teto mesmo com override manual
    if (!bloqueadoPorInsumo && consumoDia > 0) {
      const teto = Math.max(0, estoqueTeto - estoqueAtual - totalProg);
      qtdFinal   = Math.min(qtdFinal, teto);
    }

    // Produto bloqueado por insumo → registrar no resultado mas não programar
    if (bloqueadoPorInsumo || qtdFinal <= 0) {
      if (temInsumoFalta && !insumoChegaSemana && qtdPossivel <= 0) {
        // Incluir no resultado apenas para exibir o alerta na UI
        resultado.push({
          produto:             nome,
          codigo:              cod,
          maquina:             (maquinas.find(m => m.produtos?.includes(cod))?.nome) || null,
          qtdNecessaria,
          qtdPossivel:         0,
          quantidade:          0,
          quantidade_bruta:    Math.ceil(necFinal),
          insumoStatus:        'bloqueado',
          temInsumoFalta:      true,
          insumoDisponivel,
          insumoChegaSemana:   null,
          fatorInsumo,
          estoqueAlvo:         Math.ceil(estoqueAlvo),
          estoqueTeto:         Math.ceil(estoqueTeto),
          coberturaAtual:      cobAtual === Infinity ? null : +cobAtual.toFixed(1),
          cobProjetada:        cobProjFim === Infinity ? null : +cobProjFim.toFixed(1),
          coberturaMin:        cobMin,
          coberturaMax:        cobMax,
          coberturaAlvo:       cobAlvo,
          prioridadeFaixa,
          scoreRisco:          +scoreRisco.toFixed(2),
          urgente:             prioridadeFaixa === 'alta',
          consumoMedioDia:     +consumoDia.toFixed(2),
          jaProgTotal:         totalProg,
          tipoMinimo,
          prioridade:          prod.prioridadeProducao || 2,
          tempo_total_min:     0,
          dias_producao:       0,
          caixasPorSemana:     Array(nSemanas).fill(0),
          semanasAtivas:       [],
          semanaFixa:          null,
          semanaAutoInsumo:    null,
          decisaoManual:       false
        });
      }
      return; // não entra nos candidatos para alocação
    }

    const maqsProd = maquinas.filter(m => m.produtos && m.produtos.includes(cod));
    if (!maqsProd.length) return;

    const tempoTotal = qtdFinal / pcMin;

    candidatos.push({
      produto:             nome,
      codigo:              cod,
      // ── Quantidades ──────────────────────────────────────────────────
      qtdNecessaria,        // o que a cobertura pede
      qtdPossivel,          // máximo com insumo atual
      qtdFinal,             // o que vai ser produzido (após override)
      quantidade:           qtdFinal, // alias para compatibilidade
      quantidade_bruta:     Math.ceil(necFinal),
      // ── Insumo ───────────────────────────────────────────────────────
      temInsumoFalta,
      insumoDisponivel,
      insumoChegaSemana,
      fatorInsumo,
      // ── Estoque / cobertura ──────────────────────────────────────────
      estoqueAlvo:          Math.ceil(estoqueAlvo),
      estoqueTeto:          Math.ceil(estoqueTeto),
      coberturaAtual:       cobAtual === Infinity ? null : +cobAtual.toFixed(1),
      cobProjetada:         cobProjFim === Infinity ? null : +cobProjFim.toFixed(1),
      coberturaMin:         cobMin,
      coberturaMax:         cobMax,
      coberturaAlvo:        cobAlvo,
      // ── Prioridade ───────────────────────────────────────────────────
      prioridadeFaixa,
      scoreRisco:           +scoreRisco.toFixed(2),
      urgente:              prioridadeFaixa === 'alta',
      // ── Produção ─────────────────────────────────────────────────────
      consumoMedioDia:      +consumoDia.toFixed(2),
      jaProgTotal:          totalProg,
      tipoMinimo,
      producaoMinima,
      multiploProducao,
      pcMin,
      prioridade:           prod.prioridadeProducao || 2,
      tempo_min:            tempoTotal,
      maquinas:             maqsProd.map(m => m.nome),
      // ── Controle manual / automático ─────────────────────────────────
      semanaFixa,                         // null = auto | 1..N = fixado
      semanaAutoInsumo,                   // semana determinada automaticamente pelo insumo
      decisaoManual:       temOverride    // true = usuário interveio
    });
  });

  // ── FASE 2: ORDENAR POR RISCO REAL ───────────────────────────────────────────
  //
  // Produtos com semanaFixa sempre passam na frente dos sem semana fixa
  // dentro do mesmo nível de prioridade — garantindo que o slot reservado
  // seja alocado antes que outros produtos tomem aquela capacidade.
  //
  const ordemFaixa = { alta: 0, media: 1, baixa: 2 };

  candidatos.sort((a, b) => {
    // Decisão manual primeiro (usuário já decidiu — respeitar)
    if (a.decisaoManual !== b.decisaoManual) return a.decisaoManual ? -1 : 1;
    if (a.prioridade !== b.prioridade) return a.prioridade - b.prioridade;
    if (ordemFaixa[a.prioridadeFaixa] !== ordemFaixa[b.prioridadeFaixa])
      return ordemFaixa[a.prioridadeFaixa] - ordemFaixa[b.prioridadeFaixa];
    if (b.scoreRisco !== a.scoreRisco) return b.scoreRisco - a.scoreRisco;
    const covA = a.coberturaAtual === null ? Infinity : a.coberturaAtual;
    const covB = b.coberturaAtual === null ? Infinity : b.coberturaAtual;
    return covA - covB;
  });

  // ── FASE 3: BANCO DE CAPACIDADE POR MÁQUINA/SEMANA ───────────────────────────
  const capacidade = {}; // { nomeMaquina: [min_s1, min_s2, ...] }
  maquinas.forEach(maq => {
    const minSem = (jornada[maq.nome] || 8) * 60 * diasPorSem;
    capacidade[maq.nome] = Array(nSemanas).fill(minSem);
  });

  // Descontar produção já programada
  Object.entries(jaProgSemanas).forEach(([cod, arr]) => {
    const p = produtos.find(x => (x.codigo || x.cod) === cod);
    if (!p) return;
    const maqs = maquinas.filter(m => m.produtos && m.produtos.includes(cod));
    if (!maqs.length) return;
    const maqNome  = maqs[0].nome;
    const pcMinPrd = p.pc_min || 1;
    arr.forEach((cx, s) => {
      if (cx > 0 && capacidade[maqNome]) {
        capacidade[maqNome][s] = Math.max(0, capacidade[maqNome][s] - cx / pcMinPrd);
      }
    });
  });

  // ── FASE 4: ALOCAÇÃO NÃO-LINEAR ──────────────────────────────────────────────
  const resultado = [];

  candidatos.forEach(item => {
    const maqNome = item.maquinas[0];
    const capSem  = capacidade[maqNome];
    if (!capSem) return;

    const fracMax = item.urgente ? FRAC_CRITICO_POR_SEMANA : FRAC_NORMAL_POR_SEMANA;

    // ── Reconstituir estoque semana a semana com o que já foi programado ──────
    // Usado para simular a cobertura dinamicamente durante a alocação,
    // impedindo que o sistema continue alocando depois de atingir o alvo.
    //
    // estoqueSimSemana[s] = estoque projetado AO FIM da semana s
    // (antes de qualquer nova produção que estamos alocando agora)
    const progExistItem  = jaProgSemanas[item.codigo] || Array(nSemanas).fill(0);
    const consumoSemItem = item.consumoMedioDia * diasPorSem;
    const estoqueSimBase = Array(nSemanas).fill(0);
    let simAcc = estoque[item.codigo] || 0;
    for (let s = 0; s < nSemanas; s++) {
      simAcc += (progExistItem[s] || 0);
      simAcc  = Math.max(0, simAcc - consumoSemItem - (s === 0 ? (pedidos[item.codigo] || 0) : 0));
      estoqueSimBase[s] = simAcc;
    }

    /**
     * Simula a cobertura ao final da semana `s` adicionando `cxNova`
     * caixas nessa semana à projeção base.
     * Retorna a cobertura em dias ao fim dessa semana.
     */
    function coberturaAoFimDaSemana(s, cxNovaAcumAte_s) {
      if (item.consumoMedioDia <= 0) return Infinity;
      // Estoque na semana s = base + toda nova produção alocada até s
      const estFim = Math.max(0, estoqueSimBase[s] + cxNovaAcumAte_s);
      return estFim / item.consumoMedioDia;
    }

    let restante       = item.tempo_min;
    const alocMin      = Array(nSemanas).fill(0); // minutos por semana

    if (item.semanaFixa != null) {
      // ── SEMANA FIXA (escolha manual) ──────────────────────────────────────
      //
      // Toda a produção vai para a semana escolhida pelo usuário.
      // Controle de cobertura ainda aplicado: se ao alocar nessa semana
      // já atingir o alvo, para antes de encher tudo.
      // Transborda para semanas seguintes apenas se necessário.
      //
      const idx = Math.max(0, Math.min(item.semanaFixa - 1, nSemanas - 1));

      // Acumulado de caixas já alocadas (para simulação de cobertura)
      let cxAcum = 0;

      // Preencher a semana fixa primeiro
      const dispFix   = capSem[idx] * fracMax;
      const alocarFix = Math.min(restante, dispFix);
      // Verificar cobertura antes de alocar tudo de uma vez
      const cxFixMax  = Math.round(alocarFix * item.pcMin);
      const cxPermFix = calcularCxPermitidas(
        cxFixMax, cxAcum, idx, coberturaAoFimDaSemana, item.coberturaAlvo, item.pcMin
      );
      const minPermFix = cxPermFix / item.pcMin;
      alocMin[idx]    += minPermFix;
      capSem[idx]     -= minPermFix;
      restante        -= minPermFix;
      cxAcum          += cxPermFix;

      // Se transbordou, derramar para semanas seguintes (nunca anteriores)
      for (let s = idx + 1; s < nSemanas && restante > 0; s++) {
        const lim   = capSem[s] * fracMax;
        const cxMax = Math.round(Math.min(restante, lim) * item.pcMin);
        const cxPerm = calcularCxPermitidas(
          cxMax, cxAcum, s, coberturaAoFimDaSemana, item.coberturaAlvo, item.pcMin
        );
        if (cxPerm <= 0) break; // cobertura ideal atingida — parar
        const minPerm = cxPerm / item.pcMin;
        alocMin[s]   += minPerm;
        capSem[s]    -= minPerm;
        restante     -= minPerm;
        cxAcum       += cxPerm;
      }

      // Produto crítico com sobra e sem capacidade → forçar na última semana
      if (restante > 0 && item.urgente) {
        alocMin[nSemanas - 1] += restante;
      }

    } else {
      // ── ALOCAÇÃO AUTOMÁTICA CONCENTRADA (não-linear) ──────────────────────
      //
      // Preencher semana 1 → 2 → 3 → 4 na ordem.
      // A cada semana, simular o estoque acumulado. Se a cobertura projetada
      // ao fim dessa semana já atingir coberturaAlvo (~38d), PARAR.
      // Isso evita subir direto para 45d sem necessidade.
      //
      let cxAcum = 0; // caixas novas alocadas até agora (acumulado multi-semana)

      for (let s = 0; s < nSemanas && restante > 0; s++) {
        const lim   = capSem[s] * fracMax;
        const cxMax = Math.round(Math.min(restante, lim) * item.pcMin);

        // Quantas caixas podemos alocar nesta semana sem ultrapassar coberturaAlvo?
        const cxPerm = calcularCxPermitidas(
          cxMax, cxAcum, s, coberturaAoFimDaSemana, item.coberturaAlvo, item.pcMin
        );

        if (cxPerm <= 0) break; // cobertura ideal atingida — parar de alocar

        const minPerm = cxPerm / item.pcMin;
        alocMin[s]   += minPerm;
        capSem[s]    -= minPerm;
        restante     -= minPerm;
        cxAcum       += cxPerm;
      }

      // Produto crítico sem capacidade → garantir na última semana
      if (restante > 0 && item.urgente) {
        alocMin[nSemanas - 1] += restante;
      }
    }

    // Converter minutos → caixas por semana
    const caixasPorSemana = alocMin.map(min => Math.round(min * item.pcMin));

    const semanasAtivas = caixasPorSemana.reduce((acc, cx, i) => {
      if (cx > 0) acc.push(i + 1);
      return acc;
    }, []);

    const minTotal     = alocMin.reduce((a, v) => a + v, 0);
    const diasProducao = Math.ceil(minTotal / ((jornada[maqNome] || 8) * 60));

    // ── STATUS DE INSUMO ──────────────────────────────────────────────────────
    //
    // insumoStatus resume a situação para a UI:
    //   'ok'          — sem problema de insumo
    //   'parcial'     — pode produzir parte agora, restante aguarda insumo
    //   'aguardando'  — insumo previsto para semana X, programar lá
    //   'bloqueado'   — sem insumo e sem previsão de chegada
    //
    let insumoStatus = 'ok';
    if (item.temInsumoFalta) {
      if (item.insumoChegaSemana != null) {
        insumoStatus = item.insumoDisponivel > 0 ? 'parcial' : 'aguardando';
      } else {
        insumoStatus = item.insumoDisponivel > 0 ? 'parcial' : 'bloqueado';
      }
    }

    resultado.push({
      produto:             item.produto,
      codigo:              item.codigo,
      maquina:             maqNome,

      // ── Quantidades (sempre as duas + a escolhida) ──────────────────
      qtdNecessaria:       item.qtdNecessaria,   // o que a cobertura pede
      qtdPossivel:         item.qtdPossivel,      // máximo com insumo atual
      quantidade:          item.qtdFinal,         // o que vai ser produzido
      quantidade_bruta:    item.quantidade_bruta,

      // ── Insumo ───────────────────────────────────────────────────────
      insumoStatus,               // 'ok' | 'parcial' | 'aguardando' | 'bloqueado'
      temInsumoFalta:    item.temInsumoFalta,
      insumoDisponivel:  item.insumoDisponivel,
      insumoChegaSemana: item.insumoChegaSemana,
      fatorInsumo:       item.fatorInsumo,

      // ── Cobertura ────────────────────────────────────────────────────
      estoqueAlvo:         item.estoqueAlvo,
      estoqueTeto:         item.estoqueTeto,
      coberturaAtual:      item.coberturaAtual,
      cobProjetada:        item.cobProjetada,
      coberturaMin:        item.coberturaMin,
      coberturaMax:        item.coberturaMax,
      coberturaAlvo:       item.coberturaAlvo,

      // ── Prioridade ───────────────────────────────────────────────────
      prioridadeFaixa:     item.prioridadeFaixa,
      scoreRisco:          item.scoreRisco,
      urgente:             item.urgente,

      // ── Produção ─────────────────────────────────────────────────────
      consumoMedioDia:     item.consumoMedioDia,
      jaProgTotal:         item.jaProgTotal,
      tipoMinimo:          item.tipoMinimo,
      prioridade:          item.prioridade,
      tempo_total_min:     item.tempo_min,
      dias_producao:       diasProducao,

      // ── Distribuição por semana ───────────────────────────────────────
      caixasPorSemana,     // [cx_s1, cx_s2, cx_s3, cx_s4]
      semanasAtivas,       // [1, 2]

      // ── Controle manual / automático ─────────────────────────────────
      semanaFixa:          item.semanaFixa,
      semanaAutoInsumo:    item.semanaAutoInsumo,  // semana auto pelo insumo
      decisaoManual:       item.decisaoManual
    });
  });

  return resultado;
}

// ============================================================
// HELPER: recalcular após mudança manual
// ============================================================

/**
 * Atualiza decisoesUsuario com uma escolha do usuário e retorna
 * um novo objeto `decisoesUsuario` pronto para ser passado de volta
 * ao gerarPlanejamento().
 *
 * Uso típico no frontend:
 *
 *   // Usuário escolheu produzir só o possível pelo insumo na semana 3:
 *   const novasDecisoes = aplicarDecisao(decisoesAtuais, 'COD123', {
 *     quantidade: item.qtdPossivel,
 *     semanaFixa: 3
 *   });
 *   const novoPlan = gerarPlanejamento({ ...params, decisoesUsuario: novasDecisoes });
 *
 * @param {Object} decisoesAtuais   — decisoesUsuario atual
 * @param {String} cod              — código do produto alterado
 * @param {Object} mudanca          — { quantidade?, semanaFixa? }
 * @returns {Object}                — novo decisoesUsuario (imutável — não muta o original)
 */
export function aplicarDecisao(decisoesAtuais, cod, mudanca) {
  return {
    ...decisoesAtuais,
    [cod]: {
      ...(decisoesAtuais[cod] || {}),
      ...mudanca
    }
  };
}

/**
 * Remove a decisão manual de um produto, voltando ao modo automático.
 *
 * @param {Object} decisoesAtuais
 * @param {String} cod
 * @returns {Object}
 */
export function removerDecisao(decisoesAtuais, cod) {
  const novo = { ...decisoesAtuais };
  delete novo[cod];
  return novo;
}

/**
 * Remove TODAS as decisões manuais — volta ao modo 100% automático.
 *
 * @returns {Object} objeto vazio
 */
export function resetarDecisoes() {
  return {};
}

// ============================================================
// HELPER: aplicar mínimo e múltiplo (interno)
// ============================================================

/**
 * Calcula quantas caixas podemos alocar numa semana sem ultrapassar coberturaAlvo.
 *
 * @param {Number}   cxMaxDisponivel  — máximo de caixas que cabem (capacidade × fracMax)
 * @param {Number}   cxJaAlocadas     — caixas novas já alocadas em semanas anteriores
 * @param {Number}   semanaIdx        — índice da semana corrente (0-based)
 * @param {Function} cobFn            — coberturaAoFimDaSemana(s, cxAcum) → dias
 * @param {Number}   cobAlvo          — cobertura alvo em dias (ex: 38)
 * @param {Number}   pcMin            — caixas por minuto (não usado diretamente, reservado)
 * @returns {Number} caixas permitidas (inteiro ≥ 0)
 */
function calcularCxPermitidas(cxMaxDisponivel, cxJaAlocadas, semanaIdx, cobFn, cobAlvo, pcMin) {
  if (cxMaxDisponivel <= 0) return 0;

  // Cobertura sem nenhuma caixa nova nesta semana
  const cobSemNova = cobFn(semanaIdx, cxJaAlocadas);
  if (cobSemNova >= cobAlvo) return 0; // já atingiu o alvo — parar

  // Cobertura com todo o máximo disponível desta semana
  const cobComTudo = cobFn(semanaIdx, cxJaAlocadas + cxMaxDisponivel);
  if (cobComTudo <= cobAlvo) return cxMaxDisponivel; // tudo cabe sem ultrapassar

  // Busca binária: achar quantas caixas levam a cobertura exatamente até cobAlvo
  // 20 iterações → precisão sub-unitária (< 1 caixa de erro)
  let low  = 0;
  let high = cxMaxDisponivel;
  for (let i = 0; i < 20; i++) {
    const mid = Math.floor((low + high) / 2);
    const cob = cobFn(semanaIdx, cxJaAlocadas + mid);
    if (cob < cobAlvo) low  = mid + 1;
    else               high = mid;
  }
  return Math.max(0, low);
}

function aplicarMinimoEMultiplo(necessidade, producaoMinima, multiploProducao, tipoMinimo) {
  let qtd = necessidade;

  if (producaoMinima > 0 && qtd < producaoMinima) qtd = producaoMinima;

  if (tipoMinimo === 'multiplo' && multiploProducao > 0) {
    qtd = Math.ceil(qtd / multiploProducao) * multiploProducao;
  } else if (tipoMinimo === 'palete' && producaoMinima > 0) {
    qtd = Math.ceil(qtd / producaoMinima) * producaoMinima;
  } else if (tipoMinimo === 'fixo') {
    qtd = Math.ceil(qtd);
  } else {
    qtd = Math.ceil(qtd);
    if (multiploProducao > 0) {
      qtd = Math.ceil(qtd / multiploProducao) * multiploProducao;
    }
  }

  return qtd;
}
