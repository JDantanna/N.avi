// Detalhes de uma tarefa, numa folha: título, data e hora, repetição, tags, checklist, anotações e cor.
// Cada mudança vai direto para o armazém (não há botão de salvar); a folha só se refaz quando a forma dela muda
// (uma tag ou um item novo, a repetição ligada), guardando o foco.

import { somaDias } from "./datas.js";
import { h, icone } from "./dom.js";
import { abrirFolha } from "./folha.js";
import { corDaTag, rgb } from "./modelo.js";
import { REPETE, ROTULO_REPETE, definirAncora, unidade } from "./recorrencia.js";

/** Cores para escolher: as mesmas de partida das tags, que combinam com o tema escuro. */
const CORES = [[110, 142, 251], [236, 112, 99], [88, 196, 141], [240, 178, 70], [176, 124, 230], [80, 190, 210], [230, 120, 170], [160, 170, 90]];

const mesmaCor = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function abrirDetalhe(ctx, id, aoFechar = () => {}) {
  const { armazem } = ctx;
  if (!armazem.porId(id)) return null;
  const novoEvento = "detalhe";
  const alterar = (fn) => armazem.alterar(id, fn, novoEvento);

  const folha = abrirFolha({
    classe: "folha-detalhe",
    titulo: "Tarefa",
    acoes: [
      h("button", { class: "botao-icone perigo", "aria-label": "Excluir a tarefa", onclick: () => {
        const r = armazem.remover(id);
        folha.fechar();
        if (r) ctx.avisar("Tarefa excluída", () => armazem.restaurar(r.antes, r.indice));
      } }, icone("lixeira", 21)),
    ],
    aoFechar,
    montar: () => h("div", { class: "detalhe-conteudo" }),
  });

  /** Refaz o conteúdo; `foco` é o seletor do campo que volta a ter o cursor. */
  function montar(foco = null) {
    const t = armazem.porId(id);
    if (!t) return;
    const conteudo = folha.corpo.firstElementChild;
    const rolagem = folha.corpo.scrollTop;

    // --- Título e concluída
    const titulo = h("textarea", {
      class: "campo-titulo",
      rows: "1",
      "aria-label": "Título",
      placeholder: "Título da tarefa",
      oninput: (e) => {
        ajustarAltura(e.target);
        alterar((x) => {
          x.title = e.target.value.replace(/[\r\n]+/g, " ");
        });
      },
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.target.blur();
        }
      },
    });
    titulo.value = t.title;

    const concluida = h(
      "button",
      {
        class: `chip-concluir${t.done ? " feita" : ""}`,
        "aria-pressed": String(t.done),
        onclick: () => {
          const r = armazem.alternarConcluida(id, ctx.hoje());
          if (r) ctx.avisar(r.reagendou ? `Próxima data: ${r.tarefa.date.slice(8)}/${r.tarefa.date.slice(5, 7)}` : r.tarefa.done ? "Tarefa concluída" : "Tarefa reaberta", () => armazem.restaurar(r.antes, r.indice));
          montar();
        },
      },
      icone(t.done ? "check" : "concluidas", 18),
      t.done ? "Concluída" : "Marcar como concluída",
    );

    // --- Quando
    const data = h("input", {
      type: "date",
      class: "campo",
      "aria-label": "Data",
      value: t.date ?? "",
      onchange: (e) => {
        armazem.alterar(id, (x) => {
          x.date = e.target.value || null;
          definirAncora(x);
        }, novoEvento);
        montar();
      },
    });
    const atalhoData = (rotulo, valor) =>
      h("button", { class: "mini", type: "button", onclick: () => {
        armazem.alterar(id, (x) => {
          x.date = valor;
          definirAncora(x);
        }, novoEvento);
        montar();
      } }, rotulo);
    const hora = h("input", {
      type: "time",
      class: "campo",
      "aria-label": "Hora",
      value: t.time ? t.time.slice(0, 5) : "",
      onchange: (e) => alterar((x) => {
        x.time = e.target.value ? `${e.target.value}:00` : null;
      }),
    });

    // --- Repetição
    const repete = h(
      "select",
      {
        class: "campo",
        "aria-label": "Repetir",
        onchange: (e) => {
          alterar((x) => {
            x.repeat = e.target.value;
            definirAncora(x);
            if (x.repeat === "None") x.repeat_times = null;
          });
          montar();
        },
      },
      REPETE.map((r) => h("option", { value: r, selected: r === t.repeat }, ROTULO_REPETE[r])),
    );
    const linhasRepete = [h("div", { class: "linha-campo" }, h("label", {}, "Repetir"), repete)];
    if (t.repeat !== "None") {
      linhasRepete.push(
        h(
          "div",
          { class: "linha-campo" },
          h("label", {}, "A cada"),
          h(
            "div",
            { class: "grupo-inline" },
            h("input", {
              type: "number", inputmode: "numeric", min: "1", max: "365", class: "campo curto", value: String(t.every), "aria-label": "Intervalo da repetição",
              onchange: (e) => {
                const n = Math.min(365, Math.max(1, Math.floor(Number(e.target.value)) || 1));
                alterar((x) => {
                  x.every = n;
                });
                montar();
              },
            }),
            h("span", { class: "unidade" }, unidade(t.repeat, t.every)),
          ),
        ),
        h(
          "div",
          { class: "linha-campo" },
          h("label", {}, "Termina"),
          h(
            "div",
            { class: "grupo-inline" },
            h(
              "select",
              {
                class: "campo",
                "aria-label": "Quando a repetição termina",
                onchange: (e) => {
                  alterar((x) => {
                    x.repeat_times = e.target.value === "vezes" ? (x.repeat_times ?? 3) : null;
                  });
                  montar();
                },
              },
              h("option", { value: "nunca", selected: t.repeat_times == null }, "Nunca"),
              h("option", { value: "vezes", selected: t.repeat_times != null }, "Após um número de vezes"),
            ),
            t.repeat_times != null
              ? h("input", {
                type: "number", inputmode: "numeric", min: "1", max: "999", class: "campo curto", value: String(t.repeat_times), "aria-label": "Número de ocorrências",
                onchange: (e) => alterar((x) => {
                  x.repeat_times = Math.min(999, Math.max(1, Math.floor(Number(e.target.value)) || 1));
                }),
              })
              : null,
          ),
        ),
      );
      if (t.repeat_times != null) linhasRepete.push(h("p", { class: "dica" }, "Contando com a ocorrência desta data."));
      if (!t.date) linhasRepete.push(h("p", { class: "dica aviso" }, "Escolha uma data para a repetição valer."));
    }

    // --- Tags
    const cores = armazem.coresDasTags;
    const chipTag = (tag, ativa) => h(
      "button",
      {
        class: `chip-tag${ativa ? " ativo" : ""}`,
        style: { "--cor": rgb(corDaTag(cores, tag)) },
        "aria-label": ativa ? `Tirar a tag ${tag}` : `Pôr a tag ${tag}`,
        onclick: () => {
          alterar((x) => {
            x.tags = ativa ? x.tags.filter((g) => g !== tag) : [...x.tags, tag];
          });
          montar();
        },
      },
      h("i"),
      tag,
      ativa ? h("span", { class: "tirar", "aria-hidden": "true" }, "×") : null,
    );
    const novaTag = h("input", {
      type: "text", class: "campo curto largo", placeholder: "nova tag", enterkeyhint: "done", autocapitalize: "none", autocomplete: "off", "aria-label": "Nova tag", "data-foco": "tag",
      onkeydown: (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const tag = e.target.value.trim().replace(/^#+/, "");
        if (!tag || t.tags.includes(tag)) return;
        alterar((x) => {
          x.tags = [...x.tags, tag];
        });
        montar("[data-foco=tag]");
      },
    });
    const existentes = armazem.tags().filter((g) => !t.tags.includes(g));

    // --- Checklist
    const itens = t.subtasks.map((s, i) =>
      h(
        "div",
        { class: `item${s.done ? " feito" : ""}` },
        h("button", { class: "marca pequena", style: { "--cor": rgb(t.color) }, "aria-label": s.done ? "Desmarcar o item" : "Marcar o item", onclick: () => {
          alterar((x) => {
            x.subtasks[i].done = !x.subtasks[i].done;
          });
          montar();
        } }, s.done ? icone("check", 13) : null),
        h("input", {
          type: "text", class: "campo item-texto", value: s.title, "aria-label": `Item ${i + 1}`, enterkeyhint: "done",
          oninput: (e) => alterar((x) => {
            x.subtasks[i].title = e.target.value;
          }),
        }),
        h("button", { class: "botao-icone pequeno", "aria-label": "Remover o item", onclick: () => {
          alterar((x) => {
            x.subtasks.splice(i, 1);
          });
          montar();
        } }, icone("fechar", 16)),
      ),
    );
    const novoItem = h("input", {
      type: "text", class: "campo", placeholder: "Adicionar item e Enter", enterkeyhint: "done", autocomplete: "off", "aria-label": "Novo item do checklist", "data-foco": "item",
      onkeydown: (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const titulo = e.target.value.trim();
        if (!titulo) return;
        alterar((x) => {
          x.subtasks.push({ title: titulo, done: false });
        });
        montar("[data-foco=item]");
      },
    });

    // --- Anotações e cor
    const notas = h("textarea", {
      class: "campo notas", rows: "4", placeholder: "Anotações", "aria-label": "Anotações",
      oninput: (e) => alterar((x) => {
        x.notes = e.target.value;
      }),
    });
    notas.value = t.notes;
    const cor = h(
      "div",
      { class: "cores", role: "radiogroup", "aria-label": "Cor da tarefa" },
      CORES.map((c) =>
        h("button", {
          class: `cor${mesmaCor(c, t.color) ? " ativa" : ""}`, style: { "--cor": rgb(c) }, role: "radio", "aria-checked": String(mesmaCor(c, t.color)), "aria-label": `Cor ${rgb(c)}`,
          onclick: () => {
            alterar((x) => {
              x.color = [...c];
            });
            montar();
          },
        }),
      ),
    );

    const feitos = t.subtasks.filter((s) => s.done).length;
    conteudo.replaceChildren(
      titulo,
      concluida,
      h(
        "div",
        { class: "bloco" },
        h("div", { class: "linha-campo" }, h("label", {}, "Data"), h("div", { class: "grupo-inline" }, data)),
        h("div", { class: "atalhos" }, atalhoData("Hoje", ctx.hoje()), atalhoData("Amanhã", somaDias(ctx.hoje(), 1)), atalhoData("Sem data", null)),
        h("div", { class: "linha-campo" }, h("label", {}, "Hora"), h("div", { class: "grupo-inline" }, hora, t.time ? h("button", { class: "mini", type: "button", onclick: () => {
          alterar((x) => {
            x.time = null;
          });
          montar();
        } }, "Sem hora") : null)),
      ),
      h("div", { class: "bloco" }, linhasRepete),
      h("div", { class: "bloco" }, h("h3", {}, "Tags"), h("div", { class: "tags-tarefa" }, t.tags.map((g) => chipTag(g, true)), novaTag), existentes.length ? h("div", { class: "tags-existentes" }, h("span", { class: "dica" }, "Já usadas:"), existentes.map((g) => chipTag(g, false))) : null),
      h(
        "div",
        { class: "bloco" },
        h("h3", {}, "Checklist", t.subtasks.length ? h("span", { class: "dica" }, ` ${feitos}/${t.subtasks.length}`) : null),
        t.subtasks.length ? h("div", { class: "progresso fino" }, h("span", { style: { width: `${(100 * feitos) / t.subtasks.length}%` } })) : null,
        itens,
        novoItem,
      ),
      h("div", { class: "bloco" }, h("h3", {}, "Anotações"), notas),
      h("div", { class: "bloco" }, h("h3", {}, "Cor"), cor),
    );
    ajustarAltura(titulo);
    if (foco) conteudo.querySelector(foco)?.focus({ preventScroll: true });
    folha.corpo.scrollTop = rolagem;
  }

  montar();
  return { folha, montar, id };
}

function ajustarAltura(campo) {
  campo.style.height = "auto";
  campo.style.height = `${campo.scrollHeight}px`;
}
