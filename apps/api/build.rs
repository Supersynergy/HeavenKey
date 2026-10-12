fn main() {
    println!("cargo:rerun-if-changed=../web/dist/main.js");
    assert!(
        std::path::Path::new("../web/dist/main.js").is_file(),
        "Build the browser assets first: bun run build"
    );
}
