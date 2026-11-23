// Testes da lógica do app web: datas, recorrência (com os vetores compartilhados com o desktop), entrada rápida,
// listas e armazenamento. Rodam com `node --test web/tests`, sem instalar nada.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as D from "../js/datas.js";
import * as R from "../js/recorrencia.js";
import * as Q from "../js/rapido.js";
import * as M from "../js/modelo.js";
import { Armazem, CHAVE } from "../js/armazem.js";

const vetores = JSON.parse(readFileSync(new URL("./vetores-recorrencia.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------------------------------------------------- datas

test("datas: soma de dias e de meses mantém o dia-âncora", () => {
  assert.equal(D.somaDias("2026-11-30", 1), "2026-12-01");
  assert.equal(D.somaDias("2026-03-01", -1), "2026-02-28");
  assert.equal(D.somaDias("2028-02-28", 1), "2028-02-29");
  assert.equal(D.somaMeses("2026-01-30", 1, 30), "2026-02-28");
  assert.equal(D.somaMeses("2026-02-28", 1, 30), "2026-03-30");
  assert.equal(D.somaMeses("2026-11-15", 3, 15), "2027-02-15");
  assert.equal(D.somaMeses("2026-01-31", -2, 31), "2025-11-30");
  assert.equal(D.somaMeses("2026-12-10", 12, 10), "2027-12-10");
});

test("datas: dia da semana começa na segunda e o horário de verão não muda o dia", () => {
  assert.equal(D.diaDaSemana("2026-11-05"), 3); // quinta-feira
  assert.equal(D.diaDaSemana("2026-11-08"), 6); // domingo
  assert.equal(D.diaDaSemana("2026-11-09"), 0); // segunda
  assert.equal(D.diasEntre("2026-03-01", "2026-04-01"), 31);
  assert.equal(D.diasEntre("2026-10-24", "2026-11-02"), 9);
});

test("datas: hora do arquivo, rótulos e nome do mês", () => {
  assert.equal(D.horaCurta("14:30:00"), "14:30");
  assert.equal(D.horaCurta(null), null);
  assert.equal(D.horaDoArquivo("09:05"), "09:05:00");
  assert.equal(D.diaMes("2026-11-05"), "05/11");
  assert.equal(D.diaMes("2026-11-05", true), "05/11/2026");
  const hoje = "2026-11-05";
  assert.equal(D.rotuloDia("2026-11-05", hoje), "Hoje");
  assert.equal(D.rotuloDia("2026-11-06", hoje), "Amanhã");
  assert.equal(D.rotuloDia("2026-11-09", hoje), "segunda-feira");
  assert.equal(D.rotuloDia("2026-12-25", hoje), "25/12");
  assert.equal(D.rotuloDia("2027-01-02", hoje), "02/01/2027");
  assert.equal(D.nomeDoMes("2026-11-05"), "novembro de 2026");
  assert.equal(D.hojeIso(new Date(2026, 10, 5, 23, 59, 59)), "2026-11-05");
});

// --------------------------------------------------------------------------------------------------- recorrência

test("recorrência: em quais dias a tarefa cai (vetores compartilhados)", () => {
  for (const caso of vetores.ocorre_em) {
    for (const dia of caso.sim) assert.equal(R.ocorreEm(caso.tarefa, dia), true, `${caso.nome}: devia cair em ${dia}`);
    for (const dia of caso.nao) assert.equal(R.ocorreEm(caso.tarefa, dia), false, `${caso.nome}: não devia cair em ${dia}`);
  }
});

test("recorrência: a data seguinte (vetores compartilhados)", () => {
  for (const caso of vetores.proxima_apos) {
    assert.equal(R.proximaApos(caso.tarefa, caso.de), caso.para, caso.nome);
  }
});

test("modelo: toda tarefa tem uid de 32 hexadecimais, e o que já existe é mantido", () => {
  const nova = M.novaTarefa(1, "x");
  assert.match(nova.uid, /^[0-9a-f]{32}$/);
  assert.notEqual(nova.uid, M.novaTarefa(2, "y").uid);
  assert.equal(M.normalizar({ id: 3, uid: "abc" }).uid, "abc");
  assert.match(M.normalizar({ id: 4 }).uid, /^[0-9a-f]{32}$/);
});

test("recorrência: concluir reagenda ou conclui de vez (vetores compartilhados)", () => {
  for (const caso of vetores.reagendar) {
    for (const [i, passo] of caso.passos.entries()) {
      const t = { subtasks: [{ done: true }], ...structuredClone(passo.tarefa) };
      const reagendou = R.reagendar(t, caso.hoje);
      const esperado = passo.esperado;
      assert.equal(reagendou, esperado.reagendou, `${caso.nome} (passo ${i + 1}): reagendou`);
      assert.equal(t.date, esperado.date, `${caso.nome} (passo ${i + 1}): data`);
      assert.equal(t.done, esperado.done, `${caso.nome} (passo ${i + 1}): concluída`);
      assert.equal(t.repeat_times, esperado.repeat_times, `${caso.nome} (passo ${i + 1}): vezes`);
      // Reagendada, o checklist volta desmarcado; concluída de vez, fica como estava.
      assert.equal(t.subtasks[0].done, !reagendou, `${caso.nome} (passo ${i + 1}): checklist`);
    }
  }
});

test("recorrência: atrasada (vetores compartilhados)", () => {
  for (const caso of vetores.atrasada) {
    const [dia, hora] = caso.agora.split("T");
    assert.equal(R.atrasada(caso.tarefa, dia, hora), caso.esperado, caso.nome);
  }
});

test("recorrência: unidade no singular e no plural e âncora do dia", () => {
  assert.equal(R.unidade("Monthly", 1), "mês");
  assert.equal(R.unidade("Monthly", 2), "meses");
  assert.equal(R.unidade("Daily", 5), "dias");
  const t = { date: "2026-01-30", anchor_day: 0 };
  R.definirAncora(t);
  assert.equal(t.anchor_day, 30);
});

// ------------------------------------------------------------------------------------------------ entrada rápida

const HOJE = "2026-11-05"; // quinta-feira

test("entrada rápida: data, hora e tags no fim do texto", () => {
  const q = Q.analisar("Reunião amanhã 14h #trabalho", HOJE);
  assert.deepEqual(q, { titulo: "Reunião", data: "2026-11-06", hora: "14:00:00", tags: ["trabalho"] });

  const q2 = Q.analisar("Dentista dia 20/11 às 9h30", HOJE);
  assert.deepEqual([q2.titulo, q2.data, q2.hora], ["Dentista", "2026-11-20", "09:30:00"]);

  assert.equal(Q.analisar("Prova sexta-feira", HOJE).data, "2026-11-06");
  assert.equal(Q.analisar("Prova quinta", HOJE).data, "2026-11-12", "a mesma quinta pede a da semana que vem");
  const q3 = Q.analisar("Viagem depois de amanhã", HOJE);
  assert.deepEqual([q3.titulo, q3.data], ["Viagem", "2026-11-07"]);
  assert.equal(Q.analisar("Natal 01/02", HOJE).data, "2027-02-01", "já passou neste ano: o ano que vem");
  assert.equal(Q.analisar("Natal 25/12/26", HOJE).data, "2026-12-25");
  assert.equal(Q.analisar("Natal 25/12/2027", HOJE).data, "2027-12-25");
});

test("entrada rápida: não inventa data no meio do título", () => {
  const q = Q.analisar("Ler o jornal de hoje cedo", HOJE);
  assert.deepEqual([q.titulo, q.data, q.hora], ["Ler o jornal de hoje cedo", null, null]);
  assert.deepEqual(Q.analisar("hoje", HOJE), { titulo: "hoje", data: null, hora: null, tags: [] });
  assert.equal(Q.analisar("Comprar 3 itens", HOJE).hora, null);
  assert.equal(Q.analisar("Sala 25:00", HOJE).hora, null);
  assert.equal(Q.analisar("Fração 31/02", HOJE).data, null);
  assert.equal(Q.analisar("Ligar 29/02", HOJE).data, null, "29/02 não existe em 2026");
  assert.equal(Q.analisar("  ", HOJE).titulo, "");
});

test("entrada rápida: tags valem em qualquer lugar e não se repetem", () => {
  const q = Q.analisar("#casa Comprar pão #casa #mercado", HOJE);
  assert.deepEqual([q.titulo, q.tags], ["Comprar pão", ["casa", "mercado"]]);
  assert.equal(Q.horaRapida("9h"), "09:00:00");
  assert.equal(Q.horaRapida("9:05"), "09:05:00");
  assert.equal(Q.horaRapida("14:"), null);
  assert.equal(Q.horaRapida("hoje"), null);
});

// ------------------------------------------------------------------------------------------------------- modelo

test("modelo: seções e filtros seguem a data, como no desktop", () => {
  const agora = "12:00:00";
  const t = (date, extra = {}) => M.normalizar({ id: 1, title: "x", date, ...extra });
  assert.equal(M.grupoDe(t("2026-11-04"), HOJE, agora), "Atrasadas");
  assert.equal(M.grupoDe(t("2026-11-05"), HOJE, agora), "Hoje");
  assert.equal(M.grupoDe(t("2026-11-05", { time: "11:00:00" }), HOJE, agora), "Atrasadas");
  assert.equal(M.grupoDe(t("2026-11-06"), HOJE, agora), "Amanha");
  assert.equal(M.grupoDe(t("2026-11-12"), HOJE, agora), "Semana");
  assert.equal(M.grupoDe(t("2026-11-13"), HOJE, agora), "Depois");
  assert.equal(M.grupoDe(t(null), HOJE, agora), "SemData");
  assert.equal(M.grupoDe(t("2026-11-01", { done: true }), HOJE, agora), "Concluidas");
  const sem = t(null);
  assert.equal(M.noFiltro("todas", "SemData", sem, HOJE), true);
  assert.equal(M.noFiltro("hoje", "SemData", sem, HOJE), false);
  assert.equal(M.noFiltro("proximos", "Atrasadas", sem, HOJE), false);
  // Concluída hoje continua em Hoje; concluída de outro dia, não.
  assert.equal(M.noFiltro("hoje", "Concluidas", t("2026-11-05", { done: true }), HOJE), true);
  assert.equal(M.noFiltro("hoje", "Concluidas", t("2026-11-01", { done: true }), HOJE), false);
});

test("modelo: data e hora da linha, cada uma à parte", () => {
  const t = M.normalizar({ id: 1, title: "x", date: "2026-11-30", time: "09:05:00" });
  assert.deepEqual(M.partesQuando(t, "Depois"), { dia: "30/11", hora: "09:05" });
  assert.deepEqual(M.partesQuando(t, "Semana"), { dia: "seg", hora: "09:05" });
  assert.deepEqual(M.partesQuando(t, "Hoje"), { dia: null, hora: "09:05" });
  assert.deepEqual(M.partesQuando(t, "Amanha"), { dia: null, hora: "09:05" });
  t.time = null;
  assert.deepEqual(M.partesQuando(t, "Depois"), { dia: "30/11", hora: null });
});

test("modelo: cor da tag é sempre a mesma para o mesmo nome, e a escolhida vale mais", () => {
  assert.deepEqual(M.corDaTag({}, "casa"), M.corDaTag({}, "casa"));
  assert.deepEqual(M.corDaTag({ casa: [1, 2, 3] }, "casa"), [1, 2, 3]);
  // Nomes com acento passam pelos bytes UTF-8, como no desktop (não pode lançar nem dar cor vazia).
  assert.equal(M.corDaTag({}, "saúde").length, 3);
  // A conta é de 64 bits: um nome comprido não pode virar NaN.
  assert.equal(M.corDaTag({}, "a".repeat(200)).length, 3);
});

test("modelo: um dia lista as tarefas por hora, as concluídas no fim", () => {
  const tarefas = [
    M.normalizar({ id: 1, title: "tarde", date: "2026-11-05", time: "16:00:00" }),
    M.normalizar({ id: 2, title: "feita", date: "2026-11-05", done: true, time: "08:00:00" }),
    M.normalizar({ id: 3, title: "sem hora", date: "2026-11-05" }),
    M.normalizar({ id: 4, title: "cedo", date: "2026-11-05", time: "07:30:00" }),
    M.normalizar({ id: 5, title: "outro dia", date: "2026-11-06" }),
  ];
  assert.deepEqual(M.doDia(tarefas, "2026-11-05").map((t) => t.title), ["cedo", "tarde", "sem hora", "feita"]);
  assert.deepEqual(M.doDia(tarefas, "2026-11-05", false).map((t) => t.title), ["cedo", "tarde", "sem hora"]);
});

// ----------------------------------------------------------------------------------------------------- armazém

/** Um localStorage de mentira. */
function falso() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), m };
}

test("armazém: cria, conclui com desfazer, exclui e restaura", () => {
  const a = new Armazem(falso());
  const t = a.adicionar("Pagar a luz", "2026-11-05");
  assert.equal(t.id, 1);
  assert.equal(a.adicionar("Outra").id, 2);
  const r = a.alternarConcluida(1, "2026-11-05");
  assert.equal(a.porId(1).done, true);
  a.restaurar(r.antes, r.indice);
  assert.equal(a.porId(1).done, false);
  const apagada = a.remover(1);
  assert.equal(a.tarefas.length, 1);
  a.restaurar(apagada.antes, apagada.indice);
  assert.deepEqual(a.tarefas.map((x) => x.id), [1, 2], "volta ao lugar de antes");
});

test("armazém: concluir uma tarefa que repete a reagenda", () => {
  const a = new Armazem(falso());
  const t = a.adicionar("Academia", "2026-11-05");
  a.alterar(t.id, (x) => {
    x.repeat = "Daily";
  });
  const r = a.alternarConcluida(t.id, "2026-11-05");
  assert.equal(r.reagendou, true);
  assert.equal(a.porId(t.id).date, "2026-11-06");
  assert.equal(a.porId(t.id).done, false);
});

test("armazém: grava e lê de volta, guardando o que o app não conhece", () => {
  const disco = falso();
  const desktop = {
    next_id: 7,
    tasks: [{ id: 7, title: "Do desktop", campo_novo_do_desktop: { a: 1 }, date: "2026-11-05", time: "14:30:00" }],
    tag_colors: { casa: [1, 2, 3] },
    outro_campo: true,
  };
  const a = new Armazem(disco);
  assert.equal(a.importar(JSON.stringify(desktop)), 1);
  a.adicionar("Do celular");
  assert.equal(a.gravar(), true);

  const b = new Armazem(disco);
  assert.equal(b.tarefas.length, 2);
  assert.deepEqual(b.porId(7).campo_novo_do_desktop, { a: 1 });
  assert.equal(b.dados.outro_campo, true);
  assert.deepEqual(b.coresDasTags, { casa: [1, 2, 3] });
  assert.equal(b.porId(7).time, "14:30:00", "a hora volta no formato do desktop");
  // O próximo id continua depois do maior que existe, mesmo que o arquivo diga outra coisa.
  assert.equal(b.adicionar("Mais uma").id, 9);
});

test("armazém: arquivo estragado não apaga nada em silêncio", () => {
  const disco = falso();
  disco.setItem(CHAVE, "{isto não é json");
  const a = new Armazem(disco);
  assert.equal(a.tarefas.length, 0);
  assert.equal(disco.getItem(`${CHAVE}.ilegivel`), "{isto não é json", "guarda uma cópia do que não deu para ler");
  assert.throws(() => a.importar("lixo"), /tasks\.json válido/);
  assert.throws(() => a.importar('{"semTarefas": 1}'), /lista de tarefas/);
  assert.equal(new Armazem(falso()).dados.next_id, 0);
});

test("armazém: tags em ordem alfabética e contagem", () => {
  const a = new Armazem(falso());
  a.adicionar("1", null, { tags: ["trabalho", "casa"] });
  a.adicionar("2", null, { tags: ["Saúde", "casa"] });
  assert.deepEqual(a.tags(), ["casa", "Saúde", "trabalho"]);
  assert.equal(a.quantasComATag("casa"), 2);
});
