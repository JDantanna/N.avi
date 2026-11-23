// Folha deslizante: sobe da base no iPhone (com o puxão para baixo que fecha) e vira uma gaveta à direita em
// telas largas, como o iPad. Serve para os detalhes da tarefa e para os ajustes.

import { h, icone } from "./dom.js";

let aberta = null;

/**
 * Abre uma folha. `montar(folha)` devolve o conteúdo; `aoFechar` roda quando ela fecha, por qualquer caminho.
 * Só há uma folha por vez: abrir outra fecha a anterior.
 */
export function abrirFolha({ classe = "", titulo = "", acoes = [], montar, aoFechar = () => {} }) {
  aberta?.fechar();
  const raiz = document.getElementById("folhas");
  const fundo = h("div", { class: "fundo", onclick: () => folha.fechar() });
  const corpo = h("div", { class: "folha-corpo" });
  const alca = h("div", { class: "alca", "aria-hidden": "true" }, h("span"));
  const cabeca = h(
    "div",
    { class: "folha-cabeca" },
    h("h2", {}, titulo),
    h("div", { class: "folha-acoes" }, ...acoes, h("button", { class: "botao-icone", "aria-label": "Fechar", onclick: () => folha.fechar() }, icone("fechar", 22))),
  );
  const painel = h("section", { class: `folha ${classe}`.trim(), role: "dialog", "aria-modal": "true", "aria-label": titulo || "Detalhes" }, alca, cabeca, corpo);
  const folha = {
    el: painel,
    corpo,
    cabeca,
    fechado: false,
    fechar() {
      if (folha.fechado) return;
      folha.fechado = true;
      document.body.classList.remove("com-folha");
      document.removeEventListener("keydown", teclas);
      painel.classList.add("saindo");
      fundo.classList.add("saindo");
      const sair = () => {
        painel.remove();
        fundo.remove();
      };
      // Termina a animação; se o aparelho a desliga (movimento reduzido), sai logo.
      painel.addEventListener("animationend", sair, { once: true });
      setTimeout(sair, 320);
      if (aberta === folha) aberta = null;
      aoFechar();
    },
  };
  const teclas = (e) => {
    if (e.key === "Escape") folha.fechar();
  };
  document.addEventListener("keydown", teclas);

  // Puxar a alça (ou a cabeça) para baixo fecha a folha.
  let inicio = null;
  const comecar = (e) => {
    inicio = { y: e.touches[0].clientY, dy: 0 };
    painel.style.transition = "none";
  };
  const mover = (e) => {
    if (!inicio) return;
    inicio.dy = Math.max(0, e.touches[0].clientY - inicio.y);
    painel.style.transform = `translateY(${inicio.dy}px)`;
  };
  const soltar = () => {
    if (!inicio) return;
    painel.style.transition = "";
    if (inicio.dy > 110) folha.fechar();
    else painel.style.transform = "";
    inicio = null;
  };
  for (const zona of [alca, cabeca]) {
    zona.addEventListener("touchstart", comecar, { passive: true });
    zona.addEventListener("touchmove", mover, { passive: true });
    zona.addEventListener("touchend", soltar);
    zona.addEventListener("touchcancel", soltar);
  }

  raiz.append(fundo, painel);
  document.body.classList.add("com-folha");
  aberta = folha;
  corpo.append(montar(folha));
  return folha;
}

export const folhaAberta = () => aberta;
