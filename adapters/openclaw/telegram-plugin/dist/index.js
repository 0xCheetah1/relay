import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { connect } from "node:net";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OWNER_ID = String(process.env.RELAY_OPENCLAW_TELEGRAM_OWNER ?? "");
const SOCKET = process.env.RELAY_OPENCLAW_APPROVAL_SOCKET ?? join(homedir(), ".config", "relay", "openclaw-test.sock");

function log(message) {
  try { appendFileSync("/tmp/relay-telegram.log", `${new Date().toISOString()} ${message}\n`); } catch {}
}

function sendDecision(request) {
  return new Promise((resolve) => {
    const socket = connect(SOCKET);
    let output = "";
    const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, error: "timeout" }); }, 3000);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => { output += chunk; if (output.length > 2048) socket.destroy(); });
    socket.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(output)); } catch { resolve({ ok: false, error: "bad_reply" }); } });
    socket.on("error", () => { clearTimeout(timer); resolve({ ok: false, error: "socket" }); });
  });
}

export default definePluginEntry({
  id: "relay-telegram",
  name: "RELAY Telegram",
  description: "Incoming RELAY call approve/reject buttons for the OpenClaw Telegram bot.",
  register(api) {
    log(`register() called; api has registerInteractiveHandler = ${typeof api.registerInteractiveHandler}`);
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "rc",
      handler: async (ctx) => {
        log(`handler fired; data=${ctx.callback?.data} payload=${ctx.callback?.payload} sender=${ctx.senderId}`);
        try {
          if (ctx.senderId !== OWNER_ID && !ctx.auth?.isAuthorizedSender) {
            await ctx.respond.editMessage({ text: "Only the owner can answer this call." });
            return { handled: true };
          }
          const payload = ctx.callback?.payload ?? "";
          const [action, callId, code] = payload.split(":");
          const accepted = action === "a";
          if ((action !== "a" && action !== "r") || !callId || !code) {
            await ctx.respond.editMessage({ text: "Invalid call." });
            return { handled: true };
          }
          const result = await sendDecision({ action: accepted ? "accept" : "reject", callId, code });
          if (!result.ok) {
            await ctx.respond.editMessage({ text: "⏳ Call expired or already answered." });
            return { handled: true };
          }
          await ctx.respond.editMessage({ text: `${accepted ? "✅ Call accepted" : "❌ Call rejected"} — ${callId}` });
          return { handled: true };
        } catch (error) {
          log(`handler error: ${error?.message}`);
          return { handled: true };
        }
      },
    });
  },
});
