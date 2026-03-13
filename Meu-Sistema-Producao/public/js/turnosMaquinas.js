/**
 * turnosMaquinas.js
 * Gerencia configuração de turnos por máquina.
 *
 * Estrutura salva em localStorage (cfg_turnos_maquinas):
 * {
 *   horasPorTurno: 8,          // horas por turno (padrão 8)
 *   maquinas: {
 *     "ALFATECK 14": {
 *       turnos: {
 *         0: [true, true, false],   // Dom: T1 on, T2 on, T3 off
 *         1: [true, true, false],   // Seg: T1 on, T2 on, T3 off
 *         ...
 *         6: [false, false, false]  // Sáb: tudo off
 *       }
 *     },
 *     ...
 *   }
 * }
 *
 * Turnos têm horário fixo:
 *   T1: 06:00 – 14:00
 *   T2: 14:00 – 22:00
 *   T3: 22:00 – 06:00 (do dia seguinte)
 */

// ──────────────────────────────────────────────
// Constantes
// ──────────────────────────────────────────────
const STORAGE_KEY_TURNOS = 'cfg_turnos_maquinas';

// Horários de início de cada turno (minutos desde 00:00)
const TURNOS_HORARIOS = [
  { id: 'T1', label: 'Turno 1', inicio: 6 * 60,  fim: 14 * 60 }, // 06:00–14:00
  { id: 'T2', label: 'Turno 2', inicio: 14 * 60, fim: 22 * 60 }, // 14:00–22:00
  { id: 'T3', label: 'Turno 3', inicio: 22 * 60, fim: 30 * 60 }, // 22:00–06:00 (+1 dia, fim=30h)
];

// ──────────────────────────────────────────────
// Storage helpers
// ──────────────────────────────────────────────
function _loadCfg() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TURNOS);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

function _saveCfg(cfg) {
  try { localStorage.setItem(STORAGE_KEY_TURNOS, JSON.stringify(cfg)); } catch(e) {}
}

function _defaultCfg(maquinas, horasPorTurno) {
  const cfg = { horasPorTurno: horasPorTurno || 8, maquinas: {} };
  (maquinas || []).forEach(m => {
    cfg.maquinas[m] = { turnos: {} };
    for (let d = 0; d < 7; d++) {
      // Default: T1 e T2 ativos de Seg(1) a Sex(5), fds off
      const isWorkday = d >= 1 && d <= 5;
      cfg.maquinas[m].turnos[d] = [isWorkday, isWorkday, false];
    }
  });
  return cfg;
}

// ──────────────────────────────────────────────
// API pública – leitura
// ──────────────────────────────────────────────

/**
 * Retorna array [T1ativo, T2ativo, T3ativo] para a máquina no dia da semana (0=Dom…6=Sáb).
 */
function getTurnosMaquinaDia(maq, diaSemana) {
  const cfg = _loadCfg();
  if (!cfg || !cfg.maquinas || !cfg.maquinas[maq]) return [false, false, false];
  const t = cfg.maquinas[maq].turnos[diaSemana];
  if (!Array.isArray(t)) return [false, false, false];
  return [!!t[0], !!t[1], !!t[2]];
}

/**
 * Retorna horas por turno configuradas.
 */
function getHorasPorTurno() {
  const cfg = _loadCfg();
  return (cfg && cfg.horasPorTurno) ? cfg.horasPorTurno : 8;
}

/**
 * Retorna total de horas disponíveis para a máquina em uma data específica.
 * Soma apenas os turnos ativos.
 */
function hoursOnDayForMaq(date, maq) {
  const dia = date.getDay(); // 0=Dom…6=Sáb
  const ativos = getTurnosMaquinaDia(maq, dia);
  const hPorTurno = getHorasPorTurno();
  const qtdAtivos = ativos.filter(Boolean).length;
  return qtdAtivos * hPorTurno;
}

/**
 * Retorna total de horas disponíveis para a máquina na semana (dom a sáb).
 * monday: Date do início da semana.
 */
function weekHoursForMaq(monday, maq) {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    total += hoursOnDayForMaq(d, maq);
  }
  return total;
}

/**
 * Retorna os blocos de turno ativos para a máquina em uma data específica.
 * Cada bloco: { turnoIdx: 0|1|2, label:'T1'|'T2'|'T3', inicioMin, fimMin, duracaoMin }
 * Os blocos estão em ordem cronológica.
 * inicioMin/fimMin são minutos desde 00:00 do DIA (T3 tem fimMin > 1440 para indicar dia seguinte).
 */
function getActiveShiftBlocks(date, maq) {
  const dia = date.getDay();
  const ativos = getTurnosMaquinaDia(maq, dia);
  const hPorTurno = getHorasPorTurno();
  const durMin = hPorTurno * 60;

  const blocos = [];
  TURNOS_HORARIOS.forEach((t, idx) => {
    if (!ativos[idx]) return;
    blocos.push({
      turnoIdx: idx,
      label: t.id,
      inicioMin: t.inicio,
      fimMin: t.inicio + durMin,
    });
  });
  return blocos; // já em ordem cronológica (T1 < T2 < T3)
}

// ──────────────────────────────────────────────
// API pública – escrita / inicialização
// ──────────────────────────────────────────────

/**
 * Inicializa a configuração para as máquinas fornecidas, preservando dados existentes.
 */
function initTurnosCfgForMaquinas(maquinas, horasPorTurno) {
  let cfg = _loadCfg();
  if (!cfg) {
    cfg = _defaultCfg(maquinas, horasPorTurno);
    _saveCfg(cfg);
    return;
  }
  if (!cfg.maquinas) cfg.maquinas = {};
  if (horasPorTurno) cfg.horasPorTurno = horasPorTurno;
  // Garante que toda máquina nova tenha config
  (maquinas || []).forEach(m => {
    if (!cfg.maquinas[m]) {
      cfg.maquinas[m] = { turnos: {} };
      for (let d = 0; d < 7; d++) {
        const isWorkday = d >= 1 && d <= 5;
        cfg.maquinas[m].turnos[d] = [isWorkday, isWorkday, false];
      }
    }
  });
  _saveCfg(cfg);
}

/**
 * Liga/desliga um turno de uma máquina num dia.
 * turnoIdx: 0=T1, 1=T2, 2=T3.
 */
function toggleTurnoMaq(maq, diaSemana, turnoIdx) {
  const cfg = _loadCfg();
  if (!cfg || !cfg.maquinas || !cfg.maquinas[maq]) return;
  const t = cfg.maquinas[maq].turnos[diaSemana];
  if (!Array.isArray(t)) return;
  t[turnoIdx] = !t[turnoIdx];
  _saveCfg(cfg);
}

function saveTurnosMaquinas() {
  // A config é salva em tempo real via toggleTurnoMaq; esta função dispara refresh visual
  if (typeof renderGantt === 'function' && typeof ganttBaseMonday !== 'undefined' && ganttBaseMonday) {
    renderGantt();
  }
  if (typeof renderMaquinas === 'function') renderMaquinas();
}

function resetTurnosMaquinas(maquinas, horasPorTurno) {
  localStorage.removeItem(STORAGE_KEY_TURNOS);
  initTurnosCfgForMaquinas(maquinas, horasPorTurno);
  if (typeof renderTurnosMaquinas === 'function') renderTurnosMaquinas(maquinas, horasPorTurno);
  saveTurnosMaquinas();
}

/**
 * Copia configuração de turnos de uma máquina origem para uma ou mais destinos.
 */
function copiarTurnosMaquinas(maqOrigem, maqsDestino) {
  const cfg = _loadCfg();
  if (!cfg || !cfg.maquinas || !cfg.maquinas[maqOrigem]) return;
  const origem = cfg.maquinas[maqOrigem];
  (maqsDestino || []).forEach(m => {
    if (m === maqOrigem) return;
    cfg.maquinas[m] = JSON.parse(JSON.stringify(origem));
  });
  _saveCfg(cfg);
}

// ──────────────────────────────────────────────
// UI – renderiza aba "Turnos por Máquina"
// ──────────────────────────────────────────────
const DAY_LABELS_TM = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

function renderTurnosMaquinas(maquinas, horasPorTurno) {
  initTurnosCfgForMaquinas(maquinas, horasPorTurno);
  const cfg = _loadCfg();
  const hpt = cfg.horasPorTurno || 8;

  // Target: scontent-turnos (the bare container)
  const container = document.getElementById('scontent-turnos');
  if (!container) return;

  let html = `
  <div style="width:100%;max-width:1100px;padding:20px 0">

    <div style="background:var(--s1);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <!-- Header -->
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div style="display:flex;align-items:center;gap:8px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span style="font-size:13px;font-weight:700;color:var(--text)">Turnos por Máquina</span>
          <span style="font-size:11px;color:var(--text3)">— T1: 06:00–14:00 · T2: 14:00–22:00 · T3: 22:00–06:00</span>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:6px">
            Horas/turno:
            <input id="tm-hpt" type="number" min="1" max="12" value="${hpt}"
              style="width:56px;padding:4px 6px;border:1px solid var(--border2);border-radius:6px;background:var(--s2);color:var(--text);font-size:13px;font-family:'JetBrains Mono',monospace">
          </label>
          <button id="tm-reset-btn"
            style="padding:6px 12px;border:1px solid var(--border2);border-radius:6px;background:var(--s2);color:var(--text3);font-size:11px;cursor:pointer">
            ↺ Resetar
          </button>
        </div>
      </div>

      <!-- Table -->
      <div style="overflow-x:auto;padding:14px 16px">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead>
          <tr style="background:var(--s2)">
            <th style="padding:8px 12px;text-align:left;color:var(--text3);font-weight:600;white-space:nowrap;border-bottom:1px solid var(--border)">Máquina</th>
            ${DAY_LABELS_TM.map(d=>`<th colspan="3" style="padding:8px 6px;text-align:center;color:var(--text2);font-weight:600;border-bottom:1px solid var(--border);border-left:1px solid var(--border2)">${d}</th>`).join('')}
            <th style="padding:8px 6px;text-align:center;color:var(--text3);font-weight:600;border-bottom:1px solid var(--border);border-left:2px solid var(--border2);white-space:nowrap">H/sem</th>
            <th style="padding:8px 6px;text-align:center;color:var(--text3);border-bottom:1px solid var(--border);border-left:1px solid var(--border2)">Copiar</th>
          </tr>
          <tr style="background:var(--s1)">
            <th style="border-bottom:2px solid var(--border2)"></th>
            ${[0,1,2,3,4,5,6].map(()=>`
              <th style="padding:3px 4px;text-align:center;color:var(--cyan);font-size:9px;border-left:1px solid var(--border2)">T1</th>
              <th style="padding:3px 4px;text-align:center;color:var(--purple);font-size:9px">T2</th>
              <th style="padding:3px 4px;text-align:center;color:var(--orange);font-size:9px">T3</th>
            `).join('')}
            <th style="border-bottom:2px solid var(--border2);border-left:2px solid var(--border2)"></th>
            <th style="border-bottom:2px solid var(--border2)"></th>
          </tr>
        </thead>
        <tbody>`;

  (maquinas || []).forEach((maq, mi) => {
    const maqCfg = cfg.maquinas[maq] || { turnos: {} };
    let weekHrs = 0;
    for (let d = 0; d < 7; d++) {
      const t = maqCfg.turnos[d] || [false, false, false];
      weekHrs += t.filter(Boolean).length * hpt;
    }
    const maqEncoded = encodeURIComponent(maq);

    html += `<tr style="background:${mi%2===0?'var(--s1)':'var(--s0)'};border-bottom:1px solid var(--border)" data-maq="${maqEncoded}">
      <td style="padding:7px 12px;color:var(--purple);font-weight:600;font-family:'JetBrains Mono',monospace;font-size:11px;white-space:nowrap">${maq}</td>`;

    for (let d = 0; d < 7; d++) {
      const t = maqCfg.turnos[d] || [false, false, false];
      html += `<td style="border-left:1px solid var(--border2)">`;
      [0, 1, 2].forEach(ti => {
        const on = !!t[ti];
        const colors = ['var(--cyan)', 'var(--purple)', 'var(--orange)'];
        html += `<label style="display:flex;justify-content:center;align-items:center;padding:5px 4px;cursor:pointer" title="T${ti+1} ${DAY_LABELS_TM[d]}">
          <input type="checkbox" class="tm-check" ${on ? 'checked' : ''}
            data-maq="${maqEncoded}" data-dia="${d}" data-turno="${ti}"
            style="width:14px;height:14px;accent-color:${colors[ti]};cursor:pointer">
        </label>`;
      });
      html += `</td>`;
    }

    // H/sem
    const weekColor = weekHrs === 0 ? 'var(--text4)' : weekHrs >= 100 ? 'var(--cyan)' : 'var(--text2)';
    html += `<td class="tm-hrsem" data-maq="${maqEncoded}" style="text-align:center;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:${weekColor};border-left:2px solid var(--border2);padding:0 8px">${weekHrs}h</td>`;

    // Copiar
    html += `<td style="text-align:center;border-left:1px solid var(--border2);padding:0 8px">
      <button class="tm-copy-btn" data-maq="${maqEncoded}"
        style="font-size:9px;padding:3px 7px;border:1px solid var(--border2);border-radius:4px;background:var(--s2);color:var(--text3);cursor:pointer;white-space:nowrap"
        title="Copiar turnos desta máquina para todas as outras">→ Todas</button>
    </td>`;

    html += `</tr>`;
  });

  html += `</tbody></table>
      </div><!-- /overflow-x:auto -->

      <div style="margin:0 16px 16px;padding:10px 14px;background:var(--s2);border-radius:7px;font-size:10px;color:var(--text3);line-height:1.7">
        <strong style="color:var(--text2)">💡 Como funciona:</strong>
        Cada checkbox ativa um turno de ${hpt}h para a máquina naquele dia da semana.
        T1 = 06:00–14:00 · T2 = 14:00–22:00 · T3 = 22:00–06:00.
        O algoritmo distribui a produção respeitando exatamente esses blocos.
      </div>
    </div>
  </div>`;

  container.innerHTML = html;
  container.style.display = 'flex';
  container.style.flexDirection = 'column';

  // ── Event listeners (evita problemas de escape em onclick inline) ──

  // Checkbox toggle
  container.querySelectorAll('.tm-check').forEach(cb => {
    cb.addEventListener('change', function() {
      const maq = decodeURIComponent(this.dataset.maq);
      const dia = parseInt(this.dataset.dia);
      const turno = parseInt(this.dataset.turno);
      toggleTurnoMaq(maq, dia, turno);
      _recalcHsemCell(container, this.dataset.maq, maquinas, hpt);
      if (typeof saveTurnosMaquinas === 'function') saveTurnosMaquinas();
    });
  });

  // Horas/turno input
  const hptInput = container.querySelector('#tm-hpt');
  if (hptInput) {
    hptInput.addEventListener('change', function() {
      const newHpt = parseInt(this.value) || 8;
      const c = _loadCfg();
      c.horasPorTurno = newHpt;
      _saveCfg(c);
      if (typeof saveTurnosMaquinas === 'function') saveTurnosMaquinas();
      renderTurnosMaquinas(maquinas, horasPorTurno);
    });
  }

  // Resetar
  const resetBtn = container.querySelector('#tm-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function() {
      if (typeof resetTurnosMaquinas === 'function') resetTurnosMaquinas(maquinas, horasPorTurno);
    });
  }

  // Copiar para todas
  container.querySelectorAll('.tm-copy-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const maq = decodeURIComponent(this.dataset.maq);
      const outros = (maquinas || []).filter(m => m !== maq);
      copiarTurnosMaquinas(maq, outros);
      renderTurnosMaquinas(maquinas, horasPorTurno);
      if (typeof saveTurnosMaquinas === 'function') saveTurnosMaquinas();
    });
  });
}

// Recalculate H/sem cell for one machine without full re-render
function _recalcHsemCell(container, maqEncoded, maquinas, hpt) {
  const cfg = _loadCfg();
  const maq = decodeURIComponent(maqEncoded);
  if (!cfg || !cfg.maquinas || !cfg.maquinas[maq]) return;
  let weekHrs = 0;
  for (let d = 0; d < 7; d++) {
    const t = cfg.maquinas[maq].turnos[d] || [false, false, false];
    weekHrs += t.filter(Boolean).length * hpt;
  }
  const cell = container.querySelector(`.tm-hrsem[data-maq="${maqEncoded}"]`);
  if (!cell) return;
  cell.textContent = weekHrs + 'h';
  cell.style.color = weekHrs === 0 ? 'var(--text4)' : weekHrs >= 100 ? 'var(--cyan)' : 'var(--text2)';
}
