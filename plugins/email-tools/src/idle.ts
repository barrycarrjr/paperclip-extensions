import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ImapFlow } from "imapflow";
import { buildMailboxRuntime, pollOne } from "./poll.js";
import { openConnection, safeLogout } from "./imap.js";
import type { ConfigMailbox, InstanceConfig } from "./types.js";

interface IdleEntry {
  mailbox: ConfigMailbox;
  client?: ImapFlow;
  reconnectTimer?: NodeJS.Timeout;
  backoffMs: number;
  closed: boolean;
}

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 30_000];
const IDLE_RENEW_MS = 28 * 60 * 1000;

export class IdleManager {
  private ctx: PluginContext;
  private entries = new Map<string, IdleEntry>();
  private lastConfigKey = "";

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  async start(config: InstanceConfig): Promise<void> {
    this.lastConfigKey = serializeRelevantConfig(config);
    for (const mailbox of config.mailboxes ?? []) {
      if (mailbox.pollEnabled && mailbox.key && mailbox.ingestCompanyId) {
        this.openIdle(mailbox);
      }
    }
  }

  async onConfigChanged(newConfig: InstanceConfig): Promise<void> {
    const newKey = serializeRelevantConfig(newConfig);
    if (newKey === this.lastConfigKey) return;
    this.lastConfigKey = newKey;

    const wantedKeys = new Set<string>();
    const wantedMap = new Map<string, ConfigMailbox>();
    for (const m of newConfig.mailboxes ?? []) {
      if (m.pollEnabled && m.key && m.ingestCompanyId) {
        wantedKeys.add(m.key);
        wantedMap.set(m.key, m);
      }
    }

    for (const [key, entry] of this.entries.entries()) {
      if (!wantedKeys.has(key) || configChanged(entry.mailbox, wantedMap.get(key))) {
        await this.closeOne(key);
      }
    }
    for (const [key, mailbox] of wantedMap.entries()) {
      if (!this.entries.has(key)) {
        this.openIdle(mailbox);
      }
    }
  }

  async shutdown(): Promise<void> {
    const keys = Array.from(this.entries.keys());
    await Promise.all(keys.map((k) => this.closeOne(k)));
  }

  private openIdle(mailbox: ConfigMailbox): void {
    const key = mailbox.key as string;
    const entry: IdleEntry = { mailbox, backoffMs: 0, closed: false };
    this.entries.set(key, entry);
    void this.connectLoop(entry);
  }

  private async connectLoop(entry: IdleEntry): Promise<void> {
    const key = entry.mailbox.key as string;
    while (!entry.closed) {
      try {
        const rt = await buildMailboxRuntime(this.ctx, entry.mailbox, key);
        const client = await openConnection(rt, {
          forIdle: true,
          maxIdleTimeMs: IDLE_RENEW_MS,
        });
        entry.client = client;
        entry.backoffMs = 0;

        const folder = entry.mailbox.pollFolder ?? "INBOX";
        await client.mailboxOpen(folder);

        const triggerPoll = () => {
          this.ctx.telemetry
            .track("idle-notification", { mailbox: key })
            .catch(() => {});
          void pollOne(this.ctx, entry.mailbox).catch((err) => {
            this.ctx.logger.error("email-tools: idle-triggered poll failed", {
              mailbox: key,
              message: (err as Error).message,
            });
          });
        };

        client.on("exists", triggerPoll);
        client.on("expunge", triggerPoll);

        await this.ctx.telemetry.track("idle-opened", { mailbox: key });
        this.ctx.logger.info("email-tools: IDLE opened", { mailbox: key, folder });

        await new Promise<void>((resolve) => {
          const onClose = () => {
            client.removeListener("close", onClose);
            client.removeListener("error", onErr);
            resolve();
          };
          const onErr = (err: Error) => {
            this.ctx.logger.warn("email-tools: IDLE socket error", {
              mailbox: key,
              message: err.message,
            });
          };
          client.on("close", onClose);
          client.on("error", onErr);
        });

        await this.ctx.telemetry.track("idle-closed", { mailbox: key });
      } catch (err) {
        await this.ctx.telemetry.track("idle-error", {
          mailbox: key,
          message: String((err as Error).message),
        });
        this.ctx.logger.warn("email-tools: IDLE connection failed", {
          mailbox: key,
          message: (err as Error).message,
        });
      }

      if (entry.closed) break;

      const delay = nextBackoff(entry.backoffMs);
      entry.backoffMs = delay;
      await waitOrAbort(delay, entry);
    }
  }

  private async closeOne(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.closed = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.client) {
      await safeLogout(entry.client);
    }
    this.entries.delete(key);
  }
}

function nextBackoff(prev: number): number {
  const idx = RECONNECT_BACKOFF_MS.indexOf(prev);
  if (idx === -1) return RECONNECT_BACKOFF_MS[0];
  if (idx >= RECONNECT_BACKOFF_MS.length - 1) return RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];
  return RECONNECT_BACKOFF_MS[idx + 1];
}

async function waitOrAbort(ms: number, entry: IdleEntry): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    entry.reconnectTimer = t;
  });
}

function serializeRelevantConfig(config: InstanceConfig): string {
  const keys = (config.mailboxes ?? []).map((m) => ({
    key: m.key,
    pollEnabled: !!m.pollEnabled,
    imapHost: m.imapHost,
    imapPort: m.imapPort,
    imapSecure: m.imapSecure,
    user: m.user,
    pass: m.pass,
    pollFolder: m.pollFolder,
    ingestCompanyId: m.ingestCompanyId,
  }));
  return JSON.stringify(keys);
}

function configChanged(prev: ConfigMailbox, next: ConfigMailbox | undefined): boolean {
  if (!next) return true;
  return (
    prev.imapHost !== next.imapHost ||
    prev.imapPort !== next.imapPort ||
    prev.imapSecure !== next.imapSecure ||
    prev.user !== next.user ||
    prev.pass !== next.pass ||
    prev.pollFolder !== next.pollFolder ||
    prev.pollEnabled !== next.pollEnabled
  );
}
