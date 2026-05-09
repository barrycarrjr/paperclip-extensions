import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
} from "@paperclipai/plugin-sdk";

interface OperatorPhoneRecord {
  e164: string;
  verifiedAt: string;
}

function stateKey(userId: string): string {
  return `assistants:operator-phone:${userId}`;
}

export async function handleOperatorPhoneApi(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse | null> {
  if (input.routeKey === "operator-phone.get") {
    return readOperatorPhone(ctx, input);
  }
  if (input.routeKey === "operator-phone.set") {
    return setOperatorPhone(ctx, input);
  }
  return null;
}

function userIdFor(input: PluginApiRequestInput): string | null {
  if (input.actor.actorType === "user" && input.actor.actorId) return input.actor.actorId;
  if (input.actor.userId) return input.actor.userId;
  return null;
}

async function readOperatorPhone(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const userId = userIdFor(input);
  if (!userId) {
    return { status: 401, body: { error: "Operator-phone routes require a user actor." } };
  }
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: stateKey(userId),
  });
  if (!value || typeof value !== "object") {
    return { status: 200, body: { e164: null, verifiedAt: null } };
  }
  const record = value as Partial<OperatorPhoneRecord>;
  return {
    status: 200,
    body: {
      e164: typeof record.e164 === "string" ? record.e164 : null,
      verifiedAt: typeof record.verifiedAt === "string" ? record.verifiedAt : null,
    },
  };
}

async function setOperatorPhone(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const userId = userIdFor(input);
  if (!userId) {
    return { status: 401, body: { error: "Operator-phone routes require a user actor." } };
  }
  const body = (input.body && typeof input.body === "object" && !Array.isArray(input.body))
    ? (input.body as Record<string, unknown>)
    : {};
  const e164Raw = typeof body.e164 === "string" ? body.e164.trim() : "";
  if (!/^\+[1-9]\d{6,14}$/.test(e164Raw)) {
    return { status: 400, body: { error: "Phone must be in E.164 format, e.g. +15551234567." } };
  }
  const record: OperatorPhoneRecord = {
    e164: e164Raw,
    verifiedAt: new Date().toISOString(),
  };
  await ctx.state.set(
    { scopeKind: "instance", stateKey: stateKey(userId) },
    record,
  );
  return { status: 200, body: record };
}
