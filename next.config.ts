import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";

const REMOTE_BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;

export function resolveBuildId(
  env: Record<string, string | undefined> = process.env,
): string {
  const remoteBuildId = env.EXPED_BUILD_ID
    || env.GITHUB_SHA
    || env.VERCEL_GIT_COMMIT_SHA;

  if (!remoteBuildId) return `local-${randomUUID()}`;
  if (!REMOTE_BUILD_ID.test(remoteBuildId)) {
    throw new Error("BUILD_ID remoto invalido");
  }
  return remoteBuildId;
}

const nextConfig: NextConfig = {
  output: "standalone",
  generateBuildId: async () => resolveBuildId(),
};

export default nextConfig;
