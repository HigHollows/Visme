mod lock;
mod profiles;
mod sysaudio;
mod sidecar;

use lock::{hash_password, verify_password, LockConfig, LockState};
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
    if app.state::<LockState>().is_locked() {
        return; // verrouillé : la capture rapide ne doit pas contourner le mot de passe
    }
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

struct ActiveCapture {
    stopper: sysaudio::Stopper,
    uploader: std::thread::JoinHandle<()>,
}
pub struct SysAudioState(Mutex<Option<ActiveCapture>>);

/// La capture de l'audio du système est-elle possible sur cette machine ?
#[tauri::command]
fn system_audio_supported() -> serde_json::Value {
    match sysaudio::supported() {
        Ok(()) => serde_json::json!({ "supported": true }),
        Err(reason) => serde_json::json!({ "supported": false, "reason": reason }),
    }
}

/// Démarre la capture de l'audio du système pour une réunion. Les segments WAV partent directement au moteur (piste « system »).
#[tauri::command]
fn system_audio_start(state: State<'_, SidecarState>, cap: State<'_, SysAudioState>, meeting_id: String, started_at_ms: u64) -> Result<(), String> {
    use base64::Engine;
    if cap.0.lock().unwrap().is_some() {
        return Err("Capture de l'audio système déjà en cours".into());
    }
    sysaudio::supported()?;
    let sc = state.get()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let base = now.saturating_sub(started_at_ms);
    let (tx, rx) = std::sync::mpsc::channel::<sysaudio::Segment>();
    let uploader = std::thread::spawn(move || {
        for seg in rx {
            let data = base64::engine::general_purpose::STANDARD.encode(&seg.wav);
            let params = serde_json::json!({
                "id": meeting_id, "idx": seg.index, "offsetMs": seg.offset_ms, "durationMs": seg.duration_ms,
                "mime": "audio/wav", "data": data, "track": "system",
            });
            if let Err(e) = tauri::async_runtime::block_on(sc.call("meetings.segment", params)) {
                eprintln!("[sysaudio] envoi du segment impossible : {e}");
            }
        }
    });
    let factory: sysaudio::PipelineFactory = Box::new(move |rate, channels| {
        sysaudio::Pipeline::new(rate, channels, base, Box::new(move |seg| { let _ = tx.send(seg); }))
    });
    match sysaudio::start(factory) {
        Ok(stopper) => {
            *cap.0.lock().unwrap() = Some(ActiveCapture { stopper, uploader });
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Arrête la capture et attend l'envoi du dernier segment (à appeler AVANT de terminer la réunion).
#[tauri::command]
fn system_audio_stop(cap: State<'_, SysAudioState>) -> Result<(), String> {
    if let Some(active) = cap.0.lock().unwrap().take() {
        (active.stopper)();
        let _ = active.uploader.join();
    }
    Ok(())
}

/// Démarre le moteur pour le profil actif (ouvre la base chiffrée avec sa clé du trousseau) et enregistre le raccourci de capture.
/// Appelé au lancement, ou après déverrouillage si un mot de passe est défini.
async fn boot(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = data_dir(app)?;
    let profile = app.state::<ProfileState>().0.lock().unwrap().current.clone();
    let bundled = sidecar::launch_spec(app)?.bundled_plugins;
    let sc = Sidecar::spawn(app.clone())?;
    sc.init(&dir.to_string_lossy(), &profile, &bundled.to_string_lossy()).await?;
    *app.state::<SidecarState>().0.lock().unwrap() = Some(sc.clone());
    let accel = sc
        .call("settings.get", serde_json::json!({}))
        .await
        .ok()
        .and_then(|s| s["capture"]["shortcut"].as_str().map(String::from))
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    if let Err(e) = register_shortcut(app, &accel).or_else(|_| register_shortcut(app, DEFAULT_SHORTCUT)) {
        eprintln!("[shell] raccourci de capture non enregistré : {e}");
    }
    Ok(())
}

#[tauri::command]
fn lock_status(lock: State<'_, LockState>) -> serde_json::Value {
    let c = lock.cfg.lock().unwrap();
    serde_json::json!({ "ready": lock.ready.load(std::sync::atomic::Ordering::SeqCst), "enabled": c.enabled, "locked": lock.is_locked(), "idleMinutes": c.idle_minutes })
}

#[tauri::command]
fn lock_set_password(app: tauri::AppHandle, lock: State<'_, LockState>, current: Option<String>, password: String, idle_minutes: u32) -> Result<(), String> {
    if password.chars().count() < 8 {
        return Err("Mot de passe trop court (8 caractères minimum)".into());
    }
    let mut c = lock.cfg.lock().unwrap();
    if c.enabled && !verify_password(&current.unwrap_or_default(), &c.hash) {
        return Err("Mot de passe actuel incorrect".into());
    }
    c.hash = hash_password(&password)?;
    c.enabled = true;
    c.idle_minutes = idle_minutes.min(240);
    c.save(&data_dir(&app)?)
}

#[tauri::command]
fn lock_disable(app: tauri::AppHandle, lock: State<'_, LockState>, password: String) -> Result<(), String> {
    let mut c = lock.cfg.lock().unwrap();
    if !c.enabled {
        return Ok(());
    }
    if !verify_password(&password, &c.hash) {
        return Err("Mot de passe incorrect".into());
    }
    *c = LockConfig::default();
    c.save(&data_dir(&app)?)
}

/// Verrouille : le moteur est arrêté (la base chiffrée n'est plus ouverte) jusqu'à la saisie du mot de passe.
#[tauri::command]
fn lock_now(app: tauri::AppHandle, lock: State<'_, LockState>, state: State<'_, SidecarState>) -> Result<(), String> {
    if !lock.cfg.lock().unwrap().enabled {
        return Err("Aucun mot de passe défini".into());
    }
    lock.locked.store(true, std::sync::atomic::Ordering::SeqCst);
    let old = state.0.lock().unwrap().take();
    drop(old);
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
async fn unlock(app: tauri::AppHandle, lock: State<'_, LockState>, password: String) -> Result<(), String> {
    if let Some(wait) = lock.throttle() {
        return Err(format!("Trop d'essais : patientez {} s", wait.as_secs() + 1));
    }
    let hash = lock.cfg.lock().unwrap().hash.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || verify_password(&password, &hash)).await.map_err(|e| e.to_string())?;
    lock.record(ok);
    if !ok {
        return Err("Mot de passe incorrect".into());
    }
    boot(&app).await?;
    lock.locked.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Effacement total (RGPD) : tous les profils, leurs clés du trousseau, le verrou, puis fermeture.
#[tauri::command]
fn erase_all_data(app: tauri::AppHandle, state: State<'_, SidecarState>, reg: State<'_, ProfileState>) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let old = state.0.lock().unwrap().take();
    drop(old); // ferme la base avant de supprimer les fichiers
    let profiles = reg.0.lock().unwrap().profiles.clone();
    for p in &profiles {
        for prov in &p.providers {
            let _ = sidecar::delete_api_key(&p.id, prov);
        }
        sidecar::delete_db_key(&p.id);
    }
    if dir.exists() {
        // Uniquement le dossier de données de l'application.
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Suppression impossible : {e}"))?;
    }
    app.exit(0);
    Ok(())
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
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
    let bundled = sidecar::launch_spec(&app)?.bundled_plugins;
    let old = state.0.lock().unwrap().take();
    drop(old); // arrête le sidecar précédent avant d'ouvrir l'autre base
    let sc = Sidecar::spawn(app.clone())?;
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
    let mut out = vec![];
    for p in profiles.into_iter().filter(|p| p.id != current) {
        let sc = Sidecar::spawn_quiet(&app)?;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
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
        .manage(LockState::pending())
        .manage(SysAudioState(Mutex::new(None)))
        .manage(ProfileState(Mutex::new(Registry { current: String::new(), profiles: vec![] })))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let registry = Registry::load(&data_dir);
            registry.save(&data_dir)?;
            *app.state::<ProfileState>().0.lock().unwrap() = registry;
            let lock_cfg = LockConfig::load(&data_dir);
            app.state::<LockState>().init(lock_cfg.clone());
            // Verrou actif : on ne démarre PAS le moteur (la base reste fermée) jusqu'au déverrouillage.
            if !lock_cfg.enabled {
                tauri::async_runtime::block_on(boot(app.handle()))?;
            }

            // Fenêtre de capture rapide : créée masquée, affichée par le raccourci global.
            WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html".into()))
                .title("Capture rapide")
                .inner_size(540.0, 440.0)
                .resizable(false)
                .always_on_top(true)
                .visible(false)
                .build()?;

            // Lancé à l'ouverture de session (--hidden) : on démarre dans la barre de menus, fenêtre masquée.
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
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
            app.state::<LockState>().ready.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fermer la fenêtre la masque seulement ; « Quitter » (menu de la barre) arrête vraiment l'application.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![app_version, rpc, secret_set, set_badge, system_audio_supported, system_audio_start, system_audio_stop, lock_status, lock_set_password, lock_disable, lock_now, unlock, erase_all_data, set_capture_shortcut, hide_capture, capture_screen, profiles_list, profile_create, profile_rename, profile_switch, profile_delete, profiles_overview])
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
