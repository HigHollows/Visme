//! Capture de l'audio du système (ce que « disent » les participants d'une visioconférence).
//!
//! Un flux d'ENTRÉE est ouvert sur le périphérique de SORTIE par défaut : `cpal` active alors le bouclage
//! (WASAPI sous Windows ; « process tap » CoreAudio sous macOS 14.6+, permission « Enregistrement audio du système »).
//!
//! Dans les deux cas l'audio est ramené en mono 16 kHz, découpé en segments WAV de 5 minutes et envoyé au moteur
//! (`meetings.segment`, piste « system ») ; les segments silencieux sont écartés. Le micro reste capté par la webview.

use std::sync::{Arc, Mutex};

pub const RATE: u32 = 16_000;
const SEGMENT_SECONDS: usize = 300;
const MIN_FLUSH_SAMPLES: usize = RATE as usize / 2;
/// Crête (sur 32767) en dessous de laquelle un segment est considéré comme du silence.
const SILENCE_PEAK: i16 = 40;

/// Un segment audio prêt à être envoyé.
pub struct Segment {
    pub index: u32,
    pub offset_ms: u64,
    pub duration_ms: u64,
    pub wav: Vec<u8>,
}

/// WAV PCM 16 bits mono.
pub fn wav_bytes(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut v = Vec::with_capacity(44 + samples.len() * 2);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes()); // taille du bloc fmt
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&1u16.to_le_bytes()); // mono
    v.extend_from_slice(&RATE.to_le_bytes());
    v.extend_from_slice(&(RATE * 2).to_le_bytes()); // octets/s
    v.extend_from_slice(&2u16.to_le_bytes()); // alignement
    v.extend_from_slice(&16u16.to_le_bytes()); // bits/échantillon
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        v.extend_from_slice(&s.to_le_bytes());
    }
    v
}

/// Convertit un flux de trames entrelacées (n canaux, fréquence quelconque) en mono 16 kHz, par interpolation linéaire.
pub struct Mono16k {
    channels: usize,
    step: f64,
    pos: f64,
    prev: f32,
    have_prev: bool,
}

impl Mono16k {
    pub fn new(rate_in: u32, channels: usize) -> Self {
        Self { channels: channels.max(1), step: rate_in as f64 / RATE as f64, pos: 0.0, prev: 0.0, have_prev: false }
    }

    pub fn push(&mut self, interleaved: &[f32], out: &mut Vec<i16>) {
        for frame in interleaved.chunks_exact(self.channels) {
            let cur = frame.iter().sum::<f32>() / self.channels as f32; // mixage mono
            if !self.have_prev {
                self.prev = cur;
                self.have_prev = true;
                continue;
            }
            // `pos` est la position fractionnaire entre `prev` (0.0) et `cur` (1.0).
            while self.pos < 1.0 {
                let v = self.prev + (cur - self.prev) * self.pos as f32;
                out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = cur;
        }
    }
}

/// Découpe le flux en segments de durée fixe et les remet à `emit`.
pub struct Segmenter {
    buf: Vec<i16>,
    index: u32,
    /// Échantillons déjà émis (pour calculer le décalage de chaque segment).
    emitted: u64,
    base_offset_ms: u64,
    max: usize,
    emit: Box<dyn FnMut(Segment) + Send>,
}

impl Segmenter {
    pub fn new(base_offset_ms: u64, emit: Box<dyn FnMut(Segment) + Send>) -> Self {
        Self::with_len(base_offset_ms, SEGMENT_SECONDS * RATE as usize, emit)
    }

    pub fn with_len(base_offset_ms: u64, max: usize, emit: Box<dyn FnMut(Segment) + Send>) -> Self {
        Self { buf: Vec::new(), index: 0, emitted: 0, base_offset_ms, max, emit }
    }

    pub fn push(&mut self, samples: &[i16]) {
        self.buf.extend_from_slice(samples);
        while self.buf.len() >= self.max {
            let seg: Vec<i16> = self.buf.drain(..self.max).collect();
            self.send(seg);
        }
    }

    /// Termine : émet ce qui reste (au moins une demi-seconde).
    pub fn flush(&mut self) {
        if self.buf.len() >= MIN_FLUSH_SAMPLES {
            let seg = std::mem::take(&mut self.buf);
            self.send(seg);
        }
    }

    fn send(&mut self, seg: Vec<i16>) {
        let offset_ms = self.base_offset_ms + self.emitted * 1000 / RATE as u64;
        let duration_ms = seg.len() as u64 * 1000 / RATE as u64;
        self.emitted += seg.len() as u64;
        let index = self.index;
        self.index += 1;
        // Rien d'audible : inutile (et coûteux) de transcrire du silence.
        if seg.iter().map(|s| s.saturating_abs()).max().unwrap_or(0) < SILENCE_PEAK {
            return;
        }
        (self.emit)(Segment { index, offset_ms, duration_ms, wav: wav_bytes(&seg) });
    }
}

/// Mixage + découpage partagés par les captures de chaque plateforme.
pub struct Pipeline {
    conv: Mono16k,
    seg: Segmenter,
    scratch: Vec<i16>,
}

impl Pipeline {
    pub fn new(rate_in: u32, channels: usize, base_offset_ms: u64, emit: Box<dyn FnMut(Segment) + Send>) -> Self {
        Self { conv: Mono16k::new(rate_in, channels), seg: Segmenter::new(base_offset_ms, emit), scratch: Vec::new() }
    }

    pub fn push_f32(&mut self, interleaved: &[f32]) {
        self.scratch.clear();
        self.conv.push(interleaved, &mut self.scratch);
        self.seg.push(&self.scratch);
    }

    pub fn finish(&mut self) {
        self.seg.flush();
    }
}

pub type SharedPipeline = Arc<Mutex<Pipeline>>;
pub type Stopper = Box<dyn FnOnce() + Send>;
/// Construit le traitement une fois la fréquence et le nombre de canaux du périphérique connus.
pub type PipelineFactory = Box<dyn FnOnce(u32, usize) -> Pipeline + Send>;

/// La capture de l'audio système est-elle disponible ici ? (message à afficher sinon)
pub fn supported() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let v = std::process::Command::new("sw_vers").arg("-productVersion").output().ok()
            .and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
        let mut it = v.trim().split('.').map(|x| x.parse::<u32>().unwrap_or(0));
        let (major, minor) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
        return if major > 14 || (major == 14 && minor >= 6) {
            Ok(())
        } else {
            Err("Capter l'audio système demande macOS 14.6 ou plus récent. Sinon, choisissez un périphérique de bouclage (ex. BlackHole) comme micro.".into())
        };
    }
    #[cfg(windows)]
    {
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("Capture de l'audio système non disponible sur ce système".into())
}

/// Démarre la capture ; renvoie la fonction qui l'arrête (elle vide aussi le dernier segment).
pub fn start(factory: PipelineFactory) -> Result<Stopper, String> {
    #[cfg(any(target_os = "macos", windows))]
    return native::start(factory);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = factory;
        Err("Capture de l'audio du système non disponible sur ce système".into())
    }
}

#[cfg(any(target_os = "macos", windows))]
mod native {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::mpsc;

    pub fn start(factory: PipelineFactory) -> Result<Stopper, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        // `cpal::Stream` n'est pas `Send` : il vit dans son propre thread, de la création à l'arrêt.
        std::thread::spawn(move || {
            let mut factory = Some(factory);
            let mut setup = || -> Result<(cpal::Stream, SharedPipeline), String> {
                let host = cpal::default_host();
                let device = host.default_output_device().ok_or("Aucun périphérique de sortie audio")?;
                let supported = device.default_output_config().map_err(|e| e.to_string())?;
                let (channels, rate, format) = (supported.channels() as usize, supported.sample_rate(), supported.sample_format());
                let config = supported.config();
                let pipeline: SharedPipeline = Arc::new(Mutex::new((factory.take().ok_or("déjà démarré")?)(rate, channels)));
                let push = {
                    let p = pipeline.clone();
                    move |data: &[f32]| {
                        if let Ok(mut pl) = p.lock() {
                            pl.push_f32(data);
                        }
                    }
                };
                let err_fn = |e: cpal::Error| eprintln!("[sysaudio] erreur de flux : {e}");
                let stream = match format {
                    cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(config, move |d, _| push(d), err_fn, None),
                    cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
                        config,
                        move |d, _| push(&d.iter().map(|s| *s as f32 / 32768.0).collect::<Vec<f32>>()),
                        err_fn,
                        None,
                    ),
                    cpal::SampleFormat::I32 => device.build_input_stream::<i32, _, _>(
                        config,
                        move |d, _| push(&d.iter().map(|s| *s as f32 / 2_147_483_648.0).collect::<Vec<f32>>()),
                        err_fn,
                        None,
                    ),
                    other => return Err(format!("Format audio non géré : {other:?}")),
                }
                .map_err(|e| e.to_string())?;
                stream.play().map_err(|e| e.to_string())?;
                Ok((stream, pipeline))
            };
            match setup() {
                Ok((stream, pipeline)) => {
                    let _ = ready_tx.send(Ok(()));
                    let _ = stop_rx.recv();
                    drop(stream);
                    if let Ok(mut pl) = pipeline.lock() {
                        pl.finish(); // vide le dernier segment
                    }
                    let _ = done_tx.send(());
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        });
        ready_rx.recv().map_err(|_| "capture interrompue".to_string())??;
        Ok(Box::new(move || {
            let _ = stop_tx.send(());
            let _ = done_rx.recv_timeout(std::time::Duration::from_secs(15)); // attend le dernier segment
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn en_tete_wav_valide() {
        let w = wav_bytes(&[0, 1000, -1000, 32767]);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()) as usize, w.len() - 8);
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), RATE);
        assert_eq!(u16::from_le_bytes(w[22..24].try_into().unwrap()), 1, "mono");
        assert_eq!(u16::from_le_bytes(w[34..36].try_into().unwrap()), 16);
        assert_eq!(&w[36..40], b"data");
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 8);
        assert_eq!(i16::from_le_bytes(w[46..48].try_into().unwrap()), 1000);
    }

    #[test]
    fn reechantillonnage_conserve_duree_et_niveau() {
        // 1 s de signal continu à 48 kHz stéréo (0,5 / 0,5) → ~16 000 échantillons mono ≈ 16383.
        let mut c = Mono16k::new(48_000, 2);
        let input = vec![0.5f32; 48_000 * 2];
        let mut out = Vec::new();
        c.push(&input, &mut out);
        assert!((out.len() as i64 - 16_000).abs() <= 2, "durée conservée : {}", out.len());
        assert!(out.iter().all(|s| (*s as i32 - 16_383).abs() <= 1), "niveau conservé");
    }

    #[test]
    fn mixage_stereo_en_mono_et_flux_fragmente() {
        // Canal gauche à +1, droit à -1 → mixage = 0 (silence).
        let mut c = Mono16k::new(16_000, 2);
        let mut out = Vec::new();
        for _ in 0..10 {
            c.push(&vec![1.0, -1.0, 1.0, -1.0, 1.0, -1.0], &mut out); // livraison par petits blocs
        }
        assert!(!out.is_empty() && out.iter().all(|s| *s == 0));
        // Même résultat qu'en un seul bloc
        let mut a = Mono16k::new(44_100, 1);
        let mut b = Mono16k::new(44_100, 1);
        let sig: Vec<f32> = (0..4410).map(|i| (i as f32 / 100.0).sin()).collect();
        let (mut oa, mut ob) = (Vec::new(), Vec::new());
        a.push(&sig, &mut oa);
        for chunk in sig.chunks(37) {
            b.push(chunk, &mut ob);
        }
        assert_eq!(oa, ob);
    }

    #[test]
    fn segments_decalages_et_silence_ecarte() {
        let count = Arc::new(AtomicUsize::new(0));
        let seen: Arc<Mutex<Vec<(u32, u64, u64)>>> = Arc::new(Mutex::new(vec![]));
        let (c2, s2) = (count.clone(), seen.clone());
        let mut s = Segmenter::with_len(2_000, 16_000, Box::new(move |seg| {
            c2.fetch_add(1, Ordering::SeqCst);
            s2.lock().unwrap().push((seg.index, seg.offset_ms, seg.duration_ms));
        }));
        let loud = vec![5000i16; 16_000];
        let quiet = vec![3i16; 16_000];
        s.push(&loud); // segment 0 (1 s)
        s.push(&quiet); // segment 1 : silence, écarté mais le temps avance
        s.push(&loud); // segment 2
        s.push(&vec![5000i16; 4_000]); // reste de 0,25 s : trop court pour être émis
        s.flush();
        assert_eq!(*seen.lock().unwrap(), vec![(0, 2_000, 1_000), (2, 4_000, 1_000)]);
        s.push(&vec![5000i16; 12_000]); // 0,75 s + 0,25 s précédent écartés par flush → 0,75 s
        s.flush();
        assert_eq!(count.load(Ordering::SeqCst), 3);
    }
}
