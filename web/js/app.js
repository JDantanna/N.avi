// N.avi para o iPhone: monta a casca (topo, telas, abas), liga o armazém às telas e registra o modo offline.

import { abrirAjustes } from "./ajustes.js";
import { Armazem, CHAVE } from "./armazem.js";
import { criarCalendario } from "./calendario.js";
import { agoraHMS, diaMes, hojeIso } from "./datas.js";
import { abrirDetalhe } from "./detalhe.js";
import { fada, h, icone } from "./dom.js";
import { folhaAberta } from "./folha.js";
import { criarTarefas } from "./tarefas.js";

const CHAVE_UI = "navi.ui.v1";
const ESTADO_PADRAO = { aba: "tarefas", filtro: "hoje", tag: null, calModo: "mes" };
const CONFIG_PADRAO = { semanaNoDomingo: false };

function lerJson(chave, padrao) {
  try {
    return { ...padrao, ...JSON.parse(localStorage.getItem(chave) ?? "{}") };
  } catch {
    return { ...padrao };
  }
}

function iniciar() {
  const armazem = new Armazem();
  const salvo = lerJson(CHAVE_UI, { ...ESTADO_PADRAO, configuracoes: CONFIG_PADRAO });
  const hoje = () => hojeIso();
  const estado = {
    aba: salvo.aba === "calendario" ? "calendario" : "tarefas",
    filtro: ["hoje", "proximos", "todas", "concluidas"].includes(salvo.filtro) ? salvo.filtro : "hoje",
    tag: null, // o filtro de tag vale só até fechar o app
    calModo: salvo.calModo === "semana" ? "semana" : "mes",
    ancora: hoje(),
    diaSel: hoje(),
  };
  const configuracoes = { ...CONFIG_PADRAO, ...(salvo.configuracoes ?? {}) };

  const guardarUi = () => {
    try {
      localStorage.setItem(CHAVE_UI, JSON.stringify({ aba: estado.aba, filtro: estado.filtro, calModo: estado.calModo, configuracoes }));
    } catch { /* sem espaço ou modo privado: a escolha só não é lembrada */ }
  };

  let detalheAberto = null;

  const ctx = {
    armazem,
    estado,
    configuracoes,
    hoje,
    agora: agoraHMS,
    mudarEstado(parte) {
      Object.assign(estado, parte);
      guardarUi();
      desenhar();
    },
    mudarConfiguracao(parte) {
      Object.assign(configuracoes, parte);
      guardarUi();
      desenhar();
    },
    abrirDetalhe(id) {
      detalheAberto = abrirDetalhe(ctx, id, () => {
        detalheAberto = null;
      });
    },
    /** Conclui ou reabre, com o aviso para desfazer. */
    alternar(id) {
      const r = armazem.alternarConcluida(id, hoje());
      if (!r) return;
      const mensagem = r.reagendou ? `Próxima data: ${diaMes(r.tarefa.date)}` : r.tarefa.done ? "Tarefa concluída" : "Tarefa reaberta";
      ctx.avisar(mensagem, () => armazem.restaurar(r.antes, r.indice));
    },
    avisar,
  };

  // --- A casca
  const tarefas = criarTarefas(ctx);
  const calendario = criarCalendario(ctx);
  const abas = {
    tarefas: { rotulo: "Tarefas", icone: "tarefas", tela: tarefas },
    calendario: { rotulo: "Calendário", icone: "calendario", tela: calendario },
  };
  const telas = h("main", { id: "telas", class: "telas" }, tarefas.el, calendario.el);
  const botoesAba = Object.entries(abas).map(([id, aba]) =>
    h("button", { class: "aba", type: "button", "data-aba": id, onclick: () => ctx.mudarEstado({ aba: id }) }, icone(aba.icone, 24), h("span", {}, aba.rotulo)),
  );
  const topo = h(
    "header",
    { class: "topo" },
    h("div", { class: "marca-app" }, fada(30), h("span", {}, "N.avi")),
    h("button", { class: "botao-icone", "aria-label": "Ajustes e dados", onclick: () => abrirAjustes(ctx) }, icone("ajustes", 22)),
  );
  // Se o aparelho não deixa guardar (sem espaço, aba privada), o que se edita só existe na memória: avisa e não some.
  const faixa = h("div", { class: "faixa-aviso", role: "alert", hidden: "" }, "Não consegui guardar suas tarefas neste aparelho (sem espaço ou aba privada). Elas só existem enquanto o app estiver aberto: exporte uma cópia em Ajustes.");
  document.getElementById("app").replaceChildren(
    topo,
    faixa,
    telas,
    h("nav", { class: "abas", "aria-label": "Seções" }, botoesAba),
    h("div", { id: "folhas" }),
    h("div", { id: "avisos", role: "status", "aria-live": "polite" }),
  );

  function desenhar() {
    for (const [id, aba] of Object.entries(abas)) {
      const ativa = estado.aba === id;
      aba.tela.el.hidden = !ativa;
      if (ativa) aba.tela.atualizar();
    }
    for (const b of botoesAba) {
      const ativa = b.dataset.aba === estado.aba;
      b.classList.toggle("ativa", ativa);
      b.setAttribute("aria-current", ativa ? "page" : "false");
    }
  }

  // Toda mudança nos dados redesenha a tela. A folha de detalhes só se refaz quando a mudança veio de fora dela
  // (desfazer, concluir pela lista, importar), para não tirar o cursor de quem está digitando.
  armazem.aoMudar((origem) => {
    faixa.hidden = !armazem.falhou;
    if (origem === "gravacao") return;
    desenhar();
    if (detalheAberto && origem !== "detalhe") {
      if (armazem.porId(detalheAberto.id)) detalheAberto.montar();
      else folhaAberta()?.fechar();
    }
  });

  // O que depende da hora (atrasadas, "hoje") se atualiza com o relógio e quando o app volta à frente.
  let ultimoDia = hoje();
  const relogio = () => {
    if (document.hidden) return;
    if (hoje() !== ultimoDia) {
      // Virou o dia com o app aberto: o calendário volta a hoje.
      ultimoDia = hoje();
      Object.assign(estado, { ancora: ultimoDia, diaSel: ultimoDia });
    }
    if (!folhaAberta()) desenhar();
  };
  setInterval(relogio, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) armazem.gravar();
    else relogio();
  });
  addEventListener("pagehide", () => armazem.gravar());
  // Duas abas abertas (no Safari fora da tela de início): a que grava por último não pode apagar a outra.
  addEventListener("storage", (e) => {
    if (e.key === CHAVE && e.newValue) armazem.recarregar(e.newValue);
  });

  desenhar();
  // O iOS pode apagar os dados de um site que fica semanas sem uso; pedir armazenamento persistente reduz o risco
  // (o Safari decide, e quase sempre concede a um app instalado na tela de início). A nuvem é a cópia de verdade.
  navigator.storage?.persist?.().catch(() => {});
  return ctx;
}

// --- Avisos curtos, com "Desfazer"
let timerAviso = null;
function avisar(texto, desfazer = null) {
  const raiz = document.getElementById("avisos");
  clearTimeout(timerAviso);
  raiz.replaceChildren(
    h(
      "div",
      { class: "aviso" },
      h("span", {}, texto),
      desfazer
        ? h("button", { type: "button", onclick: () => {
          desfazer();
          raiz.replaceChildren();
        } }, "Desfazer")
        : null,
    ),
  );
  timerAviso = setTimeout(() => raiz.replaceChildren(), desfazer ? 6000 : 3500);
}

// --- Modo offline: o service worker guarda o app no aparelho
async function registrarOffline() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  try {
    const havia = Boolean(navigator.serviceWorker.controller);
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" });
    reg.addEventListener("updatefound", () => {
      const novo = reg.installing;
      novo?.addEventListener("statechange", () => {
        if (novo.state === "installed" && havia) avisarAtualizacao();
      });
    });
    // Procura versão nova cada vez que o app volta à frente.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  } catch {
    // Sem service worker o app funciona do mesmo jeito, só não abre sem internet.
  }
}

function avisarAtualizacao() {
  const raiz = document.getElementById("avisos");
  raiz.replaceChildren(
    h("div", { class: "aviso" }, h("span", {}, "Versão nova pronta."), h("button", { type: "button", onclick: () => location.reload() }, "Atualizar")),
  );
}

iniciar();
registrarOffline();
