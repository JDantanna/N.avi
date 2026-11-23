// O arquivo N.avi.sync.json no Google Drive, pela API REST v3, para o ciclo de `sincronia.js`:
//   ler() / versao() / gravar(texto), com a conferência do arquivo a cada acesso (docs/sincronizacao.md):
//   se ele foi para a lixeira ou saiu da pasta, lança NuvemErro("perdido") e o app para e pede para escolher de novo.
//
// O Drive v3 não tem gravação condicional (`files.update` não aceita If-Match e `version` é só de leitura): quem
// garante que nada se perde é o ciclo, que compara a `version` lida com a de logo antes de gravar e remescla.
// Aqui não há tela nem login: o token vem de fora (`token.atual()` / `token.renovar()`), e o `fetch` é injetável,
// o que permite testar tudo contra um Drive de mentira.

import { NuvemErro } from "./sincronia.js";

const ARQUIVOS = "https://www.googleapis.com/drive/v3/files";
const ENVIO = "https://www.googleapis.com/upload/drive/v3/files";
/** Só o que a conferência precisa: leve e suficiente. */
const CAMPOS = "id,name,trashed,parents,version,mimeType";

export class NuvemDrive {
  /**
   * @param {{fileId: string, pastas?: string[]}} arquivo o arquivo escolhido e a(s) pasta(s) onde ele estava ao escolher
   * @param {{atual: () => Promise<string>, renovar: () => Promise<string>}} token
   * @param {typeof fetch} [buscar]
   */
  constructor(arquivo, token, buscar = (...a) => globalThis.fetch(...a)) {
    this.fileId = arquivo.fileId;
    this.pastas = arquivo.pastas ?? [];
    this.token = token;
    this.buscar = buscar;
  }

  /** Uma chamada à API. Um 401 renova o token uma vez e repete; os demais erros viram `NuvemErro`. */
  async #chamar(url, opcoes = {}) {
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const credencial = tentativa === 0 ? await this.token.atual() : await this.token.renovar();
      let resposta;
      try {
        resposta = await this.buscar(url, { ...opcoes, headers: { ...opcoes.headers, authorization: `Bearer ${credencial}` } });
      } catch {
        throw new NuvemErro("rede", "Sem conexão com o Google Drive.");
      }
      if (resposta.ok) return resposta;
      if (resposta.status === 401 && tentativa === 0) continue;
      throw await this.#erroDe(resposta);
    }
    throw new NuvemErro("entrar", "O login do Google venceu. Entre de novo para continuar sincronizando.");
  }

  async #erroDe(resposta) {
    const { status } = resposta;
    if (status === 401) return new NuvemErro("entrar", "O login do Google venceu. Entre de novo para continuar sincronizando.");
    if (status === 404) return new NuvemErro("perdido", "O Drive não encontra mais o arquivo de sincronização. Escolha-o de novo.");
    let motivo = "";
    try {
      motivo = (await resposta.json())?.error?.errors?.[0]?.reason ?? "";
    } catch { /* corpo que não é JSON: o status basta */ }
    if (status === 403 && /rateLimit|quota/i.test(motivo)) return new NuvemErro("rede", "O Google Drive pediu para esperar um pouco. Tentando de novo daqui a pouco.");
    // 403 por outro motivo: o app perdeu o direito sobre o arquivo (a pessoa o descompartilhou ou revogou o acesso).
    if (status === 403) return new NuvemErro("perdido", "O app não tem mais acesso ao arquivo de sincronização. Escolha-o de novo.");
    return new NuvemErro("rede", `O Google Drive respondeu com erro ${status}. Tentando de novo daqui a pouco.`);
  }

  /** Confere se o arquivo continua valendo: fora da lixeira e ainda na pasta onde foi escolhido. */
  #conferir(meta) {
    if (meta.trashed) throw new NuvemErro("perdido", "O arquivo de sincronização está na lixeira do Drive. Escolha-o de novo (ou restaure-o antes).");
    if (this.pastas.length > 0) {
      const aindaLa = Array.isArray(meta.parents) && meta.parents.some((p) => this.pastas.includes(p));
      if (!aindaLa) throw new NuvemErro("perdido", "O arquivo de sincronização saiu da pasta onde estava. Escolha-o de novo.");
    }
    return meta;
  }

  async #metadados() {
    const url = `${ARQUIVOS}/${encodeURIComponent(this.fileId)}?fields=${CAMPOS}&supportsAllDrives=true`;
    const resposta = await this.#chamar(url);
    return this.#conferir(await resposta.json());
  }

  /** A versão atual, conferida: barato (só metadados). */
  async versao() {
    return String((await this.#metadados()).version);
  }

  /**
   * Lê o arquivo. A versão devolvida é a de ANTES do download: se alguém gravar enquanto se baixa, a conferência
   * antes de gravar nota a diferença e o ciclo relê.
   */
  async ler() {
    const meta = await this.#metadados();
    const resposta = await this.#chamar(`${ARQUIVOS}/${encodeURIComponent(this.fileId)}?alt=media&supportsAllDrives=true`, { cache: "no-store" });
    const texto = await resposta.text();
    return { texto: texto.trim() === "" ? null : texto, versao: String(meta.version) };
  }

  /** Regrava o conteúdo do MESMO arquivo (nunca cria outro) e devolve a versão nova. */
  async gravar(texto) {
    const url = `${ENVIO}/${encodeURIComponent(this.fileId)}?uploadType=media&supportsAllDrives=true&fields=${CAMPOS}`;
    const resposta = await this.#chamar(url, { method: "PATCH", headers: { "content-type": "application/json; charset=UTF-8" }, body: texto });
    return String(this.#conferir(await resposta.json()).version);
  }

  /** Os metadados do arquivo, sem conferir a pasta: para quem acabou de escolher e precisa anotar onde ele está. */
  static async descrever(fileId, token, buscar = (...a) => globalThis.fetch(...a)) {
    const nuvem = new NuvemDrive({ fileId }, token, buscar);
    const resposta = await nuvem.#chamar(`${ARQUIVOS}/${encodeURIComponent(fileId)}?fields=${CAMPOS}&supportsAllDrives=true`);
    return resposta.json();
  }
}
