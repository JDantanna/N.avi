// O que só o navegador faz com a conta Google: entrar (Google Identity Services, escopo `drive.file`) e abrir o
// seletor de arquivos (Google Picker) para a pessoa escolher o N.avi.sync.json que o computador criou. Com o
// escopo `drive.file` o app só enxerga os arquivos que a pessoa escolhe no seletor.
//
// O token dura cerca de uma hora e não há como renová-lo em segundo plano: pede-se outro quando vence, e se o
// navegador não deixar abrir a janela sem um toque da pessoa, o app mostra "Entrar de novo".
// Não dá para testar sem o navegador e sem credenciais: a lógica que importa fica em drive.js e sincronia.js.

import { NuvemErro } from "./sincronia.js";

const ESCOPO = "https://www.googleapis.com/auth/drive.file";
const SCRIPT_LOGIN = "https://accounts.google.com/gsi/client";
const SCRIPT_API = "https://apis.google.com/js/api.js";

const carregados = new Map();
function carregarScript(src) {
  if (!carregados.has(src)) {
    carregados.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = true;
        el.onload = resolve;
        el.onerror = () => {
          carregados.delete(src); // permite tentar de novo quando a internet voltar
          reject(new NuvemErro("rede", "Não consegui carregar o login do Google. Confira a conexão."));
        };
        document.head.append(el);
      }),
    );
  }
  return carregados.get(src);
}

export class ContaGoogle {
  /** @param {{clientId: string, apiKey: string}} config */
  constructor(config) {
    this.clientId = config.clientId;
    this.apiKey = config.apiKey;
    this.credencial = null;
    this.validoAte = 0;
  }

  /** O número do projeto no Google Cloud é o que vem antes do traço no ID do cliente; o seletor precisa dele. */
  get idDoApp() {
    return this.clientId.split("-")[0];
  }

  /** O token de agora, se ainda vale por mais de um minuto; senão, pede outro. */
  async atual() {
    if (this.credencial && Date.now() < this.validoAte - 60_000) return this.credencial;
    return this.renovar();
  }

  /** Pede um token novo. Sem interação quando o Google já conhece a pessoa; com a janela de login na primeira vez. */
  async renovar() {
    await carregarScript(SCRIPT_LOGIN);
    return new Promise((resolve, reject) => {
      const cliente = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: ESCOPO,
        callback: (r) => {
          if (r.error || !r.access_token) {
            reject(new NuvemErro("entrar", "Não foi possível entrar no Google. Toque em \"Entrar de novo\"."));
          } else if (!google.accounts.oauth2.hasGrantedAllScopes(r, ESCOPO)) {
            reject(new NuvemErro("entrar", "O acesso aos arquivos do Drive não foi permitido. Entre de novo e aceite."));
          } else {
            this.credencial = r.access_token;
            this.validoAte = Date.now() + Number(r.expires_in || 3600) * 1000;
            resolve(this.credencial);
          }
        },
        // A janela foi fechada ou o navegador não a deixou abrir (acontece sem um toque da pessoa).
        error_callback: () => reject(new NuvemErro("entrar", "Entre de novo no Google para continuar sincronizando.")),
      });
      cliente.requestAccessToken({ prompt: "" });
    });
  }

  /** Abre o seletor do Drive. Devolve { id, name } do arquivo escolhido, ou null se a pessoa cancelou. */
  async escolherArquivo() {
    const credencial = await this.atual();
    await carregarScript(SCRIPT_API);
    await new Promise((resolve) => gapi.load("picker", { callback: resolve }));
    return new Promise((resolve) => {
      const vista = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes("application/json,text/plain").setIncludeFolders(false);
      vista.setQuery?.("N.avi.sync");
      new google.picker.PickerBuilder()
        .setAppId(this.idDoApp)
        .setOAuthToken(credencial)
        .setDeveloperKey(this.apiKey)
        .setLocale("pt-BR")
        .setTitle("Escolha o arquivo N.avi.sync.json")
        .addView(vista)
        .setCallback((dados) => {
          if (dados.action === google.picker.Action.PICKED) resolve({ id: dados.docs[0].id, name: dados.docs[0].name });
          else if (dados.action === google.picker.Action.CANCEL) resolve(null);
        })
        .build()
        .setVisible(true);
    });
  }

  /** Esquece o token daqui e o revoga no Google (a pessoa pediu para desconectar). */
  async sair() {
    const credencial = this.credencial;
    this.credencial = null;
    this.validoAte = 0;
    if (credencial && globalThis.google?.accounts?.oauth2) google.accounts.oauth2.revoke(credencial, () => {});
  }
}
