import { type FSWatcher, watch as fsWatch, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import type { Db } from "@assistant/db";
import { MAX_FILE_BYTES, isSupported } from "./documents/extract";

const MAX_FILES_PER_SCAN = 2000;
const SETTLE_MS = 1200;
const IGNORED = /^(\.|~\$|.*\.(part|crdownload|tmp|swp)$)/i;

export interface WatchedFolder {
  path: string;
}

export interface WatchDeps {
  db: Db;
  /** Ajoute un fichier à la bibliothèque (dédoublonné par empreinte). */
  add: (path: string) => Promise<unknown>;
  notify: (method: string, params: unknown) => void;
  /** Injectables pour les tests. */
  settleMs?: number;
}

/** Dossiers surveillés : tout nouveau fichier pris en charge est importé, sans jamais modifier ni supprimer l'original. */
export class WatchService {
  private watchers = new Map<string, FSWatcher>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private d: WatchDeps) {}

  list(): WatchedFolder[] {
    const r = this.d.db.prepare("SELECT value FROM kv WHERE key='watch_folders'").get() as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as WatchedFolder[]) : [];
  }

  private save(l: WatchedFolder[]) {
    this.d.db.prepare("INSERT INTO kv(key,value) VALUES('watch_folders',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(l));
  }

  add(path: string) {
    const p = resolve(path);
    if (!statSync(p).isDirectory()) throw new Error("Ce n'est pas un dossier");
    const l = this.list();
    if (l.some((f) => f.path === p)) return;
    if (l.length >= 20) throw new Error("20 dossiers surveillés maximum");
    this.save([...l, { path: p }]);
    this.start(p);
    void this.scan(p);
  }

  remove(path: string) {
    const p = resolve(path);
    this.save(this.list().filter((f) => f.path !== p));
    this.watchers.get(p)?.close();
    this.watchers.delete(p);
  }

  /** (Ré)active la surveillance de tous les dossiers enregistrés et rattrape ce qui est arrivé pendant l'absence. */
  startAll() {
    for (const f of this.list()) {
      try {
        this.start(f.path);
        void this.scan(f.path);
      } catch (e) {
        this.d.notify("watch.event", { path: f.path, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  stopAll() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private start(dir: string) {
    if (this.watchers.has(dir)) return;
    const w = fsWatch(dir, { recursive: true }, (_ev, name) => {
      if (!name) return;
      this.schedule(join(dir, name.toString()), dir);
    });
    w.on("error", () => { this.watchers.delete(dir); });
    this.watchers.set(dir, w);
  }

  private eligible(file: string): boolean {
    const name = basename(file);
    if (IGNORED.test(name) || !isSupported(name)) return false;
    try {
      const st = statSync(file);
      return st.isFile() && st.size > 0 && st.size <= MAX_FILE_BYTES;
    } catch {
      return false;
    }
  }

  /** Attend que le fichier ait fini d'être écrit (taille stable) avant de l'importer. */
  private schedule(file: string, root: string) {
    // Un chemin qui sort du dossier surveillé (lien symbolique, ..) est ignoré.
    if (!resolve(file).startsWith(root + sep)) return;
    clearTimeout(this.timers.get(file));
    this.timers.set(file, setTimeout(() => {
      this.timers.delete(file);
      if (this.eligible(file)) this.enqueue(file);
    }, this.d.settleMs ?? SETTLE_MS));
  }

  private enqueue(file: string) {
    this.chain = this.chain.then(async () => {
      try {
        await this.d.add(file);
        this.d.notify("watch.event", { path: file, imported: true });
      } catch (e) {
        this.d.notify("watch.event", { path: file, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /** Parcourt le dossier et importe ce qui manque. Renvoie le nombre de fichiers candidats. */
  scan(dir: string): Promise<number> {
    let n = 0;
    const rec = (d: string, depth: number) => {
      if (depth > 8 || n >= MAX_FILES_PER_SCAN) return;
      for (const name of readdirSync(d)) {
        if (IGNORED.test(name) || name === "node_modules") continue;
        const p = join(d, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) rec(p, depth + 1);
        else if (extname(name) && this.eligible(p) && n < MAX_FILES_PER_SCAN) { n++; this.enqueue(p); }
      }
    };
    try { rec(dir, 0); } catch { /* dossier disparu */ }
    return this.chain.then(() => n);
  }

  /** Attend la fin des imports en cours (tests, arrêt propre). */
  idle() {
    return this.chain;
  }
}
