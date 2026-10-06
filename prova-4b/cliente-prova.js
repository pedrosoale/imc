/*
 * Cliente de PROVA do contrato com o Apps Script (Rodada 4A). Não é usado pela aplicação principal.
 *
 * Regras:
 *  - requisição "simples" (POST, Content-Type text/plain, sem cabeçalhos personalizados) para não gerar pré-voo CORS;
 *  - NUNCA usa mode "no-cors": a resposta precisa ser legível;
 *  - "confirmado" só se o servidor respondeu legivelmente (HTTP 200, JSON v1, ok:true), com status "inserted" ou
 *    "duplicate" E o registro devolvido ("stored", relido da planilha) idêntico ao enviado;
 *  - qualquer outra coisa (erro de rede, resposta opaca, HTML de login, JSON inválido, ok:false, eco divergente,
 *    registro ausente) é "nao-confirmado" e o registro deve continuar pendente para reenvio com o MESMO recordId;
 *  - nenhuma chave nem URL é guardada ou escrita em log por este módulo.
 */
(function (root) {
  "use strict";

  const CONTRACT_VERSION = 1;
  const DATA_KEYS = ["recordId", "surveyId", "collectedAt", "ageMonths", "sex", "weightKg", "heightM"];
  const DERIVED_KEYS = ["bmi", "calcVersion"];

  function sameRecord(a, b) {
    if (!a || !b || !a.data || !b.data || !a.derived || !b.derived) return false;
    return DATA_KEYS.every((k) => a.data[k] === b.data[k]) && DERIVED_KEYS.every((k) => a.derived[k] === b.derived[k])
      && Object.keys(a.data).length === DATA_KEYS.length && Object.keys(b.data).length === DATA_KEYS.length
      && Object.keys(a.derived).length === DERIVED_KEYS.length && Object.keys(b.derived).length === DERIVED_KEYS.length;
  }

  function create(options) {
    const url = options.url;
    const fetchImpl = options.fetchImpl;
    const timeoutMs = options.timeoutMs || 20000;
    if (typeof url !== "string" || !url) throw new Error("url é obrigatória.");
    if (typeof fetchImpl !== "function") throw new Error("fetchImpl é obrigatório.");

    /**
     * Cancelamento de melhor esforço do corpo, sem aguardar nem propagar nada: cancel() devolve uma Promise cuja
     * rejeição (ex.: "ReadableStream is locked", pois text() já travou o fluxo) é absorvida, e uma exceção
     * síncrona também. A limpeza nunca prolonga o prazo nem bloqueia o retorno de post().
     */
    function discardBody(response) {
      try {
        const body = response && response.body;
        if (!body || typeof body.cancel !== "function") return;
        const pending = body.cancel();
        if (pending && typeof pending.then === "function") pending.then(() => {}, () => {});
      } catch (_) { /* ignorado */ }
    }

    /**
     * Envia uma requisição e devolve { ok:true, data } ou { ok:false, kind, ... }. Nunca lança.
     * O limite de tempo (timeoutMs) cobre TODA a operação: conexão, cabeçalhos E leitura do corpo.
     * Ao esgotar: aborta o fetch (se houver AbortController), tenta cancelar o corpo e devolve kind "timeout".
     * O temporizador é sempre limpo (finally).
     */
    async function post(body) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let timer = null;
      let timedOut = false; // o AbortError provocado pelo próprio prazo é timeout, não falha de rede
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (controller) { try { controller.abort(); } catch (_) { /* ignorado */ } }
          reject(Object.assign(new Error("timeout"), { isTimeout: true }));
        }, timeoutMs);
      });
      deadline.catch(() => {}); // evita rejeição não tratada se o prazo vencer fora de uma corrida
      let response = null;
      try {
        response = await Promise.race([fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(body),
          redirect: "follow",
          credentials: "omit",
          cache: "no-store",
          signal: controller ? controller.signal : undefined
        }), deadline]);
        if (!response || response.type === "opaque" || response.type === "opaqueredirect") return { ok: false, kind: "opaca" };
        if (!response.ok) return { ok: false, kind: "http", status: response.status };
        let text;
        try { text = await Promise.race([response.text(), deadline]); } catch (error) {
          if ((error && error.isTimeout) || timedOut) throw error;
          return { ok: false, kind: "leitura" };
        }
        let data;
        try { data = JSON.parse(text); } catch (_) { return { ok: false, kind: "nao-json" }; } // ex.: página de login do Google
        if (!data || typeof data !== "object" || typeof data.ok !== "boolean" || data.v !== CONTRACT_VERSION) return { ok: false, kind: "formato" };
        if (!data.ok) return { ok: false, kind: "servidor", error: data.error || null };
        return { ok: true, data };
      } catch (error) {
        if ((error && error.isTimeout) || timedOut) {
          discardBody(response);
          return { ok: false, kind: "timeout" };
        }
        return { ok: false, kind: "rede", detail: error && error.name ? error.name : "erro" };
      } finally {
        clearTimeout(timer);
      }
    }

    /** Compara o que foi enviado com o que o servidor diz ter gravado. */
    function verify(sent, results) {
      const byId = new Map();
      (Array.isArray(results) ? results : []).forEach((r) => {
        if (r && typeof r.recordId === "string") byId.set(r.recordId, (byId.get(r.recordId) || []).concat(r));
      });
      return sent.map((record) => {
        const id = record.data.recordId;
        const found = byId.get(id) || [];
        if (found.length !== 1) return { recordId: id, verdict: "nao-confirmado", reason: found.length ? "resultado-repetido" : "sem-resultado" };
        const r = found[0];
        if ((r.status === "inserted" || r.status === "duplicate") && sameRecord(r.stored, record)) return { recordId: id, verdict: "confirmado", status: r.status };
        if (r.status === "inserted" || r.status === "duplicate") return { recordId: id, verdict: "nao-confirmado", reason: "eco-divergente" };
        if (r.status === "conflict") return { recordId: id, verdict: "conflito", differingFields: r.differingFields || [] };
        if (r.status === "rejected") return { recordId: id, verdict: "rejeitado", reason: r.error || [] };
        return { recordId: id, verdict: "nao-confirmado", reason: r.status === "error" ? "erro-servidor" : "status-desconhecido" };
      });
    }

    return {
      post,
      verify,
      ping: (key) => post({ v: CONTRACT_VERSION, action: "ping", key }),
      summary: (key) => post({ v: CONTRACT_VERSION, action: "summary", key }),
      list: (key, cursor) => post({ v: CONTRACT_VERSION, action: "list", key, cursor }),
      /**
       * Restaura TODA a pesquisa com a chave de leitura. Só devolve complete:true se: o resumo e todas as páginas
       * vieram legíveis e sem erro; a lista terminou (done); não há ID repetido; a quantidade e o SHA-256 dos IDs
       * ordenados conferem com o resumo. Qualquer erro de integridade do servidor (integrity-error) é incompleto.
       * `sha256Hex` (async) é injetado: Node crypto ou crypto.subtle.
       */
      async restore(key, sha256Hex) {
        const fail = (reason, extra) => ({ complete: false, reason, records: [], ...(extra || {}) });
        if (typeof sha256Hex !== "function") return fail("sem-verificacao");
        const summary = await post({ v: CONTRACT_VERSION, action: "summary", key });
        if (!summary.ok) return fail(summary.kind === "servidor" && summary.error && summary.error.code === "integrity-error" ? "integridade" : "resumo", { transport: summary });
        const records = [];
        let cursor = 0;
        let done = false;
        for (let page = 0; page < 10000 && !done; page += 1) {
          const result = await post({ v: CONTRACT_VERSION, action: "list", key, cursor });
          if (!result.ok) return fail(result.kind === "servidor" && result.error && result.error.code === "integrity-error" ? "integridade" : "listagem", { transport: result });
          const d = result.data;
          if (!Array.isArray(d.records) || typeof d.nextCursor !== "number" || typeof d.done !== "boolean") return fail("formato");
          records.push(...d.records);
          if (!d.done && d.nextCursor <= cursor) return fail("cursor");
          cursor = d.nextCursor;
          done = d.done;
        }
        if (!done) return fail("limite-de-paginas");
        const ids = records.map((r) => r && r.data && r.data.recordId);
        if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) return fail("ids-repetidos");
        if (records.length !== summary.data.count) return fail("contagem-diferente", { expected: summary.data.count, received: records.length });
        const digest = await sha256Hex(ids.slice().sort().join("\n"));
        if (digest !== summary.data.idDigest) return fail("digest-diferente");
        return { complete: true, reason: null, records, count: records.length };
      },
      /** Retorna { transport, verdicts }. Sem resposta legível, todos ficam "nao-confirmado". */
      async append(key, records) {
        const result = await post({ v: CONTRACT_VERSION, action: "append", key, records });
        if (!result.ok) {
          return { transport: result, verdicts: records.map((r) => ({ recordId: r.data.recordId, verdict: "nao-confirmado", reason: result.kind })) };
        }
        return { transport: { ok: true }, verdicts: verify(records, result.data.results) };
      }
    };
  }

  const api = { CONTRACT_VERSION, sameRecord, create };
  root.ClienteSheets = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
