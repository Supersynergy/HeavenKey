fn main() {
    println!("cargo:rerun-if-changed=../web/dist/main.js");
    println!("cargo:rerun-if-changed=../demo");
    assert!(
        std::path::Path::new("../web/dist/main.js").is_file(),
        "Build the browser assets first: bun run build"
    );
}
