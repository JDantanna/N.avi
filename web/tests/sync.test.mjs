// Testes da sincronização: os casos de mesclagem compartilhados com o desktop (docs/sync-casos/mesclagem.json),
// o armazém com carimbos e lápides, e o ciclo de sincronização contra uma nuvem de mentira.
// Rodam com `node --test web/tests/sync.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Armazem } from "../js/armazem.js";
import * as S from "../js/mesclagem.js";
import { normalizar } from "../js/modelo.js";
import { NuvemErro, Sincronia } from "../js/sincronia.js";

const casos = JSON.parse(readFileSync(new URL("../../docs/sync-casos/mesclagem.json", import.meta.url), "utf8"));
const T0 = 1_764_000_000_000;

/** Um localStorage de mentira. */
function falso() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), m };
}

/** Um armazém no estado `local` de um caso (como se já tivesse sincronizado antes). */
function armazemDe(local, agora, relogio = () => agora) {
  const a = new Armazem(falso(), relogio);
  const d = a.dados;
  d.tasks = (local.tasks ?? []).map((t, i) => ({ ...normalizar(structuredClone(t)), id: i + 1 }));
  d.next_id = d.tasks.length;
  d.tag_colors = {};
  d.tag_stamps = {};
  for (const [nome, e] of Object.entries(local.tags ?? {})) {
    if (e.color) d.tag_colors[nome] = e.color;
    d.tag_stamps[nome] = e.at;
  }
  d.deleted = structuredClone(local.deleted ?? []);
  d.synced_once = true;
  a.marcarSincronizado();
  return a;
}

const arquivo = (tarefas = [], deleted = [], tags = {}) => S.lerArquivo(JSON.stringify({ schema: 1, tasks: tarefas, deleted, tags }));
const tarefa = (uid, title, carimbo, extra = {}) => ({
  uid, title, ...extra, stamps: Object.fromEntries(["title", "notes", "state", "notify", "tags", "color", "subtasks"].map((g) => [g, carimbo])),
});

// ---------------------------------------------------------------------------------------- casos compartilhados

test("mesclagem: todos os casos compartilhados com o desktop (docs/sync-casos/mesclagem.json)", () => {
  let n = 0;
  for (const caso of casos.casos) {
    const agora = caso.agora ?? casos.agora;
    const a = armazemDe(caso.local, agora);
    // A base: o estado da última mesclagem que o aparelho conhece, para saber se os dois lados mudaram o mesmo grupo.
    if (caso.base) a.base = new Map(S.lerArquivo(JSON.stringify(caso.base)).tasks.map((t) => [t.uid, t]));
    const remoto = caso.remoto ? S.lerArquivo(JSON.stringify(caso.remoto)) : null;
    if (caso.primeira_vez && remoto) S.adotarIguais(a, remoto);
    const saida = S.mesclar(a, remoto, "teste", agora);
    const esperado = S.lerArquivo(JSON.stringify(caso.esperado));
    assert.ok(S.mesmoConteudo(esperado, saida.arquivo), `${caso.nome}:\nesperado ${JSON.stringify(esperado)}\nveio     ${JSON.stringify(saida.arquivo)}`);
    n += 1;
  }
  assert.ok(n >= 17, `${n} casos lidos`);
});

test("ciclo: informações editadas nos dois aparelhos (com a gravação local no meio) são combinadas, sem perder texto", async () => {
  const disco = falso();
  const celular = new Armazem(disco, () => T0 + 1000);
  const nuvem = nuvemFalsa(JSON.stringify({ schema: 1, tasks: [tarefa("t", "Consulta", T0, { notes: "Levar documentos" })], deleted: [], tags: {} }));
  await sincronia(celular, nuvem).sincronizar({ primeiraVez: true }); // fixa a base
  // O celular edita e GRAVA (a gravação refaz o retrato de carimbar, mas não a base da mesclagem)...
  celular.alterar(celular.tarefas[0].id, (x) => {
    x.notes = "Levar documentos e exames";
  });
  celular.gravar();
  // ...e o computador edita o mesmo texto e grava no arquivo, com carimbo mais novo.
  const f = JSON.parse(nuvem.texto);
  f.tasks[0].notes = "Levar RG";
  f.tasks[0].stamps.notes = T0 + 400_000;
  nuvem.texto = JSON.stringify(f);
  nuvem.v += 1;
  await sincronia(celular, nuvem).sincronizar();
  const esperado = `Levar RG\n\n${S.SEPARADOR_OUTRA_VERSAO}\nLevar documentos e exames`;
  assert.equal(celular.tarefas[0].notes, esperado);
  assert.equal(JSON.parse(nuvem.texto).tasks[0].notes, esperado, "o combinado vai para a nuvem");
  // A base sobrevive a fechar e abrir o app.
  assert.equal(new Armazem(disco, () => T0).base.get(celular.tarefas[0].uid).notes, esperado);
  clearTimeout(celular.timer);
});

test("mesclagem: o mesmo resultado em qualquer ordem", () => {
  const x = [tarefa("x", "Pão", 100), tarefa("y", "Leite", 300)];
  const a = armazemDe({ tasks: x, deleted: [{ uid: "z", at: 200 }] }, 1000);
  const b = armazemDe({ tasks: [tarefa("x", "Pão francês", 250), tarefa("z", "Ovos", 150)] }, 1000);
  const arqA = S.arquivoDe(a, "1");
  const arqB = S.arquivoDe(b, "2");
  const ab = S.mesclar(a, S.lerArquivo(JSON.stringify(arqB)), "1", 1000);
  const ba = S.mesclar(b, S.lerArquivo(JSON.stringify(arqA)), "2", 1000);
  assert.ok(S.mesmoConteudo(ab.arquivo, ba.arquivo));
  assert.equal(ab.arquivo.tasks.find((t) => t.uid === "x").title, "Pão francês");
  assert.ok(ab.arquivo.tasks.every((t) => t.uid !== "z"), "a exclusão de z (200) é mais nova que a edição (150)");
});

test("combinar informações: se um lado apagou o texto, fica o do outro, sem separador", () => {
  const com = (a, b, sa, sb) => {
    const local = { notes: a, stamps: { notes: sa } };
    S.combinar(local, { notes: b, stamps: { notes: sb } }, "notes");
    return local.notes;
  };
  assert.equal(com("", "Levar RG", 9, 1), "Levar RG", "o vencedor apagou o texto");
  assert.equal(com("Levar RG", "", 9, 1), "Levar RG", "o perdedor está vazio");
  assert.equal(com("  \n", "Levar RG", 9, 1), "Levar RG", "só espaços também vale como apagado");
  assert.equal(com("A", "B", 9, 1), `A\n\n${S.SEPARADOR_OUTRA_VERSAO}\nB`);
  const junto = `Levar RG\n\n${S.SEPARADOR_OUTRA_VERSAO}\nLevar documentos`;
  assert.equal(com(junto, "Levar documentos", 9, 1), junto, "o vencedor já contém o outro: não acrescenta de novo");
  assert.equal(com("Levar documentos", junto, 9, 1), junto, "o vencedor está contido no perdedor: fica o maior");
});

test("armazém: o campo base do tasks.json do PC é descartado ao importar e não volta ao exportar", () => {
  const a = new Armazem(falso(), () => T0);
  a.importar(JSON.stringify({ next_id: 1, tasks: [{ id: 1, uid: "u1", title: "T" }], base: { u1: { title: "velho" } } }));
  assert.equal("base" in a.dados, false);
  assert.equal("base" in JSON.parse(a.exportar()), false);
  clearTimeout(a.timer);
});

test("mesclagem: exclusão contra edição, dos dois lados", () => {
  const a = armazemDe({ tasks: [tarefa("a", "A", 100)] }, 1000);
  a.removerUid("a");
  a.dados.deleted.push({ uid: "a", at: 500 });
  const saida = S.mesclar(a, arquivo([tarefa("a", "A editada", 400)]), "t", 1000);
  assert.equal(a.acharUid("a"), null);
  assert.equal(saida.arquivo.deleted.length, 1);

  const b = armazemDe({ tasks: [tarefa("b", "B", 600)] }, 1000);
  const saidaB = S.mesclar(b, arquivo([], [{ uid: "b", at: 550 }]), "t", 1000);
  assert.ok(b.acharUid("b"));
  assert.equal(saidaB.arquivo.deleted.length, 0);
});

test("mesclagem: o que veio de fora não é recarimbado como edição daqui", () => {
  // B recebe "X"@200 e o regrava; se o recarimbasse, "X" venceria uma edição mais nova feita em C.
  const a = armazemDe({}, T0 + 1000);
  S.mesclar(a, arquivo([tarefa("a", "X", T0 + 200)]), "b", T0 + 1000);
  a.marcarSincronizado();
  a.gravar();
  assert.equal(a.acharUid("a").stamps.title, T0 + 200, "gravar depois de mesclar não gera carimbo novo");
  a.acharUid("a").notes = "anotação";
  a.gravar();
  assert.ok(a.acharUid("a").stamps.notes > T0 + 200, "uma edição de verdade continua ganhando carimbo");
  assert.equal(a.acharUid("a").stamps.title, T0 + 200, "e só no grupo que mudou");
});

test("mesclagem: o desempate por texto usa os bytes UTF-8, como o Rust", () => {
  // Em UTF-16 "￿" > "😀" (surrogate alto); em UTF-8 o emoji (F0...) vem depois de U+FFFF (EF BF BF).
  assert.ok(S.compararBytes("😀", "￿") > 0);
  assert.ok("￿" > "😀", "a comparação nativa do JS diria o contrário");
  assert.equal(S.chaveGrupo({ title: 'a"b\n' }, "title"), '"a\\"b\\n"');
  assert.equal(S.chaveGrupo({ tags: ["x", "y"] }, "tags"), '["x", "y"]');
  assert.equal(S.chaveGrupo({ subtasks: [{ title: "Pauta", done: true }] }, "subtasks"), '[Subtask { title: "Pauta", done: true }]');
  assert.equal(S.chaveGrupo({ done: false, date: "2026-11-05", time: null, repeat: "Weekly", every: 1, anchor_day: 5, repeat_times: null }, "state"), "false|2026-11-05||Weekly|1|5|");
});

test("arquivo: lê o que falta com o padrão, descarta o que não tem uid e tira o id de outro aparelho", () => {
  const f = S.lerArquivo(JSON.stringify({ tasks: [{ uid: "a", id: 99, title: "T", time: "09:05" }, { title: "sem uid" }], tags: { x: { color: [1, 2, 3], at: 5 }, y: { color: null } } }));
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].id, undefined);
  assert.equal(f.tasks[0].time, "09:05:00", "a hora é completada para HH:MM:SS");
  assert.deepEqual(f.tags.y, { color: null, at: 0 });
  assert.throws(() => S.lerArquivo("{quebrado"), /JSON legível/);
  assert.throws(() => S.lerArquivo("[1]"), /formato/);
});

// ----------------------------------------------------------------------------------------------- o armazém

test("armazém: carimba só o grupo que mudou, e a tarefa nova em todos", () => {
  let agora = T0;
  const a = new Armazem(falso(), () => agora);
  const t = a.adicionar("Pagar a luz", "2026-11-05");
  a.gravar();
  const primeiro = a.porId(t.id).stamps.title;
  assert.ok(primeiro >= T0);
  assert.deepEqual(new Set(Object.values(a.porId(t.id).stamps)).size, 1, "todos os grupos da tarefa nova têm o mesmo carimbo");
  agora = T0 + 5000;
  a.alterar(t.id, (x) => {
    x.title = "Pagar a luz e a água";
  });
  a.gravar();
  assert.ok(a.porId(t.id).stamps.title >= T0 + 5000);
  assert.equal(a.porId(t.id).stamps.state, primeiro, "a data não mudou");
});

test("armazém: o relógio nunca anda para trás, nem com a hora do aparelho atrasada", () => {
  let agora = T0;
  const a = new Armazem(falso(), () => agora);
  a.adiantarRelogio(T0 + 100_000); // viu um carimbo de um aparelho adiantado
  agora = T0 - 50_000; // e o relógio daqui está atrasado
  const c1 = a.carimbo();
  const c2 = a.carimbo();
  assert.ok(c1 > T0 + 100_000 && c2 === c1 + 1);
});

test("armazém: excluir deixa lápide ao gravar, e desfazer depois da gravação a derruba e vence", () => {
  let agora = T0;
  const a = new Armazem(falso(), () => agora);
  const t = a.adicionar("Dentista");
  a.gravar();
  const apagada = a.remover(t.id);
  agora = T0 + 1000;
  a.gravar();
  assert.deepEqual(a.dados.deleted.map((x) => x.uid), [t.uid]);
  const lapide = a.dados.deleted[0].at;
  agora = T0 + 2000;
  a.restaurar(apagada.antes, apagada.indice);
  assert.deepEqual(a.dados.deleted, [], "a lápide cai");
  a.gravar();
  assert.ok(a.acharUid(t.uid).stamps.title > lapide, "a tarefa volta carimbada de agora e vence a lápide que já pode estar na nuvem");
});

test("armazém: desfazer antes de gravar não deixa rastro", () => {
  const a = new Armazem(falso(), () => T0);
  const t = a.adicionar("X");
  a.gravar();
  const apagada = a.remover(t.id);
  a.restaurar(apagada.antes, apagada.indice);
  a.gravar();
  assert.deepEqual(a.dados.deleted, []);
});

test("armazém: tarefas de uma versão sem sincronização ganham carimbo ao abrir", () => {
  const disco = falso();
  disco.setItem("navi.tarefas.v1", JSON.stringify({ next_id: 1, tasks: [{ id: 1, title: "Antiga" }], tag_colors: {} }));
  const a = new Armazem(disco, () => T0);
  assert.ok(a.tarefas[0].stamps.title >= T0);
  assert.match(a.tarefas[0].uid, /^[0-9a-f]{32}$/);
});

test("armazém: importar vale como editado agora e mantém o que só existe na nuvem", () => {
  let agora = T0;
  const a = new Armazem(falso(), () => agora);
  a.adicionar("Que já havia");
  a.gravar();
  agora = T0 + 10_000;
  const antigo = { next_id: 1, clock: 5, tasks: [{ id: 1, uid: "u1", title: "Do backup", stamps: { title: 5 } }], tag_colors: { casa: [1, 2, 3] }, tag_stamps: { casa: 5 } };
  a.importar(JSON.stringify(antigo));
  const t = a.acharUid("u1");
  assert.ok(Object.values(t.stamps).every((c) => c >= T0 + 10_000), "todos os grupos recarimbados");
  assert.ok(a.dados.tag_stamps.casa >= T0 + 10_000);
  assert.ok(a.dados.clock >= T0 + 10_000);
});

test("armazém: se a gravação falhar, avisa e tenta de novo", () => {
  const disco = falso();
  const a = new Armazem(disco, () => T0);
  const avisos = [];
  a.aoMudar((o) => avisos.push(o));
  const original = disco.setItem;
  disco.setItem = () => {
    throw new Error("sem espaço");
  };
  a.adicionar("X");
  assert.equal(a.gravar(), false);
  assert.equal(a.falhou, true);
  assert.ok(avisos.includes("gravacao"));
  disco.setItem = original;
  assert.equal(a.gravar(), true);
  assert.equal(a.falhou, false);
  clearTimeout(a.timer);
});

// ------------------------------------------------------------------------------------- o ciclo de sincronia

function nuvemFalsa(texto = null) {
  const n = {
    texto, v: texto == null ? 0 : 1, gravacoes: 0, perdido: false, aoLer: null, aoVersao: null,
    async ler() {
      if (n.perdido) throw new NuvemErro("perdido", "O arquivo foi para a lixeira.");
      n.aoLer?.();
      return { texto: n.texto, versao: n.texto == null ? null : String(n.v) };
    },
    async versao() {
      n.aoVersao?.();
      return String(n.v);
    },
    async gravar(t) {
      n.texto = t;
      n.v += 1;
      n.gravacoes += 1;
      return String(n.v);
    },
  };
  return n;
}

const sem = async () => {};
const sincronia = (a, nuvem, extra = {}) => new Sincronia(a, nuvem, { aparelho: "celular", relogio: () => T0 + 500_000, esperar: sem, ...extra });

test("ciclo: sem arquivo na nuvem, grava o que há aqui", async () => {
  const a = new Armazem(falso(), () => T0);
  a.adicionar("Academia");
  const nuvem = nuvemFalsa();
  const s = sincronia(a, nuvem);
  assert.equal((await s.sincronizar()).fase, "ok");
  const gravado = JSON.parse(nuvem.texto);
  assert.equal(gravado.tasks.length, 1);
  assert.equal(gravado.tasks[0].id, undefined, "o id numérico não sai do aparelho");
  assert.equal(gravado.tasks[0].uid, a.tarefas[0].uid);
  assert.equal(gravado.next_id, undefined);
  assert.equal(a.dados.synced_once, true);
});

test("ciclo: traz a tarefa do computador, manda a daqui e não regrava sem mudança", async () => {
  const a = new Armazem(falso(), () => T0);
  a.adicionar("Do celular");
  const nuvem = nuvemFalsa(JSON.stringify({ schema: 1, tasks: [tarefa("pc-1", "Do computador", T0 + 100)], deleted: [], tags: {} }));
  const s = sincronia(a, nuvem);
  await s.sincronizar();
  assert.deepEqual(a.tarefas.map((t) => t.title).sort(), ["Do computador", "Do celular"].sort());
  assert.deepEqual(JSON.parse(nuvem.texto).tasks.map((t) => t.title).sort(), ["Do celular", "Do computador"]);
  const gravacoes = nuvem.gravacoes;
  await s.sincronizar();
  assert.equal(nuvem.gravacoes, gravacoes, "nada mudou: não regrava");
  assert.equal(s.estado.fase, "ok");
  assert.equal(s.estado.pendente, false);
});

test("ciclo: primeira vez com o arquivo do computador não duplica a tarefa igual", async () => {
  const a = new Armazem(falso(), () => T0);
  a.adicionar("Aluguel", "2026-12-05");
  const nuvem = nuvemFalsa(JSON.stringify({ schema: 1, tasks: [tarefa("pc-1", "Aluguel", T0 - 100, { date: "2026-12-05", anchor_day: 5 })], deleted: [], tags: {} }));
  await sincronia(a, nuvem).sincronizar({ primeiraVez: true });
  assert.equal(a.tarefas.length, 1);
  assert.equal(a.tarefas[0].uid, "pc-1", "assume a identidade do arquivo");
});

test("ciclo: se outro aparelho gravar no meio do caminho, relê e mescla de novo", async () => {
  const a = new Armazem(falso(), () => T0);
  a.adicionar("Do celular");
  const nuvem = nuvemFalsa(JSON.stringify({ schema: 1, tasks: [], deleted: [], tags: {} }));
  let lidas = 0;
  nuvem.aoVersao = () => {
    // Na primeira conferência antes de gravar, o computador grava uma tarefa nova.
    if (lidas++ === 0) {
      const f = JSON.parse(nuvem.texto);
      f.tasks.push(tarefa("pc-9", "Chegou no meio", T0 + 300));
      nuvem.texto = JSON.stringify(f);
      nuvem.v += 1;
    }
  };
  await sincronia(a, nuvem).sincronizar();
  assert.deepEqual(JSON.parse(nuvem.texto).tasks.map((t) => t.title).sort(), ["Chegou no meio", "Do celular"]);
  assert.ok(a.tarefas.some((t) => t.title === "Chegou no meio"));
});

test("ciclo: arquivo na lixeira ou fora da pasta para tudo e pede para escolher de novo", async () => {
  const a = new Armazem(falso(), () => T0);
  a.adicionar("X");
  const nuvem = nuvemFalsa("{}");
  nuvem.perdido = true;
  const s = sincronia(a, nuvem);
  assert.equal((await s.sincronizar()).fase, "escolher");
  assert.equal(nuvem.gravacoes, 0);
  nuvem.perdido = false;
  assert.equal((await s.sincronizar()).fase, "escolher", "continua parado até a pessoa escolher");
  assert.equal(nuvem.gravacoes, 0);
  clearTimeout(s.timer);
});

test("ciclo: arquivo ilegível é relido e, se continuar ilegível, não é tocado", async () => {
  const a = new Armazem(falso(), () => T0);
  a.adicionar("X");
  const nuvem = nuvemFalsa('{"schema":1,"tasks":[{"uid":"a"');
  let esperas = 0;
  const s = sincronia(a, nuvem, { esperar: async () => void esperas++ });
  const e = await s.sincronizar();
  assert.equal(e.fase, "erro");
  assert.equal(esperas, 2, "relê três vezes, com espera entre elas");
  assert.equal(nuvem.gravacoes, 0);
  assert.equal(nuvem.texto, '{"schema":1,"tasks":[{"uid":"a"', "o arquivo não foi alterado");
  clearTimeout(s.timer);
});

test("ciclo: arquivo de uma versão mais nova não é gravado", async () => {
  const a = new Armazem(falso(), () => T0);
  const nuvem = nuvemFalsa(JSON.stringify({ schema: 2, tasks: [], deleted: [], tags: {} }));
  const s = sincronia(a, nuvem);
  const e = await s.sincronizar();
  assert.equal(e.fase, "erro");
  assert.match(e.mensagem, /versão mais nova/);
  assert.equal(nuvem.gravacoes, 0);
  clearTimeout(s.timer);
});

test("ciclo: uma edição feita durante o ciclo fica pendente e roda outro ciclo", async () => {
  const a = new Armazem(falso(), () => T0);
  a.adicionar("Primeira");
  const nuvem = nuvemFalsa();
  const s = sincronia(a, nuvem);
  s.ligar();
  clearTimeout(s.timer);
  nuvem.gravar = async function (t) {
    // A pessoa edita enquanto a gravação está a caminho.
    a.adicionar("Durante");
    this.texto = t;
    this.v += 1;
    this.gravacoes += 1;
    return String(this.v);
  };
  await s.sincronizar();
  assert.equal(s.estado.pendente, true, "a edição de durante o ciclo ainda não está no arquivo");
  assert.equal(JSON.parse(nuvem.texto).tasks.length, 1);
  assert.ok(s.repetir === false, "o novo ciclo foi agendado");
  clearTimeout(s.timer);
  s.desligar();
  clearTimeout(a.timer);
});

test("ciclo: duas aparelhos editando a mesma tarefa em grupos diferentes mantêm as duas edições", async () => {
  // O computador muda o título; o celular conclui. Cada um sincroniza por último uma vez.
  const base = tarefa("t", "Comprar pao", T0);
  const nuvem = nuvemFalsa(JSON.stringify({ schema: 1, tasks: [base], deleted: [], tags: {} }));
  const celular = new Armazem(falso(), () => T0 + 1000);
  await sincronia(celular, nuvem).sincronizar({ primeiraVez: true });
  celular.alterar(celular.tarefas[0].id, (x) => {
    x.done = true;
  });
  const f = JSON.parse(nuvem.texto);
  f.tasks[0].title = "Comprar pao integral";
  f.tasks[0].stamps.title = T0 + 2000;
  nuvem.texto = JSON.stringify(f);
  nuvem.v += 1;
  await sincronia(celular, nuvem).sincronizar();
  assert.equal(celular.tarefas[0].title, "Comprar pao integral");
  assert.equal(celular.tarefas[0].done, true);
  const final = JSON.parse(nuvem.texto).tasks[0];
  assert.equal(final.title, "Comprar pao integral");
  assert.equal(final.done, true);
  clearTimeout(celular.timer);
});
