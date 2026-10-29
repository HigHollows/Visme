use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "app.assistant.desktop";

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

pub struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Sidecar {
    /// En dev on lance le script via node ; le packaging en binaire autonome viendra en phase 5.
    pub fn spawn(root: PathBuf) -> Result<Self, String> {
        let mut child = Command::new("node")
            .args(["--import", "tsx", "src/main.ts"])
            .current_dir(root.join("apps/sidecar"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("lancement du sidecar impossible: {e}"))?;
        let stdin = child.stdin.take().ok_or("stdin indisponible")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("stdout indisponible")?);
        Ok(Self { child, stdin, stdout, next_id: 1 })
    }

    pub fn call(&mut self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let req = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{req}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        self.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
        if line.is_empty() {
            return Err("le sidecar s'est arrêté".into());
        }
        let resp: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if let Some(err) = resp.get("error") {
            return Err(err["message"].as_str().unwrap_or("erreur RPC").to_string());
        }
        Ok(resp["result"].clone())
    }

    pub fn init(&mut self, data_dir: &str, profile: &str) -> Result<(), String> {
        let key = db_key(profile)?;
        self.call("init", serde_json::json!({"dataDir": data_dir, "key": key, "profile": profile}))?;
        Ok(())
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

pub struct SidecarState(pub Mutex<Option<Sidecar>>);
