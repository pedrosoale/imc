/*
 * Lógica da página prova-sheets.html — teste real controlado (Rodada 4B).
 * Não guarda nada no navegador (sem localStorage/sessionStorage/cookies). Chaves e URL só existem nos campos
 * digitados e na memória da página; o relatório sanitizado nunca inclui chaves nem a URL do Web App.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const log = [];
  let record = null;
  let unhandled = 0;

  window.addEventListener("unhandledrejection", () => { unhandled += 1; $("unhandled").textContent = String(unhandled); });

  function sanitize(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    let out = text;
    [$("url").value.trim(), $("chaveColeta").value, $("chaveLeitura").value].filter((s) => s && s.length >= 8).forEach((secret) => { out = out.split(secret).join("<oculto>"); });
    return out;
  }

  function print(title, value, ms) {
    log.push(`[${new Date().toISOString()}]${ms !== undefined ? ` (${Math.round(ms)} ms)` : ""} ${title}\n${sanitize(value)}`);
    $("saida").textContent = log.join("\n\n");
  }

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `r_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  function makeRecord() {
    const weightKg = 40 + Math.round(Math.random() * 100) / 10;
    const heightM = 1.4 + Math.round(Math.random() * 20) / 100;
    return {
      data: { recordId: randomId(), surveyId: $("surveyId").value, collectedAt: new Date().toISOString(), ageMonths: 120 + Math.floor(Math.random() * 40), sex: "male", weightKg, heightM },
      derived: { bmi: weightKg / (heightM * heightM), calcVersion: 1 }
    };
  }

  // fetch comum, ou "descarta a resposta" depois de enviar (simula resposta perdida no navegador)
  function client(options) {
    const opts = options || {};
    const fetchImpl = opts.discardResponse
      ? (url, init) => { fetch(url, { ...init, signal: undefined }).catch(() => {}); return Promise.reject(new TypeError("resposta descartada de propósito")); }
      : (url, init) => fetch(url, init);
    return ClienteSheets.create({ url: $("url").value.trim(), fetchImpl, timeoutMs: opts.timeoutMs || 20000 });
  }

  function ensureRecord() {
    if (!record) { record = makeRecord(); print("Registro fictício criado", { recordId: record.data.recordId }); }
    return record;
  }

  async function run(title, fn) {
    const started = performance.now();
    try { const value = await fn(); print(title, value, performance.now() - started); } catch (error) { print(`${title} — erro`, String(error && error.message), performance.now() - started); }
  }

  const sha256 = async (text) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
  };

  $("origem").textContent = location.origin;
  $("bPing").onclick = () => run("Ping", async () => ({ coleta: await client().ping($("chaveColeta").value), leitura: await client().ping($("chaveLeitura").value) }));
  $("bNovo").onclick = () => { record = makeRecord(); print("Novo registro fictício", record); };
  $("bEnviar").onclick = () => run("Enviar", () => client().append($("chaveColeta").value, [ensureRecord()]));
  $("bReenviar").onclick = () => run("Reenviar o mesmo registro", () => client().append($("chaveColeta").value, [ensureRecord()]));
  $("bPerder").onclick = () => { record = makeRecord(); return run("Enviar descartando a resposta (confira a planilha; depois use o passo 4)", () => client({ discardResponse: true }).append($("chaveColeta").value, [record])); };
  $("bConflito").onclick = () => run("Mesmo ID, conteúdo diferente", () => {
    const changed = JSON.parse(JSON.stringify(ensureRecord()));
    changed.data.ageMonths += 1;
    return client().append($("chaveColeta").value, [changed]);
  });
  $("bSimultaneo").onclick = () => run("Envio simultâneo do mesmo ID (2 requisições)", async () => {
    record = makeRecord();
    const results = await Promise.all([client().append($("chaveColeta").value, [record]), client().append($("chaveColeta").value, [record])]);
    return results.map((r) => r.verdicts[0]);
  });
  $("bChaveInvalida").onclick = () => run("Chave inválida", () => client().append("x".repeat(40), [ensureRecord()]));
  $("bColetaLe").onclick = () => run("Chave de coleta tentando ler (deve ser recusada)", async () => ({ resumo: await client().summary($("chaveColeta").value), listagem: await client().list($("chaveColeta").value, 0) }));
  $("bLeituraGrava").onclick = () => run("Chave de leitura tentando acrescentar (deve ser recusada)", () => client().append($("chaveLeitura").value, [ensureRecord()]));
  $("bResumo").onclick = () => run("Resumo", () => client().summary($("chaveLeitura").value));
  $("bListar").onclick = () => run("Listar", () => client().list($("chaveLeitura").value, 0));
  $("bRestaurar").onclick = () => run("Restauração verificada (resumo + páginas + contagem + digest)", async () => {
    const r = await client().restore($("chaveLeitura").value, sha256);
    return { complete: r.complete, reason: r.reason, count: r.count, transport: r.transport };
  });
  // Envia de verdade, mas substitui o corpo da resposta por um fluxo que nunca termina (Response/ReadableStream reais):
  // reproduz "cabeçalhos chegam, corpo trava". Esperado: timeout, não confirmado, nenhuma unhandledrejection; depois, reenvio = duplicate.
  $("bTimeout").onclick = () => run("Corpo travado (prazo de 400 ms): deve dar timeout, não confirmar e não gerar unhandledrejection", async () => {
    const before = unhandled;
    record = makeRecord();
    const stalled = (url, init) => fetch(url, init).then(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));
    const r = await ClienteSheets.create({ url: $("url").value.trim(), fetchImpl: stalled, timeoutMs: 400 }).append($("chaveColeta").value, [record]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { transport: r.transport, verdicts: r.verdicts, unhandledrejectionNovos: unhandled - before, proximoPasso: "use o passo 4 (reenviar): esperado duplicate" };
  });
  $("bCopiar").onclick = async () => {
    const header = `Origem: ${location.origin}\nNavegador: ${navigator.userAgent}\nunhandledrejection: ${unhandled}\n\n`;
    try { await navigator.clipboard.writeText(header + $("saida").textContent); print("Relatório sanitizado copiado", "ok"); } catch (_) { print("Cópia indisponível", "selecione o texto manualmente"); }
  };
})();
