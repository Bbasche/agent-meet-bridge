import { SidecarServer } from "../src/sidecar-server.mjs";

const token = "local-preview";
const server = new SidecarServer({
  sessionToken: token,
  getState: async () => ({
    agentName: "Agent",
    meetingStatus: "joined",
    voiceStatus: "connected",
    runtime: "local",
    mode: "passive",
    codexConnected: true,
    codexThreadId: "preview-thread",
    allowWrites: false,
    agenda: "1. Confirm goals\n2. WordPress plugin and technical questions\n3. Decisions, owners, and next steps",
  }),
  onPrivateMessage: async ({ message }) => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    return {
      message: `I kept this private. Here is the short answer to “${message}”: the Codex bridge is connected and ready to inspect the repository.`,
      threadId: "preview-thread",
      visibility: "private",
    };
  },
  onStop: async () => false,
  onSpeak: async ({ text }) => console.log(`[preview] would speak: ${text}`),
  onAgendaUpdate: async ({ text }) => ({ agenda: text }),
});

const url = await server.listen(Number(process.env.SIDECAR_PREVIEW_PORT ?? 4318));
console.log(`Private sidecar preview: ${url}`);
console.log("Press Ctrl+C to close.");

async function stop() {
  await server.close();
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
