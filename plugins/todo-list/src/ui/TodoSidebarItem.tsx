import { useCallback, useEffect, useRef, useState } from "react";
import {
  useHostContext,
  usePluginData,
  usePluginToast,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { todosApi } from "./api.js";

interface VisibilityResult {
  visible: boolean;
  capture: boolean;
  reason: string;
}

/**
 * Broadcast so the sidebar and the page stay in step without sharing state.
 * Either one dispatches after a write; both listen and refetch.
 */
export const TODOS_CHANGED_EVENT = "todo-list:changed";

export function notifyTodosChanged(): void {
  window.dispatchEvent(new CustomEvent(TODOS_CHANGED_EVENT));
}

export function TodoSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const toast = usePluginToast();
  const companyId = host.companyId;

  const { data: visibility, loading } = usePluginData<VisibilityResult>(
    "todo-list.sidebar-visible",
    { companyId },
  );

  const [openCount, setOpenCount] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshCount = useCallback(async () => {
    if (!companyId) return;
    try {
      const { todos } = await todosApi.list(companyId, { includeDone: false });
      setOpenCount(todos.length);
    } catch {
      // A count is decoration. Failing to load one should never make noise in
      // the sidebar, so leave the previous value and move on.
    }
  }, [companyId]);

  useEffect(() => {
    if (!visibility?.visible) return;
    void refreshCount();
    const onChanged = () => void refreshCount();
    window.addEventListener(TODOS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TODOS_CHANGED_EVENT, onChanged);
  }, [visibility?.visible, refreshCount]);

  const submit = useCallback(async () => {
    const title = draft.trim();
    if (!title || !companyId || saving) return;
    setSaving(true);
    try {
      await todosApi.create(companyId, { title });
      // Clear but keep focus, so several things can be rattled off in a row.
      setDraft("");
      inputRef.current?.focus();
      notifyTodosChanged();
      toast({ tone: "success", title: "Added to your to-dos", body: title });
    } catch (err) {
      toast({ tone: "error", title: "Could not add that", body: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [draft, companyId, saving, toast]);

  if (loading || !visibility?.visible) return null;

  const href = host.companyPrefix ? `/${host.companyPrefix}/todos` : "/todos";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <a
        href={href}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] font-medium text-foreground hover:bg-accent/30"
        style={{ color: "inherit", textDecoration: "none" }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            width: 14,
            height: 14,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✓
        </span>
        <span style={{ flex: 1 }}>To-dos</span>
        {openCount ? (
          <span
            style={{
              fontSize: 11,
              opacity: 0.6,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {openCount}
          </span>
        ) : null}
      </a>

      {visibility.capture ? (
        <input
          ref={inputRef}
          value={draft}
          disabled={saving}
          placeholder="Add a to-do"
          aria-label="Add a to-do"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // isComposing guards IME input, where Enter commits the candidate
            // rather than submitting.
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              setDraft("");
              inputRef.current?.blur();
            }
          }}
          style={{
            margin: "0 8px 4px 8px",
            padding: "4px 8px",
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid var(--border, rgba(127,127,127,0.3))",
            background: "var(--background, transparent)",
            color: "inherit",
            outline: "none",
            minWidth: 0,
          }}
        />
      ) : null}
    </div>
  );
}
