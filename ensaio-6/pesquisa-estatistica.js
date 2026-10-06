/*
 * Pesquisa educativa — estatística descritiva e modelo do painel.
 *
 * Módulo PURO (sem DOM, sem armazenamento, sem rede): recebe registros já validados e devolve
 * números e textos. A apresentação (SVG/HTML) fica em pesquisa-painel.js.
 *
 * Regras:
 *  - todos os cálculos usam os valores preservados; arredondamento só ao formatar para a tela;
 *  - a média de IMC é a média dos IMCs individuais (não o IMC de peso médio e altura média);
 *  - a moda exata compara os valores armazenados, sem agrupar (nada de cm inteiros ou décimos);
 *  - classe modal de um histograma é outra coisa e nunca substitui a moda exata;
 *  - nenhuma cor ou categoria clínica: os resultados descrevem uma amostra voluntária por conveniência.
 */
(function (root) {
  "use strict";

  const MIN_FOR_STATS = 3;   // abaixo disso, só a contagem (proteção inicial, NÃO é garantia de anonimato)
  const MIN_NO_WARNING = 5;  // abaixo disso, aviso "poucos participantes"

  // Faixas PEDAGÓGICAS em anos completos. Não são o corte técnico da curva OMS (229 meses).
  const AGE_BANDS = [
    { id: "5-8", label: "5 a 8 anos", min: 60, max: 107 },
    { id: "9-11", label: "9 a 11 anos", min: 108, max: 143 },
    { id: "12-14", label: "12 a 14 anos", min: 144, max: 179 },
    { id: "15-19", label: "15 a 19 anos", min: 180, max: 239 },
    { id: "20+", label: "20 anos ou mais", min: 240, max: Infinity }
  ];

  const VARIABLES = {
    age: { key: "age", label: "Idade", unit: "meses", decimals: 1, get: (r) => r.data.ageMonths },
    weight: { key: "weight", label: "Peso", unit: "kg", decimals: 1, get: (r) => r.data.weightKg },
    height: { key: "height", label: "Altura", unit: "m", decimals: 2, get: (r) => r.data.heightM },
    bmi: { key: "bmi", label: "IMC", unit: "kg/m²", decimals: 1, get: (r) => r.derived.bmi }
  };

  // Classes: [inferior, superior) — fechada à esquerda e aberta à direita, sem sobreposição.
  const HIST_SPECS = {
    weight: { variable: "weight", width: 5, decimals: 0, unit: "kg", widthText: "5 kg" },
    height: { variable: "height", width: 0.05, decimals: 2, unit: "m", widthText: "0,05 m (5 cm)" },
    bmi: { variable: "bmi", width: 1, decimals: 0, unit: "kg/m²", widthText: "1 kg/m²" }
  };

  // ---------- formatação (somente apresentação) ----------

  function formatNumber(value, decimals) {
    return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  }

  /** Texto do valor exato, com vírgula e sem arredondar (para a moda). */
  function formatExact(value) {
    return String(value).replace(".", ",");
  }

  /**
   * Formata valores distintos com o mínimo de casas em que continuam distintos na tela,
   * para que dois valores diferentes nunca pareçam o mesmo.
   */
  function formatDistinct(values, startDecimals) {
    let decimals = startDecimals;
    for (; decimals <= 12; decimals += 1) {
      const texts = values.map((v) => formatNumber(v, decimals));
      if (new Set(texts).size === values.length) return texts;
    }
    return values.map(formatExact);
  }

  function formatAgeMonths(months) {
    const whole = Math.floor(months);
    const years = Math.floor(whole / 12);
    const rest = whole % 12;
    return `${years} ${years === 1 ? "ano" : "anos"} e ${rest} ${rest === 1 ? "mês" : "meses"}`;
  }

  // ---------- registros ----------

  /** Remove repetições do mesmo recordId (nunca conta duas vezes). */
  function uniqueRecords(records) {
    const seen = new Set();
    const out = [];
    let duplicates = 0;
    records.forEach((record) => {
      const id = record.data.recordId;
      if (seen.has(id)) { duplicates += 1; return; }
      seen.add(id);
      out.push(record);
    });
    return { records: out, duplicates };
  }

  function bandOf(ageMonths) {
    return AGE_BANDS.find((band) => ageMonths >= band.min && ageMonths <= band.max) || null;
  }

  function filterByBand(records, bandId) {
    if (!bandId || bandId === "todos") return records;
    const band = AGE_BANDS.find((b) => b.id === bandId);
    if (!band) return [];
    return records.filter((r) => r.data.ageMonths >= band.min && r.data.ageMonths <= band.max);
  }

  // ---------- medidas ----------

  /** Soma compensada (Neumaier): reduz erro de ponto flutuante sem arredondar valores. */
  function sum(values) {
    let total = 0;
    let compensation = 0;
    values.forEach((v) => {
      const t = total + v;
      compensation += Math.abs(total) >= Math.abs(v) ? (total - t) + v : (v - t) + total;
      total = t;
    });
    return total + compensation;
  }

  function median(sorted) {
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Moda exata e convenção pedagógica. `kind`:
   *  - "sem-dados"            n = 0
   *  - "registro-unico"       n = 1 (nada se repete: não se declara moda)
   *  - "todos-iguais"         n ≥ 2 e um único valor distinto: ele é a moda
   *  - "sem-moda"             n ≥ 2 e todos os valores distintos (cada um aparece uma vez)
   *  - "sem-moda-destacada"   ≥ 2 valores distintos, todos com a mesma frequência ≥ 2: nenhum se destaca
   *  - "unica"                um valor tem frequência máxima, maior que as demais
   *  - "multimodal"           vários valores empatam na frequência máxima e há valores menos frequentes
   */
  function modeOf(values) {
    const n = values.length;
    if (n === 0) return { kind: "sem-dados", values: [], frequency: 0, distinct: 0 };
    if (n === 1) return { kind: "registro-unico", values: [], frequency: 1, distinct: 1 };
    const counts = new Map();
    values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
    const distinct = counts.size;
    const maxFreq = Math.max(...counts.values());
    const top = [...counts.entries()].filter(([, f]) => f === maxFreq).map(([v]) => v).sort((a, b) => a - b);
    if (distinct === 1) return { kind: "todos-iguais", values: top, frequency: maxFreq, distinct };
    if (top.length === distinct) {
      return maxFreq === 1
        ? { kind: "sem-moda", values: [], frequency: 1, distinct }
        : { kind: "sem-moda-destacada", values: [], frequency: maxFreq, distinct };
    }
    if (top.length === 1) return { kind: "unica", values: top, frequency: maxFreq, distinct };
    return { kind: "multimodal", values: top, frequency: maxFreq, distinct };
  }

  /** { n, mean, median, mode } sem arredondar. Com n = 0, mean e median são null. */
  function describe(values) {
    const n = values.length;
    if (n === 0) return { n, mean: null, median: null, mode: modeOf(values) };
    const sorted = values.slice().sort((a, b) => a - b);
    return { n, mean: sum(values) / n, median: median(sorted), mode: modeOf(values) };
  }

  /** Texto da moda exata para a tela. Valores diferentes nunca parecem um só. */
  function modeText(mode, variable) {
    const unit = variable.unit;
    switch (mode.kind) {
      case "sem-dados": return "—";
      case "registro-unico": return "Com um único registro nada se repete: não há moda.";
      case "sem-moda": return "Sem moda: nenhum valor se repete.";
      case "sem-moda-destacada": return `Sem moda destacada: ${mode.distinct} valores diferentes aparecem o mesmo número de vezes (${mode.frequency}), então nenhum se destaca.`;
      case "todos-iguais": return `${formatExact(mode.values[0])} ${unit} (todos os ${mode.frequency} valores são iguais)`;
      case "unica": return `${formatExact(mode.values[0])} ${unit} (${mode.frequency} registros)`;
      case "multimodal": {
        const shown = mode.values.slice(0, 4).map(formatExact);
        const more = mode.values.length > 4 ? ` e mais ${mode.values.length - 4}` : "";
        return `Multimodal: ${shown.join(", ")}${more} ${unit} (${mode.frequency} registros cada)`;
      }
      default: return "—";
    }
  }

  // ---------- histogramas ----------

  function edgeOf(k, width) {
    return Number((k * width).toFixed(10));
  }

  function classIndex(value, width) {
    let k = Math.floor(value / width);
    while (value < edgeOf(k, width)) k -= 1;
    while (value >= edgeOf(k + 1, width)) k += 1;
    return k;
  }

  /**
   * Histograma com classes contíguas [lo, hi). Valor igual ao limite superior pertence à classe seguinte.
   * `modal` descreve a(s) classe(s) de maior frequência — NÃO é a moda exata.
   */
  function histogram(values, spec) {
    if (values.length === 0) return { spec, classes: [], total: 0, modal: { kind: "sem-dados", classes: [], frequency: 0 } };
    const indexes = values.map((v) => classIndex(v, spec.width));
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    const classes = [];
    for (let k = first; k <= last; k += 1) {
      const lo = edgeOf(k, spec.width);
      const hi = edgeOf(k + 1, spec.width);
      classes.push({ lo, hi, count: 0, label: `${formatNumber(lo, spec.decimals)} a menos de ${formatNumber(hi, spec.decimals)} ${spec.unit}` });
    }
    indexes.forEach((k) => { classes[k - first].count += 1; });
    const nonEmpty = classes.filter((c) => c.count > 0);
    const maxCount = Math.max(...classes.map((c) => c.count));
    const top = classes.filter((c) => c.count === maxCount);
    let kind;
    if (nonEmpty.length === 1) kind = "unica-classe";
    else if (top.length === nonEmpty.length) kind = "sem-destaque";
    else if (top.length === 1) kind = "unica";
    else kind = "multipla";
    return { spec, classes, total: values.length, modal: { kind, classes: top, frequency: maxCount } };
  }

  function modalText(modal, spec) {
    const base = `Depende dos intervalos escolhidos (classes de ${spec.widthText}); não é a moda exata.`;
    switch (modal.kind) {
      case "sem-dados": return "—";
      case "unica-classe": return `Todos os registros caem em uma única classe: ${modal.classes[0].label} (${modal.frequency}). ${base}`;
      case "sem-destaque": return `Nenhuma classe se destaca: todas as classes com registros têm ${modal.frequency}. ${base}`;
      case "unica": return `Classe modal: ${modal.classes[0].label} (${modal.frequency} registros). ${base}`;
      default: return `Classes modais empatadas: ${modal.classes.map((c) => c.label).join("; ")} (${modal.frequency} registros cada). ${base}`;
    }
  }

  // ---------- integridade da base ----------

  /** Descreve o estado da base para o painel (pendentes, incerteza, ilegível, conflitos). */
  function describeIntegrity(info) {
    const messages = [];
    const incomplete = info.status === "corrupt" || info.status === "unsupported" || info.status === "unavailable";
    if (info.status === "corrupt" || info.status === "unsupported") {
      messages.push("A base salva neste navegador está ilegível. Esta visão pode estar INCOMPLETA: os números abaixo não representam toda a pesquisa.");
    } else if (info.status === "unavailable") {
      messages.push("O armazenamento do navegador está indisponível. Esta visão pode estar INCOMPLETA e só inclui registros em memória.");
    }
    if (info.unsaved > 0) {
      messages.push(info.lastOutcome === "incerto"
        ? `${info.unsaved} registro(s) estão nesta janela e NÃO se sabe se foram gravados no armazenamento (gravação não confirmada).`
        : `${info.unsaved} registro(s) estão apenas na memória desta janela e ainda não foram confirmados no armazenamento.`);
    }
    if (info.conflicts > 0) {
      messages.push(`${info.conflicts} registro(s) em conflito: a versão local ficou de fora das estatísticas (vale a versão do armazenamento).`);
    }
    if (info.duplicates > 0) messages.push(`${info.duplicates} repetição(ões) do mesmo registro foram ignoradas.`);
    return { incomplete, pending: info.unsaved || 0, conflicts: info.conflicts || 0, messages };
  }

  function snapshotOf(store) {
    return {
      records: store.getRecords(),
      status: store.getStatus(),
      unsaved: store.unsavedCount(),
      lastOutcome: store.getLastOutcome(),
      conflicts: store.getConflicts().length
    };
  }

  // ---------- modelo do painel ----------

  /**
   * Modelo do painel para um recorte. Com n < 3 o modelo contém SOMENTE contagens e mensagens:
   * nenhuma medida, extremo, histograma ou marcador (proteção inicial; não garante anonimato).
   */
  function buildPanel(snapshot, bandId) {
    const unique = uniqueRecords(snapshot.records);
    const all = unique.records;
    const band = AGE_BANDS.find((b) => b.id === bandId) || null;
    const selected = filterByBand(all, band ? band.id : "todos");
    const integrity = describeIntegrity({ ...snapshot, duplicates: unique.duplicates });
    const n = selected.length;
    const total = all.length;

    const model = {
      bandId: band ? band.id : "todos",
      bandLabel: band ? band.label : "Todos os participantes",
      n,
      total,
      countText: `n = ${n} de ${total} participantes`,
      totalIsPartial: integrity.incomplete,
      integrity,
      bandCounts: AGE_BANDS.map((b) => ({ id: b.id, label: b.label, count: filterByBand(all, b.id).length })),
      level: "ok",
      message: ""
    };

    if (n === 0) {
      model.level = total === 0 ? "amostra-vazia" : "filtro-vazio";
      model.message = total === 0
        ? "Ainda não há participantes registrados."
        : "Nenhum participante nesta faixa etária. Escolha outra faixa ou \"Todos\".";
      return model;
    }
    if (n < MIN_FOR_STATS) {
      model.level = "insuficiente";
      model.message = "Dados insuficientes: com menos de 3 participantes neste recorte as medidas e gráficos não são exibidos. Esse limite é só uma proteção inicial e não garante anonimato.";
      return model;
    }
    if (n < MIN_NO_WARNING) {
      model.level = "poucos";
      model.message = "Poucos participantes: com tão poucos dados, as medidas mudam muito a cada novo registro e não devem ser generalizadas.";
    }

    model.measures = {};
    Object.keys(VARIABLES).forEach((key) => {
      const variable = VARIABLES[key];
      const values = selected.map(variable.get);
      const stats = describe(values);
      model.measures[key] = {
        variable,
        n: stats.n,
        mean: stats.mean,
        median: stats.median,
        mode: stats.mode,
        meanText: formatNumber(stats.mean, variable.decimals),
        medianText: formatNumber(stats.median, variable.decimals),
        modeText: modeText(stats.mode, variable)
      };
    });
    model.histograms = {};
    Object.keys(HIST_SPECS).forEach((key) => {
      const spec = HIST_SPECS[key];
      const h = histogram(selected.map(VARIABLES[spec.variable].get), spec);
      h.modalText = modalText(h.modal, spec);
      h.mean = model.measures[spec.variable].mean;
      h.median = model.measures[spec.variable].median;
      model.histograms[key] = h;
    });
    return model;
  }

  /** Exemplo didático FICTÍCIO (pesos em kg): nunca vem da pesquisa nem é persistido. */
  function didacticExample() {
    const sem = [38, 40, 41, 42, 43, 44, 45];
    const com = [38, 40, 41, 42, 43, 44, 90];
    return { without: { values: sem, ...describe(sem) }, withExtreme: { values: com, ...describe(com) } };
  }

  const api = {
    MIN_FOR_STATS,
    MIN_NO_WARNING,
    AGE_BANDS,
    VARIABLES,
    HIST_SPECS,
    formatNumber,
    formatExact,
    formatDistinct,
    formatAgeMonths,
    uniqueRecords,
    bandOf,
    filterByBand,
    sum,
    describe,
    modeOf,
    modeText,
    histogram,
    modalText,
    describeIntegrity,
    snapshotOf,
    buildPanel,
    didacticExample
  };

  root.PesquisaEstatistica = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
