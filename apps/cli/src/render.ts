/**
 * Pure rendering layer: turns SDK values into plain `RenderedLine` records the
 * I/O adapter (or a test) can print/assert without any ANSI or PTY. Keeping
 * `RenderedLine` a data value — not a pre-coloured string — is what makes the
 * whole command surface testable against `CliApp.handleInput`.
 */

/** The category of a rendered line — lets an adapter colour by kind and tests assert on it. */
export type RenderKind = "message" | "system" | "warn" | "connection" | "info" | "error";

/** One line of output. `ts` is the wall-clock time it was produced (for ordering/snapshotting). */
export interface RenderedLine {
  kind: RenderKind;
  text: string;
  ts: number;
}

/** Where async, non-command output (incoming messages, system events, connection changes) is pushed. */
export type OutputSink = (lines: RenderedLine[]) => void;

/** `HH:MM` (24h, local) for a millisecond epoch. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** `YYYY-MM-DD` (local) for a join date. */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Groups a hex identity-key fingerprint into space-separated quads for readable
 * out-of-band comparison (`abcdef0123456789` → `abcd ef01 2345 6789`). The
 * ungrouped hex is exactly the crypto-layer material
 * (`sha256(identityKey).slice(0,16)`); grouping only adds spaces, so stripping
 * them recovers it verbatim (the fingerprint-parity invariant).
 */
export function formatFingerprint(fingerprint: string): string {
  if (fingerprint.length === 0) return "(no key on file)";
  return (fingerprint.match(/.{1,4}/g) ?? [fingerprint]).join(" ");
}

/** Short, stable display token for a userId when no username is known. */
export function shortUserId(userId: string): string {
  return userId.length > 8 ? userId.slice(0, 8) : userId;
}

/** Convenience constructor keeping every producer on the same `{kind,text,ts}` shape. */
export function line(kind: RenderKind, text: string, ts: number): RenderedLine {
  return { kind, text, ts };
}
