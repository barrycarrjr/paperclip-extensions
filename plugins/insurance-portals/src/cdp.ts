/**
 * Minimal Chrome driver over the DevTools protocol pipe.
 *
 * Why not Playwright/Puppeteer: both expect their own package folder at
 * runtime (package.json, browser registries), and the install step ships
 * only the bundled `dist/`. Chrome's `--remote-debugging-pipe` speaks plain
 * NUL-delimited JSON on fds 3 and 4, so a small client is enough and needs no
 * dependency at all.
 *
 * Every run gets a throwaway profile directory, so no cookies, saved
 * passwords or "trusted device" marks survive between runs.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

type Json = Record<string, unknown>;
type Listener = (params: Json, sessionId: string | undefined) => void;

const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

export function findChrome(override?: string): string {
  if (override && override.trim()) {
    if (!existsSync(override)) throw new Error(`[ECHROME_NOT_FOUND] No browser at ${override}`);
    return override;
  }
  for (const p of CHROME_CANDIDATES[process.platform] ?? []) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "[ECHROME_NOT_FOUND] Google Chrome is not installed in its usual place. Install Chrome, or set 'Chrome path' in the plugin settings.",
  );
}

/**
 * Create a kept profile folder private to this user, and clear a lock left by
 * a Chrome that is no longer running (a crash, a killed worker). A lock held
 * by a live Chrome is left alone, and the launch will fail rather than share.
 */
async function prepareProfile(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const lock = join(dir, "SingletonLock");
  const st = await lstat(lock).catch(() => null);
  if (!st) return;
  const target = await readlink(lock).catch(() => "");
  const pid = Number(/-(\d+)$/.exec(target)?.[1] ?? NaN);
  let alive = false;
  if (Number.isFinite(pid)) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  if (!alive) {
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      await rm(join(dir, f), { force: true }).catch(() => undefined);
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LaunchOptions {
  executablePath: string;
  headless: boolean;
  /**
   * A profile folder kept between runs (cookies, "remember this device"
   * marks). Omit for a throwaway profile deleted on close.
   */
  profileDir?: string;
}

export class Browser {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
  private listeners = new Map<string, Set<Listener>>();
  private buffer = "";
  private closed = false;
  readonly pages = new Map<string, Page>();

  private constructor(
    private proc: ChildProcess,
    private input: Writable,
    output: Readable,
    readonly profileDir: string,
    readonly downloadDir: string,
    private readonly keepProfile = false,
  ) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.onData(chunk));
    proc.on("exit", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("[EBROWSER_EXITED] Chrome exited"));
      this.pending.clear();
    });
  }

  static async launch(opts: LaunchOptions): Promise<Browser> {
    const keepProfile = !!opts.profileDir;
    const profileDir = opts.profileDir ?? (await mkdtemp(join(tmpdir(), "pc-insurance-profile-")));
    if (keepProfile) await prepareProfile(profileDir);
    const downloadDir = await mkdtemp(join(tmpdir(), "pc-insurance-dl-"));
    const args = [
      "--remote-debugging-pipe",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--password-store=basic",
      // Keep Chrome away from the macOS keychain: a background run must never
      // raise a keychain prompt. The profile folder itself is private (0700).
      "--use-mock-keychain",
      "--hide-crash-restore-bubble",
      "--window-size=1366,900",
      "--lang=en-US",
      ...(opts.headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    const proc = spawn(opts.executablePath, args, {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    const input = proc.stdio[3] as Writable;
    const output = proc.stdio[4] as Readable;
    const browser = new Browser(proc, input, output, profileDir, downloadDir, keepProfile);
    await browser.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
    // Every tab, including ones a click opens later (a PDF viewer, a print
    // view), is attached paused, has the hooks applied (request guard, PDF
    // capture), and only then is allowed to load.
    browser.on("Target.attachedToTarget", (p) => {
      const info = p.targetInfo as Json;
      const sessionId = String(p.sessionId);
      if (info?.type !== "page") {
        void browser.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
        return;
      }
      void browser.setUpPage(String(info.targetId), sessionId).catch(() => undefined);
    });
    browser.on("Target.detachedFromTarget", (p) => {
      for (const [id, page] of browser.pages) if (page.sessionId === p.sessionId) browser.pages.delete(id);
    });
    await browser.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return browser;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\0")) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      let msg: Json;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = msg.error as { message?: string };
          p.reject(new Error(`${p.method}: ${err.message ?? "CDP error"}`));
        } else {
          p.resolve((msg.result as Json) ?? {});
        }
      } else if (typeof msg.method === "string") {
        for (const l of this.listeners.get(msg.method) ?? []) {
          try {
            l((msg.params as Json) ?? {}, msg.sessionId as string | undefined);
          } catch {
            // A listener failing must not break the message loop.
          }
        }
      }
    }
  }

  send(method: string, params: Json = {}, sessionId?: string, timeoutMs = 30_000): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("[EBROWSER_EXITED] Chrome is not running"));
    const id = this.nextId++;
    const msg: Json = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.input.write(JSON.stringify(msg) + "\0");
    });
  }

  on(method: string, l: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(l);
    return () => set!.delete(l);
  }

  private readonly hooks: Array<(page: Page) => Promise<void>> = [];
  private readonly ready = new Map<string, Promise<Page>>();

  /** Run `hook` on every open tab now and on every tab attached later. */
  async addHook(hook: (page: Page) => Promise<void>): Promise<void> {
    this.hooks.push(hook);
    for (const page of this.pages.values()) await page.apply(hook);
  }

  setUpPage(targetId: string, sessionId: string): Promise<Page> {
    let p = this.ready.get(targetId);
    if (!p) {
      p = (async () => {
        const page = new Page(this, targetId, sessionId);
        await page.send("Page.enable");
        await page.send("Runtime.enable");
        await page.send("Network.enable", { maxResourceBufferSize: 50_000_000, maxTotalBufferSize: 200_000_000 });
        for (const hook of this.hooks) await page.apply(hook);
        this.pages.set(targetId, page);
        await page.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
        return page;
      })();
      this.ready.set(targetId, p);
    }
    return p;
  }

  async firstPage(): Promise<Page> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const first = this.ready.values().next();
      if (!first.done) return first.value;
      await sleep(100);
    }
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    while (!this.ready.has(targetId)) await sleep(100);
    return this.ready.get(targetId)!;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      await this.send("Browser.close", {}, undefined, 5_000).catch(() => undefined);
      await sleep(300);
      if (!this.closed) this.proc.kill("SIGKILL");
    }
    if (!this.keepProfile) await rm(this.profileDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(this.downloadDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class Page {
  private readonly applied = new Set<(page: Page) => Promise<void>>();

  async apply(hook: (page: Page) => Promise<void>): Promise<void> {
    if (this.applied.has(hook)) return;
    this.applied.add(hook);
    await hook(this);
  }

  constructor(
    readonly browser: Browser,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  send(method: string, params: Json = {}, timeoutMs?: number): Promise<Json> {
    return this.browser.send(method, params, this.sessionId, timeoutMs);
  }

  on(method: string, l: (params: Json) => void): () => void {
    return this.browser.on(method, (p, sid) => {
      if (sid === this.sessionId) l(p);
    });
  }

  /** Run `fn` in the page with JSON-serialisable args; returns its JSON result. */
  async evaluate<T>(fn: (...args: any[]) => unknown, ...args: unknown[]): Promise<T> {
    // `__name` covers transpilers (tsx, esbuild keepNames) that wrap functions
    // in a helper the page does not have.
    const expression = `(() => { var __name = (f) => f; return (${fn.toString()})(...${JSON.stringify(args)}); })()`;
    const res = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (res.exceptionDetails) {
      throw new Error(
        `page script failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "unknown"}`,
      );
    }
    return res.result?.value as T;
  }

  async url(): Promise<string> {
    return this.evaluate<string>(() => location.href).catch(() => "");
  }

  async goto(url: string, timeoutMs = 45_000): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.waitForLoad(timeoutMs);
  }

  async waitForLoad(timeoutMs = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await sleep(500);
    while (Date.now() < deadline) {
      const state = await this.evaluate<string>(() => document.readyState).catch(() => "loading");
      if (state === "complete") break;
      await sleep(300);
    }
    // Single-page apps keep rendering after `load`; give them a moment.
    await sleep(1500);
  }

  /** Poll `fn` in the page until it returns a truthy value. */
  async waitFor<T>(fn: (...args: any[]) => T, args: unknown[], timeoutMs: number, intervalMs = 500): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await this.evaluate<T>(fn, ...args).catch(() => null);
      if (v) return v;
      await sleep(intervalMs);
    }
    return null;
  }

  /** Click the element marked `data-pcip="<mark>"` with real mouse events. */
  async clickMark(mark: string): Promise<boolean> {
    const box = await this.evaluate<{ x: number; y: number; covered: boolean } | null>((m: string) => {
      const el = document.querySelector(`[data-pcip="${m}"]`) as HTMLElement | null;
      if (!el) return null;
      // "nearest" sideways: centring sideways shifts the whole page left.
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // Something floating on top (a chat button, a banner) would take the click.
      const top = document.elementFromPoint(x, y);
      const covered = !top || !(top === el || el.contains(top) || top.contains(el));
      return { x, y, covered };
    }, mark);
    if (!box || box.covered) {
      return this.evaluate<boolean>((m: string) => {
        const el = document.querySelector(`[data-pcip="${m}"]`) as HTMLElement | null;
        if (!el) return false;
        el.click();
        return true;
      }, mark).catch(() => false);
    }
    const base = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return true;
  }

  /**
   * Replace the value of the element marked `mark` with `text`, as typed
   * input. The text travels only over the DevTools pipe; it is never logged.
   */
  async typeIntoMark(mark: string, text: string): Promise<boolean> {
    const ok = await this.evaluate<boolean>((m: string) => {
      const el = document.querySelector(`[data-pcip="${m}"]`) as HTMLInputElement | null;
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.focus();
      el.select?.();
      return document.activeElement === el;
    }, mark);
    if (!ok) return false;
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.send("Input.insertText", { text });
    // Some forms only validate on change/blur; fall back to the native setter
    // if the typed value did not stick.
    return this.evaluate<boolean>(
      (m: string, v: string) => {
        const el = document.querySelector(`[data-pcip="${m}"]`) as HTMLInputElement | null;
        if (!el) return false;
        if (el.value !== v) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return el.value === v;
      },
      mark,
      text,
    );
  }

  async pressEscape(): Promise<void> {
    const k = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  }

  async pressEnter(): Promise<void> {
    const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  }

  async screenshot(path: string): Promise<void> {
    const { data } = (await this.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    await writeFile(path, Buffer.from(data, "base64"));
  }
}
