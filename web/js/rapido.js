// Campo de nova tarefa: entende data, hora e tags escritas no próprio texto ("Reunião amanhã 14h #trabalho").
// É o mesmo reconhecimento do desktop (`parse_quick` em src/tasks.rs).

import { diaDaSemana, diasNoMes, partes, somaDias } from "./datas.js";

const dois = (n) => String(n).padStart(2, "0");

/** "14h", "14h30", "14:30" ou "9:05" vira "HH:MM:00"; qualquer outra coisa é `null`. */
export function horaRapida(palavra) {
  let h, m, doisPontos = false;
  if (palavra.includes(":")) {
    [h, m] = palavra.split(/:(.*)/s);
    doisPontos = true;
  } else if (palavra.includes("h")) {
    [h, m] = palavra.split(/h(.*)/s);
  } else {
    return null;
  }
  if (!/^\d+$/.test(h)) return null;
  let minuto;
  if (m.length === 0 && !doisPontos) minuto = 0;
  else if (m.length === 2 && /^\d{2}$/.test(m)) minuto = Number(m);
  else return null;
  const hora = Number(h);
  if (hora > 23 || minuto > 59) return null;
  return `${dois(hora)}:${dois(minuto)}:00`;
}

const SEMANA = {
  segunda: 0, terça: 1, terca: 1, quarta: 2, quinta: 3, sexta: 4, sábado: 5, sabado: 5, domingo: 6,
};

function dataValida(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= diasNoMes(y, m);
}

/** "hoje", "amanhã", um dia da semana (sempre o próximo), "05/11", "05/11/26" ou "05/11/2026". */
export function dataRapida(palavra, hoje) {
  if (palavra === "hoje") return hoje;
  if (palavra === "amanhã" || palavra === "amanha") return somaDias(hoje, 1);
  const nome = palavra.endsWith("-feira") ? palavra.slice(0, -6) : palavra;
  if (Object.hasOwn(SEMANA, nome)) {
    // Sempre a próxima: "sexta" dita numa sexta é a da semana que vem.
    const ahead = ((((SEMANA[nome] - diaDaSemana(hoje) - 1) % 7) + 7) % 7) + 1;
    return somaDias(hoje, ahead);
  }
  const partesTexto = palavra.split("/");
  if (partesTexto.length < 2 || partesTexto.length > 3 || !partesTexto.every((p) => /^\d+$/.test(p))) return null;
  const [dia, mes] = [Number(partesTexto[0]), Number(partesTexto[1])];
  const { y } = partes(hoje);
  if (partesTexto.length === 2) {
    // Sem ano: este ano, ou o que vem se a data já passou (como no desktop, uma data que não existe neste ano
    // não é tentada no próximo).
    if (!dataValida(y, mes, dia)) return null;
    const esteAno = `${y}-${dois(mes)}-${dois(dia)}`;
    if (esteAno >= hoje) return esteAno;
    return dataValida(y + 1, mes, dia) ? `${y + 1}-${dois(mes)}-${dois(dia)}` : null;
  }
  const ano = Number(partesTexto[2]);
  const anoCheio = ano < 100 ? 2000 + ano : ano;
  return dataValida(anoCheio, mes, dia) ? `${anoCheio}-${dois(mes)}-${dois(dia)}` : null;
}

const LIGACOES = new Set(["às", "as", "dia", "para", "pra", "na", "no"]);

/**
 * Separa o título, a data, a hora e as tags. As tags valem em qualquer lugar do texto; data e hora, só no fim,
 * para "Ler o jornal de hoje cedo" continuar sendo só um título.
 */
export function analisar(texto, hoje) {
  const tags = [];
  const palavras = [];
  for (const palavra of texto.split(/\s+/).filter(Boolean)) {
    if (palavra.startsWith("#") && palavra.length > 1) {
      const tag = palavra.slice(1);
      if (!tags.includes(tag)) tags.push(tag);
    } else {
      palavras.push(palavra);
    }
  }
  let data = null;
  let hora = null;
  while (palavras.length) {
    const ultima = palavras[palavras.length - 1].toLowerCase();
    const h = horaRapida(ultima);
    const d = dataRapida(ultima, hoje);
    if (hora === null && h !== null) hora = h;
    else if (data === null && d !== null) data = d;
    else break;
    palavras.pop();
    // "depois de amanhã".
    if (ultima.startsWith("amanh") && palavras.length >= 2
      && palavras[palavras.length - 2].toLowerCase() === "depois" && palavras[palavras.length - 1].toLowerCase() === "de") {
      palavras.length -= 2;
      data = somaDias(data, 1);
    }
    // As ligações: "às 14h", "dia 05/11", "para sexta".
    if (palavras.length && LIGACOES.has(palavras[palavras.length - 1].toLowerCase())) palavras.pop();
  }
  if (palavras.length === 0) {
    // Sem sobrar título, o texto inteiro é o título: uma tarefa chamada "hoje" é uma escolha válida.
    return { titulo: texto.trim(), data: null, hora: null, tags: [] };
  }
  return { titulo: palavras.join(" "), data, hora, tags };
}
