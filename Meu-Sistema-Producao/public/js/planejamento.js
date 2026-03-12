// MOTOR DE PLANEJAMENTO AUTOMÁTICO

export function gerarPlanejamento({
  estoque,
  pedidos,
  escadinha,
  maquinas,
  produtos,
  jornada
}) {

  const planejamento = []

  produtos.forEach(prod => {

    const cod = prod.codigo
    const nome = prod.produto

    const estoqueAtual = estoque[cod] || 0
    const pedidosAbertos = pedidos[cod] || 0
    const previsao = escadinha[cod] || 0

    const estoqueMinimo = prod.estoque_min || 0

    const necessidade =
      pedidosAbertos +
      previsao +
      estoqueMinimo -
      estoqueAtual

    if (necessidade <= 0) return

    const maquinasProduto = maquinas.filter(m =>
      m.produtos.includes(cod)
    )

    if (!maquinasProduto.length) return

    const pcMin = prod.pc_min

    const tempoMin = necessidade / pcMin

    planejamento.push({
      produto: nome,
      codigo: cod,
      quantidade: Math.ceil(necessidade),
      tempo_min: tempoMin,
      maquinas: maquinasProduto.map(m => m.nome)
    })

  })

  return distribuirMaquinas(planejamento, maquinas, jornada)

}

function distribuirMaquinas(lista, maquinas, jornada){

  const resultado = []

  lista.forEach(item => {

    const maquina = maquinas.find(m =>
      item.maquinas.includes(m.nome)
    )

    if(!maquina) return

    const horasDia = jornada[maquina.nome] || 8
    const minutosDia = horasDia * 60

    const dias = Math.ceil(item.tempo_min / minutosDia)

    resultado.push({
      produto: item.produto,
      codigo: item.codigo,
      maquina: maquina.nome,
      quantidade: item.quantidade,
      tempo_total_min: item.tempo_min,
      dias_producao: dias
    })

  })

  return resultado

}