use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub color: String,
    /// Fournisseurs IA dont une clé est stockée dans le trousseau pour ce profil (pour pouvoir les effacer).
    #[serde(default)]
    pub providers: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Registry {
    pub current: String,
    pub profiles: Vec<Profile>,
}

impl Registry {
    fn path(dir: &Path) -> PathBuf {
        dir.join("profiles.json")
    }

    /// Charge le registre ; le profil historique « default » devient « Pro » pour ne pas perdre les données existantes.
    pub fn load(dir: &Path) -> Registry {
        if let Ok(s) = fs::read_to_string(Self::path(dir)) {
            if let Ok(mut r) = serde_json::from_str::<Registry>(&s) {
                if !r.profiles.iter().any(|p| p.id == r.current) {
                    if let Some(p) = r.profiles.first() {
                        r.current = p.id.clone();
                    }
                }
                if !r.profiles.is_empty() {
                    return r;
                }
            }
        }
        Registry {
            current: "default".into(),
            profiles: vec![Profile { id: "default".into(), name: "Pro".into(), color: "#2563eb".into(), providers: vec![] }],
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("profiles.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, Self::path(dir)).map_err(|e| e.to_string())
    }

    pub fn get(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }
}

/// Identifiant sûr pour un nom de fichier : lettres/chiffres/tirets + suffixe aléatoire.
pub fn make_id(name: &str) -> Result<String, String> {
    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let base: String = base.chars().take(24).collect();
    let mut buf = [0u8; 3];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    let suffix: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    Ok(if base.is_empty() { format!("profil-{suffix}") } else { format!("{base}-{suffix}") })
}

pub fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 {
        return Err("Nom invalide (1 à 40 caractères)".into());
    }
    Ok(n.to_string())
}

pub fn clean_color(c: &str) -> String {
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit());
    if ok { c.to_string() } else { "#64748b".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiants_sans_caracteres_dangereux() {
        for name in ["Perso", "Association / Club ../..", "Éléphant & Cie", "   ", "日本語", "a".repeat(100).as_str()] {
            let id = make_id(name).unwrap();
            assert!(id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "id sûr pour un nom de fichier : {id}");
            assert!(!id.contains(".."));
            assert!(id.len() <= 24 + 1 + 6);
        }
        assert_ne!(make_id("Perso").unwrap(), make_id("Perso").unwrap(), "suffixe aléatoire");
    }

    #[test]
    fn validation_des_noms_et_couleurs() {
        assert!(clean_name("  ").is_err());
        assert!(clean_name(&"x".repeat(41)).is_err());
        assert_eq!(clean_name("  Pro ").unwrap(), "Pro");
        assert_eq!(clean_color("#16a34a"), "#16a34a");
        assert_eq!(clean_color("red; background:url(x)"), "#64748b");
        assert_eq!(clean_color("#12345"), "#64748b");
    }

    #[test]
    fn registre_par_defaut_et_reparation() {
        let dir = std::env::temp_dir().join(format!("assistant-reg-test-{}", std::process::id()));
        let r = Registry::load(&dir);
        assert_eq!(r.current, "default");
        assert_eq!(r.profiles[0].name, "Pro");
        // profil courant inexistant → on retombe sur le premier profil
        let broken = Registry { current: "fantome".into(), profiles: vec![Profile { id: "perso-1".into(), name: "Perso".into(), color: "#16a34a".into(), providers: vec![] }] };
        broken.save(&dir).unwrap();
        assert_eq!(Registry::load(&dir).current, "perso-1");
        std::fs::write(dir.join("profiles.json"), "{ corrompu").unwrap();
        assert_eq!(Registry::load(&dir).current, "default", "fichier corrompu → registre par défaut");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
