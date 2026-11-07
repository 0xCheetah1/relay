"""RELAY notifications and approval buttons for an already-connected Hermes Telegram bot."""

import asyncio
import html
import json
import logging
import os
import re
import time
from pathlib import Path

log = logging.getLogger(__name__)
_CALL_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_CODE = re.compile(r"^[0-9a-f]{8}$")
_started = False
_PENDING: dict[str, dict] = {}


def _paths():
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    relay_home = Path(os.environ.get("RELAY_HOME", Path.home() / ".config" / "relay"))
    approval = os.environ.get("RELAY_APPROVAL_SOCKET")
    if not approval:
        profile = os.environ.get("RELAY_PROFILE", "default")
        approval = str(relay_home / f"{profile}.sock")
    return home / "config.yaml", relay_home / "telegram.sock", Path(approval)


_HOME_CHANNEL = re.compile(r"^\s*TELEGRAM_HOME_CHANNEL\s*:\s*(\d+)\s*$", re.MULTILINE)


def _owner_chat_id():
    config, _, _ = _paths()
    text = config.read_text(encoding="utf-8")
    match = _HOME_CHANNEL.search(text)
    if not match:
        raise ValueError("RELAY Telegram owner must be a top-level positive DM chat ID")
    return int(match.group(1))


async def _send_decision(call_id, code, action):
    _, _, approval_path = _paths()
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(str(approval_path)), timeout=2)
    try:
        writer.write((json.dumps({"action": action, "callId": call_id, "code": code}) + "\n").encode())
        await writer.drain()
        response = await asyncio.wait_for(reader.readline(), timeout=2)
        return json.loads(response)
    finally:
        writer.close()
        await writer.wait_closed()


def register(ctx):
    def wire(application, adapter):
        global _started
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        from telegram.ext import CallbackQueryHandler

        async def on_button(update, context):
            query = update.callback_query
            if not query or not query.data or not query.message or not query.from_user:
                return
            try:
                owner = _owner_chat_id()
                if query.from_user.id != owner or query.message.chat_id != owner or query.message.chat.type != "private":
                    await query.answer("Only the owner can answer this call", show_alert=True)
                    return
                _, action, call_id, code = query.data.split(":", 3)
                if not _CALL_ID.fullmatch(call_id) or not _CODE.fullmatch(code):
                    await query.answer("Invalid call", show_alert=True)
                    return
                result = await _send_decision(call_id, code, "accept" if action == "a" else "reject")
                if not result.get("ok"):
                    await query.answer("Call expired or already answered", show_alert=True)
                    try:
                        await query.edit_message_text("⏳ <b>Call expired</b> — no longer available.",
                                                      parse_mode="HTML", reply_markup=None)
                    except Exception:
                        pass
                    return
                accepted = action == "a"
                pending = _PENDING.pop(call_id, None)
                alias = pending.get("alias") if pending else html.escape("unknown agent")
                status = "✅ <b>Call accepted</b>" if accepted else "❌ <b>Call rejected</b>"
                await query.answer("Accepted" if accepted else "Rejected")
                await query.edit_message_text(f"{status} — from <b>{alias}</b>\n\n<code>{call_id}</code>",
                                              parse_mode="HTML", reply_markup=None)
            except Exception:
                log.exception("RELAY Telegram button failed")
                await query.answer("Could not answer call", show_alert=True)

        application.add_handler(CallbackQueryHandler(on_button, pattern=r"^rc:[ar]:[0-9a-f-]{36}:[0-9a-f]{8}$"))

        async def serve():
            _, path, _ = _paths()
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if path.exists():
                try:
                    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(str(path)), timeout=1)
                    writer.close()
                    await writer.wait_closed()
                    return  # An existing live handler owns the socket.
                except (OSError, asyncio.TimeoutError):
                    path.unlink()

            async def handle(reader, writer):
                try:
                    raw = await asyncio.wait_for(reader.readline(), timeout=2)
                    if len(raw) > 8192:
                        raise ValueError("Oversized RELAY call")
                    call = json.loads(raw)
                    call_id, code = call["callId"], call["code"]
                    if not _CALL_ID.fullmatch(call_id) or not _CODE.fullmatch(code):
                        raise ValueError("Invalid call identity")
                    owner = _owner_chat_id()
                    alias = html.escape(str(call.get("alias", call["from"]))[:80])
                    intent = html.escape(str(call["intent"])[:160])
                    task = html.escape(str(call["task"])[:1400])
                    trusted = bool(call.get("trusted", True))
                    warning = "" if trusted else "⚠ <b>Unknown caller</b> — not in your phonebook. Accepting answers with minimal context.\n\n"
                    text = (
                        "📞 <b>Incoming RELAY call</b>\n\n"
                        f"From: <b>{alias}</b>\n"
                        + warning
                        + f"Intent: <i>{intent}</i>\n\n"
                        "<b>Task</b>\n"
                        f"<i>{task}</i>\n\n"
                        "⏳ Answer within 30 seconds.\n"
                        f"<code>{call_id}</code>\n\n"
                        f"Or reply: <code>accept {call_id} {code}</code> / <code>reject {call_id} {code}</code>"
                    )
                    keyboard = InlineKeyboardMarkup([[
                        InlineKeyboardButton("✅ Accept", callback_data=f"rc:a:{call_id}:{code}"),
                        InlineKeyboardButton("❌ Reject", callback_data=f"rc:r:{call_id}:{code}"),
                    ]])
                    await application.bot.send_message(chat_id=owner, text=text, parse_mode="HTML", reply_markup=keyboard)
                    _PENDING[call_id] = {"alias": alias, "at": time.time()}
                    writer.write(b'{"status":"delivered"}\n')
                except Exception:
                    log.exception("RELAY Telegram notification failed")
                    writer.write(b'{"status":"failed"}\n')
                finally:
                    await writer.drain()
                    writer.close()
                    await writer.wait_closed()

            server = await asyncio.start_unix_server(handle, path=str(path))
            os.chmod(path, 0o600)
            log.info("RELAY Telegram button handler ready")
            async with server:
                await server.serve_forever()

        if not _started:
            _started = True
            asyncio.get_running_loop().create_task(serve())

    ctx.register_platform_handler("telegram", wire)
