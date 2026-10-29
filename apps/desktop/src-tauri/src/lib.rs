mod profiles;
mod sidecar;

use profiles::{clean_color, clean_name, make_id, Profile, Registry};
use sidecar::{Sidecar, SidecarState};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

pub struct ShortcutRegistered(pub Mutex<Option<Shortcut>>);

/// Affiche (ou masque) la petite fenêtre de capture rapide, même si la fenêtre principale est cachée.
fn toggle_capture(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let Some(w) = app.get_webview_window("capture") else { return };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("capture-open", ());
    }
}

/// Enregistre le raccourci global (remplace l'ancien). Renvoie une erreur lisible si la syntaxe ou le raccourci est invalide.
fn register_shortcut(app: &tauri::AppHandle, accel: &str) -> Result<(), String> {
    let sc: Shortcut = accel.parse().map_err(|_| format!("Raccourci invalide : « {accel} »"))?;
    let state = app.state::<ShortcutRegistered>();
    let gs = app.global_shortcut();
    if let Some(old) = state.0.lock().unwrap().take() {
        let _ = gs.unregister(old);
    }
    gs.register(sc).map_err(|e| format!("Raccourci indisponible (déjà utilisé ?) : {e}"))?;
    *state.0.lock().unwrap() = Some(sc);
    Ok(())
}

#[tauri::command]
fn set_capture_shortcut(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    register_shortcut(&app, &accelerator)
}

#[tauri::command]
fn hide_capture(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
}

/// Capture d'écran interactive (macOS) : l'utilisateur sélectionne une zone ; l'image PNG est renvoyée en base64.
#[tauri::command]
async fn capture_screen(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let capture = app.get_webview_window("capture");
        if let Some(w) = &capture { let _ = w.hide(); } // pour qu'elle n'apparaisse pas sur l'image
        let tmp = std::env::temp_dir().join(format!("assistant-shot-{}.png", std::process::id()));
        let path = tmp.clone();
        let status = tauri::async_runtime::spawn_blocking(move || std::process::Command::new("screencapture").args(["-i", "-x"]).arg(&path).status())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string());
        if let Some(w) = &capture { let _ = w.show(); let _ = w.set_focus(); }
        status?;
        let bytes = std::fs::read(&tmp).map_err(|_| "Capture annulée (ou autorisation « Enregistrement de l'écran » manquante dans Réglages Système)".to_string())?;
        let _ = std::fs::remove_file(&tmp);
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("La capture d'écran intégrée n'est disponible que sur macOS : faites une capture (Win+Maj+S) puis collez-la (Ctrl+V).".into())
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
async fn secret_set(app: tauri::AppHandle, state: State<'_, SidecarState>, reg: State<'_, ProfileState>, provider: String, key: String) -> Result<(), String> {
    let profile = reg.0.lock().unwrap().current.clone();
    if key.is_empty() {
        sidecar::delete_api_key(&profile, &provider)?;
    } else {
        sidecar::store_api_key(&profile, &provider, &key)?;
        // On retient le fournisseur pour pouvoir effacer ses clés si le profil est supprimé.
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let mut r = reg.0.lock().unwrap();
        if let Some(p) = r.profiles.iter_mut().find(|p| p.id == profile) {
            if !p.providers.contains(&provider) {
                p.providers.push(provider.clone());
            }
        }
        r.save(&dir)?;
    }
    state.get()?.call("ai.setKeys", serde_json::json!({ "keys": { provider: key } })).await?;
    Ok(())
}

pub struct ProfileState(pub Mutex<Registry>);

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn repo_root() -> Result<PathBuf, String> {
    // En dev, la racine du dépôt est trois niveaux au-dessus de src-tauri.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().map_err(|e| e.to_string())
}

#[tauri::command]
fn profiles_list(reg: State<'_, ProfileState>) -> Registry {
    reg.0.lock().unwrap().clone()
}

#[tauri::command]
fn profile_create(app: tauri::AppHandle, reg: State<'_, ProfileState>, name: String, color: String) -> Result<Profile, String> {
    let p = Profile { id: make_id(&name)?, name: clean_name(&name)?, color: clean_color(&color), providers: vec![] };
    let mut r = reg.0.lock().unwrap();
    if r.profiles.len() >= 12 {
        return Err("12 profils maximum".into());
    }
    r.profiles.push(p.clone());
    r.save(&data_dir(&app)?)?;
    Ok(p)
}

#[tauri::command]
fn profile_rename(app: tauri::AppHandle, reg: State<'_, ProfileState>, id: String, name: String, color: String) -> Result<(), String> {
    let mut r = reg.0.lock().unwrap();
    let p = r.profiles.iter_mut().find(|p| p.id == id).ok_or("Profil introuvable")?;
    p.name = clean_name(&name)?;
    p.color = clean_color(&color);
    r.save(&data_dir(&app)?)
}

/// Bascule de profil : le sidecar du profil précédent est arrêté (mémoire, clés et tâches en cours disparaissent avec lui),
/// puis un nouveau sidecar s'ouvre sur la base chiffrée du nouveau profil avec SES clés. Aucun état n'est partagé.
#[tauri::command]
async fn profile_switch(app: tauri::AppHandle, state: State<'_, SidecarState>, reg: State<'_, ProfileState>, id: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    if reg.0.lock().unwrap().get(&id).is_none() {
        return Err("Profil introuvable".into());
    }
    if reg.0.lock().unwrap().current == id {
        return Ok(());
    }
    let root = repo_root()?;
    let bundled = root.join("plugins");
    let old = state.0.lock().unwrap().take();
    drop(old); // arrête le sidecar précédent avant d'ouvrir l'autre base
    let sc = Sidecar::spawn(root, app.clone())?;
    sc.init(&dir.to_string_lossy(), &id, &bundled.to_string_lossy()).await?;
    *state.0.lock().unwrap() = Some(sc);
    {
        let mut r = reg.0.lock().unwrap();
        r.current = id;
        r.save(&dir)?;
    }
    use tauri::Emitter;
    let _ = app.emit("profile-changed", ());
    Ok(())
}

#[tauri::command]
fn profile_delete(app: tauri::AppHandle, reg: State<'_, ProfileState>, id: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let mut r = reg.0.lock().unwrap();
    if r.current == id {
        return Err("Impossible de supprimer le profil actif : basculez d'abord sur un autre profil.".into());
    }
    if r.profiles.len() <= 1 {
        return Err("Il faut garder au moins un profil.".into());
    }
    let p = r.get(&id).cloned().ok_or("Profil introuvable")?;
    for prov in &p.providers {
        let _ = sidecar::delete_api_key(&id, prov);
    }
    sidecar::delete_db_key(&id);
    // id = [a-z0-9-]+ (généré par make_id) : pas de traversée de chemin possible.
    if id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(dir.join(format!("{id}.{ext}")));
        }
        let _ = std::fs::remove_dir_all(dir.join("profiles-data").join(&id));
    }
    r.profiles.retain(|x| x.id != id);
    r.save(&dir)
}

/// Vue combinée en lecture seule : aperçu du jour des AUTRES profils. Chaque profil est ouvert dans un sidecar
/// temporaire qui n'a ni clé API ni agent, et qui est arrêté juste après. Rien n'est envoyé à une IA.
#[tauri::command]
async fn profiles_overview(app: tauri::AppHandle, reg: State<'_, ProfileState>) -> Result<Vec<serde_json::Value>, String> {
    let dir = data_dir(&app)?;
    let (current, profiles) = { let r = reg.0.lock().unwrap(); (r.current.clone(), r.profiles.clone()) };
    let root = repo_root()?;
    let mut out = vec![];
    for p in profiles.into_iter().filter(|p| p.id != current) {
        let sc = Sidecar::spawn_quiet(root.clone())?;
        let res = async {
            sc.init_read_only(&dir.to_string_lossy(), &p.id).await?;
            sc.call("overview", serde_json::json!({})).await
        }
        .await;
        drop(sc);
        out.push(serde_json::json!({ "id": p.id, "name": p.name, "color": p.color, "overview": res.ok() }));
    }
    Ok(out)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_capture(app);
                    }
                })
                .build(),
        )
        .manage(ShortcutRegistered(Mutex::new(None)))
        .manage(SidecarState(Mutex::new(None)))
        .manage(ProfileState(Mutex::new(Registry { current: String::new(), profiles: vec![] })))
        .setup(|app| {
            // En dev, la racine du dépôt est trois niveaux au-dessus de src-tauri.
            let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let data_dir = app.path().app_data_dir()?;
            let registry = Registry::load(&data_dir);
            let profile = registry.current.clone();
            registry.save(&data_dir)?;
            *app.state::<ProfileState>().0.lock().unwrap() = registry;
            let root = root.canonicalize()?;
            let bundled = root.join("plugins");
            let sc = Sidecar::spawn(root, app.handle().clone())?;
            tauri::async_runtime::block_on(sc.init(&data_dir.to_string_lossy(), &profile, &bundled.to_string_lossy()))?;
            *app.state::<SidecarState>().0.lock().unwrap() = Some(sc);

            // Fenêtre de capture rapide : créée masquée, affichée par le raccourci global.
            WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html".into()))
                .title("Capture rapide")
                .inner_size(540.0, 440.0)
                .resizable(false)
                .always_on_top(true)
                .visible(false)
                .build()?;
            let accel = tauri::async_runtime::block_on(app.state::<SidecarState>().get()?.call("settings.get", serde_json::json!({})))
                .ok()
                .and_then(|s| s["capture"]["shortcut"].as_str().map(String::from))
                .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
            if let Err(e) = register_shortcut(app.handle(), &accel).or_else(|_| register_shortcut(app.handle(), DEFAULT_SHORTCUT)) {
                eprintln!("[shell] raccourci de capture non enregistré : {e}");
            }

            // Icône de la zone de notification : l'agent continue de tourner fenêtre fermée.
            let open = MenuItem::with_id(app, "open", "Ouvrir ASSISTANT", true, None::<&str>)?;
            let cap = MenuItem::with_id(app, "capture", "Capture rapide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &cap, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("icône absente")?.clone())
                .tooltip("ASSISTANT")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "capture" => toggle_capture(app),
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
        .invoke_handler(tauri::generate_handler![app_version, rpc, secret_set, set_badge, set_capture_shortcut, hide_capture, capture_screen, profiles_list, profile_create, profile_rename, profile_switch, profile_delete, profiles_overview])
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
