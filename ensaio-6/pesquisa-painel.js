/*
 * Pesquisa educativa — painel estatístico (apresentação).
 *
 * Só desenha o que pesquisa-estatistica.js calculou: medidas agregadas, histogramas em SVG,
 * contagem por faixa etária e textos pedagógicos. NÃO renderiza tabela de registros individuais,
 * IDs, horários, nomes ou datas de nascimento. Sem bibliotecas, sem rede.
 *
 * Estado de envio (Rodada 5): um parágrafo separado (#painelEnvio) mostra o que a janela de coleta informou por
 * canal entre janelas de pesquisa-projecao.js (somente contagens). Ele NUNCA altera os números do painel: as estatísticas dependem só dos registros,
 * e um registro passar de pendente a confirmado não muda nenhuma medida. Sem sinal recente, não se afirma "tudo salvo".
 *
 * Atualização: update() redesenha apenas quando o modelo mudou e nunca move o foco; o seletor
 * de faixa etária não é recriado, e o estado aberto dos <details> é preservado.
 */
(function (root) {
  "use strict";
  if (typeof document === "undefined") return;

  const Estatistica = root.PesquisaEstatistica;
  if (!Estatistica) return;

  const $ = (id) => document.getElementById(id);
  const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function create(options) {
    const store = options.store;
    const section = $("painelSection");
    if (!section) return { update() {}, isActive: () => false };

    const projection = options.projection || null;
    const syncBox = $("painelEnvio");
    let syncTimer = null;
    let projectionStarted = false;
    let lastSyncText = null;
    const select = $("painelFaixa");
    let band = "todos";
    let lastSignature = null;

    // ---------- seletor (criado uma vez) ----------
    const optionsList = [{ id: "todos", label: "Todos os participantes" }].concat(Estatistica.AGE_BANDS.map((b) => ({ id: b.id, label: b.label })));
    optionsList.forEach((o) => {
      const el = document.createElement("option");
      el.value = o.id;
      el.textContent = o.label;
      select.appendChild(el);
    });
    select.addEventListener("change", () => { band = select.value; update(true); });

    // ---------- gráficos ----------

    function histogramSvg(key, h) {
      const spec = h.spec;
      const classes = h.classes;
      const W = 680, H = 330, ml = 52, mr = 18, mt = 44, mb = 74;
      const pw = W - ml - mr, ph = H - mt - mb;
      const maxCount = Math.max(...classes.map((c) => c.count));
      const step = Math.max(1, Math.ceil(maxCount / 5));
      const yMax = Math.ceil(maxCount / step) * step;
      const bw = pw / classes.length;
      const x0 = classes[0].lo, x1 = classes[classes.length - 1].hi;
      const xOf = (v) => ml + ((v - x0) / (x1 - x0)) * pw;
      const yOf = (c) => mt + ph - (c / yMax) * ph;
      const modalSet = new Set(h.modal.kind === "sem-destaque" || h.modal.kind === "sem-dados" ? [] : h.modal.classes.map((c) => c.lo));
      const parts = [];
      for (let t = 0; t <= yMax; t += step) {
        parts.push(`<line class="ch-grid" x1="${ml}" x2="${W - mr}" y1="${yOf(t)}" y2="${yOf(t)}"/><text class="ch-tick" x="${ml - 8}" y="${yOf(t) + 4}" text-anchor="end">${t}</text>`);
      }
      classes.forEach((c, i) => {
        const x = ml + i * bw;
        const height = (c.count / yMax) * ph;
        parts.push(`<rect class="ch-bar${modalSet.has(c.lo) ? " is-modal" : ""}" x="${x + 1}" y="${yOf(c.count)}" width="${Math.max(0, bw - 2)}" height="${height}"/>`);
        if (c.count > 0) parts.push(`<text class="ch-count" x="${x + bw / 2}" y="${yOf(c.count) - 5}" text-anchor="middle">${c.count}</text>`);
      });
      const every = Math.max(1, Math.ceil(46 / bw));
      for (let i = 0; i <= classes.length; i += every) {
        const edge = i === classes.length ? x1 : classes[i].lo;
        parts.push(`<line class="ch-axis" x1="${ml + i * bw}" x2="${ml + i * bw}" y1="${mt + ph}" y2="${mt + ph + 5}"/><text class="ch-tick" x="${ml + i * bw}" y="${mt + ph + 19}" text-anchor="middle">${Estatistica.formatNumber(edge, spec.decimals)}</text>`);
      }
      parts.push(`<line class="ch-axis" x1="${ml}" x2="${W - mr}" y1="${mt + ph}" y2="${mt + ph}"/><line class="ch-axis" x1="${ml}" x2="${ml}" y1="${mt}" y2="${mt + ph}"/>`);
      parts.push(`<text class="ch-label" x="${ml + pw / 2}" y="${H - 28}" text-anchor="middle">${esc(Estatistica.VARIABLES[spec.variable].label)} (${esc(spec.unit)}) — classes de ${esc(spec.widthText)}: [inferior, superior)</text>`);
      parts.push(`<text class="ch-label" transform="translate(14 ${mt + ph / 2}) rotate(-90)" text-anchor="middle">Participantes</text>`);
      // média (linha contínua) e mediana (tracejada): distinguíveis sem depender de cor
      const mx = xOf(h.mean), dx = xOf(h.median);
      parts.push(`<line class="ch-mean" x1="${mx}" x2="${mx}" y1="${mt - 6}" y2="${mt + ph}"/><line class="ch-median" x1="${dx}" x2="${dx}" y1="${mt - 6}" y2="${mt + ph}"/>`);
      parts.push(`<line class="ch-mean" x1="${ml}" x2="${ml + 26}" y1="14" y2="14"/><text class="ch-legend" x="${ml + 32}" y="18">Média ${esc(Estatistica.formatNumber(h.mean, Estatistica.VARIABLES[spec.variable].decimals))}</text>`);
      parts.push(`<line class="ch-median" x1="${ml + 150}" x2="${ml + 176}" y1="14" y2="14"/><text class="ch-legend" x="${ml + 182}" y="18">Mediana ${esc(Estatistica.formatNumber(h.median, Estatistica.VARIABLES[spec.variable].decimals))}</text>`);
      parts.push(`<rect class="ch-bar is-modal" x="${ml + 330}" y="8" width="14" height="12"/><text class="ch-legend" x="${ml + 350}" y="18">Classe modal (barra escura)</text>`);
      const desc = `${h.total} participantes. ${classes.map((c) => `${c.label}: ${c.count}`).join("; ")}. Média ${Estatistica.formatNumber(h.mean, Estatistica.VARIABLES[spec.variable].decimals)} ${spec.unit}; mediana ${Estatistica.formatNumber(h.median, Estatistica.VARIABLES[spec.variable].decimals)} ${spec.unit}.`;
      return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="hist-${key}-t hist-${key}-d"><title id="hist-${key}-t">Histograma de ${esc(Estatistica.VARIABLES[spec.variable].label.toLowerCase())}</title><desc id="hist-${key}-d">${esc(desc)}</desc>${parts.join("")}</svg>`;
    }

    function histogramTable(key, h) {
      const rows = h.classes.map((c) => {
        const isModal = h.modal.kind !== "sem-destaque" && h.modal.classes.includes(c);
        return `<tr><th scope="row">${esc(c.label)}</th><td>${c.count}</td><td>${isModal ? "sim" : ""}</td></tr>`;
      }).join("");
      return `<details class="chart-table" data-key="det-${key}"><summary id="det-${key}">Ver os números deste gráfico (frequências por classe)</summary>`
        + `<div class="table-wrap" tabindex="0" role="region" aria-label="Tabela de frequências: ${esc(Estatistica.VARIABLES[h.spec.variable].label)}"><table><caption>${esc(Estatistica.VARIABLES[h.spec.variable].label)}: frequência por classe — total ${h.total}</caption><thead><tr><th scope="col">Classe (inferior ≤ x &lt; superior)</th><th scope="col">Participantes</th><th scope="col">Classe modal</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
    }

    function measureCard(key, m) {
      const v = m.variable;
      const withAge = (value, text) => (key === "age" ? `${text} ${v.unit} (${Estatistica.formatAgeMonths(value)})` : `${text} ${v.unit}`);
      return `<article class="measure-card"><h3>${esc(v.label)}</h3><dl>`
        + `<dt>Média</dt><dd>${esc(withAge(m.mean, m.meanText))}</dd>`
        + `<dt>Mediana</dt><dd>${esc(withAge(m.median, m.medianText))}</dd>`
        + `<dt>Moda exata</dt><dd>${esc(m.modeText)}</dd></dl></article>`;
    }

    function bandBars(model) {
      const max = Math.max(1, ...model.bandCounts.map((b) => b.count));
      const items = model.bandCounts.map((b) => {
        const pct = Math.round((b.count / max) * 100);
        const mark = b.id === model.bandId ? " (recorte atual)" : "";
        return `<li><span class="band-label">${esc(b.label)}${mark}</span><span class="band-track" aria-hidden="true"><span class="band-fill" style="width:${pct}%"></span></span><span class="band-count">${b.count}</span></li>`;
      }).join("");
      return `<section class="panel-block" aria-labelledby="bandas-t"><h3 id="bandas-t">Participantes por faixa etária</h3><ul class="band-bars">${items}</ul>`
        + `<p class="panel-note">Faixas pedagógicas em anos completos (5–8: 60 a 107 meses; 9–11: 108 a 143; 12–14: 144 a 179; 15–19: 180 a 239; 20 ou mais: a partir de 240). Não são o corte técnico da curva da OMS.</p></section>`;
    }

    // ---------- render ----------

    function render(model) {
      $("painelContagem").textContent = model.countText + (model.totalIsPartial ? " — total PARCIAL (visão possivelmente incompleta)" : "");
      const notices = model.integrity.messages.slice();
      if (model.message) notices.push(model.message);
      const box = $("painelAvisos");
      box.innerHTML = notices.length ? `<ul>${notices.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
      box.hidden = notices.length === 0;

      // opções do seletor: só o texto muda (o foco do operador não é perdido)
      [...select.options].forEach((o) => {
        const count = o.value === "todos" ? model.total : (model.bandCounts.find((b) => b.id === o.value) || { count: 0 }).count;
        const base = optionsList.find((x) => x.id === o.value).label;
        const text = `${base} (${count})`;
        if (o.textContent !== text) o.textContent = text;
      });

      const content = $("painelConteudo");
      const openDetails = new Set([...content.querySelectorAll("details[open]")].map((d) => d.dataset.key));
      const activeId = content.contains(document.activeElement) ? document.activeElement.id : null;

      if (!model.measures) {
        content.innerHTML = "";
        return;
      }
      const hist = ["weight", "height", "bmi"].map((key) => {
        const h = model.histograms[key];
        return `<section class="panel-block" aria-labelledby="hs-${key}"><h3 id="hs-${key}">${esc(Estatistica.VARIABLES[key].label)}: distribuição</h3>`
          + `<figure class="chart-figure">${histogramSvg(key, h)}</figure>`
          + `<p class="panel-note"><strong>Classe modal ≠ moda exata.</strong> ${esc(h.modalText)}</p>${histogramTable(key, h)}</section>`;
      }).join("");
      content.innerHTML = `<section class="panel-block" aria-labelledby="medidas-t"><h3 id="medidas-t">Medidas centrais do recorte (${esc(model.bandLabel)})</h3>`
        + `<div class="measure-grid">${["age", "weight", "height", "bmi"].map((k) => measureCard(k, model.measures[k])).join("")}</div>`
        + `<p class="panel-note">A média do IMC é a média dos IMCs de cada participante (não o IMC calculado com o peso médio e a altura média). Ela <strong>não classifica</strong> clinicamente o grupo: o IMC de crianças e adolescentes depende da idade e do sexo.</p></section>`
        + bandBars(model) + hist;

      openDetails.forEach((key) => { const d = content.querySelector(`details[data-key="${key}"]`); if (d) d.open = true; });
      if (activeId) { const el = $(activeId); if (el) el.focus({ preventScroll: true }); }
    }

    function exampleHtml() {
      const ex = Estatistica.didacticExample();
      const f = (v) => Estatistica.formatNumber(v, 1);
      return `<p class="example-badge">Exemplo fictício — não faz parte da pesquisa</p>`
        + `<p>Sete pesos inventados, em kg. Veja o que acontece com a média e a mediana quando o último valor é substituído por um valor extremo.</p>`
        + `<div class="table-wrap" tabindex="0" role="region" aria-label="Tabela do exemplo fictício"><table><caption>Exemplo fictício: efeito de um valor extremo</caption><thead><tr><th scope="col">Situação</th><th scope="col">Valores (kg)</th><th scope="col">Média</th><th scope="col">Mediana</th></tr></thead><tbody>`
        + `<tr><th scope="row">Sem valor extremo</th><td>${ex.without.values.join("; ")}</td><td>${f(ex.without.mean)}</td><td>${f(ex.without.median)}</td></tr>`
        + `<tr><th scope="row">Com valor extremo (90 no lugar de 45)</th><td>${ex.withExtreme.values.join("; ")}</td><td>${f(ex.withExtreme.mean)}</td><td>${f(ex.withExtreme.median)}</td></tr></tbody></table></div>`
        + `<p>A média subiu de ${f(ex.without.mean)} para ${f(ex.withExtreme.mean)} kg porque considera todos os valores. A mediana continuou ${f(ex.withExtreme.median)} kg porque depende da posição central.</p>`;
    }
    const exampleBox = $("painelExemplo");
    if (exampleBox) exampleBox.innerHTML = exampleHtml();

    function isActive() {
      return !section.hidden;
    }

    function renderSync() {
      if (!syncBox) return;
      const text = isActive() && projection ? "Envio à planilha: " + projection.view().text : "";
      if (text !== lastSyncText) { lastSyncText = text; syncBox.textContent = text; }
    }

    function syncRoute(on) {
      if (!projection) return;
      if (on) {
        if (!projectionStarted) { projectionStarted = true; projection.start(); projection.onChange(renderSync); }
        renderSync();
        if (syncTimer === null) syncTimer = root.setInterval(renderSync, 5000); // o aviso expira sozinho se a janela de coleta calar
      } else if (syncTimer !== null) { root.clearInterval(syncTimer); syncTimer = null; }
    }

    function update(force) {
      if (!isActive()) return;
      const model = Estatistica.buildPanel(Estatistica.snapshotOf(store), band);
      const signature = JSON.stringify(model, (k, v) => (typeof v === "function" ? undefined : v));
      if (!force && signature === lastSignature) return;
      lastSignature = signature;
      render(model);
    }

    // ---------- rota #painel ----------

    function applyRoute(userNavigation) {
      const on = root.location.hash === "#painel";
      document.body.classList.toggle("modo-painel", on);
      section.hidden = !on;
      syncRoute(on);
      if (on) {
        lastSignature = null;
        update(true);
        if (userNavigation) { $("painelTitulo").focus({ preventScroll: true }); root.scrollTo(0, 0); }
      }
    }
    root.addEventListener("hashchange", () => applyRoute(true));
    applyRoute(false);

    return { update, isActive, applyRoute };
  }

  root.PesquisaPainel = { create };
})(typeof globalThis !== "undefined" ? globalThis : this);
