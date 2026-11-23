// Os dados do app, guardados no aparelho (localStorage) no MESMO formato do tasks.json do desktop:
// { next_id, tasks: [...], tag_colors, tag_stamps, deleted, clock, synced_once }. Qualquer campo que este app
// não conhece é mantido como está, para a sincronização nunca perder o que o desktop gravou.
//
// Para a sincronização (docs/sincronizacao.md) o armazém faz o que o `Store` do Rust faz: cada tarefa tem um
// `uid` e um carimbo por grupo de campos, refeito na gravação só para os grupos que mudaram; excluir deixa uma
// lápide; o relógio é híbrido e nunca anda para trás.

import { hojeIso } from "./datas.js";
import { igualGrupo } from "./mesclagem.js";
import { GRUPOS_SYNC, carimbosCompletos, normalizar, novaTarefa } from "./modelo.js";
import { definirAncora, reagendar } from "./recorrencia.js";

export const CHAVE = "navi.tarefas.v1";
export const CHAVE_BASE = "navi.base.v1";
/** Espera depois da última mudança antes de gravar (para não gravar a cada tecla). */
const ESPERA_GRAVACAO_MS = 250;
/** Se a gravação falhar, tenta de novo neste intervalo. */
const ESPERA_NOVA_TENTATIVA_MS = 3000;

export class Armazem {
  /**
   * @param {Storage} [armazenamento] onde guardar (nos testes, um falso).
   * @param {() => number} [relogio] o relógio de parede em ms (nos testes, um controlado).
   */
  constructor(armazenamento = globalThis.localStorage, relogio = () => Date.now()) {
    this.storage = armazenamento;
    this.relogio = relogio;
    this.ouvintes = new Set();
    this.timer = null;
    /** Há mudanças que ainda não foram gravadas no aparelho. */
    this.sujo = false;
    /** A última gravação falhou (sem espaço, modo privado): o que foi editado desde então só está na memória. */
    this.falhou = false;
    /** As tarefas como estavam na última gravação ou mesclagem, por uid: comparando com isto se sabe o que mudou. */
    this.ultimo = new Map();
    this.dados = this.#ler();
    /**
     * As tarefas como ficaram na ÚLTIMA MESCLAGEM com a nuvem, por uid. É diferente de `ultimo` (que se refaz a cada
     * gravação): serve para saber se os dois lados mudaram o mesmo grupo desde que se sincronizaram, e por isso
     * só se atualiza ao fim de uma mesclagem e fica guardada entre uma abertura do app e outra.
     */
    this.base = this.#lerBase();
    this.#migrar();
  }

  #lerBase() {
    try {
      const lista = JSON.parse(this.storage?.getItem(CHAVE_BASE) ?? "[]");
      return new Map((Array.isArray(lista) ? lista : []).filter((t) => t && typeof t.uid === "string").map((t) => [t.uid, normalizar(t)]));
    } catch {
      return new Map();
    }
  }

  /** Depois de uma mesclagem: o estado de agora é a base da próxima. */
  fixarBase() {
    this.base = new Map(this.tarefas.map((t) => [t.uid, structuredClone(t)]));
    try {
      this.storage?.setItem(CHAVE_BASE, JSON.stringify([...this.base.values()]));
    } catch { /* sem espaço: sem base, a próxima mesclagem decide só pelo carimbo, sem perder nada */ }
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
    // A base da mesclagem do desktop (tasks.json do PC) não serve aqui: o web guarda a sua em `navi.base.v1`.
    delete d.base;
    d.tasks = Array.isArray(d.tasks) ? d.tasks.filter((t) => t && typeof t === "object").map(normalizar) : [];
    d.tag_colors = d.tag_colors && typeof d.tag_colors === "object" ? d.tag_colors : {};
    d.tag_stamps = d.tag_stamps && typeof d.tag_stamps === "object" ? d.tag_stamps : {};
    d.deleted = (Array.isArray(d.deleted) ? d.deleted : [])
      .filter((x) => x && typeof x.uid === "string" && x.uid)
      .map((x) => ({ uid: x.uid, at: Number.isFinite(x.at) ? Math.trunc(x.at) : 0 }));
    d.clock = Number.isFinite(d.clock) ? Math.trunc(d.clock) : 0;
    d.synced_once = Boolean(d.synced_once);
    const maior = d.tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    d.next_id = Math.max(Number(d.next_id) || 0, maior);
    return d;
  }

  /** Tarefas de versões sem sincronização ganham carimbo; o retrato da última gravação começa daqui. */
  #migrar() {
    const antigas = this.tarefas.filter((t) => GRUPOS_SYNC.every((g) => t.stamps[g] === 0));
    if (antigas.length) {
      const agora = this.carimbo();
      for (const t of antigas) for (const g of GRUPOS_SYNC) t.stamps[g] = agora;
      this.sujo = true;
    }
    this.marcarSincronizado();
  }

  // --------------------------------------------------------------------------------------------- o relógio

  /** Um carimbo novo: o relógio de agora, ou um passo à frente do maior carimbo já visto, o que for maior. */
  carimbo() {
    this.dados.clock = Math.max(this.relogio(), this.dados.clock + 1);
    return this.dados.clock;
  }

  /** Um carimbo lido de outro aparelho: o relógio daqui nunca fica atrás dele. */
  adiantarRelogio(visto) {
    if (Number.isFinite(visto)) this.dados.clock = Math.max(this.dados.clock, visto);
  }

  // ------------------------------------------------------------------------------------------ carimbos

  /**
   * Carimba os grupos que mudaram desde a última gravação ou mesclagem, cria lápides para as tarefas que
   * sumiram e tira as lápides das que voltaram (desfazer). Roda a cada gravação e logo antes de cada mesclagem,
   * para uma edição ainda não gravada ter carimbo de agora e não perder para o arquivo.
   */
  carimbarMudancas() {
    const d = this.dados;
    const mudou =
      d.tasks.some((t) => !this.ultimo.has(t.uid) || GRUPOS_SYNC.some((g) => !igualGrupo(this.ultimo.get(t.uid), t, g))) ||
      [...this.ultimo.keys()].some((uid) => !d.tasks.some((t) => t.uid === uid));
    if (!mudou) return false;
    const agora = this.carimbo();
    for (const t of d.tasks) {
      const antes = this.ultimo.get(t.uid);
      for (const g of GRUPOS_SYNC) if (!antes || !igualGrupo(antes, t, g)) t.stamps[g] = agora;
    }
    const presentes = new Set(d.tasks.map((t) => t.uid));
    for (const uid of this.ultimo.keys()) {
      if (!presentes.has(uid) && !d.deleted.some((x) => x.uid === uid)) d.deleted.push({ uid, at: agora });
    }
    d.deleted = d.deleted.filter((x) => !presentes.has(x.uid));
    this.marcarSincronizado();
    return true;
  }

  /** O estado de agora passa a ser a referência da próxima gravação (o que veio de outro aparelho não vira edição daqui). */
  marcarSincronizado() {
    this.ultimo = new Map(this.tarefas.map((t) => [t.uid, structuredClone(t)]));
  }

  // --------------------------------------------------------------------------------------------- tarefas

  /** Outra aba gravou: passa a valer o que ela gravou (sem gravar de volta). */
  recarregar(texto) {
    try {
      const novos = Armazem.normalizarDados(JSON.parse(texto));
      novos.clock = Math.max(novos.clock, this.dados.clock);
      this.dados = novos;
    } catch {
      return false;
    }
    this.marcarSincronizado();
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
    this.sujo = true;
    this.agendarGravacao();
    this.avisar(origem);
  }

  /** Conta a quem desenha as telas que algo mudou (e de onde veio a mudança). */
  avisar(origem) {
    for (const fn of this.ouvintes) fn(origem);
  }

  /** Marca que há algo a gravar (mudança que não passou por `#mudou`, como a adoção de tarefas do arquivo). */
  marcarSujo() {
    this.sujo = true;
    this.agendarGravacao();
  }

  /** Grava logo depois da última mudança (não a cada tecla). */
  agendarGravacao(espera = ESPERA_GRAVACAO_MS) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.gravar(), espera);
  }

  /** Carimba o que mudou e grava no aparelho. Se falhar, tenta de novo daqui a pouco e avisa quem escuta. */
  gravar() {
    clearTimeout(this.timer);
    this.timer = null;
    this.carimbarMudancas();
    try {
      this.storage?.setItem(CHAVE, JSON.stringify(this.dados));
      this.sujo = false;
      if (this.falhou) {
        this.falhou = false;
        for (const fn of this.ouvintes) fn("gravacao");
      }
      return true;
    } catch {
      if (!this.falhou) {
        this.falhou = true;
        for (const fn of this.ouvintes) fn("gravacao");
      }
      this.agendarGravacao(ESPERA_NOVA_TENTATIVA_MS);
      return false;
    }
  }

  porId(id) {
    return this.tarefas.find((t) => t.id === id) ?? null;
  }

  acharUid(uid) {
    return this.tarefas.find((t) => t.uid === uid) ?? null;
  }

  removerUid(uid) {
    this.dados.tasks = this.dados.tasks.filter((t) => t.uid !== uid);
    this.marcarSujo();
  }

  /** Entra uma tarefa vinda de outro aparelho, com um id local novo. */
  adotar(tarefa) {
    this.dados.next_id += 1;
    tarefa.id = this.dados.next_id;
    this.dados.tasks.push(tarefa);
    this.marcarSujo();
    return tarefa;
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

  /**
   * Desfaz uma mudança: a tarefa volta como estava e, se foi excluída, para o lugar de antes. Se a exclusão já
   * virou lápide (foi gravada), a lápide cai e a tarefa volta carimbada de agora, em todos os grupos, para vencer
   * a lápide que já pode ter ido ao arquivo de sincronização.
   */
  restaurar(antes, indice) {
    if (this.dados.deleted.some((x) => x.uid === antes.uid)) {
      this.dados.deleted = this.dados.deleted.filter((x) => x.uid !== antes.uid);
      const agora = this.carimbo();
      for (const g of GRUPOS_SYNC) antes.stamps[g] = agora;
    }
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
    this.carimbarMudancas();
    return JSON.stringify(this.dados, null, 2);
  }

  /**
   * Troca tudo pelo conteúdo de um tasks.json. Lança um erro com a razão se o texto não serve. Como ao restaurar
   * um backup no desktop, tudo o que entra vale como editado agora (senão a sincronização desfaria a importação
   * com o que o arquivo da nuvem tem de mais novo) e o que só existe nos outros aparelhos continua lá.
   */
  importar(texto) {
    let dados;
    try {
      dados = JSON.parse(texto);
    } catch {
      throw new Error("O arquivo não é um tasks.json válido.");
    }
    if (!dados || !Array.isArray(dados.tasks)) throw new Error("Não achei a lista de tarefas neste arquivo.");
    this.carimbarMudancas();
    const anterior = this.dados;
    const novos = Armazem.normalizarDados(dados);
    novos.clock = Math.max(novos.clock, anterior.clock);
    novos.synced_once = anterior.synced_once; // a nuvem escolhida e a identidade do aparelho são desta máquina
    const presentes = new Set(novos.tasks.map((t) => t.uid));
    novos.deleted = [...anterior.deleted, ...novos.deleted.filter((x) => !anterior.deleted.some((y) => y.uid === x.uid))].filter(
      (x) => !presentes.has(x.uid),
    );
    this.dados = novos;
    const agora = this.carimbo();
    for (const t of novos.tasks) t.stamps = carimbosCompletos(Object.fromEntries(GRUPOS_SYNC.map((g) => [g, agora])));
    for (const nome of new Set([...Object.keys(novos.tag_colors), ...Object.keys(novos.tag_stamps)])) novos.tag_stamps[nome] = agora;
    this.marcarSincronizado();
    this.#mudou("importar");
    return this.dados.tasks.length;
  }
}
