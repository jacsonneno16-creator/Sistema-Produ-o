/**
 * turnosMaquinas.js  v3
 * Configuração de jornada por máquina usando faixas de horário reais.
 *
 * Nova estrutura (cfg_turnos_maquinas_v3):
 * {
 *   maquinas: {
 *     "ALFATECK 14": {
 *       dias: {
 *         1: [ { ini: "08:00", fim: "17:00" } ],  // Seg: 9h
 *         2: [ { ini: "08:00", fim: "12:00" } ],  // Ter: 4h
 *         3: [],                                    // Qua: inativa
 *         ...
 *       }
 *     }
 *   }
 * }
 * A chave de dia é 0=Dom…6=Sáb (getDay()).
 * T1/T2/T3 continuam como atalhos de preenchimento rápido com horários editáveis.
 */

const STORAGE_KEY_TURNOS    = 'cfg_turnos_maquinas_v3';
const STORAGE_KEY_TURNOS_HR = 'cfg_turnos_horarios';

const DEFAULT_TURNO_HR = [
  { id: 'T1', ini: '06:00', fim: '14:00' },
  { id: 'T2', ini: '14:00', fim: '22:00' },
  { id: 'T3', ini: '22:00', fim: '06:00' },
];

const DAY_LABELS_TM = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

// ── helpers de tempo ──
function _hhmm2min(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return 0;
  const parts = hhmm.split(':');
  return (parseInt(parts[0])||0)*60 + (parseInt(parts[1])||0);
}
function _faixaDurHrs(faixa) {
  let iniMin = _hhmm2min(faixa.ini);
  let fimMin = _hhmm2min(faixa.fim);
  if (fimMin <= iniMin) fimMin += 1440;
  return Math.max(0, (fimMin - iniMin) / 60);
}

// ── storage ──
function _loadCfg() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TURNOS);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}
function _saveCfg(cfg) {
  try { localStorage.setItem(STORAGE_KEY_TURNOS, JSON.stringify(cfg)); } catch(e) {}
}
function _loadTurnoHr() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TURNOS_HR);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length === 3) return p; }
  } catch(e) {}
  return JSON.parse(JSON.stringify(DEFAULT_TURNO_HR));
}
function _saveTurnoHr(arr) {
  try { localStorage.setItem(STORAGE_KEY_TURNOS_HR, JSON.stringify(arr)); } catch(e) {}
}

function _defaultDiasCfg() {
  const dias = {};
  for (let d = 0; d < 7; d++) {
    dias[d] = (d >= 1 && d <= 5) ? [{ ini: '08:00', fim: '17:00' }] : [];
  }
  return dias;
}
function _defaultCfg(maquinas) {
  const cfg = { maquinas: {} };
  (maquinas || []).forEach(m => { cfg.maquinas[m] = { dias: _defaultDiasCfg() }; });
  return cfg;
}

// ── inicialização ──
function initTurnosCfgForMaquinas(maquinas) {
  let cfg = _loadCfg();
  if (!cfg) { cfg = _defaultCfg(maquinas); _saveCfg(cfg); return; }
  if (!cfg.maquinas) cfg.maquinas = {};
  (maquinas || []).forEach(m => {
    if (!cfg.maquinas[m]) {
      cfg.maquinas[m] = { dias: _defaultDiasCfg() };
    } else if (!cfg.maquinas[m].dias) {
      cfg.maquinas[m].dias = _defaultDiasCfg(); // migração formato antigo
    }
  });
  _saveCfg(cfg);
}

// ── API pública leitura (usada pelo app.js) ──
function hoursOnDayForMaqRaw(cfg, maq, dia) {
  if (!cfg || !cfg.maquinas || !cfg.maquinas[maq]) return 0;
  const faixas = (cfg.maquinas[maq].dias || {})[dia] || [];
  return faixas.reduce((acc, f) => acc + _faixaDurHrs(f), 0);
}

function hoursOnDayForMaq(date, maq) {
  const cfg = _loadCfg();
  return hoursOnDayForMaqRaw(cfg, maq, date.getDay());
}

function weekHoursForMaq(monday, maq) {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    total += hoursOnDayForMaq(d, maq);
  }
  return Math.round(total * 10) / 10;
}

function getActiveShiftBlocks(date, maq) {
  const cfg = _loadCfg();
  if (!cfg || !cfg.maquinas || !cfg.maquinas[maq]) return [];
  const faixas = (cfg.maquinas[maq].dias || {})[date.getDay()] || [];
  return faixas.map((f, idx) => {
    let iniMin = _hhmm2min(f.ini);
    let fimMin = _hhmm2min(f.fim);
    if (fimMin <= iniMin) fimMin += 1440;
    return { turnoIdx: idx, label: 'F'+(idx+1), inicioMin: iniMin, fimMin };
  }).filter(b => b.fimMin > b.inicioMin);
}

function getTurnosMaquinaDia(maq, diaSemana) {
  const hrs = hoursOnDayForMaqRaw(_loadCfg(), maq, diaSemana);
  return [hrs > 0, hrs > 8, hrs > 16];
}

// ── API escrita ──
function saveTurnosMaquinas() {
  if (typeof renderGantt === 'function' && typeof ganttBaseMonday !== 'undefined' && ganttBaseMonday) renderGantt();
  if (typeof renderMaquinas === 'function') renderMaquinas();
}

function resetTurnosMaquinas(maquinas) {
  localStorage.removeItem(STORAGE_KEY_TURNOS);
  localStorage.removeItem(STORAGE_KEY_TURNOS_HR);
  initTurnosCfgForMaquinas(maquinas);
  if (typeof renderTurnosMaquinas === 'function') renderTurnosMaquinas(maquinas);
  saveTurnosMaquinas();
}

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

function _addFaixa(maqEncoded, dia) {
  const cfg = _loadCfg(); const maq = decodeURIComponent(maqEncoded);
  if (!cfg.maquinas[maq]) return;
  cfg.maquinas[maq].dias[dia] = cfg.maquinas[maq].dias[dia] || [];
  cfg.maquinas[maq].dias[dia].push({ ini: '08:00', fim: '17:00' });
  _saveCfg(cfg);
}
function _removeFaixa(maqEncoded, dia, fi) {
  const cfg = _loadCfg(); const maq = decodeURIComponent(maqEncoded);
  if (!cfg.maquinas[maq]) return;
  (cfg.maquinas[maq].dias[dia] || []).splice(fi, 1);
  _saveCfg(cfg);
}
function _updateFaixa(maqEncoded, dia, fi, patch) {
  const cfg = _loadCfg(); const maq = decodeURIComponent(maqEncoded);
  if (!cfg.maquinas[maq]) return;
  const arr = cfg.maquinas[maq].dias[dia] || [];
  if (!arr[fi]) return;
  Object.assign(arr[fi], patch);
  cfg.maquinas[maq].dias[dia] = arr;
  _saveCfg(cfg);
  saveTurnosMaquinas();
}
function _refreshDayCell(container, maqEncoded, dia) {
  const cfg = _loadCfg(); const maq = decodeURIComponent(maqEncoded);
  if (!cfg || !cfg.maquinas || !cfg.maquinas[maq]) return;
  const faixas = (cfg.maquinas[maq].dias || {})[dia] || [];
  const dayHrs = faixas.reduce((a,f) => a + _faixaDurHrs(f), 0);
  const dayEl = container.querySelector('.tm-day-hrs[data-maq="'+maqEncoded+'"][data-dia="'+dia+'"]');
  if (dayEl) { dayEl.textContent = dayHrs > 0 ? dayHrs.toFixed(1)+'h' : ''; dayEl.style.color = dayHrs > 0 ? 'var(--cyan)' : 'var(--text4)'; }
  let weekTotal = 0;
  for (let d = 0; d < 7; d++) weekTotal += hoursOnDayForMaqRaw(cfg, maq, d);
  weekTotal = Math.round(weekTotal * 10) / 10;
  const weekEl = container.querySelector('.tm-hrsem[data-maq="'+maqEncoded+'"]');
  if (weekEl) { weekEl.textContent = weekTotal > 0 ? weekTotal+'h' : '—'; weekEl.style.color = weekTotal === 0 ? 'var(--text4)' : weekTotal >= 80 ? 'var(--cyan)' : 'var(--text2)'; }
}

// ── UI ──
function renderTurnosMaquinas(maquinas) {
  initTurnosCfgForMaquinas(maquinas);
  const container = document.getElementById('scontent-turnos');
  if (!container) return;
  const cfg  = _loadCfg();
  const tHrs = _loadTurnoHr();
  const TURNO_COLS = ['var(--cyan)','var(--purple)','var(--orange)'];

  function calcWeekHrs(maq) {
    let t = 0; for (let d = 0; d < 7; d++) t += hoursOnDayForMaqRaw(cfg, maq, d);
    return Math.round(t * 10) / 10;
  }

  let html = `<div style="width:100%;padding:20px 0 40px">
  <div style="background:var(--s1);border:1px solid var(--border);border-radius:10px;overflow:hidden">

    <!-- Header -->
    <div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:8px">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span style="font-size:13px;font-weight:700;color:var(--text)">Jornada por Máquina</span>
        <span style="font-size:11px;color:var(--text3)">— Configure as faixas de horário reais de cada máquina por dia da semana</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button id="tm-turno-shortcuts-btn" style="padding:5px 11px;border:1px solid rgba(0,212,255,.3);border-radius:6px;background:rgba(0,212,255,.07);color:var(--cyan);font-size:11px;cursor:pointer">⚡ Atalhos T1/T2/T3</button>
        <button id="tm-reset-btn" style="padding:5px 11px;border:1px solid var(--border2);border-radius:6px;background:var(--s2);color:var(--text3);font-size:11px;cursor:pointer">↺ Resetar tudo</button>
      </div>
    </div>

    <!-- Painel de atalhos (oculto por padrão) -->
    <div id="tm-shortcuts-panel" style="display:none;padding:14px 18px;border-bottom:1px solid var(--border);background:rgba(0,212,255,.03)">
      <div style="font-size:11px;color:var(--text2);font-weight:600;margin-bottom:10px">⚡ Atalhos de turno — edite os horários e clique T1/T2/T3 em qualquer célula para aplicar</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        ${tHrs.map((t,i)=>`
        <div style="display:flex;align-items:center;gap:8px;background:var(--s2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px">
          <span style="font-size:12px;font-weight:700;color:${TURNO_COLS[i]}">${t.id}</span>
          <input class="tm-thr-ini" data-tidx="${i}" type="time" value="${t.ini}" style="background:var(--s0);border:1px solid var(--border2);border-radius:5px;color:var(--text);font-size:12px;padding:3px 6px;font-family:'JetBrains Mono',monospace;width:88px">
          <span style="color:var(--text3);font-size:11px">–</span>
          <input class="tm-thr-fim" data-tidx="${i}" type="time" value="${t.fim}" style="background:var(--s0);border:1px solid var(--border2);border-radius:5px;color:var(--text);font-size:12px;padding:3px 6px;font-family:'JetBrains Mono',monospace;width:88px">
          <span class="tm-thr-dur" data-tidx="${i}" style="font-size:10px;color:var(--text3);min-width:28px">${_faixaDurHrs({ini:t.ini,fim:t.fim}).toFixed(1)}h</span>
        </div>`).join('')}
      </div>
    </div>

    <!-- Tabela -->
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:11px;min-width:960px">
      <thead>
        <tr style="background:var(--s2);border-bottom:2px solid var(--border2)">
          <th style="padding:10px 14px;text-align:left;color:var(--text3);font-weight:600;white-space:nowrap;min-width:130px">Máquina</th>
          ${DAY_LABELS_TM.map(d=>`<th style="padding:8px 6px;text-align:center;color:var(--text2);font-weight:600;border-left:1px solid var(--border2);min-width:115px">${d}</th>`).join('')}
          <th style="padding:8px 10px;text-align:center;color:var(--text3);font-weight:600;border-left:2px solid var(--border2);white-space:nowrap">H/sem</th>
          <th style="padding:8px 10px;text-align:center;color:var(--text3);border-left:1px solid var(--border2)">Copiar</th>
        </tr>
      </thead>
      <tbody>`;

  (maquinas || []).forEach((maq, mi) => {
    const maqCfg  = cfg.maquinas[maq] || { dias: _defaultDiasCfg() };
    const weekHrs = calcWeekHrs(maq);
    const maqEnc  = encodeURIComponent(maq);
    const wColor  = weekHrs === 0 ? 'var(--text4)' : weekHrs >= 80 ? 'var(--cyan)' : 'var(--text2)';

    html += `<tr style="background:${mi%2===0?'var(--s1)':'var(--s0)'};border-bottom:1px solid var(--border)">
      <td style="padding:10px 14px;color:var(--purple);font-weight:600;font-family:'JetBrains Mono',monospace;font-size:11px;white-space:nowrap;vertical-align:top">${maq}</td>`;

    for (let d = 0; d < 7; d++) {
      const faixas = (maqCfg.dias || {})[d] || [];
      const dayHrs = faixas.reduce((a,f) => a + _faixaDurHrs(f), 0);
      const dColor = dayHrs === 0 ? 'var(--text4)' : 'var(--cyan)';

      html += `<td style="border-left:1px solid var(--border2);padding:6px 6px;vertical-align:top">
        <div class="tm-faixas" data-maq="${maqEnc}" data-dia="${d}">`;

      if (faixas.length === 0) {
        html += `<div style="text-align:center;color:var(--text4);font-size:10px;padding:4px 0;line-height:1.4">—<br><span style="font-size:9px">inativa</span></div>`;
      } else {
        faixas.forEach((f, fi) => {
          html += `<div style="display:flex;align-items:center;gap:3px;margin-bottom:4px">
            <input type="time" class="tm-ini" value="${f.ini}" data-maq="${maqEnc}" data-dia="${d}" data-fi="${fi}"
              style="width:74px;background:var(--s0);border:1px solid var(--border2);border-radius:4px;color:var(--text);font-size:10px;padding:2px 4px;font-family:'JetBrains Mono',monospace">
            <span style="color:var(--text4);font-size:9px">–</span>
            <input type="time" class="tm-fim" value="${f.fim}" data-maq="${maqEnc}" data-dia="${d}" data-fi="${fi}"
              style="width:74px;background:var(--s0);border:1px solid var(--border2);border-radius:4px;color:var(--text);font-size:10px;padding:2px 4px;font-family:'JetBrains Mono',monospace">
            <button class="tm-del-faixa" data-maq="${maqEnc}" data-dia="${d}" data-fi="${fi}"
              style="background:none;border:none;color:var(--text4);cursor:pointer;font-size:14px;padding:0 2px;line-height:1;opacity:.6" title="Remover">×</button>
          </div>`;
        });
      }

      html += `</div>
        <div style="display:flex;align-items:center;gap:3px;margin-top:3px;flex-wrap:wrap">
          <span class="tm-day-hrs" data-maq="${maqEnc}" data-dia="${d}"
            style="font-size:9px;font-family:'JetBrains Mono',monospace;font-weight:700;color:${dColor};min-width:24px">
            ${dayHrs > 0 ? dayHrs.toFixed(1)+'h' : ''}
          </span>
          <button class="tm-add-faixa" data-maq="${maqEnc}" data-dia="${d}"
            style="font-size:9px;padding:2px 5px;border:1px dashed var(--border2);border-radius:4px;background:none;color:var(--text3);cursor:pointer">+faixa</button>
          ${tHrs.map((t,ti)=>`<button class="tm-apply-turno" data-maq="${maqEnc}" data-dia="${d}" data-tidx="${ti}"
            style="font-size:8px;padding:2px 4px;border:1px solid ${TURNO_COLS[ti]}44;border-radius:4px;background:none;color:${TURNO_COLS[ti]};cursor:pointer">${t.id}</button>`).join('')}
        </div>
      </td>`;
    }

    html += `<td class="tm-hrsem" data-maq="${maqEnc}"
      style="text-align:center;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${wColor};border-left:2px solid var(--border2);padding:0 10px;white-space:nowrap;vertical-align:middle">
      ${weekHrs > 0 ? weekHrs+'h' : '—'}
    </td>
    <td style="text-align:center;border-left:1px solid var(--border2);padding:0 8px;vertical-align:middle">
      <button class="tm-copy-btn" data-maq="${maqEnc}"
        style="font-size:9px;padding:3px 8px;border:1px solid var(--border2);border-radius:4px;background:var(--s2);color:var(--text3);cursor:pointer;white-space:nowrap">→ Todas</button>
    </td></tr>`;
  });

  html += `</tbody></table></div>
    <div style="margin:12px 16px 16px;padding:10px 14px;background:var(--s2);border-radius:7px;font-size:10px;color:var(--text3);line-height:1.8">
      <strong style="color:var(--text2)">💡 Como usar:</strong>
      Configure início e fim de cada faixa de trabalho.
      Use <strong style="color:var(--cyan)">+faixa</strong> para múltiplos períodos no mesmo dia (ex: manhã + tarde com intervalo).
      Use <strong style="color:var(--cyan)">T1/T2/T3</strong> como atalhos para preencher turnos pré-definidos.
      O cálculo de capacidade usa a soma exata das horas configuradas.
    </div>
  </div></div>`;

  container.innerHTML = html;
  container.style.display = 'flex';
  container.style.flexDirection = 'column';

  // ── Events ──

  // Toggle atalhos
  container.querySelector('#tm-turno-shortcuts-btn').addEventListener('click', () => {
    const p = container.querySelector('#tm-shortcuts-panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });

  // Editar horários dos atalhos
  container.querySelectorAll('.tm-thr-ini, .tm-thr-fim').forEach(inp => {
    inp.addEventListener('change', function() {
      const tidx = parseInt(this.dataset.tidx);
      const arr = _loadTurnoHr();
      if (this.classList.contains('tm-thr-ini')) arr[tidx].ini = this.value;
      else arr[tidx].fim = this.value;
      _saveTurnoHr(arr);
      const durEl = container.querySelector('.tm-thr-dur[data-tidx="'+tidx+'"]');
      if (durEl) durEl.textContent = _faixaDurHrs({ini:arr[tidx].ini,fim:arr[tidx].fim}).toFixed(1)+'h';
    });
  });

  // Editar hora ini de faixa
  container.querySelectorAll('.tm-ini').forEach(inp => {
    inp.addEventListener('change', function() {
      _updateFaixa(this.dataset.maq, +this.dataset.dia, +this.dataset.fi, { ini: this.value });
      _refreshDayCell(container, this.dataset.maq, +this.dataset.dia);
    });
  });
  // Editar hora fim de faixa
  container.querySelectorAll('.tm-fim').forEach(inp => {
    inp.addEventListener('change', function() {
      _updateFaixa(this.dataset.maq, +this.dataset.dia, +this.dataset.fi, { fim: this.value });
      _refreshDayCell(container, this.dataset.maq, +this.dataset.dia);
    });
  });

  // Remover faixa
  container.querySelectorAll('.tm-del-faixa').forEach(btn => {
    btn.addEventListener('click', function() {
      _removeFaixa(this.dataset.maq, +this.dataset.dia, +this.dataset.fi);
      renderTurnosMaquinas(maquinas); saveTurnosMaquinas();
    });
  });

  // Adicionar faixa
  container.querySelectorAll('.tm-add-faixa').forEach(btn => {
    btn.addEventListener('click', function() {
      _addFaixa(this.dataset.maq, +this.dataset.dia);
      renderTurnosMaquinas(maquinas); saveTurnosMaquinas();
    });
  });

  // Aplicar atalho T1/T2/T3
  container.querySelectorAll('.tm-apply-turno').forEach(btn => {
    btn.addEventListener('click', function() {
      const maq  = decodeURIComponent(this.dataset.maq);
      const dia  = +this.dataset.dia;
      const tidx = +this.dataset.tidx;
      const arr  = _loadTurnoHr();
      const t    = arr[tidx];
      const c    = _loadCfg();
      if (!c.maquinas[maq]) return;
      c.maquinas[maq].dias[dia] = [{ ini: t.ini, fim: t.fim }];
      _saveCfg(c);
      renderTurnosMaquinas(maquinas); saveTurnosMaquinas();
    });
  });

  // Resetar
  container.querySelector('#tm-reset-btn').addEventListener('click', () => {
    if (confirm('Resetar toda a configuração de jornada para o padrão (Seg–Sex 08:00–17:00)?')) {
      resetTurnosMaquinas(maquinas);
    }
  });

  // Copiar para todas
  container.querySelectorAll('.tm-copy-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const maq = decodeURIComponent(this.dataset.maq);
      copiarTurnosMaquinas(maq, (maquinas||[]).filter(m => m !== maq));
      renderTurnosMaquinas(maquinas); saveTurnosMaquinas();
    });
  });
}
