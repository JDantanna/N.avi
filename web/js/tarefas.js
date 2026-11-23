// Aba Tarefas: listas por filtro (Hoje, Próximos, Todas, Concluídas), seções por data que recolhem, filtro por tag
// e o campo de nova tarefa que entende data, hora e tags escritas no texto.

import { DIAS, MESES, partes, somaDias, diaDaSemana, rotuloDia } from "./datas.js";
import { h, icone, trocar } from "./dom.js";
import { linhaTarefa } from "./linhas.js";
import { FILTROS, GRUPOS, ROTULO_GRUPO, contar, corDaTag, grupoDe, noFiltro, ordenar, rgb } from "./modelo.js";
import { analisar } from "./rapido.js";

/**
 * O campo de nova tarefa. `dataPadrao()` diz em que dia a tarefa cai quando o texto não traz data
 * (e `null` deixa sem data); `tagPadrao()` é a tag do filtro ativo, se houver.
 */
export function criarRapido(ctx, { dataPadrao, tagPadrao = () => null, dica = "Nova tarefa" }) {
  const entrada = h("input", {
    type: "text",
    class: "rapido-campo",
    placeholder: dica,
    enterkeyhint: "done",
    autocomplete: "off",
    autocapitalize: "sentences",
    spellcheck: "false",
    "aria-label": dica,
  });
  const previa = h("div", { class: "rapido-previa", "aria-live": "polite" });
  const botao = h("button", { class: "rapido-botao", type: "submit", "aria-label": "Criar tarefa" }, icone("mais", 22));

  const entender = () => analisar(entrada.value, ctx.hoje());

  const atualizarPrevia = () => {
    const q = entender();
    const partesPrevia = [];
    if (q.data) partesPrevia.push(h("span", {}, icone("calendario", 13), rotuloDia(q.data, ctx.hoje())));
    if (q.hora) partesPrevia.push(h("span", {}, icone("relogio", 13), q.hora.slice(0, 5)));
    for (const tag of q.tags) partesPrevia.push(h("span", {}, `#${tag}`));
    trocar(previa, partesPrevia);
    previa.hidden = partesPrevia.length === 0;
    botao.disabled = !q.titulo;
  };
  entrada.addEventListener("input", atualizarPrevia);

  const form = h(
    "form",
    {
      class: "rapido",
      onsubmit: (e) => {
        e.preventDefault();
        const q = entender();
        if (!q.titulo) return;
        const data = q.data ?? (q.hora ? ctx.hoje() : dataPadrao());
        const tags = [...q.tags];
        const filtroTag = tagPadrao();
        if (filtroTag && !tags.includes(filtroTag)) tags.push(filtroTag);
        ctx.armazem.adicionar(q.titulo, data, { time: q.hora, tags });
        entrada.value = "";
        atualizarPrevia();
        // O foco fica no campo: dá para escrever a próxima tarefa em seguida.
        entrada.focus({ preventScroll: true });
      },
    },
    previa,
    h("div", { class: "rapido-linha" }, entrada, botao),
  );
  atualizarPrevia();
  return form;
}

function textoVazio(filtro, comTag) {
  if (comTag) return ["Nenhuma tarefa com esta tag aqui.", "Toque na tag de novo para ver todas."];
  switch (filtro) {
    case "hoje": return ["Nada para hoje.", "Escreva abaixo para criar a primeira tarefa."];
    case "proximos": return ["Nada nos próximos dias.", "Tente: Dentista sexta 15h"];
    case "concluidas": return ["Nada concluído ainda.", "O que você concluir aparece aqui."];
    default: return ["Nenhuma tarefa ainda.", "Escreva abaixo para criar a primeira."];
  }
}

export function criarTarefas(ctx) {
  const { armazem, estado } = ctx;
  const cabeca = h("header", { class: "cabeca" });
  const filtros = h("div", { class: "filtros", role: "tablist", "aria-label": "Listas" });
  const tags = h("div", { class: "faixa-tags", "aria-label": "Tags" });
  const rolagem = h("div", { class: "rolagem lista" });
  const rapido = criarRapido(ctx, {
    dica: "Nova tarefa — ex.: Reunião amanhã 14h #trabalho",
    dataPadrao: () => (estado.filtro === "hoje" ? ctx.hoje() : estado.filtro === "proximos" ? somaDias(ctx.hoje(), 1) : null),
    tagPadrao: () => estado.tag,
  });
  const raiz = h("section", { class: "tela tela-tarefas" }, cabeca, filtros, tags, rolagem, rapido);
  const fechados = new Set(["Concluidas"]);

  function atualizar() {
    const hoje = ctx.hoje();
    const agora = ctx.agora();
    const todas = armazem.tarefas;

    // Cabeçalho: o nome da lista, o resumo e, em Hoje, o progresso do dia.
    const pendentes = contar(todas, estado.filtro, hoje, agora);
    const filtro = FILTROS.find((f) => f.id === estado.filtro);
    const resumo = [];
    if (estado.filtro === "hoje") {
      const { d, m } = partes(hoje);
      resumo.push(`${DIAS[diaDaSemana(hoje)]}, ${d} de ${MESES[m - 1]}`);
    }
    resumo.push(estado.filtro === "concluidas" ? `${pendentes} ${pendentes === 1 ? "tarefa" : "tarefas"}` : `${pendentes} ${pendentes === 1 ? "pendente" : "pendentes"}`);
    if (estado.tag) resumo.unshift(`#${estado.tag}`);
    const feitasHoje = estado.filtro === "hoje" ? todas.filter((t) => t.done && noFiltro("hoje", "Concluidas", t, hoje)).length : 0;
    const total = feitasHoje + pendentes;
    trocar(
      cabeca,
      h("h1", {}, filtro.rotulo),
      h("p", { class: "resumo" }, resumo.join(" · ")),
      estado.filtro === "hoje" && total > 0
        ? h("div", { class: "progresso", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(feitasHoje) }, h("span", { style: { width: `${(100 * feitasHoje) / total}%` } }))
        : null,
    );

    // As listas, com o número ao lado.
    trocar(
      filtros,
      FILTROS.map((f) => {
        const n = contar(todas, f.id, hoje, agora);
        return h(
          "button",
          { class: `filtro${f.id === estado.filtro ? " ativo" : ""}`, role: "tab", "aria-selected": String(f.id === estado.filtro), onclick: () => ctx.mudarEstado({ filtro: f.id }) },
          f.rotulo,
          n > 0 && f.id !== "concluidas" ? h("span", { class: "contagem" }, n) : null,
        );
      }),
    );

    // As tags: tocar filtra, tocar de novo desfaz.
    const lista = armazem.tags();
    tags.hidden = lista.length === 0;
    trocar(
      tags,
      lista.map((tag) =>
        h(
          "button",
          {
            class: `chip-tag${estado.tag === tag ? " ativo" : ""}`,
            style: { "--cor": rgb(corDaTag(armazem.coresDasTags, tag)) },
            "aria-pressed": String(estado.tag === tag),
            onclick: () => ctx.mudarEstado({ tag: estado.tag === tag ? null : tag }),
          },
          h("i"),
          tag,
        ),
      ),
    );

    // A lista em seções.
    const rolagemAntes = rolagem.scrollTop;
    const grupos = new Map(GRUPOS.map((g) => [g, []]));
    for (const t of todas) {
      const g = grupoDe(t, hoje, agora);
      if (noFiltro(estado.filtro, g, t, hoje) && (!estado.tag || t.tags.includes(estado.tag))) grupos.get(g).push(t);
    }
    const secoes = [];
    for (const g of GRUPOS) {
      const itens = ordenar(grupos.get(g));
      if (!itens.length) continue;
      // Em Concluídas todas são da mesma seção: o cabeçalho só repetiria o título.
      if (estado.filtro === "concluidas") {
        secoes.push(...itens.map((t) => linhaTarefa(ctx, t, g)));
        continue;
      }
      const fechada = fechados.has(g);
      secoes.push(
        h(
          "section",
          { class: `secao${g === "Atrasadas" ? " atrasadas" : ""}${fechada ? " fechada" : ""}` },
          h(
            "button",
            {
              class: "secao-cabeca",
              "aria-expanded": String(!fechada),
              onclick: () => {
                if (!fechados.delete(g)) fechados.add(g);
                atualizar();
              },
            },
            icone("baixo", 16),
            h("span", { class: "secao-nome" }, ROTULO_GRUPO[g]),
            h("span", { class: "secao-conta" }, itens.length),
          ),
          fechada ? null : h("div", { class: "secao-itens" }, itens.map((t) => linhaTarefa(ctx, t, g))),
        ),
      );
    }
    if (!secoes.length) {
      const [titulo, dica] = textoVazio(estado.filtro, Boolean(estado.tag));
      secoes.push(h("div", { class: "vazio" }, h("p", { class: "vazio-titulo" }, titulo), h("p", {}, dica)));
    }
    trocar(rolagem, secoes);
    rolagem.scrollTop = rolagemAntes;
  }

  return { el: raiz, atualizar };
}
