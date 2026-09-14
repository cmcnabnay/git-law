import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface RepoHeaderState {
  repoName: string | null;
  setRepoName: (name: string | null) => void;
}

const RepoHeaderContext = createContext<RepoHeaderState | null>(null);

export function RepoHeaderProvider({ children }: { children: ReactNode }) {
  const [repoName, setRepoName] = useState<string | null>(null);
  return <RepoHeaderContext.Provider value={{ repoName, setRepoName }}>{children}</RepoHeaderContext.Provider>;
}

export function useRepoHeaderName(): string | null {
  const ctx = useContext(RepoHeaderContext);
  if (!ctx) throw new Error("useRepoHeaderName must be used within a RepoHeaderProvider");
  return ctx.repoName;
}

// Shows `name` as the "Git Law / <name>" breadcrumb for as long as the calling
// page is mounted, reverting to the plain logo when it unmounts.
export function useSetRepoHeaderName(name: string | null) {
  const ctx = useContext(RepoHeaderContext);
  if (!ctx) throw new Error("useSetRepoHeaderName must be used within a RepoHeaderProvider");
  const { setRepoName } = ctx;
  useEffect(() => {
    setRepoName(name);
    return () => setRepoName(null);
  }, [name, setRepoName]);
}
