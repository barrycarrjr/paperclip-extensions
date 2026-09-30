import { randomInt } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// RFC 8010/8011: this client sends only Get-Printer-Attributes (0x000b).
// It cannot submit jobs, restart a device, alter settings or follow a URI returned
// by a printer. Keep requested attributes free of document/job/user information.
export const printerAttributes = ["printer-name", "printer-make-and-model", "printer-uuid", "printer-state",
  "printer-state-reasons", "printer-is-accepting-jobs", "queued-job-count", "marker-names", "marker-levels"];
const maxBody = 128 * 1024;
export interface PrinterEndpoint { address: string; path: string; tls: boolean; port: number }
function attribute(tag: number, name: string, value: string) {
  const key = Buffer.from(name); const data = Buffer.from(value);
  const header = Buffer.alloc(3); header[0] = tag; header.writeUInt16BE(key.length, 1);
  const size = Buffer.alloc(2); size.writeUInt16BE(data.length);
  return Buffer.concat([header, key, size, data]);
}
export function printerRequest(endpoint: PrinterEndpoint, requestId: number) {
  const header = Buffer.alloc(9); header[0] = 1; header[1] = 1; header.writeUInt16BE(0x000b, 2); header.writeInt32BE(requestId, 4); header[8] = 1;
  return Buffer.concat([header, attribute(0x47, "attributes-charset", "utf-8"), attribute(0x48, "attributes-natural-language", "en"),
    attribute(0x45, "printer-uri", `${endpoint.tls ? "ipps" : "ipp"}://${endpoint.address}:${endpoint.port}${endpoint.path}`),
    ...printerAttributes.map((name, index) => attribute(0x44, index ? "" : "requested-attributes", name)), Buffer.from([3])]);
}
type AttributeValue = string | number | boolean | null;
export function parsePrinterResponse(body: Buffer, requestId: number) {
  if (body.length < 9 || body.length > maxBody || ![1, 2].includes(body[0]!) || body.readInt32BE(4) !== requestId) throw new Error("Invalid IPP response header");
  const statusCode = body.readUInt16BE(2);
  if (statusCode > 0x00ff) return { statusCode, attributes: {} as Record<string, AttributeValue[]> };
  const attributes: Record<string, AttributeValue[]> = {}; let offset = 8; let group = 0; let name = ""; let entries = 0; let ended = false;
  while (offset < body.length) {
    const tag = body[offset++]!;
    if (tag === 3) { ended = true; break; }
    if (tag <= 15) { if (![1, 2, 4, 5].includes(tag)) throw new Error("Invalid IPP group"); group = tag; name = ""; continue; }
    if (++entries > 2000 || offset + 2 > body.length) throw new Error("Invalid IPP attribute count or length");
    const keyLength = body.readUInt16BE(offset); offset += 2;
    if (keyLength > 255 || offset + keyLength + 2 > body.length) throw new Error("Invalid IPP name length");
    if (keyLength) name = body.subarray(offset, offset + keyLength).toString("utf8");
    else if (!name) throw new Error("IPP continuation without a name");
    offset += keyLength; const length = body.readUInt16BE(offset); offset += 2;
    if (offset + length > body.length) throw new Error("Truncated IPP value");
    const value = body.subarray(offset, offset + length); offset += length;
    if (name === "attributes-charset" && group === 1 && !["utf-8", "us-ascii"].includes(value.toString().toLowerCase())) throw new Error("Unsupported IPP charset");
    if (group !== 4 || !printerAttributes.includes(name)) continue;
    let decoded: AttributeValue;
    if (tag === 0x21 || tag === 0x23) { if (length !== 4) throw new Error("Invalid IPP integer"); decoded = value.readInt32BE(); }
    else if (tag === 0x22) { if (length !== 1 || value[0]! > 1) throw new Error("Invalid IPP boolean"); decoded = value[0] === 1; }
    else if ([0x41, 0x42, 0x44, 0x45].includes(tag)) decoded = value.toString("utf8").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
    else if (tag >= 0x10 && tag <= 0x1f && length === 0) decoded = null;
    else continue;
    const values = attributes[name] ??= [];
    if (values.length >= 64) throw new Error("Too many IPP attribute values");
    values.push(decoded);
  }
  if (!ended || offset !== body.length) throw new Error("Invalid IPP response termination");
  return { statusCode, attributes };
}
export async function readPrinterAttributes(endpoint: PrinterEndpoint, timeoutMs = 10_000) {
  const requestId = randomInt(1, 2147483647); const body = printerRequest(endpoint, requestId);
  return new Promise<ReturnType<typeof parsePrinterResponse>>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error, value?: ReturnType<typeof parsePrinterResponse>) => {
      if (settled) return; settled = true; clearTimeout(timer); req.destroy();
      error ? reject(error) : resolve(value!);
    };
    const request = endpoint.tls ? httpsRequest : httpRequest;
    // Numeric IP only, direct connection, no ambient proxy/credentials and no
    // redirect handling. HTTPS keeps normal certificate and hostname checks.
    const req = request({ hostname: endpoint.address, port: endpoint.port, path: endpoint.path, method: "POST", agent: false,
      headers: { "content-type": "application/ipp", "content-length": body.length, accept: "application/ipp" } }, response => {
      if (response.statusCode !== 200 || response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/ipp") {
        response.destroy(); return done(new Error("IPP HTTP response rejected"));
      }
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBody) { response.destroy(); done(new Error("IPP body limit exceeded")); } else chunks.push(chunk); });
      response.on("error", () => done(new Error("IPP response interrupted")));
      response.on("end", () => { try { done(undefined, parsePrinterResponse(Buffer.concat(chunks), requestId)); } catch { done(new Error("Invalid IPP response")); } });
    });
    const timer = setTimeout(() => done(new Error("IPP deadline exceeded")), timeoutMs);
    req.on("error", () => done(new Error("IPP connection unavailable"))); req.end(body);
  });
}
