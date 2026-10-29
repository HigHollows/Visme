use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct LockConfig {
    pub enabled: bool,
    /// Empreinte Argon2id (format PHC) du mot de passe — jamais le mot de passe.
    pub hash: String,
    pub idle_minutes: u32,
}

impl LockConfig {
    fn path(dir: &Path) -> std::path::PathBuf {
        dir.join("security.json")
    }

    pub fn load(dir: &Path) -> Self {
        std::fs::read_to_string(Self::path(dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("security.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, Self::path(dir)).map_err(|e| e.to_string())
    }
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let mut salt_bytes = [0u8; 16];
    getrandom::getrandom(&mut salt_bytes).map_err(|e| e.to_string())?;
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| e.to_string())?;
    Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string()).map_err(|e| e.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok()).unwrap_or(false)
}

pub struct LockState {
    pub cfg: Mutex<LockConfig>,
    pub locked: AtomicBool,
    /// Faux tant que le `setup` n'a pas fini (le webview peut interroger l'état avant) : l'interface attend.
    pub ready: AtomicBool,
    failures: Mutex<(u32, Option<Instant>)>,
}

impl LockState {
    /// État initial avant lecture de la configuration : verrouillé par prudence, non prêt.
    pub fn pending() -> Self {
        Self { cfg: Mutex::new(LockConfig::default()), locked: AtomicBool::new(true), ready: AtomicBool::new(false), failures: Mutex::new((0, None)) }
    }

    pub fn init(&self, cfg: LockConfig) {
        self.locked.store(cfg.enabled, Ordering::SeqCst);
        *self.cfg.lock().unwrap() = cfg;
    }

    pub fn is_locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }

    /// Temporisation croissante après des échecs (1 s, 2 s, 4 s … 30 s) contre les essais en rafale.
    pub fn throttle(&self) -> Option<Duration> {
        let f = self.failures.lock().unwrap();
        let (n, last) = *f;
        if n == 0 {
            return None;
        }
        let wait = Duration::from_secs((1u64 << (n - 1).min(5)).min(30));
        last.and_then(|t| wait.checked_sub(t.elapsed())).filter(|d| !d.is_zero())
    }

    pub fn record(&self, ok: bool) {
        let mut f = self.failures.lock().unwrap();
        if ok { *f = (0, None); } else { *f = (f.0 + 1, Some(Instant::now())); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_et_verification() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2"), "format PHC Argon2 attendu");
        assert!(!h.contains("correct horse"), "le mot de passe ne doit jamais apparaître dans l'empreinte");
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("correct horse batterY", &h));
        assert!(!verify_password("", &h));
        assert!(!verify_password("x", "pas-une-empreinte"));
    }

    #[test]
    fn sels_differents() {
        assert_ne!(hash_password("meme-mot-de-passe").unwrap(), hash_password("meme-mot-de-passe").unwrap());
    }

    #[test]
    fn temporisation_croissante_puis_remise_a_zero() {
        let s = LockState::pending();
        assert!(s.throttle().is_none());
        s.record(false);
        assert!(s.throttle().is_some(), "après un échec on patiente");
        s.record(false);
        s.record(false);
        let d = s.throttle().unwrap();
        assert!(d > Duration::from_secs(1) && d <= Duration::from_secs(4), "1 s, 2 s, 4 s…");
        s.record(true);
        assert!(s.throttle().is_none());
    }

    #[test]
    fn configuration_sauvegardee_atomiquement_et_relue() {
        let dir = std::env::temp_dir().join(format!("assistant-lock-test-{}", std::process::id()));
        let cfg = LockConfig { enabled: true, hash: hash_password("motdepasse1").unwrap(), idle_minutes: 15 };
        cfg.save(&dir).unwrap();
        let back = LockConfig::load(&dir);
        assert!(back.enabled && back.idle_minutes == 15 && verify_password("motdepasse1", &back.hash));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("security.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "lisible par l'utilisateur seul");
        }
        assert!(!LockConfig::load(&dir.join("absent")).enabled, "sans fichier : pas de verrou");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
