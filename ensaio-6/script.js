/*
 * Calculadora educativa de IMC por idade e sexo.
 *
 * DADOS DA OMS
 * O arquivo who-data.js contém os parâmetros LMS oficiais por sexo e mês:
 * L = potência Box-Cox que corrige a assimetria da distribuição;
 * M = mediana do IMC para aquela idade e sexo;
 * S = coeficiente de variação da distribuição.
 *
 * Para L diferente de zero: z = ((IMC / M)^L - 1) / (L × S)
 * Para L igual a zero:      z = ln(IMC / M) / S
 *
 * Fora de ±3, aplica-se a extensão linear recomendada pela OMS, usando a
 * distância entre 2 e 3 desvios-padrão. Consulte README.md para fontes.
 */
(function (root) {
  "use strict";

  const MS_PER_DAY = 86_400_000;
  const MIN_MONTH = 60;
  const MAX_MONTH = 228;
  const MAX_PLAUSIBLE_MONTH = 1560; // 130 anos — checagem de plausibilidade, não um limite normativo

  const CLASSIFICATIONS = {
    severeThin: {
      label: "Magreza acentuada",
      message: "O resultado ficou muito abaixo da faixa esperada para idade e sexo. Uma única medição não estabelece diagnóstico, mas é recomendável conversar com os responsáveis e buscar avaliação de um profissional de saúde."
    },
    thin: {
      label: "Magreza",
      message: "O resultado ficou abaixo da faixa de referência para idade e sexo. É importante observar o crescimento ao longo do tempo e, se necessário, conversar com um profissional de saúde."
    },
    adequate: {
      label: "Faixa adequada",
      message: "O resultado está dentro da faixa de referência para idade e sexo. Continue valorizando alimentação variada, movimento, sono adequado e acompanhamento do crescimento."
    },
    overweight: {
      label: "Sobrepeso",
      message: "O resultado ficou acima da faixa de referência para idade e sexo. Isso não representa um diagnóstico isolado. A análise deve considerar crescimento, alimentação, atividade física, sono e acompanhamento profissional."
    },
    obesity: {
      label: "Obesidade",
      message: "O resultado ficou consideravelmente acima da faixa de referência para idade e sexo. Recomenda-se conversar com os responsáveis e procurar orientação profissional, sem julgamentos ou dietas por conta própria."
    },
    severeObesity: {
      label: "Obesidade grave",
      message: "O resultado ficou muito acima da faixa de referência para idade e sexo. É importante procurar avaliação profissional para uma análise completa, respeitosa e individualizada."
    }
  };

  // Faixas de IMC para adultos (a partir de 229 meses, ou seja, 19 anos e 1 mês) — classificação padrão da OMS,
  // única para os dois sexos e sem uso de escore-z (que se aplica apenas a crianças e adolescentes).
  const ADULT_CLASSIFICATIONS = {
    underweight: {
      label: "Abaixo do peso",
      message: "O IMC ficou abaixo da faixa considerada adequada para adultos. Uma única medição não estabelece diagnóstico; é recomendável conversar com um profissional de saúde."
    },
    normal: {
      label: "Peso adequado",
      message: "O IMC está dentro da faixa considerada adequada para adultos. Continue valorizando alimentação variada, atividade física e sono adequado."
    },
    overweight: {
      label: "Sobrepeso",
      message: "O IMC ficou acima da faixa considerada adequada para adultos. Isso não representa um diagnóstico isolado; a avaliação completa deve considerar alimentação, atividade física e acompanhamento profissional."
    },
    obesityI: {
      label: "Obesidade grau I",
      message: "O IMC ficou na faixa de obesidade grau I para adultos. Recomenda-se buscar orientação profissional para uma avaliação completa e individualizada."
    },
    obesityII: {
      label: "Obesidade grau II",
      message: "O IMC ficou na faixa de obesidade grau II para adultos. É importante procurar avaliação profissional para uma análise completa e individualizada."
    },
    obesityIII: {
      label: "Obesidade grau III",
      message: "O IMC ficou na faixa de obesidade grau III para adultos. É importante procurar avaliação profissional para uma análise completa e individualizada."
    }
  };

  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  }

  function dateToInputValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function calculateAge(birthInput, assessmentInput) {
    const birth = birthInput instanceof Date ? birthInput : parseDate(birthInput);
    const assessment = assessmentInput instanceof Date ? assessmentInput : parseDate(assessmentInput);
    if (!birth || !assessment || assessment < birth) return null;

    let totalMonths = (assessment.getUTCFullYear() - birth.getUTCFullYear()) * 12
      + assessment.getUTCMonth() - birth.getUTCMonth();
    if (assessment.getUTCDate() < birth.getUTCDate()) totalMonths -= 1;

    return {
      years: Math.floor(totalMonths / 12),
      months: totalMonths % 12,
      totalMonths,
      totalDays: Math.floor((assessment.getTime() - birth.getTime()) / MS_PER_DAY)
    };
  }

  function parseBrazilianNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    const normalized = String(value || "").trim().replace(/\s/g, "").replace(",", ".");
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return NaN;
    return Number(normalized);
  }

  function heightInMeters(value, unit) {
    const height = parseBrazilianNumber(value);
    if (!Number.isFinite(height)) return NaN;
    return unit === "cm" ? height / 100 : height;
  }

  function calculateBmi(weight, heightMeters) {
    return weight / (heightMeters * heightMeters);
  }

  function lmsValueAtZ(z, l, m, s) {
    if (Math.abs(l) < 1e-12) return m * Math.exp(s * z);
    const base = 1 + l * s * z;
    return base > 0 ? m * Math.pow(base, 1 / l) : NaN;
  }

  function calculateWhoZScore(bmi, l, m, s) {
    const rawZ = Math.abs(l) < 1e-12
      ? Math.log(bmi / m) / s
      : (Math.pow(bmi / m, l) - 1) / (l * s);

    if (rawZ >= -3 && rawZ <= 3) return rawZ;

    if (rawZ > 3) {
      const sd3 = lmsValueAtZ(3, l, m, s);
      const sd2 = lmsValueAtZ(2, l, m, s);
      return 3 + (bmi - sd3) / (sd3 - sd2);
    }

    const sdNeg3 = lmsValueAtZ(-3, l, m, s);
    const sdNeg2 = lmsValueAtZ(-2, l, m, s);
    return -3 + (bmi - sdNeg3) / (sdNeg2 - sdNeg3);
  }

  function getLms(sex, ageMonths, data) {
    const source = data || root.WHO_LMS_DATA;
    if (!source || !source[sex] || ageMonths < source.firstMonth || ageMonths > source.lastMonth) return null;
    const row = source[sex][ageMonths - source.firstMonth];
    return row ? { l: row[0], m: row[1], s: row[2] } : null;
  }

  function classifyZ(z) {
    if (z < -3) return { key: "severeThin", ...CLASSIFICATIONS.severeThin };
    if (z < -2) return { key: "thin", ...CLASSIFICATIONS.thin };
    if (z <= 1) return { key: "adequate", ...CLASSIFICATIONS.adequate };
    if (z <= 2) return { key: "overweight", ...CLASSIFICATIONS.overweight };
    if (z <= 3) return { key: "obesity", ...CLASSIFICATIONS.obesity };
    return { key: "severeObesity", ...CLASSIFICATIONS.severeObesity };
  }

  function isAdultAge(totalMonths) {
    return totalMonths > MAX_MONTH;
  }

  function classifyAdultBmi(bmi) {
    if (bmi < 18.5) return { key: "underweight", ...ADULT_CLASSIFICATIONS.underweight };
    if (bmi < 25) return { key: "normal", ...ADULT_CLASSIFICATIONS.normal };
    if (bmi < 30) return { key: "overweight", ...ADULT_CLASSIFICATIONS.overweight };
    if (bmi < 35) return { key: "obesityI", ...ADULT_CLASSIFICATIONS.obesityI };
    if (bmi < 40) return { key: "obesityII", ...ADULT_CLASSIFICATIONS.obesityII };
    return { key: "obesityIII", ...ADULT_CLASSIFICATIONS.obesityIII };
  }

  function formatNumber(value, decimals) {
    return new Intl.NumberFormat("pt-BR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value);
  }

  function formatZ(z) {
    const prefix = z > 0 ? "+" : z < 0 ? "−" : "";
    return `${prefix}${formatNumber(Math.abs(z), 2)}`;
  }

  function plural(value, singular, pluralForm) {
    return `${value} ${value === 1 ? singular : pluralForm}`;
  }

  function formatAge(age) {
    return `${plural(age.years, "ano", "anos")} e ${plural(age.months, "mês", "meses")}`;
  }

  function validate(values) {
    const errors = {};
    if (!values.sex) errors.sex = "Selecione a curva correspondente para continuar.";

    const birth = parseDate(values.birthDate);
    const assessment = parseDate(values.assessmentDate);
    if (!birth) errors.birthDate = "Informe a data de nascimento.";
    if (!assessment) errors.assessmentDate = "Informe a data da avaliação.";

    let age = null;
    if (birth && assessment) {
      if (birth > assessment) {
        errors.birthDate = "A data de nascimento não pode ser posterior à data da avaliação.";
      } else {
        age = calculateAge(birth, assessment);
        if (age.totalMonths < MIN_MONTH) {
          errors.birthDate = `Esta calculadora exige idade mínima de 5 anos completos (${MIN_MONTH} meses).`;
        } else if (age.totalMonths > MAX_PLAUSIBLE_MONTH) {
          errors.birthDate = "Confira a data de nascimento informada.";
        }
      }
    }

    const weight = parseBrazilianNumber(values.weight);
    if (!Number.isFinite(weight)) errors.weight = "Informe o peso em quilogramas.";
    else if (weight < 10 || weight > 300) errors.weight = "Confira o peso informado. Utilize um valor plausível entre 10 e 300 kg.";

    const heightMeters = heightInMeters(values.height, values.heightUnit);
    if (!Number.isFinite(heightMeters)) errors.height = "Informe uma altura válida.";
    else if (heightMeters < 0.8 || heightMeters > 2.3) errors.height = "Confira a altura informada. Utilize um valor plausível entre 80 cm e 2,30 m.";

    let bmi = null;
    if (Number.isFinite(weight) && Number.isFinite(heightMeters) && weight > 0 && heightMeters > 0) {
      bmi = calculateBmi(weight, heightMeters);
      if (bmi < 7 || bmi > 100) errors.height = "Confira peso e altura: a combinação informada está fora dos limites plausíveis.";
    }

    return { valid: Object.keys(errors).length === 0, errors, birth, assessment, age, weight, heightMeters, bmi };
  }

  const api = {
    MIN_MONTH,
    MAX_MONTH,
    MAX_PLAUSIBLE_MONTH,
    parseDate,
    calculateAge,
    parseBrazilianNumber,
    heightInMeters,
    calculateBmi,
    lmsValueAtZ,
    calculateWhoZScore,
    getLms,
    classifyZ,
    isAdultAge,
    classifyAdultBmi,
    validate,
    formatAge,
    formatZ
  };

  root.IMCCalculator = api;
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  const form = document.getElementById("imcForm");
  const resultSection = document.getElementById("resultado");
  const globalError = document.getElementById("globalError");
  const assessmentDate = document.getElementById("assessmentDate");
  const fields = {
    birthDate: document.getElementById("birthDate"),
    assessmentDate,
    weight: document.getElementById("weight"),
    height: document.getElementById("height")
  };

  assessmentDate.value = dateToInputValue(new Date());
  fields.birthDate.max = assessmentDate.value;

  function readValues() {
    const formData = new FormData(form);
    return {
      name: String(formData.get("name") || "").trim(),
      sex: String(formData.get("sex") || ""),
      birthDate: String(formData.get("birthDate") || ""),
      assessmentDate: String(formData.get("assessmentDate") || ""),
      weight: String(formData.get("weight") || ""),
      height: String(formData.get("height") || ""),
      heightUnit: String(formData.get("heightUnit") || "cm")
    };
  }

  function clearErrors() {
    globalError.hidden = true;
    globalError.textContent = "";
    document.querySelectorAll(".field-error").forEach((element) => { element.textContent = ""; });
    document.querySelectorAll("[aria-invalid='true']").forEach((element) => element.removeAttribute("aria-invalid"));
    document.getElementById("sexGroup").removeAttribute("aria-invalid");
  }

  function showErrors(errors) {
    clearErrors();
    globalError.textContent = "Confira os dados informados antes de continuar.";
    globalError.hidden = false;
    globalError.focus();

    Object.entries(errors).forEach(([key, message]) => {
      const messageElement = document.getElementById(`${key}Error`);
      if (messageElement) messageElement.textContent = message;
      if (key === "sex") document.getElementById("sexGroup").setAttribute("aria-invalid", "true");
      else if (fields[key]) fields[key].setAttribute("aria-invalid", "true");
    });
  }

  function markerPosition(z) {
    const clamped = Math.max(-4, Math.min(4, z));
    return ((clamped + 4) / 8) * 100;
  }

  const CHILD_STYLES = {
    severeThin: ["#e7eef4", "#375f7a"],
    thin: ["#dff1ff", "#176da9"],
    adequate: ["#ddf6ee", "#169b78"],
    overweight: ["#fff4cb", "#a77a00"],
    obesity: ["#ffead6", "#bf671f"],
    severeObesity: ["#fde1e5", "#b53f50"]
  };

  const ADULT_STYLES = {
    underweight: ["#dff1ff", "#176da9"],
    normal: ["#ddf6ee", "#169b78"],
    overweight: ["#fff4cb", "#a77a00"],
    obesityI: ["#ffead6", "#bf671f"],
    obesityII: ["#ffdcc2", "#a5501a"],
    obesityIII: ["#fde1e5", "#b53f50"]
  };

  function updateClassificationStyle(key, adult) {
    const panel = document.querySelector(".classification-panel");
    const [background, accent] = (adult ? ADULT_STYLES : CHILD_STYLES)[key];
    panel.style.background = background;
    panel.style.borderColor = accent;
    panel.querySelector(".classification-icon").style.background = accent;
    panel.querySelector("h3").style.color = accent;
  }

  function fillCommonResultFields(values, computed) {
    const safeName = values.name;
    document.getElementById("resultName").textContent = safeName ? `Avaliação de ${safeName}` : "Avaliação sem identificação";
    document.getElementById("resultBmi").textContent = formatNumber(computed.bmi, 1);
    document.getElementById("resultAge").textContent = formatAge(computed.age);
    document.getElementById("resultMonths").textContent = `${computed.age.totalMonths} meses completos`;
    document.getElementById("resultWeight").textContent = `${formatNumber(computed.weight, 1)} kg`;
    document.getElementById("resultHeight").textContent = `${formatNumber(computed.heightMeters, 2)} m`;
  }

  function renderChildResult(values, computed) {
    const lms = getLms(values.sex, computed.age.totalMonths);
    if (!lms) {
      showErrors({ birthDate: "Não foi possível localizar a idade na referência da OMS." });
      return false;
    }

    const z = calculateWhoZScore(computed.bmi, lms.l, lms.m, lms.s);
    const classification = classifyZ(z);

    fillCommonResultFields(values, computed);
    document.getElementById("resultModeBadge").textContent = "Avaliação infantil/adolescente — curva da OMS por idade e sexo";
    document.getElementById("resultModeBadge").className = "mode-badge mode-child";
    document.getElementById("resultZRow").hidden = false;
    document.getElementById("resultZ").textContent = formatZ(z);
    document.getElementById("classificationContextLabel").textContent = "Classificação na curva de crescimento";
    document.getElementById("resultClassification").textContent = classification.label;
    document.getElementById("resultMessage").textContent = classification.message;
    document.getElementById("zChartSection").hidden = false;
    document.getElementById("chartZBadge").textContent = `z = ${formatZ(z)}`;
    document.getElementById("zMarker").style.left = `${markerPosition(z)}%`;
    document.getElementById("markerLabel").textContent = `Resultado: ${formatZ(z)}`;
    updateClassificationStyle(classification.key, false);

    resultSection.hidden = false;
    requestAnimationFrame(() => resultSection.scrollIntoView({ behavior: "smooth", block: "start" }));
    return true;
  }

  function renderAdultResult(values, computed) {
    const classification = classifyAdultBmi(computed.bmi);

    fillCommonResultFields(values, computed);
    document.getElementById("resultModeBadge").textContent = "Avaliação adulta (a partir de 229 meses: 19 anos e 1 mês) — faixas de IMC da OMS, sem escore-z";
    document.getElementById("resultModeBadge").className = "mode-badge mode-adult";
    document.getElementById("resultZRow").hidden = true;
    document.getElementById("classificationContextLabel").textContent = "Classificação por IMC — faixas padrão da OMS para adultos";
    document.getElementById("resultClassification").textContent = classification.label;
    document.getElementById("resultMessage").textContent = classification.message;
    document.getElementById("zChartSection").hidden = true;
    updateClassificationStyle(classification.key, true);

    resultSection.hidden = false;
    requestAnimationFrame(() => resultSection.scrollIntoView({ behavior: "smooth", block: "start" }));
    return true;
  }

  function renderResult(values, computed) {
    return isAdultAge(computed.age.totalMonths)
      ? renderAdultResult(values, computed)
      : renderChildResult(values, computed);
  }

  // Ganchos para a pesquisa opcional (pesquisa-ui.js). Os eventos NUNCA carregam nome nem data de nascimento:
  // apenas os valores numéricos já calculados e o dia da avaliação.
  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) { /* a calculadora não depende da pesquisa */ }
  }

  function resetAll(focusForm) {
    form.reset();
    assessmentDate.value = dateToInputValue(new Date());
    document.getElementById("heightUnit").value = "cm";
    clearErrors();
    resultSection.hidden = true;
    emit("imc:invalidar", { motivo: "limpar" });
    if (focusForm) {
      document.getElementById("calculadora").scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => document.getElementById("name").focus(), 450);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = readValues();
    const computed = validate(values);
    if (!computed.valid) {
      showErrors(computed.errors);
      resultSection.hidden = true;
      emit("imc:invalidar", { motivo: "invalido" });
      return;
    }
    clearErrors();
    if (renderResult(values, computed) !== false) {
      emit("imc:calculo", {
        sex: values.sex,
        ageMonths: computed.age.totalMonths,
        weightKg: computed.weight,
        heightM: computed.heightMeters,
        bmi: computed.bmi,
        assessmentDay: values.assessmentDate
      });
    } else {
      emit("imc:invalidar", { motivo: "sem-resultado" });
    }
  });

  document.getElementById("clearButton").addEventListener("click", () => resetAll(false));
  document.getElementById("newAssessmentButton").addEventListener("click", () => resetAll(true));
  document.getElementById("backToFormButton").addEventListener("click", () => {
    document.getElementById("calculadora").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("name").focus({ preventScroll: true });
  });

  assessmentDate.addEventListener("change", () => {
    fields.birthDate.max = assessmentDate.value || dateToInputValue(new Date());
  });

  document.getElementById("presentationButton").addEventListener("click", async () => {
    const button = document.getElementById("presentationButton");
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        button.innerHTML = '<span aria-hidden="true">×</span> Sair da apresentação';
        button.setAttribute("aria-label", "Sair do modo apresentação");
      } else {
        await document.exitFullscreen();
      }
    } catch (_) {
      button.textContent = "Tela cheia indisponível";
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const button = document.getElementById("presentationButton");
    if (!document.fullscreenElement) {
      button.innerHTML = '<span aria-hidden="true">⛶</span> Modo apresentação';
      button.setAttribute("aria-label", "Ativar modo apresentação em tela cheia");
    }
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
