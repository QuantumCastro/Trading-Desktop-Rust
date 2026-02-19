use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoResponse {
    pub product_name: String,
    pub version: String,
    pub identifier: String,
    pub platform: String,
    pub arch: String,
}

pub fn build_app_info_response(
    product_name: String,
    version: String,
    identifier: String,
) -> AppInfoResponse {
    AppInfoResponse {
        product_name,
        version,
        identifier,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfoResponse {
    let package = app.package_info();
    let config = app.config();
    let product_name = config
        .product_name
        .clone()
        .unwrap_or_else(|| package.name.clone());

    build_app_info_response(
        product_name,
        package.version.to_string(),
        config.identifier.clone(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_contains_runtime_metadata() {
        let response = build_app_info_response(
            "Desktop Template".to_string(),
            "0.1.0".to_string(),
            "com.template.desktop".to_string(),
        );

        assert!(!response.product_name.is_empty());
        assert!(!response.version.is_empty());
        assert!(!response.identifier.is_empty());
        assert!(!response.platform.is_empty());
        assert!(!response.arch.is_empty());
    }
}
