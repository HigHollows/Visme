mod sidecar;

use sidecar::{Sidecar, SidecarState};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, State, WindowEvent};

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Pastille de l'icône de l'app : nombre de suggestions « À valider » (0 = aucune).
#[tauri::command]
fn set_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.set_badge_count(if count == 0 { None } else { Some(count as i64) }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Seul point d'entrée de l'UI vers le backend : relaie un appel JSON-RPC au sidecar.
#[tauri::command]
async fn rpc(state: State<'_, SidecarState>, method: String, params: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    state.get()?.call(&method, params.unwrap_or(serde_json::json!({}))).await
}

/// La clé API va directement de l'UI au trousseau puis au sidecar ; elle n'est jamais relue par l'UI.
#[tauri::command]
async fn secret_set(state: State<'_, SidecarState>, provider: String, key: String) -> Result<(), String> {
    if key.is_empty() {
        sidecar::delete_api_key(&provider)?;
    } else {
        sidecar::store_api_key(&provider, &key)?;
    }
    state.get()?.call("ai.setKeys", serde_json::json!({ "keys": { provider: key } })).await?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            // En dev, la racine du dépôt est trois niveaux au-dessus de src-tauri.
            let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let data_dir = app.path().app_data_dir()?;
            let sc = Sidecar::spawn(root.canonicalize()?, app.handle().clone())?;
            tauri::async_runtime::block_on(sc.init(&data_dir.to_string_lossy(), "default"))?;
            *app.state::<SidecarState>().0.lock().unwrap() = Some(sc);

            // Icône de la zone de notification : l'agent continue de tourner fenêtre fermée.
            let open = MenuItem::with_id(app, "open", "Ouvrir ASSISTANT", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("icône absente")?.clone())
                .tooltip("ASSISTANT")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fermer la fenêtre la masque seulement ; « Quitter » (menu de la barre) arrête vraiment l'application.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![app_version, rpc, secret_set, set_badge])
        .build(tauri::generate_context!())
        .expect("erreur au lancement de l'application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
