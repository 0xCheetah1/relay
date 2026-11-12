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


_HOME_CHANNEL = re.compile(r"^\s*TELEGRAM_HOME_CHANNEL\s*:\s*[\"']?(\d+)[\"']?\s*$", re.MULTILINE)
_OWNER_OVERRIDE = None


def _valid_chat_id(value):
    try:
        chat_id = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return chat_id if chat_id > 0 else None


def _owner_from_config():
    config, _, _ = _paths()
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        return None
    match = _HOME_CHANNEL.search(text)
    return _valid_chat_id(match.group(1)) if match else None


def _owner_chat_id():
    if _OWNER_OVERRIDE is not None:
        return _OWNER_OVERRIDE
    env_value = os.environ.get("TELEGRAM_HOME_CHANNEL")
    if env_value:
        chat_id = _valid_chat_id(env_value)
        if chat_id is not None:
            return chat_id
    configured = _owner_from_config()
    if configured is not None:
        return configured
    if env_value:
        raise ValueError("TELEGRAM_HOME_CHANNEL must be a positive private chat ID for RELAY approvals")
    raise ValueError("RELAY Telegram owner chat not found; set TELEGRAM_HOME_CHANNEL or plugins.entries.relay-telegram.settings.owner_chat_id")


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

async def _send_control(call_id, action):
    _, _, approval_path = _paths()
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(str(approval_path)), timeout=2)
    try:
        writer.write((json.dumps({"action": action, "callId": call_id}) + "\n").encode())
        await writer.drain()
        response = await asyncio.wait_for(reader.readline(), timeout=2)
        return json.loads(response)
    finally:
        writer.close()
        await writer.wait_closed()


def register(ctx):
    global _OWNER_OVERRIDE
    try:
        configured = ctx.get_config("owner_chat_id", None)
    except Exception:
        configured = None
    if configured is not None:
        chat_id = _valid_chat_id(configured)
        if chat_id is None:
            raise ValueError("plugins.entries.relay-telegram.settings.owner_chat_id must be a positive private chat ID")
        _OWNER_OVERRIDE = chat_id

    def wire(application, adapter):
        global _started
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        from telegram.ext import CallbackQueryHandler

        async def send_message(**kwargs):
            try:
                return await application.bot.send_message(**kwargs)
            except RuntimeError as exc:
                if "not initialized" not in str(exc):
                    raise
                await application.bot.initialize()
                return await application.bot.send_message(**kwargs)

        async def edit_message(query, text, **kwargs):
            try:
                return await query.edit_message_text(text, **kwargs)
            except RuntimeError as exc:
                if "not initialized" not in str(exc):
                    raise
                await query.get_bot().initialize()
                return await query.edit_message_text(text, **kwargs)

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
                        await edit_message(query, "⏳ <b>Call expired</b> — no longer available.",
                                                      parse_mode="HTML", reply_markup=None)
                    except Exception:
                        pass
                    return
                accepted = action == "a"
                pending = _PENDING.pop(call_id, None)
                alias = pending.get("alias") if pending else html.escape("unknown agent")
                status = "✅ <b>Call accepted</b>" if accepted else "❌ <b>Call rejected</b>"
                await query.answer("Accepted" if accepted else "Rejected")
                await edit_message(query, f"{status} — from <b>{alias}</b>\n\n<code>{call_id}</code>",
                                              parse_mode="HTML", reply_markup=None)
            except Exception:
                log.exception("RELAY Telegram button failed")
                await query.answer("Could not answer call", show_alert=True)

        application.add_handler(CallbackQueryHandler(on_button, pattern=r"^rc:[ar]:[0-9a-f-]{36}:[0-9a-f]{8}$"))

        async def on_call_action(update, context):
            query = update.callback_query
            if not query or not query.data or not query.message or not query.from_user:
                return
            try:
                owner = _owner_chat_id()
                if query.from_user.id != owner or query.message.chat_id != owner or query.message.chat.type != "private":
                    await query.answer("Only the owner can answer this call", show_alert=True)
                    return
                _, action, call_id = query.data.split(":", 2)
                if not _CALL_ID.fullmatch(call_id):
                    await query.answer("Invalid call", show_alert=True)
                    return
                if action == "o":
                    await query.answer("Closed")
                    await edit_message(query, "📴 <b>Call ended</b>", parse_mode="HTML", reply_markup=None)
                    return
                result = await _send_control(call_id, "details")
                if result.get("ok") and result.get("details"):
                    await query.answer()
                    await edit_message(query, result["details"], reply_markup=None)
                else:
                    await query.answer("Details unavailable", show_alert=True)
            except Exception:
                log.exception("RELAY call action failed")
                await query.answer("Could not open call", show_alert=True)

        application.add_handler(CallbackQueryHandler(on_call_action, pattern=r"^rc:[do]:[0-9a-f-]{36}$"))

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
                    if len(raw) > 16384:
                        raise ValueError("Oversized RELAY call")
                    call = json.loads(raw)
                    owner = _owner_chat_id()
                    if call.get("action") == "resolve":
                        call_id = str(call.get("callId", ""))
                        if not _CALL_ID.fullmatch(call_id):
                            raise ValueError("Invalid call identity")
                        pending = _PENDING.pop(call_id, None)
                        if pending:
                            text = html.escape(str(call.get("text", ""))[:3500])
                            try:
                                await application.bot.edit_message_text(
                                    chat_id=pending["chat"], message_id=pending["messageId"],
                                    text=text, parse_mode="HTML", reply_markup=None)
                            except Exception:
                                log.exception("RELAY Telegram missed-call edit failed")
                        writer.write(b'{"status":"resolved"}\n')
                        return
                    if call.get("action") == "notice":
                        text = html.escape(str(call.get("text", ""))[:3500])
                        buttons = call.get("buttons")
                        keyboard = None
                        if isinstance(buttons, list) and buttons:
                            rows = [[InlineKeyboardButton(str(button.get("text", "?"))[:64], callback_data=str(button.get("data", ""))[:64])
                                     for button in buttons if isinstance(button, dict) and button.get("text") and button.get("data")]]
                            keyboard = InlineKeyboardMarkup(rows) if rows and rows[0] else None
                        await send_message(chat_id=owner, text=text, parse_mode="HTML",
                                                          disable_notification=bool(call.get("silent", False)),
                                                          reply_markup=keyboard)
                        writer.write(b'{"status":"delivered"}\n')
                        return
                    call_id, code = call["callId"], call["code"]
                    if not _CALL_ID.fullmatch(call_id) or not _CODE.fullmatch(code):
                        raise ValueError("Invalid call identity")
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
                    message = await send_message(chat_id=owner, text=text, parse_mode="HTML", reply_markup=keyboard)
                    _PENDING[call_id] = {"alias": alias, "at": time.time(),
                                         "chat": message.chat_id, "messageId": message.message_id}
                    writer.write((json.dumps({"status": "delivered", "messageId": message.message_id,
                                              "chatId": message.chat_id}) + "\n").encode())
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
