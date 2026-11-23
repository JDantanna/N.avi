// A ligação do app com o Google Drive: lembra qual arquivo foi escolhido, monta a nuvem e o ciclo de
// sincronização, e responde aos toques da tela (conectar, escolher de novo, entrar de novo, desconectar).
// As credenciais (ID do cliente e chave de API) vêm de config/nuvem.json; sem elas o app funciona só no aparelho.

import { NuvemDrive } from "./drive.js";
import { ContaGoogle } from "./google.js";
import { novoUid } from "./modelo.js";
import { Sincronia } from "./sincronia.js";

const CHAVE_NUVEM = "navi.nuvem.v1";
const CHAVE_APARELHO = "navi.aparelho.v1";

/** O arquivo que o computador cria se chama assim; o seletor só deve levar a pessoa a ele. */
const NOME_VALIDO = /^N\.avi\.sync.*\.json$/i;

function ler(storage, chave) {
  try {
    return JSON.parse(storage.getItem(chave) ?? "null");
  } catch {
    return null;
  }
}

function guardar(storage, chave, valor) {
  try {
    if (valor == null) storage.removeItem(chave);
    else storage.setItem(chave, JSON.stringify(valor));
  } catch { /* sem espaço: a escolha só não é lembrada */ }
}

/** Identidade deste aparelho no arquivo de sincronização (só informativa): criada na primeira vez e guardada. */
export function idDoAparelho(storage) {
  let id = ler(storage, CHAVE_APARELHO);
  if (typeof id !== "string" || !id) {
    id = novoUid().slice(0, 16);
    guardar(storage, CHAVE_APARELHO, id);
  }
  return id;
}

const duasCasas = (n) => String(n).padStart(2, "0");

/**
 * O que a tela mostra sobre a sincronização: um nível (para a cor do ícone) e um texto.
 * nivel: "desligada" | "trabalhando" | "ok" | "pendente" | "erro".
 */
export function descreverEstado(estado, ligada, agora = new Date()) {
  if (!ligada) return { nivel: "desligada", texto: "Sincronização desligada." };
  if (estado.fase === "escolher" || estado.fase === "entrar") return { nivel: "erro", texto: estado.mensagem };
  if (estado.fase === "erro") {
    return { nivel: "erro", texto: `${estado.mensagem}${estado.pendente ? " Há edições que ainda não foram para a nuvem." : ""}` };
  }
  if (estado.fase === "sincronizando") return { nivel: "trabalhando", texto: "Sincronizando…" };
  if (estado.pendente) return { nivel: "pendente", texto: "Há edições que ainda não foram para a nuvem." };
  if (estado.ultimaOk) {
    const quando = new Date(estado.ultimaOk);
    const hoje = quando.toDateString() === agora.toDateString();
    const hora = `${duasCasas(quando.getHours())}:${duasCasas(quando.getMinutes())}`;
    return { nivel: "ok", texto: hoje ? `Sincronizado às ${hora}.` : `Sincronizado em ${duasCasas(quando.getDate())}/${duasCasas(quando.getMonth() + 1)} às ${hora}.` };
  }
  return { nivel: "trabalhando", texto: "Conectando…" };
}

export class Conexao {
  /**
   * @param {{armazem: import("./armazem.js").Armazem, config?: {clientId?: string, apiKey?: string}, storage?: Storage,
   *   criarConta?: (c: object) => object, buscar?: typeof fetch, aoMudar?: () => void}} opcoes
   */
  constructor({ armazem, config = {}, storage = globalThis.localStorage, criarConta = (c) => new ContaGoogle(c), buscar, aoMudar = () => {} }) {
    this.armazem = armazem;
    this.config = config;
    this.storage = storage;
    this.criarConta = criarConta;
    this.buscar = buscar;
    this.ouvintes = new Set([aoMudar]);
    this.salva = ler(storage, CHAVE_NUVEM);
    this.conta = null;
    this.sincronia = null;
    this.aparelho = idDoAparelho(storage);
  }

  /** Há credenciais no arquivo de configuração? Sem elas o botão de conectar nem aparece. */
  get configurada() {
    return Boolean(this.config?.clientId && this.config?.apiKey);
  }

  get ligada() {
    return Boolean(this.salva);
  }

  get resumo() {
    return descreverEstado(this.sincronia?.estado ?? { fase: "pronta", pendente: false, ultimaOk: null, mensagem: "" }, this.ligada);
  }

  get nomeDoArquivo() {
    return this.salva?.nome ?? "";
  }

  /** Quem quer saber de toda mudança no estado da sincronização (a barra de cima, a folha de ajustes). Devolve como parar. */
  ouvir(fn) {
    this.ouvintes.add(fn);
    return () => this.ouvintes.delete(fn);
  }

  #avisar() {
    for (const fn of this.ouvintes) fn();
  }

  #conta() {
    this.conta ??= this.criarConta(this.config);
    return this.conta;
  }

  #token() {
    const conta = this.#conta();
    return { atual: () => conta.atual(), renovar: () => conta.renovar() };
  }

  #montar() {
    this.sincronia?.desligar?.();
    const nuvem = new NuvemDrive({ fileId: this.salva.fileId, pastas: this.salva.pastas }, this.#token(), this.buscar);
    this.sincronia = new Sincronia(this.armazem, nuvem, { aparelho: this.aparelho, aoMudarEstado: () => this.#avisar() });
  }

  /** Ao abrir o app: se já estava conectado, volta a sincronizar. */
  iniciar() {
    if (!this.ligada || !this.configurada) return;
    this.#montar();
    this.sincronia.ligar();
    this.#avisar();
  }

  /** Pelo toque em "Conectar": entra no Google, abre o seletor e faz a primeira sincronização. Devolve false se cancelou. */
  async conectar() {
    if (!this.configurada) throw new Error("A sincronização com o Google Drive ainda não está configurada neste app.");
    const escolhido = await this.#conta().escolherArquivo();
    if (!escolhido) return false;
    if (!NOME_VALIDO.test(escolhido.name)) {
      throw new Error(`Escolha o arquivo N.avi.sync.json, o que o computador criou. Este se chama "${escolhido.name}".`);
    }
    const meta = await NuvemDrive.descrever(escolhido.id, this.#token(), this.buscar);
    if (meta.trashed) throw new Error("Este arquivo está na lixeira do Drive.");
    this.salva = { tipo: "google", fileId: escolhido.id, nome: escolhido.name, pastas: meta.parents ?? [] };
    guardar(this.storage, CHAVE_NUVEM, this.salva);
    this.#montar();
    const estado = await this.sincronia.sincronizar({ primeiraVez: true });
    this.sincronia.ligar({ jaSincronizou: estado.fase === "ok" });
    this.#avisar();
    return true;
  }

  /** O arquivo se perdeu (lixeira, outra pasta): a pessoa escolhe de novo e a sincronização recomeça. */
  escolherDeNovo() {
    // Mesmo caminho da primeira vez: escolhe, anota onde o arquivo está e recomeça a sincronização do zero.
    return this.conectar();
  }

  /** O login venceu: entrar de novo (precisa de um toque, por isso é um botão) e continuar. */
  async entrarDeNovo() {
    await this.#conta().renovar();
    this.sincronia?.reiniciar();
    await this.sincronia?.sincronizar();
  }

  async sincronizarAgora() {
    await this.sincronia?.sincronizar();
  }

  /** Para de sincronizar e esquece o arquivo. As tarefas daqui ficam como estão; o arquivo na nuvem não é mexido. */
  async desconectar() {
    this.sincronia?.desligar?.();
    this.sincronia = null;
    await this.conta?.sair?.();
    this.conta = null;
    this.salva = null;
    guardar(this.storage, CHAVE_NUVEM, null);
    this.#avisar();
  }
}
