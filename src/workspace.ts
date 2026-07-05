import type { Request } from "express";

// Workspace isolation: each user (me + a friend) gets their own slice of the
// shared tables, keyed by a `workspace` column. The client proves which
// workspace it belongs to by sending a secret in the `x-workspace-key` header;
// this module turns that secret into a workspace name.
//
// Configure via the WORKSPACE_KEYS env var — a comma-separated list of
// `secret:workspace` pairs, e.g.
//   WORKSPACE_KEYS="mySecret123:default,palSecret456:friend"
//
// Pre-existing accounts (created before this column existed) default to the
// "default" workspace, so map your own key to `default` to keep owning them.
// A request with no key — or an unrecognised key — falls back to "default",
// matching the app's previous no-auth behaviour rather than locking anyone out.
export const WORKSPACE_HEADER = "x-workspace-key";
export const DEFAULT_WORKSPACE = "default";

function parseKeyMap(): Map<string, string> {
  const raw = process.env.WORKSPACE_KEYS || "";
  const map = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [key, workspace] = pair.split(":").map((s) => s.trim());
    if (key && workspace) map.set(key, workspace);
  }
  return map;
}

export function resolveWorkspace(key: string | undefined | null): string {
  if (!key) return DEFAULT_WORKSPACE;
  return parseKeyMap().get(key.trim()) || DEFAULT_WORKSPACE;
}

// Resolve the caller's workspace from the request header. Use this in every
// handler that reads or writes workspace-scoped data.
export function getWorkspace(req: Request): string {
  return resolveWorkspace(req.header(WORKSPACE_HEADER));
}
