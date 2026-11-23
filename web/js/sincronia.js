// Um ciclo de sincronização: ler o arquivo da nuvem, mesclar com as tarefas daqui e gravar o resultado.
// Não sabe falar com nenhuma nuvem em particular: recebe um objeto `nuvem` com três funções (ver abaixo), o que
// permite testar tudo com uma nuvem de mentira. Segue docs/sincronizacao.md.
//
//   nuvem.ler()    → { texto: string | null, versao: string | null }   (texto null = o arquivo ainda não existe)
//   nuvem.versao() → string                                            (só os metadados: barato)
//   nuvem.gravar(texto) → string                                       (a versão nova; regrava o MESMO arquivo)
//
// Quem implementa a nuvem confere, a cada `ler()`, se o arquivo continua valendo (no Google Drive: `trashed`,
// `parents`, `version`) e, se ele foi para a lixeira ou saiu da pasta, lança `NuvemErro("perdido")`.

import { SCHEMA, adotarIguais, lerArquivo, mesclar } from "./mesclagem.js";

export class NuvemErro extends Error {
  /** @param {"perdido" | "entrar" | "rede"} codigo */
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

/** Leituras ilegíveis seguidas antes de desistir (quase sempre é um arquivo ainda sendo gravado por outro aparelho). */
const LEITURAS_ILEGIVEIS = 3;
const ESPERA_ILEGIVEL_MS = 3000;
/** Quantas vezes reler e mesclar de novo se outro aparelho gravar no meio do caminho. */
const TENTATIVAS = 3;
/** Espera até a nova tentativa depois de um erro, em ms: sobe até o último e fica nele. */
const RECUOS_MS = [5_000, 15_000, 60_000, 300_000];
/** Quanto esperar depois da última edição antes de sincronizar. */
const ESPERA_EDICAO_MS = 1500;
/** De quanto em quanto tempo conferir a nuvem com o app aberto. */
const CONFERIR_A_CADA_MS = 60_000;

export class Sincronia {
  /**
   * @param {import("./armazem.js").Armazem} armazem
   * @param {{ler: Function, versao: Function, gravar: Function}} nuvem
   * @param {{aparelho: string, relogio?: () => number, esperar?: (ms: number) => Promise<void>, aoMudarEstado?: (e: object) => void}} opcoes
   */
  constructor(armazem, nuvem, { aparelho, relogio = () => Date.now(), esperar = (ms) => new Promise((r) => setTimeout(r, ms)), aoMudarEstado = null }) {
    this.armazem = armazem;
    this.nuvem = nuvem;
    this.aparelho = aparelho;
    this.relogio = relogio;
    this.esperar = esperar;
    this.aoMudarEstado = aoMudarEstado;
    /**
     * fase: "pronta" (ainda não sincronizou) | "sincronizando" | "ok" | "erro" | "escolher" (o arquivo se perdeu:
     * a pessoa precisa escolher de novo) | "entrar" (o login da nuvem venceu).
     * pendente: há edição daqui que ainda não chegou ao arquivo.
     */
    this.estado = { fase: "pronta", pendente: false, ultimaOk: null, mensagem: "" };
    this.emCurso = false;
    this.repetir = false;
    this.versaoVista = null;
    this.mudancas = 0; // conta as edições locais, para saber se houve alguma durante um ciclo
    this.falhas = 0;
    this.timer = null;
    this.desligar = null;
  }

  #estado(parte) {
    this.estado = { ...this.estado, ...parte };
    this.aoMudarEstado?.(this.estado);
  }

  /** Começa a acompanhar as edições (sincroniza logo depois de cada uma) e a conferir a nuvem de tempos em tempos. */
  ligar({ jaSincronizou = false } = {}) {
    const parar = this.armazem.aoMudar((origem) => {
      if (origem === "sincronia" || origem === "recarregar" || origem === "gravacao") return;
      this.mudancas += 1;
      this.#estado({ pendente: true });
      this.agendar(ESPERA_EDICAO_MS);
    });
    const doc = globalThis.document;
    const periodico = setInterval(() => {
      if (!doc?.hidden) this.agendar(0);
    }, CONFERIR_A_CADA_MS);
    const aoVoltar = () => {
      if (!doc.hidden) this.agendar(0);
    };
    doc?.addEventListener("visibilitychange", aoVoltar);
    this.desligar = () => {
      parar();
      clearInterval(periodico);
      clearTimeout(this.timer);
      doc?.removeEventListener("visibilitychange", aoVoltar);
    };
    if (jaSincronizou) return;
    // Ao ligar não se sabe o que ficou sem ir ao arquivo na última vez: conta como pendente até o primeiro ciclo dar certo.
    this.#estado({ pendente: true });
    this.agendar(0);
  }

  /** A pessoa resolveu o que travava (escolheu o arquivo de novo, entrou de novo): volta a sincronizar do zero. */
  reiniciar() {
    this.versaoVista = null;
    this.falhas = 0;
    this.#estado({ fase: "pronta", mensagem: "" });
  }

  agendar(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sincronizar(), ms);
  }

  /** Um ciclo completo. Nunca lança: o resultado fica em `estado`. */
  async sincronizar({ primeiraVez = false } = {}) {
    if (this.emCurso) {
      this.repetir = true; // pediram durante um ciclo: roda outro logo depois
      return this.estado;
    }
    if (this.estado.fase === "escolher" || this.estado.fase === "entrar") return this.estado;
    this.emCurso = true;
    this.#estado({ fase: "sincronizando" });
    try {
      await this.#ciclo(primeiraVez);
      this.falhas = 0;
    } catch (e) {
      this.#falhou(e);
    } finally {
      this.emCurso = false;
    }
    if (this.repetir) {
      this.repetir = false;
      this.agendar(0);
    }
    return this.estado;
  }

  #falhou(e) {
    if (e instanceof NuvemErro && e.codigo === "perdido") {
      this.#estado({ fase: "escolher", mensagem: e.message || "O arquivo de sincronização saiu da pasta ou foi para a lixeira. Escolha-o de novo." });
      return;
    }
    if (e instanceof NuvemErro && e.codigo === "entrar") {
      this.#estado({ fase: "entrar", mensagem: e.message || "Entre de novo na sua conta para continuar sincronizando." });
      return;
    }
    this.#estado({ fase: "erro", mensagem: e?.message || "Não foi possível sincronizar." });
    this.agendar(RECUOS_MS[Math.min(this.falhas, RECUOS_MS.length - 1)]);
    this.falhas += 1;
  }

  /** Lê o arquivo; um texto que não se lê é relido algumas vezes antes de valer (pode estar sendo gravado). */
  async #lerRemoto() {
    let ultimoErro = null;
    for (let i = 0; i < LEITURAS_ILEGIVEIS; i++) {
      if (i > 0) await this.esperar(ESPERA_ILEGIVEL_MS);
      const lido = await this.nuvem.ler();
      if (lido.texto == null) return { lido, remoto: null };
      try {
        return { lido, remoto: lerArquivo(lido.texto) };
      } catch (e) {
        ultimoErro = e;
      }
    }
    throw new Error(`${ultimoErro.message} Nada foi alterado aqui; o computador o põe de lado e o regrava.`);
  }

  async #ciclo(primeiraVez) {
    const armazem = this.armazem;
    for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
      const { lido, remoto } = await this.#lerRemoto();
      if (remoto && remoto.schema > SCHEMA) {
        throw new Error("O arquivo foi gravado por uma versão mais nova do N.avi. Atualize o app para sincronizar.");
      }
      // Nada mudou desde a última vez e nada local a mandar: não há o que mesclar.
      if (remoto && !this.estado.pendente && lido.versao && lido.versao === this.versaoVista) {
        this.#estado({ fase: "ok", ultimaOk: this.relogio(), mensagem: "" });
        return;
      }

      // Uma edição ainda não gravada ganha carimbo antes de mesclar, com o relógio já adiantado pelo arquivo:
      // é a mudança mais recente e não pode perder para o que veio de fora.
      if (remoto) armazem.adiantarRelogio(remoto.clock);
      armazem.carimbarMudancas();
      const mudancasAntes = this.mudancas;
      let mudouLocal = false;
      if (remoto && (primeiraVez || !armazem.dados.synced_once)) mudouLocal = adotarIguais(armazem, remoto);
      const r = mesclar(armazem, remoto, this.aparelho, this.relogio());
      mudouLocal ||= r.mudouLocal;
      if (!armazem.dados.synced_once) {
        armazem.dados.synced_once = true;
        mudouLocal = true;
      }
      // O estado mesclado passa a ser a referência: o que veio de fora não é recarimbado como edição daqui.
      armazem.marcarSincronizado();
      armazem.fixarBase();
      if (mudouLocal) {
        armazem.marcarSujo();
        armazem.avisar("sincronia");
      }
      armazem.gravar();

      if (!r.mudouArquivo) {
        this.versaoVista = lido.versao;
        this.#estado({ fase: "ok", pendente: this.mudancas !== mudancasAntes, ultimaOk: this.relogio(), mensagem: "" });
        if (this.mudancas !== mudancasAntes) this.repetir = true;
        return;
      }
      // O Drive não aceita gravação condicional: a garantia vem de conferir a versão logo antes de gravar e, se
      // outro aparelho gravou no meio do caminho, reler e mesclar de novo (não é atômico, mas fecha quase toda a janela).
      if (lido.versao != null && (await this.nuvem.versao()) !== lido.versao) continue;
      this.versaoVista = await this.nuvem.gravar(JSON.stringify(r.arquivo, null, 2));
      const houveEdicao = this.mudancas !== mudancasAntes;
      this.#estado({ fase: "ok", pendente: houveEdicao, ultimaOk: this.relogio(), mensagem: "" });
      if (houveEdicao) this.repetir = true;
      return;
    }
    throw new Error("Outro aparelho gravou ao mesmo tempo, várias vezes seguidas. Tentando de novo daqui a pouco.");
  }
}
