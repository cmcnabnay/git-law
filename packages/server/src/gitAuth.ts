import type { NextFunction, Request, Response } from "express";
import { reposRepo, participantsRepo, type Repo } from "@gitlaw/core";

export interface AuthedRequest<P = any> extends Request<P> {
  repo?: Repo;
  participantEmail?: string;
}

function parseBasicAuth(header: string | undefined): { email: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return { email: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/**
 * Gates a repo's git smart-HTTP endpoints behind HTTP Basic Auth, checked
 * against that repo's `participants` table. A 401 (rather than 403) with a
 * `WWW-Authenticate` header is required here, not just convention — it's
 * what makes git clients prompt for or retry with credentials instead of
 * just failing outright.
 */
export function requireBasicAuth(req: AuthedRequest<{ repoId: string }>, res: Response, next: NextFunction) {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).end("repo not found\n");

  const creds = parseBasicAuth(req.headers.authorization);
  if (!creds || !participantsRepo.verifyPassword(repo.id, creds.email, creds.password)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Git Law"');
    return res.status(401).end("Authentication required\n");
  }

  req.repo = repo;
  req.participantEmail = creds.email;
  next();
}
