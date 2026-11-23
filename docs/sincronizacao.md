# Sincronização entre aparelhos

Como as tarefas do N.avi passam do computador para o celular (PWA) e voltam, sem servidor próprio, sem conta
além da nuvem que a pessoa já usa, e sem perder dado quando os dois mexem ao mesmo tempo.

## O arquivo

Um único arquivo JSON, `N.avi.sync.json`, numa pasta de nuvem escolhida pela pessoa. Só tarefas, tags e cores de
tags: o uso dos programas (Monitoramento) não entra por enquanto.

```json
{
  "schema": 1,
  "app": "N.avi",
  "written_by": "a3f9…",            // id do aparelho que gravou por último (só informativo)
  "written_at": 1764000000123,       // carimbo da gravação
  "clock": 1764000000123,            // maior carimbo já dado ou visto por quem gravou
  "tasks": [
    {
      "uid": "7c1d…",                // identidade entre aparelhos (o id numérico local não sai da máquina)
      "title": "Reunião", "notes": "", "done": false,
      "subtasks": [{ "title": "Pauta", "done": true }],
      "date": "2026-11-05", "time": "14:30:00",
      "notify": 15, "notify_day_before": false,
      "tags": ["trabalho"], "color": [236, 112, 99],
      "repeat": "Weekly", "every": 1, "anchor_day": 5, "repeat_times": null,
      "stamps": { "title": 1764000000001, "notes": 0, "state": 1764000000001,
                  "notify": 0, "tags": 1764000000001, "color": 0, "subtasks": 1764000000001 }
    }
  ],
  "deleted": [ { "uid": "e21b…", "at": 1763990000000 } ],
  "tags": { "casa": { "color": [110, 142, 251], "at": 1763980000000 },
            "antiga": { "color": null, "at": 1763985000000 } }
}
```

- `schema`: versão do formato. Quem lê um `schema` maior que o seu não grava nada e pede atualização.
- `repeat`: `"None" | "Daily" | "Weekly" | "Monthly" | "Yearly"`; datas como `AAAA-MM-DD`, horas como `HH:MM:SS`.
- Tag com `color: null` é uma cor removida (a remoção também precisa chegar aos outros aparelhos).

## Carimbos: um relógio que não anda para trás

Todo carimbo é um instante em milissegundos (Unix), mas tirado de um relógio híbrido: cada aparelho guarda o
maior carimbo que já deu ou viu (`clock`) e todo carimbo novo é `max(agora, clock + 1)`. Assim um computador com
o relógio atrasado nunca produz um carimbo "no passado" de algo que ele já mesclou, e um relógio adiantado só
faz os outros adiantarem o `clock` deles ao ler o arquivo. Ninguém depende de os aparelhos terem a mesma hora.

Cada tarefa tem um carimbo **por grupo de campos**, não um só:

| grupo | campos | por quê |
|---|---|---|
| `title` | título | |
| `notes` | informações | |
| `state` | data, hora, concluída, repetição, a cada, dia-âncora, vezes restantes | concluir uma recorrente muda tudo isso de uma vez |
| `notify` | aviso, aviso no dia anterior | |
| `tags` | lista de tags | a lista inteira, para uma tag tirada não voltar |
| `color` | cor | |
| `subtasks` | checklist inteiro | |

O carimbo do grupo é refeito quando algum campo dele muda, no momento de gravar (o app compara com a última
gravação, então toda mudança é apanhada, venha de onde vier: edição, concluir, importar `.ics`, desfazer).

## Exclusões guardadas

Excluir uma tarefa guarda uma **lápide** `{ uid, at }` em vez de simplesmente sumir com ela: é o que leva a
exclusão aos outros aparelhos. As lápides vivem 90 dias; um aparelho que passar mais de 90 dias sem sincronizar
pode fazer uma tarefa excluída voltar (é o preço de não ter servidor; aceitável para uso pessoal).

## Mesclagem

Toda sincronização é: ler o arquivo, mesclar com o que está no aparelho, gravar o resultado. A regra é
determinística, então dois aparelhos que mesclem os mesmos dados chegam ao mesmo resultado, em qualquer ordem.

1. **Tarefa que existe nos dois lados**: grupo a grupo, vence o carimbo maior. Empate exato de carimbo com
   conteúdo diferente: vence o grupo cujo texto canônico (`Task::group_key`) é maior, para os dois lados
   escolherem o mesmo. Concluir no celular e mudar o título no computador ao mesmo tempo mantém os dois.
2. **Tarefa só de um lado, sem lápide**: entra no outro (é nova).
3. **Lápide contra tarefa**: a lápide vence se `at` é maior ou igual ao maior carimbo da tarefa (a exclusão veio
   depois da última edição). Se a tarefa foi editada **depois** da exclusão, ela sobrevive e a lápide cai: editar
   algo é um sinal mais forte de que a pessoa quer aquilo do que uma exclusão anterior.
4. **Cores de tags**: por tag, vence o carimbo maior; `null` remove.
5. `clock` do aparelho passa a ser o máximo entre o dele, o do arquivo e todo carimbo lido.
6. O arquivo só é regravado se o conteúdo mesclado difere do que estava nele (ou se há mudança local), para dois
   aparelhos não ficarem regravando o mesmo conteúdo em formatos diferentes.

Arquivo ilegível (JSON quebrado, upload pela metade): é posto de lado como `N.avi.sync.corrompido-<data>.json`,
o app avisa, e grava o estado dele no lugar. Nada do aparelho é apagado por causa de um arquivo ruim.

## Onde o arquivo fica

- **Computador**: numa pasta que a pessoa escolhe na janela de Backup, de preferência sincronizada por Google
  Drive (`Meu Drive\N.avi`) ou OneDrive (`OneDrive\Apps\N.avi`). O app lê o arquivo a cada 20 s e logo depois
  de gravar as tarefas, em segundo plano (a unidade da nuvem pode demorar), e grava com arquivo temporário e
  troca, para a nuvem nunca receber um arquivo pela metade.
- **Celular (PWA)**: sem cliente de nuvem, o site fala com a nuvem pela API:
  - **Google Drive** com o escopo `drive.file` (só os arquivos que o próprio app criou ou que a pessoa abriu).
    Na primeira vez, o Google Picker deixa a pessoa escolher o `N.avi.sync.json` criado pelo computador; o app
    guarda o id do arquivo e dali em diante lê e grava por ele (`files.get?alt=media`, `files.update` com
    `If-Match` do ETag para não gravar por cima de uma versão que não leu).
  - **OneDrive** com o escopo `Files.ReadWrite.AppFolder`: a pasta especial do app, `Apps/N.avi`
    (`/me/drive/special/approot`), que o cliente do OneDrive no computador sincroniza como uma pasta comum.
  Nos dois casos o login é o da própria nuvem, no navegador; o N.avi não guarda senha de nada.

## Mesma lógica nos dois lados

O celular precisa de recorrência (`occurs_on`, `roll_over`) e de mesclagem iguais às do Rust, senão uma tarefa
mensal cai em dias diferentes em cada aparelho. Em vez de portar o Rust para WASM (que pesaria e exigiria uma
ponte para o DOM), as duas implementações compartilham **casos de teste em JSON**, em `docs/sync-casos/`:

- `mesclagem.json`: estado local, estado remoto e o resultado esperado da mesclagem;
- `recorrencia.json`: tarefas recorrentes com os dias em que caem, os em que não caem e o que acontece ao concluir.

Os testes do Rust (`src/sync.rs`, `src/model.rs`) leem esses arquivos; o PWA fará o mesmo com os mesmos arquivos.
Um caso novo entra primeiro no JSON e só então nas duas implementações. Se um dia a lógica crescer, o WASM continua
possível: a mesclagem e a recorrência já são funções puras, sem Windows nem interface.
