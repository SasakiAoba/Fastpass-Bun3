export type StartupBuildEnvironment = {
  mode: string;
  cloudflarePages?: string;
  cloudflarePagesBranch?: string;
};

export function resolveAutoStartDeveloperMode({
  mode,
  cloudflarePages,
  cloudflarePagesBranch,
}: StartupBuildEnvironment): boolean {
  if (cloudflarePages === "1" && cloudflarePagesBranch === "main") {
    return false;
  }

  if (cloudflarePages === "1" && cloudflarePagesBranch) {
    return true;
  }

  return mode === "preview";
}
