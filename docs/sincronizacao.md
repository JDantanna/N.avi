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
- `repeat`: `"None" | "Daily" | "Weekly" | "Monthly" | "Yearly"`.
- Tag com `color: null` é uma cor removida (a remoção também precisa chegar aos outros aparelhos).

### Identidade das tarefas

Cada aparelho numera as tarefas com um inteiro sequencial (`next_id`), e dois aparelhos criam o mesmo `7` ao mesmo
tempo. Por isso o inteiro **fica na máquina** (é a alça da interface e do arquivo local) e **não sai no arquivo de
sincronização**; o que identifica a tarefa entre aparelhos é o `uid`: 32 dígitos hexadecimais, 128 bits aleatórios,
gerado ao criar a tarefa (`model::fresh_uid` no desktop, `novoUid()` com `crypto.getRandomValues` no web). Migração:
no primeiro carregamento de um arquivo antigo, cada tarefa sem `uid` ganha um; uma tarefa que chega de outro
aparelho recebe um `id` local novo ao entrar. Nada que já existe muda de número.

### Datas e horas

Sempre como texto, sem fuso: datas `AAAA-MM-DD` e horas `HH:MM:SS` (o desktop grava assim por padrão; o web
completa `HH:MM` para `HH:MM:SS` ao gravar). Carimbos são inteiros em ms Unix, nunca datas.

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

O carimbo do grupo é refeito quando algum campo dele muda, no momento de gravar e **logo antes de cada
mesclagem** (o app compara com a referência da última gravação ou mesclagem, então toda mudança é apanhada,
venha de onde vier: edição, concluir, importar `.ics`, desfazer). Depois de cada mesclagem essa referência passa
a ser o estado mesclado, com os carimbos que vieram nele: um valor recebido de outro aparelho **nunca** é
recarimbado como se fosse edição daqui. Sem isso, B receberia "X"@200, o regravaria como "X"@211 e venceria a
edição "Y"@205 feita em C, que é a mais recente.

## Exclusões guardadas

Excluir uma tarefa guarda uma **lápide** `{ uid, at }` em vez de simplesmente sumir com ela: é o que leva a
exclusão aos outros aparelhos. As lápides vivem 90 dias, contados pelo **relógio de parede** do aparelho que poda
(nunca pelo relógio híbrido, que um aparelho com a hora adiantada empurra para o futuro e podaria tudo de uma
vez); uma lápide com `at` no futuro fica. Um aparelho que passar mais de 90 dias sem sincronizar pode fazer uma
tarefa excluída voltar (é o preço de não ter servidor; aceitável para uso pessoal).

**Desfazer** uma exclusão (o aviso de 6 s) tira a lápide local e devolve a tarefa carimbada de agora, em todos
os grupos: se a lápide já tinha ido ao arquivo, a tarefa restaurada vence (regra 3 abaixo) e a lápide cai.

## Mesclagem

Toda sincronização é: ler o arquivo, mesclar com o que está no aparelho, gravar o resultado. A mesclagem roda
**na thread da interface, sobre as tarefas como estão naquele instante**; a thread de fundo só lê bytes e grava
bytes. Assim nada é aplicado "depois" por cima do que a pessoa digitou entre a leitura e a aplicação, e uma
edição ainda não gravada ganha carimbo (com o relógio já adiantado pelo arquivo) antes de ser comparada: é a
mudança mais recente e não perde para o arquivo. A regra é determinística, então dois aparelhos que mesclem os
mesmos dados chegam ao mesmo resultado, em qualquer ordem.

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
7. **Cópias de conflito**: quando duas gravações quase juntas fazem a nuvem criar `N.avi.sync (1).json`
   (Google), `N.avi.sync-NOMEDOPC.json` (OneDrive) ou `N.avi.sync (conflicted copy ...).json` (Dropbox), o
   computador lê todo `N.avi.sync*.json` da pasta (menos os `.corrompido-`), mescla cada cópia como se fosse
   outro arquivo remoto e depois a move para a subpasta `conflitos/`, sem apagar nada.
8. **Primeira mesclagem com um arquivo que já existe** (computador migrado de uma versão sem sincronização,
   backup antigo restaurado): uma tarefa daqui sem par no arquivo e uma do arquivo sem par aqui, **iguais em
   todos os grupos**, são a mesma tarefa que ganhou `uid`s diferentes. A daqui assume o `uid` e os carimbos da do
   arquivo, mantendo o `id` local; sem isso tudo apareceria em dobro. Se algo difere (informações só de um lado,
   checklist, tags...), as duas ficam: uma duplicata visível, que a pessoa apaga, em vez de perder conteúdo em
   silêncio. Isso acontece uma vez só por aparelho (`synced_once`), na primeira entrada de verdade, não a cada
   vez que a pasta é escolhida; depois, duas tarefas iguais criadas em lados diferentes são mesmo duas.

### Os dois lados mudaram o mesmo grupo: combinar, não escolher

A regra 1 (vence o carimbo maior) só vale quando um lado mudou. Cada aparelho guarda a tarefa como estava **ao
fim da última mesclagem que ele fez** (`Store.base`): um retrato à parte, atualizado só por `mark_synced` e gravado
no disco com as tarefas, porque a mesclagem seguinte pode ser em outra execução. Não serve a referência de
carimbar, que toda gravação refaz e por isso é sempre igual ao local. Se, em relação a essa base, **os dois lados mudaram o mesmo grupo** e os valores diferem, o grupo é combinado, para
nada se perder:

- **tags**: união (as daqui na ordem daqui, depois as de lá que faltavam);
- **checklist**: união por item (pelo título), e o item fica concluído se **qualquer** lado o concluiu. Um item
  apagado num lado pode voltar; aceitável, porque não perde nada;
- **informações**: fica o texto que venceria pela regra 1 e, embaixo de uma linha
  `--- versão de outro aparelho ---`, o texto do outro lado. Se um lado está vazio (apagou), fica só o outro,
  sem separador; se um lado já contém o outro (uma combinação anterior), fica o maior, sem acrescentar de novo.
  Cópias de conflito são mescladas uma a uma, e o resultado de cada mesclagem vira a base da seguinte, para a
  mesma versão não ser acrescentada duas vezes.

O grupo combinado recebe um **carimbo novo**, `max(agora, clock + 1)`, à frente de tudo o que o aparelho já viu:
assim o resultado combinado vence as duas versões em qualquer outro aparelho pela regra 1, e os dois convergem.
O mesmo valor nos dois lados nunca é conflito (só o carimbo converge para o maior). Título, data/estado, aviso e
cor não se combinam: seguem o carimbo. Sem base (tarefa que este aparelho nunca sincronizou), vale a regra 1.

### Arquivo ilegível

Um JSON que não se lê **quase sempre é um download do cliente da nuvem pela metade**, não um arquivo
corrompido. Por isso o computador não conclui nada na primeira leitura: relê três vezes, com 3 s de intervalo,
enquanto o conteúdo não mudar. Só então:

1. guarda uma **cópia** como `N.avi.sync.corrompido-<data>.json` (copia, nunca renomeia: renomear levaria junto a
   identidade do arquivo na nuvem, e o celular passaria a gravar na cópia);
2. aproveita o que ainda se lê inteiro (tarefas, lápides e tags completas) e mescla isso, o que só acrescenta ou
   atualiza: nada do aparelho é apagado por causa de um arquivo ruim;
3. regrava o conteúdo no **mesmo** arquivo e avisa na janela de Backup.

## Onde o arquivo fica

- **Computador**: numa pasta que a pessoa escolhe na janela de Backup, de preferência sincronizada por Google
  Drive (`Meu Drive\N.avi`) ou OneDrive (`OneDrive\Apps\N.avi`). O app lê a pasta a cada 20 s e logo depois
  de gravar as tarefas, em segundo plano (a unidade da nuvem pode demorar). A gravação **regrava o conteúdo do
  próprio arquivo** (abrir, truncar, escrever, `fsync`) e confere lendo de volta, com três tentativas. Se a
  leitura de volta encontrar **outro conteúdo** (o cliente da nuvem trouxe a versão de outro aparelho entre a
  gravação e a conferência), o app não regrava por cima: relê, mescla e só então grava. Nunca
  troca o arquivo por outro via renomeação, porque o Google Drive trata a troca como "apagar e criar" e o
  arquivo novo ganha outro id, invisível para o celular (ver abaixo). O leitor que apanhar o arquivo no meio de
  uma gravação vê um JSON pela metade, que a releitura descrita acima absorve.
- **Celular (PWA)**: sem cliente de nuvem, o site fala com a nuvem pela API:
  - **Google Drive** com o escopo `drive.file` (só os arquivos que o próprio app criou ou que a pessoa abriu).
    Na primeira vez, o Google Picker deixa a pessoa escolher o `N.avi.sync.json` criado pelo computador; o app
    guarda o id do arquivo e dali em diante lê e grava por ele (`files.get?alt=media`, `files.update`).
    **A cada leitura o app confere o arquivo do id** (`files.get` com `fields=trashed,parents,version`): se
    ele está na lixeira ou saiu da pasta, o app para, avisa e pede para escolher o arquivo de novo; nunca segue
    gravando num órfão.
    **Não há gravação condicional no Drive v3**: a referência de `files.update` não aceita `If-Match`, o
    recurso de arquivo não tem `etag`, e os campos `version` (monotônico, muda a cada alteração) e
    `headRevisionId` são só de leitura (conferido na documentação em 2026-11-23). O que dá para fazer é
    comparar o `version` lido antes com o de imediatamente antes de gravar e, se mudou, reler e mesclar de novo;
    não é atômico. A garantia de não perder dado vem de cada aparelho guardar o próprio estado e mesclar de
    novo (item 7 e seção seguinte), não da API.
  - **OneDrive** com o escopo `Files.ReadWrite.AppFolder`: a pasta especial do app, `Apps/N.avi`
    (`/me/drive/special/approot`), acessada por caminho, que o cliente do OneDrive no computador sincroniza
    como uma pasta comum. O Microsoft Graph aceita `If-Match` com o `eTag`, então a gravação pode ser
    condicional de verdade.
  Nos dois casos o login é o da própria nuvem, no navegador; o N.avi não guarda senha de nada.
- **O estado local do celular precisa durar**: o iOS pode apagar os dados de sites (IndexedDB) depois de semanas
  sem uso, e a cura dos conflitos depende de cada aparelho ter o próprio estado para mesclar de novo. O PWA
  grava no arquivo logo depois de cada edição (com nova tentativa se falhar), pede `navigator.storage.persist()`
  e mostra como pendente toda edição que ainda não chegou ao arquivo. Perdido o estado local, a nuvem é a fonte:
  o app recomeça do arquivo, e o que estava pendente é o único que se perde.

## Restaurar um backup com a sincronização ligada

Restaurar o zip troca os dados por um estado antigo, com carimbos antigos; a mesclagem seguinte traria de volta
tudo o que o arquivo tem de mais novo, inclusive as lápides, desfazendo o que a pessoa quis recuperar. Por isso,
ao concluir a restauração, **tudo o que foi restaurado é recarimbado como editado agora** (tarefas, grupo a
grupo, e cores de tags), com o relógio à frente do de antes da restauração, e a janela avisa disso antes de
restaurar. A **base** continua a de antes da restauração: uma anotação, item de checklist ou tag que outro
aparelho mudou depois do backup é combinada com o restaurado (seção "combinar, não escolher"), não apagada por
ele; título e estado seguem o restaurado. O que só existe nos outros aparelhos (criado depois do backup) continua lá e volta pela mesclagem:
restaurar recupera, não apaga. A pasta de sincronização e a identidade do aparelho não vêm do backup: são desta
máquina. Um backup de antes dos `uid`s ganha `uid`s novos ao carregar e passa pela regra 8 da mesclagem, que
casa cada tarefa com a do arquivo em vez de duplicá-la.

## Mesma lógica nos dois lados

O web é JavaScript puro, sem compilação. A recorrência (`occurs_on`, `next_after`, `roll_over`, `overdue`) foi
portada para `web/js/recorrencia.js`, e a mesclagem seguirá o mesmo caminho. Para as duas pontas nunca divergirem
(uma tarefa mensal caindo em dias diferentes em cada aparelho), elas rodam **os mesmos vetores de teste em JSON**:

- `web/tests/vetores-recorrencia.json`: em que dias cada tarefa recorrente cai, a data seguinte a uma ocorrência,
  o que acontece ao concluir (`reagendar` / `roll_over_on(hoje)`, com `hoje` sempre dado, nunca lido do relógio)
  e quando uma tarefa está atrasada (sem `time` só no dia seguinte, com `time` quando a hora passa).
  Rodado por `web/tests/logica.test.mjs` e por `model.rs` (`recorrencia_segue_os_vetores_compartilhados_com_o_web`).
- `docs/sync-casos/mesclagem.json`: estado local, estado remoto e o resultado esperado da mesclagem, com o
  relógio de parede (`agora`) de cada caso, a `base` (o estado da última mesclagem, para os casos em que os dois
  lados mudaram o mesmo grupo) e a marca `primeira_vez` para os casos da regra 8. Rodado por
  `src/sync.rs` hoje e pelo web quando a mesclagem chegar lá.

Um caso novo entra primeiro no JSON e só então nas duas implementações. Se um dia a lógica crescer, o WASM continua
possível: a mesclagem e a recorrência já são funções puras, sem Windows nem interface.
