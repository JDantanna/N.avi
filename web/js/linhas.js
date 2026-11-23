// A linha de uma tarefa, usada na lista de Tarefas e na agenda do Calendário: círculo de concluir, título, detalhes
// (checklist, repetição, tags) e, à direita, a data e a hora, cada uma com a sua legenda (calendário e relógio).

import { h, icone } from "./dom.js";
import { corDaTag, partesQuando, rgb } from "./modelo.js";

/** @param {object} ctx contexto do app (armazém, abrirDetalhe, alternar) */
export function linhaTarefa(ctx, t, grupo) {
  const atrasada = grupo === "Atrasadas";
  const quando = partesQuando(t, grupo);
  const itens = t.subtasks.length;
  const feitos = t.subtasks.filter((s) => s.done).length;
  const cores = ctx.armazem.coresDasTags;

  const detalhes = [];
  if (itens) detalhes.push(h("span", { class: "detalhe" }, icone("lista", 13), `${feitos}/${itens}`));
  if (t.repeat !== "None") detalhes.push(h("span", { class: "detalhe", title: "Se repete" }, icone("repetir", 13)));
  for (const tag of t.tags) detalhes.push(h("span", { class: "tag-texto", style: { color: rgb(corDaTag(cores, tag)) } }, `#${tag}`));
  if (t.notes.trim()) detalhes.push(h("span", { class: "detalhe", title: "Tem anotações" }, icone("nota", 13)));

  const marca = h(
    "button",
    {
      class: "marca",
      style: { "--cor": rgb(atrasada ? [255, 130, 130] : t.color) },
      "aria-label": t.done ? "Reabrir a tarefa" : "Concluir a tarefa",
      onclick: (e) => {
        e.stopPropagation();
        ctx.alternar(t.id);
      },
    },
    t.done ? icone("check", 15) : null,
  );

  const direita = [];
  if (quando.dia) direita.push(h("span", { class: "quando-dia" }, icone("calendario", 12), quando.dia));
  if (quando.hora) direita.push(h("span", { class: "quando-hora" }, icone("relogio", 12), quando.hora));

  return h(
    "div",
    {
      class: ["linha", t.done && "feita", atrasada && "atrasada"].filter(Boolean).join(" "),
      role: "button",
      tabindex: "0",
      onclick: () => ctx.abrirDetalhe(t.id),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ctx.abrirDetalhe(t.id);
        }
      },
    },
    marca,
    h("div", { class: "texto" }, h("div", { class: "titulo" }, t.title || "(sem título)"), detalhes.length ? h("div", { class: "detalhes" }, detalhes) : null),
    direita.length ? h("div", { class: `quando${direita.length === 1 ? " so-um" : ""}` }, direita) : null,
  );
}
