//! Bandeja do sistema. Ao "ir para a bandeja" a janela some da barra de tarefas e sai
//! da tela (continua existindo e desenhando, então o widget flutuante segue atualizando);
//! clicar no ícone da bandeja traz tudo de volta.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use eframe::egui;
use crate::brand;
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, GetWindowPlacement, GetWindowRect, IsIconic, SW_HIDE, SW_SHOW, SW_SHOWMAXIMIZED,
    SW_SHOWNOACTIVATE, SW_SHOWNORMAL, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SetForegroundWindow, SetWindowLongPtrW,
    SetWindowPlacement, SetWindowPos, ShowWindow, WINDOWPLACEMENT, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

const OPEN_ID: &str = "navi-open";
const QUIT_ID: &str = "navi-quit";

static WANT_RESTORE: AtomicBool = AtomicBool::new(false);
static WANT_QUIT: AtomicBool = AtomicBool::new(false);
static SAVED: Mutex<Option<Saved>> = Mutex::new(None);

/// Canto de onde a janela escondida fica, longe de qualquer monitor.
const OFFSCREEN: i32 = -32000;

/// Onde a janela estava antes de ir para a bandeja (posição normal, em coordenadas da área de trabalho).
struct Saved {
    rect: RECT,
    maximized: bool,
}

/// Pedidos feitos pelo ícone da bandeja, a tratar no laço da interface.
pub enum Request {
    Restore,
    Quit,
}

pub fn take_request() -> Option<Request> {
    if WANT_QUIT.swap(false, Ordering::Relaxed) {
        Some(Request::Quit)
    } else if WANT_RESTORE.swap(false, Ordering::Relaxed) {
        Some(Request::Restore)
    } else {
        None
    }
}

pub struct Tray {
    _icon: TrayIcon,
}

/// A janela principal deste app (só desta thread: nunca a de outro programa com o mesmo título).
fn main_window() -> HWND {
    crate::chrome::find_window(brand::MAIN_TITLE).unwrap_or(std::ptr::null_mut())
}

/// A janela principal está escondida fora da tela, como `enter` a deixa (e não só minimizada, que também fica
/// em -32000 para o Windows). É o que diz se o app está de fato na bandeja, aconteça o que acontecer com o
/// resto do estado.
pub fn is_hidden() -> bool {
    let hwnd = main_window();
    if hwnd.is_null() {
        return false;
    }
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetWindowRect(hwnd, &mut r) != 0 && IsIconic(hwnd) == 0 } && r.left <= OFFSCREEN / 2
}

/// Esconde a janela principal e põe o ícone na bandeja.
pub fn enter(ctx: &egui::Context, rgba: &[u8]) -> Option<Tray> {
    // Os testes não mexem na janela do Navi que estiver aberta na máquina de quem os roda.
    if cfg!(test) {
        return None;
    }
    let hwnd = main_window();
    if hwnd.is_null() {
        return None;
    }
    let menu = Menu::new();
    menu.append(&MenuItem::with_id(OPEN_ID, format!("Abrir o {}", brand::NAME), true, None)).ok()?;
    menu.append(&MenuItem::with_id(QUIT_ID, "Sair", true, None)).ok()?;
    let icon = TrayIconBuilder::new()
        .with_icon(Icon::from_rgba(rgba.to_vec(), 64, 64).ok()?)
        .with_tooltip(brand::NAME)
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .build()
        .ok()?;

    let c = ctx.clone();
    TrayIconEvent::set_event_handler(Some(move |e: TrayIconEvent| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            WANT_RESTORE.store(true, Ordering::Relaxed);
            c.request_repaint();
        }
    }));
    let c = ctx.clone();
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        match e.id.0.as_str() {
            OPEN_ID => WANT_RESTORE.store(true, Ordering::Relaxed),
            QUIT_ID => WANT_QUIT.store(true, Ordering::Relaxed),
            _ => return,
        }
        c.request_repaint();
    }));

    unsafe {
        // O lugar da janela vem sempre de `GetWindowPlacement`, que serve para minimizada ou não e usa as
        // mesmas coordenadas (da área de trabalho) com que `leave` a devolve. `GetWindowRect` não serve:
        // minimizada, a janela diz estar em (-32000, -32000).
        let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
        placement.length = size_of::<WINDOWPLACEMENT>() as u32;
        GetWindowPlacement(hwnd, &mut placement);
        let was_iconic = IsIconic(hwnd) != 0;
        let normal = placement.rcNormalPosition;
        let mut saved = SAVED.lock().unwrap();
        if saved.is_none() {
            *saved = Some(Saved { rect: normal, maximized: placement.showCmd == SW_SHOWMAXIMIZED as u32 });
        }
        // Sem botão na barra de tarefas e fora da tela, mas ainda "visível" para o sistema.
        ShowWindow(hwnd, SW_HIDE);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize));
        if was_iconic {
            // Uma janela minimizada não pode ficar assim na bandeja (apareceria como uma barrinha no canto da
            // tela), e ao ser restaurada ela iria para a posição normal dela, que é na tela. Então a posição
            // normal passa a ser fora da tela, e a janela é restaurada sem ser ativada (para o teclado não ir
            // parar numa janela que ninguém vê). O lugar de verdade fica guardado em `SAVED`.
            placement.rcNormalPosition = RECT {
                left: OFFSCREEN,
                top: OFFSCREEN,
                right: OFFSCREEN + (normal.right - normal.left),
                bottom: OFFSCREEN + (normal.bottom - normal.top),
            };
            placement.flags = 0;
            placement.showCmd = SW_SHOWNOACTIVATE as u32;
            SetWindowPlacement(hwnd, &placement);
        } else {
            SetWindowPos(hwnd, std::ptr::null_mut(), OFFSCREEN, OFFSCREEN, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }
    Some(Tray { _icon: icon })
}

/// Traz a janela de volta ao lugar de antes (e ao tamanho, maximizada ou não).
pub fn leave() {
    let hwnd = main_window();
    if hwnd.is_null() {
        return;
    }
    unsafe {
        ShowWindow(hwnd, SW_HIDE);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & !(WS_EX_TOOLWINDOW as isize)) | WS_EX_APPWINDOW as isize);
        match SAVED.lock().unwrap().take() {
            Some(saved) => {
                // As coordenadas de `SetWindowPlacement` são as mesmas de `GetWindowPlacement`, que guardou o lugar.
                let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
                placement.length = size_of::<WINDOWPLACEMENT>() as u32;
                GetWindowPlacement(hwnd, &mut placement);
                placement.rcNormalPosition = saved.rect;
                placement.flags = 0;
                let show = if saved.maximized { SW_SHOWMAXIMIZED } else { SW_SHOWNORMAL };
                placement.showCmd = show as u32;
                SetWindowPlacement(hwnd, &placement);
            }
            None => {
                // Sem lugar guardado (o app perdeu a conta de ter ido para a bandeja): se a janela está fora da
                // tela, volta para o meio do monitor principal em vez de ser mostrada onde ninguém vê.
                let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
                if GetWindowRect(hwnd, &mut r) != 0
                    && r.left <= OFFSCREEN / 2
                    && let Some(work) = crate::chrome::primary_work_area()
                {
                    let (w, h) = (r.right - r.left, r.bottom - r.top);
                    let x = work[0] + ((work[2] - work[0]) - w) / 2;
                    let y = work[1] + ((work[3] - work[1]) - h) / 2;
                    SetWindowPos(hwnd, std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                }
                ShowWindow(hwnd, SW_SHOW);
            }
        }
        SetForegroundWindow(hwnd);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sem_janela_nao_esta_escondida() {
        // O processo dos testes não tem a janela do app: nada a esconder, nada escondido.
        assert!(!super::is_hidden());
        assert!(super::main_window().is_null());
    }
}
