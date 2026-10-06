/*
 * Pesquisa educativa — sincronização opcional com a planilha do responsável (Rodada 5).
 *
 * O módulo é dono da LÓGICA de envio; tudo que toca o mundo é injetado: transporte (fetchImpl), relógio, temporizadores,
 * aleatório, SHA-256, a base de dados (store) e a persistência da fila (syncStore). Não usa DOM, rede nem armazenamento do navegador diretamente.
 *
 * Princípios
 *  - A fila guarda só IDs e estados; os valores enviados vêm da base de dados no momento do envio. Estados de envio
 *    nunca alteram os dados coletados.
 *  - A fila é gravada ANTES de enviar. Se não puder ser gravada, nada é enviado.
 *  - "Salvo na planilha" (estado "confirmado") exige resposta legível, HTTP 200, status inserted/duplicate e eco do
 *    registro idêntico ao enviado (verificação feita por pesquisa-cliente.js). Nunca no-cors.
 *  - O mesmo recordId é usado em toda retentativa; o servidor é idempotente. Uma chamada pode falhar DEPOIS de o servidor
 *    gravar: por isso "falha" significa "não confirmado", e o reenvio é sempre seguro (resultado "duplicate").
 *  - Se a confirmação não puder ser gravada localmente, ela vale só para esta sessão e é dita como tal; depois de recarregar,
 *    o item volta a ser reenviado (duplicate → confirmado de novo).
 *  - Uma requisição de envio por vez. Recuo exponencial com variação aleatória e limite. Erros de credencial, configuração,
 *    integridade e conflito não são repetidos indefinidamente: exigem retomada explícita.
 *  - A chave de coleta vive só em memória (closure). A chave de leitura é recebida por chamada e descartada.
 *  - Só um operador de envio por vez (licença em armazenamento compartilhado, ver createSyncStore).
 *  - navigator.onLine nunca é prova de disponibilidade: o evento "online" apenas antecipa uma tentativa real.
 */
(function (root) {
  "use strict";

  const isNode = typeof module === "object" && module.exports;
  const Dados = isNode ? require("./pesquisa-dados.js") : root.PesquisaDados;
  const Cliente = isNode ? require("./pesquisa-cliente.js") : root.ClienteSheets;

  const DEFAULTS = {
    attemptTimeoutMs: 30000,
    batchSize: 10,
    maxBatch: 25,                 // limite do contrato v1 (Codigo.gs MAX_BATCH)
    backoffBaseMs: 2000,
    backoffFactor: 2,
    backoffMaxMs: 300000,
    jitter: 0.5,                  // atraso efetivo entre 50% e 100% do calculado
    minSpacingMs: 1000,           // intervalo mínimo entre quaisquer duas tentativas
    onlineKickMinMs: 15000,       // o evento "online" não pode disparar tentativas em rajada
    maxTransientFailures: 10,
    maxUnexpectedResponses: 3,
    leaseTtlMs: 45000,
    heartbeatMs: 10000,
    diagnosticsSize: 20
  };

  const STATES = Dados.SYNC_STATES; // local, pendente, enviando, confirmado, falha, intervencao

  // ---------- destino ----------

  /**
   * Nesta versão só se aceita o endpoint de uma implantação Apps Script: https, host script.google.com,
   * /macros/s/<ID>/exec, sem credenciais embutidas, porta, parâmetros ou fragmento. A validação acontece
   * ANTES de qualquer chave ser transmitida.
   */
  function validateEndpoint(value) {
    if (typeof value !== "string" || !value.trim()) return { ok: false, error: "Informe o endereço do serviço." };
    let url;
    try { url = new URL(value.trim()); } catch (_) { return { ok: false, error: "Endereço inválido." }; }
    if (url.protocol !== "https:") return { ok: false, error: "O endereço deve usar HTTPS." };
    if (url.hostname !== "script.google.com") return { ok: false, error: "Nesta versão só é aceito o endereço de uma implantação do Google Apps Script." };
    if (url.username || url.password) return { ok: false, error: "O endereço não pode conter usuário ou senha." };
    if (url.port) return { ok: false, error: "O endereço não pode conter porta." };
    if (url.search || url.hash) return { ok: false, error: "O endereço não pode conter parâmetros nem fragmento." };
    if (!/^\/macros\/s\/[A-Za-z0-9_-]{20,200}\/exec$/.test(url.pathname)) return { ok: false, error: "O endereço deve terminar em /exec de uma implantação (macros/s/…/exec)." };
    return { ok: true, endpoint: url.href };
  }

  function keyProblem(key) {
    if (typeof key !== "string" || key.length < 16 || key.length > 200) return "A chave deve ter entre 16 e 200 caracteres.";
    if (/\s/.test(key)) return "A chave não pode conter espaços.";
    return null;
  }

  // ---------- classificação de falhas ----------

  const TRANSIENT_HTTP = new Set([404, 408, 425, 429, 500, 502, 503, 504]);
  const SERVER_BLOCKS = {
    unauthorized: "credencial",
    forbidden: "sem-permissao",
    "collection-disabled": "coleta-desligada",
    "integrity-error": "integridade",
    "not-configured": "servidor-nao-configurado",
    "not-prepared": "planilha-nao-preparada",
    "unsupported-version": "versao-do-contrato",
    "bad-request": "requisicao-recusada",
    "too-large": "requisicao-recusada"
  };

  /**
   * Resultado de transporte -> { category: "transient" | "unexpected" | "block", code }.
   *  transient:  timeout, rede, HTTP 404/408/425/429/5xx, erro de leitura, servidor ocupado/planilha inacessível (retryable)
   *  unexpected: resposta opaca, não-JSON (ex.: página de login), formato fora do contrato, outros HTTP
   *  block:      erro explícito do servidor que não melhora sozinho
   */
  function classifyTransport(transport) {
    const kind = transport && transport.kind;
    if (kind === "timeout" || kind === "rede" || kind === "leitura") return { category: "transient", code: kind };
    if (kind === "http") {
      const code = `http-${Number(transport.status) || 0}`;
      return { category: TRANSIENT_HTTP.has(transport.status) ? "transient" : "unexpected", code };
    }
    if (kind === "opaca" || kind === "nao-json" || kind === "formato") return { category: "unexpected", code: kind };
    if (kind === "servidor") {
      const err = transport.error || {};
      const raw = typeof err.code === "string" ? err.code : "desconhecido";
      if (SERVER_BLOCKS[raw]) return { category: "block", code: SERVER_BLOCKS[raw], serverCode: raw };
      if (err.retryable === true) return { category: "transient", code: raw === "busy" ? "servidor-ocupado" : (raw === "spreadsheet-access" ? "planilha-inacessivel" : "servidor-temporario") };
      return { category: "block", code: "servidor-recusou", serverCode: raw };
    }
    return { category: "unexpected", code: "desconhecido" };
  }

  const BLOCK_TEXT = {
    credencial: "A chave de coleta foi recusada pelo servidor. Digite a chave correta e retome o envio.",
    "sem-permissao": "Esta chave não tem permissão para enviar registros. Use a chave de COLETA e retome o envio.",
    "coleta-desligada": "A coleta está desligada no servidor. Peça ao responsável para ligá-la e retome o envio.",
    integridade: "A planilha contém linhas inválidas ou IDs repetidos. O responsável precisa reparar a base; a coleta local continua normalmente. Retome o envio depois do reparo.",
    "servidor-nao-configurado": "O servidor não está configurado. Peça ao responsável para corrigir a implantação e retome o envio.",
    "planilha-nao-preparada": "A planilha ainda não foi preparada pelo responsável. Retome o envio depois.",
    "versao-do-contrato": "O servidor usa uma versão de contrato diferente desta página. Atualize a página ou o servidor.",
    "requisicao-recusada": "O servidor recusou o formato da requisição. Não será repetido automaticamente.",
    "servidor-recusou": "O servidor recusou o envio por um motivo não previsto. Não será repetido automaticamente.",
    "falhas-repetidas": "Muitas tentativas falharam seguidas (rede ou serviço indisponível). O envio foi pausado; os registros continuam salvos neste computador. Use \"Retomar envio\" quando a conexão estiver normal.",
    "resposta-inesperada": "O serviço respondeu algo que não é o esperado (endereço errado, página de login ou serviço fora do contrato). Confira o endereço e retome o envio.",
    "fila-nao-salva": "A fila de envio não pôde ser gravada neste navegador; por segurança nada é enviado. Os registros continuam como estavam."
  };

  function backoffDelay(failures, cfg, random) {
    const exp = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * Math.pow(cfg.backoffFactor, Math.max(0, failures - 1)));
    const jittered = exp * (1 - cfg.jitter * random());
    return Math.max(cfg.minSpacingMs, Math.round(jittered));
  }

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const newItem = (state) => ({ state, attempts: 0, lastAttemptAt: null, nextAttemptAt: null, confirmedAt: null, error: null });
  const safeCode = (code) => String(code || "desconhecido").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "desconhecido";

  // ======================= criação =======================

  /**
   * deps: { store, syncStore, fetchImpl, sha256Hex, surveyId, now, timers:{setTimeout,clearTimeout}, random,
   *         createClient, ownerId, config:{...DEFAULTS} }
   */
  function create(deps) {
    const store = deps.store;
    const syncStore = deps.syncStore;
    const surveyId = deps.surveyId || Dados.DEFAULT_SURVEY_ID;
    const now = deps.now || (() => Date.now());
    const timers = deps.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
    const random = deps.random || Math.random;
    const sha256Hex = deps.sha256Hex;
    const createClient = deps.createClient || Cliente.create;
    const cfg = { ...DEFAULTS, ...(deps.config || {}) };
    cfg.batchSize = Math.max(1, Math.min(cfg.batchSize, cfg.maxBatch));
    const ownerId = deps.ownerId || `w_${Math.floor(random() * 1e9).toString(36)}${now().toString(36)}`;

    // estado em memória
    let queue = null;               // fila (somente IDs e estados)
    let queueStatus = "empty";      // empty | ok | corrupt | unavailable
    let queueError = null;
    let endpoint = null;            // URL validada (não é segredo)
    let appendKey = null;           // SOMENTE em memória
    let operator = false;
    let active = false;             // enviando automaticamente (operador + chave + não pausado/bloqueado)
    let inFlight = false;
    let inFlightIds = new Set();
    let attemptTimer = null;
    let heartbeatTimer = null;
    let nextAllowedAt = 0;          // recuo global
    let lastAttemptEnd = 0;
    let lastKickAt = -Infinity;
    let failures = { transient: 0, unexpected: 0 };
    let durable = true;             // a última gravação da fila deu certo?
    let persistError = null;
    let unsavedConfirmations = 0;   // confirmações só em memória (a fila não pôde ser gravada)
    let diagnostics = [];
    // "Geração" = época da configuração. Sobe quando a pesquisa local é excluída, quando o destino muda e quando o destino é
    // removido. Toda tentativa e toda prévia de conferência ficam presas à geração (e ao destino) em que nasceram; resposta
    // ou prévia de outra época nunca altera a fila nem confirma nada no destino atual.
    let generation = 0;
    const itemStreak = new Map();   // recordId -> falhas consecutivas em respostas legíveis (só memória)
    const previews = new WeakMap(); // prévia (objeto devolvido) -> { generation, destination, remote, newIds, knownLocal }
    const listeners = new Set();

    function emit() {
      const snap = snapshot();
      listeners.forEach((fn) => { try { fn(snap); } catch (_) { /* ouvintes não podem quebrar o envio */ } });
    }

    function diag(entry) {
      diagnostics.push({ at: now(), ...entry });
      if (diagnostics.length > cfg.diagnosticsSize) diagnostics = diagnostics.slice(-cfg.diagnosticsSize);
    }

    // ---------- fila ----------

    function loadQueue() {
      const loaded = syncStore.load();
      queueStatus = loaded.status;
      queueError = loaded.error || null;
      queue = loaded.queue;
      return loaded.status;
    }

    function persist() {
      if (queueStatus === "corrupt" || queueStatus === "unavailable") { durable = false; persistError = queueError || "Fila indisponível."; return { ok: false, error: persistError }; }
      const result = syncStore.save(queue);
      if (result.ok) {
        durable = true; persistError = null; unsavedConfirmations = 0;
        if (queueStatus === "empty") queueStatus = "ok";
      } else {
        durable = false; persistError = result.error;
      }
      return result;
    }

    /** Sem destino configurado e sem fila gravada, nada é escrito: a coleta local se comporta como antes da Rodada 5. */
    const queueInUse = () => Boolean(queue && (queue.destination || queueStatus === "ok"));

    /** Cria itens para registros novos e descarta itens cujo registro deixou de existir. Devolve true se mudou. */
    function ensureQueue() {
      if (!queue || (!queue.destination && queueStatus !== "ok")) return false; // sem integração, nada é criado nem gravado
      const storeStatus = store.getStatus();
      const records = store.getRecords();
      let changed = false;
      const ids = new Set();
      records.forEach((r) => {
        const id = r.data.recordId;
        ids.add(id);
        if (!queue.items[id]) { queue.items[id] = newItem(queue.destination ? "pendente" : "local"); changed = true; }
      });
      // Só descarta quando a base foi lida com sucesso (uma base ilegível não pode apagar estados confirmados).
      if (storeStatus === "ok" || storeStatus === "empty") {
        Object.keys(queue.items).forEach((id) => { if (!ids.has(id) && !inFlightIds.has(id)) { delete queue.items[id]; changed = true; } });
      }
      return changed;
    }

    function counts() {
      const c = { total: 0, local: 0, pendente: 0, enviando: 0, confirmado: 0, falha: 0, intervencao: 0 };
      const records = store.getRecords();
      records.forEach((r) => {
        c.total += 1;
        const item = queue && queue.items[r.data.recordId];
        let state = item ? item.state : (queue && queue.destination ? "pendente" : "local");
        if (state === "enviando" && !inFlightIds.has(r.data.recordId)) state = "falha"; // interrompido por recarga/outra janela
        c[state] += 1;
      });
      return c;
    }

    function itemState(recordId) {
      const item = queue && queue.items[recordId];
      let state = item ? item.state : (queue && queue.destination ? "pendente" : "local");
      if (state === "enviando" && !inFlightIds.has(recordId)) state = "falha";
      return state;
    }

    function recoverInterrupted() {
      let changed = false;
      Object.values(queue.items).forEach((item) => {
        if (item.state === "enviando" && !inFlightIds.size) { item.state = "pendente"; item.error = { code: "interrompido" }; changed = true; }
      });
      return changed;
    }

    // ---------- estado público ----------

    function snapshot() {
      const c = counts();
      const lease = syncStore.peekLease ? syncStore.peekLease() : null;
      const otherOperator = Boolean(lease && lease.owner !== ownerId && lease.expiresAt > now());
      return {
        counts: c,
        configured: Boolean(endpoint && queue && queue.destination),
        hasEndpoint: Boolean(endpoint),
        hasKey: appendKey !== null,
        operator,
        otherOperator,
        active,
        sending: inFlight,
        paused: Boolean(queue && queue.paused),
        blocked: queue && queue.blocked ? { code: queue.blocked.code, text: BLOCK_TEXT[queue.blocked.code] || "Envio bloqueado." } : null,
        queueStatus,
        queueError,
        durable,
        persistError,
        unsavedConfirmations,
        nextAttemptAt: active && nextAllowedAt > now() ? nextAllowedAt : null,
        failures: { ...failures },
        // verdadeiro somente quando TUDO o que existe localmente está confirmado e o estado confirmado foi gravado
        allConfirmedDurably: c.total > 0 && c.confirmado === c.total && durable && unsavedConfirmations === 0
      };
    }

    // ---------- classificação de estado para exibição ----------

    function describe(recordId) {
      const state = itemState(recordId);
      const item = queue && queue.items[recordId];
      const paused = Boolean(queue && queue.paused);
      const blocked = Boolean(queue && queue.blocked);
      switch (state) {
        case "confirmado":
          return durable && unsavedConfirmations === 0
            ? { state, label: "Salvo na planilha", warning: false }
            : { state, label: "Confirmado na planilha nesta sessão; este computador não conseguiu gravar essa informação (o reenvio é seguro)", warning: true };
        case "enviando": return { state, label: "Enviando… ainda sem confirmação", warning: false };
        case "falha": return { state, label: "Envio não confirmado", warning: true, detail: item && item.error ? item.error.code : null };
        case "intervencao": return { state, label: "Conflito ou rejeição: exige intervenção do responsável", warning: true, detail: item && item.error ? item.error.code : null };
        case "pendente": return { state, label: paused || blocked ? "Envio pausado; salvo neste computador" : "Aguardando envio", warning: false };
        default: return { state: "local", label: "Salvo neste computador", warning: false };
      }
    }

    // ---------- configuração ----------

    function initFromStorage() {
      loadQueue();
      const saved = syncStore.readEndpoint ? syncStore.readEndpoint() : null;
      if (saved) {
        const v = validateEndpoint(saved);
        endpoint = v.ok ? v.endpoint : null;
      }
      if (queueStatus === "ok" && ensureQueue()) persistIfInUse();
      emit();
      return snapshot();
    }

    function persistIfInUse() { return queueInUse() ? persist() : { ok: true, skipped: true }; }

    /**
     * Define o destino. Confirmações só valem para o destino em que ocorreram: se o destino mudou, tudo o que estava
     * "confirmado" volta a "pendente" (será conferido no novo destino; o reenvio é seguro).
     */
    async function configure(text) {
      const v = validateEndpoint(text);
      if (!v.ok) return { ok: false, error: v.error };
      if (typeof sha256Hex !== "function") return { ok: false, error: "SHA-256 indisponível neste contexto (use https ou localhost)." };
      if (queueStatus === "corrupt" || queueStatus === "unavailable") return { ok: false, error: "A fila de envio não pode ser usada agora (veja o alerta). A coleta local continua." };
      let fingerprint;
      try { fingerprint = await sha256Hex(`imc-destino:${v.endpoint}`); } catch (e) { return { ok: false, error: "Não foi possível calcular a identificação do destino." }; }
      const changedDestination = queue.destination !== fingerprint;
      if (changedDestination) {
        // Cancelar no cliente não garante que o servidor antigo não gravou: por isso respostas antigas são invalidadas
        // (geração), o agendamento e a chave são descartados e o novo destino exige ativação explícita.
        generation += 1;
        itemStreak.clear();
        deactivate();
      }
      endpoint = v.endpoint;
      queue.destination = fingerprint;
      ensureQueue();
      Object.values(queue.items).forEach((item) => {
        if (item.state === "local" || (changedDestination && (item.state === "confirmado" || item.state === "intervencao" || item.state === "enviando" || item.state === "falha"))) {
          item.state = "pendente"; item.error = null; item.confirmedAt = null; item.nextAttemptAt = null; item.attempts = 0;
        }
      });
      if (changedDestination) { queue.blocked = null; failures = { transient: 0, unexpected: 0 }; }
      const saved = persist();
      if (syncStore.writeEndpoint) syncStore.writeEndpoint(endpoint);
      emit();
      return { ok: true, durable: saved.ok, destinationChanged: changedDestination };
    }

    function removeDestination() {
      generation += 1; // respostas de envios iniciados para o destino removido deixam de valer
      itemStreak.clear();
      deactivate();
      endpoint = null;
      if (syncStore.writeEndpoint) syncStore.writeEndpoint(null);
      if (queue) {
        queue.destination = null; queue.blocked = null;
        // sem destino não há como afirmar confirmação: todos voltam a "salvo neste computador"
        Object.values(queue.items).forEach((item) => { item.state = "local"; item.error = null; item.nextAttemptAt = null; item.confirmedAt = null; });
        persistIfInUse();
      }
      emit();
      return { ok: true };
    }

    function setKey(key) {
      const problem = keyProblem(key);
      if (problem) return { ok: false, error: problem };
      appendKey = key;
      emit();
      return { ok: true };
    }
    function clearKey() { appendKey = null; emit(); }

    // ---------- licença de operador e agendamento ----------

    function acquire() {
      const r = syncStore.acquireLease(ownerId, cfg.leaseTtlMs);
      operator = r.ok === true;
      return r;
    }

    function heartbeat() {
      heartbeatTimer = null;
      if (!operator) return;
      const r = acquire();
      if (!r.ok) { deactivate(); diag({ event: "licenca-perdida" }); emit(); return; }
      heartbeatTimer = timers.setTimeout(heartbeat, cfg.heartbeatMs);
    }

    function canSend(manual) {
      if (queueStatus === "corrupt" || queueStatus === "unavailable") return { ok: false, reason: "fila-indisponivel" };
      if (!queue || !queue.destination || !endpoint) return { ok: false, reason: "sem-destino" };
      if (appendKey === null) return { ok: false, reason: "sem-chave" };
      if (!operator) return { ok: false, reason: "nao-operador" };
      if (queue.paused) return { ok: false, reason: "pausado" };
      if (queue.blocked) return { ok: false, reason: "bloqueado" };
      if (store.getStatus() === "unavailable" || store.getStatus() === "corrupt" || store.getStatus() === "unsupported") return { ok: false, reason: "base-local-indisponivel" };
      return { ok: true };
    }

    function clearAttemptTimer() { if (attemptTimer !== null) { timers.clearTimeout(attemptTimer); attemptTimer = null; } }

    function hasEligible(manual) {
      const t = now();
      return Object.values(queue.items).some((item) => item.state === "pendente" || (item.state === "falha" && (manual || (item.nextAttemptAt || 0) <= Math.max(t, nextAllowedAt))));
    }

    function schedule() {
      clearAttemptTimer();
      if (!active || inFlight || !canSend(false).ok) return;
      const open = Object.values(queue.items).filter((i) => i.state === "pendente" || i.state === "falha");
      if (!open.length) return;
      const t = now();
      const earliest = open.some((i) => i.state === "pendente") ? 0 : Math.min(...open.map((i) => i.nextAttemptAt || 0));
      const delay = Math.max(0, nextAllowedAt - t, lastAttemptEnd + cfg.minSpacingMs - t, earliest - t);
      attemptTimer = timers.setTimeout(() => { attemptTimer = null; attempt(false); }, delay);
    }

    /** Liga o envio automático nesta janela (exige destino, chave e licença de operador). */
    function activate() {
      const gate = { ...canSend(true) };
      if (!gate.ok && gate.reason !== "nao-operador") return { ok: false, reason: gate.reason };
      const lease = acquire();
      if (!lease.ok) return { ok: false, reason: lease.holderActive ? "outra-janela-opera" : "licenca-indisponivel" };
      if (queueStatus === "ok" || queueStatus === "empty") {
        loadQueue(); // pode ter mudado depois da última leitura
        if (recoverInterrupted() | ensureQueue()) persist();
      }
      const gate2 = canSend(true);
      if (!gate2.ok && gate2.reason !== "pausado" && gate2.reason !== "bloqueado") { operator = false; syncStore.releaseLease(ownerId); return { ok: false, reason: gate2.reason }; }
      active = true;
      clearTimeoutSafe(heartbeatTimer); heartbeatTimer = timers.setTimeout(heartbeat, cfg.heartbeatMs);
      schedule();
      emit();
      return { ok: true };
    }
    function clearTimeoutSafe(id) { if (id !== null && id !== undefined) timers.clearTimeout(id); }

    /**
     * Para novos envios nesta janela, solta a licença e descarta a chave. Um envio JÁ INICIADO não pode ser
     * cancelado no servidor: ele termina e o resultado ainda é registrado (confirmado ou não).
     */
    function deactivate() {
      active = false;
      clearAttemptTimer();
      clearTimeoutSafe(heartbeatTimer); heartbeatTimer = null;
      if (operator) syncStore.releaseLease(ownerId);
      operator = false;
      appendKey = null;
      emit();
    }

    function pause() {
      if (!queue) return { ok: false };
      queue.paused = true;
      clearAttemptTimer();
      persistIfInUse();
      emit();
      return { ok: true, note: inFlight ? "O envio em andamento termina; nenhum novo será iniciado." : "" };
    }

    /** Retomada explícita: limpa pausa, bloqueio e contadores de falha e libera itens em recuo. */
    function resume() {
      if (!queue) return { ok: false };
      queue.paused = false; queue.blocked = null;
      failures = { transient: 0, unexpected: 0 };
      itemStreak.clear();
      nextAllowedAt = 0;
      Object.values(queue.items).forEach((i) => { if (i.state === "falha") i.nextAttemptAt = null; });
      persistIfInUse();
      schedule();
      emit();
      return { ok: true };
    }

    /** Ação explícita do responsável depois de corrigir a causa: itens em intervenção voltam a pendentes. */
    function retryAttention() {
      let n = 0;
      Object.values(queue.items).forEach((i) => { if (i.state === "intervencao") { i.state = "pendente"; i.error = null; i.attempts = 0; n += 1; } });
      persistIfInUse();
      schedule();
      emit();
      return { ok: true, count: n };
    }

    // ---------- tentativa de envio ----------

    function pickBatch(manual) {
      const t = now();
      const byId = new Map(store.getRecords().map((r) => [r.data.recordId, r]));
      const chosen = [];
      for (const [id, item] of Object.entries(queue.items)) {
        if (chosen.length >= cfg.batchSize) break;
        const eligible = item.state === "pendente" || (item.state === "falha" && (manual || (item.nextAttemptAt || 0) <= t));
        if (!eligible) continue;
        const record = byId.get(id);
        if (!record) continue;
        if (Dados.validateRecord(record).length) { item.state = "intervencao"; item.error = { code: "registro-invalido" }; continue; }
        chosen.push({ id, record });
      }
      return chosen;
    }

    function blockAll(code, ids) {
      queue.blocked = { code, at: now() };
      ids.forEach((id) => { const i = queue.items[id]; if (i && i.state === "enviando") { i.state = "pendente"; } });
      clearAttemptTimer();
    }

    /** Uma tentativa. manual=true ignora o recuo (não a pausa, o bloqueio nem a exclusão mútua). */
    async function attempt(manual) {
      if (inFlight) return { status: "ocupado" };
      const gate = canSend(manual);
      if (!gate.ok) return { status: gate.reason };
      const t0 = now();
      if (manual && t0 - lastAttemptEnd < cfg.minSpacingMs && lastAttemptEnd > 0) return { status: "muito-rapido" };
      const lease = acquire();
      if (!lease.ok) { deactivate(); return { status: "nao-operador" }; }
      loadQueueIfIdle();
      if (ensureQueue()) persist();
      const batch = pickBatch(manual);
      if (!batch.length) { lastAttemptEnd = now(); schedule(); return { status: "nada-a-enviar" }; }

      inFlight = true;
      const myGeneration = generation;
      const myDestination = queue.destination;
      const myEndpoint = endpoint;
      const ids = batch.map((b) => b.id);
      inFlightIds = new Set(ids);
      const before = ids.map((id) => ({ id, item: clone(queue.items[id]) }));
      ids.forEach((id) => { const i = queue.items[id]; i.state = "enviando"; i.attempts += 1; i.lastAttemptAt = t0; i.nextAttemptAt = null; i.error = null; });
      const saved = persist();
      if (!saved.ok) {
        // A fila é gravada ANTES de enviar. Sem isso, nada sai.
        before.forEach(({ id, item }) => { queue.items[id] = item; });
        inFlight = false; inFlightIds = new Set();
        failures.transient += 1;
        diag({ event: "fila-nao-salva" });
        if (failures.transient >= cfg.maxTransientFailures) blockAll("fila-nao-salva", []);
        else nextAllowedAt = now() + backoffDelay(failures.transient, cfg, random);
        schedule(); emit();
        return { status: "fila-nao-salva" };
      }
      emit();

      let outcome;
      try {
        const client = createClient({ url: myEndpoint, fetchImpl: deps.fetchImpl, timeoutMs: cfg.attemptTimeoutMs, setTimeoutFn: timers.setTimeout, clearTimeoutFn: timers.clearTimeout });
        outcome = await client.append(appendKey, batch.map((b) => b.record));
      } catch (error) {
        outcome = { transport: { ok: false, kind: "rede" }, verdicts: ids.map((id) => ({ recordId: id, verdict: "nao-confirmado", reason: "rede" })) };
      }
      const result = applyOutcome(ids, outcome, myGeneration, myDestination, t0);
      inFlight = false; inFlightIds = new Set();
      lastAttemptEnd = now();
      schedule(); emit();
      return result;
    }

    function loadQueueIfIdle() { /* a fila em memória é a fonte durante a operação; só uma janela escreve (licença) */ }

    function applyOutcome(ids, outcome, myGeneration, myDestination, startedAt) {
      const duration = now() - startedAt;
      if (myGeneration !== generation || !queue || queue.destination !== myDestination) {
        // A resposta pertence a outro destino ou a outra pesquisa local: não confirma nada e não mexe em contadores nem na fila.
        diag({ event: "resultado-ignorado", reason: "destino-ou-pesquisa-mudou", durationMs: duration });
        return { status: "ignorado" };
      }
      const live = new Set(store.getRecords().map((r) => r.data.recordId));
      const t = now();
      const summary = { status: "concluido", confirmed: 0, failed: 0, attention: 0, batch: ids.length };

      if (!outcome.transport.ok) {
        const cls = classifyTransport(outcome.transport);
        diag({ event: "falha", category: cls.category, code: cls.code, durationMs: duration, batch: ids.length });
        if (cls.category === "block") {
          blockAll(cls.code, ids);
          if (cls.code === "credencial" || cls.code === "sem-permissao") appendKey = null; // força digitar de novo
          ids.forEach((id) => { const i = queue.items[id]; if (i) i.error = { code: cls.code }; });
          summary.status = "bloqueado"; summary.code = cls.code;
        } else {
          if (cls.category === "transient") { failures.transient += 1; failures.unexpected = 0; } else { failures.unexpected += 1; failures.transient = 0; }
          const delay = backoffDelay(Math.max(failures.transient, failures.unexpected), cfg, random);
          nextAllowedAt = t + delay;
          ids.forEach((id) => {
            const i = queue.items[id];
            if (!i) return;
            if (!live.has(id)) { delete queue.items[id]; return; }
            i.state = "falha"; i.error = { code: safeCode(cls.code) }; i.nextAttemptAt = nextAllowedAt; summary.failed += 1;
          });
          if (failures.transient >= cfg.maxTransientFailures) { blockAll("falhas-repetidas", []); summary.status = "pausado-por-falhas"; }
          else if (failures.unexpected >= cfg.maxUnexpectedResponses) { blockAll("resposta-inesperada", []); summary.status = "pausado-por-resposta"; }
          else summary.status = "falha";
          summary.code = cls.code;
        }
        persist();
        return summary;
      }

      // Resposta legível NÃO é sucesso por si só. Só "confirmado" é sucesso; cada item que não foi confirmado nem exige
      // intervenção conta uma falha consecutiva própria. Um item confirmado não mascara a falha persistente dos outros.
      const PROTOCOL_REASONS = new Set(["sem-resultado", "resultado-repetido", "status-desconhecido"]);
      const byId = new Map();
      outcome.verdicts.forEach((v) => { if (v && typeof v.recordId === "string" && !byId.has(v.recordId)) byId.set(v.recordId, v); });
      const failedNow = [];
      ids.forEach((id) => {
        const v = byId.get(id) || { recordId: id, verdict: "nao-confirmado", reason: "sem-resultado" };
        const i = queue.items[id];
        if (!i) return;
        if (!live.has(id)) { delete queue.items[id]; itemStreak.delete(id); return; } // excluído localmente durante o envio: não ressuscita
        if (v.verdict === "confirmado") {
          i.state = "confirmado"; i.confirmedAt = t; i.error = null; i.nextAttemptAt = null; summary.confirmed += 1; itemStreak.delete(id);
        } else if (v.verdict === "conflito") {
          i.state = "intervencao"; i.error = { code: "conflito" }; summary.attention += 1; itemStreak.delete(id);
        } else if (v.verdict === "rejeitado") {
          i.state = "intervencao"; i.error = { code: "rejeitado" }; summary.attention += 1; itemStreak.delete(id);
        } else if (v.reason === "eco-divergente") {
          i.state = "intervencao"; i.error = { code: "eco-divergente" }; summary.attention += 1; itemStreak.delete(id);
        } else {
          i.state = "falha"; i.error = { code: safeCode(v.reason || "nao-confirmado") }; summary.failed += 1;
          itemStreak.set(id, (itemStreak.get(id) || 0) + 1);
          failedNow.push({ id, category: PROTOCOL_REASONS.has(v.reason) ? "unexpected" : "transient" });
        }
      });
      if (!failedNow.length) {
        failures = { transient: 0, unexpected: 0 };
      } else {
        const worst = (category) => Math.max(0, ...failedNow.filter((f) => f.category === category).map((f) => itemStreak.get(f.id) || 0));
        failures = { transient: worst("transient"), unexpected: worst("unexpected") };
        nextAllowedAt = t + backoffDelay(Math.max(failures.transient, failures.unexpected), cfg, random);
        failedNow.forEach((f) => { const i = queue.items[f.id]; if (i) i.nextAttemptAt = nextAllowedAt; });
        if (failures.transient >= cfg.maxTransientFailures) { blockAll("falhas-repetidas", []); summary.status = "pausado-por-falhas"; }
        else if (failures.unexpected >= cfg.maxUnexpectedResponses) { blockAll("resposta-inesperada", []); summary.status = "pausado-por-resposta"; }
      }
      diag({ event: "resposta", confirmed: summary.confirmed, failed: summary.failed, attention: summary.attention, durationMs: duration, batch: ids.length });
      const saved = persist();
      if (!saved.ok && summary.confirmed) {
        unsavedConfirmations += summary.confirmed;
        summary.durable = false;
      }
      return summary;
    }

    // ---------- gatilhos ----------

    function sendNow() { return attempt(true); }

    /** Antecipa uma tentativa real (ex.: evento "online"). Não substitui o recuo de forma ilimitada. */
    function kick() {
      const t = now();
      if (inFlight || !active) return { status: inFlight ? "ocupado" : "inativo" };
      if (t - lastKickAt < cfg.onlineKickMinMs) return { status: "muito-rapido" };
      lastKickAt = t;
      if (!canSend(false).ok) return { status: "nao-pode" };
      nextAllowedAt = 0;
      Object.values(queue.items).forEach((i) => { if (i.state === "falha") i.nextAttemptAt = null; });
      clearAttemptTimer();
      attemptTimer = timers.setTimeout(() => { attemptTimer = null; attempt(false); }, Math.max(0, lastAttemptEnd + cfg.minSpacingMs - t));
      return { status: "agendado" };
    }

    /** Chamar depois de registrar/importar/excluir ou quando outra janela alterar a base. */
    function refresh() {
      if (!queue) return;
      if (!operator) {
        // Janela que não opera o envio só LÊ a fila gravada pelo operador; nunca escreve nela.
        if (!inFlight) { loadQueue(); const saved = syncStore.readEndpoint ? syncStore.readEndpoint() : null; const v = saved ? validateEndpoint(saved) : null; endpoint = v && v.ok ? v.endpoint : null; }
        emit();
        return;
      }
      if (queueStatus === "ok" || queueStatus === "empty") {
        if (ensureQueue() && queueInUse()) persist();
      }
      schedule();
      emit();
    }

    /** Exclusão da pesquisa local: a fila é descartada. Linhas já enviadas ao Google NÃO são afetadas. */
    function onSurveyDeleted() {
      generation += 1;
      itemStreak.clear();
      clearAttemptTimer();
      const had = queue ? Object.values(queue.items).filter((i) => i.state === "confirmado").length : 0;
      const destination = queue ? queue.destination : null;
      const reset = syncStore.reset();
      if (queue) queue.items = {};      // o destino configurado continua; só os itens somem
      unsavedConfirmations = 0; durable = reset.ok; persistError = reset.ok ? null : reset.error;
      failures = { transient: 0, unexpected: 0 }; nextAllowedAt = 0;
      if (destination) persist();       // regrava só destino/pausa, sem itens
      emit();
      return { ok: reset.ok, droppedConfirmed: had, error: reset.error };
    }

    // ---------- restauração / conciliação (chave de LEITURA) ----------

    /**
     * Lê toda a planilha com a chave de leitura e prepara uma PRÉVIA, sem alterar nada.
     * Verificações e alcance:
     *  - resumo + páginas + total + SHA-256 dos IDs ordenados conferem (garante o CONJUNTO de IDs, não o conteúdo);
     *  - cada registro recebido é validado aqui (estrutura, limites, IMC coerente, pesquisa) e IDs não podem repetir;
     *  - o conteúdo só é comparado para IDs que também existem localmente (iguais x divergentes).
     * Qualquer falha => { ok:false, reason } (nunca restauração parcial apresentada como completa).
     */
    async function prepareReconciliation(readKey) {
      const problem = keyProblem(readKey);
      if (problem) return { ok: false, reason: "chave-leitura-invalida", error: problem };
      if (appendKey !== null && readKey === appendKey) return { ok: false, reason: "chaves-iguais", error: "A chave de leitura deve ser diferente da chave de coleta." };
      if (!endpoint) return { ok: false, reason: "sem-destino", error: "Configure o destino antes." };
      if (typeof sha256Hex !== "function") return { ok: false, reason: "sem-verificacao", error: "SHA-256 indisponível neste contexto." };
      if (!queue || !queue.destination) return { ok: false, reason: "sem-destino", error: "Configure o destino antes." };
      const prepGeneration = generation;
      const prepDestination = queue.destination;
      const client = createClient({ url: endpoint, fetchImpl: deps.fetchImpl, timeoutMs: cfg.attemptTimeoutMs, setTimeoutFn: timers.setTimeout, clearTimeoutFn: timers.clearTimeout });
      let restored;
      try { restored = await client.restore(readKey, sha256Hex); } catch (_) { restored = { complete: false, reason: "rede" }; }
      readKey = null; // descartada
      if (generation !== prepGeneration || !queue || queue.destination !== prepDestination) return { ok: false, reason: "destino-mudou", error: "O destino mudou durante a leitura; a prévia foi descartada." };
      if (!restored.complete) return { ok: false, reason: restored.reason || "incompleta", transport: restored.transport ? classifyTransport(restored.transport) : null };

      const seen = new Set();
      for (const r of restored.records) {
        const issues = Dados.validateRecord(r);
        if (issues.length || r.data.surveyId !== surveyId || seen.has(r.data.recordId)) return { ok: false, reason: "registros-invalidos" };
        seen.add(r.data.recordId);
      }
      if (restored.records.length !== restored.count) return { ok: false, reason: "contagem-diferente" };

      const local = new Map(store.getRecords().map((r) => [r.data.recordId, r]));
      const toAdd = [];
      const identical = [];
      const differing = [];
      restored.records.forEach((r) => {
        const mine = local.get(r.data.recordId);
        if (!mine) toAdd.push(Dados.cloneRecord(r));
        else if (Dados.recordsEqual(mine, r)) identical.push(r.data.recordId);
        else differing.push({ recordId: r.data.recordId, differingFields: fieldDiff(mine, r), local: Dados.cloneRecord(mine), remote: Dados.cloneRecord(r) });
      });
      const localOnlyIds = [...local.keys()].filter((id) => !seen.has(id));
      // Itens que a fila diz "confirmado" mas que a planilha NÃO tem (planilha trocada, zerada ou restaurada de uma cópia antiga):
      // a confirmação deixa de valer e eles voltam a ser enviados.
      const staleConfirmed = localOnlyIds.filter((id) => queue && queue.items[id] && queue.items[id].state === "confirmado").length;
      const preview = {
        ok: true,
        counts: { remote: restored.records.length, new: toAdd.length, identical: identical.length, differing: differing.length, localOnly: localOnlyIds.length, staleConfirmed },
        toAdd, identical, differing, localOnlyIds,
        report: JSON.stringify({ format: "imc-pesquisa-conciliacao", formatVersion: 1, surveyId, divergentes: differing.map((d) => ({ recordId: d.recordId, differingFields: d.differingFields, local: d.local, remote: d.remote })) }, null, 2)
      };
      // A prévia fica presa ao destino e à geração em que foi lida e guarda o conteúdo remoto COMPLETO (não só IDs), para
      // comparar de novo com a base local no momento de aplicar. O registro fica fora do objeto devolvido (não é forjável).
      previews.set(preview, {
        generation: prepGeneration,
        destination: prepDestination,
        remote: restored.records.map(Dados.cloneRecord),
        newIds: new Set(toAdd.map((r) => r.data.recordId)),
        knownLocal: new Set(local.keys())
      });
      return preview;
    }

    function fieldDiff(a, b) {
      const keys = [];
      ["recordId", "surveyId", "collectedAt", "ageMonths", "sex", "weightKg", "heightM"].forEach((k) => { if (a.data[k] !== b.data[k]) keys.push(k); });
      ["bmi", "calcVersion"].forEach((k) => { if (a.derived[k] !== b.derived[k]) keys.push(k); });
      return keys;
    }

    /**
     * Aplica a prévia: importa os registros novos (tudo ou nada), marca como confirmados os que vieram da planilha ou
     * conferem com ela, e marca divergentes para revisão SEM sobrescrever. Exige ser o operador (escreve na fila).
     */
    function applyReconciliation(preview) {
      if (!preview || !preview.ok) return { ok: false, reason: "previa-invalida" };
      const bound = previews.get(preview);
      if (!bound) return { ok: false, reason: "previa-desconhecida" };
      if (!queue || !queue.destination) return { ok: false, reason: "sem-destino" };
      // Antes de importar ou tocar na fila: a prévia só vale para o destino e a geração em que foi lida.
      if (bound.generation !== generation || bound.destination !== queue.destination) return { ok: false, reason: "previa-desatualizada" };
      const acquiredHere = !operator;
      if (acquiredHere) {
        const lease = acquire();
        if (!lease.ok) return { ok: false, reason: "nao-operador" };
        // esta janela só tinha uma visão da fila: relê (outra janela pode ter trocado o destino)
        loadQueue();
        if (!queue.destination || bound.destination !== queue.destination) {
          syncStore.releaseLease(ownerId); operator = false;
          return { ok: false, reason: "previa-desatualizada" };
        }
      }
      try { return applyReconciliationLocked(bound, preview); } finally {
        // a licença tomada só para aplicar não fica retida (não há batimento nem envio nesta janela)
        if (acquiredHere && !active) { syncStore.releaseLease(ownerId); operator = false; emit(); }
      }
    }

    /**
     * Recalcula TUDO contra a base local atual (inclusive mudanças de outras janelas depois da prévia) usando o conteúdo
     * remoto guardado: a presença de um ID nunca basta para confirmar; só conteúdo igual confirma.
     * Registros que existiam localmente na prévia e foram excluídos depois NÃO são trazidos de volta.
     */
    function applyReconciliationLocked(bound, preview) {
      store.reconcile(); // enxerga alterações de outras janelas
      const local = new Map(store.getRecords().map((r) => [r.data.recordId, r]));
      const remoteIds = new Set(bound.remote.map((r) => r.data.recordId));
      const toAdd = [];
      const differing = [];
      let skippedDeleted = 0;
      bound.remote.forEach((r) => {
        const id = r.data.recordId;
        const mine = local.get(id);
        if (!mine) {
          if (bound.newIds.has(id)) toAdd.push(Dados.cloneRecord(r));
          else skippedDeleted += 1; // existia na prévia e foi excluído localmente depois
        } else if (!Dados.recordsEqual(mine, r)) {
          differing.push({ recordId: id, differingFields: fieldDiff(mine, r), local: Dados.cloneRecord(mine), remote: Dados.cloneRecord(r) });
        }
      });
      let added = 0;
      if (toAdd.length) {
        const imported = store.applyImport({ ok: true, toAdd, errors: [], counts: {} });
        if (!imported.ok && imported.outcome !== "incerto") return { ok: false, reason: "importacao-nao-aplicada", error: imported.error };
        added = imported.added || 0;
      }
      ensureQueue();
      const t = now();
      const current = new Map(store.getRecords().map((r) => [r.data.recordId, r]));
      let confirmed = 0;
      bound.remote.forEach((r) => {
        const id = r.data.recordId;
        const mine = current.get(id);
        const i = queue.items[id];
        if (i && mine && Dados.recordsEqual(mine, r)) { i.state = "confirmado"; i.confirmedAt = t; i.error = null; i.nextAttemptAt = null; confirmed += 1; itemStreak.delete(id); }
      });
      differing.forEach((d) => { const i = queue.items[d.recordId]; if (i) { i.state = "intervencao"; i.error = { code: "divergente" }; } });
      let reopened = 0;
      [...current.keys()].filter((id) => !remoteIds.has(id)).forEach((id) => {
        const i = queue.items[id];
        if (i && i.state === "confirmado") { i.state = "pendente"; i.confirmedAt = null; i.error = null; i.nextAttemptAt = null; reopened += 1; }
      });
      const saved = persist();
      emit();
      schedule();
      const changedSincePreview = toAdd.length !== preview.counts.new || differing.length !== preview.counts.differing || skippedDeleted > 0;
      return {
        ok: true, added, confirmed, differing: differing.length, reopened, skippedDeleted, changedSincePreview, durable: saved.ok,
        report: JSON.stringify({ format: "imc-pesquisa-conciliacao", formatVersion: 1, surveyId, divergentes: differing }, null, 2)
      };
    }

    // ---------- exportação de estados para backup (informativa) ----------

    function exportStates() {
      return store.getRecords().map((r) => ({ recordId: r.data.recordId, state: itemState(r.data.recordId) }));
    }

    initFromStorage();

    return {
      ownerId,
      config: cfg,
      init: initFromStorage,
      configure,
      removeDestination,
      setKey,
      clearKey,
      activate,
      deactivate,
      pause,
      resume,
      retryAttention,
      sendNow,
      kick,
      refresh,
      onSurveyDeleted,
      prepareReconciliation,
      applyReconciliation,
      snapshot,
      describe,
      getEndpoint: () => endpoint,
      exportStates,
      diagnostics: () => diagnostics.map((d) => ({ ...d })),
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      /** Substitui uma fila ilegível (cópia preservada em quarentena). Seguro: a fila só tem estados; o reenvio é idempotente. */
      quarantineQueue() {
        const q = syncStore.quarantine();
        if (q.ok) { loadQueue(); emit(); }
        return q;
      },
      // exposto para testes e diagnósticos (não contém segredos)
      _internals: { get queue() { return queue; } }
    };
  }

  const api = { DEFAULTS, STATES, BLOCK_TEXT, validateEndpoint, keyProblem, classifyTransport, backoffDelay, create };
  root.PesquisaSincronizacao = api;
  if (isNode) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
