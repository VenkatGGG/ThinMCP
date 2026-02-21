import type { SourceServerConfig } from "./types.js";

export function getServerEndpoint(server: SourceServerConfig): string {
  if (server.transport === "http") {
    return server.url;
  }

  return `stdio://${server.command}`;
}
