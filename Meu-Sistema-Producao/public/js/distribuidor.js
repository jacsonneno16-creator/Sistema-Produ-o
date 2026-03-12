export function distribuirProducao(planejamento, maquinas, jornada) {

  const resultado = []
  const cargaMaquinas = {}

  maquinas.forEach(m => {
    const horas = jornada[m.nome] || 8
    cargaMaquinas[m.nome] = {
      capacidadeMin: horas * 60,
      usado: 0
    }
  })

  planejamento.forEach(item => {

    const maquinasPossiveis = maquinas.filter(m =>
      m.produtos.includes(item.codigo)
    )

    if (!maquinasPossiveis.length) return

    let restante = item.tempo_min

    maquinasPossiveis.forEach(maquina => {

      if (restante <= 0) return

      const carga = cargaMaquinas[maquina.nome]

      const livre = carga.capacidadeMin - carga.usado

      if (livre <= 0) return

      const usado = Math.min(livre, restante)

      carga.usado += usado
      restante -= usado

      resultado.push({
        produto: item.produto,
        codigo: item.codigo,
        maquina: maquina.nome,
        tempo_min: usado
      })

    })

  })

  return {
    producao: resultado,
    carga: cargaMaquinas
  }

}