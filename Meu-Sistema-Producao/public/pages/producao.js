export function producao() {
  const app =
    document.getElementById("content") ||
    document.getElementById("root") ||
    document.getElementById("content") ||
    document.getElementById("main") ||
    document.querySelector("main");

  if (!app) {
    console.error("Container principal não encontrado para renderizar Produção Dia.");
    return;
  }

  app.innerHTML = `
    <section id="panel-producao-dia" class="page page-producao-dia">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn btn-ghost" onclick="window.prodDiaWeek && window.prodDiaWeek(-1)">‹ Ant.</button>

          <div
            id="pd-week-label"
            style="background:var(--s1,#111827);border:1px solid var(--border,#243041);border-radius:8px;padding:8px 16px;font-size:13px;color:var(--cyan,#22d3ee)"
          >
            Semana
          </div>

          <button class="btn btn-ghost" onclick="window.prodDiaWeek && window.prodDiaWeek(1)">Próx. ›</button>
          <button class="btn btn-ghost" onclick="window.prodDiaToday && window.prodDiaToday()">Hoje</button>
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="window.pdRestoreAll && window.pdRestoreAll()">↺ Restaurar finalizados</button>
        </div>
      </div>

      <div id="pd-body"></div>
    </section>
  `;

  if (typeof window.initProducaoDiaPage === "function") {
    window.initProducaoDiaPage();
  }
}