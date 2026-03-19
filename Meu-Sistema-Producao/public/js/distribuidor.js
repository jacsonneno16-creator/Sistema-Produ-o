// ============================================================
// DISTRIBUIDOR DE PRODUÇÃO — v2
// ============================================================
//
// Resolve dois problemas do sistema anterior:
//
//  1. CONCENTRAÇÃO NA SEGUNDA-FEIRA
//     O sistema colocava todos os produtos para iniciar na segunda
//     porque dtDesejada = segunda da semana. Agora, para cada produto
//     programado numa semana, calculamos o MELHOR DIA DE INÍCIO com
//     base na carga real já ocupada em cada dia da máquina.
//
//  2. QUANTIDADE MAIOR QUE A CAPACIDADE REAL
//     O sistema permitia programar qntCaixas que não cabiam no tempo
//     disponível da semana. Agora validamos antes de confirmar:
//     se não couber tudo, a quantidade é truncada para o que cabe,
//     e o excedente é sinalizado para ir à semana seguinte.
//
// API pública:
//   calcularMelhorDiaInicio(monday, maq, tempoNecessarioMin, cargaExistente?)
//   validarCapacidadeRegistro(reg, monday, cargaExistente?, pcMin?, getHoursFn?)
//   distribuirProducao(planejamento, maquinas, jornada, monday?)
//   construirCargaSemanal(schedule)
//
// ============================================================

// ──────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 1: calcularMelhorDiaInicio
// ──────────────────────────────────────────────────────────────────────────────
//
// Para cada produto programado numa semana, em vez de sempre jogar na segunda,
// encontra o DIA COM MAIS CAPACIDADE LIVRE para iniciar.
//
// Critérios (em ordem):
//   1. Prefere dia onde TUDO cabe sem fragmentar (produção concentrada)
//   2. Entre os dias onde tudo cabe, escolhe o que tem MAIS horas livres
//   3. Em empate de horas livres, prefere o mais ADIANTADO na semana
//      (quinta > quarta > terça > segunda — distribui carga ao longo da semana)
//   4. Se não couber em nenhum dia inteiro, escolhe o com maior capacidade livre
//
// @param {Date}     monday               — segunda-feira da semana
// @param {String}   maq                  — nome da máquina
// @param {Number}   tempoNecessarioMin    — minutos totais necessários
// @param {Object}   [cargaExistente]      — { 'YYYY-MM-DD': minutosJaUsados }
// @param {Function} [getHoursFn]          — fn(Date, maq) → horas disponíveis
// @returns {String} dateStr do melhor dia ('YYYY-MM-DD')
//
export function calcularMelhorDiaInicio(monday, maq, tempoNecessarioMin, cargaExistente = {}, getHoursFn = null) {
  const days      = _getWeekDays(monday);
  const hrsFunction = getHoursFn || _hoursOnDayMaqSafe;

  // Calcular capacidade livre por dia (apenas dias com jornada > 0)
  const livres = days.map(d => {
    const ds       = _dateStr(d);
    const capMin   = hrsFunction(d, maq) * 60;
    const usadoMin = cargaExistente[ds] || 0;
    const livreMin = Math.max(0, capMin - usadoMin);
    return { d, ds, capMin, livreMin };
  }).filter(x => x.capMin > 0);

  if (!livres.length) return _dateStr(days[0]); // fallback: segunda

  // Caso 1: dias onde tudo cabe de uma vez (sem fragmentar)
  const cabeTudo = livres.filter(x => x.livreMin >= tempoNecessarioMin);
  if (cabeTudo.length > 0) {
    // Ordenar: mais livre primeiro; empate → mais adiantado na semana (evitar segunda)
    cabeTudo.sort((a, b) => {
      const delta = b.livreMin - a.livreMin;
      if (Math.abs(delta) > 1) return delta;
      return b.d.getDay() - a.d.getDay(); // qui(4) > qua(3) > ter(2) > seg(1)
    });
    return cabeTudo[0].ds;
  }

  // Caso 2: não cabe em nenhum dia inteiro — dia com MAIS capacidade livre
  livres.sort((a, b) => {
    const delta = b.livreMin - a.livreMin;
    if (Math.abs(delta) > 1) return delta;
    return b.d.getDay() - a.d.getDay();
  });

  return livres[0].ds;
}

// ──────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 2: validarCapacidadeRegistro
// ──────────────────────────────────────────────────────────────────────────────
//
// Verifica se a quantidade programada (qntCaixas) cabe no tempo disponível
// da máquina nesta semana. Se não couber: trunca para o que cabe e retorna
// o excedente.
//
// Garante que o Gantt NUNCA mostre uma barra de produção impossível.
//
// @param {Object}   reg               — registro de produção
//   reg.maquina       — nome da máquina
//   reg.qntCaixas     — quantidade programada (caixas)
//   reg.dtDesejada    — 'YYYY-MM-DD' do dia de início (pode ser null)
// @param {Date}     monday            — segunda-feira da semana alvo
// @param {Object}   [cargaExistente]  — { 'YYYY-MM-DD': minutosJaUsados }
// @param {Number}   [pcMin]           — caixas por minuto (taxa de produção)
// @param {Function} [getHoursFn]      — fn(Date, maq) → horas disponíveis
//
// @returns {Object}
//   .qtdCabe          — caixas que realmente cabem nesta semana
//   .qtdExcedente     — caixas para a próxima semana (0 = nenhum)
//   .minutosLivres    — minutos disponíveis a partir de dtDesejada até domingo
//   .minutosNecessarios — tempo necessário para produzir qtdCabe
//   .overflow         — true se há excedente
//   .melhorDiaInicio  — dateStr do melhor dia para iniciar
//
export function validarCapacidadeRegistro(reg, monday, cargaExistente = {}, pcMin = 1, getHoursFn = null) {
  const maq           = reg.maquina;
  const qntSolicitada = reg.qntCaixas || 0;
  const hrsFunction   = getHoursFn || _hoursOnDayMaqSafe;
  const days          = _getWeekDays(monday);
  const mondayStr     = _dateStr(days[0]);
  const sundayStr     = _dateStr(days[6]);

  // Dia de início: dtDesejada se dentro desta semana, senão segunda
  let inicioStr = reg.dtDesejada || mondayStr;
  if (inicioStr < mondayStr || inicioStr > sundayStr) inicioStr = mondayStr;

  // Somar minutos livres a partir do dia de início
  let minutosLivresTotal = 0;
  for (const d of days) {
    const ds = _dateStr(d);
    if (ds < inicioStr) continue;
    const capMin   = hrsFunction(d, maq) * 60;
    const usadoMin = cargaExistente[ds] || 0;
    minutosLivresTotal += Math.max(0, capMin - usadoMin);
  }

  const minutosNecessarios = pcMin > 0 ? qntSolicitada / pcMin : 0;

  // Melhor dia de início baseado na carga existente
  const melhorDiaInicio = calcularMelhorDiaInicio(
    monday, maq, minutosNecessarios, cargaExistente, getHoursFn
  );

  if (minutosLivresTotal >= minutosNecessarios) {
    // Tudo cabe — sem overflow
    return {
      qtdCabe:            qntSolicitada,
      qtdExcedente:       0,
      minutosLivres:      minutosLivresTotal,
      minutosNecessarios,
      overflow:           false,
      melhorDiaInicio
    };
  }

  // Não cabe tudo — truncar
  const qtdCabe      = pcMin > 0 ? Math.floor(minutosLivresTotal * pcMin) : 0;
  const qtdExcedente = Math.max(0, qntSolicitada - qtdCabe);

  return {
    qtdCabe:            Math.max(0, qtdCabe),
    qtdExcedente,
    minutosLivres:      minutosLivresTotal,
    minutosNecessarios: pcMin > 0 ? qtdCabe / pcMin : 0,
    overflow:           qtdExcedente > 0,
    melhorDiaInicio
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 3: construirCargaSemanal
// ──────────────────────────────────────────────────────────────────────────────
//
// Constrói o mapa de carga real por máquina por dia a partir do schedule
// já calculado pelo buildSchedule() do Gantt.
// Use isso para obter cargaExistente antes de chamar validarCapacidadeRegistro
// ou calcularMelhorDiaInicio.
//
// @param {Object} schedule — resultado de buildSchedule().schedule
// @returns {Object} { [maquina]: { 'YYYY-MM-DD': minutosUsados } }
//
export function construirCargaSemanal(schedule) {
  const carga = {};
  for (const [maq, entries] of Object.entries(schedule)) {
    if (!carga[maq]) carga[maq] = {};
    for (const { segments = [], setupSegments = [] } of entries) {
      for (const seg of segments) {
        carga[maq][seg.date] = (carga[maq][seg.date] || 0) + (seg.useMin || 0);
      }
      for (const seg of setupSegments) {
        carga[maq][seg.date] = (carga[maq][seg.date] || 0) + (seg.setupMin || 0);
      }
    }
  }
  return carga;
}

// ──────────────────────────────────────────────────────────────────────────────
// FUNÇÃO 4: distribuirProducao (compatibilidade com código legado)
// ──────────────────────────────────────────────────────────────────────────────
//
// Mantém a mesma assinatura do distribuidor original.
// Agora inclui melhorDiaInicio e validação de capacidade real.
//
export function distribuirProducao(planejamento, maquinas, jornada, monday = null) {
  const resultado     = [];
  const cargaMaquinas = {};

  // Inicializar capacidade por máquina
  maquinas.forEach(m => {
    const horas = jornada[m.nome] || 8;
    cargaMaquinas[m.nome] = {
      capacidadeMin: horas * 60,
      usado:         0,
      cargaDiaria:   {}  // { 'YYYY-MM-DD': minutosUsados }
    };
  });

  const mondayDate = monday || _getThisMonday();

  planejamento.forEach(item => {
    const maquinasPossiveis = maquinas.filter(m =>
      m.produtos && m.produtos.includes(item.codigo)
    );
    if (!maquinasPossiveis.length) return;

    const pcMin     = item.pcMin || item.pc_min || 1;
    const qtdTotal  = item.quantidade || item.qtdFinal || 0;
    let restanteMin = qtdTotal / pcMin;

    maquinasPossiveis.forEach(maquina => {
      if (restanteMin <= 0.001) return;

      const carga = cargaMaquinas[maquina.nome];

      // Validar capacidade: o que realmente cabe nesta máquina esta semana?
      const validacao = validarCapacidadeRegistro(
        { maquina: maquina.nome, qntCaixas: restanteMin * pcMin, dtDesejada: null },
        mondayDate,
        carga.cargaDiaria,
        pcMin
      );

      if (validacao.qtdCabe <= 0) return; // máquina cheia

      const minUsado = validacao.qtdCabe / pcMin;
      carga.usado += minUsado;

      // Registrar carga no melhor dia calculado
      const dia = validacao.melhorDiaInicio;
      carga.cargaDiaria[dia] = (carga.cargaDiaria[dia] || 0) + minUsado;
      restanteMin -= minUsado;

      resultado.push({
        produto:       item.produto,
        codigo:        item.codigo,
        maquina:       maquina.nome,
        tempo_min:     minUsado,
        quantidade:    Math.round(validacao.qtdCabe),
        diaInicio:     validacao.melhorDiaInicio,  // melhor dia, não sempre segunda
        overflow:      validacao.overflow,
        qtdExcedente:  validacao.qtdExcedente
      });
    });
  });

  return {
    producao: resultado,
    carga:    cargaMaquinas
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS INTERNOS
// ──────────────────────────────────────────────────────────────────────────────

function _dateStr(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _getWeekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function _getThisMonday() {
  const d   = new Date();
  const day = d.getDay();
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Wrapper seguro para hoursOnDayMaq: usa a global do app.js se disponível
function _hoursOnDayMaqSafe(d, maq) {
  if (typeof hoursOnDayMaq === 'function') return hoursOnDayMaq(d, maq);
  if (typeof hoursOnDay    === 'function') return hoursOnDay(d);
  // Fallback hardcoded: seg-qui=9h, sex=8h, sáb-dom=0h
  const dayHrs = [0, 9, 9, 9, 9, 8, 0];
  return dayHrs[d.getDay()] || 0;
}
