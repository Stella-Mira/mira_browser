"""Persistent browser-session bridge for the DSH collaboration tools.

Why a long-lived child process: `ai_browser`'s in-process sessions
(`open_session` / `act_in_session`) are what keep a page alive across steps, while
the CLI spawns a fresh process per call (stateless). Driving a DSH GUI needs the
page to survive from "open the session" to "type" to "read back", so the caller
(Node) keeps this process running and talks to it over line-delimited JSON.

Protocol (one JSON object per line on stdin, one per line on stdout):
  in : {"id": <any>, "op": "...", ...args}
  out: {"id": <any>, "ok": true, ...payload}   or   {"id": <any>, "ok": false, "error": "..."}
Anything on stderr is diagnostic only.

Environment (set by the caller):
  AI_BROWSER_PROFILES        profile dir (must be writable BY THIS PROCESS)
  TEMP / TMP                 Playwright artifacts dir (must be writable here too)
  PLAYWRIGHT_BROWSERS_PATH   where chromium lives
  AI_BROWSER_IGNORE_HTTPS=1  accept self-signed certs (the reverse proxy uses one)
  AI_BROWSER_HTTP_USER/PASS  Basic credentials for the proxy in front of a DSH GUI

Usage: python browser_bridge.py     (reads commands until EOF / {"op":"quit"})
"""
from __future__ import annotations

import json
import os
import sys
import traceback

from ai_browser import act_in_session, close_session, open_session


def _log(msg: str) -> None:
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


def _close_all_sessions() -> None:
    """退出前关掉自己开过的浏览器会话（重要：否则 Playwright 的 Chromium 会变成孤儿，
    继续占用 profile 的 SingletonLock，下一次 collab_list 就报 ProcessSingleton）。"""
    try:
        import ai_browser.core as core
    except Exception:  # noqa: BLE001
        return
    try:
        with core._SESSIONS_LOCK:
            sids = list(core.SESSIONS.keys())
    except Exception:  # noqa: BLE001
        return
    for sid in sids:
        try:
            close_session(sid)
            _log(f"closed session {sid}")
        except Exception as e:  # noqa: BLE001
            _log(f"close session {sid} failed: {e}")


def _act(sid: str, action: dict) -> dict:
    return act_in_session(sid, action)


def _key_chord(page_act, key: str) -> dict:
    """Press a key, honouring Playwright's "ControlOrMeta+X" style chords."""
    return page_act({"action": "press", "key": key})


def op_open(req: dict) -> dict:
    """Open (or reuse) a browser session on a URL.

    `session_id` may be given to reuse an existing browser session; otherwise a new
    one is created. Returns the browser session id plus the page JSON so the caller
    can address elements in follow-up ops.
    """
    out = open_session(
        req.get("url"),
        profile=req.get("profile"),
        include_urls=bool(req.get("include_urls", False)),
        tree=bool(req.get("tree", False)),
        max_chars=req.get("max_chars"),
    )
    return {"session_id": out.get("session_id"), "page": out}


def op_act(req: dict) -> dict:
    return _act(req["session_id"], req["action"])


def op_press(req: dict) -> dict:
    """Press a key, optionally with modifiers held down (e.g. Ctrl+Enter).

    ai_browser's press action takes a single key name, so chords are built here with
    Playwright's own keyboard API (`keyboard.down/up`), not by string concatenation.
    The DSH GUI distinguishes `Enter` (queue to next turn) from `Ctrl/Cmd+Enter`
    (splice into the running step), which is exactly this path.
    """
    import ai_browser.core as core

    sid = req["session_id"]
    key = str(req.get("key", "Enter"))
    mods = [str(m) for m in (req.get("modifiers") or [])]

    with core._SESSIONS_LOCK:
        s = core.SESSIONS.get(sid)
    if s is None:
        raise ValueError(f"会话 {sid} 不存在或已过期")

    def _press() -> None:
        kb = s.page.keyboard
        for m in mods:
            kb.down(m)
        try:
            kb.press(key)
        finally:
            for m in reversed(mods):
                kb.up(m)

    s._run(_press)
    page = _act(sid, {"action": "wait", "ms": int(req.get("settle_ms", 300))})
    return {"page": page, "pressed": {"key": key, "modifiers": mods}}


def op_texts(req: dict) -> dict:
    """Return the page's text blocks (kind=text), each as {id, text}."""
    page = _act(req["session_id"], {"action": "wait", "ms": int(req.get("wait_ms", 300))})
    blocks = page.get("blocks") or []
    out = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        kind = b.get("kind") or b.get("type") or b.get("tag")
        text = b.get("text")
        if text is None:
            continue
        out.append({"id": b.get("id"), "kind": kind, "text": str(text)})
    return {"texts": out, "page_url": page.get("url"), "coverage": page.get("coverage")}


def op_wait(req: dict) -> dict:
    return {"page": _act(req["session_id"], {"action": "wait", "ms": int(req.get("ms", 1000))})}


def op_cdp_click(req: dict) -> dict:
    """Click at viewport coordinates through CDP `Input.dispatchMouseEvent`.

    Why this exists: a DSH GUI can carry a decorative overlay (the Live2D canvas)
    that swallows pointer events, and ai_browser's structured click correctly
    refuses with `blocked_by=overlay`. For *our own* GUI we know the overlay is
    cosmetic, so we keep a raw, auditable escape hatch — the caller (Node) always
    verifies the outcome structurally afterwards (`aria-selected` on the target
    row), so a click that misses cannot silently pass as success.
    """
    import ai_browser.core as core  # local import: keep module import side effects minimal

    with core._SESSIONS_LOCK:
        s = core.SESSIONS.get(req["session_id"])
    if s is None:
        raise ValueError(f"会话 {req['session_id']} 不存在或已过期")

    def _click() -> None:
        page = s.page
        x = float(req["x"])
        y = float(req["y"])
        cdp = page.context.new_cdp_session(page)
        try:
            for kind in ("mousePressed", "mouseReleased"):
                cdp.send("Input.dispatchMouseEvent", {
                    "type": kind, "x": x, "y": y, "button": "left",
                    "clickCount": 1, "buttons": 1 if kind == "mousePressed" else 0,
                })
        finally:
            try:
                cdp.detach()
            except Exception:  # noqa: BLE001
                pass

    s._run(_click)
    return {"clicked_at": {"x": req["x"], "y": req["y"]}}


def op_close(req: dict) -> dict:
    res = close_session(req["session_id"])
    return {"closed": bool(res), "detail": dict(res)}


OPS = {
    "open": op_open,
    "act": op_act,
    "press": op_press,
    "texts": op_texts,
    "wait": op_wait,
    "cdp_click": op_cdp_click,
    "close": op_close,
}


def main() -> int:
    _log(f"start pid={os.getpid()} profiles={os.environ.get('AI_BROWSER_PROFILES')} "
         f"temp={os.environ.get('TEMP')}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"id": None, "ok": False, "error": f"bad json: {e}"}), flush=True)
            continue
        rid = req.get("id")
        op = req.get("op")
        if op == "quit":
            _close_all_sessions()
            print(json.dumps({"id": rid, "ok": True}), flush=True)
            return 0
        fn = OPS.get(op)
        if fn is None:
            print(json.dumps({"id": rid, "ok": False, "error": f"unknown op {op!r}"}), flush=True)
            continue
        try:
            payload = fn(req)
            payload["id"] = rid
            payload["ok"] = True
        except Exception as e:  # noqa: BLE001
            payload = {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}",
                       "trace": traceback.format_exc()[-1200:]}
            # 给 Node 侧一个**结构化**判据：会话过期要自愈重开，别的错误不许误判。
            # 只认 ai_browser 自己那条「会话 <sid> 不存在或已过期」文案（它带 sid，
            # Node 侧还会再核对 sid 是不是刚用的那个）；不按异常类型判，避免
            # ValueError 之外的包装把自愈路径漏掉。会话数上限等其它 ValueError
            # 不含这句文案，因此不会被误当成过期。
            if "不存在或已过期" in str(e):
                payload["code"] = "session/expired"
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    _close_all_sessions()
    _log("stdin closed, exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
