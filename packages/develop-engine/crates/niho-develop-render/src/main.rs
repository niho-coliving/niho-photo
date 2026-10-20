//! `niho-develop-render` — see the crate docs (`src/lib.rs`) and README
//! "native CLI（NIHO Desktop の原寸の書き出し）".

fn main() {
    niho_develop_render::install_panic_hook();
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(niho_develop_render::run(&args));
}
