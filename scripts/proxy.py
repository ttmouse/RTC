#!/usr/bin/env python3
"""
百炼 ASR WebSocket 代理
监听 8932 端口，浏览器连到此代理，代理转发到百炼。
不做过滤，所有结果原样转发到浏览器。
"""

import asyncio
import json
import sys
import websockets


async def proxy(ws):
    """处理一个浏览器连接"""
    bailian = None
    try:
        msg = await asyncio.wait_for(ws.recv(), timeout=30)
        data = json.loads(msg)
        if data.get("type") != "connect" or "url" not in data:
            await ws.send(json.dumps({"type": "error", "message": "expected connect message"}))
            return

        bailian_url = data["url"]
        print(f"[proxy] connecting to 百炼...", flush=True)

        try:
            bailian = await asyncio.wait_for(
                websockets.connect(bailian_url, ping_interval=None, max_size=2**20),
                timeout=10
            )
        except Exception as e:
            await ws.send(json.dumps({"type": "error", "message": f"百炼连接失败: {e}"}))
            print(f"[proxy] 百炼连接失败: {e}", flush=True)
            return

        print("[proxy] connected to 百炼", flush=True)
        await ws.send(json.dumps({"type": "connected"}))

        async def bailian_to_ws():
            """百炼 → 浏览器（原样转发）"""
            try:
                while True:
                    msg = await asyncio.wait_for(bailian.recv(), timeout=120)
                    await ws.send(msg)
            except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
                pass

        async def ws_to_bailian():
            """浏览器 → 百炼"""
            try:
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=600)
                    try:
                        parsed = json.loads(msg)
                        if parsed.get("type") == "connect":
                            continue
                    except json.JSONDecodeError:
                        pass
                    if isinstance(msg, bytes):
                        await bailian.send(msg)
                    else:
                        await bailian.send(msg)
            except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
                pass

        await asyncio.gather(bailian_to_ws(), ws_to_bailian())

    except asyncio.TimeoutError:
        print("[proxy] timeout waiting for connect message", flush=True)
    except Exception as e:
        print(f"[proxy] error: {e}", flush=True)
    finally:
        if bailian:
            try:
                await bailian.close()
            except Exception:
                pass
        print("[proxy] connection closed", flush=True)


async def main():
    print(f"[proxy] starting on :8932", flush=True)
    async with websockets.serve(proxy, "0.0.0.0", 8932, ping_interval=None):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[proxy] stopped", flush=True)
        sys.exit(0)