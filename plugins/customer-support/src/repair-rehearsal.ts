import { randomUUID } from "node:crypto";
import { IntakeError } from "./routing.js";
import { diagnosticScript } from "./diagnostic-catalog.js";

/** A controlled write rehearsal; callers cannot supply a directory or payload. */
export function buildRepairRehearsal(id: string = randomUUID()) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new IntakeError(422, "Invalid rehearsal identifier");
  const values = { rehearsalId: id };
  const header = `$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if ($root -notmatch '^[a-zA-Z]:\\\\' -or -not (Test-Path -LiteralPath $root -PathType Container)) { throw 'A local Windows temporary directory is required' }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A redirected temporary directory is not supported by this rehearsal' }
$file = Join-Path $root ('paperclip-support-rehearsal-' + [string]$SupportOptions.rehearsalId + '.txt')
$marker = 'Paperclip support write rehearsal ' + [string]$SupportOptions.rehearsalId
`;
  const write = `if (Test-Path -LiteralPath $file) { throw 'Rehearsal file already exists; no existing file will be overwritten' }
$stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $bytes = [Text.Encoding]::UTF8.GetBytes($marker); $stream.Write($bytes,0,$bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
`;
  const inspect = `if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Rehearsal file identity changed' }
if ([IO.File]::ReadAllText($file,[Text.Encoding]::UTF8) -cne $marker) { throw 'Rehearsal content changed; no file will be removed' }
`;
  const remove = `Remove-Item -LiteralPath $file -ErrorAction Stop
if (Test-Path -LiteralPath $file) { throw 'Rehearsal cleanup was not verified' }
`;
  return { rehearsalId: id, script: diagnosticScript(header + write, values),
    verificationScript: diagnosticScript(header + `if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The rehearsal write was not observed' }\n` + inspect + remove, values),
    recoveryScript: diagnosticScript(header + "if (-not (Test-Path -LiteralPath $file)) { return }\n" + inspect + remove, values),
    cleanupVerificationScript: diagnosticScript(header + "if (Test-Path -LiteralPath $file) { throw 'Rehearsal file is still present' }\n", values),
    recoveryNotes: "Writes one newly created marker file in the remote support account's local temporary directory; no existing file is overwritten. Verification checks its exact content, removes that same file and confirms absence. If interrupted, inspect the original case and use the separately confirmed recovery repair; it refuses a redirected or changed file. No service, printer, settings, jobs or staff document is changed. This tests remote write/verification/cleanup, not every administrator operation or a real issue's resolution." };
}
