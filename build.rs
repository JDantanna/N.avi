fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set("ProductName", "N.avi");
        res.set("FileDescription", "N.avi");
        if let Err(e) = res.compile() {
            println!("cargo:warning=icone nao embutido: {e}");
        }
    }
}
