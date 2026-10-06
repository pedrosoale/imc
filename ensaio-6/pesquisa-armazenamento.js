/*
 * Pesquisa educativa — armazenamento local.
 *
 * ÚNICO módulo do projeto autorizado a usar localStorage (verificado em tests.js).
 * Recebe um adaptador { getItem, setItem, removeItem } para ser testado sem navegador.
 *
 * Modelo de consistência
 *  - "baseline" = o que sabemos estar gravado (última leitura ou gravação confirmada).
 *  - registros em memória que NÃO estão no baseline são "pendentes" (só em memória).
 *  - ao reler o armazenamento (reconcile/load):
 *      · registro do baseline que sumiu do armazenamento = excluído por outra janela: é
 *        removido da visão e NÃO é regravado (sem ressurreição);
 *      · registro pendente que não existe no armazenamento continua pendente (não se perde);
 *      · registro novo no armazenamento entra na visão;
 *      · mesmo ID com conteúdo diferente = conflito: vale a versão do armazenamento e a versão
 *        local é guardada em getConflicts() para recuperação (nunca descartada em silêncio).
 *
 * Resultado de uma tentativa de gravação (outcome):
 *  - "gravado":     o texto gravado foi relido e confere;
 *  - "nao-gravado": sabemos que a base não foi alterada;
 *  - "incerto":     houve tentativa e não é possível afirmar se gravou (ex.: leitura de
 *                   confirmação falhou). Os dados ficam em memória como pendentes; uma releitura
 *                   posterior (retrySave/reconcile) resolve sem duplicar.
 *
 * Outras garantias: base ilegível/corrompida/de versão desconhecida nunca é apagada nem
 * sobrescrita automaticamente; a importação é lote completo ou nada (ou "incerto", sempre dito).
 */
(function (root) {
  "use strict";

  const Dados = (typeof module === "object" && module.exports) ? require("./pesquisa-dados.js") : root.PesquisaDados;

  const STORE_FORMAT = "imc-pesquisa-local";
  const STORE_VERSION = 1;
  const KEY_PREFIX = "imcPesquisa:v1:";
  const CONFIG_KEY = `${KEY_PREFIX}config`;
  const STORE_KEYS = ["format", "storeVersion", "surveyId", "records"];
  const CONFLICT_FORMAT = "imc-pesquisa-conflitos";

  function messageOf(error) {
    return error && error.message ? error.message : String(error);
  }

  /** Adaptador para window.localStorage. O acesso pode lançar exceção (bloqueio, modo privado). */
  function createLocalStorageAdapter(win) {
    const target = win || root;
    return {
      getItem: (key) => target.localStorage.getItem(key),
      setItem: (key, value) => target.localStorage.setItem(key, value),
      removeItem: (key) => target.localStorage.removeItem(key)
    };
  }

  const isDefaultSurvey = (surveyId) => !surveyId || surveyId === Dados.DEFAULT_SURVEY_ID;
  /** Configuração (modo coleta) POR PESQUISA. A pesquisa principal mantém a chave original; outras ganham sufixo. */
  const configKeyFor = (surveyId) => (isDefaultSurvey(surveyId) ? CONFIG_KEY : `${CONFIG_KEY}:${surveyId}`);
  const syncConfigKeyFor = (surveyId) => (isDefaultSurvey(surveyId) ? `${KEY_PREFIX}sync-config` : `${KEY_PREFIX}sync-config:${surveyId}`);

  function storageKey(surveyId) {
    return `${KEY_PREFIX}${surveyId}`;
  }

  function serialize(surveyId, records) {
    return JSON.stringify({
      format: STORE_FORMAT,
      storeVersion: STORE_VERSION,
      surveyId,
      records: records.map((r) => ({ data: r.data, derived: r.derived, local: { status: "local" } }))
    });
  }

  /** Interpreta o texto salvo. Devolve { status: "ok" | "corrupt" | "unsupported", records, error }. */
  function parseStored(raw, surveyId) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return { status: "corrupt", records: [], error: "O texto salvo não é um JSON válido." }; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "corrupt", records: [], error: "Estrutura inesperada." };
    if (parsed.format !== STORE_FORMAT) return { status: "corrupt", records: [], error: "Formato não reconhecido." };
    if (parsed.storeVersion !== STORE_VERSION) {
      return { status: "unsupported", records: [], error: `Versão da base não suportada (${String(parsed.storeVersion)}).` };
    }
    const extra = Object.keys(parsed).filter((k) => !STORE_KEYS.includes(k));
    if (extra.length) return { status: "corrupt", records: [], error: `Campos desconhecidos: ${extra.join(", ")}.` };
    if (parsed.surveyId !== surveyId || !Array.isArray(parsed.records)) return { status: "corrupt", records: [], error: "Pesquisa ou lista de registros inconsistente." };

    const ids = new Set();
    const records = [];
    for (let i = 0; i < parsed.records.length; i += 1) {
      const problems = Dados.validateRecord(parsed.records[i], { allowLocal: true });
      if (problems.length || parsed.records[i].data.surveyId !== surveyId) {
        return { status: "corrupt", records: [], error: `Registro ${i + 1} inválido: ${problems[0] || "pesquisa diferente"}` };
      }
      if (ids.has(parsed.records[i].data.recordId)) return { status: "corrupt", records: [], error: `Registro ${i + 1}: recordId repetido.` };
      ids.add(parsed.records[i].data.recordId);
      records.push(Dados.cloneRecord(parsed.records[i]));
    }
    return { status: "ok", records };
  }

  /**
   * Cria o repositório de uma pesquisa.
   * status: "empty" | "ok" | "unavailable" | "corrupt" | "unsupported"
   */
  function createStore(options) {
    const storage = options.storage;
    const surveyId = options.surveyId || Dados.DEFAULT_SURVEY_ID;
    const now = options.now || (() => new Date());
    const key = storageKey(surveyId);

    let status = "empty";
    let lastError = null;
    let lastOutcome = null;
    let records = [];
    let baseline = new Map();   // recordId -> registro gravado conforme a última leitura/gravação confirmada
    let conflicts = [];         // { recordId, memory, stored }
    let lastReconcile = null;
    let rawPreserved = null;    // texto bruto de uma base que não pudemos interpretar
    let lastRaw = null;         // último texto que sabemos estar gravado (null = chave ausente)

    const isPending = (record) => !baseline.has(record.data.recordId);
    const pendingList = () => records.filter(isPending);

    function readRaw() {
      try {
        if (!storage) throw new Error("Armazenamento indisponível.");
        const raw = storage.getItem(key);
        return { ok: true, raw: raw === undefined ? null : raw };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    }

    function blocked() {
      return status === "corrupt" || status === "unsupported" || status === "unavailable";
    }

    function setBaseline(list) {
      baseline = new Map(list.map((r) => [r.data.recordId, Dados.cloneRecord(r)]));
    }

    /**
     * Relê o armazenamento e reconcilia a memória com ele (ver cabeçalho).
     * Devolve o status; os detalhes ficam em getLastReconcile().
     */
    function load() {
      const read = readRaw();
      if (!read.ok) { status = "unavailable"; lastError = read.error; return status; }

      const summary = { added: 0, removedSaved: 0, keptPending: 0, conflicts: 0, replaced: 0, changed: false };
      if (read.raw === null) {
        // Chave ausente: o que estava no baseline foi excluído em outro lugar; pendentes permanecem.
        const kept = records.filter(isPending);
        summary.removedSaved = records.length - kept.length;
        summary.keptPending = kept.length;
        summary.changed = summary.removedSaved > 0;
        records = kept;
        baseline = new Map();
        lastRaw = null;
        lastError = null;
        rawPreserved = null;
        status = records.length ? "ok" : "empty";
        lastReconcile = summary;
        return status;
      }

      const parsed = parseStored(read.raw, surveyId);
      if (parsed.status !== "ok") {
        status = parsed.status;
        lastError = parsed.error;
        rawPreserved = read.raw;
        lastRaw = read.raw;
        baseline = new Map(); // não podemos confiar no que supomos gravado: tudo vira pendente
        lastReconcile = summary;
        return status;
      }

      const stored = new Map(parsed.records.map((r) => [r.data.recordId, r]));
      const memory = new Map(records.map((r) => [r.data.recordId, r]));
      const pending = [];
      records.forEach((record) => {
        const id = record.data.recordId;
        if (stored.has(id)) {
          if (!Dados.recordsEqual(record, stored.get(id))) {
            // Cópia local que nunca foi alterada e diverge do armazenamento = mudança externa (vale o armazenamento).
            // Cópia local pendente ou alterada = conflito real: o conteúdo local é guardado para recuperação.
            const untouched = baseline.has(id) && Dados.recordsEqual(record, baseline.get(id));
            if (!untouched && !conflicts.some((c) => c.recordId === id && Dados.recordsEqual(c.memory, record))) {
              conflicts.push({ recordId: id, memory: Dados.cloneRecord(record), stored: Dados.cloneRecord(stored.get(id)) });
              summary.conflicts += 1;
            } else if (untouched) {
              summary.replaced += 1;
            }
          }
        } else if (isPending(record)) {
          pending.push(record);
        } else {
          summary.removedSaved += 1; // estava salvo e foi excluído por outra janela
        }
      });
      parsed.records.forEach((record) => { if (!memory.has(record.data.recordId)) summary.added += 1; });
      summary.keptPending = pending.length;
      summary.changed = summary.added > 0 || summary.removedSaved > 0 || summary.conflicts > 0 || summary.replaced > 0;

      records = parsed.records.concat(pending.map(Dados.cloneRecord));
      setBaseline(parsed.records);
      lastRaw = read.raw;
      lastError = null;
      rawPreserved = null;
      status = records.length ? "ok" : "empty";
      lastReconcile = summary;
      return status;
    }

    /**
     * Uma tentativa de gravação de `list`. Não altera a memória.
     * Devolve { outcome: "gravado" | "nao-gravado" | "incerto" | "obsoleto", error }.
     * "obsoleto" = outra janela alterou a base desde a última leitura; nada foi tentado.
     */
    function attemptWrite(list) {
      if (blocked()) return { outcome: "nao-gravado", error: lastError || "Armazenamento bloqueado." };
      const current = readRaw();
      if (!current.ok) return { outcome: "nao-gravado", error: current.error };
      if (current.raw !== lastRaw) return { outcome: "obsoleto", error: "A base foi alterada por outra janela." };

      const text = serialize(surveyId, list);
      try {
        storage.setItem(key, text);
      } catch (error) {
        const check = readRaw();
        if (!check.ok) return { outcome: "incerto", error: `${messageOf(error)}; não foi possível conferir o resultado.` };
        if (check.raw === text) { lastRaw = text; return { outcome: "gravado" }; }
        return { outcome: "nao-gravado", error: messageOf(error) };
      }
      const back = readRaw();
      if (!back.ok) return { outcome: "incerto", error: `A gravação foi tentada, mas a leitura de confirmação falhou (${back.error}).` };
      if (back.raw === text) { lastRaw = text; return { outcome: "gravado" }; }
      if (back.raw === lastRaw) return { outcome: "nao-gravado", error: "A leitura de confirmação não confere com o que foi gravado." };
      return { outcome: "incerto", error: "A base mudou durante a gravação; o resultado não pode ser afirmado." };
    }

    function finish(result) {
      lastOutcome = result.outcome;
      if (result.outcome === "gravado") { lastError = null; status = records.length ? "ok" : "empty"; }
      else lastError = result.error || null;
      return result;
    }

    /** Grava a memória atual (pendentes incluídos), reconciliando antes se a base mudou. */
    function persistCurrent() {
      let result = attemptWrite(records);
      if (result.outcome === "obsoleto") {
        load();
        if (blocked()) return finish({ outcome: "nao-gravado", error: lastError });
        result = attemptWrite(records);
        if (result.outcome === "obsoleto") result = { outcome: "nao-gravado", error: "A base foi alterada novamente por outra janela; tente de novo." };
      }
      if (result.outcome === "gravado") setBaseline(records);
      return finish(result);
    }

    load();

    return {
      surveyId,
      key,
      load,
      reconcile() { load(); return lastReconcile; },
      getStatus: () => status,
      getLastError: () => lastError,
      getLastOutcome: () => lastOutcome,
      getLastReconcile: () => lastReconcile,
      getRecords: () => records.map(Dados.cloneRecord),
      has: (recordId) => records.some((r) => r.data.recordId === recordId),
      count: () => records.length,
      unsavedCount: () => pendingList().length,
      isSaved: (recordId) => records.some((r) => r.data.recordId === recordId) && baseline.has(recordId),
      hasPreservedRaw: () => rawPreserved !== null,
      getPreservedRaw: () => rawPreserved,
      getConflicts: () => conflicts.map((c) => ({ recordId: c.recordId, memory: Dados.cloneRecord(c.memory), stored: Dados.cloneRecord(c.stored) })),
      conflictReport: () => buildConflictReport(conflicts, surveyId, now),

      /** Adiciona um registro. O registro fica em memória mesmo que a gravação falhe ou seja incerta. */
      addRecord(record) {
        const problems = Dados.validateRecord(record);
        if (problems.length) return { ok: false, saved: false, error: problems[0] };
        if (record.data.surveyId !== surveyId) return { ok: false, saved: false, error: "Registro de outra pesquisa." };
        const existing = records.find((r) => r.data.recordId === record.data.recordId);
        if (existing) {
          if (!Dados.recordsEqual(existing, record)) return { ok: false, saved: false, error: "Conflito: mesmo recordId com conteúdo diferente." };
          return { ok: true, duplicate: true, saved: baseline.has(record.data.recordId) };
        }
        records.push(Dados.cloneRecord(record));
        const result = persistCurrent();
        return result.outcome === "gravado"
          ? { ok: true, duplicate: false, saved: true, outcome: "gravado" }
          : { ok: true, duplicate: false, saved: false, outcome: result.outcome, error: result.error };
      },

      /**
       * Releitura + nova tentativa de gravar o que está só em memória. Seguro contra duplicação:
       * relê antes, então registros que na verdade chegaram à base passam a "salvos".
       */
      retrySave() {
        load();
        if (blocked()) return { ok: false, outcome: "nao-gravado", error: lastError, pending: pendingList().length };
        if (pendingList().length === 0) {
          lastOutcome = "gravado";
          return { ok: true, outcome: "gravado", pending: 0, reconcile: lastReconcile };
        }
        const result = persistCurrent();
        return { ok: result.outcome === "gravado", outcome: result.outcome, error: result.error, pending: pendingList().length, reconcile: lastReconcile };
      },

      /** Importação, etapa 1: prévia, sem alterar nada. */
      previewImport(text, parseOptions) {
        const parsed = Dados.parseBackup(text, { surveyId, ...(parseOptions || {}) });
        if (!parsed.ok) return { ok: false, errors: parsed.errors, counts: null, toAdd: [] };
        const byId = new Map(records.map((r) => [r.data.recordId, r]));
        const toAdd = [];
        const conflicting = [];
        let identical = parsed.duplicatesInFile || 0;
        parsed.records.forEach((record) => {
          const existing = byId.get(record.data.recordId);
          if (!existing) toAdd.push(record);
          else if (Dados.recordsEqual(existing, record)) identical += 1;
          else conflicting.push(record.data.recordId);
        });
        const counts = { total: parsed.records.length, new: toAdd.length, identical, conflicts: conflicting.length };
        if (conflicting.length) {
          return { ok: false, errors: [`${conflicting.length} registro(s) com o mesmo recordId e conteúdo diferente. Nada será importado.`], counts, toAdd: [] };
        }
        return { ok: true, errors: [], counts, toAdd, claimedConfirmed: parsed.claimedConfirmed || 0 };
      },

      /**
       * Importação, etapa 2: lote completo ou nada.
       * Relê a base antes (para não duplicar nem sobrescrever outra janela) e refaz a comparação.
       * Retorna { ok, outcome, added, error }. outcome "incerto": os registros foram mantidos em
       * memória como pendentes e podem ser conciliados com retrySave().
       */
      applyImport(preview) {
        if (!preview || !preview.ok) return { ok: false, outcome: "nao-gravado", error: "Prévia inválida." };
        load();
        if (blocked()) return { ok: false, outcome: "nao-gravado", error: lastError || "Armazenamento bloqueado; nada foi importado." };
        const byId = new Map(records.map((r) => [r.data.recordId, r]));
        const fresh = [];
        for (const record of preview.toAdd) {
          const existing = byId.get(record.data.recordId);
          if (!existing) fresh.push(Dados.cloneRecord(record));
          else if (!Dados.recordsEqual(existing, record)) return { ok: false, outcome: "nao-gravado", error: "A base mudou desde a prévia e há conflito; refaça a importação." };
        }
        if (fresh.length === 0) return { ok: true, outcome: "gravado", added: 0 };
        const merged = records.concat(fresh);
        const result = attemptWrite(merged);
        if (result.outcome === "gravado") {
          records = merged;
          setBaseline(records);
          return { ok: true, ...finish(result), added: fresh.length };
        }
        finish(result);
        if (result.outcome === "incerto") {
          records = merged; // preservados como pendentes; a releitura decide
          return { ok: false, outcome: "incerto", added: fresh.length, error: result.error };
        }
        return { ok: false, outcome: "nao-gravado", added: 0, error: result.error };
      },

      /** Exclui somente esta pesquisa, após o texto digitado coincidir com o surveyId. */
      deleteSurvey(confirmation) {
        if (confirmation !== surveyId) return { ok: false, outcome: "nao-excluido", error: "Confirmação incorreta; nada foi excluído." };
        if (status === "unavailable") return { ok: false, outcome: "nao-excluido", error: "Armazenamento indisponível; nada foi excluído." };
        const count = records.length;
        const pending = pendingList().length;
        let removeError = null;
        try { storage.removeItem(key); } catch (error) { removeError = messageOf(error); }
        const check = readRaw();
        if (!check.ok) return { ok: false, outcome: "incerto", error: `Não foi possível confirmar a exclusão (${check.error}). Os dados foram mantidos em memória.` };
        if (check.raw !== null) return { ok: false, outcome: "nao-excluido", error: removeError || "A base continua presente após a tentativa de exclusão." };
        records = [];
        baseline = new Map();
        conflicts = [];
        rawPreserved = null;
        lastRaw = null;
        lastError = null;
        status = "empty";
        return { ok: true, outcome: "excluido", deleted: count, droppedUnsaved: pending };
      },

      /**
       * Ação explícita do operador diante de base ilegível: copia o texto bruto para uma chave de
       * quarentena (conferindo a cópia), remove a base ilegível e inicia uma base nova.
       * Retorna { ok, persisted, outcome, pending }: `persisted` só é true se a base nova foi gravada.
       */
      quarantineAndReset() {
        if (status !== "corrupt" && status !== "unsupported") return { ok: false, error: "A base não está em estado de quarentena." };
        const quarantineKey = `${key}:ilegivel:${now().getTime()}`;
        try {
          storage.setItem(quarantineKey, rawPreserved);
          if (storage.getItem(quarantineKey) !== rawPreserved) return { ok: false, error: "Não foi possível confirmar a cópia de segurança; a base original foi mantida." };
        } catch (error) {
          return { ok: false, error: `${messageOf(error)} A base original foi mantida.` };
        }
        try { storage.removeItem(key); } catch (error) { return { ok: false, quarantineKey, error: `Cópia de segurança feita, mas a base ilegível não pôde ser removida (${messageOf(error)}).` }; }
        const check = readRaw();
        if (!check.ok || check.raw !== null) return { ok: false, quarantineKey, error: "Cópia de segurança feita, mas não foi possível confirmar a remoção da base ilegível." };
        baseline = new Map();
        rawPreserved = null;
        lastRaw = null;
        status = records.length ? "ok" : "empty";
        lastError = null;
        if (records.length === 0) return { ok: true, quarantineKey, persisted: true, outcome: "gravado", pending: 0 };
        const result = persistCurrent();
        return { ok: true, quarantineKey, persisted: result.outcome === "gravado", outcome: result.outcome, error: result.error, pending: pendingList().length };
      }
    };
  }

  function buildConflictReport(list, surveyId, nowFn) {
    return JSON.stringify({
      format: CONFLICT_FORMAT,
      formatVersion: 1,
      surveyId,
      exportedAt: Dados.toIsoWithOffset((nowFn || (() => new Date()))()),
      conflicts: list.map((c) => ({ recordId: c.recordId, memory: c.memory, stored: c.stored }))
    }, null, 2);
  }

  /** Mensagens para o operador, honestas quanto ao resultado. Funções puras (testadas). */
  const messages = {
    save(result) {
      if (result.outcome === "gravado") return result.pending ? `Parte dos registros foi salva; ${result.pending} continuam só na memória.` : "Salvo neste computador: não há mais registros apenas na memória.";
      if (result.outcome === "incerto") return `Não foi possível confirmar a gravação (${result.error}). Os registros continuam em memória; tente salvar novamente ou baixe o backup.`;
      return `Continua NÃO salvo: ${result.error || "falha desconhecida"}. ${result.pending || 0} registro(s) seguem apenas na memória; baixe o backup.`;
    },
    importResult(result) {
      if (result.ok) return result.added ? `${result.added} registro(s) importado(s) e confirmados no armazenamento.` : "Nada novo a importar.";
      if (result.outcome === "incerto") return `Resultado da importação INCERTO: ${result.error} Os ${result.added} registro(s) do arquivo foram mantidos em memória; use "Tentar salvar novamente" para conferir a base, sem duplicar.`;
      return `Importação não aplicada (a base não foi alterada): ${result.error}`;
    },
    deleteResult(result) {
      if (result.ok) return `Pesquisa excluída deste computador (${result.deleted} registro(s)${result.droppedUnsaved ? `, dos quais ${result.droppedUnsaved} só estavam na memória` : ""}).`;
      if (result.outcome === "incerto") return `Exclusão NÃO confirmada: ${result.error}`;
      return `A pesquisa não foi excluída: ${result.error}`;
    },
    quarantine(result) {
      if (!result.ok) return `Quarentena não concluída: ${result.error}`;
      if (result.persisted) return "A base ilegível foi copiada para uma área de segurança do navegador e uma base nova foi iniciada e gravada.";
      return `A base ilegível foi preservada em quarentena, mas a base nova AINDA NÃO foi gravada (${result.outcome === "incerto" ? "resultado incerto" : "falhou"}: ${result.error || "erro desconhecido"}). ${result.pending} registro(s) seguem só na memória; use "Tentar salvar novamente" ou baixe o backup.`;
    },
    reconcile(summary) {
      if (!summary || !summary.changed) return "";
      const parts = [];
      if (summary.removedSaved) parts.push(`${summary.removedSaved} registro(s) salvos aqui deixaram de existir (excluídos em outra janela; não foram restaurados)`);
      if (summary.added) parts.push(`${summary.added} registro(s) novo(s) vieram de outra janela`);
      if (summary.replaced) parts.push(`${summary.replaced} registro(s) tiveram o conteúdo alterado em outra janela (vale o armazenamento)`);
      if (summary.keptPending) parts.push(`${summary.keptPending} registro(s) pendentes continuam só na memória desta janela`);
      if (summary.conflicts) parts.push(`${summary.conflicts} conflito(s) de mesmo ID com conteúdo diferente (a versão do armazenamento prevaleceu; a versão desta janela pode ser baixada)`);
      return `A pesquisa foi alterada em outra janela: ${parts.join("; ")}.`;
    }
  };

  /** Configuração do operador (modo coleta ligado/desligado). Falhas nunca interrompem a calculadora. */
  function createConfig(storage, surveyId) {
    const CONFIG_KEY = configKeyFor(surveyId);
    return {
      read() {
        try {
          const raw = storage.getItem(CONFIG_KEY);
          const parsed = raw ? JSON.parse(raw) : {};
          return { collectMode: parsed.collectMode === true };
        } catch (_) {
          return { collectMode: false };
        }
      },
      write(config) {
        try {
          storage.setItem(CONFIG_KEY, JSON.stringify({ collectMode: config.collectMode === true }));
          return true;
        } catch (_) {
          return false;
        }
      }
    };
  }

  // ======================= fila de sincronização (Rodada 5) =======================
  /*
   * A fila guarda SOMENTE identificadores e estados de envio — nunca valores de registros, chaves ou a URL.
   * Fica em chaves próprias, separadas da base de dados: estados de envio não alteram os dados coletados e a
   * base de dados (formato "imc-pesquisa-local", versão 1) permanece exatamente como era antes da Rodada 5.
   */
  const QUEUE_FORMAT = "imc-pesquisa-fila";
  const QUEUE_VERSION = 1;
  const QUEUE_STATES = ["local", "pendente", "enviando", "confirmado", "falha", "intervencao"];
  const QUEUE_KEYS = ["format", "queueVersion", "surveyId", "destination", "paused", "blocked", "items"];
  const ITEM_KEYS = ["state", "attempts", "lastAttemptAt", "nextAttemptAt", "confirmedAt", "error"];

  function emptyQueue(surveyId) {
    return { format: QUEUE_FORMAT, queueVersion: QUEUE_VERSION, surveyId, destination: null, paused: false, blocked: null, items: {} };
  }

  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isNullableNumber = (v) => v === null || (typeof v === "number" && Number.isFinite(v));

  /** Valida a fila lida do armazenamento. Devolve { ok, queue } ou { ok:false, error }. */
  function parseQueue(raw, surveyId) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return { ok: false, error: "A fila de envio não é um JSON válido." }; }
    if (!isObject(parsed) || parsed.format !== QUEUE_FORMAT) return { ok: false, error: "Formato da fila não reconhecido." };
    if (parsed.queueVersion !== QUEUE_VERSION) return { ok: false, error: `Versão da fila não suportada (${String(parsed.queueVersion)}).` };
    if (Object.keys(parsed).length !== QUEUE_KEYS.length || QUEUE_KEYS.some((k) => !(k in parsed))) return { ok: false, error: "Campos da fila inesperados." };
    if (parsed.surveyId !== surveyId || typeof parsed.paused !== "boolean" || !isObject(parsed.items)) return { ok: false, error: "Fila inconsistente." };
    if (parsed.destination !== null && !(typeof parsed.destination === "string" && /^[0-9a-f]{64}$/.test(parsed.destination))) return { ok: false, error: "Destino da fila inválido." };
    if (parsed.blocked !== null && !(isObject(parsed.blocked) && typeof parsed.blocked.code === "string" && parsed.blocked.code.length <= 40 && isNullableNumber(parsed.blocked.at))) return { ok: false, error: "Bloqueio da fila inválido." };
    for (const [id, item] of Object.entries(parsed.items)) {
      if (!/^r_[0-9a-f]{32}$/.test(id) || !isObject(item)) return { ok: false, error: "Item da fila inválido." };
      if (Object.keys(item).length !== ITEM_KEYS.length || ITEM_KEYS.some((k) => !(k in item))) return { ok: false, error: "Campos de item inesperados." };
      if (!QUEUE_STATES.includes(item.state) || !Number.isInteger(item.attempts) || item.attempts < 0) return { ok: false, error: "Estado de item inválido." };
      if (!isNullableNumber(item.lastAttemptAt) || !isNullableNumber(item.nextAttemptAt) || !isNullableNumber(item.confirmedAt)) return { ok: false, error: "Horário de item inválido." };
      if (item.error !== null && !(isObject(item.error) && typeof item.error.code === "string" && item.error.code.length <= 40)) return { ok: false, error: "Erro de item inválido." };
    }
    return { ok: true, queue: parsed };
  }

  /**
   * Persistência da fila, da configuração do destino e da "licença" de operador (coordenação entre abas).
   * A licença impede dois operadores de sincronização ao mesmo tempo; não é atômica (localStorage não tem
   * compare-and-swap), por isso é só uma barreira de cortesia: a segurança contra duplicação vem da
   * idempotência por recordId no servidor.
   */
  function createSyncStore(options) {
    const storage = options.storage;
    const surveyId = options.surveyId || Dados.DEFAULT_SURVEY_ID;
    const now = options.now || (() => Date.now());
    const queueKey = `${KEY_PREFIX}sync:${surveyId}`;
    const leaseKey = `${KEY_PREFIX}sync-lease:${surveyId}`;
    const SYNC_CONFIG_KEY = syncConfigKeyFor(surveyId);
    let rawPreserved = null;

    const get = (key) => { try { const v = storage.getItem(key); return { ok: true, raw: v === undefined ? null : v }; } catch (e) { return { ok: false, error: messageOf(e) }; } };

    return {
      queueKey,
      leaseKey,
      configKey: SYNC_CONFIG_KEY,

      /** { status: "empty" | "ok" | "corrupt" | "unavailable", queue, error } */
      load() {
        const r = get(queueKey);
        if (!r.ok) return { status: "unavailable", queue: emptyQueue(surveyId), error: r.error };
        if (r.raw === null) { rawPreserved = null; return { status: "empty", queue: emptyQueue(surveyId) }; }
        const parsed = parseQueue(r.raw, surveyId);
        if (!parsed.ok) { rawPreserved = r.raw; return { status: "corrupt", queue: emptyQueue(surveyId), error: parsed.error }; }
        rawPreserved = null;
        return { status: "ok", queue: parsed.queue };
      },

      /** Grava e relê. Só devolve ok:true se o texto lido de volta for idêntico. */
      save(queue) {
        const text = JSON.stringify(queue);
        try { storage.setItem(queueKey, text); } catch (e) { return { ok: false, error: messageOf(e) }; }
        const back = get(queueKey);
        if (!back.ok) return { ok: false, error: `Leitura de confirmação falhou (${back.error}).` };
        return back.raw === text ? { ok: true } : { ok: false, error: "A leitura de confirmação não confere com o que foi gravado." };
      },

      reset() {
        try { storage.removeItem(queueKey); } catch (e) { return { ok: false, error: messageOf(e) }; }
        const back = get(queueKey);
        return back.ok && back.raw === null ? { ok: true } : { ok: false, error: "A fila continua presente após a tentativa de remoção." };
      },

      hasPreservedRaw: () => rawPreserved !== null,
      getPreservedRaw: () => rawPreserved,

      /** Copia a fila ilegível para uma chave de quarentena (conferida) e remove a original. */
      quarantine() {
        if (rawPreserved === null) return { ok: false, error: "Não há fila ilegível." };
        const qKey = `${queueKey}:ilegivel:${now()}`;
        try {
          storage.setItem(qKey, rawPreserved);
          if (storage.getItem(qKey) !== rawPreserved) return { ok: false, error: "Não foi possível confirmar a cópia; a fila original foi mantida." };
        } catch (e) { return { ok: false, error: `${messageOf(e)} A fila original foi mantida.` }; }
        const removed = this.reset();
        if (removed.ok) rawPreserved = null;
        return removed.ok ? { ok: true, quarantineKey: qKey } : { ok: false, error: removed.error };
      },

      /** Endpoint (NÃO é segredo) lembrado entre recargas. Chaves nunca passam por aqui. */
      readEndpoint() {
        const r = get(SYNC_CONFIG_KEY);
        if (!r.ok || r.raw === null) return null;
        try { const p = JSON.parse(r.raw); return typeof p.endpoint === "string" ? p.endpoint : null; } catch (_) { return null; }
      },
      writeEndpoint(endpoint) {
        try {
          if (endpoint === null) storage.removeItem(SYNC_CONFIG_KEY);
          else storage.setItem(SYNC_CONFIG_KEY, JSON.stringify({ endpoint }));
          return true;
        } catch (_) { return false; }
      },

      // ----- licença de operador -----
      peekLease() {
        const r = get(leaseKey);
        if (!r.ok || r.raw === null) return null;
        try { const p = JSON.parse(r.raw); return typeof p.owner === "string" && Number.isFinite(p.expiresAt) ? p : null; } catch (_) { return null; }
      },
      /** Adquire ou renova. { ok:true } só se, após gravar, a leitura de volta mostra este dono. */
      acquireLease(owner, ttlMs) {
        const current = this.peekLease();
        if (current && current.owner !== owner && current.expiresAt > now()) return { ok: false, holderActive: true };
        try { storage.setItem(leaseKey, JSON.stringify({ owner, expiresAt: now() + ttlMs })); } catch (e) { return { ok: false, error: messageOf(e) }; }
        const back = this.peekLease();
        return back && back.owner === owner ? { ok: true } : { ok: false, holderActive: true };
      },
      releaseLease(owner) {
        const current = this.peekLease();
        if (current && current.owner === owner) { try { storage.removeItem(leaseKey); } catch (_) { /* ignorado */ } }
      }
    };
  }

  /**
   * Lista EXATA das chaves de uma pesquisa (todas contêm o surveyId, exceto as chaves da pesquisa principal que mantêm o
   * nome original por compatibilidade). `quarantinePrefixes`: cópias de segurança de base/fila ilegível (sufixo = horário).
   */
  function surveyKeys(surveyId) {
    const data = storageKey(surveyId);
    const queue = `${KEY_PREFIX}sync:${surveyId}`;
    return {
      exact: [data, configKeyFor(surveyId), queue, syncConfigKeyFor(surveyId), `${KEY_PREFIX}sync-lease:${surveyId}`],
      quarantinePrefixes: [`${data}:ilegivel:`, `${queue}:ilegivel:`]
    };
  }
  function isSurveyKey(key, surveyId) {
    const k = surveyKeys(surveyId);
    return k.exact.includes(key) || k.quarantinePrefixes.some((p) => typeof key === "string" && key.startsWith(p));
  }

  const api = { surveyKeys, isSurveyKey, configKeyFor, syncConfigKeyFor, QUEUE_FORMAT, QUEUE_VERSION, QUEUE_STATES, createSyncStore, emptyQueue, parseQueue, STORE_FORMAT, STORE_VERSION, CONFLICT_FORMAT, KEY_PREFIX, CONFIG_KEY, storageKey, createLocalStorageAdapter, createStore, createConfig, messages };

  root.PesquisaArmazenamento = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
