use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

const KEYRING_SERVICE: &str = "app.assistant.desktop";

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>>;

/// Clé de chiffrement de la base : générée une fois, conservée dans le trousseau système.
fn db_key(profile: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &format!("db-key:{profile}")).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(k) => Ok(k),
        Err(keyring::Error::NoEntry) => {
            let mut buf = [0u8; 32];
            getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
            let key: String = buf.iter().map(|b| format!("{b:02x}")).collect();
            entry.set_password(&key).map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Les clés API sont propres à chaque profil : `api-key:<profil>:<fournisseur>`.
fn api_key_entry(profile: &str, provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("api-key:{profile}:{provider}")).map_err(|e| e.to_string())
}

pub fn store_api_key(profile: &str, provider: &str, key: &str) -> Result<(), String> {
    api_key_entry(profile, provider)?.set_password(key).map_err(|e| e.to_string())
}

pub fn delete_api_key(profile: &str, provider: &str) -> Result<(), String> {
    match api_key_entry(profile, provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn load_api_key(profile: &str, provider: &str) -> Option<String> {
    if let Some(k) = api_key_entry(profile, provider).ok().and_then(|e| e.get_password().ok()) {
        return Some(k);
    }
    // Migration : avant les profils, les clés étaient stockées sans nom de profil ; elles reviennent au profil historique.
    if profile == "default" {
        let legacy = keyring::Entry::new(KEYRING_SERVICE, &format!("api-key:{provider}")).ok()?;
        let k = legacy.get_password().ok()?;
        if store_api_key(profile, provider, &k).is_ok() {
            let _ = legacy.delete_credential();
        }
        return Some(k);
    }
    None
}

pub fn delete_db_key(profile: &str) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, &format!("db-key:{profile}")) {
        let _ = e.delete_credential();
    }
}

/// Processus Node enfant, parlant JSON-RPC ligne à ligne.
/// Un thread lit stdout : les réponses (avec `id`) réveillent l'appelant,
/// les notifications (sans `id`) sont relayées à l'UI sous l'événement `sidecar-event`.
pub struct Sidecar {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
}

impl Sidecar {
    /// En dev on lance le script via node ; le packaging en binaire autonome viendra en phase 5.
    pub fn spawn(root: PathBuf, app: AppHandle) -> Result<Arc<Self>, String> {
        let mut child = Command::new("node")
            .args(["--import", "tsx", "src/main.ts"])
            .current_dir(root.join("apps/sidecar"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("lancement du sidecar impossible: {e}"))?;
        let stdin = child.stdin.take().ok_or("stdin indisponible")?;
        let stdout = child.stdout.take().ok_or("stdout indisponible")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        let pending_reader = pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                    let result = match msg.get("error") {
                        Some(err) => Err(err["message"].as_str().unwrap_or("erreur RPC").to_string()),
                        None => Ok(msg["result"].clone()),
                    };
                    if let Some(tx) = pending_reader.lock().unwrap().remove(&id) {
                        let _ = tx.send(result);
                    }
                } else if msg.get("method").is_some() {
                    let _ = app.emit("sidecar-event", msg);
                }
            }
            // Le sidecar s'est arrêté : on réveille tous les appels en attente.
            for (_, tx) in pending_reader.lock().unwrap().drain() {
                let _ = tx.send(Err("le sidecar s'est arrêté".into()));
            }
        });

        Ok(Arc::new(Self { child: Mutex::new(child), stdin: Mutex::new(stdin), pending, next_id: AtomicU64::new(1) }))
    }

    /// Sidecar temporaire (vue combinée) : ses éventuelles notifications ne sont pas relayées à l'interface.
    pub fn spawn_quiet(root: PathBuf) -> Result<Arc<Self>, String> {
        let mut child = Command::new("node")
            .args(["--import", "tsx", "src/main.ts"])
            .current_dir(root.join("apps/sidecar"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("lancement du sidecar impossible: {e}"))?;
        let stdin = child.stdin.take().ok_or("stdin indisponible")?;
        let stdout = child.stdout.take().ok_or("stdout indisponible")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pr = pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                    let result = match msg.get("error") {
                        Some(err) => Err(err["message"].as_str().unwrap_or("erreur RPC").to_string()),
                        None => Ok(msg["result"].clone()),
                    };
                    if let Some(tx) = pr.lock().unwrap().remove(&id) {
                        let _ = tx.send(result);
                    }
                }
            }
            for (_, tx) in pr.lock().unwrap().drain() {
                let _ = tx.send(Err("le sidecar s'est arrêté".into()));
            }
        });
        Ok(Arc::new(Self { child: Mutex::new(child), stdin: Mutex::new(stdin), pending, next_id: AtomicU64::new(1) }))
    }

    pub async fn call(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let req = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        {
            let mut stdin = self.stdin.lock().unwrap();
            if let Err(e) = writeln!(stdin, "{req}").and_then(|_| stdin.flush()) {
                self.pending.lock().unwrap().remove(&id);
                return Err(e.to_string());
            }
        }
        rx.await.map_err(|_| "réponse perdue".to_string())?
    }

    pub async fn init(&self, data_dir: &str, profile: &str, bundled_plugins: &str) -> Result<(), String> {
        let key = db_key(profile)?;
        self.call("init", serde_json::json!({"dataDir": data_dir, "key": key, "profile": profile, "bundledPluginsDir": bundled_plugins})).await?;
        self.push_keys(profile).await
    }

    /// Ouverture en lecture seule (vue combinée) : ni agent, ni clés API, seules les méthodes d'aperçu sont permises.
    pub async fn init_read_only(&self, data_dir: &str, profile: &str) -> Result<(), String> {
        let key = db_key(profile)?;
        self.call("init", serde_json::json!({"dataDir": data_dir, "key": key, "profile": profile, "readOnly": true})).await?;
        Ok(())
    }

    /// Envoie au sidecar les clés API (du trousseau) des fournisseurs configurés ; elles restent en mémoire côté Node.
    pub async fn push_keys(&self, profile: &str) -> Result<(), String> {
        let settings = self.call("settings.get", serde_json::json!({})).await?;
        let mut keys = serde_json::Map::new();
        if let Some(providers) = settings["ai"]["providers"].as_object() {
            for id in providers.keys() {
                if let Some(k) = load_api_key(profile, id) {
                    keys.insert(id.clone(), serde_json::Value::String(k));
                }
            }
        }
        self.call("ai.setKeys", serde_json::json!({ "keys": keys })).await?;
        Ok(())
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap().kill();
    }
}

pub struct SidecarState(pub Mutex<Option<Arc<Sidecar>>>);

impl SidecarState {
    pub fn get(&self) -> Result<Arc<Sidecar>, String> {
        self.0.lock().unwrap().clone().ok_or_else(|| "sidecar non démarré".to_string())
    }
}
