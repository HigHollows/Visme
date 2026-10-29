mod sidecar;

use sidecar::{Sidecar, SidecarState};
use std::sync::Mutex;
use tauri::{Manager, State};

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Seul point d'entrée de l'UI vers le backend : relaie un appel JSON-RPC au sidecar.
#[tauri::command]
fn rpc(state: State<SidecarState>, method: String, params: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let sc = guard.as_mut().ok_or("sidecar non démarré")?;
    sc.call(&method, params.unwrap_or(serde_json::json!({})))
}

pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            // En dev, la racine du dépôt est deux niveaux au-dessus de src-tauri/../
            let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let data_dir = app.path().app_data_dir()?;
            let mut sc = Sidecar::spawn(root.canonicalize()?).map_err(|e| e.to_string())?;
            sc.init(&data_dir.to_string_lossy(), "default")?;
            *app.state::<SidecarState>().0.lock().unwrap() = Some(sc);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_version, rpc])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}
