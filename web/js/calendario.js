// Aba Calendário: o mês em grade (com a agenda do dia escolhido embaixo) e a semana em lista de dias.
// No iPhone cada dia mostra pontos coloridos; no iPad, as próprias tarefas dentro da célula.

import { DIAS, DIAS_CURTOS, MESES, diaDaSemana, diaMes, nomeDoMes, partes, primeiroDoMes, somaDias, somaMeses } from "./datas.js";
import { h, icone, trocar } from "./dom.js";
import { linhaTarefa } from "./linhas.js";
import { doDia, grupoDe, rgb } from "./modelo.js";
import { atrasada } from "./recorrencia.js";
import { criarRapido } from "./tarefas.js";

const MAIUSCULA = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** O primeiro dia da semana que contém `iso` (segunda, ou domingo se `domingo`). */
export function inicioDaSemana(iso, domingo) {
  const indice = domingo ? (diaDaSemana(iso) + 1) % 7 : diaDaSemana(iso);
  return somaDias(iso, -indice);
}

export function criarCalendario(ctx) {
  const { armazem, estado } = ctx;
  const cabeca = h("header", { class: "cabeca cabeca-calendario" });
  const rolagem = h("div", { class: "rolagem calendario" });
  const rapido = criarRapido(ctx, { dica: "Nova tarefa para este dia", dataPadrao: () => estado.diaSel });
  const raiz = h("section", { class: "tela tela-calendario" }, cabeca, rolagem, rapido);

  const mover = (sentido) => {
    if (estado.calModo === "mes") {
      const novo = somaMeses(primeiroDoMes(estado.ancora), sentido, 1);
      ctx.mudarEstado({ ancora: novo, diaSel: novo.slice(0, 7) === ctx.hoje().slice(0, 7) ? ctx.hoje() : novo });
    } else {
      const novo = somaDias(estado.ancora, 7 * sentido);
      ctx.mudarEstado({ ancora: novo, diaSel: novo });
    }
  };
  const irParaHoje = () => ctx.mudarEstado({ ancora: ctx.hoje(), diaSel: ctx.hoje() });

  /** Deslizar o dedo na grade troca o mês (ou a semana). */
  function gestos(el) {
    let ini = null;
    el.addEventListener("touchstart", (e) => {
      ini = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (!ini) return;
      const dx = e.changedTouches[0].clientX - ini.x;
      const dy = e.changedTouches[0].clientY - ini.y;
      ini = null;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 45) mover(dx < 0 ? 1 : -1);
    });
  }

  function titulo() {
    if (estado.calModo === "mes") return MAIUSCULA(nomeDoMes(estado.ancora));
    const inicio = inicioDaSemana(estado.ancora, ctx.configuracoes.semanaNoDomingo);
    return `${diaMes(inicio)} – ${diaMes(somaDias(inicio, 6), true)}`;
  }

  function celulas(mes, hoje, agora) {
    const domingo = ctx.configuracoes.semanaNoDomingo;
    const primeiro = primeiroDoMes(mes);
    const { y, m } = partes(primeiro);
    const dias = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const deslocamento = domingo ? (diaDaSemana(primeiro) + 1) % 7 : diaDaSemana(primeiro);
    const linhas = Math.ceil((deslocamento + dias) / 7);
    const inicio = somaDias(primeiro, -deslocamento);
    const nomes = domingo ? ["dom", ...DIAS_CURTOS.slice(0, 6)] : DIAS_CURTOS;
    const grade = [h("div", { class: "grade-cabeca", "aria-hidden": "true" }, nomes.map((n) => h("span", {}, n)))];
    const corpo = [];
    for (let i = 0; i < linhas * 7; i++) {
      const dia = somaDias(inicio, i);
      const tarefas = doDia(armazem.tarefas, dia, true);
      const pendentes = tarefas.filter((t) => !t.done);
      const dosMes = dia.slice(0, 7) === primeiro.slice(0, 7);
      const ehHoje = dia === hoje;
      const classes = ["celula", !dosMes && "fora", ehHoje && "hoje", dia === estado.diaSel && "sel"].filter(Boolean).join(" ");
      const pontos = pendentes.slice(0, 3).map((t) => h("i", { style: { "--cor": atrasada(t, hoje, agora) ? "rgb(255 120 120)" : rgb(t.color) } }));
      const chips = tarefas.slice(0, 3).map((t) =>
        h("span", { class: `chip-dia${t.done ? " feita" : ""}${grupoDe(t, hoje, agora) === "Atrasadas" ? " atrasada" : ""}`, style: { "--cor": rgb(t.color) } }, t.time ? h("b", {}, t.time.slice(0, 5)) : null, t.title),
      );
      const { d } = partes(dia);
      corpo.push(
        h(
          "button",
          {
            class: classes,
            type: "button",
            "aria-label": `${d} de ${MESES[partes(dia).m - 1]}${tarefas.length ? `, ${tarefas.length} ${tarefas.length === 1 ? "tarefa" : "tarefas"}` : ""}`,
            "aria-pressed": String(dia === estado.diaSel),
            onclick: () => ctx.mudarEstado({ diaSel: dia, ancora: dosMes ? estado.ancora : dia }),
          },
          h("span", { class: "num" }, d),
          pontos.length ? h("span", { class: "pontos" }, pontos, pendentes.length > 3 ? h("small", {}, `+${pendentes.length - 3}`) : null) : null,
          chips.length ? h("span", { class: "chips" }, chips, tarefas.length > 3 ? h("small", {}, `+${tarefas.length - 3} mais`) : null) : null,
        ),
      );
    }
    const gradeEl = h("div", { class: "grade", style: { "--linhas": linhas } }, ...grade, h("div", { class: "grade-corpo" }, corpo));
    gestos(gradeEl);
    return gradeEl;
  }

  function agenda(dia, hoje, agora, comTitulo = true) {
    const tarefas = doDia(armazem.tarefas, dia, true);
    const { d, m } = partes(dia);
    return h(
      "section",
      { class: `agenda${dia === hoje ? " e-hoje" : ""}` },
      comTitulo ? h("h2", {}, h("span", {}, `${MAIUSCULA(DIAS[diaDaSemana(dia)])}, ${d} de ${MESES[m - 1]}`), h("small", {}, tarefas.length ? `${tarefas.length} ${tarefas.length === 1 ? "tarefa" : "tarefas"}` : "")) : null,
      tarefas.length
        ? h("div", { class: "agenda-itens" }, tarefas.map((t) => linhaTarefa(ctx, t, grupoDe(t, hoje, agora))))
        : h("p", { class: "vazio-dia" }, "Nenhuma tarefa neste dia."),
    );
  }

  function semana(hoje, agora) {
    const inicio = inicioDaSemana(estado.ancora, ctx.configuracoes.semanaNoDomingo);
    const dias = Array.from({ length: 7 }, (_, i) => somaDias(inicio, i));
    const el = h(
      "div",
      { class: "semana" },
      dias.map((dia) => {
        const tarefas = doDia(armazem.tarefas, dia, true);
        const { d } = partes(dia);
        return h(
          "section",
          { class: `dia-semana${dia === hoje ? " hoje" : ""}${dia === estado.diaSel ? " sel" : ""}` },
          h(
            "button",
            { class: "dia-semana-cabeca", type: "button", onclick: () => ctx.mudarEstado({ diaSel: dia }), "aria-pressed": String(dia === estado.diaSel) },
            h("span", { class: "dia-semana-nome" }, DIAS_CURTOS[diaDaSemana(dia)]),
            h("span", { class: "num" }, d),
            tarefas.length ? h("small", {}, `${tarefas.length}`) : null,
          ),
          tarefas.length ? h("div", { class: "agenda-itens" }, tarefas.map((t) => linhaTarefa(ctx, t, grupoDe(t, hoje, agora)))) : h("p", { class: "vazio-dia" }, "Nada neste dia"),
        );
      }),
    );
    gestos(el);
    return el;
  }

  function atualizar() {
    const hoje = ctx.hoje();
    const agora = ctx.agora();
    trocar(
      cabeca,
      h(
        "div",
        { class: "cal-barra" },
        h("button", { class: "botao-icone", "aria-label": estado.calModo === "mes" ? "Mês anterior" : "Semana anterior", onclick: () => mover(-1) }, icone("esquerda", 22)),
        h("h1", { class: "cal-titulo" }, titulo()),
        h("button", { class: "botao-icone", "aria-label": estado.calModo === "mes" ? "Próximo mês" : "Próxima semana", onclick: () => mover(1) }, icone("direita", 22)),
      ),
      h(
        "div",
        { class: "cal-controles" },
        h("div", { class: "segmentos", role: "tablist", "aria-label": "Visão do calendário" },
          [["mes", "Mês"], ["semana", "Semana"]].map(([id, rotulo]) =>
            h("button", { class: `segmento${estado.calModo === id ? " ativo" : ""}`, role: "tab", "aria-selected": String(estado.calModo === id), onclick: () => ctx.mudarEstado({ calModo: id }) }, rotulo),
          ),
        ),
        h("button", { class: "mini", type: "button", onclick: irParaHoje }, "Hoje"),
      ),
    );
    const antes = rolagem.scrollTop;
    if (estado.calModo === "mes") {
      trocar(rolagem, h("div", { class: "cal-mes" }, celulas(estado.ancora, hoje, agora), agenda(estado.diaSel, hoje, agora)));
    } else {
      trocar(rolagem, semana(hoje, agora));
    }
    rolagem.scrollTop = antes;
    rapido.querySelector("input").placeholder = estado.diaSel === hoje ? "Nova tarefa para hoje" : `Nova tarefa para ${diaMes(estado.diaSel)}`;
  }

  return { el: raiz, atualizar };
}
