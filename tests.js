/* Execute com: node tests.js */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const data = require("./who-data.js");
const calc = require("./script.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} deveria ser próximo de ${expected}`);
}

test("carrega 169 meses oficiais para cada sexo", () => {
  assert.equal(data.male.length, 169);
  assert.equal(data.female.length, 169);
  assert.equal(data.firstMonth, 60);
  assert.equal(data.lastMonth, 228);
});

test("converte centímetros para metros", () => close(calc.heightInMeters("145", "cm"), 1.45));
test("aceita vírgula decimal", () => close(calc.parseBrazilianNumber("42,5"), 42.5));
test("calcula o IMC corretamente", () => close(calc.calculateBmi(42.5, 1.45), 20.214030915576696));

test("calcula idade em meses completos", () => {
  assert.deepEqual(calc.calculateAge("2012-04-15", "2024-08-15"), { years: 12, months: 4, totalMonths: 148, totalDays: 4505 });
});

test("trata corretamente o ano bissexto", () => {
  const beforeAnniversary = calc.calculateAge("2012-02-29", "2025-02-28");
  const afterAnniversary = calc.calculateAge("2012-02-29", "2025-03-01");
  assert.equal(beforeAnniversary.totalMonths, 155);
  assert.equal(afterAnniversary.totalMonths, 156);
});

test("rejeita data civil impossível", () => assert.equal(calc.parseDate("2025-02-29"), null));
test("rejeita número negativo", () => assert.ok(Number.isNaN(calc.parseBrazilianNumber("-42"))));

test("usa curvas diferentes para masculino e feminino", () => {
  const male = calc.getLms("male", 148, data);
  const female = calc.getLms("female", 148, data);
  assert.notDeepEqual(male, female);
  assert.notEqual(calc.calculateWhoZScore(20, male.l, male.m, male.s), calc.calculateWhoZScore(20, female.l, female.m, female.s));
});

test("LMS reproduz os pontos centrais de z", () => {
  const { l, m, s } = calc.getLms("female", 148, data);
  [-3, -2, 1, 2, 3].forEach((z) => {
    const bmi = calc.lmsValueAtZ(z, l, m, s);
    close(calc.calculateWhoZScore(bmi, l, m, s), z, 1e-8);
  });
});

test("aplica extensão OMS abaixo de -3", () => {
  const { l, m, s } = calc.getLms("male", 192, data);
  const sdNeg3 = calc.lmsValueAtZ(-3, l, m, s);
  const sdNeg2 = calc.lmsValueAtZ(-2, l, m, s);
  const bmi = sdNeg3 - (sdNeg2 - sdNeg3) * 0.8;
  close(calc.calculateWhoZScore(bmi, l, m, s), -3.8, 1e-8);
});

test("aplica extensão OMS acima de +3", () => {
  const { l, m, s } = calc.getLms("male", 132, data);
  const sd3 = calc.lmsValueAtZ(3, l, m, s);
  const sd2 = calc.lmsValueAtZ(2, l, m, s);
  const bmi = sd3 + (sd3 - sd2) * 0.5;
  close(calc.calculateWhoZScore(bmi, l, m, s), 3.5, 1e-8);
});

test("respeita inclusão e exclusão nos seis limites", () => {
  assert.equal(calc.classifyZ(-3.01).key, "severeThin");
  assert.equal(calc.classifyZ(-3).key, "thin");
  assert.equal(calc.classifyZ(-2).key, "adequate");
  assert.equal(calc.classifyZ(1).key, "adequate");
  assert.equal(calc.classifyZ(1.01).key, "overweight");
  assert.equal(calc.classifyZ(2).key, "overweight");
  assert.equal(calc.classifyZ(2.01).key, "obesity");
  assert.equal(calc.classifyZ(3).key, "obesity");
  assert.equal(calc.classifyZ(3.01).key, "severeObesity");
});

const validBase = {
  name: "",
  sex: "male",
  birthDate: "2012-04-15",
  assessmentDate: "2024-08-15",
  weight: "42,5",
  height: "145",
  heightUnit: "cm"
};

test("aceita a idade mínima de 60 meses", () => {
  const result = calc.validate({ ...validBase, birthDate: "2019-08-15" });
  assert.equal(result.valid, true);
  assert.equal(result.age.totalMonths, 60);
});

test("aceita a idade máxima de 228 meses", () => {
  const result = calc.validate({ ...validBase, birthDate: "2005-08-15" });
  assert.equal(result.valid, true);
  assert.equal(result.age.totalMonths, 228);
});

test("rejeita idade abaixo do mínimo", () => assert.equal(calc.validate({ ...validBase, birthDate: "2019-09-15" }).valid, false));
test("rejeita idade acima do máximo", () => assert.equal(calc.validate({ ...validBase, birthDate: "2005-07-15" }).valid, false));
test("rejeita campos obrigatórios vazios", () => assert.equal(calc.validate({ sex: "", birthDate: "", assessmentDate: "", weight: "", height: "", heightUnit: "cm" }).valid, false));
test("rejeita nascimento posterior à avaliação", () => assert.match(calc.validate({ ...validBase, birthDate: "2025-01-01" }).errors.birthDate, /posterior/));
test("rejeita medidas fora de limites plausíveis", () => assert.equal(calc.validate({ ...validBase, weight: "900", height: "40" }).valid, false));

test("não usa armazenamento, cookies, rede ou rastreadores", () => {
  const sources = ["index.html", "index-unico.html", "script.js", "style.css", "who-data.js"].map((file) => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /localStorage|sessionStorage|document\.cookie|fetch\s*\(|XMLHttpRequest|googletag|analytics/i);
  assert.doesNotMatch(sources, /https?:\/\//i);
});

test("versão única incorpora CSS, dados e lógica", () => {
  const single = fs.readFileSync(path.join(__dirname, "index-unico.html"), "utf8");
  assert.match(single, /<style>[\s\S]*:root/);
  assert.match(single, /root\.WHO_LMS_DATA=/);
  assert.match(single, /function calculateWhoZScore/);
  assert.doesNotMatch(single, /<(?:script|link)[^>]+(?:src|href)="/i);
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error.message}`);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} testes aprovados.`);
if (failures) process.exitCode = 1;
