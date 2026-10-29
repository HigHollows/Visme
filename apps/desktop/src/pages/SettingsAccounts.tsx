import { useCallback, useEffect, useState } from "react";
import { tr, locale } from "../i18n";
import { listen } from "@tauri-apps/api/event";
import { rpc, type AppSettings } from "../rpc";

interface Features { mail: boolean; send: boolean; calendar: boolean; calendarWrite: boolean }
interface Account {
  id: string; provider: "google" | "microsoft" | "imap" | "caldav"; email: string; status: "ok" | "reauth";
  syncStatus: "idle" | "syncing" | "error"; syncError: string | null; lastSyncAt: number | null; mailCount: number;
  features: Features;
  calendarStatus: "idle" | "syncing" | "error" | null; calendarError: string | null; calendarLastSyncAt: number | null; eventCount: number;
}
type S = AppSettings & { mail: { readAttachments: boolean; allowSend: boolean }; calendar: { writeTo: string | null } };

const PROVIDER: Record<Account["provider"], string> = { google: "Google", microsoft: "Microsoft", imap: "IMAP/SMTP", caldav: "CalDAV" };
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function Perms({ v, set }: { v: Features; set: (f: Features) => void }) {
  const box = (k: keyof Features, label: string, help: string, disabled = false) => (
    <label className="flex items-center gap-1 text-sm" title={help}><input type="checkbox" disabled={disabled} checked={v[k]} onChange={(e) => set({ ...v, [k]: e.target.checked })} /> {label}</label>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {box("mail", tr("Lire les mails"), tr("Accès en lecture seule"))}
      {box("send", tr("Envoyer des mails"), tr("Permet d'envoyer un brouillon après votre confirmation explicite"))}
      {box("calendar", tr("Lire l'agenda"), tr("Accès en lecture seule"))}
      {box("calendarWrite", tr("Écrire dans l'agenda"), tr("Permet d'ajouter/modifier/supprimer des événements"))}
    </div>
  );
}

export function SettingsAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(() => { rpc<Account[]>("accounts.list").then(setAccounts).catch((e) => setMsg(String(e))); }, []);
  const loadSettings = useCallback(() => { rpc<S>("settings.get").then(setSettings).catch(() => {}); }, []);

  useEffect(() => {
    refresh(); loadSettings();
    const un = listen<{ method: string }>("sidecar-event", ({ payload }) => { if (payload.method === "mail.event" || payload.method === "calendar.event") refresh(); });
    return () => void un.then((f) => f());
  }, [refresh, loadSettings]);

  const saveSettings = async (next: S) => { try { setSettings(await rpc<S>("settings.set", { settings: next })); } catch (e) { setMsg(String(e)); } };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setMsg(label);
    try { await fn(); setMsg(tr("Compte connecté ; synchronisation en cours.")); } catch (e) { setMsg(tr("Échec : {0}", e)); }
    setBusy(false); refresh();
  };

  return (
    <div className="max-w-3xl space-y-8 text-sm">
      <GoogleSection busy={busy} run={run} />
      <MicrosoftSection busy={busy} run={run} />
      <ImapSection busy={busy} run={run} />
      <CalDavSection busy={busy} run={run} />

      <section aria-labelledby="acc">
        <h2 id="acc" className="mb-2 text-lg font-medium">{tr("Comptes connectés")}</h2>
        {msg && <p role="status" className="mb-2 text-neutral-600 dark:text-neutral-400">{msg}</p>}
        <ul className="space-y-2">
          {accounts.length === 0 && <li className="text-neutral-500">{tr("Aucun compte connecté.")}</li>}
          {accounts.map((a) => {
            const f = a.features;
            return (
              <li key={a.id} className="space-y-1 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{a.email}</strong>
                  <span className="rounded bg-neutral-100 px-1.5 text-xs dark:bg-neutral-800">{PROVIDER[a.provider]}</span>
                  <span className="text-xs text-neutral-500">
                    {[f.mail && tr("{0} mails", a.mailCount), f.send && tr("envoi"), f.calendar && tr("{0} événements", a.eventCount), f.calendarWrite && tr("écriture agenda")].filter(Boolean).join(" · ")}
                  </span>
                  <span className={`text-xs ${a.status === "reauth" || a.syncStatus === "error" || a.calendarStatus === "error" ? "text-red-600" : a.syncStatus === "syncing" || a.calendarStatus === "syncing" ? "text-amber-600" : "text-green-600"}`}>
                    {a.calendarStatus === "error" ? tr("agenda : {0}", a.calendarError) : a.status === "reauth" ? tr("à reconnecter") : a.syncStatus === "syncing" ? tr("synchronisation…") : a.syncStatus === "error" ? tr("erreur : {0}", a.syncError) : a.lastSyncAt ? tr("synchronisé {0}", new Date(a.lastSyncAt).toLocaleString(locale())) : ""}
                  </span>
                  <span className="ml-auto flex gap-2">
                    <button className={btn} disabled={a.syncStatus === "syncing" || a.calendarStatus === "syncing"} onClick={() => Promise.all([rpc("mail.sync", { accountId: a.id }), rpc("calendar.sync", { accountId: a.id })]).then(refresh)}>{tr("Synchroniser")}</button>
                    <button className={btn} onClick={async () => { if (confirm(tr("Retirer {0} et supprimer ses données de cet appareil ?", a.email))) { await rpc("accounts.remove", { id: a.id }); refresh(); loadSettings(); } }}>{tr("Retirer")}</button>
                  </span>
                </div>
                {f.calendarWrite && settings && (
                  <label className="flex items-center gap-2"><input type="radio" name="writeTo" checked={settings.calendar.writeTo === a.id} onChange={() => saveSettings({ ...settings, calendar: { writeTo: a.id } })} />
                    {tr("Écrire aussi dans cet agenda les événements créés dans ASSISTANT (y compris ceux ajoutés par l'IA)")}</label>
                )}
              </li>
            );
          })}
        </ul>
        {settings && accounts.some((a) => a.features.calendarWrite) && (
          <button className={`${btn} mt-2`} disabled={settings.calendar.writeTo === null} onClick={() => saveSettings({ ...settings, calendar: { writeTo: null } })}>{tr("Ne plus écrire dans un agenda externe")}</button>
        )}
      </section>

      {settings && (
        <section className="space-y-2" aria-labelledby="mailopts">
          <h2 id="mailopts" className="text-lg font-medium">{tr("Courrier")}</h2>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={settings.mail.readAttachments} onChange={(e) => saveSettings({ ...settings, mail: { ...settings.mail, readAttachments: e.target.checked } })} />
            <span>{tr("Indexer les pièces jointes des mails analysés par l'agent")}<br /><span className="text-neutral-500">{tr("PDF (y compris scannés), Word, Excel, PowerPoint, texte, images (OCR). Leur contenu passe par le même circuit IA que vos documents. Vous pouvez aussi les importer à la main depuis un mail.")}</span></span></label>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={settings.mail.allowSend} onChange={(e) => saveSettings({ ...settings, mail: { ...settings.mail, allowSend: e.target.checked } })} />
            <span><strong>{tr("Autoriser l'envoi de mails depuis l'application")}</strong><br /><span className="text-neutral-500">{tr("Désactivé par défaut. Même activé, rien ne part sans votre clic de confirmation sur chaque message ; l'agent, le chat et les plugins ne peuvent jamais envoyer. Nécessite un compte avec le droit « Envoyer des mails » (ou un serveur SMTP).")}</span></span></label>
        </section>
      )}
      <p className="text-xs text-neutral-500">{tr("Les identifiants (jetons, mots de passe d'application) sont stockés dans la base chiffrée de ce profil et ne sont jamais affichés. Rien n'est envoyé à l'IA sans que l'agent soit activé (Settings › Agent).")}</p>
    </div>
  );
}

type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>;
const DEFAULT_PERMS: Features = { mail: true, send: false, calendar: true, calendarWrite: false };

function GoogleSection({ busy, run }: { busy: boolean; run: Run }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [perms, setPerms] = useState<Features>(DEFAULT_PERMS);
  const [msg, setMsg] = useState("");
  useEffect(() => { rpc<{ clientId: string; hasSecret: boolean }>("google.config.get").then((c) => { setClientId(c.clientId); setHasSecret(c.hasSecret); }); }, []);
  return (
    <section aria-labelledby="g" className="space-y-2">
      <h2 id="g" className="text-lg font-medium">{tr("Google (Gmail, Google Agenda)")}</h2>
      <details className="text-neutral-600 dark:text-neutral-400"><summary className="cursor-pointer">{tr("Comment obtenir l'identifiant client ?")}</summary>
        <ol className="ml-5 mt-2 list-decimal space-y-1">
          <li>{tr("Console Google Cloud → créez un projet, activez l'")}<em>{tr("API Gmail")}</em> {tr("et l'")}<em>{tr("API Google Calendar")}</em>.</li>
          <li>{tr("« Écran de consentement OAuth » : type Externe, ajoutez votre adresse comme utilisateur de test.")}</li>
          <li>{tr("« Identifiants » →")} <em>{tr("ID client OAuth")}</em> {tr("→ type")} <strong>{tr("Application de bureau")}</strong>{tr(", puis collez-le ci-dessous.")}</li>
        </ol></details>
      <div className="flex flex-wrap items-end gap-2">
        <label>{tr("ID client")}<br /><input className={`${input} w-96`} value={clientId} placeholder={tr("xxx.apps.googleusercontent.com")} onChange={(e) => setClientId(e.target.value)} /></label>
        <label>{tr("Code secret (facultatif)")}<br /><input type="password" autoComplete="off" className={`${input} w-52`} value={secret} placeholder={hasSecret ? tr("•••••• (remplacer)") : ""} onChange={(e) => setSecret(e.target.value)} /></label>
        <button className={btn} disabled={!clientId} onClick={async () => { try { await rpc("google.config.set", { clientId, clientSecret: secret }); setSecret(""); setHasSecret(hasSecret || !!secret); setMsg(tr("Enregistré.")); } catch (e) { setMsg(String(e)); } }}>{tr("Enregistrer")}</button>
      </div>
      <Perms v={perms} set={setPerms} />
      <button className={btn} disabled={busy || !clientId || !(perms.mail || perms.calendar || perms.calendarWrite)}
        onClick={() => run(tr("Une page Google s'est ouverte dans votre navigateur : autorisez l'accès…"), () => rpc("accounts.connectGoogle", { mail: perms.mail, send: perms.send, calendar: perms.calendar, calendarWrite: perms.calendarWrite }))}>{tr("Connecter un compte Google")}</button>
      <span role="status" className="ml-2 text-xs text-neutral-500">{msg}</span>
      <p className="text-xs text-neutral-500">{tr("Pour ajouter un droit à un compte déjà connecté (ex. l'écriture dans l'agenda), reconnectez-le avec les cases voulues.")}</p>
    </section>
  );
}

function MicrosoftSection({ busy, run }: { busy: boolean; run: Run }) {
  const [clientId, setClientId] = useState("");
  const [tenant, setTenant] = useState("common");
  const [perms, setPerms] = useState<Features>(DEFAULT_PERMS);
  const [msg, setMsg] = useState("");
  useEffect(() => { rpc<{ clientId: string; tenant: string }>("microsoft.config.get").then((c) => { setClientId(c.clientId); setTenant(c.tenant); }); }, []);
  return (
    <section aria-labelledby="ms" className="space-y-2">
      <h2 id="ms" className="text-lg font-medium">{tr("Microsoft (Outlook, Microsoft 365)")}</h2>
      <details className="text-neutral-600 dark:text-neutral-400"><summary className="cursor-pointer">{tr("Comment obtenir l'ID d'application ?")}</summary>
        <ol className="ml-5 mt-2 list-decimal space-y-1">
          <li>{tr("Portail Azure ›")} <em>{tr("Microsoft Entra ID")}</em> {tr("› Inscriptions d'applications › Nouvelle inscription.")}</li>
          <li>{tr("Types de comptes : selon votre usage (« comptes personnels et professionnels » pour Outlook.com + 365).")}</li>
          <li>{tr("URI de redirection : plateforme")} <strong>{tr("Client public / natif")}</strong>{tr(", valeur")} <code>{tr("http://localhost")}</code>.</li>
          <li>{tr("Autorisations API (Microsoft Graph, déléguées) :")} <code>{tr("Mail.Read")}</code>, <code>{tr("Mail.Send")}</code>, <code>{tr("Calendars.ReadWrite")}</code>, <code>{tr("offline_access")}</code>, <code>{tr("User.Read")}</code>.</li>
          <li>{tr("Copiez l'")}<em>{tr("ID d'application (client)")}</em> {tr("ci-dessous. Aucun secret n'est nécessaire.")}</li>
        </ol></details>
      <div className="flex flex-wrap items-end gap-2">
        <label>{tr("ID d'application")}<br /><input className={`${input} w-96`} value={clientId} placeholder={tr("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")} onChange={(e) => setClientId(e.target.value)} /></label>
        <label>{tr("Locataire")}<br /><input className={`${input} w-40`} value={tenant} onChange={(e) => setTenant(e.target.value)} title={tr("common, organizations, consumers ou l'ID du locataire")} /></label>
        <button className={btn} disabled={!clientId} onClick={async () => { try { await rpc("microsoft.config.set", { clientId, tenant }); setMsg(tr("Enregistré.")); } catch (e) { setMsg(String(e)); } }}>{tr("Enregistrer")}</button>
      </div>
      <Perms v={perms} set={setPerms} />
      <button className={btn} disabled={busy || !clientId || !(perms.mail || perms.calendar || perms.calendarWrite)}
        onClick={() => run(tr("Une page Microsoft s'est ouverte dans votre navigateur : autorisez l'accès…"), () => rpc("accounts.connectMicrosoft", { mail: perms.mail, send: perms.send, calendar: perms.calendar, calendarWrite: perms.calendarWrite }))}>{tr("Connecter un compte Microsoft")}</button>
      <span role="status" className="ml-2 text-xs text-neutral-500">{msg}</span>
    </section>
  );
}

function ImapSection({ busy, run }: { busy: boolean; run: Run }) {
  const [f, setF] = useState({ email: "", imapHost: "", imapPort: "993", password: "", smtpHost: "", smtpPort: "587", smtpUser: "", smtpPassword: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <details className="space-y-2" open={false}>
      <summary className="cursor-pointer text-lg font-medium">{tr("IMAP / SMTP (autre messagerie)")}</summary>
      <p className="text-neutral-600 dark:text-neutral-400">{tr("Pour OVH, Infomaniak, iCloud, Yahoo, un serveur d'entreprise… Utilisez un")} <strong>{tr("mot de passe d'application")}</strong> {tr("quand votre fournisseur en propose un. Les connexions sont toujours chiffrées (TLS/STARTTLS).")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label>{tr("Adresse e-mail")}<br /><input className={`${input} w-56`} value={f.email} onChange={set("email")} autoComplete="off" /></label>
        <label>{tr("Serveur IMAP")}<br /><input className={`${input} w-48`} value={f.imapHost} placeholder={tr("imap.exemple.com")} onChange={set("imapHost")} /></label>
        <label>{tr("Port")}<br /><input className={`${input} w-20`} value={f.imapPort} onChange={set("imapPort")} /></label>
        <label>{tr("Mot de passe")}<br /><input type="password" className={`${input} w-44`} value={f.password} onChange={set("password")} autoComplete="new-password" /></label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label>{tr("Serveur SMTP (envoi, facultatif)")}<br /><input className={`${input} w-48`} value={f.smtpHost} placeholder={tr("smtp.exemple.com")} onChange={set("smtpHost")} /></label>
        <label>{tr("Port")}<br /><input className={`${input} w-20`} value={f.smtpPort} onChange={set("smtpPort")} /></label>
        <label>{tr("Identifiant SMTP")}<br /><input className={`${input} w-44`} value={f.smtpUser} placeholder={tr("(comme l'adresse)")} onChange={set("smtpUser")} /></label>
        <label>{tr("Mot de passe SMTP")}<br /><input type="password" className={`${input} w-44`} value={f.smtpPassword} placeholder={tr("(comme IMAP)")} onChange={set("smtpPassword")} autoComplete="new-password" /></label>
      </div>
      <button className={btn} disabled={busy || !f.email || !f.imapHost || !f.password}
        onClick={() => run(tr("Test de la connexion…"), async () => {
          await rpc("accounts.addImap", { email: f.email, imapHost: f.imapHost, imapPort: Number(f.imapPort), password: f.password, ...(f.smtpHost && { smtpHost: f.smtpHost, smtpPort: Number(f.smtpPort), smtpUser: f.smtpUser || undefined, smtpPassword: f.smtpPassword || undefined }) });
          setF({ ...f, password: "", smtpPassword: "" });
        })}>{tr("Tester et ajouter")}</button>
    </details>
  );
}

function CalDavSection({ busy, run }: { busy: boolean; run: Run }) {
  const [f, setF] = useState({ url: "", user: "", password: "", calendar: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer text-lg font-medium">{tr("CalDAV (Nextcloud, iCloud, Fastmail, Synology…)")}</summary>
      <p className="text-neutral-600 dark:text-neutral-400">{tr("Lecture et écriture de l'agenda. L'URL doit être en HTTPS (ex.")} <code>{tr("https://cloud.exemple.com/remote.php/dav")}</code>{tr("). Utilisez un mot de passe d'application.")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label>{tr("URL du serveur")}<br /><input className={`${input} w-96`} value={f.url} placeholder={tr("https://…")} onChange={set("url")} /></label>
        <label>{tr("Identifiant")}<br /><input className={`${input} w-44`} value={f.user} onChange={set("user")} autoComplete="off" /></label>
        <label>{tr("Mot de passe")}<br /><input type="password" className={`${input} w-44`} value={f.password} onChange={set("password")} autoComplete="new-password" /></label>
        <label>{tr("Calendrier (facultatif)")}<br /><input className={`${input} w-40`} value={f.calendar} placeholder={tr("nom du calendrier")} onChange={set("calendar")} /></label>
      </div>
      <button className={btn} disabled={busy || !f.url || !f.user || !f.password}
        onClick={() => run(tr("Test de la connexion…"), async () => { await rpc("accounts.addCalDav", { url: f.url, user: f.user, password: f.password, calendar: f.calendar || undefined }); setF({ ...f, password: "" }); })}>{tr("Tester et ajouter")}</button>
    </details>
  );
}
