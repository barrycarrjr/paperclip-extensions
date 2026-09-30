export type Source = "slack" | "helpscout" | "email" | "whmcs" | "other";

export interface Connection {
  id: string;
  source: Source;
  externalAccountId: string;
  ingestAgentId: string;
  deliveryPluginId?: string;
  outboundAccount?: string;
  botTokenRef?: string;
  pollingEnabled?: boolean;
  allowedCompanies: string[];
  routes: { externalRouteId: string; companyId: string }[];
}

export interface Config {
  dailySummaries?: { companyId: string; connectionId: string; channelId: string; timezone: string; sendAt: string; enabled: boolean }[];
  ticketPolicies?: TicketPolicy[];
  connections?: Connection[];
  softwareRoutes?: SoftwareRoute[];
  remoteAccessProfiles?: RemoteAccessProfile[];
  discoveryNetworks?: { id: string; companyId: string; cidr: string }[];
}

export interface TicketPolicy {
  companyId: string;
  agentId: string;
  enabled: boolean;
  diagnostics: string[];
  allowThreadUpdates: boolean;
}

export interface RemoteAccessProfile {
  id: string;
  companyId: string;
  credentialUser: string;
  passwordRef: string;
  targets?: {
    address: string;
    transport: "Auto" | "WinRMHttps" | "WinRMHttp" | "Wmi";
    allowProcessExecutionPolicyBypass?: boolean;
  }[];
  scopes?: {
    kind: "dns_suffix" | "ipv4_cidr";
    value: string;
    transport: "Auto" | "WinRMHttps" | "WinRMHttp" | "Wmi";
    allowProcessExecutionPolicyBypass?: boolean;
  }[];
}

export interface SoftwareRoute {
  id: string;
  reportingCompanyId: string;
  productName: string;
  destinationKind: "email" | "jira_form";
  destination: string;
  outboundAccount?: string;
}

export interface IncomingMessage {
  companyId: string;
  connectionId: string;
  externalAccountId: string;
  externalRouteId: string;
  externalConversationId: string;
  externalMessageId: string;
  title: string;
  body: string;
  authorKind: "customer" | "reseller" | "staff" | "bot";
  occurredAt: string;
  externalUrl?: string;
  authorExternalId?: string;
  attachments?: AttachmentRef[];
}

export interface AttachmentRef {
  id: string;
  name: string;
  mimeType?: string;
  permalink?: string;
}

export class IntakeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const authorKinds = new Set(["customer", "reseller", "staff", "bot"]);

function requiredString(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new IntakeError(422, `${key} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

export function parseMessage(body: unknown): IncomingMessage {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new IntakeError(422, "JSON object required");
  const record = body as Record<string, unknown>;
  const companyId = requiredString(record, "companyId", 36);
  if (!uuid.test(companyId)) throw new IntakeError(422, "companyId must be a UUID");
  const authorKind = requiredString(record, "authorKind", 20);
  if (!authorKinds.has(authorKind)) throw new IntakeError(422, "authorKind is invalid");
  const occurredAt = requiredString(record, "occurredAt", 40);
  if (!Number.isFinite(Date.parse(occurredAt))) throw new IntakeError(422, "occurredAt must be a timestamp");
  const externalUrl = record.externalUrl === undefined ? undefined : requiredString(record, "externalUrl", 2000);
  if (externalUrl && !/^https:\/\//i.test(externalUrl)) throw new IntakeError(422, "externalUrl must use HTTPS");
  const authorExternalId = record.authorExternalId === undefined ? undefined : requiredString(record, "authorExternalId", 200);
  const rawAttachments = record.attachments;
  if (rawAttachments !== undefined && (!Array.isArray(rawAttachments) || rawAttachments.length > 20)) {
    throw new IntakeError(422, "attachments must be an array of at most 20 references");
  }
  const attachments = (rawAttachments as unknown[] | undefined)?.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new IntakeError(422, "Invalid attachment reference");
    const value = item as Record<string, unknown>;
    const permalink = value.permalink === undefined ? undefined : requiredString(value, "permalink", 2000);
    if (permalink && !/^https:\/\//i.test(permalink)) throw new IntakeError(422, "Attachment permalink must use HTTPS");
    return {
      id: requiredString(value, "id", 200),
      name: requiredString(value, "name", 500),
      mimeType: value.mimeType === undefined ? undefined : requiredString(value, "mimeType", 200),
      permalink,
    };
  });
  return {
    companyId,
    connectionId: requiredString(record, "connectionId", 120),
    externalAccountId: requiredString(record, "externalAccountId", 200),
    externalRouteId: requiredString(record, "externalRouteId", 200),
    externalConversationId: requiredString(record, "externalConversationId", 250),
    externalMessageId: requiredString(record, "externalMessageId", 250),
    title: requiredString(record, "title", 300),
    body: requiredString(record, "body", 50000),
    authorKind: authorKind as IncomingMessage["authorKind"],
    occurredAt: new Date(occurredAt).toISOString(),
    externalUrl,
    authorExternalId,
    attachments,
  };
}

export function resolveConnection(config: Config, message: IncomingMessage): Connection {
  const connections = Array.isArray(config.connections) ? config.connections : [];
  const matches = connections.filter((item) => item.id === message.connectionId && item.externalAccountId === message.externalAccountId);
  if (matches.length !== 1) throw new IntakeError(403, "Support connection is not configured uniquely");
  const connection = matches[0]!;
  if (!Array.isArray(connection.allowedCompanies) || !connection.allowedCompanies.includes(message.companyId)) {
    throw new IntakeError(403, "Connection is not allowed for this company");
  }
  const routes = Array.isArray(connection.routes) ? connection.routes : [];
  const routeMatches = routes.filter((route) => route.externalRouteId === message.externalRouteId);
  if (routeMatches.length !== 1 || routeMatches[0]!.companyId !== message.companyId) {
    throw new IntakeError(403, "Support route does not map uniquely to this company");
  }
  return connection;
}

export function companyHasConnection(config: Config, companyId: string | null): boolean {
  if (!companyId) return false;
  return (config.connections ?? []).some((connection) =>
    connection.allowedCompanies?.includes(companyId) && connection.routes?.some((route) => route.companyId === companyId),
  );
}

/** Direct Clippy support needs a remote access group, not an external help desk route. */
export function companyHasSupport(config: Config, companyId: string | null): boolean {
  return !!companyId && (companyHasConnection(config, companyId) ||
    (config.discoveryNetworks ?? []).some((network) => network.companyId === companyId) ||
    (config.remoteAccessProfiles ?? []).some((profile) => profile.companyId === companyId));
}
