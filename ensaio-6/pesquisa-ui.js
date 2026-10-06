/*
 * Pesquisa educativa — interface do modo coleta e da área do operador.
 *
 * Só atua se o operador ativar o modo coleta. Não lê nome nem data de nascimento:
 * recebe de script.js apenas o instantâneo numérico do cálculo (evento "imc:calculo").
 * Não chama a rede nem acessa o armazenamento do navegador diretamente: o armazenamento é de pesquisa-armazenamento.js e o envio opcional à planilha é de
 * pesquisa-sincronizacao.js (transporte em pesquisa-transporte.js). Esta interface só mostra o estado e aciona essas peças.
 */
(function (root) {
  "use strict";
  if (typeof document === "undefined") return;

  const Dados = root.PesquisaDados;
  const Armazenamento = root.PesquisaArmazenamento;
  const Candidato = root.PesquisaCandidato;
  if (!Dados || !Armazenamento || !Candidato) return;

  const $ = (id) => document.getElementById(id);
  // A pesquisa padrão é a principal. Uma página de ensaio declara outra por <meta name="imc-pesquisa-id">; todas as chaves
  // persistidas, a fila, a licença e o canal entre janelas são separados por esse identificador. Valor inválido: não inicia.
  const surveyMeta = document.querySelector('meta[name="imc-pesquisa-id"]');
  const surveyId = surveyMeta ? surveyMeta.getAttribute("content") : Dados.DEFAULT_SURVEY_ID;
  if (!Dados.isValidSurveyId(surveyId)) { document.documentElement.setAttribute("data-pesquisa", "invalida"); return; }

  const adapter = Armazenamento.createLocalStorageAdapter(root);
  const store = Armazenamento.createStore({ storage: adapter, surveyId });
  const config = Armazenamento.createConfig(adapter, surveyId);
  const Mensagens = Armazenamento.messages;
  const Sinc = root.PesquisaSincronizacao;
  const Transporte = root.PesquisaTransporte;
  const Projecao = root.PesquisaProjecao;
  const viewer = Projecao ? Projecao.createViewer({ surveyId }) : null;
  const painel = root.PesquisaPainel ? root.PesquisaPainel.create({ store, projection: viewer }) : null;
  const syncStore = Sinc ? Armazenamento.createSyncStore({ storage: adapter, surveyId }) : null;
  const sync = Sinc && Transporte && syncStore
    ? Sinc.create({ store, syncStore, surveyId, fetchImpl: Transporte.createFetchTransport(root), sha256Hex: Transporte.createSha256(root) })
    : null;
  const publisher = Projecao && sync ? Projecao.createPublisher({ surveyId, sessionId: sync.ownerId, getState: projectionState }) : null;
  const controller = Candidato.createController({ store, surveyId });

  const form = $("imcForm");
  const assessmentDate = $("assessmentDate");
  const resultSection = $("resultado");
  const privacyBadge = document.querySelector(".privacy-badge");
  const formPrivacy = document.querySelector(".form-privacy");

  const originalTexts = {
    badgeStrong: privacyBadge.querySelector("strong").textContent,
    badgeSmall: privacyBadge.querySelector("small").textContent,
    formPrivacy: formPrivacy.innerHTML
  };

  const AVISO_INICIO = "Participação voluntária. Se você registrar, este computador guardará somente: sexo usado no cálculo, "
    + "idade em meses completos, peso, altura e IMC, com a data e a hora. Nome e data de nascimento não são guardados.";
  const AVISO_FIM = " Você pode usar a calculadora sem registrar. Os resultados descrevem apenas quem participou da feira.";

  /** O aviso descreve o comportamento REAL do momento: com ou sem envio à planilha. */
  function aviso() {
    const s = syncView();
    if (!s || !s.configured) return AVISO_INICIO + AVISO_FIM;
    const envio = s.active && !s.paused && !s.blocked
      ? " O envio opcional está ativo: o registro também poderá ser enviado, pela internet, a uma planilha privada do responsável pela pesquisa."
      : " O responsável configurou o envio opcional, mas ele não está ativo agora: por enquanto o registro fica somente neste computador e poderá ser enviado depois, a uma planilha privada do responsável pela pesquisa.";
    return AVISO_INICIO + envio + AVISO_FIM;
  }

  const syncView = () => (sync && collectMode ? sync.snapshot() : null);
  const syncConfiguredNow = () => { const s = syncView(); return Boolean(s && s.configured); };

  function projectionState() {
    const s = sync.snapshot();
    return { collectMode, configured: s.configured, operator: s.operator, paused: s.paused, durable: s.durable, blocked: s.blocked ? s.blocked.code : null, counts: s.counts, memoryOnly: store.unsavedCount() };
  }

  let collectMode = config.read().collectMode;
  let pendingPreview = null;
  let internalChange = false;

  // ---------- utilidades ----------

  function stamp() {
    return Dados.toIsoWithOffset(new Date()).replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function say(message) {
    $("operadorMensagem").textContent = message;
  }

  function problemText() {
    const status = store.getStatus();
    if (status === "corrupt") return `A base salva neste navegador está ilegível (${store.getLastError()}). Nada foi apagado nem sobrescrito. Novos registros ficam só na memória desta página.`;
    if (status === "unsupported") return `A base salva neste navegador tem uma versão desconhecida (${store.getLastError()}). Nada foi apagado nem sobrescrito. Novos registros ficam só na memória desta página.`;
    if (status === "unavailable") return "O armazenamento do navegador está indisponível (bloqueado ou modo privado). Os registros ficam só na memória desta página.";
    if (store.getConflicts().length > 0) return `Há ${store.getConflicts().length} registro(s) em conflito (mesmo ID com conteúdo diferente entre esta janela e o armazenamento). Prevaleceu o armazenamento; baixe o conteúdo em conflito antes de continuar.`;
    if (store.unsavedCount() > 0 && store.getLastOutcome() === "incerto") return `GRAVAÇÃO NÃO CONFIRMADA: ${store.unsavedCount()} registro(s) estão na memória desta página e não se sabe se chegaram ao armazenamento${store.getLastError() ? ` (${store.getLastError()})` : ""}.`;
    if (store.unsavedCount() > 0) return `NÃO FOI SALVO neste computador: ${store.unsavedCount()} registro(s) estão apenas na memória desta página${store.getLastError() ? ` (${store.getLastError()})` : ""}.`;
    return "";
  }

  // ---------- modo coleta ----------

  function setAssessmentToday() {
    const today = Dados.localDay(new Date());
    if (assessmentDate.value === today) return;
    internalChange = true;
    assessmentDate.value = today;
    assessmentDate.dispatchEvent(new Event("change", { bubbles: true })); // atualiza a data máxima do nascimento em script.js
    internalChange = false;
  }

  function applyPrivacyTexts() {
    if (!collectMode) return;
    privacyBadge.querySelector("strong").textContent = "Seus dados só são guardados se você registrar";
    if (syncConfiguredNow()) {
      privacyBadge.querySelector("small").textContent = "Calcular não grava nem envia nada. A participação é voluntária; os dados ficam neste computador e, se o envio estiver ativo, também podem ir à planilha do responsável.";
      formPrivacy.innerHTML = '<span aria-hidden="true">◉</span> Modo coleta ativo: calcular não envia nada. Só se você escolher registrar a participação, sexo, idade em meses, peso, altura e IMC são guardados neste computador, sem nome nem data de nascimento; com o envio opcional ativo, esse registro também poderá seguir pela internet para a planilha privada do responsável.';
    } else {
      privacyBadge.querySelector("small").textContent = "Calcular não grava nada. A participação é voluntária e os dados ficam neste computador.";
      formPrivacy.innerHTML = '<span aria-hidden="true">◉</span> Modo coleta ativo: nada é enviado pela internet. Só se você escolher registrar a participação, sexo, idade em meses, peso, altura e IMC são guardados neste computador, sem nome nem data de nascimento.';
    }
  }

  function applyCollectMode() {
    if (collectMode) {
      setAssessmentToday();
      assessmentDate.readOnly = true;
      assessmentDate.title = "No modo coleta, a data da avaliação é a data de hoje neste computador.";
      applyPrivacyTexts();
      if (publisher) publisher.start();
    } else {
      if (sync) sync.deactivate(); // novos envios param e a chave é esquecida; fila e registros permanecem
      if (publisher) publisher.stop();
      assessmentDate.readOnly = false;
      assessmentDate.removeAttribute("title");
      privacyBadge.querySelector("strong").textContent = originalTexts.badgeStrong;
      privacyBadge.querySelector("small").textContent = originalTexts.badgeSmall;
      formPrivacy.innerHTML = originalTexts.formPrivacy;
      controller.invalidate();
    }
    render();
  }

  function setCollectMode(enabled) {
    collectMode = enabled;
    const remembered = config.write({ collectMode: enabled });
    applyCollectMode();
    say(enabled
      ? (remembered ? "Modo coleta ativado." : "Modo coleta ativado, mas este navegador não permitiu lembrar a escolha após recarregar a página.")
      : "Modo coleta desligado. Os registros da pesquisa e a fila de envio continuam guardados. Novos envios foram interrompidos e a chave de coleta foi esquecida; um envio que já tivesse começado não pode ser cancelado: ele termina e o resultado é registrado na fila.");
  }

  // ---------- desenho da tela ----------

  function render() {
    const total = store.count();
    const unsaved = store.unsavedCount();
    const problem = problemText();
    const state = controller.state();

    // barra de status
    $("coletaBar").hidden = !collectMode;
    const sv = syncView();
    const envioBar = sv && sv.configured ? ` · ${sv.counts.confirmado} salvo(s) na planilha, ${sv.counts.total - sv.counts.confirmado} sem confirmação${sv.paused ? " · envio pausado" : ""}` : "";
    $("coletaBarTexto").textContent = `Modo coleta ativo · pesquisa ${surveyId} · ${total} registro(s) neste computador${envioBar}${problem ? " · ATENÇÃO: veja a Área do operador" : ""}`;

    // área do operador
    $("coletaToggle").textContent = collectMode ? "Desativar modo coleta" : "Ativar modo coleta";
    $("coletaToggleEstado").textContent = collectMode ? "Modo coleta ativo" : "Modo coleta desligado";
    $("operadorResumo").textContent = `Pesquisa ${surveyId}: ${total} registro(s) neste computador${unsaved ? `, ${unsaved} somente na memória` : ""}.`;
    $("operadorAlerta").hidden = !problem;
    $("operadorAlertaTexto").textContent = problem;
    const blocked = store.hasPreservedRaw();
    const canRetry = unsaved > 0 && ["ok", "empty", "unavailable"].includes(store.getStatus());
    $("tentarSalvarButton").hidden = !canRetry;
    $("alertaTentarButton").hidden = !canRetry;
    $("conflitosButton").hidden = store.getConflicts().length === 0;
    $("baseBrutaButton").hidden = !blocked;
    $("quarentenaButton").hidden = !blocked;

    // caixa de participação no resultado
    const box = $("participacaoBox");
    const visible = collectMode && state.hasCandidate && !resultSection.hidden;
    box.hidden = !visible;
    if (visible) {
      $("participacaoAviso").textContent = aviso();
      const button = $("registrarButton");
      const status = $("participacaoStatus");
      const alert = $("participacaoAlerta");
      button.disabled = state.registered;
      button.textContent = state.registered ? "Participação registrada ✓" : "Registrar minha participação";
      if (!state.registered) {
        status.textContent = "";
        status.classList.remove("is-warning");
      } else if (store.isSaved(state.recordId)) {
        const d = syncConfiguredNow() ? sync.describe(state.recordId) : null;
        status.textContent = d ? `Salvo neste computador. ${d.label}.` : "Salvo neste computador.";
        status.classList.toggle("is-warning", Boolean(d && d.warning));
      } else {
        status.textContent = store.getLastOutcome() === "incerto"
          ? "Gravação NÃO CONFIRMADA: registro mantido na memória desta página."
          : "Registro mantido apenas na memória desta página.";
        status.classList.add("is-warning");
      }
      alert.hidden = !problem;
      $("participacaoAlertaTexto").textContent = `${problem} Baixe o backup agora e não feche nem recarregue esta página.`;
    }
    applyPrivacyTexts();
    renderEnvio();
    if (publisher) publisher.notify();
    if (painel) painel.update(); // painel agregado: só redesenha se o modelo mudou e nunca move o foco
  }

  function invalidate() {
    controller.invalidate();
    render();
  }

  // ---------- eventos da calculadora ----------

  document.addEventListener("imc:calculo", (event) => {
    if (!collectMode) return;
    controller.calculated(event.detail);
    render();
  });
  document.addEventListener("imc:invalidar", invalidate);

  // Antes de calcular (fase de captura, antes do tratador de script.js): data de hoje.
  form.addEventListener("submit", () => { if (collectMode) setAssessmentToday(); }, true);

  // Qualquer edição de campo invalida o candidato.
  ["input", "change"].forEach((type) => form.addEventListener(type, () => { if (!internalChange) invalidate(); }));

  $("registrarButton").addEventListener("click", () => {
    if (!collectMode) return;
    const result = controller.register();
    if (sync) sync.refresh(); // o registro entra na fila (gravada antes de qualquer envio)
    if (result.status === "data-mudou") {
      setAssessmentToday();
      resultSection.hidden = true;
      const error = $("globalError");
      error.textContent = "A data mudou desde o cálculo. Calcule novamente antes de registrar.";
      error.hidden = false;
      error.focus();
    } else if (result.status === "erro") {
      $("participacaoStatus").textContent = `Não foi possível registrar: ${result.error}`;
      $("participacaoStatus").classList.add("is-warning");
    }
    render();
  });

  $("alertaBackupButton").addEventListener("click", () => $("baixarBackupButton").click());

  // ---------- operador ----------

  $("coletaToggle").addEventListener("click", () => setCollectMode(!collectMode));

  $("baixarBackupButton").addEventListener("click", () => {
    const withSync = sync && sync.snapshot().configured;
    const text = Dados.backupToJson(store.getRecords(), { surveyId, sync: withSync ? { states: sync.exportStates() } : undefined });
    download(`imc-backup-${surveyId}-${stamp()}.json`, text, "application/json");
    say(`Backup com ${store.count()} registro(s) gerado${withSync ? " (com os estados de envio apenas como informação: ao importar, todos são reavaliados)" : ""}. Guarde o arquivo em local seguro. Ele não contém chaves nem o endereço do serviço.`);
  });

  $("baixarCsvButton").addEventListener("click", () => {
    download(`imc-pesquisa-${surveyId}-${stamp()}.csv`, Dados.toCsv(store.getRecords()), "text/csv;charset=utf-8");
    say(`CSV com ${store.count()} registro(s) gerado.`);
  });

  $("baseBrutaButton").addEventListener("click", () => {
    download(`imc-base-ilegivel-${surveyId}-${stamp()}.txt`, store.getPreservedRaw() || "", "text/plain;charset=utf-8");
    say("Texto bruto da base ilegível baixado. Nada foi alterado no navegador.");
  });

  $("quarentenaButton").addEventListener("click", () => {
    const result = store.quarantineAndReset();
    say(Mensagens.quarantine(result));
    render();
  });

  function clearPreview() {
    pendingPreview = null;
    $("importarPrevia").hidden = true;
    $("importarErros").textContent = "";
    $("importarArquivo").value = "";
  }

  $("importarArquivo").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const list = $("importarErros");
    list.textContent = "";
    pendingPreview = null;
    let text = "";
    if (file.size > Dados.LIMITS.maxImportChars * 3) {
      text = null;
    } else {
      try { text = await file.text(); } catch (_) { text = null; }
    }
    const preview = text === null
      ? { ok: false, errors: ["Arquivo grande demais ou ilegível."], counts: null, toAdd: [] }
      : store.previewImport(text);
    $("importarPrevia").hidden = false;
    const apply = $("importarAplicar");
    if (preview.ok) {
      $("importarResumo").textContent = `Arquivo válido: ${preview.counts.total} registro(s); ${preview.counts.new} novo(s), ${preview.counts.identical} já existente(s) idêntico(s) (ignorados).`;
      apply.hidden = preview.counts.new === 0;
      if (preview.counts.new === 0) $("importarResumo").textContent += " Nada a importar.";
      if (preview.claimedConfirmed) $("importarResumo").textContent += ` O arquivo indica ${preview.claimedConfirmed} registro(s) como já enviados à planilha; isso NÃO é verificado e será ignorado: os registros importados entram como aguardando envio (o reenvio é seguro) ou, se você usar "Conferir com a planilha", são comparados com ela.`;
      pendingPreview = preview;
    } else {
      $("importarResumo").textContent = "Importação recusada. Nada foi alterado.";
      apply.hidden = true;
      preview.errors.slice(0, 20).forEach((message) => {
        const item = document.createElement("li");
        item.textContent = message;
        list.appendChild(item);
      });
    }
  });

  $("importarAplicar").addEventListener("click", () => {
    if (!pendingPreview) return;
    const result = store.applyImport(pendingPreview);
    say(Mensagens.importResult(result));
    if (sync) sync.refresh();
    clearPreview();
    render();
  });
  $("importarCancelar").addEventListener("click", () => { clearPreview(); say("Importação cancelada. Nada foi alterado."); });

  function closeDelete() {
    $("excluirConfirmacao").hidden = true;
    $("excluirDigitar").value = "";
    $("excluirConfirmar").disabled = true;
  }

  $("excluirIniciar").addEventListener("click", () => {
    const sv = sync ? sync.snapshot() : null;
    const naPlanilha = sv && sv.configured
      ? ` ATENÇÃO: excluir aqui NÃO apaga nenhuma linha da planilha do Google${sv.counts.confirmado ? `: os ${sv.counts.confirmado} registro(s) já confirmados continuam lá e só o responsável pela planilha pode removê-los` : ""}.${sv.counts.total - sv.counts.confirmado ? ` ${sv.counts.total - sv.counts.confirmado} registro(s) ainda sem confirmação na planilha deixarão de existir aqui e NÃO serão enviados.` : ""}`
      : "";
    $("excluirResumo").textContent = `Serão excluídos ${store.count()} registro(s) da pesquisa ${surveyId} deste computador${store.unsavedCount() ? ` (${store.unsavedCount()} deles só estão na memória desta página e também serão perdidos)` : ""}. Baixe um backup antes. A exclusão não pode ser desfeita.${naPlanilha}`;
    $("excluirSurveyId").textContent = surveyId;
    $("excluirConfirmacao").hidden = false;
    $("excluirDigitar").focus();
  });
  $("excluirDigitar").addEventListener("input", () => { $("excluirConfirmar").disabled = $("excluirDigitar").value !== surveyId; });
  $("excluirCancelar").addEventListener("click", () => { closeDelete(); say("Exclusão cancelada. Nada foi alterado."); });
  $("excluirConfirmar").addEventListener("click", () => {
    const result = store.deleteSurvey($("excluirDigitar").value);
    say(Mensagens.deleteResult(result));
    closeDelete();
    if (result.ok) {
      controller.invalidate();
      if (sync) sync.onSurveyDeleted(); // a fila antiga não pode recriar nada; linhas já enviadas ao Google não são afetadas
    }
    render();
  });

  $("abrirPainelButton").addEventListener("click", () => {
    const url = `${root.location.href.split("#")[0]}#painel`;
    if (!root.open(url, "painelPesquisa")) say("O navegador bloqueou a nova janela. Use \"Ver painel nesta janela\" ou permita pop-ups para este endereço.");
  });

  // ---------- recuperação e outras janelas ----------

  function retry() {
    const result = store.retrySave();
    say(Mensagens.save(result));
    dropStaleCandidate();
    if (sync) sync.refresh();
    render();
  }
  $("tentarSalvarButton").addEventListener("click", retry);
  $("alertaTentarButton").addEventListener("click", retry);

  $("conflitosButton").addEventListener("click", () => {
    download(`imc-conflitos-${surveyId}-${stamp()}.json`, store.conflictReport(), "application/json");
    say(`Relatório com ${store.getConflicts().length} conflito(s) gerado (versão desta janela e versão do armazenamento).`);
  });

  // Candidato já registrado cujo registro deixou de existir (exclusão em outra janela) deixa de valer.
  function dropStaleCandidate() {
    const state = controller.state();
    if (state.registered && !store.has(state.recordId)) controller.invalidate();
  }

  // O evento "storage" só dispara em OUTRAS janelas da mesma origem.
  root.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== store.key) {
      // fila, destino ou licença alterados por outra janela (a operadora): só relê para exibir
      if (sync && syncStore && [syncStore.queueKey, syncStore.configKey, syncStore.leaseKey].includes(event.key)) { sync.refresh(); render(); }
      return;
    }
    const summary = store.reconcile();
    dropStaleCandidate();
    if (sync) sync.refresh();
    const text = Mensagens.reconcile(summary)
      || (["corrupt", "unsupported", "unavailable"].includes(store.getStatus())
        ? "A base foi alterada em outra janela e agora não pode ser lida; veja o alerta acima. Nada foi apagado."
        : "");
    if (text) say(text);
    render();
  });

  // ---------- envio à planilha (opcional) ----------

  const REASON_TEXT = {
    "sem-chave": "Digite a chave de coleta.",
    "sem-destino": "Informe um endereço de serviço válido.",
    "outra-janela-opera": "Outra janela deste navegador já é a operadora do envio. Use aquela janela, ou feche-a e aguarde cerca de 45 segundos.",
    "licenca-indisponivel": "Não foi possível reservar o papel de operador do envio neste navegador.",
    "fila-indisponivel": "A fila de envio deste navegador está ilegível ou indisponível; veja o alerta. A coleta local continua.",
    "base-local-indisponivel": "A base local não está legível; o envio fica bloqueado para não enviar dados incertos.",
    "nao-operador": "Esta janela não é a operadora do envio.",
    pausado: "O envio está pausado. Use \"Retomar envio\".",
    bloqueado: "O envio está bloqueado por um problema; veja o alerta e use \"Retomar envio\" depois de corrigir a causa."
  };

  function attemptText(r) {
    switch (r.status) {
      case "concluido": return `Tentativa concluída: ${r.confirmed} confirmado(s), ${r.failed} sem confirmação, ${r.attention} com conflito ou rejeição.`;
      case "falha": return "A tentativa não foi confirmada (será repetida com intervalo crescente; o diagnóstico mostra o motivo).";
      case "bloqueado": return "O servidor recusou o envio por um motivo que não melhora sozinho; veja o alerta.";
      case "pausado-por-falhas": case "pausado-por-resposta": return "Envio pausado depois de várias falhas; veja o alerta.";
      case "nada-a-enviar": return "Não há registros elegíveis para enviar agora.";
      case "ocupado": return "Já existe um envio em andamento; aguarde.";
      case "muito-rapido": return "Aguarde um instante antes de tentar de novo.";
      case "fila-nao-salva": return "Nada foi enviado: a fila não pôde ser gravada neste navegador.";
      case "ignorado": return "O resultado de um envio antigo foi ignorado porque o destino ou a pesquisa local mudou: ele não confirma nada no destino atual.";
      default: return REASON_TEXT[r.status] || `Não foi possível enviar agora (${r.status}).`;
    }
  }

  let urlPrefilled = false;
  let lastEnvioSignature = "";

  function renderEnvio() {
    const alertBox = $("envioAlerta");
    if (!sync) {
      $("envioResumo").textContent = "O envio à planilha não está disponível nesta versão da página.";
      ["envioAtivar", "envioAgora", "envioPausar", "envioRetomar", "envioIntervencao", "envioDesativar", "envioRemoverDestino"].forEach((id) => { $(id).hidden = true; });
      return;
    }
    const s = sync.snapshot();
    const c = s.counts;
    if (!urlPrefilled && sync.getEndpoint()) { $("envioUrl").value = sync.getEndpoint(); urlPrefilled = true; }

    $("envioAtivar").hidden = s.active;
    $("envioAgora").hidden = !s.active;
    $("envioPausar").hidden = !(s.active && !s.paused);
    $("envioRetomar").hidden = !(s.paused || s.blocked);
    $("envioIntervencao").hidden = c.intervencao === 0;
    $("envioDesativar").hidden = !(s.active || s.hasKey);
    $("envioRemoverDestino").hidden = !s.hasEndpoint;

    let resumo;
    if (!s.configured) {
      resumo = `Envio não configurado: os ${c.total} registro(s) ficam apenas neste computador.`;
    } else {
      const estado = s.paused ? "Envio PAUSADO." : s.blocked ? "Envio BLOQUEADO (veja o alerta)." : s.active ? "Envio ativo nesta janela." : s.otherOperator ? "Outra janela deste navegador é a operadora do envio." : "Envio inativo: digite a chave de coleta e ative.";
      const proxima = s.nextAttemptAt ? ` Próxima tentativa automática em cerca de ${Math.max(1, Math.round((s.nextAttemptAt - Date.now()) / 1000))} s.` : "";
      resumo = `${estado} ${c.confirmado} salvo(s) na planilha · ${c.pendente + c.enviando} aguardando envio · ${c.falha} com envio não confirmado · ${c.intervencao} com conflito ou rejeição · ${c.local} só neste computador.${proxima}`;
    }
    if (resumo !== $("envioResumo").textContent) $("envioResumo").textContent = resumo;

    const alerts = [];
    if (s.queueStatus === "corrupt") alerts.push(`A fila de envio gravada neste navegador está ilegível (${s.queueError}). Nada foi apagado; novos envios estão bloqueados e a coleta local continua.`);
    else if (s.queueStatus === "unavailable") alerts.push("O armazenamento da fila de envio está indisponível; nada é enviado. A coleta local continua.");
    if (s.blocked) alerts.push(s.blocked.text);
    if (s.configured && !s.durable) alerts.push(`Este navegador não conseguiu gravar o estado de envio (${s.persistError || "erro"}). Confirmações valem só nesta sessão; depois de recarregar, os itens serão reenviados e confirmados de novo, sem duplicar.`);
    alertBox.hidden = alerts.length === 0;
    $("envioAlertaTexto").textContent = alerts.join(" ");
    $("filaQuarentenaButton").hidden = s.queueStatus !== "corrupt";

    const signature = JSON.stringify(sync.diagnostics());
    if (signature !== lastEnvioSignature) {
      lastEnvioSignature = signature;
      const list = $("envioDiagLista");
      list.textContent = "";
      sync.diagnostics().slice(-10).reverse().forEach((d) => {
        const item = document.createElement("li");
        item.textContent = `${new Date(d.at).toLocaleTimeString("pt-BR")} · ${d.event}${d.category ? ` · ${d.category}` : ""}${d.code ? ` · ${d.code}` : ""}${d.reason ? ` · ${d.reason}` : ""}${d.batch ? ` · lote ${d.batch}` : ""}${d.confirmed !== undefined ? ` · ${d.confirmed} confirmado(s)` : ""}${d.durationMs !== undefined ? ` · ${d.durationMs} ms` : ""}`;
        list.appendChild(item);
      });
    }
  }

  if (sync) {
    sync.onChange(() => render());
    root.setInterval(renderEnvio, 5000);                       // contagem regressiva
    root.addEventListener("online", () => { sync.kick(); });   // "online" só antecipa uma tentativa real; não prova disponibilidade
    root.addEventListener("pagehide", () => { sync.deactivate(); }); // solta o papel de operador (e esquece a chave) ao fechar ou recarregar

    $("envioAtivar").addEventListener("click", async () => {
      if (!collectMode) { say("Ative o modo coleta antes de ativar o envio."); return; }
      const configured = await sync.configure($("envioUrl").value); // o destino é validado ANTES de a chave ser usada
      if (!configured.ok) { $("envioChave").value = ""; say(`Endereço não aceito: ${configured.error}`); render(); return; }
      const key = $("envioChave").value;
      $("envioChave").value = ""; // o campo é limpo sempre; a chave fica só em memória
      const accepted = sync.setKey(key);
      if (!accepted.ok) { say(accepted.error); render(); return; }
      const result = sync.activate();
      if (!result.ok) { sync.clearKey(); say(REASON_TEXT[result.reason] || `Não foi possível ativar o envio (${result.reason}).`); }
      else say("Envio ativado nesta janela. Os registros continuam sendo salvos primeiro neste computador; a chave fica só na memória desta página.");
      render();
    });
    $("envioAgora").addEventListener("click", async () => { say(attemptText(await sync.sendNow())); render(); });
    $("envioPausar").addEventListener("click", () => { const r = sync.pause(); say(`Envio pausado. ${r.note || ""}`.trim()); render(); });
    $("envioRetomar").addEventListener("click", () => {
      sync.resume();
      say(sync.snapshot().active ? "Envio retomado." : "Pausa e bloqueio removidos. Digite a chave de coleta e ative o envio nesta janela.");
      render();
    });
    $("envioIntervencao").addEventListener("click", () => { const r = sync.retryAttention(); say(`${r.count} registro(s) voltaram à fila para novo envio. Se o problema (por exemplo, um conflito) continuar, eles voltarão a exigir intervenção.`); render(); });
    $("envioDesativar").addEventListener("click", () => { sync.deactivate(); say("Envio interrompido nesta janela e chave esquecida. Registros e fila foram mantidos."); render(); });
    $("envioRemoverDestino").addEventListener("click", () => { sync.removeDestination(); $("envioUrl").value = ""; urlPrefilled = true; say("Endereço do serviço removido. Os registros continuam salvos neste computador; nenhum estado de envio é mais afirmado."); render(); });
    $("filaQuarentenaButton").addEventListener("click", () => {
      const r = sync.quarantineQueue();
      say(r.ok ? "A fila ilegível foi preservada em uma área de segurança e uma fila nova será criada. Reenviar é seguro: o servidor reconhece registros repetidos." : `Não foi possível: ${r.error}`);
      render();
    });

    // conferência / restauração (chave de leitura separada, descartada ao terminar)
    let reconciliation = null;
    const closeReconciliation = () => { reconciliation = null; $("conciliarPrevia").hidden = true; $("conciliarRelatorio").hidden = true; };
    const RECON_FAIL = {
      "chave-leitura-invalida": "A chave de leitura não é válida.",
      "chaves-iguais": "A chave de leitura deve ser diferente da chave de coleta.",
      "sem-destino": "Configure o endereço do serviço antes (ative o envio uma vez).",
      "sem-verificacao": "Este contexto não oferece SHA-256 (use https ou localhost).",
      integridade: "A planilha está com linhas inválidas ou IDs repetidos: a conferência foi recusada. O responsável precisa reparar a base.",
      "registros-invalidos": "A planilha devolveu registros inválidos ou repetidos: nada foi usado.",
      "digest-diferente": "A conferência dos IDs não bateu com o resumo do servidor: nada foi usado.",
      "contagem-diferente": "A quantidade recebida não bate com o resumo: nada foi usado.",
      "destino-mudou": "O endereço do serviço mudou durante a leitura: a prévia foi descartada. Refaça a conferência."
    };
    $("conciliarIniciar").addEventListener("click", async () => {
      closeReconciliation();
      const key = $("envioChaveLeitura").value;
      $("envioChaveLeitura").value = "";
      say("Lendo a planilha…");
      const prepared = await sync.prepareReconciliation(key);
      if (!prepared.ok) { say(`Conferência NÃO concluída (nenhuma restauração parcial foi usada): ${RECON_FAIL[prepared.reason] || prepared.error || prepared.reason}${prepared.transport ? ` [${prepared.transport.code}]` : ""}`); return; }
      reconciliation = prepared;
      const c = prepared.counts;
      $("conciliarResumo").textContent = `A planilha tem ${c.remote} registro(s) válidos: ${c.new} novo(s) para trazer para este computador; ${c.identical} idêntico(s) aos daqui (serão marcados como salvos na planilha); ${c.differing} com o mesmo ID e conteúdo DIFERENTE (ficam para revisão, sem sobrescrever); ${c.localOnly} registro(s) daqui ainda não estão na planilha (continuam aguardando envio)${c.staleConfirmed ? `; ${c.staleConfirmed} deles estavam marcados como salvos na planilha, mas NÃO estão lá: a marca será desfeita e eles voltarão a ser enviados` : ""}.`;
      $("conciliarPrevia").hidden = false;
      $("conciliarRelatorio").hidden = c.differing === 0;
      say("Prévia pronta. Nada foi alterado até você aplicar.");
    });
    $("conciliarAplicar").addEventListener("click", () => {
      if (!reconciliation) return;
      const r = sync.applyReconciliation(reconciliation);
      if (!r.ok && (r.reason === "previa-desatualizada" || r.reason === "previa-desconhecida")) {
        closeReconciliation();
        say("Prévia descartada: o endereço do serviço (ou a configuração) mudou depois de ela ser preparada. Nada foi importado nem confirmado. Faça a conferência de novo com o destino atual.");
        render();
        return;
      }
      if (r.ok && r.differing > 0) reconciliation.report = r.report; // relatório recalculado com a base atual
      say(r.ok ? `Aplicado${r.changedSincePreview ? " (a base local mudou desde a prévia; valem os números abaixo, recalculados agora)" : ""}: ${r.added} registro(s) trazido(s); ${r.confirmed} marcado(s) como salvos na planilha; ${r.differing} para revisão${r.skippedDeleted ? `; ${r.skippedDeleted} excluído(s) localmente depois da prévia não foram trazidos de volta` : ""}${r.reopened ? `; ${r.reopened} marca(s) de “salvo na planilha” desfeita(s) (não estavam na planilha)` : ""}${r.durable ? "" : " (o estado não pôde ser gravado neste navegador)"}.` : r.reason === "nao-operador" ? "Não aplicado: esta janela precisa ser a operadora do envio. Ative o envio aqui (com a chave de coleta) e aplique de novo; se outra janela já opera, use aquela." : `Não aplicado: ${r.reason}${r.error ? ` (${r.error})` : ""}.`);
      if (r.ok && r.differing === 0) closeReconciliation();
      render();
    });
    $("conciliarRelatorio").addEventListener("click", () => { if (reconciliation) download(`imc-divergencias-${surveyId}-${stamp()}.json`, reconciliation.report, "application/json"); });
    $("conciliarCancelar").addEventListener("click", () => { closeReconciliation(); say("Conferência cancelada. Nada foi alterado."); });
  } else {
    renderEnvio();
  }

  applyCollectMode();
})(typeof globalThis !== "undefined" ? globalThis : this);
