// Testes do cliente do Google Drive e da ligação do app com ele, contra um Drive de mentira (um `fetch` falso que
// responde como a API v3). Rodam com `node --test web/tests/drive.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";

import { Armazem } from "../js/armazem.js";
import { Conexao, descreverEstado, idDoAparelho } from "../js/conexao.js";
import { NuvemDrive } from "../js/drive.js";
import { NuvemErro, Sincronia } from "../js/sincronia.js";

const T0 = 1_764_000_000_000;
const ID = "arquivo123";

/** Um Drive de mentira com um arquivo; registra as chamadas para os testes olharem. */
function driveFalso({ texto = null, parents = ["pasta1"] } = {}) {
  const d = {
    arquivo: { id: ID, name: "N.avi.sync.json", trashed: false, parents, version: 5, texto },
    chamadas: [],
    tokensValidos: new Set(["bom"]),
    erro: null, // { status, reason } para a próxima chamada
    rede: false,
    async fetch(url, opcoes = {}) {
      d.chamadas.push({ url: String(url), metodo: opcoes.method ?? "GET", auth: opcoes.headers?.authorization, tipo: opcoes.headers?.["content-type"], corpo: opcoes.body });
      if (d.rede) throw new TypeError("Failed to fetch");
      const resposta = (status, corpo, json = true) => ({
        ok: status >= 200 && status < 300, status,
        json: async () => corpo, text: async () => (json ? JSON.stringify(corpo) : corpo),
      });
      if (!d.tokensValidos.has(opcoes.headers?.authorization?.replace("Bearer ", ""))) return resposta(401, { error: { code: 401 } });
      if (d.erro) {
        const e = d.erro;
        d.erro = null;
        return resposta(e.status, { error: { errors: [{ reason: e.reason ?? "" }] } });
      }
      const u = new URL(url);
      if (!u.pathname.endsWith(`/${ID}`)) return resposta(404, { error: { code: 404 } });
      const meta = () => ({ id: ID, name: d.arquivo.name, trashed: d.arquivo.trashed, parents: d.arquivo.parents, version: String(d.arquivo.version), mimeType: "application/json" });
      if (opcoes.method === "PATCH") {
        assert.equal(u.searchParams.get("uploadType"), "media", "regrava o conteúdo do mesmo arquivo");
        d.arquivo.texto = opcoes.body;
        d.arquivo.version += 1;
        return resposta(200, meta());
      }
      if (u.searchParams.get("alt") === "media") return resposta(200, d.arquivo.texto ?? "", false);
      return resposta(200, meta());
    },
  };
  return d;
}

const token = (atual = "bom", renovado = "bom") => ({ atual: async () => atual, renovar: async () => renovado });
const nuvem = (d, extra = {}) => new NuvemDrive({ fileId: ID, pastas: ["pasta1"], ...extra }, token(), d.fetch);

test("drive: lê o texto e a versão, pedindo só os campos da conferência", async () => {
  const d = driveFalso({ texto: '{"schema":1}' });
  const lido = await nuvem(d).ler();
  assert.deepEqual(lido, { texto: '{"schema":1}', versao: "5" });
  const meta = d.chamadas[0];
  assert.match(meta.url, /fields=id,name,trashed,parents,version,mimeType/);
  assert.match(meta.url, /supportsAllDrives=true/);
  assert.equal(meta.auth, "Bearer bom");
  assert.match(d.chamadas[1].url, /alt=media/);
});

test("drive: arquivo vazio vale como inexistente", async () => {
  const d = driveFalso({ texto: "  \n" });
  assert.equal((await nuvem(d).ler()).texto, null);
});

test("drive: gravar regrava o mesmo arquivo com o conteúdo em JSON e devolve a versão nova", async () => {
  const d = driveFalso({ texto: "{}" });
  const versao = await nuvem(d).gravar('{"schema":1,"tasks":[]}');
  assert.equal(versao, "6");
  assert.equal(d.arquivo.texto, '{"schema":1,"tasks":[]}');
  const g = d.chamadas[0];
  assert.equal(g.metodo, "PATCH");
  assert.match(g.url, /upload\/drive\/v3\/files\/arquivo123\?uploadType=media/);
  assert.match(g.tipo, /application\/json/);
  assert.ok(!d.chamadas.some((c) => c.metodo === "POST"), "nunca cria outro arquivo");
});

test("drive: arquivo na lixeira lança 'perdido', na leitura e na conferência de versão", async () => {
  const d = driveFalso({ texto: "{}" });
  d.arquivo.trashed = true;
  await assert.rejects(() => nuvem(d).ler(), (e) => e instanceof NuvemErro && e.codigo === "perdido" && /lixeira/.test(e.message));
  await assert.rejects(() => nuvem(d).versao(), (e) => e.codigo === "perdido");
  assert.ok(!d.chamadas.some((c) => /alt=media/.test(c.url)), "não baixa o conteúdo de um arquivo na lixeira");
});

test("drive: arquivo que saiu da pasta lança 'perdido', e que mudou de pasta mas segue numa das escolhidas não", async () => {
  const d = driveFalso({ texto: "{}", parents: ["outra"] });
  await assert.rejects(() => nuvem(d).ler(), (e) => e.codigo === "perdido" && /saiu da pasta/.test(e.message));
  d.arquivo.parents = [];
  await assert.rejects(() => nuvem(d).versao(), (e) => e.codigo === "perdido", "sem pai nenhum também");
  d.arquivo.parents = ["pasta1", "extra"];
  assert.equal(await nuvem(d).versao(), "5");
  // Escolhido sem pasta conhecida (arquivo compartilhado, por exemplo): não há onde conferir.
  d.arquivo.parents = ["qualquer"];
  assert.equal(await nuvem(d, { pastas: [] }).versao(), "5");
});

test("drive: 404 e 403 sem ser limite de uso são 'perdido'; limite de uso e 5xx são 'rede' (tenta de novo depois)", async () => {
  const d = driveFalso({ texto: "{}" });
  d.erro = { status: 404 };
  await assert.rejects(() => nuvem(d).versao(), (e) => e.codigo === "perdido");
  d.erro = { status: 403, reason: "forbidden" };
  await assert.rejects(() => nuvem(d).versao(), (e) => e.codigo === "perdido");
  d.erro = { status: 403, reason: "userRateLimitExceeded" };
  await assert.rejects(() => nuvem(d).versao(), (e) => e.codigo === "rede");
  d.erro = { status: 503 };
  await assert.rejects(() => nuvem(d).versao(), (e) => e.codigo === "rede");
  d.rede = true;
  await assert.rejects(() => nuvem(d).versao(), (e) => e.codigo === "rede" && /Sem conexão/.test(e.message));
});

test("drive: token vencido (401) é renovado uma vez e a chamada repetida; se ainda falhar, pede para entrar de novo", async () => {
  const d = driveFalso({ texto: "{}" });
  const renovados = [];
  const comRenovacao = new NuvemDrive({ fileId: ID, pastas: ["pasta1"] }, { atual: async () => "vencido", renovar: async () => (renovados.push(1), "bom") }, d.fetch);
  assert.equal(await comRenovacao.versao(), "5");
  assert.equal(renovados.length, 1);
  assert.deepEqual(d.chamadas.map((c) => c.auth), ["Bearer vencido", "Bearer bom"]);

  const semRenovar = new NuvemDrive({ fileId: ID }, { atual: async () => "vencido", renovar: async () => "vencido" }, d.fetch);
  await assert.rejects(() => semRenovar.versao(), (e) => e.codigo === "entrar");
  const quebrado = new NuvemDrive({ fileId: ID }, { atual: async () => "bom", renovar: async () => { throw new NuvemErro("entrar", "janela fechada"); } }, d.fetch);
  d.tokensValidos.delete("bom");
  await assert.rejects(() => quebrado.versao(), (e) => e.codigo === "entrar" && e.message === "janela fechada");
});

test("drive: descrever anota a pasta onde o arquivo está", async () => {
  const d = driveFalso({ texto: "{}", parents: ["pastaX"] });
  const meta = await NuvemDrive.descrever(ID, token(), d.fetch);
  assert.deepEqual(meta.parents, ["pastaX"]);
});

// --------------------------------------------------------------- o ciclo inteiro sobre o Drive de mentira

const tarefaDoPc = (uid, title, carimbo) => ({ uid, title, stamps: Object.fromEntries(["title", "notes", "state", "notify", "tags", "color", "subtasks"].map((g) => [g, carimbo])) });
const sem = async () => {};

test("ciclo sobre o drive: traz o que o computador gravou, manda o do celular e a segunda rodada não regrava", async () => {
  const d = driveFalso({ texto: JSON.stringify({ schema: 1, tasks: [tarefaDoPc("pc-1", "Do computador", T0 + 100)], deleted: [], tags: {} }) });
  const a = new Armazem({ getItem: () => null, setItem() {} }, () => T0);
  a.adicionar("Do celular");
  const s = new Sincronia(a, nuvem(d), { aparelho: "cel", relogio: () => T0 + 1000, esperar: sem });
  assert.equal((await s.sincronizar({ primeiraVez: true })).fase, "ok");
  assert.deepEqual(a.tarefas.map((t) => t.title).sort(), ["Do celular", "Do computador"]);
  assert.equal(JSON.parse(d.arquivo.texto).tasks.length, 2);
  const patches = d.chamadas.filter((c) => c.metodo === "PATCH").length;
  assert.equal(patches, 1);
  await s.sincronizar();
  assert.equal(d.chamadas.filter((c) => c.metodo === "PATCH").length, 1, "sem mudança, não regrava");
  clearTimeout(a.timer);
});

test("ciclo sobre o drive: arquivo apagado na lixeira para o ciclo e não grava nada", async () => {
  const d = driveFalso({ texto: "{}" });
  d.arquivo.trashed = true;
  const a = new Armazem({ getItem: () => null, setItem() {} }, () => T0);
  a.adicionar("X");
  const s = new Sincronia(a, nuvem(d), { aparelho: "cel", esperar: sem });
  const e = await s.sincronizar();
  assert.equal(e.fase, "escolher");
  assert.match(e.mensagem, /lixeira/);
  assert.equal(d.chamadas.filter((c) => c.metodo === "PATCH").length, 0);
  clearTimeout(a.timer);
});

// ------------------------------------------------------------------------------------- a ligação com o app

function storageFalso() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), m };
}

/** Uma conta Google de mentira: escolhe sempre o arquivo dado. */
function contaFalsa(escolhido) {
  return { atual: async () => "bom", renovar: async () => "bom", escolherArquivo: async () => escolhido, sair: async () => { contaFalsa.saiu = true; } };
}

test("conexão: sem credenciais não liga; com elas, conecta, lembra o arquivo e a pasta e sincroniza", async () => {
  const d = driveFalso({ texto: JSON.stringify({ schema: 1, tasks: [tarefaDoPc("pc-1", "Do computador", T0 + 100)], deleted: [], tags: {} }), parents: ["pastaZ"] });
  const storage = storageFalso();
  const a = new Armazem(storageFalso(), () => T0);
  const c = new Conexao({ armazem: a, config: {}, storage, buscar: d.fetch, criarConta: () => contaFalsa({ id: ID, name: "N.avi.sync.json" }) });
  assert.equal(c.configurada, false);
  await assert.rejects(() => c.conectar(), /ainda não está configurada/);

  c.config = { clientId: "123-abc.apps.googleusercontent.com", apiKey: "chave" };
  assert.equal(c.configurada, true);
  assert.equal(await c.conectar(), true);
  assert.deepEqual(JSON.parse(storage.getItem("navi.nuvem.v1")), { tipo: "google", fileId: ID, nome: "N.avi.sync.json", pastas: ["pastaZ"] });
  assert.equal(a.tarefas.some((t) => t.title === "Do computador"), true);
  assert.equal(c.resumo.nivel, "ok");
  c.sincronia.desligar();

  // Ao reabrir o app, volta sozinho a sincronizar com o mesmo arquivo.
  const c2 = new Conexao({ armazem: a, config: c.config, storage, buscar: d.fetch, criarConta: () => contaFalsa(null) });
  assert.equal(c2.ligada, true);
  c2.iniciar();
  assert.ok(c2.sincronia);
  c2.sincronia.desligar();
  clearTimeout(a.timer);
});

test("conexão: cancelar o seletor não muda nada, e um arquivo com outro nome é recusado", async () => {
  const d = driveFalso({ texto: "{}" });
  const storage = storageFalso();
  const a = new Armazem(storageFalso(), () => T0);
  const config = { clientId: "1-a", apiKey: "k" };
  const cancelou = new Conexao({ armazem: a, config, storage, buscar: d.fetch, criarConta: () => contaFalsa(null) });
  assert.equal(await cancelou.conectar(), false);
  assert.equal(cancelou.ligada, false);
  const errado = new Conexao({ armazem: a, config, storage, buscar: d.fetch, criarConta: () => contaFalsa({ id: ID, name: "fotos.json" }) });
  await assert.rejects(() => errado.conectar(), /Escolha o arquivo N\.avi\.sync\.json/);
  assert.equal(errado.ligada, false);
  assert.equal(storage.getItem("navi.nuvem.v1"), null);
});

test("conexão: desconectar esquece o arquivo e não mexe nas tarefas nem na nuvem", async () => {
  const d = driveFalso({ texto: JSON.stringify({ schema: 1, tasks: [], deleted: [], tags: {} }) });
  const storage = storageFalso();
  const a = new Armazem(storageFalso(), () => T0);
  a.adicionar("Minha");
  const c = new Conexao({ armazem: a, config: { clientId: "1-a", apiKey: "k" }, storage, buscar: d.fetch, criarConta: () => contaFalsa({ id: ID, name: "N.avi.sync.json" }) });
  await c.conectar();
  const texto = d.arquivo.texto;
  await c.desconectar();
  assert.equal(c.ligada, false);
  assert.equal(storage.getItem("navi.nuvem.v1"), null);
  assert.equal(a.tarefas.length, 1);
  assert.equal(d.arquivo.texto, texto);
  assert.equal(contaFalsa.saiu, true);
  clearTimeout(a.timer);
});

test("conexão: o id do aparelho é criado uma vez e lembrado", () => {
  const storage = storageFalso();
  const id = idDoAparelho(storage);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(idDoAparelho(storage), id);
});

test("estado na tela: um texto e um nível para cada situação", () => {
  const agora = new Date(2026, 10, 23, 15, 0);
  const estado = (e) => ({ fase: "ok", pendente: false, ultimaOk: null, mensagem: "", ...e });
  assert.equal(descreverEstado(estado({}), false).nivel, "desligada");
  assert.equal(descreverEstado(estado({ fase: "sincronizando" }), true).nivel, "trabalhando");
  assert.deepEqual(descreverEstado(estado({ ultimaOk: new Date(2026, 10, 23, 14, 32).getTime() }), true, agora), { nivel: "ok", texto: "Sincronizado às 14:32." });
  assert.match(descreverEstado(estado({ ultimaOk: new Date(2026, 10, 20, 9, 5).getTime() }), true, agora).texto, /em 20\/11 às 09:05/);
  assert.equal(descreverEstado(estado({ pendente: true, ultimaOk: 1 }), true).nivel, "pendente");
  const erro = descreverEstado(estado({ fase: "erro", mensagem: "Sem conexão com o Google Drive.", pendente: true }), true);
  assert.equal(erro.nivel, "erro");
  assert.match(erro.texto, /Sem conexão.*ainda não foram para a nuvem/);
  assert.equal(descreverEstado(estado({ fase: "escolher", mensagem: "Na lixeira." }), true).texto, "Na lixeira.");
});
