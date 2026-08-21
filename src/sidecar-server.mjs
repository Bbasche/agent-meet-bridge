import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sidecar");
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

async function readJson(request, maxBytes = 32_768) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type must be application/json");
    error.statusCode = 415;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function hasSession(request, expectedToken) {
  const received = request.headers["x-meeting-agent-session"] ?? "";
  const a = Buffer.from(String(received));
  const b = Buffer.from(expectedToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class SidecarServer {
  constructor({ sessionToken, getState, onPrivateMessage, onStop, onSpeak, onAgendaUpdate, logger = console }) {
    this.sessionToken = sessionToken;
    this.getState = getState;
    this.onPrivateMessage = onPrivateMessage;
    this.onStop = onStop;
    this.onSpeak = onSpeak;
    this.onAgendaUpdate = onAgendaUpdate;
    this.logger = logger;
    this.server = null;
    this.privateMessages = [];
  }

  async listen(port = 4317) {
    this.server = http.createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        const status = Number(error.statusCode) || 500;
        if (status >= 500) this.logger.error?.(error);
        if (!response.headersSent) {
          sendJson(response, status, {
            error: status >= 500 ? "The private sidecar failed" : error.message,
          });
        }
        else response.end();
      });
    });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 30_000;
    const bind = (candidatePort) => new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(candidatePort, "127.0.0.1", resolve);
    });
    try {
      await bind(port);
    } catch (error) {
      if (error.code !== "EADDRINUSE" || port === 0) throw error;
      this.logger.warn?.(`[sidecar] port ${port} is busy; using an available local port`);
      await bind(0);
    }
    const address = this.server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    // Keep the bearer token out of HTTP request targets, logs, and referrers. The
    // sidecar reads it from the URL fragment once, stores it per-tab, then clears it.
    return `http://127.0.0.1:${actualPort}/#session=${encodeURIComponent(this.sessionToken)}`;
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  appendPrivateMessage({ role = "assistant", text, timestamp = new Date().toISOString() }) {
    const clean = String(text ?? "").trim();
    if (!clean) return false;
    this.privateMessages.push({
      role: role === "user" ? "user" : "assistant",
      text: clean.length > 40_000 ? `${clean.slice(0, 40_000)}\n\n[Output truncated]` : clean,
      timestamp,
    });
    if (this.privateMessages.length > 200) {
      this.privateMessages.splice(0, this.privateMessages.length - 200);
    }
    return true;
  }

  async #handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");

    if (url.pathname.startsWith("/api/")) {
      if (!hasSession(request, this.sessionToken)) {
        sendJson(response, 401, { error: "Invalid sidecar session" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, await this.getState());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/private/messages") {
        sendJson(response, 200, { messages: this.privateMessages });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/private/messages") {
        const body = await readJson(request);
        const message = String(body.message ?? "").trim();
        if (!message || message.length > 8_000) {
          sendJson(response, 400, { error: "Message must be between 1 and 8,000 characters" });
          return;
        }
        const desiredAction = body.desired_action === "prototype" ? "prototype" : "analyze";
        this.appendPrivateMessage({ role: "user", text: message });
        const result = await this.onPrivateMessage({ message, desiredAction });
        if (result?.message) {
          this.appendPrivateMessage({
            role: "assistant",
            text: result.message,
          });
        }
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/speak") {
        const body = await readJson(request);
        const text = String(body.text ?? "").trim();
        if (!text || text.length > 2_000) {
          sendJson(response, 400, { error: "Shared response must be between 1 and 2,000 characters" });
          return;
        }
        await this.onSpeak({ text });
        sendJson(response, 202, { ok: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/agenda") {
        const body = await readJson(request);
        const text = String(body.text ?? "").trim();
        if (!text || text.length > 16_000) {
          sendJson(response, 400, { error: "Agenda must be between 1 and 16,000 characters" });
          return;
        }
        if (!this.onAgendaUpdate) {
          sendJson(response, 409, { error: "Agenda editing is unavailable" });
          return;
        }
        sendJson(response, 200, await this.onAgendaUpdate({ text }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/private/stop") {
        const interrupted = await this.onStop();
        sendJson(
          response,
          interrupted ? 202 : 409,
          interrupted ? { ok: true } : { error: "No private turn is running" },
        );
        return;
      }
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.resolve(SIDECAR_DIR, relativePath);
    if (!filePath.startsWith(`${SIDECAR_DIR}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES.get(path.extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  }
}
