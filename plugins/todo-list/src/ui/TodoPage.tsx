import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  usePluginToast,
  type PluginPageProps,
  type PluginToastFn,
} from "@paperclipai/plugin-sdk/ui";
import {
  fromDateInputValue,
  isOverdue,
  midpointSortOrder,
  partitionTodos,
  toDateInputValue,
} from "../todos.js";
import { todosApi, type Todo } from "./api.js";
import { notifyTodosChanged, TODOS_CHANGED_EVENT } from "./TodoSidebarItem.js";

// ---- Styling helpers ----

const MUTED = "var(--muted-foreground, rgba(127,127,127,0.9))";
const BORDER = "1px solid var(--border, rgba(127,127,127,0.25))";
const DANGER = "var(--destructive, #d4483b)";

const ghostButton: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: MUTED,
  cursor: "pointer",
  fontSize: 12,
  padding: "2px 6px",
  borderRadius: 4,
  lineHeight: 1.4,
};

// ---- Row ----

interface RowProps {
  todo: Todo;
  now: Date;
  busy: boolean;
  onToggle: (todo: Todo) => void;
  onRename: (todo: Todo, title: string) => void;
  onDueChange: (todo: Todo, dueAt: string | null) => void;
  onPromote: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
  draggable: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
  isDropTarget?: boolean;
}

function TodoRow({
  todo,
  now,
  busy,
  onToggle,
  onRename,
  onDueChange,
  onPromote,
  onDelete,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  isDropTarget,
}: RowProps) {
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);
  const [pickingDate, setPickingDate] = useState(false);

  const overdue = isOverdue(todo, now);

  const commitRename = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === todo.title) {
      setDraft(todo.title);
      return;
    }
    onRename(todo, next);
  };

  return (
    <li
      draggable={draggable && !editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "7px 8px",
        borderRadius: 6,
        borderTop: isDropTarget ? "2px solid var(--primary, #4f7cff)" : "2px solid transparent",
        background: hover ? "var(--accent, rgba(127,127,127,0.08))" : "transparent",
        opacity: busy ? 0.5 : 1,
        cursor: draggable && !editing ? "grab" : "default",
        listStyle: "none",
      }}
    >
      <input
        type="checkbox"
        checked={todo.done}
        disabled={busy}
        aria-label={todo.done ? `Mark "${todo.title}" as not done` : `Mark "${todo.title}" as done`}
        onChange={() => onToggle(todo)}
        style={{ marginTop: 3, cursor: "pointer", flexShrink: 0 }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                setDraft(todo.title);
                setEditing(false);
              }
            }}
            style={{
              width: "100%",
              font: "inherit",
              fontSize: 14,
              padding: "1px 4px",
              border: BORDER,
              borderRadius: 4,
              background: "var(--background, transparent)",
              color: "inherit",
              outline: "none",
            }}
          />
        ) : (
          <span
            onClick={() => {
              if (todo.done || busy) return;
              setDraft(todo.title);
              setEditing(true);
            }}
            style={{
              fontSize: 14,
              lineHeight: 1.45,
              wordBreak: "break-word",
              textDecoration: todo.done ? "line-through" : "none",
              color: todo.done ? MUTED : "inherit",
              cursor: todo.done ? "default" : "text",
            }}
          >
            {todo.title}
          </span>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          {pickingDate ? (
            <input
              type="date"
              autoFocus
              defaultValue={toDateInputValue(todo.dueAt)}
              onBlur={() => setPickingDate(false)}
              onChange={(e) => {
                onDueChange(todo, fromDateInputValue(e.target.value));
                setPickingDate(false);
              }}
              style={{
                font: "inherit",
                fontSize: 11,
                padding: "1px 4px",
                border: BORDER,
                borderRadius: 4,
                background: "var(--background, transparent)",
                color: "inherit",
              }}
            />
          ) : todo.dueAt ? (
            <button
              type="button"
              onClick={() => setPickingDate(true)}
              style={{
                ...ghostButton,
                padding: 0,
                fontSize: 11,
                color: overdue ? DANGER : MUTED,
                fontWeight: overdue ? 600 : 400,
              }}
              title="Change the due date"
            >
              {overdue ? "Overdue " : "Due "}
              {new Date(todo.dueAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </button>
          ) : null}

          {todo.promotedIssueId ? (
            <span style={{ fontSize: 11, color: MUTED }}>Promoted to an issue</span>
          ) : null}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 2,
          flexShrink: 0,
          visibility: hover && !editing ? "visible" : "hidden",
        }}
      >
        {!todo.dueAt && !todo.done ? (
          <button
            type="button"
            style={ghostButton}
            onClick={() => setPickingDate(true)}
            title="Add a due date"
          >
            Due
          </button>
        ) : null}
        {!todo.promotedIssueId ? (
          <button
            type="button"
            style={ghostButton}
            onClick={() => onPromote(todo)}
            title="Turn this into a real issue in the company you are currently in"
          >
            Promote
          </button>
        ) : null}
        <button
          type="button"
          style={{ ...ghostButton, color: DANGER }}
          onClick={() => onDelete(todo)}
          title="Delete this to-do"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

// ---- Page ----

export function TodoPage({ context }: PluginPageProps) {
  const toast: PluginToastFn = usePluginToast();
  const companyId = context.companyId;

  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const captureRef = useRef<HTMLInputElement>(null);

  // Recomputed per render rather than ticking on a timer. Overdue is a
  // day-granularity idea, so a stale clock between renders cannot mislead.
  const now = useMemo(() => new Date(), [todos]);

  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const { todos: rows } = await todosApi.list(companyId);
      setTodos(rows);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener(TODOS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TODOS_CHANGED_EVENT, onChanged);
  }, [load]);

  const { open, done } = useMemo(() => partitionTodos(todos), [todos]);

  // ---- Mutations ----

  const create = useCallback(async () => {
    const title = draft.trim();
    if (!title || !companyId) return;
    setDraft("");
    captureRef.current?.focus();
    try {
      const { todo } = await todosApi.create(companyId, { title });
      setTodos((prev) => [...prev, todo]);
      notifyTodosChanged();
    } catch (err) {
      // Put the text back so nothing typed is lost to a failed request.
      setDraft(title);
      toast({ tone: "error", title: "Could not add that", body: (err as Error).message });
    }
  }, [draft, companyId, toast]);

  const patch = useCallback(
    async (todo: Todo, changes: Parameters<typeof todosApi.update>[2], failure: string) => {
      if (!companyId) return;
      setBusy(todo.id, true);
      try {
        const { todo: updated } = await todosApi.update(companyId, todo.id, changes);
        setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        notifyTodosChanged();
      } catch (err) {
        toast({ tone: "error", title: failure, body: (err as Error).message });
        void load();
      } finally {
        setBusy(todo.id, false);
      }
    },
    [companyId, setBusy, toast, load],
  );

  const remove = useCallback(
    async (todo: Todo) => {
      if (!companyId) return;
      setBusy(todo.id, true);
      const snapshot = todos;
      setTodos((prev) => prev.filter((t) => t.id !== todo.id));
      try {
        await todosApi.remove(companyId, todo.id);
        notifyTodosChanged();
      } catch (err) {
        setTodos(snapshot);
        toast({ tone: "error", title: "Could not delete", body: (err as Error).message });
      } finally {
        setBusy(todo.id, false);
      }
    },
    [companyId, todos, setBusy, toast],
  );

  const promote = useCallback(
    async (todo: Todo) => {
      if (!companyId) return;
      setBusy(todo.id, true);
      try {
        const result = await todosApi.promote(companyId, todo.id);
        await load();
        const prefix = context.companyPrefix;
        toast({
          tone: result.alreadyPromoted ? "info" : "success",
          title: result.alreadyPromoted
            ? "Already promoted"
            : "Created an issue from this to-do",
          body: result.alreadyPromoted
            ? "This one had been promoted before, so the existing issue is linked below."
            : todo.title,
          action: {
            label: "Open issue",
            href: prefix ? `/${prefix}/issues/${result.issueId}` : `/issues/${result.issueId}`,
          },
        });
      } catch (err) {
        toast({ tone: "error", title: "Could not promote", body: (err as Error).message });
      } finally {
        setBusy(todo.id, false);
      }
    },
    [companyId, setBusy, toast, load, context.companyPrefix],
  );

  const clearDone = useCallback(async () => {
    if (!companyId || done.length === 0) return;
    const snapshot = todos;
    setTodos((prev) => prev.filter((t) => !t.done));
    try {
      const { deleted } = await todosApi.clearDone(companyId);
      notifyTodosChanged();
      toast({
        tone: "success",
        title: `Cleared ${deleted} done item${deleted === 1 ? "" : "s"}`,
      });
    } catch (err) {
      setTodos(snapshot);
      toast({ tone: "error", title: "Could not clear", body: (err as Error).message });
    }
  }, [companyId, done.length, todos, toast]);

  // ---- Reordering ----

  const handleDrop = useCallback(
    (targetId: string) => {
      setDropBeforeId(null);
      const movingId = dragId;
      setDragId(null);
      if (!movingId || movingId === targetId) return;

      const moving = open.find((t) => t.id === movingId);
      if (!moving) return;

      const without = open.filter((t) => t.id !== movingId);
      const targetIndex = without.findIndex((t) => t.id === targetId);
      if (targetIndex < 0) return;

      const before = targetIndex === 0 ? null : without[targetIndex - 1]!.sortOrder;
      const after = without[targetIndex]!.sortOrder;
      const sortOrder = midpointSortOrder(before, after);

      // Reorder locally first so the row lands under the cursor immediately;
      // the request only persists what the operator can already see.
      setTodos((prev) =>
        prev.map((t) => (t.id === movingId ? { ...t, sortOrder } : t)),
      );
      void patch(moving, { sortOrder }, "Could not reorder");
    },
    [dragId, open, patch],
  );

  // ---- Render ----

  if (!companyId) {
    return <div style={{ padding: 24, color: MUTED }}>Pick a company to see your to-dos.</div>;
  }

  return (
    <div style={{ padding: "20px 24px", maxWidth: 720, margin: "0 auto" }}>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>To-dos</h1>
        <p style={{ fontSize: 12, color: MUTED, margin: "4px 0 0" }}>
          Yours alone. Nobody else can see this list, no agent is woken by it, and it stays the
          same whichever company you are in.
        </p>
      </header>

      <input
        ref={captureRef}
        autoFocus
        value={draft}
        placeholder="Add a to-do, then press Enter"
        aria-label="Add a to-do"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void create();
          } else if (e.key === "Escape") {
            setDraft("");
          }
        }}
        style={{
          width: "100%",
          font: "inherit",
          fontSize: 14,
          padding: "9px 12px",
          border: BORDER,
          borderRadius: 8,
          background: "var(--background, transparent)",
          color: "inherit",
          outline: "none",
          marginBottom: 12,
        }}
      />

      {error ? (
        <div style={{ fontSize: 13, color: DANGER, marginBottom: 12 }}>
          {error}{" "}
          <button type="button" style={{ ...ghostButton, color: DANGER }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <div style={{ fontSize: 13, color: MUTED, padding: "12px 8px" }}>Loading.</div>
      ) : open.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTED, padding: "12px 8px" }}>
          {done.length > 0
            ? "Nothing left to do."
            : "Nothing here yet. Type a line above, or use the box in the sidebar from anywhere."}
        </div>
      ) : (
        <ul
          style={{ listStyle: "none", margin: 0, padding: 0 }}
          onDragLeave={() => setDropBeforeId(null)}
        >
          {open.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              now={now}
              busy={busyIds.has(todo.id)}
              draggable
              isDropTarget={dropBeforeId === todo.id && dragId !== todo.id}
              onDragStart={() => setDragId(todo.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setDropBeforeId(todo.id);
              }}
              onDrop={() => handleDrop(todo.id)}
              onToggle={(t) => void patch(t, { done: !t.done }, "Could not update")}
              onRename={(t, title) => void patch(t, { title }, "Could not rename")}
              onDueChange={(t, dueAt) => void patch(t, { dueAt }, "Could not set the due date")}
              onPromote={(t) => void promote(t)}
              onDelete={(t) => void remove(t)}
            />
          ))}
        </ul>
      )}

      {done.length > 0 ? (
        <section style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              style={{ ...ghostButton, padding: 0, fontWeight: 600 }}
              aria-expanded={showDone}
            >
              {showDone ? "▾" : "▸"} Done ({done.length})
            </button>
            <span style={{ flex: 1 }} />
            {showDone ? (
              <button type="button" style={ghostButton} onClick={() => void clearDone()}>
                Clear done
              </button>
            ) : null}
          </div>

          {showDone ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {done.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  now={now}
                  busy={busyIds.has(todo.id)}
                  draggable={false}
                  onToggle={(t) => void patch(t, { done: !t.done }, "Could not update")}
                  onRename={(t, title) => void patch(t, { title }, "Could not rename")}
                  onDueChange={(t, dueAt) => void patch(t, { dueAt }, "Could not set the due date")}
                  onPromote={(t) => void promote(t)}
                  onDelete={(t) => void remove(t)}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
