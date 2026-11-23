// Os dados do app, guardados no aparelho (localStorage) no MESMO formato do tasks.json do desktop:
// { next_id, tasks: [...], tag_colors: {...} }. Qualquer campo que este app não conhece é mantido como está,
// para a sincronização nunca perder o que o desktop gravou.

import { hojeIso } from "./datas.js";
import { normalizar, novaTarefa } from "./modelo.js";
import { definirAncora, reagendar } from "./recorrencia.js";

export const CHAVE = "navi.tarefas.v1";

export class Armazem {
  /** @param {Storage} [armazenamento] onde guardar (nos testes, um falso). */
  constructor(armazenamento = globalThis.localStorage) {
    this.storage = armazenamento;
    this.ouvintes = new Set();
    this.timer = null;
    this.dados = this.#ler();
  }

  #ler() {
    let dados = null;
    try {
      dados = JSON.parse(this.storage?.getItem(CHAVE) ?? "null");
    } catch {
      // Dado ilegível: guarda uma cópia antes que a próxima gravação o substitua.
      try {
        this.storage?.setItem(`${CHAVE}.ilegivel`, this.storage.getItem(CHAVE));
      } catch { /* sem espaço: nada a fazer */ }
    }
    return Armazem.normalizarDados(dados);
  }

  /** Aceita o que veio de um arquivo e devolve dados completos. */
  static normalizarDados(dados) {
    const d = dados && typeof dados === "object" ? dados : {};
    d.tasks = Array.isArray(d.tasks) ? d.tasks.filter((t) => t && typeof t === "object").map(normalizar) : [];
    d.tag_colors = d.tag_colors && typeof d.tag_colors === "object" ? d.tag_colors : {};
    const maior = d.tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    d.next_id = Math.max(Number(d.next_id) || 0, maior);
    return d;
  }

  /** Outra aba gravou: passa a valer o que ela gravou (sem gravar de volta). */
  recarregar(texto) {
    try {
      this.dados = Armazem.normalizarDados(JSON.parse(texto));
    } catch {
      return false;
    }
    for (const fn of this.ouvintes) fn("recarregar");
    return true;
  }

  get tarefas() {
    return this.dados.tasks;
  }

  get coresDasTags() {
    return this.dados.tag_colors;
  }

  /** Avisa quem desenha as telas sempre que algo muda. */
  aoMudar(fn) {
    this.ouvintes.add(fn);
    return () => this.ouvintes.delete(fn);
  }

  #mudou(origem) {
    this.agendarGravacao();
    for (const fn of this.ouvintes) fn(origem);
  }

  /** Grava logo depois da última mudança (não a cada tecla). */
  agendarGravacao() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.gravar(), 250);
  }

  gravar() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      this.storage?.setItem(CHAVE, JSON.stringify(this.dados));
      return true;
    } catch {
      return false;
    }
  }

  porId(id) {
    return this.tarefas.find((t) => t.id === id) ?? null;
  }

  adicionar(titulo, data = null, extra = {}) {
    this.dados.next_id += 1;
    const t = Object.assign(novaTarefa(this.dados.next_id, titulo, data), extra);
    this.tarefas.push(t);
    this.#mudou("adicionar");
    return t;
  }

  /** Muda uma tarefa. `origem` diz de onde veio a mudança (a folha de detalhes não precisa se redesenhar). */
  alterar(id, fn, origem = "alterar") {
    const t = this.porId(id);
    if (!t) return null;
    fn(t);
    this.#mudou(origem);
    return t;
  }

  /** Conclui ou reabre. Uma tarefa que repete volta pendente na próxima data. Devolve o estado de antes (para desfazer). */
  alternarConcluida(id, hoje = hojeIso()) {
    const indice = this.tarefas.findIndex((t) => t.id === id);
    if (indice < 0) return null;
    const antes = structuredClone(this.tarefas[indice]);
    const t = this.tarefas[indice];
    t.done = !t.done;
    const reagendou = reagendar(t, hoje);
    this.#mudou("concluir");
    return { antes, indice, reagendou, tarefa: t };
  }

  /** A data ou a repetição mudou: o dia-âncora acompanha a data. */
  mudarData(id, data) {
    return this.alterar(id, (t) => {
      t.date = data || null;
      definirAncora(t);
    });
  }

  remover(id) {
    const indice = this.tarefas.findIndex((t) => t.id === id);
    if (indice < 0) return null;
    const [antes] = this.tarefas.splice(indice, 1);
    this.#mudou("remover");
    return { antes, indice };
  }

  /** Desfaz uma mudança: a tarefa volta como estava e, se foi excluída, para o lugar de antes. */
  restaurar(antes, indice) {
    const atual = this.tarefas.findIndex((t) => t.id === antes.id);
    if (atual >= 0) this.tarefas[atual] = antes;
    else this.tarefas.splice(Math.min(indice, this.tarefas.length), 0, antes);
    this.#mudou("restaurar");
  }

  /** Todas as tags em uso, em ordem alfabética sem diferenciar maiúsculas. */
  tags() {
    const todas = new Set(this.tarefas.flatMap((t) => t.tags));
    return [...todas].sort((a, b) => a.localeCompare(b, "pt", { sensitivity: "base" }));
  }

  quantasComATag(tag) {
    return this.tarefas.filter((t) => t.tags.includes(tag)).length;
  }

  /** Os dados como texto, no formato do tasks.json do desktop. */
  exportar() {
    return JSON.stringify(this.dados, null, 2);
  }

  /** Troca tudo pelo conteúdo de um tasks.json. Lança um erro com a razão se o texto não serve. */
  importar(texto) {
    let dados;
    try {
      dados = JSON.parse(texto);
    } catch {
      throw new Error("O arquivo não é um tasks.json válido.");
    }
    if (!dados || !Array.isArray(dados.tasks)) throw new Error("Não achei a lista de tarefas neste arquivo.");
    this.dados = Armazem.normalizarDados(dados);
    this.#mudou("importar");
    return this.dados.tasks.length;
  }
}
