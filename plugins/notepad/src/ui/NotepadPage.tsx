import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useHostContext,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { Button, Input, Tabs, Textarea, Modal } from "./_primitives.js";

// ─── Types ─────────────────────────────────────────────────────────────

type NoteStatus = "draft" | "converted" | "archived";

interface Note {
  id: string;
  companyId: string;
  title: string;
  body: string;
  status: NoteStatus;
  convertedToIssueId: string | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Only present for converted-tab joins:
  issueTitle?: string | null;
  issueStatus?: string | null;
}

interface ConvertResult {
  issueId: string;
  title: string;
  body: string;
  cleanupUsed: boolean;
  warning: string | null;
}

type SaveState = "idle" | "saving" | "saved" | "error";

// ─── API client ────────────────────────────────────────────────────────

const PLUGIN_ID = "notepad";

function apiUrl(path: string, companyId: string, extra?: Record<string, string>): string {
  const url = new URL(`/api/plugins/${PLUGIN_ID}/api${path}`, window.location.origin);
  url.searchParams.set("companyId", companyId);
  for (const [k, v] of Object.entries(extra ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function apiCall<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  // Only set Content-Type when we have a body. Express's req.is("application/json")
  // returns false when the body is empty, which combined with a present
  // content-type header trips the host's "Plugin API routes accept JSON only"
  // 415 check on bodyless DELETE / POST.
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init?.body !== undefined && init?.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const errMsg =
      (payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string")
        ? (payload as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(errMsg);
  }
  return payload as T;
}

// ─── Date formatter ────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 30 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ─── Debounced auto-save hook ──────────────────────────────────────────

function useDebouncedSave<T>(
  value: T,
  saveFn: (v: T) => Promise<void>,
  delay = 800,
  guard?: () => boolean,
): SaveState {
  const [state, setState] = useState<SaveState>("idle");
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (guard && !guard()) return;
    setState("saving");
    const timer = setTimeout(async () => {
      try {
        await saveFn(value);
        setState("saved");
      } catch (err) {
        console.error("notepad auto-save failed", err);
        setState("error");
      }
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return state;
}

// ─── Note list ─────────────────────────────────────────────────────────

interface NoteListProps {
  notes: Note[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  loading: boolean;
}

function NoteList({ notes, selectedId, onSelect, onNew, loading }: NoteListProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {loading ? "Loading…" : `${notes.length} note${notes.length === 1 ? "" : "s"}`}
        </span>
        <Button size="xs" variant="outline" onClick={onNew}>
          + New
        </Button>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {notes.length === 0 && !loading && (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            No notes yet.
          </li>
        )}
        {notes.map((note) => {
          const active = note.id === selectedId;
          const display = note.title?.trim() || note.body.split("\n", 1)[0]?.trim() || "(empty)";
          return (
            <li key={note.id}>
              <button
                type="button"
                onClick={() => onSelect(note.id)}
                className={`block w-full border-b border-border/50 px-3 py-2 text-left transition-colors ${
                  active
                    ? "bg-accent/50 text-foreground"
                    : "text-foreground hover:bg-accent/20"
                }`}
              >
                <div className="truncate text-sm font-medium">{display}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {relativeTime(note.updatedAt)}
                  {note.status === "converted" && note.issueTitle && (
                    <> · → {note.issueTitle}</>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Note editor ───────────────────────────────────────────────────────

interface NoteEditorProps {
  note: Note;
  onChange: (patch: { title?: string; body?: string }) => Promise<void>;
  saveState: SaveState;
  readOnly?: boolean;
}

function NoteEditor({ note, onChange, saveState, readOnly = false }: NoteEditorProps) {
  const [localTitle, setLocalTitle] = useState(note.title);
  const [localBody, setLocalBody] = useState(note.body);
  const noteId = note.id;
  useEffect(() => {
    setLocalTitle(note.title);
    setLocalBody(note.body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // Push debounced changes via parent's onChange, which triggers the API patch.
  useDebouncedSave(
    { title: localTitle, body: localBody },
    async (v) => {
      if (v.title === note.title && v.body === note.body) return;
      await onChange({ title: v.title, body: v.body });
    },
    800,
    () => !readOnly,
  );

  const saveLabel: Record<SaveState, string> = {
    idle: "",
    saving: "Saving…",
    saved: "Saved",
    error: "Save failed",
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <Input
          value={localTitle}
          onChange={(e) => setLocalTitle(e.target.value)}
          placeholder="Untitled note"
          disabled={readOnly}
          className="border-0 bg-transparent text-base font-medium shadow-none focus-visible:ring-0"
        />
        <span
          className={`ml-3 text-[11px] tabular-nums ${
            saveState === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {saveLabel[saveState]}
        </span>
      </div>
      <Textarea
        value={localBody}
        onChange={(e) => setLocalBody(e.target.value)}
        placeholder="Start typing…"
        disabled={readOnly}
        className="flex-1 resize-none rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0"
      />
    </div>
  );
}

// ─── Convert modal ─────────────────────────────────────────────────────

interface ConvertModalProps {
  note: Note;
  defaultUseCleanup: boolean;
  companyPrefix: string | null;
  onClose: () => void;
  onConvert: (useCleanup: boolean) => Promise<ConvertResult>;
}

function ConvertModal({ note, defaultUseCleanup, companyPrefix, onClose, onConvert }: ConvertModalProps) {
  const [useCleanup, setUseCleanup] = useState(defaultUseCleanup);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const r = await onConvert(useCleanup);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Convert failed");
    } finally {
      setPending(false);
    }
  }

  const issueHref =
    result && companyPrefix
      ? `/${companyPrefix}/issues/${result.issueId}`
      : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Convert note to issue"
      width="lg"
      footer={
        result ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            {issueHref && (
              <a href={issueHref} className="inline-flex">
                <Button>Open issue</Button>
              </a>
            )}
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? "Converting…" : "Convert"}
            </Button>
          </>
        )
      }
    >
      {!result ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Create a new issue from this note. The original note is kept (status: converted) so you can audit what changed.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useCleanup}
              onChange={(e) => setUseCleanup(e.target.checked)}
            />
            Use AI cleanup (extracts title, tightens body via the company chat agent)
          </label>
          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>
      ) : (
        <div className="space-y-3">
          {result.warning && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-700 dark:text-yellow-300">
              {result.warning}
            </div>
          )}
          <div>
            <div className="text-xs font-medium text-muted-foreground">Issue title</div>
            <div className="mt-1 text-sm font-medium">{result.title}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted-foreground">Issue body</div>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-foreground">
              {result.body}
            </pre>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Compare with original note
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                  Original
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/10 px-2 py-1.5">
                  {note.body}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                  Cleaned
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/10 px-2 py-1.5">
                  {result.body}
                </pre>
              </div>
            </div>
          </details>
        </div>
      )}
    </Modal>
  );
}

// ─── Converted side-by-side view ───────────────────────────────────────

interface ConvertedViewProps {
  note: Note;
  companyPrefix: string | null;
}

function ConvertedView({ note, companyPrefix }: ConvertedViewProps) {
  const issueHref =
    note.convertedToIssueId && companyPrefix
      ? `/${companyPrefix}/issues/${note.convertedToIssueId}`
      : null;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Converted {note.convertedAt ? relativeTime(note.convertedAt) : ""}
        </div>
        <div className="mt-1 text-sm">
          {note.issueTitle ?? "Issue"}
          {note.issueStatus && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {note.issueStatus}
            </span>
          )}
        </div>
        {issueHref && (
          <a href={issueHref} className="mt-2 inline-flex">
            <Button size="sm" variant="outline">
              Open issue
            </Button>
          </a>
        )}
      </div>
      <div className="grid flex-1 grid-cols-2 gap-3 overflow-hidden p-4">
        <div className="flex flex-col overflow-hidden">
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
            Original note
          </div>
          <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/10 px-3 py-2 text-xs">
            {note.title && <strong>{note.title}{"\n\n"}</strong>}
            {note.body}
          </pre>
        </div>
        <div className="flex flex-col overflow-hidden">
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
            Issue
          </div>
          <div className="flex-1 overflow-auto rounded border border-border bg-muted/10 px-3 py-2 text-xs">
            <strong>{note.issueTitle ?? "(unknown — issue may have been deleted)"}</strong>
            <p className="mt-2 text-muted-foreground">
              Open the issue to see the full body — issue content lives in the core issues
              table and isn't mirrored here.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Right column (metadata + actions) ─────────────────────────────────

interface RightColumnProps {
  note: Note;
  onConvert: () => void;
  onDelete: () => void;
  companyPrefix: string | null;
}

function RightColumn({ note, onConvert, onDelete, companyPrefix }: RightColumnProps) {
  const canConvert = note.status === "draft" && note.body.trim().length > 0;
  const issueHref =
    note.convertedToIssueId && companyPrefix
      ? `/${companyPrefix}/issues/${note.convertedToIssueId}`
      : null;
  return (
    <div className="flex h-full flex-col gap-4 border-l border-border p-4 text-xs">
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
          Created
        </div>
        <div>{new Date(note.createdAt).toLocaleString()}</div>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
          Updated
        </div>
        <div>{new Date(note.updatedAt).toLocaleString()}</div>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
          Status
        </div>
        <div className="capitalize">{note.status}</div>
      </div>
      {note.status === "converted" && issueHref && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
            Issue
          </div>
          <a href={issueHref} className="text-primary underline">
            View issue
          </a>
        </div>
      )}
      <div className="mt-auto flex flex-col gap-2">
        <Button onClick={onConvert} disabled={!canConvert} size="sm">
          {note.status === "converted" ? "Already converted" : "Convert to issue"}
        </Button>
        <Button onClick={onDelete} variant="destructive" size="sm">
          Delete note
        </Button>
      </div>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────

export function NotepadPage(_props: PluginPageProps) {
  const host = useHostContext();
  const companyId = host.companyId ?? null;
  const companyPrefix = host.companyPrefix ?? null;

  const [tab, setTab] = useState<NoteStatus>("draft");
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [editorSaveState, setEditorSaveState] = useState<SaveState>("idle");
  const [globalError, setGlobalError] = useState<string | null>(null);

  const counts = useRef({ draft: 0, converted: 0, archived: 0 });

  const refresh = useCallback(async (status: NoteStatus) => {
    if (!companyId) return;
    setLoading(true);
    try {
      const res = await apiCall<{ notes: Note[] }>(
        apiUrl("/notes", companyId, { status }),
      );
      setNotes(res.notes);
      counts.current[status] = res.notes.length;
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    refresh(tab);
    setSelectedId(null);
  }, [tab, companyId, refresh]);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );

  const handleNew = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await apiCall<{ note: Note }>(
        apiUrl("/notes", companyId),
        { method: "POST", body: JSON.stringify({ body: "" }) },
      );
      setNotes((prev) => [res.note, ...prev]);
      setSelectedId(res.note.id);
      setTab("draft");
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Create failed");
    }
  }, [companyId]);

  const handleEdit = useCallback(
    async (patch: { title?: string; body?: string }) => {
      if (!companyId || !selectedId) return;
      setEditorSaveState("saving");
      try {
        const res = await apiCall<{ note: Note }>(
          apiUrl(`/notes/${selectedId}`, companyId),
          { method: "PATCH", body: JSON.stringify(patch) },
        );
        setNotes((prev) =>
          prev.map((n) => (n.id === res.note.id ? res.note : n)),
        );
        setEditorSaveState("saved");
      } catch (err) {
        console.error(err);
        setEditorSaveState("error");
        throw err;
      }
    },
    [companyId, selectedId],
  );

  const handleDelete = useCallback(async () => {
    if (!companyId || !selectedId) return;
    if (!window.confirm("Delete this note? This can't be undone.")) return;
    try {
      await apiCall(
        apiUrl(`/notes/${selectedId}`, companyId),
        { method: "DELETE" },
      );
      setNotes((prev) => prev.filter((n) => n.id !== selectedId));
      setSelectedId(null);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Delete failed");
    }
  }, [companyId, selectedId]);

  const handleConvert = useCallback(
    async (useCleanup: boolean): Promise<ConvertResult> => {
      if (!companyId || !selectedId) {
        throw new Error("No note selected");
      }
      const res = await apiCall<ConvertResult>(
        apiUrl(`/notes/${selectedId}/convert-to-issue`, companyId, {
          cleanup: useCleanup ? "true" : "false",
        }),
        { method: "POST" },
      );
      // Refresh draft list (the converted note moved out) and converted list
      // for the next time the tab is opened.
      await refresh(tab);
      return res;
    },
    [companyId, selectedId, tab, refresh],
  );

  if (!companyId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No company selected.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold">Notepad</h1>
          <Tabs<NoteStatus>
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "draft", label: "Drafts" },
              { value: "converted", label: "Converted" },
              { value: "archived", label: "Archived" },
            ]}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          Per-company freeform notes
        </span>
      </header>
      {globalError && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-xs text-destructive">
          {globalError}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setGlobalError(null)}
          >
            dismiss
          </button>
        </div>
      )}
      <div className="grid flex-1 overflow-hidden" style={{ gridTemplateColumns: "280px 1fr 240px" }}>
        <div className="overflow-hidden border-r border-border">
          <NoteList
            notes={notes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onNew={handleNew}
            loading={loading}
          />
        </div>
        <div className="overflow-hidden">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {notes.length === 0
                ? "Click + New to create your first note."
                : "Select a note to view or edit."}
            </div>
          ) : selected.status === "converted" ? (
            <ConvertedView note={selected} companyPrefix={companyPrefix} />
          ) : (
            <NoteEditor
              note={selected}
              onChange={handleEdit}
              saveState={editorSaveState}
              readOnly={selected.status === "archived"}
            />
          )}
        </div>
        <div className="overflow-hidden">
          {selected ? (
            <RightColumn
              note={selected}
              onConvert={() => setConvertOpen(true)}
              onDelete={handleDelete}
              companyPrefix={companyPrefix}
            />
          ) : (
            <div className="h-full border-l border-border" />
          )}
        </div>
      </div>
      {selected && convertOpen && (
        <ConvertModal
          note={selected}
          defaultUseCleanup={true}
          companyPrefix={companyPrefix}
          onClose={() => setConvertOpen(false)}
          onConvert={handleConvert}
        />
      )}
    </div>
  );
}
