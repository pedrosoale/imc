/*
 * Pesquisa educativa — candidato a registro.
 *
 * Um cálculo válido cria um "candidato" com ID. O registro é sempre montado a partir do
 * instantâneo guardado no candidato, nunca relendo o formulário.
 * Regras:
 *  - recalcular com os mesmos dados mantém o candidato (e o ID);
 *  - editar campos, limpar ou iniciar nova avaliação o invalida;
 *  - depois de registrado, o mesmo candidato não pode ser registrado de novo;
 *  - se o dia local mudou desde o cálculo, é preciso calcular novamente.
 * O candidato vive só em memória: recarregar a página o descarta.
 * Isto não identifica pessoas nem impede que alguém retorne à atividade.
 */
(function (root) {
  "use strict";

  const Dados = (typeof module === "object" && module.exports) ? require("./pesquisa-dados.js") : root.PesquisaDados;

  function createController(options) {
    const store = options.store;
    const surveyId = options.surveyId || Dados.DEFAULT_SURVEY_ID;
    const now = options.now || (() => new Date());
    const randomBytes = options.randomBytes;

    let candidate = null; // { id, snapshot, registered, saved }

    function view() {
      if (!candidate) return { hasCandidate: false, registered: false, saved: false };
      return { hasCandidate: true, registered: candidate.registered, saved: candidate.saved, recordId: candidate.id };
    }

    return {
      /** Chamado após cada cálculo válido. Devolve o estado do candidato. */
      calculated(snapshot) {
        const errors = Dados.validateSnapshot(snapshot);
        if (errors.length) { candidate = null; return { ...view(), error: errors[0] }; }
        if (candidate && Dados.snapshotsEqual(candidate.snapshot, snapshot)) return view();
        candidate = {
          id: Dados.createRecordId(randomBytes),
          snapshot: { ...snapshot },
          registered: false,
          saved: false
        };
        return view();
      },

      /** Edição de campo, limpar, nova avaliação ou cálculo inválido. */
      invalidate() {
        candidate = null;
        return view();
      },

      state: view,

      /** Registra o candidato atual. Seguro contra cliques repetidos. */
      register() {
        if (!candidate) return { status: "sem-candidato" };
        if (candidate.registered) return { status: "ja-registrado", saved: store.isSaved(candidate.id) };
        if (Dados.localDay(now()) !== candidate.snapshot.assessmentDay) {
          candidate = null;
          return { status: "data-mudou" };
        }
        let record;
        try {
          record = Dados.buildRecord(candidate.snapshot, { surveyId, now, recordId: candidate.id });
        } catch (error) {
          return { status: "erro", error: error.message };
        }
        const result = store.addRecord(record);
        if (!result.ok) return { status: "erro", error: result.error };
        candidate.registered = true;
        candidate.saved = result.saved;
        return result.saved
          ? { status: "salvo", recordId: candidate.id }
          : { status: "memoria", recordId: candidate.id, outcome: result.outcome, error: result.error };
      }
    };
  }

  const api = { createController };
  root.PesquisaCandidato = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
