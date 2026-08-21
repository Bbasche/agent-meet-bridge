import test from "node:test";
import assert from "node:assert/strict";
import { SidecarServer } from "../src/sidecar-server.mjs";

test("private sidecar requires its per-call session token", async (context) => {
  const spoken = [];
  const agendas = [];
  const server = new SidecarServer({
    sessionToken: "test-session",
    getState: async () => ({ agentName: "Test employee", meetingStatus: "joined" }),
    onPrivateMessage: async ({ message, desiredAction }) => ({ message, desiredAction }),
    onStop: async () => true,
    onSpeak: async ({ text }) => spoken.push(text),
    onAgendaUpdate: async ({ text }) => {
      agendas.push(text);
      return { agenda: text };
    },
  });
  const url = await server.listen(0);
  context.after(() => server.close());
  const origin = new URL(url).origin;
  assert.equal(new URL(url).search, "");
  assert.equal(new URL(url).hash, "#session=test-session");

  const unauthorized = await fetch(`${origin}/api/state`);
  assert.equal(unauthorized.status, 401);

  const pageWithoutToken = await fetch(origin);
  assert.equal(pageWithoutToken.status, 200);
  assert.equal(pageWithoutToken.headers.get("referrer-policy"), "no-referrer");
  assert.equal(pageWithoutToken.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(pageWithoutToken.headers.get("x-frame-options"), "DENY");

  const headers = {
    "Content-Type": "application/json",
    "x-meeting-agent-session": "test-session",
  };
  const state = await fetch(`${origin}/api/state`, { headers });
  assert.deepEqual(await state.json(), { agentName: "Test employee", meetingStatus: "joined" });

  const privateReply = await fetch(`${origin}/api/private/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "Check the repository", desired_action: "prototype" }),
  });
  assert.deepEqual(await privateReply.json(), {
    message: "Check the repository",
    desiredAction: "prototype",
  });

  const history = await fetch(`${origin}/api/private/messages`, { headers });
  const historyBody = await history.json();
  assert.equal(historyBody.messages.length, 2);
  assert.deepEqual(
    historyBody.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "Check the repository" },
      { role: "assistant", text: "Check the repository" },
    ],
  );
  assert.ok(historyBody.messages.every(({ timestamp }) => !Number.isNaN(Date.parse(timestamp))));

  const speak = await fetch(`${origin}/api/speak`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Share this explicitly" }),
  });
  assert.equal(speak.status, 202);
  assert.deepEqual(spoken, ["Share this explicitly"]);

  const agenda = await fetch(`${origin}/api/agenda`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "1. WordPress plugin\n2. Next steps" }),
  });
  assert.equal(agenda.status, 200);
  assert.deepEqual(agendas, ["1. WordPress plugin\n2. Next steps"]);

  const stop = await fetch(`${origin}/api/private/stop`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(stop.status, 202);

  const wrongContentType = await fetch(`${origin}/api/private/messages`, {
    method: "POST",
    headers: { "x-meeting-agent-session": "test-session" },
    body: JSON.stringify({ message: "No content type" }),
  });
  assert.equal(wrongContentType.status, 415);

  const malformed = await fetch(`${origin}/api/private/messages`, {
    method: "POST",
    headers,
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const oversized = await fetch(`${origin}/api/private/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "x".repeat(33_000) }),
  });
  assert.equal(oversized.status, 413);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Nothing is heard in the room/);
});
