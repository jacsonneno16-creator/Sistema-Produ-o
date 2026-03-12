export function gerarMapaFabrica(cargaMaquinas){
  const mapa = [];

  Object.keys(cargaMaquinas).forEach(maquina => {
    const capacidade = cargaMaquinas[maquina].capacidadeMin || 0;
    const usado = cargaMaquinas[maquina].usado || 0;
    const ocupacao = capacidade > 0 ? (usado / capacidade) * 100 : 0;

    mapa.push({
      maquina,
      capacidade,
      usado,
      ocupacao
    });
  });

  return mapa.sort((a,b)=>b.ocupacao-a.ocupacao);
}

export function renderMapaFabrica(mapa, container){
  let html = "";

  if (!mapa.length) {
    container.innerHTML = `
      <div class="empty-st" style="padding:20px">
        <div class="ei">🏭</div>
        Sem dados para o mapa da fábrica
      </div>
    `;
    return;
  }

  mapa.forEach(m => {
    const cor =
      m.ocupacao > 90 ? "#ff5252" :
      m.ocupacao > 70 ? "#ffa726" :
      "#2be4c3";

    html += `
      <div style="margin-bottom:20px;background:#161c23;padding:15px;border-radius:8px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <strong>${m.maquina}</strong>
          <span>${m.ocupacao.toFixed(1)}%</span>
        </div>

        <div style="width:100%;height:10px;background:#222;border-radius:6px;overflow:hidden">
          <div style="width:${Math.min(m.ocupacao,100)}%;height:10px;background:${cor};border-radius:6px"></div>
        </div>

        <div style="margin-top:6px;font-size:11px;color:#94a3b8">
          Usado: ${Math.round(m.usado)} min · Capacidade: ${Math.round(m.capacidade)} min
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}