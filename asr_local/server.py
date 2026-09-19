#!/usr/bin/env python3
"""
本地 SenseVoice ASR 服务 — RTC 第三种引擎
能量 VAD + 一次 final 推理（无 interim 中间态）
"""

import asyncio
import json
import os
import re
import sys
import uuid

import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from collections import deque

# ---------- 依赖容错 ----------
# 模型管理 HTTP（8933：状态/下载/重载）只用标准库，必须始终可用——否则用户连
# 「下载模型」这个自救入口都打不开，前端只能显示「无法连接本地模型服务」。
# 推理依赖缺失时降级为「可管理、不可识别」，缺失项由 /model/status 暴露给前端。
_MISSING_DEPS = []


def _try_import(name):
    try:
        return __import__(name), None
    except Exception as e:  # ModuleNotFoundError / OSError（如架构不匹配）等
        _MISSING_DEPS.append((name, str(e)))
        return None, str(e)


np, _ERR_NUMPY = _try_import("numpy")
_sherpa_onnx, _ERR_SHERPA = _try_import("sherpa_onnx")
websockets, _ERR_WEBSOCKETS = _try_import("websockets")

# import 名 → pip 包名（两者不一致的只有 sherpa_onnx）
PIP_NAMES = {"sherpa_onnx": "sherpa-onnx", "numpy": "numpy", "websockets": "websockets"}

# ---------- 配置 ----------
PORT = int(os.environ.get("ASR_PORT", "8932"))
ENGINE = os.environ.get("ASR_ENGINE", "sensevoice")   # sensevoice | qwen3
# Qwen3 模型目录不做模块级快照：唯一的解析入口是 default_qwen3_dir()（见下），
# 旧的 QWEN3_DIR 常量只服务已删除的 LocalASR，且缺少数据目录回落，留着就是第二个真相来源。
NUM_THREADS = int(os.environ.get("ASR_NUM_THREADS", "4"))
# 首次使用时的模型下载地址（GitHub Releases 资产）。
# 注意：固定指向 v1.0.18 的资产 URL，不随「最新版」变动——
# 模型 zip（约 160MB / 987MB）体积大，不随每次版本重传，v1.0.18 的资产长期保留。
MODEL_DOWNLOAD_URL = os.environ.get(
    "ASR_MODEL_DOWNLOAD_URL",
    "https://github.com/ttmouse/RTC/releases/download/v1.0.18/official_sensevoice.zip",
)
MODEL_HTTP_PORT = int(os.environ.get("ASR_MODEL_HTTP_PORT", "8933"))

# 模型下载状态在下方 MODEL_DL_STATES 中定义
_ASYNC_LOOP = None  # main() 中设置，供下载线程回调重载模型


# ---------- 环境诊断（供前端展示可操作的修复指引） ----------

def python_path() -> str:
    """当前解释器绝对路径（前端据此拼出可直接复制执行的安装命令）"""
    return sys.executable or "python3"


def _missing_dep_names() -> list:
    return sorted({name for name, _ in _MISSING_DEPS})


def install_command() -> str:
    """给出针对当前解释器的依赖安装命令，用户可直接复制执行"""
    names = _missing_dep_names()
    if not names:
        return ""
    pkgs = " ".join(PIP_NAMES.get(n, n) for n in names)
    return f"{python_path()} -m pip install {pkgs}"


def environment_issue() -> str:
    """返回环境问题描述；环境正常时返回空串。

    出现原因：Rust 侧 find_binary 只校验 `python3 --version` 能否执行，
    不校验依赖是否装齐。若命中系统 Python（如 /usr/bin/python3），
    推理依赖缺失，服务会退化为「可下载模型、不可识别语音」。
    """
    names = _missing_dep_names()
    if not names:
        return ""
    detail = "; ".join(f"{n}: {e.splitlines()[0]}" for n, e in sorted(_MISSING_DEPS))
    return (
        f"当前 Python 缺少依赖：{', '.join(names)}（{python_path()}）。"
        f"请在终端执行：{install_command()}，然后重启本应用。原始错误：{detail}"
    )


def default_qwen3_dir() -> str:
    """Qwen3 模型目录探测顺序：环境变量 > server.py 同目录（dev 模式）> 约定目录（.app 外置模型）。

    .app 内置版不带 Qwen3 模型，约定目录为
    ~/Library/Application Support/com.rtc.transcriber/models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25
    """
    if os.environ.get("ASR_QWEN3_DIR"):
        return os.environ["ASR_QWEN3_DIR"]
    same_dir = os.path.join(os.path.dirname(__file__), "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25")
    if os.path.isdir(same_dir) and os.path.isfile(os.path.join(same_dir, "encoder.int8.onnx")):
        return same_dir
    return os.path.join(
        os.path.expanduser("~"), "Library", "Application Support",
        "com.rtc.transcriber", "models", "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
    )


def default_sensevoice_dir() -> str:
    """SenseVoice 模型目录探测顺序：环境变量 > server.py 同目录（dev/旧版内置）> 数据目录约定位置。

    新版 .app 不再内置 228MB 模型（热更新包不能太大），约定目录为
    ~/Library/Application Support/com.rtc.transcriber/models/official_sensevoice
    """
    if os.environ.get("ASR_SENSEVOICE_DIR"):
        return os.environ["ASR_SENSEVOICE_DIR"]
    same_dir = os.path.join(os.path.dirname(__file__), "official_sensevoice")
    if os.path.isfile(os.path.join(same_dir, "model.int8.onnx")):
        return same_dir
    return os.path.join(
        os.path.expanduser("~"), "Library", "Application Support",
        "com.rtc.transcriber", "models", "official_sensevoice",
    )


def ensure_sensevoice_model() -> str:
    """确保 SenseVoice 模型可用并返回模型目录；缺失时自动从 GitHub Releases 下载到约定目录。

    返回 (model_dir, downloaded)。下载约 228MB，仅首次使用触发。
    注意：这个函数会阻塞几分钟（下载 + 解压），绝不能在 import 期或事件循环里调用。
    """
    model_dir = default_sensevoice_dir()
    model_path = os.path.join(model_dir, "model.int8.onnx")
    tokens_path = os.path.join(model_dir, "tokens.txt")
    if os.path.isfile(model_path) and os.path.isfile(tokens_path):
        return model_dir, False

    import urllib.request
    import zipfile

    os.makedirs(model_dir, exist_ok=True)
    tmp_zip = os.path.join(model_dir, "official_sensevoice.zip.tmp")
    print(f"[asr_local] 首次使用：未找到 SenseVoice 模型，从 {MODEL_DOWNLOAD_URL} 下载（约 228MB）...")
    try:
        req = urllib.request.Request(MODEL_DOWNLOAD_URL, headers={"User-Agent": "rtc-transcriber"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            got = 0
            with open(tmp_zip, "wb") as f:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    if total:
                        print(f"[asr_local] 模型下载中 {got // (1 << 20)}/{total // (1 << 20)} MB", end="\r")
        print(f"\n[asr_local] 模型下载完成（{got // (1 << 20)} MB），解压中...")
        with zipfile.ZipFile(tmp_zip) as zf:
            zf.extractall(model_dir)
        os.remove(tmp_zip)
        print(f"[asr_local] 模型就绪: {model_dir}")
        return model_dir, True
    except Exception as e:
        # 失败时把半截的 .tmp 清掉：228MB 的残包既占地方，又会让下次「文件已存在」的
        # 判断产生误导（同名 .tmp 直接覆盖，但用户看到一个巨大的可疑文件会以为是模型）。
        try:
            if os.path.exists(tmp_zip):
                os.remove(tmp_zip)
        except OSError:
            pass
        print(f"[asr_local] 模型下载失败: {e}（请联网后重启应用，或手动将模型放到 {model_dir}）")
        raise


# 模型路径是「可能随时间变化」的：首次启动时模型还没下载完，路径只能先按约定目录填上，
# 等后台下载线程完成后由 _apply_sensevoice_dir() 重新落定。引擎加载前必须显式读一次
# （见 _ENGINE_MODEL_LOCK 的用法），不能把 import 期的快照当成最终答案。
MODEL_DIR = default_sensevoice_dir()
MODEL_PATH = os.path.join(MODEL_DIR, "model.int8.onnx")
TOKENS_PATH = os.path.join(MODEL_DIR, "tokens.txt")
_MODEL_DOWNLOADED = False

# 保证「首次下载」和「引擎加载」不会同时动同一份模型目录。
_ENGINE_MODEL_LOCK = threading.Lock()
# 首次模型下载完成后置位；EngineManager.load 在加载 SenseVoice 前等它。
_SENSEVOICE_READY = threading.Event()


def _apply_sensevoice_dir(model_dir: str) -> None:
    """按给定目录重算模块级模型路径（下载完成后、或引擎加载前同步一次）。"""
    global MODEL_DIR, MODEL_PATH, TOKENS_PATH
    MODEL_DIR = model_dir
    MODEL_PATH = os.path.join(model_dir, "model.int8.onnx")
    TOKENS_PATH = os.path.join(model_dir, "tokens.txt")


def _bootstrap_sensevoice_model() -> None:
    """后台线程：首次使用下载 SenseVoice 模型。

    为什么不能在 import 期做这件事：原来这段是模块级 `ensure_sensevoice_model()`，
    首次启动要先下载 228MB 才轮到 `main()` 绑定 8932（识别 WS）和 8933（模型管理 HTTP）。
    结果是 Rust 侧 30 秒的 `wait_for_tcp(8932)` 必然超时、整个 App 判定「本地 ASR 未就绪」，
    而 8933 也没起来，用户在设置面板里连「正在下载」都看不到，只能干等一个白屏。
    放到线程里之后：两个端口立刻可用，下载进度走 8933 上报，界面能如实显示。
    """
    global _MODEL_DOWNLOADED
    try:
        with _ENGINE_MODEL_LOCK:
            model_dir, downloaded = ensure_sensevoice_model()
            _apply_sensevoice_dir(model_dir)
            _MODEL_DOWNLOADED = downloaded
    except Exception as e:
        print(f"[asr_local] 模型初始化失败: {e}（可在应用设置面板中下载模型）")
        _apply_sensevoice_dir(default_sensevoice_dir())
    finally:
        # 无论成功失败都要放行：失败时 load() 会走到「模型缺失」的清晰报错，
        # 比让录音请求永远挂在一个永远不会置位的事件上强。
        _SENSEVOICE_READY.set()

# VAD 参数
FRAME_MS = 32                      # 帧长（32ms ≈ 512 样本 @16k）
SILENCE_CUT_MS = int(os.environ.get("ASR_SILENCE_MS", "2000"))
MAX_SEGMENT_MS = int(os.environ.get("ASR_MAX_SEGMENT_MS", "30000"))
MIN_SPEECH_MS = int(os.environ.get("ASR_MIN_SPEECH_MS", "300"))
MIN_SPEECH_RUN_MS = int(os.environ.get("ASR_MIN_SPEECH_RUN_MS", "200"))
RMS_THRESHOLD = 0.006              # 能量 VAD 阈值（前端可调）
PRE_ROLL_MS = 260
PAD_MS = 200
VAD_FRAME = int(16000 * FRAME_MS / 1000)  # 512 样本
TIMING_LOGS = os.environ.get("ASR_TIMING_LOGS") == "1"

# ---------- 模型管理（HTTP，供设置面板调用） ----------

QWEN3_DOWNLOAD_URL = os.environ.get(
    "ASR_QWEN3_DOWNLOAD_URL",
    "https://github.com/ttmouse/RTC/releases/download/v1.0.18/qwen3-asr.zip",
)

# 每个模型的下载状态（前端 /model/progress 轮询）
MODEL_DL_STATES = {
    "sensevoice": {"status": "idle", "progress": 0, "downloaded": 0, "total": 0, "message": ""},
    "qwen3": {"status": "idle", "progress": 0, "downloaded": 0, "total": 0, "message": ""},
}

QWEN3_REQUIRED = ("conv_frontend.onnx", "encoder.int8.onnx", "decoder.int8.onnx")


def _dir_size(path: str) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _sensevoice_status() -> dict:
    model_dir = default_sensevoice_dir()
    model_path = os.path.join(model_dir, "model.int8.onnx")
    tokens_path = os.path.join(model_dir, "tokens.txt")
    has_model = os.path.isfile(model_path)
    has_tokens = os.path.isfile(tokens_path)
    size = 0
    if has_model:
        size += os.path.getsize(model_path)
    if has_tokens:
        size += os.path.getsize(tokens_path)
    return {
        "type": "sensevoice",
        "name": "SenseVoice",
        "exists": has_model and has_tokens,
        "model_dir": model_dir,
        "size_bytes": size,
        "missing": [n for n, ok in [("model.int8.onnx", has_model), ("tokens.txt", has_tokens)] if not ok],
        "download_url": MODEL_DOWNLOAD_URL,
    }


def _qwen3_status(custom_dir: str = "") -> dict:
    model_dir = custom_dir.strip() if custom_dir else default_qwen3_dir()
    missing = []
    for f in QWEN3_REQUIRED:
        if not os.path.isfile(os.path.join(model_dir, f)):
            missing.append(f)
    if not os.path.isdir(os.path.join(model_dir, "tokenizer")):
        missing.append("tokenizer/")
    size = _dir_size(model_dir) if os.path.isdir(model_dir) else 0
    return {
        "type": "qwen3",
        "name": "Qwen3-ASR",
        "exists": len(missing) == 0,
        "model_dir": model_dir,
        "size_bytes": size,
        "missing": missing,
        "download_url": QWEN3_DOWNLOAD_URL,
    }


def get_model_status(qwen3_dir: str = "") -> dict:
    return {
        "sensevoice": _sensevoice_status(),
        "qwen3": _qwen3_status(qwen3_dir),
        "environment": {
            "python_path": python_path(),
            "missing_deps": _missing_dep_names(),
            "issue": environment_issue(),
            "install_command": install_command(),
            "ready": not _MISSING_DEPS,
        },
    }


def _download_model_to_dir(url: str, model_dir: str, dl_state: dict) -> bool:
    import urllib.request
    import zipfile

    os.makedirs(model_dir, exist_ok=True)
    tmp_zip = os.path.join(model_dir, "_model_download.zip.tmp")
    dl_state.update(status="downloading", progress=0, downloaded=0, total=0, message="连接中...")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "rtc-transcriber"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            dl_state["total"] = total
            got = 0
            with open(tmp_zip, "wb") as f:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    dl_state["downloaded"] = got
                    if total:
                        dl_state["progress"] = round(got / total * 100, 1)
                        dl_state["message"] = f"下载中 {got // (1 << 20)}/{total // (1 << 20)} MB"
        dl_state["message"] = "解压中..."
        # 解压阶段总量未知（zip 内文件数不定），标记为 extracting 供前端切不确定态
        dl_state["status"] = "extracting"
        with zipfile.ZipFile(tmp_zip) as zf:
            zf.extractall(model_dir)
        os.remove(tmp_zip)
        dl_state.update(status="done", progress=100, message="下载完成")
        print(f"[asr_local] 模型下载完成: {model_dir}")
        return True
    except Exception as e:
        dl_state.update(status="error", message=str(e))
        print(f"[asr_local] 模型下载失败: {e}")
        try:
            os.remove(tmp_zip)
        except OSError:
            pass
        return False


def _download_model_thread(model_type: str, qwen3_dir: str = ""):
    if model_type == "qwen3":
        url = QWEN3_DOWNLOAD_URL
        model_dir = qwen3_dir.strip() if qwen3_dir else default_qwen3_dir()
    else:
        url = MODEL_DOWNLOAD_URL
        model_dir = default_sensevoice_dir()
    dl_state = MODEL_DL_STATES.get(model_type, MODEL_DL_STATES["sensevoice"])
    ok = _download_model_to_dir(url, model_dir, dl_state)
    if ok and _ASYNC_LOOP is not None:
        engine = "qwen3" if model_type == "qwen3" else "sensevoice"
        asyncio.run_coroutine_threadsafe(engine_mgr.load(engine), _ASYNC_LOOP)


def _parse_query(path: str) -> dict:
    from urllib.parse import urlparse, parse_qs
    parsed = urlparse(path)
    return {k: v[0] for k, v in parse_qs(parsed.query).items()}


def _origin_allowed(origin: str) -> bool:
    """8933 模型管理接口的来源校验。

    这个端口没有鉴权（本机工具，靠回环地址当边界），而老代码对所有来源回
    `Access-Control-Allow-Origin: *`：用户浏览器里任意一个网页都能跨域
    POST /model/download 把 228MB~987MB 的模型写进磁盘，或者拿
    GET /model/status?qwen3_dir=/任意路径 当目录探测器用。
    现在只认「本机来源」和「没有 Origin 的原生调用」，其余一律 403。
    """
    if not origin:
        return True
    from urllib.parse import urlparse
    host = (urlparse(origin).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1")


class ModelHTTPHandler(BaseHTTPRequestHandler):
    def _cors(self):
        # 只回显可信来源；不可信来源在 _reject_bad_origin 里已经被拒绝。
        origin = self.headers.get("Origin")
        if origin and _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _reject_bad_origin(self) -> bool:
        if _origin_allowed(self.headers.get("Origin")):
            return False
        self._json({"error": "origin not allowed"}, 403)
        return True

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            return {}

    def do_GET(self):
        if self._reject_bad_origin():
            return
        q = _parse_query(self.path)
        if self.path.startswith("/model/status"):
            self._json(get_model_status(q.get("qwen3_dir", "")))
        elif self.path.startswith("/model/progress"):
            mtype = q.get("type", "sensevoice")
            self._json(MODEL_DL_STATES.get(mtype, MODEL_DL_STATES["sensevoice"]))
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self._reject_bad_origin():
            return
        body = self._read_body()
        if self.path.startswith("/model/download"):
            mtype = body.get("type", "sensevoice")
            dl_state = MODEL_DL_STATES.get(mtype)
            if dl_state and dl_state["status"] in ("downloading", "extracting"):
                self._json({"started": False, "reason": "already_downloading"})
            else:
                threading.Thread(
                    target=_download_model_thread,
                    args=(mtype, body.get("qwen3_dir", "")),
                    daemon=True,
                ).start()
                self._json({"started": True})
        elif self.path.startswith("/model/reload"):
            if _ASYNC_LOOP is not None:
                mtype = body.get("type", "sensevoice")
                engine = "qwen3" if mtype == "qwen3" else "sensevoice"
                asyncio.run_coroutine_threadsafe(engine_mgr.load(engine), _ASYNC_LOOP)
                self._json({"reloading": True})
            else:
                self._json({"reloading": False, "error": "loop not ready"})
        else:
            self._json({"error": "not found"}, 404)

    def log_message(self, *args):
        pass  # 静默 HTTP 日志


def start_model_http_server():
    ThreadingHTTPServer.allow_reuse_address = True
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", MODEL_HTTP_PORT), ModelHTTPHandler)
    except OSError as e:
        print(f"[asr_local] 端口 {MODEL_HTTP_PORT} 被占用: {e}，尝试自动释放...")
        import subprocess
        pid = subprocess.run(
            ["lsof", "-ti", f"tcp:{MODEL_HTTP_PORT}"],
            capture_output=True, text=True
        ).stdout.strip()
        if pid:
            subprocess.run(["kill", "-9", pid], capture_output=True)
            time.sleep(0.5)
        srv = ThreadingHTTPServer(("127.0.0.1", MODEL_HTTP_PORT), ModelHTTPHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[asr_local] 模型管理 HTTP: http://127.0.0.1:{MODEL_HTTP_PORT}")


class EngineManager:
    """单进程多模型热切换管理器。

    只常驻一个 recognizer（最近被选用的引擎），切换时销毁旧模型、加载新模型。
    模型加载约 2-3s，在 executor 中执行避免阻塞事件循环。
    """

    def __init__(self, initial_engine: str):
        self.current_engine = initial_engine
        self.current_qwen3_dir = None
        self.lock = asyncio.Lock()
        import concurrent.futures
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.rec = None
        self._loaded = False

    def _build_recognizer(self, engine: str, qwen3_dir: str):
        """同步构建 recognizer（在 executor 线程中调用）"""
        if engine == "qwen3":
            print(f"[asr_local] 加载 Qwen3-ASR 模型: {qwen3_dir}")
            return _sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
                conv_frontend=str(os.path.join(qwen3_dir, "conv_frontend.onnx")),
                encoder=str(os.path.join(qwen3_dir, "encoder.int8.onnx")),
                decoder=str(os.path.join(qwen3_dir, "decoder.int8.onnx")),
                tokenizer=str(os.path.join(qwen3_dir, "tokenizer")),
                num_threads=NUM_THREADS,
                sample_rate=16000,
                feature_dim=128,
                decoding_method="greedy_search",
                debug=False,
                provider="cpu",
                max_total_len=1024,
                max_new_tokens=256,
                temperature=1e-6,
                top_p=0.8,
                seed=42,
            )
        else:
            # 每次加载都重新解析路径：首次下载是在后台线程里完成的，
            # import 期的 MODEL_PATH 只是「按约定目录先填上」的快照，可能还没落地。
            model_path = os.path.join(default_sensevoice_dir(), "model.int8.onnx")
            tokens_path = os.path.join(default_sensevoice_dir(), "tokens.txt")
            if not (os.path.isfile(model_path) and os.path.isfile(tokens_path)):
                # 模型确实缺失。抛 RuntimeError 之外还要给出可操作的指引，
                # 且必须是明确异常而不是让 sherpa 自己报「File doesn't exist」——
                # 上层 handle() 只捕获 ConnectionClosed，其它异常会让整条 WS 带着
                # traceback 断开，前端只看到「连接被关闭」而不知道是没下模型。
                raise FileNotFoundError(
                    f"SenseVoice 模型缺失: {model_path}。\n"
                    "请在本应用「设置」→「本地模型」点击「下载模型」安装后重试。"
                )
            print(f"[asr_local] 加载 SenseVoice 模型: {model_path}")
            return _sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=model_path,
                tokens=tokens_path,
                use_itn=True,
                debug=False,
                num_threads=NUM_THREADS,
            )

    @staticmethod
    def check_qwen3_dir(qwen3_dir: str):
        """校验 Qwen3 模型目录完整性，缺少文件时抛出清晰错误"""
        if not os.path.isdir(qwen3_dir):
            raise FileNotFoundError(
                f"Qwen3 模型目录不存在: {qwen3_dir}。\n"
                "请在本应用「设置」→「本地模型」→「Qwen3-ASR 识别模型」点击「下载模型」安装后重试。"
            )
        missing = []
        for f in ("conv_frontend.onnx", "encoder.int8.onnx", "decoder.int8.onnx"):
            if not os.path.isfile(os.path.join(qwen3_dir, f)):
                missing.append(f)
        if not os.path.isdir(os.path.join(qwen3_dir, "tokenizer")):
            missing.append("tokenizer/")
        if missing:
            raise FileNotFoundError(
                f"Qwen3 模型目录缺少文件: {', '.join(missing)}（{qwen3_dir}）"
            )

    async def load(self, engine: str, qwen3_dir: str = None):
        """确保指定引擎的 recognizer 已加载；若不同（或 qwen3 目录变化）则热切换。

        返回 (recognizer, switched)。qwen3_dir 为 None 时自动探测默认目录。
        """
        engine = engine if engine in ("sensevoice", "qwen3") else "sensevoice"
        # 依赖缺失时给出可操作的错误，而不是底层 AttributeError/ImportError
        if _sherpa_onnx is None or np is None:
            raise RuntimeError(environment_issue())
        if engine == "sensevoice":
            # 首次启动时 SenseVoice 模型由后台线程下载（见 _bootstrap_sensevoice_model）。
            # 这里等它结束：不等的话，用户在下载完成前点录音只会拿到「模型缺失」的报错，
            # 而实际上再等几分钟就好。非首次时事件早已置位，是零成本判断。
            # 必须丢到线程池里 wait()：直接调用会阻塞事件循环，把 8933 的进度查询和
            # 整条 WebSocket 服务一起冻住，恰好是最需要它们活着的那几分钟。
            await asyncio.get_running_loop().run_in_executor(None, _SENSEVOICE_READY.wait)
        if engine == "qwen3":
            qwen3_dir = qwen3_dir or default_qwen3_dir()
            self.check_qwen3_dir(qwen3_dir)
        async with self.lock:
            if (
                self._loaded
                and self.current_engine == engine
                and (engine != "qwen3" or self.current_qwen3_dir == qwen3_dir)
            ):
                return self.rec, False
            t0 = time.time()
            loop = asyncio.get_running_loop()
            self.rec = await loop.run_in_executor(
                self.executor, self._build_recognizer, engine, qwen3_dir
            )
            self.current_engine = engine
            self.current_qwen3_dir = qwen3_dir if engine == "qwen3" else None
            self._loaded = True
            print(f"[asr_local] 模型就绪 ({time.time()-t0:.1f}s) [{engine}]")
            return self.rec, True

    async def recognize(self, engine: str, pcm: bytes, qwen3_dir: str = None) -> str:
        """按引擎取 recognizer 并推理"""
        rec, _ = await self.load(engine, qwen3_dir)
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        if len(audio) == 0:
            return ""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.executor, self._infer, rec, audio)

    @staticmethod
    def _infer(rec, audio) -> str:
        stream = rec.create_stream()
        stream.accept_waveform(16000, audio)
        rec.decode_stream(stream)
        return stream.result.text.strip()


class Session:
    """一次 run-task ~ finish-task 的识别会话"""

    def __init__(self, ws, task_id: str, engine_mgr: EngineManager, engine: str):
        self.ws = ws
        self.task_id = task_id
        self.engine_mgr = engine_mgr
        self.engine = engine
        self.qwen3_dir = None
        self.silence_cut_ms = int(os.environ.get("ASR_SILENCE_MS", "2000"))
        self.reset()

    def reset(self):
        self.audio_ms = 0
        self.buf = bytearray()
        self.in_speech = False
        self.silence_ms = 0
        self.seg_start_ms = 0
        self.rms_threshold = RMS_THRESHOLD
        self.vad_mode = "auto"
        self.noise_floor = 0.0
        self.noise_samples = deque(maxlen=48)
        self.auto_paste = False
        self.pre_frames = deque(maxlen=int(PRE_ROLL_MS / FRAME_MS))
        self.seg_id = None
        self.seg_active_frames = 0
        self.seg_active_ms = 0
        self.seg_run_ms = 0
        self.seg_max_run_ms = 0
        self.seg_rms_sum = 0.0
        self.seg_rms_count = 0
        self.seg_rms_max = 0.0
        self.seg_wall_start_ms = None
        self.last_speech_wall_ms = None

    # ---------- 控制消息 ----------

    async def handle_json(self, msg: dict):
        header = msg.get("header", {})
        action = header.get("action")
        if action == "run-task":
            self.reset()
            params = (msg.get("payload") or {}).get("parameters") or {}
            eng = params.get("engine")
            if eng in ("sensevoice", "qwen3"):
                self.engine = eng
            thr = params.get("vad_threshold")
            if thr is not None:
                self.rms_threshold = float(thr)
            self.vad_mode = "manual" if params.get("vad_mode") == "manual" else "auto"
            ap = params.get("auto_paste")
            if ap is not None:
                self.auto_paste = bool(ap)
            sil = params.get("silence_timeout")
            if sil is not None:
                self.silence_cut_ms = int(sil)
            qmd = params.get("qwen3_model_dir")
            if qmd:
                self.qwen3_dir = str(qmd).strip()
            # 预热/切换模型（约 2-3s），完成后才 task-started，前端据此感知就绪
            try:
                await self.engine_mgr.load(self.engine, self.qwen3_dir)
            except FileNotFoundError as e:
                print(f"[asr_local] 模型加载失败: {e}")
                await self.send_event("task-failed", {"message": str(e)})
                return
            await self.send_event("task-started")
        elif action == "finish-task":
            await self.flush_segment(final=True, reason="finish_task")
            await self.send_event("task-finished")

    # ---------- 音频 ----------

    async def feed_audio(self, data: bytes):
        # int16 是 2 字节元素，奇数长度的 buffer 会让 np.frombuffer 抛
        # ValueError("buffer size must be a multiple of element size")。
        # 这不是纯理论：handle() 只捕获 ConnectionClosed，任何其它异常都会让整个
        # 识别会话带着 traceback 断开，前端只看到「连接被关闭」。截掉末尾那半个样本
        # （损失 0.03ms 音频）比整条会话崩掉划算得多。
        if len(data) % 2:
            data = data[:-1]
            if not data:
                return
        raw = np.frombuffer(data, dtype=np.int16)
        if len(raw) == 0:
            return
        samples = raw.astype(np.float32) / 32768.0
        self.audio_ms += len(raw) / 16

        for i in range(0, len(raw), VAD_FRAME):
            if len(raw[i : i + VAD_FRAME]) < VAD_FRAME // 2:
                break
            frame_f = samples[i : i + VAD_FRAME]
            rms = float(np.sqrt(np.mean(frame_f ** 2))) if len(frame_f) else 0.0
            frame_bytes = raw[i : i + VAD_FRAME].tobytes()
            frame_ms = len(frame_f) / 16
            self.pre_frames.append(frame_bytes)

            if self.vad_mode == "auto":
                quiet = self.noise_floor == 0 or rms < max(self.rms_threshold * 0.85, self.noise_floor * 1.35)
                if quiet:
                    self.noise_samples.append(rms)
                    ordered = sorted(self.noise_samples)
                    p25 = ordered[int((len(ordered) - 1) * 0.25)]
                    self.noise_floor = p25 if self.noise_floor == 0 else self.noise_floor * 0.92 + p25 * 0.08
                    self.rms_threshold = min(0.05, max(0.001, self.noise_floor * 2.8, self.noise_floor + 0.0025))

            if rms >= self.rms_threshold:
                self.last_speech_wall_ms = time.monotonic() * 1000
                self.seg_active_frames += 1
                self.seg_active_ms += frame_ms
                self.seg_run_ms += frame_ms
                self.seg_max_run_ms = max(self.seg_max_run_ms, self.seg_run_ms)
                self.seg_rms_sum += rms
                self.seg_rms_count += 1
                self.seg_rms_max = max(self.seg_rms_max, rms)
                if not self.in_speech:
                    self.seg_id = uuid.uuid4().hex[:8]
                    self.seg_wall_start_ms = self.last_speech_wall_ms
                    print(f"[VAD] speech_start at {self.audio_ms:.0f}ms sil={self.silence_ms:.0f} rms={rms:.5f} thr={self.rms_threshold} seg={self.seg_id}")
                    self.in_speech = True
                    self.silence_ms = 0
                    for fb in self.pre_frames:
                        self.buf.extend(fb)
                    self.seg_start_ms = max(0, self.audio_ms - PRE_ROLL_MS)
                else:
                    self.buf.extend(frame_bytes)
                    self.silence_ms = 0
                if self.audio_ms - self.seg_start_ms >= MAX_SEGMENT_MS:
                    print(f"[VAD] force_flush due to max_segment_ms ({MAX_SEGMENT_MS}ms reached, seg_start={self.seg_start_ms:.0f} audio={self.audio_ms:.0f})")
                    await self.flush_segment(final=True, reason="max_segment")
                    self.silence_ms = 0
            else:
                self.seg_run_ms = 0
                if self.in_speech:
                    self.silence_ms += frame_ms
                    self.buf.extend(frame_bytes)
                    if self.silence_ms >= self.silence_cut_ms:
                        print(f"[VAD] force_flush due to silence timeout ({self.silence_cut_ms}ms reached, sil={self.silence_ms:.0f} audio={self.audio_ms:.0f})")
                        await self.flush_segment(final=True, reason="silence_timeout")
                        self.silence_ms = 0

    async def flush_segment(self, final: bool = False, reason: str = "unknown"):
        flush_wall_ms = time.monotonic() * 1000
        pcm_all = bytes(self.buf)
        buffered_ms = int(len(pcm_all) / 2 / 16)
        active_ms = int(self.seg_active_ms)
        last_speech_to_flush_ms = round(flush_wall_ms - (self.last_speech_wall_ms or flush_wall_ms), 1)
        rms_mean = (self.seg_rms_sum / self.seg_rms_count) if self.seg_rms_count else 0.0
        passes_min_speech = active_ms >= MIN_SPEECH_MS
        passes_min_run = int(self.seg_max_run_ms) >= MIN_SPEECH_RUN_MS
        decision = "pass" if passes_min_speech and passes_min_run else "drop"
        print(
            f"[VAD] flush_segment final={final} reason={reason} seg={self.seg_id} "
            f"buf={len(self.buf)} in_speech={self.in_speech} sil_ms={self.silence_ms} "
            f"seg_dur={self.audio_ms - self.seg_start_ms:.0f}ms buffered_ms={buffered_ms} "
            f"active_ms={active_ms} max_run_ms={int(self.seg_max_run_ms)} "
            f"rms_max={self.seg_rms_max:.5f} rms_mean={rms_mean:.5f} decision={decision}"
        )
        if reason != "finish_task":
            print(f"[VAD] >>> 换行原因: {reason}")
        if not (passes_min_speech and passes_min_run):
            if final:
                self.in_speech = False
                self.silence_ms = 0
            self.buf.clear()
            self.seg_start_ms = self.audio_ms
            self._reset_segment_metrics()
            return
        pad = np.zeros(int(16000 * PAD_MS / 1000), dtype=np.int16).tobytes()
        pcm_all = pad + pcm_all + pad

        infer_start_ms = time.monotonic() * 1000
        try:
            text = await self.engine_mgr.recognize(self.engine, pcm_all, self.qwen3_dir)
        except Exception as e:
            print(f"[asr_local] 推理异常: {e}")
            text = ""
        infer_ms = round(time.monotonic() * 1000 - infer_start_ms, 1)

        print(f"[VAD] segment_result seg={self.seg_id} text={text!r} active_ms={active_ms}")
        timing = None
        if text:
            if TIMING_LOGS:
                timing = {
                    "py_flush_wall_ms": time.time() * 1000,
                    "py_infer_ms": infer_ms,
                    "last_speech_to_flush_ms": last_speech_to_flush_ms,
                    "segment_wall_ms": round(flush_wall_ms - (self.seg_wall_start_ms or flush_wall_ms), 1),
                }
                print(
                    f"[TIMING] seg={self.seg_id} reason={reason} "
                    f"last_speech_to_flush_ms={last_speech_to_flush_ms} "
                    f"infer_ms={infer_ms} text={text!r}"
                )
            send_start_ms = time.monotonic() * 1000
            await self.send_event("result-generated", {
                "output": {
                    "sentence": {
                        "seg_id": self.seg_id,
                        "text": text,
                        "begin_time": int(self.seg_start_ms),
                        "end_time": int(self.audio_ms) if final else 0,
                        "timing": timing,
                    }
                }
            })
            if TIMING_LOGS:
                print(f"[TIMING] seg={self.seg_id} send_ms={round(time.monotonic() * 1000 - send_start_ms, 1)}")

        if final:
            self.in_speech = False
            self.silence_ms = 0
            self.buf.clear()
            self.seg_start_ms = self.audio_ms
            self._reset_segment_metrics()
            # 粘贴由前端统一处理（Tauri IPC），Python 端不做 osascript

    def _reset_segment_metrics(self):
        self.seg_id = None
        self.seg_active_frames = 0
        self.seg_active_ms = 0
        self.seg_run_ms = 0
        self.seg_max_run_ms = 0
        self.seg_rms_sum = 0.0
        self.seg_rms_count = 0
        self.seg_rms_max = 0.0
        self.seg_wall_start_ms = None
        self.last_speech_wall_ms = None

    # ---------- 发送 ----------

    async def send_event(self, event: str, extra_payload=None):
        payload = {"output": {}}
        if extra_payload:
            payload.update(extra_payload)
        msg = {
            "header": {
                "event": event,
                "task_id": self.task_id,
                "status": 20000000 if event != "task-failed" else 40000001,
            },
            "payload": payload,
        }
        await self.ws.send(json.dumps(msg, ensure_ascii=False))


# ---------- 连接处理 ----------

async def handle(ws):
    print(f"[asr_local] 连接: {ws.remote_address}")
    session = None
    try:
        async for raw in ws:
            if isinstance(raw, bytes):
                if session is not None:
                    await session.feed_audio(raw)
            else:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                header = msg.get("header") or {}
                action = header.get("action")
                if action == "run-task":
                    engine = (msg.get("payload") or {}).get("parameters", {}).get("engine", ENGINE)
                    session = Session(ws, header.get("task_id", "local"), engine_mgr, engine)
                    await session.handle_json(msg)
                elif action == "finish-task" and session is not None:
                    await session.handle_json(msg)
                    session = None
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        print(f"[asr_local] 断开: {ws.remote_address}")


engine_mgr = EngineManager(initial_engine=ENGINE)


def _free_port(port: int):
    """释放指定 TCP 端口上的遗留监听进程。

    两个限定条件都是必要的：
      - `-sTCP:LISTEN`：不带这个标志时 lsof 会连「正在连接该端口的客户端」一起列出来，
        于是 node server.js 只要持有到 8932 的已建立连接就会被一起 kill -9；
      - 进程名匹配：只清理本项目自己的 pid，别去动别人恰好占了这个端口的服务。
    """
    import subprocess
    try:
        out = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=5
        ).stdout.strip()
    except Exception:
        return
    for pid in [p for p in out.splitlines() if p.strip()]:
        try:
            comm = subprocess.run(
                ["ps", "-p", pid, "-o", "comm="],
                capture_output=True, text=True, timeout=5
            ).stdout.strip()
        except Exception:
            continue
        if not any(marker in comm for marker in ("python", "asr-server", "server.py")):
            print(f"[asr_local] 端口 {port} 被非本项目进程占用 (PID: {pid} {comm})，跳过")
            continue
        print(f"[asr_local] 释放端口 {port} (PID: {pid})")
        try:
            subprocess.run(["kill", "-9", pid], capture_output=True, timeout=5)
        except Exception:
            pass
    time.sleep(0.3)


async def main():
    global _ASYNC_LOOP
    _ASYNC_LOOP = asyncio.get_running_loop()

    # 启动前清理两个端口的残留进程，避免旧进程被 Tauri 杀掉后端口仍处于 TIME_WAIT
    _free_port(PORT)
    _free_port(MODEL_HTTP_PORT)

    # 先起模型管理 HTTP（8933）：即使推理依赖缺失，用户仍能下载模型 / 查看状态
    start_model_http_server()

    # 再把「首次下载 SenseVoice 模型」丢到后台线程。必须晚于 8933 绑定：
    # 下载进度就是通过 8933 上报给设置面板的，先下载会让用户在整个下载期间
    # 既连不上 8932（识别）也连不上 8933（进度），只能看到「服务未连接」。
    threading.Thread(
        target=_bootstrap_sensevoice_model, name="sensevoice-bootstrap", daemon=True
    ).start()

    issue = environment_issue()
    if issue:
        print(f"[asr_local] ⚠️ 环境不完整，本地识别不可用：{issue}")
        print(f"[asr_local] 修复后重启应用即可；模型下载与状态查询仍可用。")

    # 启动时预热默认引擎；失败不退出（模型可在设置面板下载后重载）
    if _sherpa_onnx is not None and np is not None:
        try:
            await engine_mgr.load(ENGINE)
        except Exception as e:
            print(f"[asr_local] 模型预热失败: {e}（ASR 暂不可用，可在设置面板下载模型后点「重载」）")

    if websockets is None:
        print("[asr_local] 缺少 websockets 依赖，WebSocket 识别服务未启动（模型管理仍可用）")
        await asyncio.Future()
        return

    async with websockets.serve(handle, "127.0.0.1", PORT, max_size=10 * 1024 * 1024):
        print(f"[asr_local] 监听 ws://127.0.0.1:{PORT} (引擎: {ENGINE}, 支持热切换 sensevoice/qwen3)")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[asr_local] 退出")
