// Ajustes e dados: semana começando no domingo, exportar e importar o tasks.json (até a sincronização chegar,
// é assim que as tarefas passam entre o desktop e o iPhone) e a versão do app.

import { h, icone } from "./dom.js";
import { abrirFolha } from "./folha.js";
import { VERSAO } from "./versao.js";

/** Baixa (ou compartilha, onde o aparelho deixa) o tasks.json no formato do desktop. */
async function exportar(ctx) {
  ctx.armazem.gravar();
  const texto = ctx.armazem.exportar();
  const arquivo = new File([texto], "tasks.json", { type: "application/json" });
  try {
    if (navigator.canShare?.({ files: [arquivo] })) {
      await navigator.share({ files: [arquivo], title: "N.avi: tarefas" });
      return;
    }
  } catch (erro) {
    // Cancelar a folha de compartilhar não é erro.
    if (erro?.name === "AbortError") return;
  }
  const url = URL.createObjectURL(arquivo);
  const link = h("a", { href: url, download: "tasks.json" });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function importar(ctx, arquivo) {
  if (!arquivo) return;
  let texto;
  try {
    texto = await arquivo.text();
  } catch {
    ctx.avisar("Não consegui ler o arquivo.");
    return;
  }
  let quantas;
  try {
    // Conferir antes de trocar: um arquivo errado não pode apagar as tarefas de agora.
    const prova = JSON.parse(texto);
    if (!Array.isArray(prova?.tasks)) throw new Error("sem tarefas");
    quantas = prova.tasks.length;
  } catch {
    ctx.avisar("Este arquivo não é um tasks.json do N.avi.");
    return;
  }
  const agora = ctx.armazem.tarefas.length;
  const ok = confirm(`Trocar as ${agora} ${agora === 1 ? "tarefa" : "tarefas"} deste aparelho pelas ${quantas} do arquivo?\n\nAs tarefas de agora serão perdidas (exporte antes, se quiser guardá-las).`);
  if (!ok) return;
  try {
    ctx.armazem.importar(texto);
    ctx.avisar(`${quantas} ${quantas === 1 ? "tarefa importada" : "tarefas importadas"}.`);
  } catch (erro) {
    ctx.avisar(erro.message);
  }
}

export function abrirAjustes(ctx) {
  return abrirFolha({
    classe: "folha-ajustes",
    titulo: "Ajustes e dados",
    montar: () => {
      const domingo = h("input", {
        type: "checkbox", role: "switch", id: "ajuste-domingo", checked: ctx.configuracoes.semanaNoDomingo,
        onchange: (e) => ctx.mudarConfiguracao({ semanaNoDomingo: e.target.checked }),
      });
      const arquivo = h("input", {
        type: "file", accept: ".json,application/json", hidden: true,
        onchange: async (e) => {
          await importar(ctx, e.target.files?.[0]);
          e.target.value = "";
        },
      });
      return h(
        "div",
        { class: "ajustes" },
        h("div", { class: "bloco" },
          h("label", { class: "linha-campo interruptor", for: "ajuste-domingo" }, h("span", {}, "Semana começa no domingo"), domingo)),
        h("div", { class: "bloco" },
          h("h3", {}, "Dados deste aparelho"),
          h("p", { class: "dica" }, "As tarefas ficam guardadas aqui, no iPhone. Até a sincronização com a nuvem chegar, o tasks.json leva as tarefas entre o computador e o celular."),
          h("button", { class: "botao-largo", type: "button", onclick: () => exportar(ctx) }, icone("exportar", 20), "Exportar tasks.json"),
          h("button", { class: "botao-largo", type: "button", onclick: () => arquivo.click() }, icone("importar", 20), "Importar tasks.json"),
          arquivo,
          h("p", { class: "dica" }, "No computador, o arquivo fica em %APPDATA%\\Navi\\tasks.json."),
        ),
        h("div", { class: "bloco sobre" },
          h("p", {}, `N.avi para o iPhone · versão ${VERSAO}`),
          h("p", { class: "dica" }, "Instalado na tela de início, funciona sem internet.")),
      );
    },
  });
}
