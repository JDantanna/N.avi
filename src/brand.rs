//! O nome do app como o usuário lê e os títulos das janelas.
//!
//! Os títulos também são o que o Windows usa para achar cada janela (`FindWindowW`): quem abre a janela e quem
//! a procura leem daqui, então nunca ficam diferentes. O executável (`navi.exe`), a pasta de dados
//! (`%APPDATA%\Navi`) e o `AppId` do instalador mantêm o nome antigo de propósito: trocá-los quebraria os dados
//! e a atualização de quem já tem o app instalado.

/// Nome do app em qualquer texto que o usuário lê.
pub const NAME: &str = "N.avi";
/// Nome gravado por versões antigas (por exemplo, no cache de nomes dos programas).
const OLD_NAME: &str = "Navi";

/// Janela principal (a que a bandeja esconde e mostra).
pub const MAIN_TITLE: &str = "N.avi";
/// Janela flutuante do widget.
pub const WIDGET_TITLE: &str = "N.avi · Monitoramento";
/// Painel que o botão direito abre no widget e na aba Monitoramento.
pub const PANEL_TITLE: &str = "N.avi · Programa";
/// Lista flutuante das tarefas de hoje.
pub const TASKS_TITLE: &str = "N.avi · Tarefas de hoje";

/// O nome é o do próprio app (como ele aparece no rastreador quando está na frente)?
pub fn is_own_name(name: &str) -> bool {
    name == NAME || name == OLD_NAME
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titulos_levam_o_nome_e_nao_se_confundem() {
        let titles = [MAIN_TITLE, WIDGET_TITLE, PANEL_TITLE, TASKS_TITLE];
        for t in titles {
            assert!(t.starts_with(NAME), "{t:?}");
        }
        // `FindWindowW` casa o título inteiro: dois títulos iguais achariam a janela errada.
        for (i, a) in titles.iter().enumerate() {
            for b in &titles[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_eq!(MAIN_TITLE, NAME);
    }

    #[test]
    fn reconhece_o_nome_novo_e_o_antigo() {
        assert!(is_own_name("N.avi") && is_own_name("Navi"));
        assert!(!is_own_name("Chrome") && !is_own_name("") && !is_own_name("N.avi Backup"));
    }
}
