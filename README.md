# O Peso da Estatística na Saúde

Calculadora educativa de IMC por idade e sexo para a **Feira do Conhecimento da Escola Esther Vianna Bologna**. O projeto foi pensado para uso em notebook, televisão, projetor, tablet ou celular e funciona sem internet, servidor, cadastro ou banco de dados.

> **Aviso:** o IMC é um indicador de triagem. Esta ferramenta não estabelece diagnóstico e não substitui avaliação médica ou nutricional.

## Como abrir

### Opção recomendada

1. Mantenha `index.html`, `style.css`, `who-data.js` e `script.js` na mesma pasta.
2. Abra `index.html` com dois cliques.
3. Não é necessário instalar nada nem iniciar um servidor.

### Arquivo único

Abra `index-unico.html`. Essa versão contém estilos, dados da OMS e JavaScript no próprio arquivo e é útil para copiar a aplicação em um pen drive ou para outros computadores da escola.

## Estrutura dos arquivos

```text
imc/
├── index.html          # Página principal
├── index-unico.html    # Versão completa em um único arquivo
├── logo-escola.png     # Identidade visual da escola no cabeçalho
├── style.css           # Identidade visual e responsividade
├── who-data.js         # Parâmetros LMS oficiais incorporados
├── script.js           # Validação, cálculos e interações
├── tests.js            # Testes automatizados sem dependências
└── README.md           # Este guia
```

## Como funciona o cálculo

O IMC é calculado por:

```text
IMC = peso (kg) ÷ altura² (m)
```

A aplicação aceita vírgula ou ponto decimal. Quando a altura é informada em centímetros, o valor é dividido por 100 antes do cálculo.

A idade é obtida pela diferença entre a data de nascimento e a data da avaliação. A interface apresenta anos, meses e o total de **meses completos**. O uso de datas UTC internamente evita alterações causadas por fuso horário ou horário de verão.

## Classificação por idade e sexo

As faixas fixas usadas em adultos **não são utilizadas**. Para cada sexo e mês de idade, a aplicação seleciona três parâmetros:

- **L:** potência Box-Cox, que trata a assimetria da distribuição;
- **M:** mediana do IMC na idade e sexo selecionados;
- **S:** coeficiente de variação.

Quando `L ≠ 0`, o escore-z inicial é:

```text
z = ((IMC ÷ M)^L − 1) ÷ (L × S)
```

Quando `L = 0`, usa-se:

```text
z = ln(IMC ÷ M) ÷ S
```

Para resultados além de ±3, o código aplica o método recomendado pela OMS: extensão linear usando a distância entre 2 e 3 desvios-padrão. Isso evita extrapolar a cauda da distribuição LMS além da região observada.

Os pontos de corte implementados são:

| Escore-z | Classificação |
|---:|---|
| `z < −3` | Magreza acentuada |
| `−3 ≤ z < −2` | Magreza |
| `−2 ≤ z ≤ +1` | Faixa adequada |
| `+1 < z ≤ +2` | Sobrepeso |
| `+2 < z ≤ +3` | Obesidade |
| `z > +3` | Obesidade grave |

## Fonte dos dados da OMS

Os dados estão no arquivo `who-data.js` e não são baixados durante o uso.

- Meses **61 a 228**, masculino e feminino: *WHO 2007 Growth Reference — BMI-for-age, 5–19 years*. [Página oficial da OMS](https://www.who.int/toolkits/growth-reference-data-for-5to19-years/indicators/bmi-for-age)
- Mês **60**: ponto oficial complementar do *WHO Child Growth Standards — BMI-for-age, 2–5 years*. A referência de 5–19 anos começa no mês 61; o ponto do mês 60 permite atender exatamente o quinto aniversário sem estimar dados. [Página oficial da OMS](https://www.who.int/toolkits/child-growth-standards/standards/body-mass-index-for-age-bmi-for-age)
- Procedimento matemático: *Computation of centiles and z-scores for height-for-age, weight-for-age and BMI-for-age*. [Documento oficial da OMS](https://cdn.who.int/media/docs/default-source/child-growth/growth-reference-5-19-years/computation.pdf)
- Contexto da referência: [Growth reference data for 5–19 years](https://www.who.int/tools/growth-reference-data-for-5to19-years)

Os valores LMS foram transcritos das tabelas oficiais por mês e preservam a precisão publicada pela OMS. O código identifica claramente a localização dos dados e a fórmula usada.

## Privacidade

- Nenhum nome, data, peso, altura ou resultado é salvo.
- Não há cookies, `localStorage`, `sessionStorage`, banco de dados ou histórico.
- Não há rastreadores, publicidade ou ferramentas de análise.
- Nenhuma informação é enviada para a internet.
- O botão **Limpar dados** apaga formulário, mensagens e resultado da tela.
- Fechar ou atualizar a página também elimina os dados digitados.

## Uso totalmente offline

1. Copie a pasta inteira ou apenas `index-unico.html` para o computador de destino.
2. Desconecte o Wi-Fi ou o cabo de rede.
3. Abra a aplicação e faça um cálculo.
4. O resultado continuará disponível porque todos os dados necessários estão incorporados.

## Como validar a calculadora

### Testes automatizados

Se houver Node.js instalado, execute na pasta do projeto:

```powershell
node tests.js
```

Os testes conferem conversão de unidades, IMC, idade em meses, ano bissexto, curvas diferentes por sexo, fórmula LMS, extensão além de ±3, inclusão dos pontos de corte, idades mínima e máxima, campos vazios, valores negativos, datas inválidas, vírgula decimal, limites plausíveis e ausência de armazenamento ou rede.

### Comparação com as tabelas oficiais

1. Escolha sexo e idade em meses.
2. Abra a tabela oficial de IMC por idade da OMS correspondente.
3. Use como IMC um valor publicado nas colunas `−3 SD`, `−2 SD`, `+1 SD`, `+2 SD` ou `+3 SD`.
4. Para montar peso e altura compatíveis com esse IMC, escolha uma altura em metros e calcule `peso = IMC × altura²`.
5. Insira os valores na aplicação. Pequenas diferenças podem aparecer porque as colunas de desvio-padrão impressas pela OMS têm uma casa decimal, enquanto o projeto calcula a partir de L, M e S com maior precisão.

Para uma verificação adicional, compare casos com o software **WHO AnthroPlus**, usando as mesmas datas, sexo, peso e altura.

### Roteiro manual

- Calcule `42,5 kg` e `145 cm`; o IMC deve ser `20,2 kg/m²`.
- Troque `145 cm` por `1,45 m`; o resultado deve ser idêntico.
- Use a mesma idade e IMC nas opções masculino e feminino; o escore-z deve mudar.
- Teste datas com 29 de fevereiro.
- Tente calcular com campos vazios, datas invertidas, peso negativo e altura fora dos limites.
- Teste idades com 60, 228, 59 e 229 meses.
- Pressione Tab para percorrer todos os controles e conferir o foco visível.
- Ative **Modo apresentação** e saia com Esc.
- Calcule e use **Limpar dados** e **Iniciar nova avaliação**; não deve restar resultado anterior.
- Faça um cálculo com a internet desconectada.

## Limitações

- A ferramenta atende apenas de **60 a 228 meses completos** (do quinto aniversário até 19 anos completos). O limite superior segue a extensão publicada da referência da OMS.
- O valor representa uma medição pontual e pode ser afetado por erro de balança, postura, roupa, horário e digitação.
- O IMC não mede diretamente gordura corporal, massa muscular, maturação puberal, alimentação ou saúde clínica.
- A categoria “obesidade grave” (`z > +3`) foi incluída conforme a especificação educativa do projeto; as páginas resumidas da OMS destacam principalmente sobrepeso acima de +1 e obesidade acima de +2.
- Resultados não devem ser usados para prescrever dieta, exercício, medicamento ou qualquer intervenção.

## Como personalizar

### Escola e textos

Abra `index.html` em um editor de texto e procure por:

- `Escola Esther Vianna Bologna`;
- `O Peso da Estatística na Saúde`;
- `Feira do Conhecimento`.

Faça a mesma alteração em `index-unico.html` se essa versão já tiver sido gerada.

### Cores

No início de `style.css`, edite as variáveis dentro de `:root`, como `--navy-900`, `--blue-500`, `--green-600` e `--yellow-400`.

## Como atualizar os dados antropométricos

1. Baixe novas tabelas apenas das páginas oficiais da OMS.
2. Confirme que cada linha contém mês, L, M e S e que existem registros separados para masculino e feminino.
3. Substitua as matrizes `male` e `female` em `who-data.js`, preservando a ordem mensal.
4. Atualize `firstMonth`, `lastMonth`, fonte e data de acesso.
5. Execute `node tests.js`.
6. Compare vários meses, os dois sexos e todos os pontos de corte com as tabelas oficiais.
7. Gere novamente `index-unico.html`, pois ele contém uma cópia incorporada dos dados.

Não arredonde nem interpole parâmetros sem documentação oficial. Uma atualização dos dados deve ser revisada por alguém com conhecimento em antropometria ou saúde.

## Requisitos técnicos

Navegador moderno com JavaScript habilitado. A aplicação foi feita apenas com HTML5, CSS3 e JavaScript puro, sem frameworks ou dependências de execução.
