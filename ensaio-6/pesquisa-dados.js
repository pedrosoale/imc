/*
 * Pesquisa educativa — esquema, validação, backup JSON e CSV.
 *
 * Módulo puro: não acessa armazenamento, rede nem DOM.
 *
 * Privacidade: o registro é montado por LISTA EXPLÍCITA de campos a partir de um
 * instantâneo do cálculo. Nome e data de nascimento não existem neste módulo,
 * exceto na lista de nomes proibidos usada para rejeitar arquivos importados.
 * Registros sem nome NÃO são anônimos: combinam data/hora, idade, sexo, peso e altura.
 */
(function (root) {
  "use strict";

  const APP_VERSION = "3.0.0-sincronizacao";
  const BACKUP_FORMAT = "imc-pesquisa-backup";
  const BACKUP_VERSION = 1;          // formato sem bloco de sincronização (continua aceito na importação)
  const BACKUP_VERSION_SYNC = 2;     // acrescenta o bloco informativo "sync" (nunca é prova de envio)
  const SYNC_STATES = ["local", "pendente", "enviando", "confirmado", "falha", "intervencao"];
  const CALC_VERSION = 1;
  const DEFAULT_SURVEY_ID = "feira-2026";

  const LIMITS = {
    maxImportChars: 2_000_000,
    maxImportRecords: 20_000,
    ageMonths: [60, 1560],
    weightKg: [10, 300],
    heightM: [0.8, 2.3],
    bmi: [7, 100]
  };

  const DATA_KEYS = ["recordId", "surveyId", "collectedAt", "ageMonths", "sex", "weightKg", "heightM"];
  const DERIVED_KEYS = ["bmi", "calcVersion"];
  const BACKUP_KEYS = ["format", "formatVersion", "appVersion", "surveyId", "exportedAt", "recordCount", "records"];
  const BACKUP_KEYS_SYNC = BACKUP_KEYS.concat(["sync"]);
  const IDENTIFYING = /nome|name|nasc|birth|cpf|rg\b|e-?mail|telefone|phone|endereco|address|responsavel|mae|pai/i;

  // Identificadores que colidiriam com chaves de configuração do armazenamento (prefixo + id).
  const RESERVED_SURVEY_IDS = ["config", "sync-config"];
  const RECORD_ID = /^r_[0-9a-f]{32}$/;
  const SURVEY_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
  const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function inRange(value, [min, max]) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  }

  function pad(value, size) {
    return String(value).padStart(size || 2, "0");
  }

  function localDay(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function toIsoWithOffset(date) {
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const abs = Math.abs(offset);
    return `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }

  function randomHex(randomBytes, bytes) {
    const buffer = randomBytes(bytes);
    if (!buffer || buffer.length !== bytes) throw new Error("Gerador aleatório indisponível.");
    return Array.from(buffer, (b) => pad((b & 0xff).toString(16), 2)).join("");
  }

  function defaultRandomBytes(size) {
    const cryptoApi = root.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") throw new Error("Gerador aleatório indisponível.");
    return cryptoApi.getRandomValues(new Uint8Array(size));
  }

  function createRecordId(randomBytes) {
    return `r_${randomHex(randomBytes || defaultRandomBytes, 16)}`;
  }

  // Mesma expressão de IMCCalculator.calculateBmi, para os valores guardados serem recalculáveis.
  function bmiOf(weightKg, heightM) {
    return weightKg / (heightM * heightM);
  }

  function validateSnapshot(snapshot) {
    const errors = [];
    if (!isPlainObject(snapshot)) return ["Instantâneo inválido."];
    const allowed = ["sex", "ageMonths", "weightKg", "heightM", "bmi", "assessmentDay"];
    Object.keys(snapshot).forEach((key) => { if (!allowed.includes(key)) errors.push(`Campo não permitido no instantâneo: ${key}`); });
    if (snapshot.sex !== "male" && snapshot.sex !== "female") errors.push("sex inválido");
    if (!Number.isInteger(snapshot.ageMonths) || !inRange(snapshot.ageMonths, LIMITS.ageMonths)) errors.push("ageMonths inválido");
    if (!inRange(snapshot.weightKg, LIMITS.weightKg)) errors.push("weightKg inválido");
    if (!inRange(snapshot.heightM, LIMITS.heightM)) errors.push("heightM inválido");
    if (!inRange(snapshot.bmi, LIMITS.bmi)) errors.push("bmi inválido");
    else if (snapshot.bmi !== bmiOf(snapshot.weightKg, snapshot.heightM)) errors.push("bmi não corresponde a peso e altura");
    if (typeof snapshot.assessmentDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.assessmentDay)) errors.push("assessmentDay inválido");
    return errors;
  }

  function snapshotsEqual(a, b) {
    return ["sex", "ageMonths", "weightKg", "heightM", "bmi", "assessmentDay"].every((key) => a[key] === b[key]);
  }

  /** Cria o registro persistível a partir de um instantâneo validado. Valores não são arredondados. */
  function buildRecord(snapshot, options) {
    const errors = validateSnapshot(snapshot);
    if (errors.length) throw new Error(errors.join("; "));
    const surveyId = (options && options.surveyId) || DEFAULT_SURVEY_ID;
    const now = (options && options.now) ? options.now() : new Date();
    const recordId = (options && options.recordId) || createRecordId(options && options.randomBytes);
    const record = {
      data: {
        recordId,
        surveyId,
        collectedAt: toIsoWithOffset(now),
        ageMonths: snapshot.ageMonths,
        sex: snapshot.sex,
        weightKg: snapshot.weightKg,
        heightM: snapshot.heightM
      },
      derived: {
        bmi: bmiOf(snapshot.weightKg, snapshot.heightM),
        calcVersion: CALC_VERSION
      }
    };
    const problems = validateRecord(record);
    if (problems.length) throw new Error(problems.join("; "));
    return record;
  }

  function exactKeys(object, keys, label, errors) {
    if (!isPlainObject(object)) { errors.push(`${label} deve ser um objeto.`); return false; }
    Object.keys(object).forEach((key) => {
      if (!keys.includes(key)) {
        errors.push(IDENTIFYING.test(key)
          ? `${label}: campo de identificação não permitido (${key}).`
          : `${label}: campo desconhecido (${key}).`);
      }
    });
    keys.forEach((key) => { if (!(key in object)) errors.push(`${label}: campo ausente (${key}).`); });
    return true;
  }

  /**
   * Validação estrita de um registro { data, derived [, local] }.
   * `local`, quando permitido, só aceita o estado "local": nenhum estado de sincronização é aceito.
   */
  function validateRecord(record, options) {
    const errors = [];
    const allowLocal = Boolean(options && options.allowLocal);
    if (!isPlainObject(record)) return ["Registro deve ser um objeto."];
    const topKeys = allowLocal ? ["data", "derived", "local"] : ["data", "derived"];
    Object.keys(record).forEach((key) => {
      if (!topKeys.includes(key)) errors.push(IDENTIFYING.test(key) ? `Registro: campo de identificação não permitido (${key}).` : `Registro: campo desconhecido (${key}).`);
    });
    const { data, derived } = record;
    const dataOk = exactKeys(data, DATA_KEYS, "data", errors);
    const derivedOk = exactKeys(derived, DERIVED_KEYS, "derived", errors);
    if (allowLocal) {
      if (!isPlainObject(record.local) || Object.keys(record.local).length !== 1 || record.local.status !== "local") {
        errors.push("local: estado não aceito (somente \"local\").");
      }
    }
    if (dataOk) {
      if (typeof data.recordId !== "string" || !RECORD_ID.test(data.recordId)) errors.push("data.recordId inválido.");
      if (typeof data.surveyId !== "string" || !SURVEY_ID.test(data.surveyId)) errors.push("data.surveyId inválido.");
      if (typeof data.collectedAt !== "string" || !ISO_DATE_TIME.test(data.collectedAt) || Number.isNaN(Date.parse(data.collectedAt))) errors.push("data.collectedAt inválido.");
      if (!Number.isInteger(data.ageMonths) || !inRange(data.ageMonths, LIMITS.ageMonths)) errors.push("data.ageMonths inválido.");
      if (data.sex !== "male" && data.sex !== "female") errors.push("data.sex inválido.");
      if (!inRange(data.weightKg, LIMITS.weightKg)) errors.push("data.weightKg inválido.");
      if (!inRange(data.heightM, LIMITS.heightM)) errors.push("data.heightM inválido.");
    }
    if (derivedOk) {
      if (!inRange(derived.bmi, LIMITS.bmi)) errors.push("derived.bmi inválido.");
      if (derived.calcVersion !== CALC_VERSION) errors.push("derived.calcVersion não suportado.");
      if (dataOk && inRange(data.weightKg, LIMITS.weightKg) && inRange(data.heightM, LIMITS.heightM)
        && derived.bmi !== bmiOf(data.weightKg, data.heightM)) errors.push("derived.bmi não corresponde a peso e altura.");
    }
    return errors;
  }

  function recordsEqual(a, b) {
    return DATA_KEYS.every((key) => a.data[key] === b.data[key]) && a.derived.bmi === b.derived.bmi && a.derived.calcVersion === b.derived.calcVersion;
  }

  function cloneRecord(record) {
    return { data: { ...record.data }, derived: { ...record.derived } };
  }

  // ---------- backup JSON (restauração) ----------

  function buildBackup(records, options) {
    const surveyId = (options && options.surveyId) || DEFAULT_SURVEY_ID;
    const exportedAt = toIsoWithOffset((options && options.now) ? options.now() : new Date());
    const list = records.map(cloneRecord);
    const backup = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_VERSION,
      appVersion: APP_VERSION,
      surveyId,
      exportedAt,
      recordCount: list.length,
      records: list
    };
    if (options && options.sync) {
      // Informação auxiliar: estados que ESTE navegador conhecia. Não prova que o registro está na planilha.
      const ids = new Set(list.map((r) => r.data.recordId));
      const states = (options.sync.states || [])
        .filter((s) => ids.has(s.recordId) && SYNC_STATES.includes(s.state))
        .map((s) => ({ recordId: s.recordId, state: s.state }));
      backup.formatVersion = BACKUP_VERSION_SYNC;
      backup.sync = {
        note: "Informativo. Estados de envio NÃO provam que o registro está na planilha; ao importar, todos são reavaliados.",
        states
      };
    }
    return backup;
  }

  function backupToJson(records, options) {
    return JSON.stringify(buildBackup(records, options), null, 2);
  }

  /** Lê e valida um backup. Qualquer erro invalida o arquivo inteiro (tudo ou nada). */
  function parseBackup(text, options) {
    const errors = [];
    const expectedSurvey = (options && options.surveyId) || DEFAULT_SURVEY_ID;
    const maxChars = (options && options.maxChars) || LIMITS.maxImportChars;
    const maxRecords = (options && options.maxRecords) || LIMITS.maxImportRecords;
    if (typeof text !== "string" || !text.trim()) return { ok: false, errors: ["Arquivo vazio."], records: [] };
    if (text.length > maxChars) return { ok: false, errors: [`Arquivo maior que o limite de ${maxChars} caracteres.`], records: [] };

    let parsed;
    try { parsed = JSON.parse(text.replace(/^﻿/, "")); } catch (_) { return { ok: false, errors: ["O arquivo não é um JSON válido."], records: [] }; }

    const withSync = isPlainObject(parsed) && parsed.formatVersion === BACKUP_VERSION_SYNC;
    if (!exactKeys(parsed, withSync ? BACKUP_KEYS_SYNC : BACKUP_KEYS, "backup", errors)) return { ok: false, errors, records: [] };
    if (parsed.format !== BACKUP_FORMAT) errors.push("Formato de arquivo não reconhecido.");
    if (parsed.formatVersion !== BACKUP_VERSION && !withSync) errors.push(`Versão de backup não suportada (${String(parsed.formatVersion)}).`);
    if (typeof parsed.surveyId !== "string" || !SURVEY_ID.test(parsed.surveyId)) errors.push("surveyId do backup inválido.");
    else if (parsed.surveyId !== expectedSurvey) errors.push(`O backup é da pesquisa "${parsed.surveyId}", diferente da pesquisa selecionada ("${expectedSurvey}").`);
    if (!Array.isArray(parsed.records)) errors.push("records deve ser uma lista.");
    else if (parsed.records.length > maxRecords) errors.push(`Mais de ${maxRecords} registros.`);
    else if (parsed.recordCount !== parsed.records.length) errors.push("recordCount não confere com a quantidade de registros.");
    if (errors.length) return { ok: false, errors, records: [] };
    let claimedStates = [];
    if (withSync) {
      const sync = parsed.sync;
      if (!isPlainObject(sync) || Object.keys(sync).some((k) => k !== "note" && k !== "states") || !Array.isArray(sync.states)) errors.push("backup.sync inválido.");
      else {
        const seen = new Set();
        sync.states.forEach((s, i) => {
          if (!isPlainObject(s) || Object.keys(s).length !== 2 || typeof s.recordId !== "string" || !RECORD_ID.test(s.recordId) || !SYNC_STATES.includes(s.state)) errors.push(`backup.sync.states[${i}] inválido.`);
          else if (seen.has(s.recordId)) errors.push(`backup.sync.states[${i}]: recordId repetido.`);
          else seen.add(s.recordId);
        });
        if (!errors.length) claimedStates = sync.states.map((s) => ({ recordId: s.recordId, state: s.state }));
      }
      if (errors.length) return { ok: false, errors: errors.slice(0, 20), records: [] };
    }

    const accepted = [];
    const byId = new Map();
    let duplicatesInFile = 0;
    parsed.records.forEach((record, index) => {
      const problems = validateRecord(record);
      if (problems.length) {
        if (errors.length < 20) problems.forEach((p) => errors.push(`Registro ${index + 1}: ${p}`));
        return;
      }
      if (record.data.surveyId !== expectedSurvey) { errors.push(`Registro ${index + 1}: pertence a outra pesquisa.`); return; }
      const known = byId.get(record.data.recordId);
      if (known) {
        if (recordsEqual(known, record)) duplicatesInFile += 1;
        else errors.push(`Registro ${index + 1}: o mesmo recordId aparece no arquivo com conteúdo diferente.`);
        return;
      }
      byId.set(record.data.recordId, record);
      accepted.push(cloneRecord(record));
    });
    if (errors.length) return { ok: false, errors, records: [] };
    // claimedConfirmed: o que o arquivo ALEGA; nunca é usado como prova (ver pesquisa-sincronizacao.js).
    return { ok: true, errors: [], records: accepted, duplicatesInFile, claimedConfirmed: claimedStates.filter((s) => s.state === "confirmado").length };
  }

  // ---------- CSV para análise ----------

  const CSV_HEADER = ["id_registro", "id_pesquisa", "coletado_em", "idade_meses", "sexo_calculo", "peso_kg", "altura_m", "imc"];

  function csvNumber(value) {
    return String(value).replace(".", ",");
  }

  /** CSV UTF-8 com BOM, separador ";" e decimal vírgula. Valores em precisão total. */
  function toCsv(records) {
    const lines = [CSV_HEADER.join(";")];
    records.forEach(({ data, derived }) => {
      lines.push([
        data.recordId,
        data.surveyId,
        data.collectedAt,
        data.ageMonths,
        data.sex === "male" ? "masculino" : "feminino",
        csvNumber(data.weightKg),
        csvNumber(data.heightM),
        csvNumber(derived.bmi)
      ].join(";"));
    });
    return `﻿${lines.join("\r\n")}\r\n`;
  }

  const api = {
    APP_VERSION,
    BACKUP_FORMAT,
    BACKUP_VERSION,
    BACKUP_VERSION_SYNC,
    SYNC_STATES,
    CALC_VERSION,
    DEFAULT_SURVEY_ID,
    LIMITS,
    CSV_HEADER,
    RESERVED_SURVEY_IDS,
    isValidSurveyId: (value) => typeof value === "string" && SURVEY_ID.test(value) && !RESERVED_SURVEY_IDS.includes(value),
    localDay,
    toIsoWithOffset,
    createRecordId,
    bmiOf,
    validateSnapshot,
    snapshotsEqual,
    buildRecord,
    validateRecord,
    recordsEqual,
    cloneRecord,
    buildBackup,
    backupToJson,
    parseBackup,
    toCsv
  };

  root.PesquisaDados = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
