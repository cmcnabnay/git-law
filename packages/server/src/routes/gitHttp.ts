/// <reference path="../types/git-http-backend.d.ts" />
import { Router } from "express";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import backend from "git-http-backend";
import { requireBasicAuth, type AuthedRequest } from "../gitAuth.js";

export const gitHttpRouter = Router();

/**
 * Serves every bare repo over git's smart HTTP protocol, so `git clone` /
 * `fetch` / `push` work from any machine against
 * `http(s)://<host>/repos/<repoId>.git`, not just from local filesystem
 * paths. `git-http-backend` parses the pkt-line request framing and hands
 * back which git subprocess to run (git-upload-pack for fetch/clone,
 * git-receive-pack for push, run with `--stateless-rpc`); we just spawn the
 * real `git` binary and pipe its stdio through the stream it gives us —
 * this route never re-implements any git wire-protocol logic itself.
 *
 * Mounted ahead of `express.json()` in app.ts, and safe even if it weren't:
 * body-parser only inspects requests whose Content-Type is
 * `application/json`, and git's requests use
 * `application/x-git-<service>-request`, so the raw body stream is never
 * touched before it gets here.
 */
gitHttpRouter.all("/:repoId.git/*", requireBasicAuth, (req: AuthedRequest<{ repoId: string }>, res) => {
  const repo = req.repo!;

  const contentEncoding = req.headers["content-encoding"];
  const reqStream = contentEncoding === "gzip" ? req.pipe(zlib.createGunzip()) : req;

  reqStream
    .pipe(
      backend(req.url, (err, service) => {
        if (err) {
          res.statusCode = 500;
          return res.end(String(err));
        }
        res.setHeader("content-type", service.type);
        const proc = spawn(service.cmd, service.args.concat(repo.bare_path));
        proc.stderr.on("data", (chunk: Buffer) => {
          console.error(`gitlaw: ${service.cmd} (${repo.id}): ${chunk.toString().trim()}`);
        });
        proc.stdout.pipe(service.createStream()).pipe(proc.stdin);
      })
    )
    .pipe(res);
});
