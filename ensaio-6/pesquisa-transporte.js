/*
 * Pesquisa educativa — transporte e criptografia do navegador.
 *
 * ÚNICO arquivo do projeto autorizado a chamar fetch (verificado em tests.js). Só é acionado pela sincronização
 * opcional, depois de o destino ser validado (pesquisa-sincronizacao.js). Cálculo, dados da OMS, painel e
 * armazenamento nunca usam rede.
 *
 *  - nunca usa mode "no-cors": a resposta precisa ser legível pelo chamador;
 *  - não guarda nem registra URL, corpo ou chaves;
 *  - fetch é resolvido no momento da chamada (permite dobles nos testes de navegador).
 */
(function (root) {
  "use strict";

  /** Devolve uma função (url, init) => Promise<Response>, ligada à janela informada. */
  function createFetchTransport(win) {
    const target = win || root;
    return function transport(url, init) {
      if (!target || typeof target.fetch !== "function") return Promise.reject(new TypeError("fetch indisponível"));
      if (init && init.mode === "no-cors") return Promise.reject(new TypeError("no-cors não é permitido: a resposta precisa ser legível"));
      return target.fetch(url, init);
    };
  }

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** SHA-256 hexadecimal (UTF-8) por crypto.subtle; indisponível fora de contexto seguro (https ou localhost). */
  function createSha256(win) {
    const target = win || root;
    return async function sha256Hex(text) {
      const subtle = target && target.crypto && target.crypto.subtle;
      if (!subtle) throw new Error("crypto.subtle indisponível neste contexto.");
      return toHex(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
    };
  }

  const api = { createFetchTransport, createSha256 };
  root.PesquisaTransporte = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
