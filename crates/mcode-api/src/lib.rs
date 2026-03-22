pub use mcode_core;

pub fn api_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_version_matches_core() {
        assert_eq!(api_version(), mcode_core::version());
    }
}
