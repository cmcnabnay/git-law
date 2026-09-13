declare module "git-http-backend" {
  import type { Duplex } from "node:stream";

  export interface GitService {
    cmd: "git-upload-pack" | "git-receive-pack";
    args: string[];
    action: "info" | "push" | "pull" | "clone" | "tag";
    type: string;
    fields: Record<string, string | boolean | undefined>;
    createStream(): Duplex;
  }

  function backend(url: string, cb?: (err: Error | null, service: GitService) => void): Duplex;
  export default backend;
}
