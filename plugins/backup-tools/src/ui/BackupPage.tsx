import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  useHostContext,
  usePluginData,
  usePluginAction,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { errorText, restoreErrorText, restoreOutcomeUnknown } from "./errorText.js";

type Tab = "overview" | "schedules" | "destinations" | "history" | "restore";

type Backup = {
  id: string;
  archive_uuid: string;
  cadence: string;
  schedule_id: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  size_bytes: number | null;
};

type Destination = { id: string; kind: string; label: string };

// Host theme tokens, with the old light-mode literals kept as fallbacks. These
// have to be tokens rather than fixed hexes: the page previously painted the
// selected tab in near-black, which is invisible against the dark theme's
// near-black page, so the tab you were actually on was the one you could not
// read. Anything that sets a colour here reads a token.
const css = {
  border: "1px solid var(--border, #e5e7eb)",
  hairline: "1px solid color-mix(in oklab, var(--border, #f3f4f6) 55%, transparent)",
  fg: "var(--foreground, #111827)",
  muted: "var(--muted-foreground, #6b7280)",
  card: "var(--card, #ffffff)",
  sunken: "var(--muted, #f3f4f6)",
  danger: "var(--destructive, #b91c1c)",
};

const primaryButton: CSSProperties = {
  padding: "8px 14px",
  background: "var(--primary, #111827)",
  color: "var(--primary-foreground, #ffffff)",
  border: "none",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  padding: 6,
  border: "1px solid var(--input, #d1d5db)",
  borderRadius: 4,
  background: "var(--background, #ffffff)",
  color: css.fg,
};

const cardStyle: CSSProperties = {
  border: css.border,
  background: css.card,
  padding: 16,
  borderRadius: 6,
};

// A failed fetch must not render as an empty state. Every tab below took
// `data?.x ?? []` and showed "No backups yet" / "No destinations configured"
// whether the worker returned nothing or failed outright — so a missing data
// handler looked exactly like an empty table, and read as "working, nothing
// here" for as long as it took someone to notice the numbers disagreed.
function ErrorNote({ error }: { error: { message: string } }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        background: "color-mix(in oklab, var(--destructive, #b91c1c) 12%, var(--background, #fef2f2))",
        border: "1px solid color-mix(in oklab, var(--destructive, #b91c1c) 40%, transparent)",
        color: css.fg,
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      <strong style={{ color: css.danger }}>Couldn't load this tab.</strong>{" "}
      {error.message}
    </div>
  );
}

function statusBadge(status: string) {
  const color = status === "succeeded" ? "#10b981" : status === "partial" ? "#f59e0b" : status === "running" ? "#3b82f6" : "#ef4444";
  return (
    <span
      style={{
        display: "inline-block",
        background: color,
        color: "white",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

export function BackupPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div style={{ padding: 24, color: css.fg }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Backups</h1>
      <p style={{ color: css.muted, fontSize: 14, marginBottom: 16 }}>
        System backup manager — encrypted snapshots fan out to your configured destinations.
      </p>

      <nav style={{ display: "flex", gap: 4, borderBottom: css.border, marginBottom: 16 }}>
        {(["overview", "schedules", "destinations", "history", "restore"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-current={tab === t ? "page" : undefined}
            style={{
              padding: "8px 14px",
              border: "none",
              background: "transparent",
              fontSize: 14,
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? css.fg : css.muted,
              borderBottom: tab === t ? `2px solid ${css.fg}` : "2px solid transparent",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === "overview" && <OverviewTab companyId={host.companyId} />}
      {tab === "schedules" && <SchedulesTab />}
      {tab === "destinations" && <DestinationsTab companyId={host.companyId} />}
      {tab === "history" && <HistoryTab companyId={host.companyId} />}
      {tab === "restore" && <RestoreTab companyId={host.companyId} />}
    </div>
  );
}

/** How often the Overview card reads the last backup again while one is running. */
const RUNNING_REFRESH_MS = 5_000;

function OverviewTab({ companyId: _companyId }: { companyId: string | null }) {
  const { data, loading, error, refresh } = usePluginData<{ lastRun: Backup | null; nextRunAfter: string | null }>(
    "dashboard.health",
    {},
  );
  const runNowAction = usePluginAction("backups.run-now");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const running = data?.lastRun?.status === "running";

  // Run now answers as soon as the backup starts, so the card follows the
  // backup itself: read it again every few seconds until it has finished.
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(refresh, RUNNING_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [running, data, refresh]);

  // Each refresh sets loading again. Keep the card on screen while it does.
  if (loading && !data) return <div>Loading…</div>;
  if (error) return <ErrorNote error={error} />;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
      <div style={cardStyle}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Last backup</h3>
        {data?.lastRun ? (
          <>
            <div>{statusBadge(data.lastRun.status)}</div>
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <div>Started: {new Date(data.lastRun.started_at).toLocaleString()}</div>
              <div>Size: {fmtSize(data.lastRun.size_bytes)}</div>
              <div>Cadence: {data.lastRun.cadence || "—"}</div>
            </div>
          </>
        ) : (
          <div style={{ color: css.muted, fontSize: 13 }}>No backups yet.</div>
        )}
      </div>

      <div style={cardStyle}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Next scheduled run</h3>
        <div style={{ fontSize: 13 }}>
          {data?.nextRunAfter ? new Date(data.nextRunAfter).toUTCString() : "—"}
        </div>
        <button
          disabled={busy || running}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              // Answers as soon as the backup starts (or with the one already
              // running). The refresh shows it running, and the effect above
              // follows it from there.
              await runNowAction({});
              refresh();
            } catch (err) {
              setMsg(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
          style={{
            ...primaryButton,
            marginTop: 12,
            cursor: busy ? "wait" : running ? "default" : "pointer",
            opacity: busy || running ? 0.6 : 1,
          }}
        >
          {busy ? "Starting…" : running ? "Backup running…" : "Run backup now"}
        </button>
        {running && (
          <div style={{ marginTop: 8, fontSize: 12, color: css.muted }}>
            A backup is running. The result shows under Last backup when it finishes.
          </div>
        )}
        {msg && <div style={{ marginTop: 8, fontSize: 12, color: css.muted }}>{msg}</div>}
      </div>
    </div>
  );
}

function SchedulesTab() {
  return (
    <div style={{ fontSize: 13, color: css.muted }}>
      Schedules are configured on the plugin's <a href="/instance/settings/plugins/backup-tools">settings page</a>.
      This tab will surface schedule_state (last run, next run, consecutive failures) in v0.1.1.
    </div>
  );
}

function DestinationsTab({ companyId }: { companyId: string | null }) {
  const { data, loading, error } = usePluginData<{ destinations: Destination[] }>("destinations.list", { companyId });
  if (loading) return <div>Loading…</div>;
  if (error) return <ErrorNote error={error} />;
  const dests = data?.destinations ?? [];
  if (dests.length === 0) return <div>No destinations configured.</div>;
  return (
    <table style={{ width: "100%", fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: css.border }}>
          <th style={{ padding: 8 }}>ID</th>
          <th style={{ padding: 8 }}>Kind</th>
          <th style={{ padding: 8 }}>Label</th>
        </tr>
      </thead>
      <tbody>
        {dests.map((d) => (
          <tr key={d.id} style={{ borderBottom: css.hairline }}>
            <td style={{ padding: 8 }}>{d.id}</td>
            <td style={{ padding: 8 }}>{d.kind}</td>
            <td style={{ padding: 8 }}>{d.label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryTab({ companyId }: { companyId: string | null }) {
  const { data, loading, error } = usePluginData<{ backups: Backup[] }>("backups.list", { companyId });
  if (loading) return <div>Loading…</div>;
  if (error) return <ErrorNote error={error} />;
  const rows = data?.backups ?? [];
  if (rows.length === 0) return <div>No backups yet.</div>;
  return (
    <table style={{ width: "100%", fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: css.border }}>
          <th style={{ padding: 8 }}>Started</th>
          <th style={{ padding: 8 }}>Cadence</th>
          <th style={{ padding: 8 }}>Status</th>
          <th style={{ padding: 8 }}>Size</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id} style={{ borderBottom: css.hairline }}>
            <td style={{ padding: 8 }}>{new Date(b.started_at).toLocaleString()}</td>
            <td style={{ padding: 8 }}>{b.cadence}</td>
            <td style={{ padding: 8 }}>{statusBadge(b.status)}</td>
            <td style={{ padding: 8 }}>{fmtSize(b.size_bytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** How often the Restore tab reads a restore again while one runs. */
const RESTORE_REFRESH_MS = 3_000;
const RESTORE_CONFIRM_PHRASE = "RESTORE THIS INSTANCE";

type RestoreJob = {
  restoreId: string;
  mode: "preview" | "apply";
  status: "running" | "succeeded" | "failed";
  stage: "download" | "paperclip" | null;
  destinationId: string;
  archiveKey: string;
  startedAt: string;
  finishedAt: string | null;
  archive: { createdAt: string; instanceId: string; cadence: string; tables: number; rows: number } | null;
  result: { applied: boolean; dryRun: boolean; warnings: string[] } | null;
  error: string | null;
};

type RestoreStatus = { isInstanceAdmin: boolean; restore: RestoreJob | null };

const dangerText: CSSProperties = { color: css.danger, fontSize: 13 };
const noteText: CSSProperties = { color: css.muted, fontSize: 13 };
const secondaryButton: CSSProperties = {
  ...primaryButton,
  background: "transparent",
  color: css.fg,
  border: css.border,
};

function isDone(job: RestoreJob | undefined): boolean {
  return job?.status === "succeeded" || job?.status === "failed";
}

function RestoreTab({ companyId: _companyId }: { companyId: string | null }) {
  const { data, loading, error, refresh } = usePluginData<RestoreStatus>("restore.status", {});
  // A read can fail while Paperclip replaces its database, and the hook drops
  // what it had when one does. Keep the last answer so the steps stay put.
  const [lastGood, setLastGood] = useState<RestoreStatus | null>(null);
  useEffect(() => {
    if (data) setLastGood(data);
  }, [data]);
  const status = data ?? lastGood;

  return (
    <div style={{ maxWidth: 640 }}>
      <div
        style={{
          background: "color-mix(in oklab, var(--destructive, #b91c1c) 14%, var(--background, #fef2f2))",
          border: "1px solid color-mix(in oklab, var(--destructive, #b91c1c) 45%, transparent)",
          padding: 12,
          borderRadius: 6,
          marginBottom: 16,
        }}
      >
        <strong style={{ color: css.danger }}>Destructive. Instance admins only.</strong>
        <div style={{ fontSize: 13, color: css.fg, marginTop: 4 }}>
          Restore overwrites the entire instance database. There is no undo. Make sure you have a fresh backup of the
          current state before applying.
        </div>
        <div style={{ fontSize: 13, color: css.fg, marginTop: 4 }}>
          Only restore an archive you made. Paperclip replays it with psql, which can also run commands on this
          server.
        </div>
      </div>

      {!status ? (
        loading ? <div>Loading…</div> : error ? <ErrorNote error={error} /> : null
      ) : status.isInstanceAdmin ? (
        <RestoreWizard latest={status.restore} readError={error} refresh={refresh} />
      ) : (
        // The worker refuses anyone else whatever this page shows. This only
        // spares them controls that cannot work for them.
        <div style={noteText}>Only an instance admin can preview or apply a restore.</div>
      )}
    </div>
  );
}

function RestoreWizard({
  latest,
  readError,
  refresh,
}: {
  latest: RestoreJob | null;
  readError: { message: string } | null;
  refresh: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [destinationId, setDestinationId] = useState("");
  const [archiveKey, setArchiveKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [applyId, setApplyId] = useState<string | null>(null);
  // Every restore this page has seen, by id. The worker reports only the
  // latest, and this page's own restores must not vanish when another starts.
  const [seen, setSeen] = useState<Record<string, RestoreJob>>({});
  useEffect(() => {
    if (latest) setSeen((jobs) => ({ ...jobs, [latest.restoreId]: latest }));
  }, [latest]);

  const previewAction = usePluginAction("restore.preview");
  const applyAction = usePluginAction("restore.apply");

  const preview = previewId ? seen[previewId] ?? null : null;
  const applied = applyId ? seen[applyId] ?? null : null;
  // A restore this page did not start, such as one from before it was opened.
  const other = latest && latest.restoreId !== previewId && latest.restoreId !== applyId ? latest : null;
  const otherRunning = other?.status === "running";
  const previewRunning = previewId !== null && !isDone(preview ?? undefined);
  const phraseOk = confirmPhrase === RESTORE_CONFIRM_PHRASE;
  // Blank uses this instance's own key. A typed passphrase is at least 8 characters.
  const passphraseOk = passphrase.length === 0 || passphrase.length >= 8;

  // Preview and Apply answer as soon as the restore starts. Read it again every
  // few seconds until it has finished, failed reads included.
  const waiting =
    latest?.status === "running" ||
    (previewId !== null && !isDone(preview ?? undefined)) ||
    (applyId !== null && !isDone(applied ?? undefined));
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(refresh, RESTORE_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [waiting, latest, readError, refresh]);

  // A preview that went through moves on to the confirmation.
  useEffect(() => {
    if (step === 3 && preview?.status === "succeeded") setStep(4);
  }, [step, preview?.status]);

  async function start(mode: "preview" | "apply") {
    setBusy(true);
    setRefusal(null);
    try {
      const params = { destinationId, archiveKey, passphrase, conflictMode: "overwrite" };
      const started = (await (mode === "apply"
        ? applyAction({ ...params, confirmPhrase })
        : previewAction(params))) as { restoreId: string };
      if (mode === "apply") {
        setApplyId(started.restoreId);
        setStep(5);
      } else {
        setPreviewId(started.restoreId);
      }
      refresh();
    } catch (err) {
      setRefusal(restoreErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setStep(1);
    setPreviewId(null);
    setApplyId(null);
    setConfirmPhrase("");
    setRefusal(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {other && otherRunning && (
        <div style={{ ...cardStyle, fontSize: 13 }}>
          A {other.mode === "apply" ? "restore" : "preview"} of {other.archiveKey} is running.{" "}
          <RestoreProgress job={other} /> Wait for it to finish before you start another.
        </div>
      )}
      {other && !otherRunning && other.finishedAt && (
        <div style={noteText}>
          Last {other.mode === "apply" ? "restore" : "preview"}: {other.archiveKey},{" "}
          {other.status === "succeeded" ? "finished" : "failed"} {new Date(other.finishedAt).toLocaleString()}.
          {other.mode === "apply" && other.status === "succeeded" && " Restart Paperclip if you have not since."}
        </div>
      )}

      {step === 1 && (
        <>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Step 1: Pick the archive</h3>
          <label style={{ fontSize: 13 }}>
            Destination ID (the Destinations tab lists them):
            <input
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              style={{ ...inputStyle, marginLeft: 8 }}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            Archive key, its file name (for example 20261009T030700-&lt;archive id&gt;.pcback):
            <input
              value={archiveKey}
              onChange={(e) => setArchiveKey(e.target.value)}
              style={{ ...inputStyle, marginLeft: 8, width: 400 }}
            />
          </label>
          <div>
            <button
              disabled={!destinationId.trim() || !archiveKey.trim()}
              onClick={() => setStep(2)}
              style={{ ...primaryButton, opacity: !destinationId.trim() || !archiveKey.trim() ? 0.5 : 1 }}
            >
              Next
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Step 2: Passphrase</h3>
          <label style={{ fontSize: 13 }}>
            Backup passphrase:
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              style={{ ...inputStyle, marginLeft: 8, width: 400 }}
            />
          </label>
          <div style={noteText}>
            Leave it blank for an archive this instance made. Its own key, or the passphrase in the plugin settings, is
            used. For an archive from another instance, paste that instance's exported key or passphrase.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setStep(1)} style={secondaryButton}>
              Back
            </button>
            <button
              disabled={!passphraseOk}
              onClick={() => setStep(3)}
              style={{ ...primaryButton, opacity: passphraseOk ? 1 : 0.5 }}
            >
              Next
            </button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Step 3: Preview</h3>
          <div style={noteText}>
            The preview downloads the whole archive and decrypts it with the passphrase, checking every part. Nothing
            is changed and nothing is saved to disk. Paperclip itself reads the archive only when you apply. It can
            take a few minutes.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setStep(2)} disabled={busy || previewRunning} style={secondaryButton}>
              Back
            </button>
            <button
              disabled={busy || previewRunning || otherRunning}
              onClick={() => start("preview")}
              style={{ ...primaryButton, opacity: busy || previewRunning || otherRunning ? 0.6 : 1 }}
            >
              {busy
                ? "Starting…"
                : previewRunning
                  ? "Previewing…"
                  : preview?.status === "failed"
                    ? "Run the preview again"
                    : "Run preview"}
            </button>
          </div>
          {previewRunning && <RestoreProgress job={preview} />}
          {preview?.status === "failed" && (
            <div style={dangerText}>The preview did not work. {restoreErrorText(preview.error)}</div>
          )}
          {refusal && <div style={dangerText}>{refusal}</div>}
        </>
      )}

      {step === 4 && preview?.status === "succeeded" && (
        <>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Step 4: Confirm</h3>
          {preview.archive && <ArchiveSummary archive={preview.archive} />}
          <div style={{ fontSize: 13 }}>
            The plugin decrypted the whole archive and every part checked out, so it is complete and was made with
            this passphrase. Paperclip has not read it yet: it does when you apply, and a dump it cannot run is rolled
            back then. Nothing has been changed. Applying replaces the whole database with this archive.
          </div>
          <label style={{ fontSize: 13 }}>
            Type <code>{RESTORE_CONFIRM_PHRASE}</code> to enable apply:
            <input
              value={confirmPhrase}
              onChange={(e) => setConfirmPhrase(e.target.value)}
              style={{
                ...inputStyle,
                marginLeft: 8,
                borderColor: phraseOk ? "#10b981" : "var(--input, #d1d5db)",
                width: 400,
                fontFamily: "monospace",
              }}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={startOver} disabled={busy} style={secondaryButton}>
              Start over
            </button>
            <button
              disabled={!phraseOk || busy || otherRunning}
              onClick={() => start("apply")}
              style={{
                ...primaryButton,
                background: css.danger,
                color: "var(--destructive-foreground, #ffffff)",
                opacity: !phraseOk || busy || otherRunning ? 0.5 : 1,
              }}
            >
              {busy ? "Starting…" : "Apply restore"}
            </button>
          </div>
          {refusal && <div style={dangerText}>{refusal}</div>}
        </>
      )}

      {step === 5 && (
        <>
          {!isDone(applied ?? undefined) && (
            <>
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>Restoring</h3>
              <div style={{ fontSize: 13 }}>
                Paperclip is replacing the whole database with this archive. It can take several minutes, and Paperclip
                may stop answering until it finishes. Keep this tab open. It checks again every few seconds.
              </div>
              <RestoreProgress job={applied} />
              {readError && (
                <div style={noteText}>
                  Paperclip is not answering at the moment, which is expected while it restores. If you have been
                  signed out, sign in again and open this tab to see the result.
                </div>
              )}
            </>
          )}
          {applied?.status === "succeeded" && (
            <>
              <h3 style={{ fontSize: 16, fontWeight: 600, color: "#10b981" }}>Restore complete</h3>
              <div style={{ fontSize: 13 }}>
                The database now holds the archive
                {applied.archive ? ` made ${new Date(applied.archive.createdAt).toLocaleString()}` : ""}. Restart
                Paperclip now, so every part of it works from the restored data. You may need to sign in again.
              </div>
            </>
          )}
          {applied?.status === "failed" && (
            <>
              <h3 style={{ fontSize: 16, fontWeight: 600, color: css.danger }}>The restore did not finish</h3>
              <div style={dangerText}>{restoreErrorText(applied.error)}</div>
              {!restoreOutcomeUnknown(applied.error) && (
                <div style={{ fontSize: 13 }}>
                  Paperclip restores in one transaction, so the database is as it was before.
                </div>
              )}
              <div>
                <button onClick={startOver} style={secondaryButton}>
                  Start over
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Where a running restore has got to, in words. */
function RestoreProgress({ job }: { job: RestoreJob | null }) {
  const text = !job
    ? "Starting…"
    : job.mode === "preview"
      ? "Downloading the archive and checking every part…"
      : job.stage === "download"
        ? "Downloading and decrypting the archive…"
        : "Paperclip is replacing the database…";
  return <span style={noteText}>{text}</span>;
}

/** What the archive holds, from its envelope, whose seal the passphrase checked. */
function ArchiveSummary({ archive }: { archive: NonNullable<RestoreJob["archive"]> }) {
  return (
    <div style={{ ...cardStyle, fontSize: 13 }}>
      <div>
        Made: {new Date(archive.createdAt).toLocaleString()} ({archive.cadence} backup)
      </div>
      <div>From instance: {archive.instanceId}</div>
      <div>
        Holds: {archive.tables} tables, {archive.rows.toLocaleString()} rows
      </div>
    </div>
  );
}
