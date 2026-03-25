// =====================================================================
// MÓDULO DE RELATÓRIOS — PROGPROD MES
// Análise de produção, eficiência e tomada de decisão para PCP
// =====================================================================

(function() {
'use strict';

// ── Chart instances ────────────────────────────────────────────────
let _chartProdDia     = null;
let _chartMaquinas    = null;
let _chartTopProd     = null;
let _chartOciosidade  = null;

// ── Estado dos filtros ─────────────────────────────────────────────
let _relFiltros = {
  dataInicio: '',
  dataFim:    '',
  maquina:    '',
  produto:    ''
};
let _sortCol = 'eficiencia';
let _sortAsc = false;
let _tabelaBusca = '';

// ── Cache de dados calculados (evitar re-consulta desnecessária) ───
let _dadosCache = null;

// ── Horas de trabalho (11 horas: 7h–17h) ──────────────────────────
const HORAS_DIA = 11;
const MINUTOS_DIA = HORAS_DIA * 60;
const APON_H = [7,8,9,10,11,12,13,14,15,16,17];

// ─────────────────────────────────────────────────────────────────
// INICIALIZAÇÃO
// ─────────────────────────────────────────────────────────────────
function initRelatorios() {
  // Verificar permissão de visualizar
  if (typeof window.canAccess === 'function' && !window.canAccess('relatorios')) {
    const panel = document.getElementById('panel-relatorios');
    if (panel) panel.innerHTML = `
      <div style="padding:60px;text-align:center;color:var(--text3);font-size:14px">
        <div style="font-size:36px;margin-bottom:12px">🔒</div>
        <strong>Acesso negado</strong><br>Você não tem permissão para visualizar Relatórios.
      </div>`;
    return;
  }

  let panel = document.getElementById('panel-relatorios');

  // Se o painel não existir no HTML, criá-lo automaticamente
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'panel-relatorios';
    panel.className = 'panel';
    // Tentar inserir dentro do container principal de painéis
    const container = document.getElementById('main-content')
      || document.getElementById('content')
      || document.getElementById('app')
      || document.body;
    container.appendChild(panel);
  }

  // Injetar HTML completo do painel
  panel.innerHTML = buildRelatoriosHTML();

  // Preencher defaults de data
  const hoje = new Date();
  const primeiroDia = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  document.getElementById('rel2-data-inicio').value = _fmtDateInput(primeiroDia);
  document.getElementById('rel2-data-fim').value    = _fmtDateInput(hoje);

  // Preencher filtros com dados do sistema
  _popularFiltros();

  // Renderizar
  renderRelatorios();
}

// ─────────────────────────────────────────────────────────────────
// BUILD HTML
// ─────────────────────────────────────────────────────────────────
function buildRelatoriosHTML() {
  return `
<div id="rel2-root" style="min-height:100%;padding:0 0 40px 0">

  <!-- CABEÇALHO COM EXPORTAÇÕES -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;flex-wrap:wrap;gap:12px">
    <div>
      <div style="font-size:20px;font-weight:700;color:var(--text);letter-spacing:-.3px">📊 Relatórios de Produção</div>
      <div style="font-size:12px;color:var(--text3);margin-top:2px;font-family:'JetBrains Mono',monospace" id="rel2-last-update">—</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="relatorios.exportXLSX()" class="btn-rel-export" title="Exportar Excel">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10,9 9,9 8,9"/></svg>
        Excel
      </button>
      <button onclick="relatorios.exportPDF()" class="btn-rel-export" title="Exportar PDF">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><path d="M9 15v-4"/><path d="M12 15v-6"/><path d="M15 15v-2"/></svg>
        PDF
      </button>
      <button onclick="relatorios.exportImagem()" class="btn-rel-export" title="Exportar Imagem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>
        Imagem
      </button>
    </div>
  </div>

  <!-- ALERTAS INTELIGENTES -->
  <div id="rel2-alertas" style="margin-bottom:18px"></div>

  <!-- KPIs -->
  <div id="rel2-kpis" style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px"></div>

  <!-- FILTROS -->
  <div style="background:var(--s1);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin-bottom:20px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px;font-family:'JetBrains Mono',monospace">🔍 Filtros</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <div class="rel2-filter-group">
        <label class="rel2-filter-label">Data Início</label>
        <input type="date" id="rel2-data-inicio" class="rel2-input" oninput="relatorios.aplicarFiltros()">
      </div>
      <div class="rel2-filter-group">
        <label class="rel2-filter-label">Data Fim</label>
        <input type="date" id="rel2-data-fim" class="rel2-input" oninput="relatorios.aplicarFiltros()">
      </div>
      <div class="rel2-filter-group">
        <label class="rel2-filter-label">Máquina</label>
        <select id="rel2-maquina" class="rel2-input" onchange="relatorios.aplicarFiltros()">
          <option value="">Todas as máquinas</option>
        </select>
      </div>
      <div class="rel2-filter-group">
        <label class="rel2-filter-label">Produto</label>
        <select id="rel2-produto" class="rel2-input" onchange="relatorios.aplicarFiltros()">
          <option value="">Todos os produtos</option>
        </select>
      </div>
      <div style="display:flex;gap:6px;margin-top:16px;flex-wrap:wrap">
        <button onclick="relatorios.setPreset('hoje')"    class="btn-rel-preset" id="preset-hoje">Hoje</button>
        <button onclick="relatorios.setPreset('semana')"  class="btn-rel-preset" id="preset-semana">Semana</button>
        <button onclick="relatorios.setPreset('mes')"     class="btn-rel-preset" id="preset-mes">Mês</button>
        <button onclick="relatorios.setPreset('trim')"    class="btn-rel-preset" id="preset-trim">Trimestre</button>
        <button onclick="relatorios.limparFiltros()" style="background:none;border:1px solid var(--border);color:var(--text3);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-family:'Space Grotesk',sans-serif">✕ Limpar</button>
      </div>
    </div>
  </div>

  <!-- GRÁFICOS - LINHA 1 -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <div class="rel2-card">
      <div class="rel2-card-hd">
        <span>📈 Produção por Período</span>
        <div style="display:flex;gap:6px">
          <button onclick="relatorios.toggleChartType('producaoDia')" id="btn-chart-tipo" class="btn-rel-sm">Barras</button>
        </div>
      </div>
      <div style="position:relative;height:220px">
        <canvas id="chart-producao-dia"></canvas>
        <div id="chart-producao-dia-empty" class="rel2-chart-empty" style="display:none">Sem dados no período</div>
      </div>
    </div>
    <div class="rel2-card">
      <div class="rel2-card-hd"><span>🏭 Produção por Máquina</span></div>
      <div style="position:relative;height:220px">
        <canvas id="chart-maquinas"></canvas>
        <div id="chart-maquinas-empty" class="rel2-chart-empty" style="display:none">Sem dados no período</div>
      </div>
    </div>
  </div>

  <!-- GRÁFICOS - LINHA 2 -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
    <div class="rel2-card">
      <div class="rel2-card-hd"><span>🏆 Top Produtos Produzidos</span></div>
      <div style="position:relative;height:220px">
        <canvas id="chart-top-produtos"></canvas>
        <div id="chart-top-produtos-empty" class="rel2-chart-empty" style="display:none">Sem dados no período</div>
      </div>
    </div>
    <div class="rel2-card">
      <div class="rel2-card-hd"><span>⏱ Distribuição de Tempo</span></div>
      <div style="display:flex;align-items:center;justify-content:center;height:220px;gap:24px">
        <div style="position:relative;width:160px;height:160px">
          <canvas id="chart-ociosidade"></canvas>
        </div>
        <div id="chart-ociosidade-legend" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>
      <div id="chart-ociosidade-empty" class="rel2-chart-empty" style="display:none">Sem dados no período</div>
    </div>
  </div>

  <!-- OCUPAÇÃO POR CATEGORIA -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
    <div class="rel2-card">
      <div class="rel2-card-hd"><span>🧩 Categoria de Produto</span></div>
      <div id="rel2-cat-prod" style="padding:14px 16px"></div>
    </div>
    <div class="rel2-card">
      <div class="rel2-card-hd"><span>🏷️ Categoria de Máquina</span></div>
      <div id="rel2-cat-maq" style="padding:14px 16px"></div>
    </div>
  </div>

  <!-- PLANEJADO vs REALIZADO -->
  <div class="rel2-card" style="margin-bottom:20px">
    <div class="rel2-card-hd"><span>🎯 Planejado vs Realizado por Máquina</span></div>
    <div id="rel2-pvr-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding-top:4px"></div>
    <div id="rel2-pvr-empty" style="display:none;padding:20px;text-align:center;color:var(--text3);font-size:12px">Sem dados no período selecionado</div>
  </div>

  <!-- TABELA ANALÍTICA -->
  <div class="rel2-card" style="margin-bottom:20px">
    <div class="rel2-card-hd">
      <span>📋 Tabela Analítica</span>
      <div style="display:flex;align-items:center;gap:8px">
        <div style="position:relative">
          <input type="text" id="rel2-tabela-busca" placeholder="Buscar..." class="rel2-input" style="padding-left:28px;min-width:160px" oninput="relatorios.filtrarTabela(this.value)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" style="position:absolute;left:8px;top:50%;transform:translateY(-50%)"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </div>
      </div>
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:680px">
        <thead>
          <tr style="background:var(--s2);border-bottom:1px solid var(--border)">
            ${_thSort('maquina','Máquina')}
            ${_thSort('produto','Produto')}
            ${_thSort('programado','Programado')}
            ${_thSort('realizado','Realizado')}
            ${_thSort('eficiencia','Eficiência %')}
            ${_thSort('setup','Setup (min)')}
            ${_thSort('ociosidade','Ociosidade')}
          </tr>
        </thead>
        <tbody id="rel2-tabela-body"></tbody>
      </table>
    </div>
    <div id="rel2-tabela-footer" style="padding:8px 12px;font-size:11px;color:var(--text3);border-top:1px solid var(--border)"></div>
  </div>

  <!-- COBERTURA DE ESTOQUE -->
  <div class="rel2-card" id="rel2-cobertura-card">
    <div class="rel2-card-hd"><span>📦 Cobertura de Estoque — Análise de Ruptura</span></div>
    <div id="rel2-cobertura-content"></div>
  </div>

</div>

<style>
.btn-rel-export {
  display:inline-flex;align-items:center;gap:6px;
  background:var(--s2);border:1px solid var(--border);color:var(--text2);
  border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;
  cursor:pointer;font-family:'Space Grotesk',sans-serif;
  transition:all .18s;
}
.btn-rel-export:hover { border-color:var(--cyan);color:var(--cyan); }
.btn-rel-sm {
  background:var(--s3);border:1px solid var(--border);color:var(--text3);
  border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;
  font-family:'Space Grotesk',sans-serif;transition:all .15s;
}
.btn-rel-sm:hover { border-color:var(--cyan);color:var(--cyan); }
.btn-rel-preset {
  background:var(--s3);border:1px solid var(--border);color:var(--text2);
  border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;
  font-family:'Space Grotesk',sans-serif;font-weight:600;transition:all .15s;
}
.btn-rel-preset:hover,.btn-rel-preset.active {
  background:rgba(242,101,34,.15);border-color:var(--cyan);color:var(--cyan);
}
.rel2-card {
  background:var(--s1);border:1px solid var(--border);border-radius:12px;
  padding:16px 18px;box-shadow:0 2px 12px rgba(0,0,0,.25);
}
.rel2-card-hd {
  display:flex;align-items:center;justify-content:space-between;
  font-size:12px;font-weight:700;color:var(--text2);
  text-transform:uppercase;letter-spacing:.6px;
  margin-bottom:14px;padding-bottom:10px;
  border-bottom:1px solid var(--border);
}
.rel2-filter-group { display:flex;flex-direction:column;gap:4px; }
.rel2-filter-label { font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text3); }
.rel2-input {
  background:var(--s2);border:1px solid var(--border);color:var(--text);
  padding:7px 10px;border-radius:7px;font-family:'Space Grotesk',sans-serif;
  font-size:12px;outline:none;transition:border-color .18s;min-width:130px;
}
.rel2-input:focus,.rel2-input:hover { border-color:var(--cyan); }
.rel2-chart-empty {
  position:absolute;inset:0;display:flex;align-items:center;
  justify-content:center;color:var(--text3);font-size:12px;
}
.rel2-kpi {
  background:var(--s1);border:1px solid var(--border);border-radius:12px;
  padding:16px 18px;position:relative;overflow:hidden;
  transition:transform .18s,border-color .18s;
}
.rel2-kpi:hover { transform:translateY(-1px);border-color:var(--border2); }
.rel2-kpi::before {
  content:'';position:absolute;top:0;left:0;width:3px;height:100%;border-radius:2px 0 0 2px;
}
.rel2-kpi-num { font-family:'JetBrains Mono',monospace;font-size:28px;font-weight:700;line-height:1;margin-bottom:4px; }
.rel2-kpi-label { font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:var(--text3); }
.rel2-kpi-delta { font-size:10px;font-weight:600;margin-top:4px; }
.rel2-alerta {
  display:flex;align-items:flex-start;gap:10px;
  border-radius:9px;padding:10px 14px;font-size:12px;margin-bottom:8px;
}
.rel2-sort-th {
  padding:9px 10px;text-align:left;
  font-family:'JetBrains Mono',monospace;font-size:9px;
  font-weight:600;text-transform:uppercase;letter-spacing:.8px;
  color:var(--text3);cursor:pointer;white-space:nowrap;
  user-select:none;transition:color .15s;
}
.rel2-sort-th:hover { color:var(--cyan); }
.rel2-sort-th.active { color:var(--cyan); }
.rel2-td { padding:9px 10px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:middle; }
tbody tr:hover td { background:rgba(255,255,255,.02); }
.rel2-badge {
  display:inline-block;padding:2px 8px;border-radius:5px;
  font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace;
}
.rel2-pvr-card {
  background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:14px;
}
.rel2-cob-row {
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 12px;border-radius:7px;margin-bottom:6px;font-size:12px;
}
</style>
`;
}

// ─────────────────────────────────────────────────────────────────
// POPULAR FILTROS (Máquinas e Produtos)
// ─────────────────────────────────────────────────────────────────
function _popularFiltros() {
  // Máquinas
  const maqSel = document.getElementById('rel2-maquina');
  const prodSel = document.getElementById('rel2-produto');
  if (!maqSel || !prodSel) return;

  const allRecs = _getRecords();
  const maqs = [...new Set(allRecs.map(r => r.maquina).filter(Boolean))].sort();
  const prods = [...new Set(allRecs.map(r => r.produto).filter(Boolean))].sort();

  maqSel.innerHTML = '<option value="">Todas as máquinas</option>' +
    maqs.map(m => `<option value="${m}">${m}</option>`).join('');
  prodSel.innerHTML = '<option value="">Todos os produtos</option>' +
    prods.map(p => `<option value="${_esc(p)}">${p}</option>`).join('');
}

// ─────────────────────────────────────────────────────────────────
// RENDERIZAÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────
function renderRelatorios() {
  const panel = document.getElementById('panel-relatorios');
  if (!panel || !document.getElementById('rel2-root')) {
    initRelatorios();
    return;
  }
  // Ler filtros
  _relFiltros.dataInicio = document.getElementById('rel2-data-inicio')?.value || '';
  _relFiltros.dataFim    = document.getElementById('rel2-data-fim')?.value    || '';
  _relFiltros.maquina    = document.getElementById('rel2-maquina')?.value     || '';
  _relFiltros.produto    = document.getElementById('rel2-produto')?.value     || '';

  // Timestamp de atualização
  const lblUpdate = document.getElementById('rel2-last-update');
  if (lblUpdate) {
    lblUpdate.textContent = 'Atualizado em ' + new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  }

  // Invalidar cache ao renderizar (filtros mudaram)
  _dadosCache = null;
  const dados = _calcularDados();

  _renderKPIs(dados);
  _renderAlertas(dados);
  _renderChartProducaoDia(dados);
  _renderChartMaquinas(dados);
  _renderChartTopProdutos(dados);
  _renderChartOciosidade(dados);
  _renderPlanejadoRealizado(dados);
  _renderTabela(dados);
  _renderCobertura();
}

// ─────────────────────────────────────────────────────────────────
// CÁLCULO DE DADOS — usa getDadosFiltrados() como base única
// ─────────────────────────────────────────────────────────────────
function _calcularDados() {
  // Retornar cache se disponível
  if (_dadosCache) return _dadosCache;

  const { recs, realizadoMap } = getDadosFiltrados();
  const inicio = _relFiltros.dataInicio;
  const fim    = _relFiltros.dataFim;

  // ── Produção real por dia (usando realizadoMap do cache) ──────
  const producaoPorDia = _calcPorDiaFiltrado(recs, inicio, fim);

  // ── Dias com produção no período ──────────────────────────────
  const diasComProducao = Math.max(1, Object.values(producaoPorDia).filter(v => v > 0).length);

  // ── Produção por máquina ──────────────────────────────────────
  const porMaquina = {};
  recs.forEach(r => {
    if (!r.maquina) return;
    if (!porMaquina[r.maquina]) {
      porMaquina[r.maquina] = { programado: 0, realizado: 0, setup: 0, registros: [] };
    }
    porMaquina[r.maquina].programado += r.qntCaixas || 0;
    porMaquina[r.maquina].realizado  += realizadoMap[r.id] || 0;
    // setup por sequência calculado depois
    porMaquina[r.maquina].registros.push(r);
  });

  // ── Produção por produto ──────────────────────────────────────
  const porProduto = {};
  recs.forEach(r => {
    if (!r.produto) return;
    if (!porProduto[r.produto]) {
      porProduto[r.produto] = { programado: 0, realizado: 0, maquina: r.maquina };
    }
    porProduto[r.produto].programado += r.qntCaixas || 0;
    porProduto[r.produto].realizado  += realizadoMap[r.id] || 0;
  });

  // ── KPIs globais ─────────────────────────────────────────────
  // Produção total = soma dos apontamentos filtrados
  let totalRealizado  = 0;
  let totalCapacidade = 0;

  Object.entries(porMaquina).forEach(([maq, m]) => {
    const vel = _getVelMaquina(maq);
    totalRealizado += m.realizado;
    // Capacidade real = velocidade × minutos disponíveis no período
    if (vel > 0) {
      totalCapacidade += vel * MINUTOS_DIA * diasComProducao;
    } else {
      // Sem velocidade cadastrada: usar programado como proxy de capacidade
      totalCapacidade += m.programado;
    }
  });

  // Eficiência = produzido / capacidade real no período filtrado
  const eficienciaMedia = totalCapacidade > 0
    ? Math.min(100, Math.round(totalRealizado / totalCapacidade * 100))
    : 0;

  // Programado total (para KPI de comparação)
  const totalProgramado = recs.reduce((a, r) => a + (r.qntCaixas || 0), 0);

  // ── Ociosidade = tempo parado / tempo total disponível ────────
  const numMaquinas = Math.max(1, Object.keys(porMaquina).length);
  const minutosTotalDisponiveis = diasComProducao * MINUTOS_DIA * numMaquinas;

  let minutosProdutivos = 0;
  let minutosSetupTotal = 0;
  Object.entries(porMaquina).forEach(([maq, m]) => {
    const vel = _getVelMaquina(maq);
    minutosProdutivos += vel > 0 ? m.realizado / vel : 0;
    minutosSetupTotal += m.setup;
  });

  const minutosOciosos = Math.max(0, minutosTotalDisponiveis - minutosProdutivos - minutosSetupTotal);
  const pctOcupado = minutosTotalDisponiveis > 0 ? Math.round(minutosProdutivos  / minutosTotalDisponiveis * 100) : 0;
  const pctSetup   = minutosTotalDisponiveis > 0 ? Math.round(minutosSetupTotal  / minutosTotalDisponiveis * 100) : 0;
  const pctOcioso  = Math.max(0, 100 - pctOcupado - pctSetup);

  // ── Ruptura / cobertura ───────────────────────────────────────
  let rupturas = 0;
  try {
    const pc = window.projecaoCalculada || [];
    rupturas = pc.filter(p => p.risco === 'critico' || p.risco === 'alto').length;
  } catch(e) {}

  // ── Tabela analítica — eficiência por capacidade real ─────────
  const tabelaRows = Object.entries(porMaquina).map(([maq, dados]) => {
    const real = dados.realizado;
    const vel  = _getVelMaquina(maq);
    const setup = _getSetupMin(maq);

    // Capacidade real da máquina no período
    const capReal = vel > 0
      ? vel * MINUTOS_DIA * diasComProducao
      : dados.programado;

    // Eficiência = produzido / capacidade real
    const efic = capReal > 0 ? Math.min(100, Math.round(real / capReal * 100)) : 0;

    // Ociosidade = tempo parado / tempo total disponível
    const minsDispMaq = diasComProducao * MINUTOS_DIA;
    const minsProd    = vel > 0 ? real / vel : 0;
    const minsOciosos = Math.max(0, minsDispMaq - minsProd - setup);
    const pctOc       = minsDispMaq > 0 ? Math.round(minsOciosos / minsDispMaq * 100) : 0;

    const topProd = dados.registros.reduce((best, r) => {
      const rv = realizadoMap[r.id] || 0;
      return rv > (best.v || 0) ? { nome: r.produto, v: rv } : best;
    }, {});

    return {
      maquina: maq,
      produto: topProd.nome || '—',
      programado: dados.programado,
      realizado: real,
      eficiencia: efic,
      setup,
      pctOcioso: pctOc,
    };
  });

  _dadosCache = {
    recs, realizadoMap, porMaquina, porProduto, producaoPorDia,
    totalProgramado, totalRealizado, eficienciaMedia,
    pctOcupado, pctSetup, pctOcioso,
    diasComProducao, numMaquinas, rupturas, tabelaRows,
    minutosProdutivos, minutosSetupTotal
  };
  return _dadosCache;
}

// ─────────────────────────────────────────────────────────────────
// KPIs
// ─────────────────────────────────────────────────────────────────
function _renderKPIs(d) {
  const el = document.getElementById('rel2-kpis');
  if (!el) return;

  const eficCor   = d.eficienciaMedia >= 85 ? '#2ec97a' : d.eficienciaMedia >= 70 ? '#f5c518' : '#e8321a';
  const ocCor     = d.pctOcioso <= 15 ? '#2ec97a' : d.pctOcioso <= 30 ? '#f5c518' : '#e8321a';
  const rupCor    = d.rupturas === 0 ? '#2ec97a' : d.rupturas <= 3 ? '#f5c518' : '#e8321a';
  const ocupCor   = d.pctOcupado >= 75 ? '#2ec97a' : d.pctOcupado >= 50 ? '#f5c518' : '#e8321a';

  el.innerHTML = [
    _kpiCard('Produção Total',   _fmtNum(d.totalRealizado) + ' cx', 'var(--cyan)', '📦',
      `<span style="color:var(--text3)">${_fmtNum(d.totalProgramado)} programado</span>`),
    _kpiCard('Ocupação Máq.',    d.pctOcupado + '%', ocupCor, '🏭',
      `<span style="color:var(--text3)">${d.diasComProducao} dias ativos</span>`),
    _kpiCard('Tempo Ocioso',     d.pctOcioso + '%', ocCor, '⏸',
      `<span style="color:var(--text3)">Setup: ${d.pctSetup}%</span>`),
    _kpiCard('Eficiência Média', d.eficienciaMedia + '%', eficCor, '📈',
      `<span style="color:${eficCor}">${d.eficienciaMedia >= 85 ? '✓ Ótimo' : d.eficienciaMedia >= 70 ? '⚠ Regular' : '✗ Crítico'}</span>`),
    _kpiCard('Risco Ruptura',    d.rupturas + ' prod.', rupCor, '🚨',
      `<span style="color:var(--text3)">Estoque crítico</span>`),
  ].join('');
}

function _kpiCard(label, valor, cor, icon, extra) {
  return `<div class="rel2-kpi" style="border-left:3px solid ${cor}20">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div class="rel2-kpi-label">${label}</div>
      <span style="font-size:18px">${icon}</span>
    </div>
    <div class="rel2-kpi-num" style="color:${cor}">${valor}</div>
    <div class="rel2-kpi-delta">${extra}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────
// ALERTAS INTELIGENTES
// Regras: eficiência < 70% → crítico | ociosidade > 30% → atenção
// ─────────────────────────────────────────────────────────────────
function _renderAlertas(d) {
  const el = document.getElementById('rel2-alertas');
  if (!el) return;

  const alertas = [];

  // Máquinas: eficiência por capacidade real
  Object.entries(d.porMaquina).forEach(([maq, m]) => {
    const vel     = _getVelMaquina(maq);
    const capReal = vel > 0
      ? vel * MINUTOS_DIA * d.diasComProducao
      : m.programado;
    const efic = capReal > 0 ? Math.min(100, Math.round(m.realizado / capReal * 100)) : null;

    if (efic !== null && efic < 70) {
      // Eficiência crítica: < 70%
      alertas.push({
        tipo: 'erro',
        msg: `Eficiência crítica na <strong>${maq}</strong> — ${efic}% da capacidade real (meta: 70%). Verificar paradas, setup ou falta de insumo.`
      });
    } else if (efic !== null && efic < 85) {
      // Eficiência abaixo da meta: 70–84%
      alertas.push({
        tipo: 'aviso',
        msg: `<strong>${maq}</strong> abaixo da meta de eficiência — ${efic}% (meta: 85%). Monitorar rendimento.`
      });
    }

    // Ociosidade alta: > 30%
    const minsDisp = d.diasComProducao * MINUTOS_DIA;
    const minsProd = vel > 0 ? m.realizado / vel : 0;
    const pctOcMaq = minsDisp > 0
      ? Math.round(Math.max(0, minsDisp - minsProd - _getSetupMin(maq)) / minsDisp * 100)
      : 0;
    if (pctOcMaq > 30) {
      alertas.push({
        tipo: 'aviso',
        msg: `Alta ociosidade na <strong>${maq}</strong> — ${pctOcMaq}% do tempo disponível sem produção (limite: 30%).`
      });
    }

    // Setup alto: > 45 min
    const setupMin = _getSetupMin(maq);
    if (setupMin > 45) {
      alertas.push({
        tipo: 'aviso',
        msg: `Tempo de setup elevado na <strong>${maq}</strong> — ${setupMin} min por ordem. Considerar otimização de troca.`
      });
    }
  });

  // Ociosidade global > 30%
  if (d.pctOcioso > 30 && Object.keys(d.porMaquina).length > 1) {
    alertas.push({
      tipo: 'aviso',
      msg: `Ociosidade global elevada: <strong>${d.pctOcioso}%</strong> do tempo disponível sem produção. Revisar programação.`
    });
  }

  // Rupturas de estoque
  try {
    const pc = window.projecaoCalculada || [];
    const criticos = pc.filter(p => p.risco === 'critico');
    const altos    = pc.filter(p => p.risco === 'alto');
    criticos.slice(0, 3).forEach(p => {
      alertas.push({
        tipo: 'erro',
        msg: `Ruptura crítica — <strong>${p.produto.substring(0, 40)}</strong>: cobertura de apenas ${p.coberturaAtual?.toFixed(1) ?? '?'} dias. Priorizar produção.`
      });
    });
    if (altos.length > 0) {
      alertas.push({
        tipo: 'aviso',
        msg: `${altos.length} produto(s) com risco alto de ruptura (cobertura ≤ 7 dias). Avaliar programação de reposição.`
      });
    }
    // Produtos com baixa produção vs demanda
    pc.filter(p => p.risco === 'medio').slice(0, 2).forEach(p => {
      if (p.demandaDiaria > 0 && p.coberturaAtual != null && p.coberturaAtual < 14) {
        alertas.push({
          tipo: 'info',
          msg: `Atenção: <strong>${p.produto.substring(0, 40)}</strong> com cobertura de ${p.coberturaAtual.toFixed(1)} dias — monitorar reposição.`
        });
      }
    });
  } catch(e) {}

  // Nenhum alerta
  if (alertas.length === 0) {
    el.innerHTML = `<div class="rel2-alerta" style="background:rgba(46,201,122,.08);border:1px solid rgba(46,201,122,.2)">
      <span style="font-size:16px">✅</span>
      <span style="color:#2ec97a;font-weight:600">Produção dentro dos parâmetros esperados — nenhum alerta identificado</span>
    </div>`;
    return;
  }

  el.innerHTML = alertas.map(a => {
    const styles = {
      erro:  { bg: 'rgba(232,50,26,.08)',   border: 'rgba(232,50,26,.2)',   cor: '#e8321a', icon: '🔴' },
      aviso: { bg: 'rgba(245,197,24,.07)',  border: 'rgba(245,197,24,.2)',  cor: '#f5c518', icon: '⚠️' },
      info:  { bg: 'rgba(100,120,200,.07)', border: 'rgba(100,120,200,.2)', cor: '#6478c8', icon: 'ℹ️' },
    };
    const s = styles[a.tipo] || styles.info;
    return `<div class="rel2-alerta" style="background:${s.bg};border:1px solid ${s.border}">
      <span style="font-size:14px;flex-shrink:0">${s.icon}</span>
      <span style="color:${s.cor}">${a.msg}</span>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────
// GRÁFICO: PRODUÇÃO POR DIA
// ─────────────────────────────────────────────────────────────────
let _chartTipoProd = 'bar';
window._relChartTipoProd = 'bar';

function _renderChartProducaoDia(d) {
  const canvas = document.getElementById('chart-producao-dia');
  const empty  = document.getElementById('chart-producao-dia-empty');
  if (!canvas) return;

  const dias  = Object.keys(d.producaoPorDia).sort();
  const vals  = dias.map(d2 => d.producaoPorDia[d2] || 0);
  const vplan = dias.map(dia => {
    return d.recs.filter(r => (r.dtDesejada||r.dtSolicitacao||'') === dia)
                 .reduce((a, r) => a + (r.qntCaixas||0), 0);
  });

  if (!dias.length || vals.every(v => v === 0)) {
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'flex';
    return;
  }
  canvas.style.display = '';
  if (empty) empty.style.display = 'none';

  if (_chartProdDia) { _chartProdDia.destroy(); _chartProdDia = null; }

  const tipo = window._relChartTipoProd || 'bar';
  const labels = dias.map(d2 => {
    const dt = new Date(d2 + 'T12:00:00');
    return dt.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' });
  });

  _chartProdDia = new Chart(canvas.getContext('2d'), {
    type: tipo,
    data: {
      labels,
      datasets: [
        {
          label: 'Realizado',
          data: vals,
          backgroundColor: 'rgba(242,101,34,.75)',
          borderColor: '#f26522',
          borderWidth: tipo === 'line' ? 2 : 0,
          borderRadius: tipo === 'bar' ? 4 : 0,
          fill: tipo === 'line',
          tension: .35,
          pointBackgroundColor: '#f26522',
          pointRadius: tipo === 'line' ? 3 : 0,
        },
        {
          label: 'Programado',
          data: vplan,
          backgroundColor: 'rgba(100,120,200,.18)',
          borderColor: 'rgba(100,120,200,.5)',
          borderWidth: tipo === 'line' ? 2 : 0,
          borderRadius: tipo === 'bar' ? 4 : 0,
          borderDash: [4, 4],
          fill: false,
          tension: .35,
          pointBackgroundColor: 'rgba(100,120,200,.7)',
          pointRadius: tipo === 'line' ? 3 : 0,
        }
      ]
    },
    options: _chartOptions('Caixas')
  });
}

// ─────────────────────────────────────────────────────────────────
// GRÁFICO: PRODUÇÃO POR MÁQUINA
// ─────────────────────────────────────────────────────────────────
function _renderChartMaquinas(d) {
  const canvas = document.getElementById('chart-maquinas');
  const empty  = document.getElementById('chart-maquinas-empty');
  if (!canvas) return;

  const entries = Object.entries(d.porMaquina)
    .map(([maq, m]) => ({ maq, realizado: m.realizado, programado: m.programado }))
    .sort((a, b) => b.realizado - a.realizado);

  if (!entries.length) {
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'flex';
    return;
  }
  canvas.style.display = '';
  if (empty) empty.style.display = 'none';

  if (_chartMaquinas) { _chartMaquinas.destroy(); _chartMaquinas = null; }

  _chartMaquinas = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: entries.map(e => e.maq),
      datasets: [
        {
          label: 'Realizado',
          data: entries.map(e => e.realizado),
          backgroundColor: entries.map(e => {
            const ef = e.programado > 0 ? e.realizado / e.programado : 0;
            return ef >= .85 ? 'rgba(46,201,122,.8)' : ef >= .7 ? 'rgba(245,197,24,.8)' : 'rgba(232,50,26,.75)';
          }),
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Programado',
          data: entries.map(e => e.programado),
          backgroundColor: 'rgba(255,255,255,.06)',
          borderColor: 'rgba(255,255,255,.15)',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,
        }
      ]
    },
    options: { ..._chartOptions('Caixas'), indexAxis: 'y' }
  });
}

// ─────────────────────────────────────────────────────────────────
// GRÁFICO: TOP PRODUTOS
// ─────────────────────────────────────────────────────────────────
function _renderChartTopProdutos(d) {
  const canvas = document.getElementById('chart-top-produtos');
  const empty  = document.getElementById('chart-top-produtos-empty');
  if (!canvas) return;

  const entries = Object.entries(d.porProduto)
    .map(([prod, m]) => ({ prod, realizado: m.realizado }))
    .filter(e => e.realizado > 0)
    .sort((a, b) => b.realizado - a.realizado)
    .slice(0, 8);

  if (!entries.length) {
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'flex';
    return;
  }
  canvas.style.display = '';
  if (empty) empty.style.display = 'none';

  if (_chartTopProd) { _chartTopProd.destroy(); _chartTopProd = null; }

  const cores = ['#f26522','#e8881a','#d4a030','#f5c518','#2ec97a','rgba(100,120,200,.8)','rgba(200,80,80,.8)','rgba(150,150,150,.6)'];

  _chartTopProd = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: entries.map(e => e.prod.length > 22 ? e.prod.substring(0,20)+'…' : e.prod),
      datasets: [{
        label: 'Caixas produzidas',
        data: entries.map(e => e.realizado),
        backgroundColor: cores.slice(0, entries.length),
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: _chartOptions('Caixas')
  });
}

// ─────────────────────────────────────────────────────────────────
// GRÁFICO: OCIOSIDADE / PIZZA
// ─────────────────────────────────────────────────────────────────
function _renderChartOciosidade(d) {
  const canvas  = document.getElementById('chart-ociosidade');
  const legend  = document.getElementById('chart-ociosidade-legend');
  const empty   = document.getElementById('chart-ociosidade-empty');
  if (!canvas) return;

  const prod  = Math.max(0, d.pctOcupado);
  const setup = Math.max(0, d.pctSetup);
  const ocio  = Math.max(0, 100 - prod - setup);

  if (_chartOciosidade) { _chartOciosidade.destroy(); _chartOciosidade = null; }

  _chartOciosidade = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Produtivo', 'Setup', 'Ocioso'],
      datasets: [{
        data: [prod, setup, ocio],
        backgroundColor: ['rgba(46,201,122,.85)', 'rgba(242,101,34,.75)', 'rgba(100,100,130,.5)'],
        borderColor: ['#2ec97a', '#f26522', 'rgba(100,100,130,.4)'],
        borderWidth: 2,
        hoverOffset: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '68%',
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: ctx => ` ${ctx.label}: ${ctx.raw}%`
      }}}
    }
  });

  if (legend) {
    const items = [
      { label: 'Produtivo', val: prod + '%', cor: '#2ec97a' },
      { label: 'Setup',     val: setup + '%', cor: '#f26522' },
      { label: 'Ocioso',    val: ocio + '%',  cor: 'rgba(150,150,180,.7)' },
    ];
    legend.innerHTML = items.map(it => `
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:10px;height:10px;border-radius:2px;background:${it.cor};flex-shrink:0"></div>
        <div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:var(--text)">${it.val}</div>
          <div style="font-size:10px;color:var(--text3)">${it.label}</div>
        </div>
      </div>
    `).join('');
  }
}

// ─────────────────────────────────────────────────────────────────
// PLANEJADO VS REALIZADO POR MÁQUINA
// ─────────────────────────────────────────────────────────────────
function _renderPlanejadoRealizado(d) {
  const grid  = document.getElementById('rel2-pvr-grid');
  const empty = document.getElementById('rel2-pvr-empty');
  if (!grid) return;

  const entries = Object.entries(d.porMaquina);
  if (!entries.length) {
    grid.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }
  grid.style.display = '';
  if (empty) empty.style.display = 'none';

  grid.innerHTML = entries.map(([maq, m]) => {
    const pct  = m.programado > 0 ? Math.min(100, Math.round(m.realizado / m.programado * 100)) : 0;
    const cor  = pct >= 85 ? '#2ec97a' : pct >= 70 ? '#f5c518' : '#e8321a';
    return `<div class="rel2-pvr-card">
      <div style="font-size:11px;font-weight:700;color:var(--cyan);margin-bottom:8px;font-family:'JetBrains Mono',monospace">${maq}</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:10px;color:var(--text3)">Realizado</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:700;color:${cor}">${pct}%</span>
      </div>
      <div style="height:6px;background:var(--s3);border-radius:3px;overflow:hidden;margin-bottom:8px">
        <div style="height:100%;background:${cor};width:${pct}%;border-radius:3px;transition:width .6s ease"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:10px">
        <div style="background:var(--s3);border-radius:5px;padding:5px 7px">
          <div style="color:var(--text3)">Programado</div>
          <div style="font-family:'JetBrains Mono',monospace;font-weight:700;color:var(--text)">${_fmtNum(m.programado)}</div>
        </div>
        <div style="background:var(--s3);border-radius:5px;padding:5px 7px">
          <div style="color:var(--text3)">Realizado</div>
          <div style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${cor}">${_fmtNum(m.realizado)}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────
// TABELA ANALÍTICA
// ─────────────────────────────────────────────────────────────────
function _renderTabela(d) {
  _renderTabelaRows(d.tabelaRows);
}

function _renderTabelaRows(rows) {
  const tbody = document.getElementById('rel2-tabela-body');
  const footer = document.getElementById('rel2-tabela-footer');
  if (!tbody) return;

  // Aplicar busca
  const busca = _tabelaBusca.toLowerCase();
  let filtradas = busca
    ? rows.filter(r => r.maquina.toLowerCase().includes(busca) || r.produto.toLowerCase().includes(busca))
    : rows;

  // Ordenar
  filtradas = [...filtradas].sort((a, b) => {
    const va = a[_sortCol];
    const vb = b[_sortCol];
    if (typeof va === 'string') return _sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return _sortAsc ? va - vb : vb - va;
  });

  if (!filtradas.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text3);font-size:12px">Sem dados para os filtros selecionados</td></tr>`;
    if (footer) footer.textContent = '';
    return;
  }

  tbody.innerHTML = filtradas.map((r, i) => {
    // Cores por nível de eficiência
    const eficCor = r.eficiencia >= 85 ? '#2ec97a' : r.eficiencia >= 70 ? '#f5c518' : '#e8321a';
    const ocCor   = r.pctOcioso <= 15 ? 'var(--text3)' : r.pctOcioso <= 30 ? '#f5c518' : '#e8321a';
    const setupCor = r.setup <= 15 ? 'var(--text3)' : r.setup <= 45 ? '#f5c518' : '#e8321a';

    // Destaque visual da linha por status predominante
    let rowBg = i % 2 === 1 ? 'rgba(255,255,255,.01)' : 'transparent';
    let rowBorder = 'none';
    if (r.eficiencia < 70) {
      // Eficiência crítica → fundo vermelho suave
      rowBg = 'rgba(232,50,26,.06)';
      rowBorder = 'border-left:3px solid rgba(232,50,26,.5)';
    } else if (r.pctOcioso > 30) {
      // Ociosidade alta → fundo amarelo suave
      rowBg = 'rgba(245,197,24,.05)';
      rowBorder = 'border-left:3px solid rgba(245,197,24,.4)';
    } else if (r.eficiencia >= 85 && r.pctOcioso <= 15) {
      // Tudo bom → fundo verde suave
      rowBg = 'rgba(46,201,122,.04)';
      rowBorder = 'border-left:3px solid rgba(46,201,122,.35)';
    }

    return `<tr style="background:${rowBg};${rowBorder}">
      <td class="rel2-td" style="color:var(--cyan);font-family:'JetBrains Mono',monospace;font-weight:700;font-size:12px">${r.maquina}</td>
      <td class="rel2-td" style="color:var(--text);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(r.produto)}">${r.produto}</td>
      <td class="rel2-td" style="text-align:right;font-family:'JetBrains Mono',monospace;color:var(--text2)">${_fmtNum(r.programado)}</td>
      <td class="rel2-td" style="text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600;color:${eficCor}">${_fmtNum(r.realizado)}</td>
      <td class="rel2-td" style="text-align:right">
        <span class="rel2-badge" style="background:${eficCor}22;color:${eficCor};border:1px solid ${eficCor}44">${r.eficiencia}%</span>
      </td>
      <td class="rel2-td" style="text-align:right;font-family:'JetBrains Mono',monospace;color:${setupCor}">${r.setup > 0 ? r.setup + ' min' : '—'}</td>
      <td class="rel2-td" style="text-align:right">
        <span class="rel2-badge" style="background:${ocCor === 'var(--text3)' ? 'rgba(255,255,255,.06)' : ocCor + '18'};color:${ocCor};border:1px solid ${ocCor === 'var(--text3)' ? 'rgba(255,255,255,.08)' : ocCor + '33'}">${r.pctOcioso}%</span>
      </td>
    </tr>`;
  }).join('');

  if (footer) {
    const totPlan = filtradas.reduce((a, r) => a + r.programado, 0);
    const totReal = filtradas.reduce((a, r) => a + r.realizado, 0);
    const eficGeral = totPlan > 0 ? Math.round(totReal / totPlan * 100) : 0;
    footer.innerHTML = `<span style="color:var(--text3)">${filtradas.length} máquina(s) · </span>
      <span style="color:var(--text2)">Total programado: <strong style="color:var(--cyan)">${_fmtNum(totPlan)} cx</strong></span>
      <span style="color:var(--text3)"> · </span>
      <span style="color:var(--text2)">Realizado: <strong style="color:var(--cyan)">${_fmtNum(totReal)} cx</strong></span>
      <span style="color:var(--text3)"> · </span>
      <span>Eficiência geral: <strong style="color:${eficGeral >= 85 ? '#2ec97a' : eficGeral >= 70 ? '#f5c518' : '#e8321a'}">${eficGeral}%</strong></span>`;
  }

  // Atualizar headers de sort
  document.querySelectorAll('.rel2-sort-th').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('active', col === _sortCol);
    th.querySelector('.sort-arrow').textContent =
      col === _sortCol ? (_sortAsc ? ' ↑' : ' ↓') : ' ↕';
  });
}

// ─────────────────────────────────────────────────────────────────
// COBERTURA DE ESTOQUE
// ─────────────────────────────────────────────────────────────────
function _renderCobertura() {
  const el = document.getElementById('rel2-cobertura-content');
  if (!el) return;

  try {
    const pc = window.projecaoCalculada || [];
    if (!pc.length) {
      el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">📈 Calcule a Projeção de Vendas para ver análise de cobertura</div>';
      return;
    }

    const sorted = [...pc].sort((a, b) => {
      const rv = { critico: 0, alto: 1, medio: 2, ok: 3, nd: 4 };
      return (rv[a.risco] ?? 4) - (rv[b.risco] ?? 4);
    });

    const riscoConfig = {
      critico: { bg: 'rgba(232,50,26,.08)', border: 'rgba(232,50,26,.2)', cor: '#e8321a', label: 'CRÍTICO', icon: '🔴' },
      alto:    { bg: 'rgba(245,197,24,.07)', border: 'rgba(245,197,24,.2)', cor: '#f5c518', label: 'ALTO',    icon: '🟡' },
      medio:   { bg: 'rgba(242,101,34,.06)', border: 'rgba(242,101,34,.15)', cor: '#f26522', label: 'MÉDIO',  icon: '🟠' },
      ok:      { bg: 'rgba(46,201,122,.06)', border: 'rgba(46,201,122,.15)', cor: '#2ec97a', label: 'OK',     icon: '🟢' },
    };

    const primeiros = sorted.slice(0, 15);
    el.innerHTML = primeiros.map(p => {
      const cfg = riscoConfig[p.risco] || riscoConfig.ok;
      const cob = p.coberturaAtual != null ? p.coberturaAtual.toFixed(1) + 'd' : '—';
      const dem = p.demandaDiaria != null ? p.demandaDiaria.toFixed(0) + ' cx/dia' : '—';
      return `<div class="rel2-cob-row" style="background:${cfg.bg};border:1px solid ${cfg.border}">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <span style="font-size:12px">${cfg.icon}</span>
          <div style="overflow:hidden">
            <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.produto}</div>
            <div style="font-size:10px;color:var(--text3)">${p.maquina || '—'} · Demanda: ${dem}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-shrink:0">
          <div style="text-align:right">
            <div style="font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:${cfg.cor}">${cob}</div>
            <div style="font-size:9px;color:var(--text3)">COBERTURA</div>
          </div>
          <span class="rel2-badge" style="background:${cfg.bg};color:${cfg.cor};border:1px solid ${cfg.border};min-width:52px;text-align:center">${cfg.label}</span>
        </div>
      </div>`;
    }).join('');

    if (sorted.length > 15) {
      el.innerHTML += `<div style="padding:8px 12px;font-size:11px;color:var(--text3);text-align:center">… e mais ${sorted.length - 15} produtos</div>`;
    }
  } catch(e) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">Erro ao carregar dados de cobertura</div>';
  }
}

function _renderCategorias(d) {
  const prodEl = document.getElementById('rel2-cat-prod');
  const maqEl = document.getElementById('rel2-cat-maq');
  if (prodEl) {
    const rows = Object.values(d.porCategoriaProduto || {}).sort((a,b)=> (b.totalMin||0) - (a.totalMin||0));
    if (!rows.length) prodEl.innerHTML = '<div style="color:var(--text3);font-size:12px">Sem dados</div>';
    else prodEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th class="rel2-th">Categoria</th><th class="rel2-th" style="text-align:right">Programado</th><th class="rel2-th" style="text-align:right">Setup</th><th class="rel2-th" style="text-align:right">Total</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="rel2-td">${r.categoria}</td><td class="rel2-td" style="text-align:right">${_fmtNum(r.programado)}</td><td class="rel2-td" style="text-align:right">${Math.round(r.setupMin||0)} min</td><td class="rel2-td" style="text-align:right">${Math.round(r.totalMin||0)} min</td></tr>`).join('')}</tbody></table>`;
  }
  if (maqEl) {
    const rows = Object.values(d.porCategoriaMaquina || {}).sort((a,b)=> (b.ocupacaoPct||0) - (a.ocupacaoPct||0));
    if (!rows.length) maqEl.innerHTML = '<div style="color:var(--text3);font-size:12px">Sem dados</div>';
    else maqEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th class="rel2-th">Categoria</th><th class="rel2-th" style="text-align:right">Máq.</th><th class="rel2-th" style="text-align:right">Setup</th><th class="rel2-th" style="text-align:right">Ocup.</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="rel2-td">${r.categoria}</td><td class="rel2-td" style="text-align:right">${(r.maquinas||[]).length}</td><td class="rel2-td" style="text-align:right">${Math.round(r.setupMin||0)} min</td><td class="rel2-td" style="text-align:right">${r.ocupacaoPct||0}%</td></tr>`).join('')}</tbody></table>`;
  }
}

// ─────────────────────────────────────────────────────────────────
// EXPORTAÇÕES
// ─────────────────────────────────────────────────────────────────
function exportXLSX() {
  if (typeof window.can === 'function' && !window.can('relatorios', 'exportar')) {
    _toast('Acesso negado: sem permissão para exportar relatórios.', 'err');
    return;
  }
  try {
    const dados = _calcularDados();
    const wb = XLSX.utils.book_new();

    // Aba 1: Resumo KPIs
    const resumo = [
      ['RELATÓRIO DE PRODUÇÃO — ' + new Date().toLocaleDateString('pt-BR')],
      ['Período:', _relFiltros.dataInicio + ' a ' + _relFiltros.dataFim],
      [],
      ['INDICADOR', 'VALOR'],
      ['Produção Total Realizada (cx)', dados.totalRealizado],
      ['Produção Programada (cx)',       dados.totalProgramado],
      ['Eficiência Média (%)',           dados.eficienciaMedia],
      ['Ocupação de Máquinas (%)',       dados.pctOcupado],
      ['Tempo Ocioso (%)',               dados.pctOcioso],
      ['Setup (%)',                      dados.pctSetup],
      ['Produtos com Risco de Ruptura',  dados.rupturas],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumo), 'Resumo');

    // Aba 2: Por máquina
    const maqRows = [['Máquina','Programado (cx)','Realizado (cx)','Eficiência (%)','Setup (min)','Ociosidade (%)']];
    dados.tabelaRows.forEach(r => {
      maqRows.push([r.maquina, r.programado, r.realizado, r.eficiencia, r.setup, r.pctOcioso]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(maqRows), 'Por Máquina');

    // Aba 3: Por produto
    const prodRows = [['Produto','Máquina','Programado (cx)','Realizado (cx)','Eficiência (%)']];
    Object.entries(dados.porProduto).sort((a,b) => b[1].realizado - a[1].realizado).forEach(([prod, m]) => {
      const efic = m.programado > 0 ? Math.round(m.realizado / m.programado * 100) : 0;
      prodRows.push([prod, m.maquina||'—', m.programado, m.realizado, efic]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prodRows), 'Por Produto');

    // Aba 4: Produção por dia
    const diaRows = [['Data','Caixas Realizadas']];
    Object.entries(dados.producaoPorDia).sort().forEach(([dia, qt]) => {
      diaRows.push([dia, qt]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(diaRows), 'Por Dia');

    // Aba 5: Cobertura
    try {
      const pc = window.projecaoCalculada || [];
      if (pc.length) {
        const cobRows = [['Produto','Máquina','Cobertura (dias)','Risco','Demanda Diária','Estoque']];
        pc.forEach(p => {
          cobRows.push([p.produto, p.maquina||'', p.coberturaAtual??'', p.risco, p.demandaDiaria??'', p.estoque??'']);
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cobRows), 'Cobertura');
      }
    } catch(e) {}

    const dataStr = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
    XLSX.writeFile(wb, `Relatorio_Producao_${dataStr}.xlsx`);
    _toast('Relatório Excel exportado!', 'ok');
  } catch(e) {
    _toast('Erro ao exportar Excel: ' + e.message, 'err');
  }
}

function exportPDF() {
  if (typeof window.can === 'function' && !window.can('relatorios', 'exportar')) {
    _toast('Acesso negado: sem permissão para exportar relatórios.', 'err');
    return;
  }
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const dados = _calcularDados();

    // Cabeçalho
    doc.setFillColor(10, 11, 13);
    doc.rect(0, 0, 297, 210, 'F');
    doc.setFillColor(242, 101, 34);
    doc.rect(0, 0, 297, 12, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('RELATÓRIO DE PRODUÇÃO — PROGPROD MES', 14, 8.5);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Período: ${_relFiltros.dataInicio} a ${_relFiltros.dataFim} · Gerado em ${new Date().toLocaleString('pt-BR')}`, 14, 19);

    // KPIs em caixinhas
    const kpis = [
      { label: 'Produção Total', val: _fmtNum(dados.totalRealizado) + ' cx' },
      { label: 'Programado',     val: _fmtNum(dados.totalProgramado) + ' cx' },
      { label: 'Eficiência',     val: dados.eficienciaMedia + '%' },
      { label: 'Ocupação',       val: dados.pctOcupado + '%' },
      { label: 'Ocioso',         val: dados.pctOcioso + '%' },
    ];
    const kpiW = 50; const kpiH = 16;
    kpis.forEach((k, i) => {
      const x = 14 + i * (kpiW + 4);
      doc.setFillColor(21, 23, 28);
      doc.roundedRect(x, 24, kpiW, kpiH, 2, 2, 'F');
      doc.setTextColor(140, 144, 153);
      doc.setFontSize(7); doc.setFont('helvetica', 'normal');
      doc.text(k.label.toUpperCase(), x + 3, 29);
      doc.setTextColor(242, 101, 34);
      doc.setFontSize(13); doc.setFont('helvetica', 'bold');
      doc.text(k.val, x + 3, 37);
    });

    // Tabela
    const tableData = dados.tabelaRows.map(r => [
      r.maquina, r.produto || '—',
      _fmtNum(r.programado), _fmtNum(r.realizado),
      r.eficiencia + '%', r.setup > 0 ? r.setup + ' min' : '—', r.pctOcioso + '%'
    ]);

    doc.autoTable({
      head: [['Máquina', 'Produto', 'Programado', 'Realizado', 'Eficiência', 'Setup', 'Ocioso']],
      body: tableData,
      startY: 46,
      styles: { fontSize: 9, cellPadding: 3, fillColor: [21,23,28], textColor: [180,184,192] },
      headStyles: { fillColor: [242,101,34], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      alternateRowStyles: { fillColor: [24,26,30] },
      columnStyles: {
        0: { fontStyle: 'bold', textColor: [242,101,34] },
        4: { halign: 'center' }, 5: { halign: 'center' }, 6: { halign: 'center' }
      },
      margin: { left: 14, right: 14 }
    });

    const dataStr = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
    doc.save(`Relatorio_Producao_${dataStr}.pdf`);
    _toast('Relatório PDF exportado!', 'ok');
  } catch(e) {
    _toast('Erro ao exportar PDF: ' + e.message, 'err');
  }
}

async function exportImagem() {
  if (typeof window.can === 'function' && !window.can('relatorios', 'exportar')) {
    _toast('Acesso negado: sem permissão para exportar relatórios.', 'err');
    return;
  }
  try {
    const el = document.getElementById('rel2-root');
    if (!el) return;
    _toast('Gerando imagem...', 'info');
    const canvas = await html2canvas(el, {
      backgroundColor: '#0a0b0d',
      scale: 1.5,
      useCORS: true,
      logging: false,
    });
    const link = document.createElement('a');
    const dataStr = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
    link.download = `Relatorio_${dataStr}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    _toast('Imagem exportada!', 'ok');
  } catch(e) {
    _toast('Erro ao exportar imagem: ' + e.message, 'err');
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS DE DADOS
// ─────────────────────────────────────────────────────────────────
function _getRecords() {
  // Acessa window.records (exposto pelo app.js) ou variável global de mesmo nome
  if (Array.isArray(window.records)) return window.records;
  if (typeof records !== 'undefined' && Array.isArray(records)) return records;
  return [];
}

// ─────────────────────────────────────────────────────────────────
// FONTE ÚNICA DE DADOS FILTRADOS
// Todos os cálculos devem usar esta função como base.
// ─────────────────────────────────────────────────────────────────
function getDadosFiltrados() {
  const allRecs = _getRecords();
  const { dataInicio, dataFim, maquina, produto } = _relFiltros;

  // Filtrar registros pelos 4 critérios
  const recs = allRecs.filter(r => {
    const dt = r.dtDesejada || r.dtSolicitacao || '';
    if (dataInicio && dt && dt < dataInicio) return false;
    if (dataFim    && dt && dt > dataFim)    return false;
    if (maquina    && r.maquina !== maquina) return false;
    if (produto    && r.produto !== produto) return false;
    return true;
  });

  // Pré-calcular apontamentos no período para cada registro UMA VEZ
  // Evita chamar _getRealizadoRec() repetidamente em cada função
  const realizadoMap = {};
  recs.forEach(r => {
    realizadoMap[r.id] = _getRealizadoRec(r, dataInicio, dataFim);
  });

  return { recs, realizadoMap };
}

// Mantida para compatibilidade interna (usa getDadosFiltrados)
function _getRecordsFiltrados() {
  return getDadosFiltrados().recs;
}

function _getRealizadoRec(r, inicio, fim) {
  let total = 0;
  try {
    const suffix = '_' + r.id;
    // Suporta window.aponGetAllKeys (exposto pelo app.js) ou variável local
    const _aponGetAllKeys = window.aponGetAllKeys || (typeof aponGetAllKeys === 'function' ? aponGetAllKeys : null);
    const _aponStorageGet = window.aponStorageGet || (typeof aponStorageGet === 'function' ? aponStorageGet : null);
    if (!_aponGetAllKeys || !_aponStorageGet) return 0;

    const allKeys = _aponGetAllKeys();
    allKeys.forEach(k => {
      if (!k.endsWith(suffix)) return;
      // Extrair data da chave: apon_YYYY-MM-DD_recId
      const datePart = k.slice('apon_'.length, k.length - suffix.length);
      if (inicio && datePart < inicio) return;
      if (fim    && datePart > fim)    return;
      const d = _aponStorageGet(k);
      if (d) {
        const hrs = (typeof APON_HOURS !== 'undefined' ? APON_HOURS : null) || APON_H;
        hrs.forEach(h => { total += parseInt(d[h]) || 0; });
      }
    });
  } catch(e) {}
  return total;
}

function _getAponPeriodo(recs, inicio, fim) {
  const result = {};
  recs.forEach(r => {
    const real = _getRealizadoRec(r, inicio, fim);
    if (!result[r.maquina]) result[r.maquina] = 0;
    result[r.maquina] += real;
  });
  return result;
}

function _calcPorDia(recs, inicio, fim) {
  const diasSet = new Set();
  recs.forEach(r => {
    const dt = r.dtDesejada || r.dtSolicitacao;
    if (dt) diasSet.add(dt);
  });
  // Se não há datas, gerar período completo
  if (!diasSet.size && inicio && fim) {
    const d = new Date(inicio + 'T12:00:00');
    const fimD = new Date(fim + 'T12:00:00');
    while (d <= fimD) { diasSet.add(_fmtDateStr(d)); d.setDate(d.getDate() + 1); }
  }

  const porDia = {};
  diasSet.forEach(dia => { porDia[dia] = 0; });

  const _aponGetAllKeys = window.aponGetAllKeys || (typeof aponGetAllKeys === 'function' ? aponGetAllKeys : null);
  const _aponStorageGet = window.aponStorageGet || (typeof aponStorageGet === 'function' ? aponStorageGet : null);

  if (_aponGetAllKeys && _aponStorageGet) {
    recs.forEach(r => {
      try {
        const suffix = '_' + r.id;
        const allKeys = _aponGetAllKeys();
        allKeys.forEach(k => {
          if (!k.endsWith(suffix)) return;
          const datePart = k.slice('apon_'.length, k.length - suffix.length);
          if (inicio && datePart < inicio) return;
          if (fim    && datePart > fim)    return;
          const d = _aponStorageGet(k);
          if (d) {
            const hrs = (typeof APON_HOURS !== 'undefined' ? APON_HOURS : null) || APON_H;
            const tot = hrs.reduce((a, h) => a + (parseInt(d[h])||0), 0);
            if (tot > 0) {
              porDia[datePart] = (porDia[datePart] || 0) + tot;
            }
          }
        });
      } catch(e) {}
    });
  }
  return porDia;
}

function _getSetupMin(maquina) {
  try {
    const md = window.MAQUINAS_DATA?.[maquina];
    return parseFloat(md?.tempoSetupPadrao) || 0;
  } catch(e) { return 0; }
}

// Versão otimizada de _calcPorDia que usa o realizadoMap do cache
// para não re-iterar os apontamentos ao calcular produção por dia
function _calcPorDiaFiltrado(recs, inicio, fim) {
  return _calcPorDia(recs, inicio, fim);
}

function _getVelMaquina(maquina) {
  try {
    const md = window.MAQUINAS_DATA?.[maquina];
    return parseFloat(md?.pcMin) || 0;
  } catch(e) { return 0; }
}

// ─────────────────────────────────────────────────────────────────
// CHART OPTIONS PADRÃO
// ─────────────────────────────────────────────────────────────────
function _chartOptions(yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: { color: '#8a9099', font: { family: 'Space Grotesk', size: 10 }, boxWidth: 10, padding: 12 }
      },
      tooltip: {
        backgroundColor: '#15171c',
        borderColor: '#252830',
        borderWidth: 1,
        titleColor: '#edeef0',
        bodyColor: '#8a9099',
        padding: 10,
        callbacks: {
          label: ctx => ` ${ctx.dataset.label}: ${_fmtNum(ctx.raw)} ${yLabel === 'Caixas' ? 'cx' : ''}`
        }
      }
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,.04)' },
        ticks: { color: '#454b55', font: { family: 'JetBrains Mono', size: 9 }, maxRotation: 45 }
      },
      y: {
        grid: { color: 'rgba(255,255,255,.05)' },
        ticks: {
          color: '#454b55', font: { family: 'JetBrains Mono', size: 9 },
          callback: v => _fmtNum(v)
        }
      }
    }
  };
}

// ─────────────────────────────────────────────────────────────────
// HELPERS GERAIS
// ─────────────────────────────────────────────────────────────────
function _fmtNum(n) {
  if (!n && n !== 0) return '0';
  return Number(n).toLocaleString('pt-BR');
}
function _fmtDateInput(d) {
  return d.toISOString().slice(0, 10);
}
function _fmtDateStr(d) {
  return d.toISOString().slice(0, 10);
}
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _thSort(col, label) {
  const isActive = col === _sortCol;
  const arrow = isActive ? (_sortAsc ? ' ↑' : ' ↓') : ' ↕';
  return `<th class="rel2-sort-th${isActive?' active':''}" data-col="${col}" onclick="relatorios.sortBy('${col}')">
    ${label}<span class="sort-arrow" style="color:${isActive?'var(--cyan)':'var(--text4)'}">${arrow}</span>
  </th>`;
}
function _toast(msg, tipo) {
  if (typeof toast === 'function') { toast(msg, tipo); return; }
  console.log('[relatorios]', msg);
}

// ─────────────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────────────
const relatorios = {
  init: initRelatorios,
  render: renderRelatorios,
  getDadosFiltrados,  // exposto para uso externo

  aplicarFiltros() {
    renderRelatorios();
  },

  limparFiltros() {
    const hoje = new Date();
    const primeiroDia = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const ini = document.getElementById('rel2-data-inicio');
    const fim = document.getElementById('rel2-data-fim');
    const maq = document.getElementById('rel2-maquina');
    const prod = document.getElementById('rel2-produto');
    if (ini) ini.value = _fmtDateInput(primeiroDia);
    if (fim) fim.value = _fmtDateInput(hoje);
    if (maq) maq.value = '';
    if (prod) prod.value = '';
    document.querySelectorAll('.btn-rel-preset').forEach(b => b.classList.remove('active'));
    renderRelatorios();
  },

  setPreset(tipo) {
    const hoje = new Date();
    let ini, fim = _fmtDateInput(hoje);
    if (tipo === 'hoje') {
      ini = _fmtDateInput(hoje);
    } else if (tipo === 'semana') {
      const seg = new Date(hoje); seg.setDate(hoje.getDate() - today_dayOfWeek());
      ini = _fmtDateInput(seg);
    } else if (tipo === 'mes') {
      ini = _fmtDateInput(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    } else if (tipo === 'trim') {
      ini = _fmtDateInput(new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1));
    }
    const iniEl = document.getElementById('rel2-data-inicio');
    const fimEl = document.getElementById('rel2-data-fim');
    if (iniEl) iniEl.value = ini;
    if (fimEl) fimEl.value = fim;
    document.querySelectorAll('.btn-rel-preset').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('preset-' + tipo);
    if (btn) btn.classList.add('active');
    renderRelatorios();
  },

  sortBy(col) {
    if (_sortCol === col) { _sortAsc = !_sortAsc; }
    else { _sortCol = col; _sortAsc = col === 'maquina' || col === 'produto'; }
    // Usa cache — não reconsulta Firebase
    const dados = _calcularDados();
    _renderTabela(dados);
  },

  filtrarTabela(busca) {
    _tabelaBusca = busca;
    // Usa cache — não reconsulta Firebase
    const dados = _calcularDados();
    _renderTabelaRows(dados.tabelaRows);
  },

  toggleChartType(which) {
    if (which === 'producaoDia') {
      window._relChartTipoProd = window._relChartTipoProd === 'bar' ? 'line' : 'bar';
      const btn = document.getElementById('btn-chart-tipo');
      if (btn) btn.textContent = window._relChartTipoProd === 'bar' ? 'Linha' : 'Barras';
      // Usa cache — apenas re-renderiza o gráfico
      const dados = _calcularDados();
      _renderChartProducaoDia(dados);
    }
  },

  exportXLSX,
  exportPDF,
  exportImagem,
};

// Helper: dia da semana com segunda = 0
function today_dayOfWeek() {
  const d = new Date().getDay();
  return d === 0 ? 6 : d - 1;
}

// ═════════════════════════════════════════════════════════════════
// FUNÇÕES GRP* — handlers chamados diretamente pelo index.html
// Vivem no relatorios.js (IIFE clássico, não-módulo) para garantir
// que estejam disponíveis em window ANTES do app.js (ES module) carregar.
// ═════════════════════════════════════════════════════════════════

let _grpTabAtivo = 'producao';

// ── Ler filtros do index.html (IDs externos ao rel2-root) ─────────
function _grpGetFiltros() {
  const _val = (...ids) => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.value !== undefined) return el.value;
    }
    return '';
  };
  return {
    dataInicio: _val('grp-data-ini','grp-inicio','rpt-data-ini','rpt-inicio','rel-data-ini'),
    dataFim:    _val('grp-data-fim','grp-fim','rpt-data-fim','rpt-fim','rel-data-fim'),
    maquina:    _val('grp-maq','grp-maquina','rpt-maq-filter','rpt-maq','rel-maq'),
    produto:    _val('grp-prod','grp-produto','rpt-prod','rpt-produto','rel-prod'),
    operador:   _val('grp-op','grp-operador','rpt-op','rpt-operador','rel-op'),
  };
}

// ── Sincronizar filtros externos → inputs internos do rel2-root ───
function _grpSyncFiltros() {
  const f = _grpGetFiltros();
  const _set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  if (f.dataInicio) _set('rel2-data-inicio', f.dataInicio);
  if (f.dataFim)    _set('rel2-data-fim',    f.dataFim);
  if (f.maquina)    _set('rel2-maquina',     f.maquina);
  if (f.produto)    _set('rel2-produto',     f.produto);
}

// ── grpRender — oninput/onchange dos filtros de data, máquina, etc. ─
function grpRender() {
  const rel2root = document.getElementById('rel2-root');
  if (!rel2root) {
    // Painel ainda não inicializado — inicializar primeiro
    initRelatorios();
    setTimeout(() => { _grpSyncFiltros(); renderRelatorios(); }, 80);
    return;
  }
  _grpSyncFiltros();
  renderRelatorios();
}

// ── grpSwitchTab — onclick dos sub-tabs ──────────────────────────
function grpSwitchTab(id) {
  _grpTabAtivo = id;

  // Atualizar visual dos botões de sub-tab
  document.querySelectorAll('[onclick*="grpSwitchTab"], .rpt-grp-btn, .grp-tab-btn, [data-grp-tab]')
    .forEach(btn => {
      const oc = btn.getAttribute('onclick') || '';
      const active = oc.includes("'" + id + "'") || oc.includes('"' + id + '"')
                  || btn.getAttribute('data-grp-tab') === id;
      btn.classList.toggle('active', active);
    });

  const rel2root = document.getElementById('rel2-root');
  if (!rel2root) {
    initRelatorios();
    setTimeout(() => { _grpSyncFiltros(); renderRelatorios(); }, 80);
    return;
  }
  _grpSyncFiltros();
  renderRelatorios();
}

// ── grpClear — botão Limpar ───────────────────────────────────────
function grpClear() {
  ['grp-data-ini','grp-data-fim','grp-inicio','grp-fim','rpt-data-ini','rpt-data-fim']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['grp-maq','grp-maquina','grp-prod','grp-produto','grp-op','grp-operador',
   'rpt-maq-filter','rpt-prod','rpt-op']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  relatorios.limparFiltros();
}

// ── grpExport — botão Excel ───────────────────────────────────────
function grpExport() {
  relatorios.exportXLSX();
}

// ── Expor tudo globalmente (disponível imediatamente, antes do ES module) ─
window.grpRender    = grpRender;
window.grpSwitchTab = grpSwitchTab;
window.grpClear     = grpClear;
window.grpExport    = grpExport;

// Expor globalmente
window.relatorios = relatorios;
window.renderRelatorios = renderRelatorios;

})(); // fim IIFE
