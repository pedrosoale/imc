/*
 * Pesquisa educativa — informe do estado de envio entre janelas (Rodada 5).
 *
 * A janela de coleta publica, por BroadcastChannel (somente local ao navegador, sem rede), um estado OPERACIONAL com
 * contagens. Nunca viajam registros individuais, IDs, horários, URL, chaves ou valores de medidas.
 * A janela do painel só informa o que recebeu e que ainda é recente; sem sinal recente ela NÃO afirma que tudo foi salvo.
 * Sem BroadcastChannel (ou se ele falhar) o painel diz que não há como informar.
 */
(function (root) {
  "use strict";

  const CHANNEL = "imc-pesquisa-envio";
  const PROTOCOL = 1;
  /** Um canal por pesquisa: pesquisas diferentes (ex.: ensaio e principal) nunca se enxergam. A principal mantém o nome original. */
  const channelName = (surveyId) => (!surveyId || surveyId === "feira-2026" ? CHANNEL : `${CHANNEL}:${surveyId}`);
  const COUNT_KEYS = ["total", "local", "pendente", "enviando", "confirmado", "falha", "intervencao"];

  function defaultChannelFactory(win) {
    const target = win || root;
    return (name) => (typeof target.BroadcastChannel === "function" ? new target.BroadcastChannel(name) : null);
  }

  /** Aceita somente o formato esperado e copia campo a campo (nada além do permitido atravessa). */
  function sanitizeState(raw) {
    if (!raw || typeof raw !== "object" || raw.v !== PROTOCOL || raw.type !== "estado") return null;
    if (typeof raw.sessionId !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(raw.sessionId)) return null;
    if (typeof raw.surveyId !== "string" || raw.surveyId.length > 40) return null;
    const s = raw.state;
    if (!s || typeof s !== "object" || !s.counts || typeof s.counts !== "object") return null;
    const counts = {};
    for (const k of COUNT_KEYS) {
      if (!Number.isInteger(s.counts[k]) || s.counts[k] < 0 || s.counts[k] > 1e6) return null;
      counts[k] = s.counts[k];
    }
    if (!Number.isInteger(s.memoryOnly) || s.memoryOnly < 0 || s.memoryOnly > 1e6) return null;
    const blocked = s.blocked === null ? null : (typeof s.blocked === "string" && /^[a-z-]{1,40}$/.test(s.blocked) ? s.blocked : undefined);
    if (blocked === undefined) return null;
    return {
      sessionId: raw.sessionId,
      surveyId: raw.surveyId,
      state: {
        collectMode: s.collectMode === true,
        configured: s.configured === true,
        operator: s.operator === true,
        paused: s.paused === true,
        durable: s.durable === true,
        blocked,
        counts,
        memoryOnly: s.memoryOnly
      }
    };
  }

  /** Lado da janela de coleta. getState() devolve o estado atual (já sem dados individuais). */
  function createPublisher(options) {
    const factory = options.channelFactory || defaultChannelFactory();
    const timers = options.timers || { setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (i) => clearTimeout(i) };
    const intervalMs = options.intervalMs || 5000;
    const surveyId = options.surveyId;
    const sessionId = options.sessionId;
    let channel = null;
    let timer = null;
    let started = false;
    let lastSignature = "";

    function post(state) {
      if (!channel) return false;
      try { channel.postMessage({ v: PROTOCOL, type: "estado", sessionId, surveyId, state }); return true; } catch (_) { return false; }
    }

    function publish(force) {
      const state = options.getState();
      const signature = JSON.stringify(state);
      if (!force && signature === lastSignature) return false;
      lastSignature = signature;
      return post(state);
    }

    function tick() {
      timer = null;
      if (!started) return;
      publish(true); // batimento: mostra que a janela continua viva
      timer = timers.setTimeout(tick, intervalMs);
    }

    return {
      supported() { return channel !== null; },
      start() {
        if (started) return true;
        try { channel = factory(channelName(surveyId)); } catch (_) { channel = null; }
        if (!channel) return false;
        started = true;
        channel.onmessage = (event) => {
          const d = event && event.data;
          if (d && d.v === PROTOCOL && d.type === "oi") publish(true); // um painel acabou de abrir
        };
        tick();
        return true;
      },
      /** Chamar quando algo mudar (publica na hora, se o estado mudou). */
      notify() { if (started) publish(false); },
      stop() {
        started = false;
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        if (channel) { try { channel.close(); } catch (_) { /* ignorado */ } }
        channel = null;
      }
    };
  }

  /** Lado do painel. */
  function createViewer(options) {
    const factory = options.channelFactory || defaultChannelFactory();
    const now = options.now || (() => Date.now());
    const staleMs = options.staleMs || 15000;
    const surveyId = options.surveyId;
    const sessions = new Map(); // sessionId -> { receivedAt, state }
    const listeners = new Set();
    let channel = null;
    let supported = false;

    function start() {
      try { channel = factory(channelName(surveyId)); } catch (_) { channel = null; }
      supported = channel !== null;
      if (!channel) return false;
      channel.onmessage = (event) => {
        const parsed = sanitizeState(event && event.data);
        if (!parsed || parsed.surveyId !== surveyId) return;
        sessions.set(parsed.sessionId, { receivedAt: now(), state: parsed.state });
        listeners.forEach((fn) => { try { fn(); } catch (_) { /* ignorado */ } });
      };
      try { channel.postMessage({ v: PROTOCOL, type: "oi" }); } catch (_) { /* ignorado */ }
      return true;
    }

    function view() {
      if (!supported) return { status: "sem-suporte", sessions: [], allSaved: false, text: "Este navegador não permite a comunicação entre janelas; não é possível informar as pendências da janela de coleta." };
      const t = now();
      const all = [...sessions.entries()].map(([id, v]) => ({ id, ageMs: t - v.receivedAt, fresh: t - v.receivedAt <= staleMs, state: v.state }));
      if (!all.length) return { status: "sem-sinal", sessions: [], allSaved: false, text: "Nenhuma janela de coleta respondeu. Não é possível afirmar que todos os registros foram salvos ou enviados." };
      const fresh = all.filter((s) => s.fresh && s.state.collectMode);
      if (!fresh.length) {
        const newest = Math.min(...all.map((s) => s.ageMs));
        return { status: "expirado", sessions: all, allSaved: false, text: `A janela de coleta não responde há ${Math.round(newest / 1000)} s (modo coleta desligado ou janela fechada). A informação de envio expirou e não pode ser usada para afirmar que tudo foi salvo.` };
      }

      // As janelas de um mesmo navegador leem a MESMA base e a MESMA fila gravada: somar contagens entre janelas contaria
      // cada registro mais de uma vez. O estado de envio vem da janela que opera o envio; só os registros apenas em
      // memória (que não são compartilhados) são somados.
      const operators = fresh.filter((s) => s.state.operator);
      const multipleOperators = operators.length > 1;
      const primary = operators.length === 1 ? operators[0] : fresh.slice().sort((a, b) => b.state.counts.total - a.state.counts.total)[0];
      const c = primary.state.counts;
      const memoryOnly = fresh.reduce((n, s) => n + s.state.memoryOnly, 0);
      const configured = primary.state.configured;
      const age = Math.round(primary.ageMs / 1000);
      const allSaved = configured && operators.length === 1 && c.total > 0 && c.confirmado === c.total
        && memoryOnly === 0 && primary.state.durable && !primary.state.blocked && !primary.state.paused;
      const waiting = c.pendente + c.enviando + c.falha + c.local;
      const parts = [];
      if (!configured) parts.push(`A janela de coleta tem ${c.total} registro(s) salvos neste computador; o envio à planilha não está configurado.`);
      else if (multipleOperators) parts.push("Mais de uma janela diz operar o envio; não é possível afirmar o estado de envio.");
      else if (allSaved) parts.push(`Todos os ${c.total} registro(s) da janela de coleta estão confirmados na planilha (último sinal há ${age} s).`);
      else {
        parts.push(`Janela de coleta: ${c.confirmado} confirmado(s) na planilha, ${waiting} aguardando envio ou sem confirmação${c.intervencao ? `, ${c.intervencao} exigindo intervenção` : ""}.`);
        if (operators.length === 0) parts.push("Nenhuma janela está operando o envio agora.");
      }
      if (primary.state.paused) parts.push("O envio está pausado.");
      if (primary.state.blocked) parts.push("O envio está bloqueado e precisa de ação do operador.");
      if (configured && !primary.state.durable) parts.push("A janela de coleta não conseguiu gravar o estado de envio neste navegador.");
      if (memoryOnly > 0) parts.push(`A janela de coleta tem ${memoryOnly} registro(s) apenas em memória; este painel NÃO os inclui.`);
      if (fresh.length > 1) parts.push(`${fresh.length} janelas de coleta responderam; os números de envio vêm ${operators.length === 1 ? "da janela operadora" : "de uma delas"}, pois todas leem a mesma base.`);
      return { status: "ativo", sessions: all, allSaved: Boolean(allSaved), text: parts.join(" ") };
    }

    return {
      start,
      view,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      stop() { if (channel) { try { channel.close(); } catch (_) { /* ignorado */ } } channel = null; supported = false; }
    };
  }

  const api = { CHANNEL, channelName, PROTOCOL, sanitizeState, createPublisher, createViewer };
  root.PesquisaProjecao = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
